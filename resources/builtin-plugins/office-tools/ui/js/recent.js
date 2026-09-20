// recent — недавние файлы: список + действия (открыть / папка / PDF)
;(function () {
  'use strict'

  var list = []

  function showErr(msg) {
    var el = document.getElementById('ot-recent-err')
    if (el) { el.style.display = 'block'; el.textContent = msg }
  }

  function entryHtml(f, i) {
    var pdfBtn = (f.kind === 'word')
      ? '<button class="ot-chip" data-act="pdf" data-i="' + i + '" title="Экспорт в PDF">' + OT.icon('pdf') + '<span>PDF</span></button>'
      : ''
    return '<div class="ot-file">'
      + OT.kindBadge(f.kind)
      + '<div class="ot-file-body">'
      + '<div class="ot-file-name" title="' + OT.esc(f.path || '') + '">' + OT.esc(f.name || f.path || '') + '</div>'
      + '<div class="ot-file-meta">'
      + OT.esc(OT.opLabel(f.op)) + ' · ' + OT.esc(OT.fmtDate(f.at)) + ' · ' + OT.esc(OT.fmtSize(f.size))
      + '</div>'
      + '<div class="ot-file-actions">'
      + '<button class="ot-chip" data-act="open" data-i="' + i + '">' + OT.icon('open') + '<span>Открыть</span></button>'
      + '<button class="ot-chip" data-act="folder" data-i="' + i + '" title="Показать в папке">' + OT.icon('folder') + '<span>Папка</span></button>'
      + pdfBtn
      + '</div>'
      + '</div></div>'
  }

  function refresh() {
    var root = document.getElementById('ot-recent')
    return OT.bridge.call('getRecent').then(function (items) {
      list = Array.isArray(items) ? items : []
      if (!list.length) {
        root.innerHTML = '<div class="ot-muted">Пока пусто — создайте первый документ</div>'
        return
      }
      var html = ''
      for (var i = 0; i < list.length; i++) html += entryHtml(list[i], i)
      root.innerHTML = html
    }).catch(function (e) {
      root.innerHTML = '<div class="ot-error">Ошибка загрузки: ' + OT.esc(e.message) + '</div>'
    })
  }

  function setChipText(btn, text) {
    var span = btn.querySelector('span')
    if (span) span.textContent = text
  }

  function onRootClick(e) {
    var btn = e.target.closest ? e.target.closest('button[data-act]') : null
    if (!btn) return
    var i = parseInt(btn.getAttribute('data-i'), 10)
    var f = list[i]
    if (!f) return
    var act = btn.getAttribute('data-act')

    if (act === 'open') {
      OT.bridge.call('openFile', { path: f.path })
        .catch(function (err) { showErr('Не удалось открыть: ' + err.message) })
    } else if (act === 'folder') {
      OT.bridge.call('showInFolder', { path: f.path })
        .catch(function (err) { showErr(err.message) })
    } else if (act === 'pdf') {
      btn.disabled = true
      setChipText(btn, '…')
      OT.bridge.call('exportPdf', { path: f.path }).then(function () {
        btn.classList.add('done')
        setChipText(btn, 'Готово ✓')
      }).catch(function (err) {
        btn.disabled = false
        setChipText(btn, 'PDF')
        showErr('Ошибка PDF: ' + err.message)
      })
    }
  }

  function init() {
    document.getElementById('ot-recent').addEventListener('click', onRootClick)
    document.getElementById('ot-clear-recent').addEventListener('click', function () {
      OT.bridge.call('clearRecent').then(refresh).catch(function (e) { showErr(e.message) })
    })
    refresh()
  }

  window.OT.recent = { init: init, refresh: refresh }
})()
