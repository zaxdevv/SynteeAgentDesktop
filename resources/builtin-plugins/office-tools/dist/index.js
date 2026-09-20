// index — ТОЛЬКО wiring: подключает модули
const state = require('./state')
const { registerTools } = require('./tools')
const { registerCommands } = require('./commands')
const { registerUi } = require('./ui')

module.exports.activate = function (syntee) {
  state.init(syntee)
  registerTools(syntee)
  registerCommands(syntee)
  registerUi(syntee)
  syntee.log.info('Office Tools активирован')
}

module.exports.deactivate = function () {
  state.cleanup()
}
