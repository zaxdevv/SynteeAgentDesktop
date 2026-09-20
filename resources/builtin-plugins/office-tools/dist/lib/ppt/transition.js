// transition — XML-транзишены слайдов (<p:transition>) для .pptx.
// pptxgenjs не умеет транзишены — инъектируем их в slideN.xml постпроцессингом.
// Используется из spec.js (создание) и edit.js (set_transition).

// Допустимые типы OOXML-транзишенов → XML-тег + атрибуты
const TRANSITIONS = {
  fade: { tag: 'p:fade', attrs: { thruBlk: '0|1' } },
  push: { tag: 'p:push', attrs: { dir: 'l|r|u|d' } },
  wipe: { tag: 'p:wipe', attrs: { dir: 'l|r|u|d' } },
  cover: { tag: 'p:cover', attrs: { dir: 'l|r|u|d|ld|lu|rd|ru' } },
  pull: { tag: 'p:pull', attrs: { dir: 'l|r|u|d|ld|lu|rd|ru' } },
  cut: { tag: 'p:cut', attrs: { thruBlk: '0|1' } },
  dissolve: { tag: 'p:dissolve', attrs: {} },
  split: { tag: 'p:split', attrs: { orient: 'horz|vert', dir: 'in|out' } },
  wedge: { tag: 'p:wedge', attrs: {} },
  wheel: { tag: 'p:wheel', attrs: { spokes: '1|2|3|4|8' } },
  zoom: { tag: 'p:zoom', attrs: { dir: 'in|out' } },
  blinds: { tag: 'p:blinds', attrs: { dir: 'horz|vert' } },
  checker: { tag: 'p:checker', attrs: { dir: 'horz|vert' } },
  comb: { tag: 'p:comb', attrs: { dir: 'horz|vert' } },
  circle: { tag: 'p:circle', attrs: {} },
  diamond: { tag: 'p:diamond', attrs: {} },
  plus: { tag: 'p:plus', attrs: {} },
  newsflash: { tag: 'p:newsflash', attrs: {} },
  strips: { tag: 'p:strips', attrs: { dir: 'ld|lu|rd|ru' } },
  randombar: { tag: 'p:randomBar', attrs: { dir: 'horz|vert' } },
  random: { tag: 'p:random', attrs: {} },
}

/** Нормализация transition-спеки: строка 'fade' → { type: 'fade' }. */
function normalizeTransition(tr) {
  const t = typeof tr === 'string' ? { type: tr } : (tr && typeof tr === 'object' ? { ...tr } : null)
  if (!t || !t.type) throw new Error('transition.type обязателен (например "fade", "push")')
  const type = String(t.type).toLowerCase()
  const def = TRANSITIONS[type]
  if (!def) {
    throw new Error('Неизвестный тип транзишена: ' + t.type + '. Доступно: ' + Object.keys(TRANSITIONS).join(', '))
  }
  return { ...t, type }
}

/** Сборка XML-тега <p:transition …><p:xxx …/></p:transition> из нормализованной спеки. */
function buildTransitionXml(tr) {
  const t = normalizeTransition(tr)
  const def = TRANSITIONS[t.type]

  // Атрибуты корня: spd (slow|med|fast), advTm (мс), advClick
  const rootAttrs = []
  const spd = String(t.spd || t.speed || '').toLowerCase()
  if (['slow', 'med', 'fast'].includes(spd)) rootAttrs.push('spd="' + spd + '"')
  if (t.advanceAfterMs != null) {
    const ms = Number(t.advanceAfterMs)
    if (!Number.isFinite(ms) || ms < 0) throw new Error('transition.advanceAfterMs — число миллисекунд')
    rootAttrs.push('advTm="' + Math.round(ms) + '"')
  }
  if (t.advanceOnClick === false) rootAttrs.push('advClick="0"')

  // Атрибуты внутреннего тега (dir/orient/spokes/thruBlk) — только допустимые
  const innerAttrs = []
  for (const [key, allowed] of Object.entries(def.attrs)) {
    const variants = allowed.split('|')
    let val = t[key]
    if (val == null && key === 'dir' && variants.includes('l')) val = 'l' // дефолт dir=l
    if (val == null && key === 'dir' && variants.includes('horz')) val = 'horz'
    if (val == null && key === 'orient') val = 'horz'
    if (val == null && key === 'dir' && variants.includes('in')) val = 'in'
    if (val == null && key === 'spokes') val = '1'
    val = String(val).toLowerCase()
    if (!variants.includes(val)) continue
    innerAttrs.push(key + '="' + val + '"')
  }
  // thruBlk по умолчанию не ставим (0 — обычное поведение)
  const inner = '<' + def.tag + (innerAttrs.length ? ' ' + innerAttrs.join(' ') : '') + '/>'
  return '<p:transition' + (rootAttrs.length ? ' ' + rootAttrs.join(' ') : '') + '>' + inner + '</p:transition>'
}

/** Инъекция transition в XML слайда: заменяет существующий <p:transition>, либо
 *  вставляет после </p:clrMapOvr> (или после </p:cSld>, если clrMapOvr нет).
 *  Порядок элементов p:sld: cSld, clrMapOvr, transition, timing. */
function applyTransitionToXml(xml, tr) {
  const tag = buildTransitionXml(tr)
  let out = xml.replace(/<p:transition\b[^>]*(?:\/>|>[\s\S]*?<\/p:transition>)/, '')
  if (out.includes('</p:clrMapOvr>')) {
    out = out.replace('</p:clrMapOvr>', '</p:clrMapOvr>' + tag)
  } else if (/<p:clrMapOvr\b[^>]*\/>/.test(out)) {
    out = out.replace(/<p:clrMapOvr\b[^>]*\/>/, (m) => m + tag)
  } else {
    out = out.replace('</p:cSld>', '</p:cSld>' + tag)
  }
  return out
}

module.exports = { TRANSITIONS, normalizeTransition, buildTransitionXml, applyTransitionToXml }
