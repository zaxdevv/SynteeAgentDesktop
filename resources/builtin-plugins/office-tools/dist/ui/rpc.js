// rpc — хендлеры вызовов из iframe (панель + виджеты): synteeBridge.call(...)
const state = require('../state')
const settings = require('../lib/settings')
const paths = require('../lib/paths')
const recent = require('../lib/recent')

function registerHandlers(syntee) {
  // ── Недавние файлы / текущий документ ──
  syntee.ui.handle('getRecent', async () => recent.list())
  syntee.ui.handle('getCurrent', async () => recent.getCurrent())
  syntee.ui.handle('clearRecent', async () => {
    await recent.clear()
    return { ok: true }
  })

  // ── Настройки ──
  syntee.ui.handle('getSettings', async () => settings.get())
  syntee.ui.handle('setSettings', async (patch) => settings.set(patch || {}))
  syntee.ui.handle('pickSaveDir', async () => {
    const dir = await state.api.fs.pickDir({ title: 'Папка для документов Office' })
    if (dir) await settings.set({ saveDir: dir })
    return { dir }
  })
  syntee.ui.handle('getDefaultSaveDir', async () => paths.getSaveDir())

  // ── Действия над файлами (из карточек и панели) ──
  syntee.ui.handle('openFile', async ({ path }) => {
    const ext = (path.split('.').pop() || '').toLowerCase()
    if (ext === 'docx' || ext === 'doc') {
      const com = require('../lib/com/word')
      await com.openDoc(path)
    } else if (ext === 'xlsx' || ext === 'xls') {
      const com = require('../lib/com/excel')
      await com.openBook(path)
    } else if (ext === 'pptx' || ext === 'ppt' || ext === 'ppsx' || ext === 'pps') {
      const com = require('../lib/com/powerpoint')
      await com.openPres(path)
    } else {
      const shell = require('../lib/com/shell')
      await shell.openWithDefault(path)
    }
    return { ok: true }
  })
  syntee.ui.handle('showInFolder', async ({ path }) => {
    const shell = require('../lib/com/shell')
    await shell.showInFolder(path)
    return { ok: true }
  })
  syntee.ui.handle('exportPdf', async ({ path }) => {
    const ext = (path.split('.').pop() || '').toLowerCase()
    let out
    if (ext === 'pptx' || ext === 'ppt' || ext === 'ppsx' || ext === 'pps') {
      const com = require('../lib/com/powerpoint')
      out = path.replace(/\.(pptx|ppt|ppsx|pps)$/i, '.pdf')
      await com.exportPdf(path, out)
    } else {
      const com = require('../lib/com/word')
      out = path.replace(/\.(docx|doc)$/i, '.pdf')
      await com.exportPdf(path, out)
    }
    return { ok: true, out }
  })

  // ── Быстрые действия: промпт в чат (запускает агента) ──
  syntee.ui.handle('quickAction', async ({ prompt }) => {
    if (!prompt) throw new Error('prompt обязателен')
    await state.api.chat.send(prompt)
    return { ok: true }
  })
  syntee.ui.handle('insertPrompt', async ({ prompt }) => {
    // только вставить в поле ввода, не отправлять
    await state.api.chat.send(prompt, { silent: true })
    return { ok: true }
  })

  // ── Шаблоны ──
  syntee.ui.handle('getTemplates', async () => {
    const templates = require('../lib/templates')
    return templates.getTemplates()
  })
}

module.exports = { registerHandlers }
