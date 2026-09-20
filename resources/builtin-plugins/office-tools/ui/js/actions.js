// actions — быстрые действия и шаблоны документов
;(function () {
  'use strict'

  var GROUPS = [
    { id: 'business', title: 'Деловые' },
    { id: 'report', title: 'Отчёты и работы' },
    { id: 'excel', title: 'Excel' },
    { id: 'presentation', title: 'Презентации' },
  ]

  var templates = []
  var activeId = null // id шаблона с открытой формой

  function showActionsError(msg) {
    var el = document.getElementById('ot-actions-err')
    if (el) { el.style.display = 'block'; el.textContent = msg }
  }

  // ── Быстрые действия ──
  function renderQuickActions() {
    var root = document.getElementById('ot-actions')
    root.innerHTML =
      '<button class="ot-action" id="ot-quick-word" title="Вставить промпт в поле ввода">'
      + OT.icon('doc') + '<span>Новый документ Word</span></button>'
      + '<button class="ot-action" id="ot-quick-excel" title="Вставить промпт в поле ввода">'
      + OT.icon('table') + '<span>Новая таблица Excel</span></button>'
      + '<button class="ot-action" id="ot-quick-ppt" title="Вставить промпт в поле ввода">'
      + OT.icon('ppt') + '<span>Новая презентация</span></button>'

    document.getElementById('ot-quick-word').addEventListener('click', function () {
      // вставить в поле ввода, НЕ отправлять
      OT.bridge.call('insertPrompt', { prompt: 'Создай Word-документ: ' })
        .catch(function (e) { showActionsError('Не удалось вставить промпт: ' + e.message) })
    })
    document.getElementById('ot-quick-excel').addEventListener('click', function () {
      OT.bridge.call('insertPrompt', { prompt: 'Создай Excel-таблицу: ' })
        .catch(function (e) { showActionsError('Не удалось вставить промпт: ' + e.message) })
    })
    document.getElementById('ot-quick-ppt').addEventListener('click', function () {
      OT.bridge.call('insertPrompt', { prompt: 'Создай презентацию PowerPoint: ' })
        .catch(function (e) { showActionsError('Не удалось вставить промпт: ' + e.message) })
    })
  }

  // ── Шаблоны ──
  function renderTemplates() {
    var root = document.getElementById('ot-templates')
    if (!templates.length) {
      root.innerHTML = '<div class="ot-muted">Шаблоны недоступны</div>'
      return
    }

    var html = ''
    GROUPS.forEach(function (g) {
      var items = templates.filter(function (t) { return t.group === g.id })
      if (!items.length) return
      html += '<div class="ot-tpl-group"><div class="ot-tpl-group-title">' + OT.esc(g.title) + '</div><div class="ot-tpl-grid">'
      items.forEach(function (t) {
        html += '<button class="ot-tpl-card' + (t.id === activeId ? ' active' : '') + '" data-tpl="' + OT.esc(t.id) + '">'
          + '<div class="ot-tpl-name">' + OT.esc(t.name) + '</div>'
          + '<div class="ot-tpl-desc">' + OT.esc(t.description || '') + '</div>'
          + '</button>'
      })
      html += '</div></div>'
    })

    // мини-форма активного шаблона
    var active = null
    for (var i = 0; i < templates.length; i++) {
      if (templates[i].id === activeId) { active = templates[i]; break }
    }
    if (active) {
      html += '<div class="ot-form" id="ot-tpl-form">'
      html += '<h3>' + OT.esc(active.name) + '</h3>'
      ;(active.fields || []).forEach(function (f) {
        html += '<div class="ot-field"><label for="ot-f-' + OT.esc(f.key) + '">' + OT.esc(f.label) + '</label>'
          + '<input id="ot-f-' + OT.esc(f.key) + '" data-key="' + OT.esc(f.key) + '" placeholder="' + OT.esc(f.placeholder || '') + '">'
          + '</div>'
      })
      html += '<div class="ot-form-actions">'
        + '<button class="ot-btn ot-btn-primary" id="ot-tpl-create">Создать</button>'
        + '<button class="ot-btn" id="ot-tpl-cancel">Отмена</button>'
        + '</div>'
        + '<div class="ot-error" id="ot-tpl-err" style="display:none"></div>'
      html += '</div>'
    }

    root.innerHTML = html
    bindTemplates(root)
  }

  function bindTemplates(root) {
    var cards = root.querySelectorAll('.ot-tpl-card')
    for (var i = 0; i < cards.length; i++) {
      ;(function (card) {
        card.addEventListener('click', function () {
          var id = card.getAttribute('data-tpl')
          activeId = (activeId === id) ? null : id
          renderTemplates()
        })
      })(cards[i])
    }
    var create = document.getElementById('ot-tpl-create')
    if (create) create.addEventListener('click', onCreate)
    var cancel = document.getElementById('ot-tpl-cancel')
    if (cancel) cancel.addEventListener('click', function () {
      activeId = null
      renderTemplates()
    })
  }

  function onCreate() {
    var active = null
    for (var i = 0; i < templates.length; i++) {
      if (templates[i].id === activeId) { active = templates[i]; break }
    }
    if (!active) return

    var inputs = document.querySelectorAll('#ot-tpl-form input[data-key]')
    var values = {}
    for (var j = 0; j < inputs.length; j++) {
      values[inputs[j].getAttribute('data-key')] = inputs[j].value
    }

    // подстановка {{key}} из полей формы
    var prompt = String(active.prompt || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function (m, key) {
      var v = (values[key] || '').trim()
      if (v) return v
      var field = null
      var fields = active.fields || []
      for (var k = 0; k < fields.length; k++) {
        if (fields[k].key === key) { field = fields[k]; break }
      }
      return field && field.placeholder ? field.placeholder : 'не указано'
    })

    var btn = document.getElementById('ot-tpl-create')
    btn.disabled = true
    btn.textContent = '…'

    OT.bridge.call('quickAction', { prompt: prompt }).then(function () {
      activeId = null
      renderTemplates()
    }).catch(function (e) {
      btn.disabled = false
      btn.textContent = 'Создать'
      var err = document.getElementById('ot-tpl-err')
      if (err) { err.style.display = 'block'; err.textContent = 'Ошибка: ' + e.message }
    })
  }

  function init() {
    renderQuickActions()
    OT.bridge.call('getTemplates').then(function (list) {
      templates = Array.isArray(list) ? list : []
      renderTemplates()
    }).catch(function (e) {
      document.getElementById('ot-templates').innerHTML =
        '<div class="ot-error">Не удалось загрузить шаблоны: ' + OT.esc(e.message) + '</div>'
    })
  }

  window.OT.actions = { init: init }
})()
