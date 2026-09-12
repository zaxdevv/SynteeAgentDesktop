/**
 * IPC handlers для плагинов.
 *
 * Каналы:
 *   plugins:getAll          — все плагины с состоянием + runtime (для popover)
 *   plugins:setState        — обновить enabled/scope (вкл = запуск процесса)
 *   plugins:reload          — hot reload (stop + start)
 *   plugins:uninstall       — остановить + удалить папку плагина
 *   plugins:installFromFolder — нативный диалог выбора папки + копирование
 *   plugins:getPaths        — пути папок плагинов (для кнопки «Открыть папку»)
 *
 * Push events (webContents.send):
 *   plugins:changed         — перезагрузить список в renderer
 *   plugins:logs            — { pluginId, logs[] } живой журнал
 *
 * PluginManager — синглтон, инициализируется в main/index.ts.
 */
import { ipcMain, BrowserWindow, dialog } from 'electron'
import Store from 'electron-store'
import { cpSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { v4 as uuid } from 'uuid'
import { getPluginManager } from '../../core/plugins/pluginManager'
import { getProjectById, getChatWorkdirContext, getAllProjects } from '../../core/db'
import { saveMessage } from '../../core/db/messages'
import { IFRAME_HOST_METHODS } from '../../shared/constants'
import type { ExtensionScope, Message } from '../../shared/types'

export function registerPluginsIPC(store: Store, getWindow: () => BrowserWindow | null): void {
  void store
  const mgr = () => getPluginManager()

  /** Резолвит { projectWorkdir, projectId } из params (chatId надёжнее). */
  const resolveProject = (params?: { projectId?: string; chatId?: string }): { projectWorkdir?: string; projectId?: string } => {
    let projectId = params?.projectId
    if (!projectId && params?.chatId) {
      try {
        const ctx = getChatWorkdirContext(params.chatId)
        if (ctx.workdir) {
          projectId = getAllProjects().find(p => p.workdir === ctx.workdir)?.id
        }
      } catch { /* ignore */ }
    }
    if (projectId) {
      const proj = getProjectById(projectId)
      if (proj?.workdir) return { projectWorkdir: proj.workdir, projectId }
    }
    return {}
  }

  ipcMain.handle('plugins:getAll', (_e, params?: { projectId?: string; chatId?: string }) => {
    const { projectWorkdir, projectId } = resolveProject(params)
    return mgr().getAllWithState({ projectWorkdir, projectId })
  })

  // Статус Python-интерпретатора (для карточек python-плагинов).
  ipcMain.handle('plugins:checkPython', () => mgr().checkPython())

  // Установка Python-зависимостей плагина (кнопка в карточке UI).
  ipcMain.handle('plugins:installDeps', (_e, params: { pluginId: string }) =>
    mgr().installPluginDeps(params.pluginId))

  ipcMain.handle('plugins:setState', async (_e, params: {
    pluginId: string
    enabled?: boolean
    scope?: ExtensionScope
    consented?: boolean
  }) => {
    const { projectWorkdir, projectId } = resolveProject()
    const m = mgr()
    if (params.consented !== undefined) m.setConsented(params.pluginId, params.consented)
    if (params.scope !== undefined) m.setScope(params.pluginId, params.scope)
    if (params.enabled !== undefined) {
      await m.setEnabled(params.pluginId, params.enabled, projectWorkdir, projectId)
    }
    return { ok: true }
  })

  // Выполнение слэш-команды плагина: RPC в процесс + сохранение диалога
  // (user-сообщение с командой + assistant-сообщение с результатом) в БД,
  // чтобы результат переживал перезагрузку. Возвращает оба сообщения.
  // chatId='' (кнопка в сайдбаре) — без записи в БД, только результат.
  ipcMain.handle('plugins:executeCommand', async (_e, params: {
    chatId: string
    pluginId: string
    name: string
    args: string
    text: string
  }) => {
    try {
      const result = await mgr().executeCommand(params.pluginId, params.name, params.args ?? '')
      let userMsg: Message | undefined
      let assistantMsg: Message | undefined
      if (params.chatId) {
        const now = Date.now()
        userMsg = {
          id: uuid(),
          chatId: params.chatId,
          role: 'user',
          content: params.text,
          createdAt: now - 1,
          isPinned: 0,
        }
        assistantMsg = {
          id: uuid(),
          chatId: params.chatId,
          role: 'assistant',
          content: result.ok
            ? (result.output || '(пустой результат команды)')
            : `⚠ Ошибка команды: ${result.error ?? 'неизвестно'}`,
          createdAt: now,
          isPinned: 0,
        }
        try {
          saveMessage(userMsg)
          saveMessage(assistantMsg)
        } catch (e) {
          console.warn('[plugins:executeCommand] saveMessage failed:', (e as Error).message)
        }
      }
      return { ok: result.ok, error: result.error, output: result.output, userMsg, assistantMsg }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Мост iframe-панель ↔ процесс плагина (renderer → main → plugin).
  ipcMain.handle('plugins:uiMessage', (_e, params: { pluginId: string; data: unknown }) => {
    mgr().sendUiMessage(params.pluginId, params.data)
    return { ok: true }
  })

  // RPC-мост: synteeBridge.call из iframe → ui.handle в плагине.
  ipcMain.handle('plugins:uiCall', (_e, params: { pluginId: string; method: string; args?: Record<string, unknown> }) =>
    mgr().uiCall(params.pluginId, params.method, params.args ?? {}))

  // Хук chat:before-send — renderer спрашивает перед отправкой сообщения.
  ipcMain.handle('plugins:beforeSend', (_e, params: { chatId: string; content: string }) =>
    mgr().beforeChatSend(params.chatId, params.content ?? ''))

  // Тема сменилась (renderer) → кэш + рассылка theme:changed в плагины.
  ipcMain.handle('plugins:themeChanged', (_e, params: { theme: string; accentColor: string }) => {
    mgr().setTheme(params.theme ?? 'dark', params.accentColor ?? '#22d3ee')
    return { ok: true }
  })

  // DevTools для отладки iframe-панелей (открывает devtools окна —
  // iframe виден в дереве фреймов).
  ipcMain.handle('plugins:openDevTools', () => {
    const win = getWindow()
    win?.webContents.openDevTools({ mode: 'detach' })
    return { ok: true }
  })

  // Сохранить ответ плагина (chat.reply) в чат — renderer передаёт текущий
  // chatId (main его не знает), сообщение пишется в БД и возвращается.
  ipcMain.handle('plugins:saveReply', (_e, params: { chatId: string; text: string }) => {
    if (!params.chatId) return { ok: false, error: 'Нет активного чата' }
    const msg: Message = {
      id: uuid(),
      chatId: params.chatId,
      role: 'assistant',
      content: params.text,
      createdAt: Date.now(),
      isPinned: 0,
    }
    try {
      saveMessage(msg)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    return { ok: true, message: msg }
  })

  // Настройки плагина (форма в карточке).
  ipcMain.handle('plugins:setConfig', (_e, params: { pluginId: string; values: Record<string, unknown> }) => {
    mgr().setConfigValues(params.pluginId, params.values)
    return { ok: true }
  })

  ipcMain.handle('plugins:reload', async (_e, pluginId: string) => {
    try {
      await mgr().reload(pluginId)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('plugins:uninstall', async (_e, params: { pluginId: string; source: 'global' | 'project'; dir?: string }) => {
    const m = mgr()
    // Встроенные плагины нельзя удалить — они восстанавливаются при каждом
    // запуске (syncBuiltinPlugins), поэтому удаление бессмысленно.
    const target = m.getAllWithState().find(p => p.id === params.pluginId)
    if (target?.manifest.builtin) {
      return { ok: false, error: 'Встроенный плагин нельзя удалить — он поставляется вместе с приложением. Его можно только выключить.' }
    }
    await m.stop(params.pluginId)
    // Чистим состояние.
    const stateMap = (store.get('pluginsState') as Record<string, unknown> | undefined) ?? {}
    delete stateMap[params.pluginId]
    store.set('pluginsState', stateMap)
    // Удаляем папку (для проектных dir приходит из getAll — там путь).
    const dir = params.dir
      ?? (m.getAllWithState().find(p => p.id === params.pluginId)?.dir ?? null)
    if (dir && existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    return { ok: true }
  })

  // Установка из папки: нативный диалог → копирование в plugins dir.
  ipcMain.handle('plugins:installFromFolder', async (_e, params?: { scope?: 'global' | { workdir: string } }) => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Выберите папку плагина',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    const src = result.filePaths[0]
    // Валидация: в папке должен быть plugin.json.
    if (!existsSync(join(src, 'plugin.json'))) {
      return { ok: false, error: 'В выбранной папке нет plugin.json — это не плагин' }
    }
    let pluginId = 'plugin'
    try {
      pluginId = (JSON.parse(readFileSync(join(src, 'plugin.json'), 'utf-8')) as { id: string }).id
    } catch {
      return { ok: false, error: 'plugin.json не читается или не содержит id' }
    }
    const destRoot = params?.scope && params.scope !== 'global'
      ? join((params.scope as { workdir: string }).workdir, '.syntee', 'plugins')
      : mgr().globalPluginsDir
    const dest = join(destRoot, pluginId)
    try {
      if (existsSync(dest)) {
        rmSync(dest, { recursive: true, force: true })
      }
      cpSync(src, dest, { recursive: true })
    } catch (e) {
      return { ok: false, error: `Копирование не удалось: ${(e as Error).message}` }
    }
    return { ok: true, pluginId }
  })

  ipcMain.handle('plugins:getPaths', () => ({
    globalPluginsDir: mgr().globalPluginsDir,
  }))

  // ── Провайдеры плагинов (renderer → plugin process) ─────────────────────

  // Поиск по всем search-провайдерам плагинов (Spotlight).
  ipcMain.handle('plugins:search', async (_e, params: { query: string }) => {
    try {
      return await mgr().searchAll(String(params.query ?? ''))
    } catch {
      return []
    }
  })

  // Клик по результату поиска плагина → хендлер провайдера.
  ipcMain.handle('plugins:searchClick', async (_e, params: {
    pluginId: string
    providerId: string
    item: { id: string; label: string; sub?: string; icon?: string }
  }) => {
    await mgr().searchClick(params.pluginId, params.providerId, params.item ?? {})
    return { ok: true }
  })

  // Autocomplete: текст поля → подсказки провайдера (null — триггера нет).
  ipcMain.handle('plugins:autocomplete', async (_e, params: { text: string }) => {
    try {
      return await mgr().autocompleteSuggest(String(params.text ?? ''))
    } catch {
      return null
    }
  })

  // Клик по пункту контекстного меню сообщений → хендлер плагина.
  ipcMain.handle('plugins:contextMenuClick', async (_e, params: {
    pluginId: string
    itemId: string
    payload: { messageId: string; chatId: string; content: string; selection?: string }
  }) => {
    await mgr().contextMenuAction(params.pluginId, params.itemId, params.payload ?? {})
    return { ok: true }
  })

  // Клик по кнопке rich-уведомления плагина → выполнить его слэш-команду.
  ipcMain.handle('plugins:notificationAction', async (_e, params: { pluginId: string; command: string }) => {
    const r = await mgr().executeCommand(params.pluginId, params.command, '')
    return r
  })

  // Клик по кнопке плагина над инпутом (registerInputAction без command)
  // → событие 'input-action' в процесс плагина.
  ipcMain.handle('plugins:inputAction', (_e, params: { pluginId: string; actionId: string }) => {
    mgr().emitInputAction(params.pluginId, params.actionId)
    return { ok: true }
  })

  // Панель плагина открыта/закрыта (renderer) → событие 'panel:opened'/
  // 'panel:closed' в процесс плагина (если подписан).
  ipcMain.handle('plugins:panelLifecycle', (_e, params: {
    pluginId: string
    panelId: string
    action: 'opened' | 'closed'
  }) => {
    mgr().emitPanelLifecycle(params.pluginId, params.action, params.panelId)
    return { ok: true }
  })

  // Прямые host-методы для iframe-панелей (synteeBridge.call с method из
  // белого списка — без хопа через ui.handle плагина). Права проверяются
  // по манифесту плагина в handleHostRequest. Список — shared/constants
  // (единый источник для main и renderer/PluginIframe).
  const IFRAME_METHODS = new Set(IFRAME_HOST_METHODS)
  ipcMain.handle('plugins:iframeCall', async (_e, params: {
    pluginId: string
    method: string
    args?: Record<string, unknown>
  }) => {
    if (!IFRAME_METHODS.has(params.method)) {
      return { ok: false, error: `Метод "${params.method}" недоступен из iframe-панели` }
    }
    // Права по манифесту: маппинг метод → permission (как в pluginHost).
    const METHOD_PERMS: Record<string, string> = {
      'fs.readFile': 'fs:read', 'fs.listDir': 'fs:read', 'fs.stat': 'fs:read',
      'clipboard.readText': 'clipboard', 'clipboard.writeText': 'clipboard',
      'chats.list': 'chats:read', 'chats.get': 'chats:read',
      'projects.list': 'projects:read', 'projects.current': 'projects:read',
      'memory.search': 'memory',
      'ai.listModels': 'ai',
    }
    const perm = METHOD_PERMS[params.method]
    if (perm) {
      const plugin = mgr().getAllWithState().find(p => p.id === params.pluginId)
      if (plugin && !(plugin.manifest.permissions ?? []).includes(perm as never)) {
        return { ok: false, error: `Permission denied: ${params.method} требует "${perm}"` }
      }
    }
    return mgr().handleHostRequestForIframe(params.pluginId, params.method, params.args ?? {})
  })
}
