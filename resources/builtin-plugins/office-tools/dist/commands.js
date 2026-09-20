// commands — слэш-команды плагина
const state = require('./state')

function registerCommands(syntee) {
  syntee.registerCommand({
    name: 'office',
    description: 'Открыть панель Office Tools',
    icon: 'star',
    handler: async () => {
      // Панель регистрируется в ui/index.js; открываем через emit-канал панели
      try {
        await state.api.ui.emit('office:open-panel', {})
      } catch { /* ignore */ }
      syntee.log.info('Панель Office: используйте вкладку Office в правой панели')
    },
  })
}

module.exports = { registerCommands }
