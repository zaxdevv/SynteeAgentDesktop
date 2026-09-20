// panel — точка входа: инициализация всех секций панели
;(function () {
  'use strict'

  function init() {
    if (window.OT && window.OT.actions) window.OT.actions.init()
    if (window.OT && window.OT.recent) window.OT.recent.init()
    if (window.OT && window.OT.preview) window.OT.preview.init()
    if (window.OT && window.OT.settings) window.OT.settings.init()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
