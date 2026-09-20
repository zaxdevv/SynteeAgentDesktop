// edit — гранулярные правки .pptx на уровне XML (adm-zip):
// find_replace, set_notes, delete_slide, move_slide, hide_slide, set_transition.
// Форматирование НЕ трогаем (кроме заменяемого текста) — lossless для остального.
// Перед записью — .bak (lib/backup.js).

const fs = require('fs')
const AdmZip = require('adm-zip')
const { loadPptx, slideRels, parseRels, decodeEntities, encodeEntities, attr } = require('./read')
const { applyTransitionToXml, normalizeTransition } = require('./transition')
const { backupFile } = require('../backup')

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT_NOTES = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml'

/** Замены в <a:t> одного XML: decode → replace → encode. Возвращает кол-во замен. */
function replaceInTextNodes(xml, find, replace) {
  let count = 0
  const out = xml.replace(/(<a:t>)([\s\S]*?)(<\/a:t>)/g, (_, open, text, close) => {
    const decoded = decodeEntities(text)
    if (!decoded.includes(find)) return open + text + close
    const replaced = decoded.split(find).join(replace)
    count++
    return open + encodeEntities(replaced) + close
  })
  return { xml: out, count }
}

/** Следующий свободный rId в rels-XML. */
function nextRid(relsXml) {
  let max = 0
  const re = /Id="rId(\d+)"/g
  let m
  while ((m = re.exec(relsXml))) max = Math.max(max, parseInt(m[1], 10))
  return 'rId' + (max + 1)
}

/** Добавить Override в [Content_Types].xml (если ещё нет). */
function addOverride(zip, partName, contentType) {
  const name = '[Content_Types].xml'
  let xml = zip.readAsText(name)
  if (!xml || xml.includes('PartName="' + partName + '"')) return
  xml = xml.replace('</Types>', '<Override PartName="' + partName + '" ContentType="' + contentType + '"/></Types>')
  zip.updateFile(name, Buffer.from(xml, 'utf-8'))
}

/** Удалить Override из [Content_Types].xml. */
function removeOverride(zip, partName) {
  const name = '[Content_Types].xml'
  let xml = zip.readAsText(name)
  if (!xml) return
  xml = xml.replace(new RegExp('<Override PartName="' + escapeRegExp(partName) + '"[^>]*/>'), '')
  zip.updateFile(name, Buffer.from(xml, 'utf-8'))
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Удалить запись <Relationship Id=…> из rels-XML по target. */
function removeRelByTarget(relsXml, target) {
  const re = /<Relationship\b[^>]*>/g
  let m
  const kept = []
  while ((m = re.exec(relsXml))) {
    if (attr(m[0], 'Target') && !attr(m[0], 'Target').startsWith('/') && normalizeTarget(attr(m[0], 'Target')) !== target) kept.push(m[0])
    else if (attr(m[0], 'Target') && attr(m[0], 'Target').startsWith('/') && attr(m[0], 'Target').slice(1) !== target) kept.push(m[0])
    else if (!attr(m[0], 'Target')) kept.push(m[0])
  }
  return relsXml.replace(/<Relationship\b[^>]*>/g, '').replace('</Relationships>', kept.join('') + '</Relationships>')
}

function normalizeTarget(t) {
  return String(t).replace(/^\.\.\//, '').replace(/^\//, '')
}

/** Создать notesSlideN.xml + rels + Override + rel со слайда. Возвращает путь нового файла. */
function createNotesSlide(zip, slidePath, notesText, notesMasterTarget) {
  // Номер: max существующий + 1
  let max = 0
  for (const e of zip.getEntries()) {
    const m = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(e.entryName)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  const num = max + 1
  const part = 'ppt/notesSlides/notesSlide' + num + '.xml'

  const safe = encodeEntities(String(notesText))
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ru-RU" dirty="0"/><a:t>' + safe + '</a:t></a:r></a:p></p:txBody>' +
    '</p:sp>' +
    '</p:spTree></p:cSld>' +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    '</p:notes>'
  zip.addFile(part, Buffer.from(xml, 'utf-8'))

  // rels notesSlide → notesMaster
  const relsPart = 'ppt/notesSlides/_rels/notesSlide' + num + '.xml.rels'
  const relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + REL_NS + '/notesMaster" Target="../' + notesMasterTarget + '"/>' +
    '</Relationships>'
  zip.addFile(relsPart, Buffer.from(relsXml, 'utf-8'))

  // Override
  addOverride(zip, '/' + part, CT_NOTES)

  // rel со слайда на notesSlide
  const slideRelsPart = slidePath.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')
  let sRels = zip.readAsText(slideRelsPart)
  if (!sRels) {
    sRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  }
  const rid = nextRid(sRels)
  const slideNum = /slide(\d+)\.xml$/.exec(slidePath)
  sRels = sRels.replace('</Relationships>',
    '<Relationship Id="' + rid + '" Type="' + REL_NS + '/notesSlide" Target="../notesSlides/notesSlide' + num + '.xml"/></Relationships>')
  zip.updateFile(slideRelsPart, Buffer.from(sRels, 'utf-8'))
  void slideNum

  return part
}

/** Записать текст в body-плейсхолдер существующего notesSlide. */
function setNotesText(notesXml, notesText) {
  const shapes = notesXml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []
  for (const sp of shapes) {
    if (/<p:ph\b[^>]*type="body"/.test(sp) || /<p:ph\b(?![^>]*type=)[^>]*>/.test(sp)) {
      const txBody = /<p:txBody>[\s\S]*?<\/p:txBody>/.exec(sp)
      if (txBody) {
        const newTx = '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ru-RU" dirty="0"/><a:t>' +
          encodeEntities(String(notesText)) + '</a:t></a:r></a:p></p:txBody>'
        return notesXml.replace(txBody[0], newTx)
      }
    }
  }
  // Нет body-ph — вставляем sp с текстом перед </p:spTree>
  const sp = '<p:sp><p:nvSpPr><p:cNvPr id="99" name="Notes"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ru-RU" dirty="0"/><a:t>' +
    encodeEntities(String(notesText)) + '</a:t></a:r></a:p></p:txBody></p:sp>'
  return notesXml.replace('</p:spTree>', sp + '</p:spTree>')
}

/** sldIdLst из presentation.xml → массив rId (по порядку). */
function sldIdList(presXml) {
  const out = []
  const re = /<p:sldId\b[^>]*>/g
  let m
  while ((m = re.exec(presXml))) out.push(attr(m[0], 'r:id'))
  return out
}

/**
 * Применить операции к .pptx и перезаписать файл.
 * @param {string} filePath путь до .pptx
 * @param {Array} ops операции
 * @returns {{ applied: string[], slideCount: number, bak: string|null }}
 */
function applyOps(filePath, ops) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('ops (массив операций) обязателен')
  const { zip, presXml, presRels, slidePaths } = loadPptx(filePath)
  const applied = []

  // Обновляемый presentation.xml (копия для мутаций)
  let pres = presXml

  for (const op of ops) {
    const name = op && op.op
    switch (name) {
      case 'find_replace': {
        if (!op.find) throw new Error('find_replace: find обязателен')
        const replace = op.replace == null ? '' : String(op.replace)
        let total = 0
        const seen = new Set()
        for (const sp of slidePaths) {
          const xml = zip.readAsText(sp)
          const r = replaceInTextNodes(xml, String(op.find), replace)
          if (r.count) { zip.updateFile(sp, Buffer.from(r.xml, 'utf-8')); total += r.count }
          const rels = slideRels(zip, sp)
          const notesRel = [...rels.values()].find((x) => x.type.endsWith('/notesSlide'))
          if (notesRel && !seen.has(notesRel.target)) {
            seen.add(notesRel.target)
            const nxml = zip.readAsText(notesRel.target)
            const nr = replaceInTextNodes(nxml, String(op.find), replace)
            if (nr.count) { zip.updateFile(notesRel.target, Buffer.from(nr.xml, 'utf-8')); total += nr.count }
          }
        }
        applied.push('find_replace "' + op.find + '": ' + total + ' замен')
        break
      }
      case 'set_notes': {
        const idx = slideIndex(op.slide, slidePaths, 'set_notes')
        const slidePath = slidePaths[idx - 1]
        const rels = slideRels(zip, slidePath)
        const notesRel = [...rels.values()].find((x) => x.type.endsWith('/notesSlide'))
        if (notesRel) {
          const nxml = zip.readAsText(notesRel.target)
          zip.updateFile(notesRel.target, Buffer.from(setNotesText(nxml, op.notes ?? ''), 'utf-8'))
        } else {
          // Создаём notesSlide: нужен notesMaster
          const nmRel = [...presRels.values()].find((x) => x.type.endsWith('/notesMaster'))
          if (!nmRel) throw new Error('set_notes: в файле нет notesMaster — заметки создать нельзя (файл создан не PowerPoint/нашим плагином?)')
          const nmTarget = nmRel.target.replace(/^ppt\//, '')
          createNotesSlide(zip, slidePath, op.notes ?? '', nmTarget)
        }
        applied.push('set_notes: слайд ' + idx)
        break
      }
      case 'delete_slide': {
        const idx = slideIndex(op.slide, slidePaths, 'delete_slide')
        const slidePath = slidePaths[idx - 1]
        // rId этого слайда в presentation.xml
        const rid = sldIdList(pres).find((r) => {
          const rel = presRels.get(r)
          return rel && rel.target === slidePath
        })
        if (!rid) throw new Error('delete_slide: слайд ' + idx + ' не найден в sldIdLst')
        // 1. Убираем из sldIdLst
        pres = pres.replace(new RegExp('<p:sldId\\b[^>]*r:id="' + rid + '"[^>]*/>'), '')
        // 2. Убираем rel из presentation.xml.rels
        const presRelsPart = 'ppt/_rels/presentation.xml.rels'
        let prXml = zip.readAsText(presRelsPart)
        prXml = prXml.replace(new RegExp('<Relationship\\b[^>]*Id="' + rid + '"[^>]*/>'), '')
        zip.updateFile(presRelsPart, Buffer.from(prXml, 'utf-8'))
        // 3. Удаляем файлы слайда + rels + notesSlide
        const rels = slideRels(zip, slidePath)
        const notesRel = [...rels.values()].find((x) => x.type.endsWith('/notesSlide'))
        for (const part of [slidePath, slidePath.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')]) {
          zip.deleteFile(part)
          removeOverride(zip, '/' + part)
        }
        if (notesRel) {
          for (const part of [notesRel.target, notesRel.target.replace(/notesSlides\/(notesSlide\d+\.xml)$/, 'notesSlides/_rels/$1.rels')]) {
            zip.deleteFile(part)
            removeOverride(zip, '/' + part)
          }
        }
        slidePaths.splice(idx - 1, 1)
        applied.push('delete_slide: слайд ' + idx)
        break
      }
      case 'move_slide': {
        const from = slideIndex(op.slide, slidePaths, 'move_slide')
        let to = slideIndex(op.to, slidePaths, 'move_slide')
        const list = sldIdList(pres)
        const rid = list[from - 1]
        list.splice(from - 1, 1)
        // после удаления позиция могла сместиться
        if (to > from) to--
        list.splice(to - 1, 0, rid)
        // Пересобираем sldIdLst
        const entries = list.map((r) => {
          const old = pres.match(new RegExp('<p:sldId\\b[^>]*r:id="' + r + '"[^>]*/>'))
          return old ? old[0] : '<p:sldId id="256" r:id="' + r + '"/>'
        })
        pres = pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, '<p:sldIdLst>' + entries.join('') + '</p:sldIdLst>')
        const moved = slidePaths.splice(from - 1, 1)[0]
        slidePaths.splice(to - 1, 0, moved)
        applied.push('move_slide: ' + from + ' → ' + to)
        break
      }
      case 'hide_slide': {
        const idx = slideIndex(op.slide, slidePaths, 'hide_slide')
        const slidePath = slidePaths[idx - 1]
        const hidden = op.hidden === undefined ? true : !!op.hidden
        let xml = zip.readAsText(slidePath)
        const root = /<p:sld\b[^>]*>/.exec(xml)
        if (!root) throw new Error('hide_slide: не найден корень <p:sld>')
        let tag = root[0]
        if (hidden) {
          if (/\sshow=/.test(tag)) tag = tag.replace(/\sshow="[^"]*"/, ' show="0"')
          else tag = tag.replace(/^<p:sld\b/, '<p:sld show="0"')
        } else {
          tag = tag.replace(/\sshow="[^"]*"/, '')
        }
        xml = xml.replace(root[0], tag)
        zip.updateFile(slidePath, Buffer.from(xml, 'utf-8'))
        applied.push('hide_slide: слайд ' + idx + (hidden ? ' скрыт' : ' показан'))
        break
      }
      case 'set_transition': {
        normalizeTransition(op.transition) // валидация
        const targets = op.slide === undefined || op.slide === null
          ? slidePaths.map((_, i) => i + 1)
          : [slideIndex(op.slide, slidePaths, 'set_transition')]
        for (const idx of targets) {
          const slidePath = slidePaths[idx - 1]
          const xml = zip.readAsText(slidePath)
          zip.updateFile(slidePath, Buffer.from(applyTransitionToXml(xml, op.transition), 'utf-8'))
        }
        applied.push('set_transition ' + op.transition.type + ': ' + (targets.length === 1 ? 'слайд ' + targets[0] : 'все слайды (' + targets.length + ')'))
        break
      }
      default:
        throw new Error('Неизвестная операция: ' + name + ' (доступно: find_replace, set_notes, delete_slide, move_slide, hide_slide, set_transition)')
    }
  }

  // presentation.xml — записываем мутированную версию
  zip.updateFile('ppt/presentation.xml', Buffer.from(pres, 'utf-8'))

  const bak = backupFile(filePath)
  fs.writeFileSync(filePath, zip.toBuffer())
  return { applied, slideCount: slidePaths.length, bak }
}

/** Индекс слайда (1-based) с валидацией. */
function slideIndex(n, slidePaths, opName) {
  const idx = Number(n)
  if (!Number.isInteger(idx) || idx < 1 || idx > slidePaths.length) {
    throw new Error(opName + ': slide — номер от 1 до ' + slidePaths.length + ', получено ' + n)
  }
  return idx
}

module.exports = { applyOps, replaceInTextNodes }
