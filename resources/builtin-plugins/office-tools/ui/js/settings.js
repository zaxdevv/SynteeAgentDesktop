// settings — настройки плагина: папка сохранения, превью, открытие в Word,
// вёрстка по умолчанию (поля страницы, красная строка, списки, разрывы)
;(function () {
  'use strict'

  var defaultDir = ''

  function showErr(msg) {
    var el = document.getElementById('ot-settings-err')
    if (el) { el.style.display = 'block'; el.textContent = msg }
  }

  function save(patch) {
    return OT.bridge.call('setSettings', patch).catch(function (e) {
      showErr('Не удалось сохранить: ' + e.message)
    })
  }

  function render(s) {
    var root = document.getElementById('ot-settings')
    var dir = s.saveDir || defaultDir || 'Documents\\Office Tools'
    var pm = s.pageMargins === 'word' || s.pageMargins === 'custom' ? s.pageMargins : 'gost'
    var cm = s.customMargins || {}
    var fli = s.firstLineIndent === 'on' || s.firstLineIndent === 'off' ? s.firstLineIndent : 'auto'
    var cmShown = pm === 'custom' ? '' : ' style="display:none"'
    root.innerHTML =
      '<div class="ot-settings">'
      + '<div class="ot-set-row">'
      + '<div class="ot-set-label">Папка сохранения</div>'
      + '<div class="ot-dir-row">'
      + '<div class="ot-dir-path" id="ot-dir-path" title="' + OT.esc(dir) + '">' + OT.esc(dir) + '</div>'
      + '<button class="ot-btn" id="ot-pick-dir">Выбрать…</button>'
      + '</div>'
      + '<div class="ot-set-hint" style="margin-top:4px">По умолчанию: Documents\\Office Tools</div>'
      + '</div>'
      + '<div class="ot-set-row">'
      + '<label class="ot-check"><input type="checkbox" id="ot-open-after"'
      + (s.openAfterCreate ? ' checked' : '')
      + '><span>Открывать документ в Word после создания</span></label>'
      + '</div>'
      + '<div class="ot-set-row">'
      + '<label class="ot-check"><input type="checkbox" id="ot-show-preview"'
      + (s.showPreview ? ' checked' : '')
      + '><span>Показывать превью в чате</span></label>'
      + '</div>'
      + '<div class="ot-set-row">'
      + '<div class="ot-set-label">Строк в превью таблиц</div>'
      + '<input type="number" class="ot-num" id="ot-preview-rows" min="3" max="50" value="'
      + (Number(s.previewRows) || 10) + '">'
      + '</div>'
      // --- Вёрстка по умолчанию ---
      + '<div class="ot-set-row">'
      + '<div class="ot-set-label">Поля страницы по умолчанию</div>'
      + '<select class="ot-num" id="ot-page-margins">'
      + '<option value="gost"' + (pm === 'gost' ? ' selected' : '') + '>ГОСТ (3 / 1.5 / 2 / 2 см)</option>'
      + '<option value="word"' + (pm === 'word' ? ' selected' : '') + '>Word (2.54 см)</option>'
      + '<option value="custom"' + (pm === 'custom' ? ' selected' : '') + '>Свои…</option>'
      + '</select>'
      + '<div class="ot-set-row" id="ot-custom-margins"' + cmShown + '>'
      + '<input type="number" class="ot-num" id="ot-cm-top" min="0.5" max="10" step="0.1" placeholder="верх" value="' + (cm.top || '') + '">'
      + '<input type="number" class="ot-num" id="ot-cm-right" min="0.5" max="10" step="0.1" placeholder="право" value="' + (cm.right || '') + '">'
      + '<input type="number" class="ot-num" id="ot-cm-bottom" min="0.5" max="10" step="0.1" placeholder="низ" value="' + (cm.bottom || '') + '">'
      + '<input type="number" class="ot-num" id="ot-cm-left" min="0.5" max="10" step="0.1" placeholder="лево" value="' + (cm.left || '') + '">'
      + '<div class="ot-set-hint">Поля в см: верх / право / низ / лево</div>'
      + '</div>'
      + '</div>'
      + '<div class="ot-set-row">'
      + '<div class="ot-set-label">Красная строка (1.25 см)</div>'
      + '<select class="ot-num" id="ot-first-line">'
      + '<option value="auto"' + (fli === 'auto' ? ' selected' : '') + '>Авто (для русских текстов)</option>'
      + '<option value="on"' + (fli === 'on' ? ' selected' : '') + '>Всегда</option>'
      + '<option value="off"' + (fli === 'off' ? ' selected' : '') + '>Никогда</option>'
      + '</select>'
      + '</div>'
      + '<div class="ot-set-row">'
      + '<label class="ot-check"><input type="checkbox" id="ot-compact-lists"'
      + (s.compactLists !== false ? ' checked' : '')
      + '><span>Компактные отступы списков</span></label>'
      + '</div>'
      + '<div class="ot-set-row">'
      + '<label class="ot-check"><input type="checkbox" id="ot-smart-breaks"'
      + (s.smartBreaks !== false ? ' checked' : '')
      + '><span>Не отрывать заголовки от текста</span></label>'
      + '</div>'
      + '<div class="ot-error" id="ot-settings-err" style="display:none"></div>'
      + '</div>'
    bind()
  }

  function bind() {
    var pick = document.getElementById('ot-pick-dir')
    pick.addEventListener('click', function () {
      pick.disabled = true
      OT.bridge.call('pickSaveDir').then(function (r) {
        pick.disabled = false
        if (r && r.dir) {
          document.getElementById('ot-dir-path').textContent = r.dir
          document.getElementById('ot-dir-path').title = r.dir
        }
      }).catch(function (e) {
        pick.disabled = false
        showErr(e.message)
      })
    })

    document.getElementById('ot-open-after').addEventListener('change', function () {
      save({ openAfterCreate: this.checked })
    })

    document.getElementById('ot-show-preview').addEventListener('change', function () {
      save({ showPreview: this.checked })
    })

    document.getElementById('ot-preview-rows').addEventListener('change', function () {
      var n = parseInt(this.value, 10)
      if (isNaN(n) || n < 3) n = 3
      if (n > 50) n = 50
      this.value = n
      save({ previewRows: n })
    })

    // Поля страницы: пресет / свои значения
    document.getElementById('ot-page-margins').addEventListener('change', function () {
      var custom = document.getElementById('ot-custom-margins')
      custom.style.display = this.value === 'custom' ? '' : 'none'
      save({ pageMargins: this.value })
    })

    var cmIds = ['ot-cm-top', 'ot-cm-right', 'ot-cm-bottom', 'ot-cm-left']
    cmIds.forEach(function (id) {
      document.getElementById(id).addEventListener('change', function () {
        var v = parseFloat(this.value)
        if (isNaN(v) || v < 0.5) v = 0.5
        if (v > 10) v = 10
        this.value = v
        save({
          customMargins: {
            top: parseFloat(document.getElementById('ot-cm-top').value) || 2,
            right: parseFloat(document.getElementById('ot-cm-right').value) || 1.5,
            bottom: parseFloat(document.getElementById('ot-cm-bottom').value) || 2,
            left: parseFloat(document.getElementById('ot-cm-left').value) || 3,
          },
        })
      })
    })

    document.getElementById('ot-first-line').addEventListener('change', function () {
      save({ firstLineIndent: this.value })
    })

    document.getElementById('ot-compact-lists').addEventListener('change', function () {
      save({ compactLists: this.checked })
    })

    document.getElementById('ot-smart-breaks').addEventListener('change', function () {
      save({ smartBreaks: this.checked })
    })
  }

  function init() {
    var root = document.getElementById('ot-settings')
    OT.bridge.call('getSettings').then(function (s) {
      return OT.bridge.call('getDefaultSaveDir').then(function (d) {
        defaultDir = d || ''
        render(s || {})
      })
    }).catch(function (e) {
      root.innerHTML = '<div class="ot-error">Ошибка загрузки настроек: ' + OT.esc(e.message) + '</div>'
    })
  }

  window.OT.settings = { init: init }
})()
