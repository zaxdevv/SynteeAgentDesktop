// preview — превью текущего документа: outline + stats, живое обновление
;(function () {
  'use strict'

  function statsLine(stats) {
    if (!stats) return ''
    var parts = []
    if (stats.paragraphs != null) parts.push(stats.paragraphs + ' абзацев')
    if (stats.words != null) parts.push(stats.words + ' слов')
    if (stats.tables != null) parts.push(stats.tables + ' таблиц')
    if (stats.images != null) parts.push(stats.images + ' изображений')
    if (stats.approxPages != null) parts.push('~' + stats.approxPages + ' стр.')
    return parts.join(' · ')
  }

  function render(cur) {
    var root = document.getElementById('ot-preview')
    if (!cur || !cur.name) {
      root.innerHTML = '<div class="ot-muted">Нет активного документа</div>'
      return
    }

    var html = '<div class="ot-preview">'
      + '<div class="ot-file">' + OT.kindBadge(cur.kind)
      + '<div class="ot-file-body">'
      + '<div class="ot-file-name" title="' + OT.esc(cur.path || '') + '">' + OT.esc(cur.name) + '</div>'
      + '<div class="ot-file-meta">' + OT.esc(OT.opLabel(cur.op)) + ' · ' + OT.esc(OT.fmtDate(cur.at)) + '</div>'
      + '</div></div>'

    var st = statsLine(cur.stats)
    if (st) html += '<div class="ot-file-meta" style="margin-top:6px">' + OT.esc(st) + '</div>'

    var outline = cur.outline
    if (outline && outline.length) {
      html += '<div class="ot-outline">'
      var max = 60
      for (var i = 0; i < outline.length && i < max; i++) {
        var h = outline[i]
        var lvl = Math.max(1, Math.min(4, Number(h.level) || 1))
        html += '<div class="ot-outline-item' + (lvl === 1 ? ' l1' : '') + '"'
          + ' style="padding-left:' + ((lvl - 1) * 14) + 'px"'
          + ' title="' + OT.esc(h.text) + '">' + OT.esc(h.text) + '</div>'
      }
      if (outline.length > max) {
        html += '<div class="ot-muted">…ещё ' + (outline.length - max) + ' заголовков</div>'
      }
      html += '</div>'
    }

    html += '</div>'
    root.innerHTML = html
  }

  function init() {
    OT.bridge.call('getCurrent').then(render).catch(function () { render(null) })
    // живое обновление: тулы плагина эмитят 'office:update' { current, reason }
    OT.bridge.on('office:update', function (p) {
      if (p && p.current) {
        render(p.current)
      } else {
        OT.bridge.call('getCurrent').then(render).catch(function () { /* ignore */ })
      }
    })
  }

  window.OT.preview = { init: init }
})()
