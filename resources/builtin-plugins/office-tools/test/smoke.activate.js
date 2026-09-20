// smoke — активация плагина с мок-хостом: проверяет wiring без запуска приложения
const path = require('path')

const registered = { tools: [], commands: [], panels: [], widgets: [], handlers: [] }

const syntee = {
  pluginDir: path.join(__dirname, '..'),
  permissions: [],
  version: '1',
  log: { info() {}, warn() {}, error() {} },
  registerTool: t => registered.tools.push(t.name),
  registerCommand: c => registered.commands.push(c.name),
  registerPanel: p => registered.panels.push(p.id),
  ui: {
    registerWidget: w => registered.widgets.push(w.name),
    handle: (m) => registered.handlers.push(m),
    emit() {},
  },
}

const plugin = require('../dist/index.js')
plugin.activate(syntee)
plugin.deactivate()

const expectedTools = ['word_create', 'word_spec_docs', 'word_read', 'word_edit', 'word_append', 'word_compare', 'excel_create', 'excel_spec_docs', 'excel_read', 'excel_edit', 'excel_chart', 'office_convert', 'office_export_pdf', 'office_open', 'word_export_pdf', 'office_update_fields', 'office_save_as', 'office_find_replace', 'office_accept_changes', 'office_reject_changes', 'ppt_create', 'ppt_spec_docs', 'ppt_read', 'ppt_edit', 'ppt_export_pdf', 'ppt_templates', 'ppt_template_search', 'ppt_template_download', 'ppt_apply_template']
const expectedHandlers = ['getRecent', 'getCurrent', 'clearRecent', 'getSettings', 'setSettings', 'pickSaveDir', 'getDefaultSaveDir', 'openFile', 'showInFolder', 'exportPdf', 'quickAction', 'insertPrompt', 'getTemplates']

let fail = 0
function check(cond, msg) {
  if (!cond) { fail++; console.error('FAIL:', msg) } else { console.log('ok:', msg) }
}

check(registered.tools.length === expectedTools.length && expectedTools.every(t => registered.tools.includes(t)), 'tools: ' + registered.tools.join(', '))
check(registered.commands.includes('office'), 'command /office')
check(registered.panels.includes('main'), 'panel main (right)')
check(registered.widgets.length === 3, 'widgets: ' + registered.widgets.join(', '))
check(expectedHandlers.every(h => registered.handlers.includes(h)) && registered.handlers.length === expectedHandlers.length, 'rpc handlers: ' + registered.handlers.length)

// Шаблоны
const templates = require('../dist/lib/templates').getTemplates()
check(templates.length >= 10, 'templates: ' + templates.length)
check(templates.every(t => t.id && t.group && t.name && t.prompt && Array.isArray(t.fields)), 'templates valid')
const ids = templates.map(t => t.id)
check(new Set(ids).size === ids.length, 'template ids unique')

// specDoc
const doc = require('../dist/lib/word/specDoc').specDoc()
check(typeof doc === 'string' && doc.length > 1000 && doc.includes('word_create'), 'specDoc ' + doc.length + ' chars')
const xdoc = require('../dist/lib/excel/specDoc').specDoc()
check(typeof xdoc === 'string' && xdoc.length > 1000 && xdoc.includes('excel_create'), 'excel specDoc ' + xdoc.length + ' chars')
const pdoc = require('../dist/lib/ppt/specDoc').specDoc()
check(typeof pdoc === 'string' && pdoc.length > 1000 && pdoc.includes('ppt_create') && pdoc.includes('DESIGN TEMPLATES'), 'ppt specDoc ' + pdoc.length + ' chars')

// Темы презентаций
const { THEMES, findTheme } = require('../dist/lib/ppt/themes')
check(THEMES.length === 10, 'ppt themes: ' + THEMES.length)
check(THEMES.every(t => t.id && t.name && t.description && t.style && t.colors.bg && t.colors.accent && t.colors.text && t.fonts.head && typeof t.masterObjects === 'function'), 'themes valid')
check(!!findTheme('Midnight') && !!findTheme('corporate-blue'), 'findTheme case-insensitive')

process.exit(fail ? 1 : 0)
