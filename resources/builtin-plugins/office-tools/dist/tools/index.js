// tools — реестр тулов: подключает группы
const { registerWordTools } = require('./wordCreate')
const { registerWordReadTools } = require('./wordRead')
const { registerWordEditTools } = require('./wordEdit')
const { registerWordCompareTools } = require('./wordCompare')
const { registerExcelTools } = require('./excelCreate')
const { registerExcelReadTools } = require('./excelRead')
const { registerExcelEditTools } = require('./excelEdit')
const { registerConvertTools } = require('./convert')
const { registerComTools } = require('./com')
const { registerPptTools } = require('./pptCreate')
const { registerPptReadTools } = require('./pptRead')
const { registerPptEditTools } = require('./pptEdit')
const { registerPptTemplateTools } = require('./pptTemplates')

function registerTools(syntee) {
  registerWordTools(syntee)
  registerWordReadTools(syntee)
  registerWordEditTools(syntee)
  registerWordCompareTools(syntee)
  registerExcelTools(syntee)
  registerExcelReadTools(syntee)
  registerExcelEditTools(syntee)
  registerConvertTools(syntee)
  registerComTools(syntee)
  registerPptTools(syntee)
  registerPptReadTools(syntee)
  registerPptEditTools(syntee)
  registerPptTemplateTools(syntee)
}

module.exports = { registerTools }
