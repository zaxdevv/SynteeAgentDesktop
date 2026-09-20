// backup — копия оригинала до перезаписи (страховка для word_edit/excel_edit).
// Рядом с файлом кладём <path>.bak (перезаписывается на каждом edit).
const fs = require('fs')

/**
 * Best-effort бэкап: копирует path → path + '.bak'.
 * @returns {string|null} путь к бэкапу или null, если скопировать не удалось
 *   (edit при этом НЕ должен падать из-за проблем с бэкапом).
 */
function backupFile(path) {
  try {
    const bak = path + '.bak'
    fs.copyFileSync(path, bak)
    return bak
  } catch (e) {
    return null
  }
}

module.exports = { backupFile }
