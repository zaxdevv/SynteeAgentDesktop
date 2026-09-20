// widgets — билдеры маркеров __plugin_ui__ (карточки в чате)
//
// Контракт data для каждого HTML-виджета (ui/widgets/*.html):
//  file-card:     { path, name, kind: 'word'|'excel'|'pdf', size, op, stats?, outline? }
//  table-preview: { path, name, sheet?, rows: [[cell,…]], totalRows, totalCols, headerRow? }
//  doc-preview:   { path, name, outline: [{ level, text }], stats }

const PLUGIN_ID = 'office-tools'

function fileCard({ entry }) {
  return JSON.stringify({
    __plugin_ui__: true,
    pluginId: PLUGIN_ID,
    entry: 'ui/widgets/file-card.html',
    height: 170,
    data: {
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      size: entry.size,
      op: entry.op,
      stats: entry.stats || null,
      outline: entry.outline || null,
    },
  })
}

function tablePreview({ path, name, sheet, rows, totalRows, totalCols }) {
  return JSON.stringify({
    __plugin_ui__: true,
    pluginId: PLUGIN_ID,
    entry: 'ui/widgets/table-preview.html',
    height: 260,
    data: { path, name, sheet: sheet || null, rows, totalRows, totalCols },
  })
}

function docPreview({ path, name, outline, stats }) {
  return JSON.stringify({
    __plugin_ui__: true,
    pluginId: PLUGIN_ID,
    entry: 'ui/widgets/doc-preview.html',
    height: 240,
    data: { path, name, outline, stats },
  })
}

module.exports = { fileCard, tablePreview, docPreview, PLUGIN_ID }
