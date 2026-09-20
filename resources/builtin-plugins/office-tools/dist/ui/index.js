// ui — регистрация панели, виджетов и RPC-хендлеров
const { registerHandlers } = require('./rpc')

function registerUi(syntee) {
  // Правая панель
  syntee.registerPanel({
    id: 'main',
    slot: 'right',
    title: 'Office',
    icon: 'star',
    entry: 'ui/panel.html',
  })

  // Виджеты-карточки в чате (декларация для system prompt)
  syntee.ui.registerWidget({ name: 'file-card', entry: 'ui/widgets/file-card.html', height: 170 })
  syntee.ui.registerWidget({ name: 'table-preview', entry: 'ui/widgets/table-preview.html', height: 260 })
  syntee.ui.registerWidget({ name: 'doc-preview', entry: 'ui/widgets/doc-preview.html', height: 240 })

  // RPC из iframe панели и виджетов
  registerHandlers(syntee)
}

module.exports = { registerUi }
