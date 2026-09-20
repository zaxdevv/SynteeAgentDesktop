// templates/index — реестр шаблонов документов для панели
'use strict'

const business = require('./business')
const reports = require('./reports')
const excel = require('./excel')
const presentation = require('./presentation')

/**
 * Шаблон: { id, group: 'business'|'report'|'excel', name, description,
 *           fields: [{ key, label, placeholder? }], prompt }
 * prompt — самодостаточная постановка для агента (рус.),
 * {{key}} подставляются из полей мини-формы в панели.
 */
function getTemplates() {
  return [...business, ...reports, ...excel, ...presentation]
}

module.exports = { getTemplates }
