import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SkillFolderUpdate } from '../shared/types'

// Типизированный API bridge для renderer
const synteeAPI = {
  // Окно
  window: {
    hide: () => ipcRenderer.invoke('window:hide'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    show: () => ipcRenderer.invoke('window:show'),
    // Развернуть/восстановить (кнопка в кастомной шапке). Смена состояния
    // приходит событием 'window:maximize-changed' через syntee.on().
    maximizeToggle: () => ipcRenderer.invoke('window:maximizeToggle'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
  },

  // Настройки
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    getAutostartStatus: () => ipcRenderer.invoke('settings:autostartStatus') as Promise<boolean>,
  },

  // Системная тема Windows (nativeTheme в main-процессе)
  systemTheme: {
    isDark: () => ipcRenderer.invoke('systemTheme:isDark') as Promise<boolean>,
    onChange: (cb: (isDark: boolean) => void) => {
      const handler = (_e: unknown, isDark: boolean) => cb(isDark)
      ipcRenderer.on('systemTheme:changed', handler)
      return () => ipcRenderer.removeListener('systemTheme:changed', handler)
    },
  },

  // Background image — сохранение/загрузка файлов в userData/bg-images/
  // Папка = библиотека: несколько картинок, переключение, удаление.
  bgImage: {
    save: (data: Uint8Array, ext: string) => ipcRenderer.invoke('bgImage:save', data, ext) as Promise<string | null>,
    list: () => ipcRenderer.invoke('bgImage:list') as Promise<{ src: string; name: string; size: number; mtime: number }[]>,
    load: (src: string) => ipcRenderer.invoke('bgImage:load', src) as Promise<string | null>,
    delete: (src: string) => ipcRenderer.invoke('bgImage:delete', src) as Promise<boolean>,
    clear: () => ipcRenderer.invoke('bgImage:clear') as Promise<boolean>,
  },

  // Sound files — кастомные звуки интерфейса в userData/sounds/.
  // Встроенные (synth.*) генерируются в renderer через Web Audio.
  sound: {
    save: (data: Uint8Array, ext: string, originalName?: string) => ipcRenderer.invoke('sound:save', data, ext, originalName) as Promise<string | null>,
    list: () => ipcRenderer.invoke('sound:list') as Promise<{ id: string; name: string; size: number; mtime: number }[]>,
    load: (id: string) => ipcRenderer.invoke('sound:load', id) as Promise<string | null>,
    delete: (id: string) => ipcRenderer.invoke('sound:delete', id) as Promise<boolean>,
    // ── Internet Archive search (keyless, free) ──
    search: (query: string, page?: number, shortOnly?: boolean) => ipcRenderer.invoke('sound:search', query, page, shortOnly) as Promise<{
      results: { identifier: string; title: string; downloads: number; size: number }[]
      total: number; page: number
    }>,
    getFiles: (identifier: string) => ipcRenderer.invoke('sound:getFiles', identifier) as Promise<{
      files: { name: string; length: string; size: number }[]
      title: string
    }>,
    fetchPreview: (identifier: string, filename: string) => ipcRenderer.invoke('sound:fetchPreview', identifier, filename) as Promise<string | null>,
    cancelPreview: () => ipcRenderer.invoke('sound:cancelPreview') as Promise<boolean>,
    saveRemote: (identifier: string, filename: string, title: string) => ipcRenderer.invoke('sound:saveRemote', identifier, filename, title) as Promise<string | null>,
  },

  // Custom fonts — кастомные шрифты в userData/custom-fonts/.
  // import: сохранить файл шрифта, вернуть custom-fonts:// URL.
  // list: список установленных шрифтов.
  // read: прочитать файл как data URL для @font-face инжекта.
  // delete: удалить шрифт.
  fonts: {
    import: (data: Uint8Array, filename: string) => ipcRenderer.invoke('font:import', data, filename) as Promise<string | null>,
    list: () => ipcRenderer.invoke('font:list') as Promise<{ id: string; name: string; size: number; mtime: number }[]>,
    read: (id: string) => ipcRenderer.invoke('font:read', id) as Promise<string | null>,
    delete: (id: string) => ipcRenderer.invoke('font:delete', id) as Promise<boolean>,
  },

  // Syntee-Gateway авторизация и профиль
  auth: {
    // Открыть браузер на consent-странице gateway (deep-link вернёт код обратно).
    login: () => ipcRenderer.invoke('auth:login'),
    // Проверить, есть ли сохранённые токены.
    isLoggedIn: () => ipcRenderer.invoke('auth:isLoggedIn') as Promise<boolean>,
    // Получить текущего пользователя (или null если не залогинен).
    me: () => ipcRenderer.invoke('auth:me'),
    // Выйти — стирает токены.
    logout: () => ipcRenderer.invoke('auth:logout'),
    // Подписка на события входа/выхода (deep-link callback).
    onLoggedIn: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('auth:logged-in', handler)
      return () => ipcRenderer.removeListener('auth:logged-in', handler)
    },
    onLoggedOut: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('auth:logged-out', handler)
      return () => ipcRenderer.removeListener('auth:logged-out', handler)
    },
    onLoginError: (cb: (err: { message: string }) => void) => {
      const handler = (_e: unknown, err: { message: string }) => cb(err)
      ipcRenderer.on('auth:login-error', handler)
      return () => ipcRenderer.removeListener('auth:login-error', handler)
    },
  },

  // Профиль пользователя gateway (имя, аватар, пароль, API-ключи)
  profile: {
    update: (payload: { display_name?: string | null; avatar_url?: string | null; username?: string }) =>
      ipcRenderer.invoke('profile:update', payload),
    checkUsername: (username: string) => ipcRenderer.invoke('profile:checkUsername', username),
    changePassword: (currentPassword: string, newPassword: string) =>
      ipcRenderer.invoke('profile:changePassword', currentPassword, newPassword),
    listApiKeys: () => ipcRenderer.invoke('profile:listApiKeys'),
    createApiKey: (name: string) => ipcRenderer.invoke('profile:createApiKey', name),
    deleteApiKey: (keyId: string) => ipcRenderer.invoke('profile:deleteApiKey', keyId),
  },

  // Syntee-Gateway модели и статусы (фаза 2)
  gateway: {
    // Список моделей gateway (/v1/models). Возвращает { models, error }:
    // при транзиентном сбое models = последний закэшированный список (stale),
    // error = сообщение об ошибке. При успехе error = null.
    // GatewayAuthError пробрасывается reject'ом (сценарий логаута).
    fetchModels: () => ipcRenderer.invoke('gateway:fetchModels'),
    // Per-model uptime buckets за 12 часов — для панели статуса.
    fetchModelStatus: () => ipcRenderer.invoke('gateway:fetchModelStatus'),
    // Per-provider request counts + uptime за 1 час.
    fetchProviderStatus: () => ipcRenderer.invoke('gateway:fetchProviderStatus'),
    // Доступен ли gateway (залогинен ли юзер).
    isAvailable: () => ipcRenderer.invoke('gateway:isAvailable') as Promise<boolean>,
  },

  // Биллинг и лимиты (фаза 3)
  billing: {
    balance: () => ipcRenderer.invoke('billing:balance'),
    transactions: (params?: { limit?: number; offset?: number }) =>
      ipcRenderer.invoke('billing:transactions', params ?? {}),
    summary: (params?: { hours?: number }) =>
      ipcRenderer.invoke('billing:summary', params ?? {}),
    timeseries: (params?: { hours?: number }) =>
      ipcRenderer.invoke('billing:timeseries', params ?? {}),
    breakdown: (params?: { hours?: number; by?: 'model' | 'provider' | 'status' | 'format' }) =>
      ipcRenderer.invoke('billing:breakdown', params ?? {}),
    plan: () => ipcRenderer.invoke('billing:plan'),
    // Открыть страницу пополнения в браузере.
    openTopup: () => ipcRenderer.invoke('billing:openTopup'),
  },

  // Локальная статистика использования (Настройки → Статистика):
  // сообщения/токены/модели/топ-чаты/вложения/ссылки из локальной БД.
  stats: {
    overview: (params?: { hours?: number }) =>
      ipcRenderer.invoke('stats:overview', params ?? {}),
  },

  // ── Мессенджер (друзья + личные сообщения, фаза 1) ────────────────────
  // WS-соединение живёт в main-процессе (токены не покидают main).
  // connect/disconnect — жизненный цикл. ws:send — отправка envelope в WS.
  // onEvent — подписка на все входящие WS-события + ws:open/ws:close.
  messenger: {
    connect: () => ipcRenderer.invoke('messenger:connect') as Promise<{ ok: boolean }>,
    disconnect: () => ipcRenderer.invoke('messenger:disconnect') as Promise<{ ok: boolean }>,
    wsSend: (envelope: { type: string; data: Record<string, unknown> }) =>
      ipcRenderer.invoke('messenger:ws:send', envelope) as Promise<{ ok: boolean }>,
    setActive: (conversationId: string | null) =>
      ipcRenderer.invoke('messenger:setActive', conversationId) as Promise<{ ok: boolean }>,
    onEvent: (cb: (envelope: { type: string; data: Record<string, unknown> }) => void) => {
      const handler = (_e: unknown, envelope: { type: string; data: Record<string, unknown> }) => cb(envelope)
      ipcRenderer.on('messenger:event', handler)
      return () => ipcRenderer.removeListener('messenger:event', handler)
    },
    // ── Друзья ──
    friends: {
      list: () => ipcRenderer.invoke('messenger:friends:list'),
      requests: () => ipcRenderer.invoke('messenger:friends:requests'),
      search: (username: string) => ipcRenderer.invoke('messenger:friends:search', username),
      request: (username: string) => ipcRenderer.invoke('messenger:friends:request', username),
      accept: (userId: string) => ipcRenderer.invoke('messenger:friends:accept', userId),
      decline: (userId: string) => ipcRenderer.invoke('messenger:friends:decline', userId),
      unfriend: (userId: string) => ipcRenderer.invoke('messenger:friends:unfriend', userId),
      block: (userId: string) => ipcRenderer.invoke('messenger:friends:block', userId),
      unblock: (userId: string) => ipcRenderer.invoke('messenger:friends:unblock', userId),
      hide: (userId: string) => ipcRenderer.invoke('messenger:friends:hide', userId),
      unhide: (userId: string) => ipcRenderer.invoke('messenger:friends:unhide', userId),
    },
    // ── Диалоги и сообщения ──
    conversations: {
      list: () => ipcRenderer.invoke('messenger:conversations:list'),
      create: (otherId: string) => ipcRenderer.invoke('messenger:conversations:create', otherId),
    },
    messages: {
      list: (conversationId: string, cursor?: string | null, limit?: number) =>
        ipcRenderer.invoke('messenger:messages:list', conversationId, cursor, limit),
      send: (conversationId: string, payload: {
        message_type?: 'text' | 'code' | 'image' | 'file'
        body?: string | null
        attachment_token?: string | null
        attachment_filename?: string | null
        attachment_mime?: string | null
        attachment_size?: number | null
        reply_to_id?: string | null
      }) => ipcRenderer.invoke('messenger:messages:send', conversationId, payload),
      read: (conversationId: string, messageId: string) =>
        ipcRenderer.invoke('messenger:messages:read', conversationId, messageId),
      typing: (conversationId: string) => ipcRenderer.invoke('messenger:messages:typing', conversationId),
      react: (conversationId: string, messageId: string, emoji: string) =>
        ipcRenderer.invoke('messenger:messages:react', conversationId, messageId, emoji),
      delete: (conversationId: string, messageId: string) =>
        ipcRenderer.invoke('messenger:messages:delete', conversationId, messageId),
      search: (q: string, conversationId?: string) =>
        ipcRenderer.invoke('messenger:messages:search', q, conversationId),
    },
    // ── Вложения ──
    attachments: {
      upload: (file: File) => ipcRenderer.invoke('messenger:attachments:upload', file),
      fetch: (conversationId: string, messageId: string) =>
        ipcRenderer.invoke('messenger:attachments:fetch', conversationId, messageId),
    },
    // ── Шаринг чатов (Фаза 3) ──
    // shareChat упаковывает локальный чат и отправляет его другу через DM.
    // importShare скачивает снапшот и импортирует в локальную SQLite.
    shares: {
      shareChat: (chatId: string, recipientId: string) =>
        ipcRenderer.invoke('messenger:shareChat', chatId, recipientId) as Promise<
          { ok: true; share: unknown } | { error: string }
        >,
      importShare: (shareId: string) =>
        ipcRenderer.invoke('messenger:importShare', shareId) as Promise<
          { chatId: string; messages: unknown[]; title: string } | { error: string }
        >,
    },
    // ── Общий чат (Lounge, Фаза 2) ──
    global: {
      list: (cursor?: string | null, limit?: number) =>
        ipcRenderer.invoke('messenger:global:list', cursor, limit),
      send: (payload: {
        message_type?: 'text' | 'code' | 'image' | 'file'
        body?: string | null
        attachment_token?: string | null
        attachment_filename?: string | null
        attachment_mime?: string | null
        attachment_size?: number | null
        reply_to_id?: string | null
      }) => ipcRenderer.invoke('messenger:global:send', payload),
      read: (messageId: string) => ipcRenderer.invoke('messenger:global:read', messageId),
      unread: () => ipcRenderer.invoke('messenger:global:unread'),
      react: (messageId: string, emoji: string) =>
        ipcRenderer.invoke('messenger:global:react', messageId, emoji),
      delete: (messageId: string) => ipcRenderer.invoke('messenger:global:delete', messageId),
      typing: () => ipcRenderer.invoke('messenger:global:typing'),
      fetchAttachment: (messageId: string) =>
        ipcRenderer.invoke('messenger:global:fetchAttachment', messageId),
      shareChat: (chatId: string) =>
        ipcRenderer.invoke('messenger:global:shareChat', chatId) as Promise<
          { ok: true; message: unknown } | { error: string }
        >,
    },
  },

  // Устройства вывода Windows и их live peak-meter (только чтение).
  // Монитор работает только пока открыты настройки визуализатора.
  audioDevices: {
    startMonitor: () => ipcRenderer.invoke('audioDevices:startMonitor') as Promise<Array<{ id: string; name: string; isDefault: boolean; level: number }>>,
    stopMonitor: () => ipcRenderer.invoke('audioDevices:stopMonitor') as Promise<boolean>,
    list: () => ipcRenderer.invoke('audioDevices:list') as Promise<Array<{ id: string; name: string; isDefault: boolean; level: number }>>,
    onUpdate: (cb: (devices: Array<{ id: string; name: string; isDefault: boolean; level: number }>) => void) => {
      const handler = (_event: unknown, devices: Array<{ id: string; name: string; isDefault: boolean; level: number }>) => cb(devices)
      ipcRenderer.on('audioDevices:update', handler)
      return () => ipcRenderer.removeListener('audioDevices:update', handler)
    },
    onStopped: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('audioDevices:stopped', handler)
      return () => ipcRenderer.removeListener('audioDevices:stopped', handler)
    },
  },

  // Захват системного звука с ВЫБРАННОГО устройства (WASAPI loopback в
  // main-процессе). Системные настройки Windows не меняются.
  audioVisualizer: {
    start: (deviceId: string | null) => ipcRenderer.invoke('audioVisualizer:start', deviceId) as Promise<{ deviceId: string; name: string; sampleRate: number; channels: number }>,
    stop: () => ipcRenderer.invoke('audioVisualizer:stop') as Promise<boolean>,
    setAgc: (enabled: boolean) => ipcRenderer.invoke('audioVisualizer:setAgc', enabled) as Promise<boolean>,
    onFrame: (cb: (frame: { level: number; bands: number[]; bass: number; mid: number; treble: number; timestamp: number; muted: boolean } | null) => void) => {
      const handler = (_event: unknown, frame: { level: number; bands: number[]; bass: number; mid: number; treble: number; timestamp: number; muted: boolean } | null) => cb(frame)
      ipcRenderer.on('audioVisualizer:frame', handler)
      return () => ipcRenderer.removeListener('audioVisualizer:frame', handler)
    },
    onStopped: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('audioVisualizer:stopped', handler)
      return () => ipcRenderer.removeListener('audioVisualizer:stopped', handler)
    },
  },

  // Система
  system: {
    info: () => ipcRenderer.invoke('system:info'),
    logError: (message: string, stack?: string) =>
      ipcRenderer.invoke('system:logError', message, stack),
  },

  // Оверлей
  overlay: {
    show: () => ipcRenderer.invoke('overlay:show'),
    hide: () => ipcRenderer.invoke('overlay:hide'),
    getDisplays: () => ipcRenderer.invoke('overlay:getDisplays'),
    captureScreen: () => ipcRenderer.invoke('overlay:captureScreen'),
    analyze: (params: { imageBase64: string; prompt: string; action: string }) =>
      ipcRenderer.invoke('overlay:analyze', params),
    saveScreenshot: (base64: string) => ipcRenderer.invoke('overlay:saveScreenshot', base64),
  },

  // ── Notification overlay ──────────────────────────────────────────
  // Управление overlay-хабом (уведомления + activity). push — подписка на
  // входящие уведомления (main → renderer event). setInteractive — единая
  // политика мыши: renderer hit-testing (elementFromPoint на mousemove)
  // решает когда окно ловит клики, IPC уходит только на смену состояния.
  notification: {
    show: () => ipcRenderer.invoke('notification:show'),
    hide: () => ipcRenderer.invoke('notification:hide'),
    action: (payload: { id: string; actionId: string; type: string; chatId?: string; reqId?: string }) =>
      ipcRenderer.send('notification:action', payload),
    // Единая политика мыши: true = окно ловит события (курсор над
    // data-interactive элементом), false = click-through + forward.
    setInteractive: (v: boolean) =>
      ipcRenderer.send('overlay:setInteractive', v),
    captureScreen: () => ipcRenderer.invoke('notification:captureScreen') as Promise<string | null>,
    onPush: (cb: (payload: import('../../shared/types').NotificationPayload) => void) => {
      const handler = (_: unknown, payload: unknown) =>
        cb(payload as import('../../shared/types').NotificationPayload)
      ipcRenderer.on('notification:push', handler)
      return () => ipcRenderer.removeListener('notification:push', handler)
    },
    onDismissAll: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('notification:dismissAll', handler)
      return () => ipcRenderer.removeListener('notification:dismissAll', handler)
    },
  },

  // ── Activity overlay (информер активности ИИ) ──────────────────────
  // Подписки на live-события агента, форвардятся из chat.ipc.ts через
  // ActivityManager в notificationWindow. События приходят ТОЛЬКО в
  // overlay-окно уведомлений (notifWin.webContents.send).
  activity: {
    onStep: (cb: (step: {
      type: string; toolName?: string; toolArgs?: Record<string, unknown>
      content?: string; success?: boolean; msgId?: string
      callId?: string; pendingCallId?: string; chatId?: string
    }) => void) => {
      const handler = (_: unknown, step: unknown) => cb(step as any)
      ipcRenderer.on('activity:step', handler)
      return () => ipcRenderer.removeListener('activity:step', handler)
    },
    onToolProgress: (cb: (data: {
      msgId: string; chatId: string; toolName: string; stage: string
      detail?: string; filesProcessed?: number; filesTotal?: number
    }) => void) => {
      const handler = (_: unknown, data: unknown) => cb(data as any)
      ipcRenderer.on('activity:tool_progress', handler)
      return () => ipcRenderer.removeListener('activity:tool_progress', handler)
    },
    onRunStatus: (cb: (data: {
      chatId: string; status: string; msgId?: string; error?: string
    }) => void) => {
      const handler = (_: unknown, data: unknown) => cb(data as any)
      ipcRenderer.on('activity:run:status', handler)
      return () => ipcRenderer.removeListener('activity:run:status', handler)
    },
    onHide: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('activity:hide', handler)
      return () => ipcRenderer.removeListener('activity:hide', handler)
    },
    onShow: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('activity:show', handler)
      return () => ipcRenderer.removeListener('activity:show', handler)
    },
  },

  // Spotlight
  spotlight: {
    show: () => ipcRenderer.invoke('spotlight:show'),
    hide: () => ipcRenderer.invoke('spotlight:hide'),
    expand: () => ipcRenderer.invoke('spotlight:expand'),
    collapse: () => ipcRenderer.invoke('spotlight:collapse'),
    // Relay-действия: прячем spotlight, показываем главное окно и шлём
    // nav:* событие в его webContents. App.tsx слушает и обрабатывает.
    // quickAsk: query + опциональный chatId (если есть — отправить в текущий).
    quickAsk: (query: string, chatId?: string) => ipcRenderer.invoke('spotlight:quickAsk', query, chatId),
    newChat: () => ipcRenderer.invoke('spotlight:newChat'),
    openChat: (chatId: string) => ipcRenderer.invoke('spotlight:openChat', chatId),
    // openSettings с опциональной секцией ('voice' | 'memory' | 'general' | ...).
    openSettings: (section?: string) => ipcRenderer.invoke('spotlight:openSettings', section),
    // История запросов Spotlight (персистится в electron-store).
    getHistory: () => ipcRenderer.invoke('spotlight:getHistory') as Promise<string[]>,
    addHistory: (query: string) => ipcRenderer.invoke('spotlight:addHistory', query),
    clearHistory: () => ipcRenderer.invoke('spotlight:clearHistory'),
  },

  // Кастомное трей-меню (frameless glass-окно). action — id действия
  // (showMain/showVoice/showSpotlight/openSettings/quit), выполняется в
  // main-процессе. getMeta — версия приложения для хедера/блока «О программе».
  trayMenu: {
    hide: () => ipcRenderer.invoke('tray-menu:hide'),
    action: (actionId: string) => ipcRenderer.invoke('tray-menu:action', actionId),
    getMeta: () => ipcRenderer.invoke('tray-menu:getMeta') as Promise<{ version: string }>,
    // Plugins: пункты меню от плагинов (снапшот при показе + push при изменении).
    getPluginItems: () => ipcRenderer.invoke('tray-menu:getPluginItems') as Promise<
      Array<{ pluginId: string; label: string; command?: string; type: 'item' | 'separator' }>
    >,
    onPluginItemsChanged: (cb: (items: Array<{ pluginId: string; label: string; command?: string; type: 'item' | 'separator' }>) => void) => {
      const listener = (_e: unknown, items: Array<{ pluginId: string; label: string; command?: string; type: 'item' | 'separator' }>) => cb(items)
      ipcRenderer.on('tray-menu:plugins-changed', listener)
      return () => ipcRenderer.removeListener('tray-menu:plugins-changed', listener)
    },
    pluginAction: (pluginId: string, label: string, command?: string) =>
      ipcRenderer.invoke('tray-menu:pluginAction', pluginId, label, command),
  },

  // Dots — always-on фоновые агенты (аналог OpenAI Dots)
  dots: {
    list: () => ipcRenderer.invoke('dots:list') as Promise<import('../../shared/types').Dot[]>,
    get: (dotId: string) => ipcRenderer.invoke('dots:get', dotId) as Promise<import('../../shared/types').Dot | null>,
    create: (input: {
      name: string
      icon: string
      color: string
      purpose: string
      rules?: string
      schedule?: { kind: 'cron' | 'interval'; value: string }
      watchPaths?: string[]
      webhookEnabled?: boolean
      modelId?: string | null
      modelProvider?: string | null
    }) => ipcRenderer.invoke('dots:create', input) as Promise<{ ok: boolean; dot?: import('../../shared/types').Dot; error?: string }>,
    update: (dotId: string, patch: Partial<import('../../shared/types').DotConfig>) =>
      ipcRenderer.invoke('dots:update', dotId, patch) as Promise<{ ok: boolean; dot?: import('../../shared/types').Dot; error?: string }>,
    delete: (dotId: string) => ipcRenderer.invoke('dots:delete', dotId) as Promise<{ ok: boolean }>,
    runNow: (dotId: string) => ipcRenderer.invoke('dots:runNow', dotId) as Promise<{ ok: boolean; reason?: string }>,
    getRuns: (dotId: string, limit?: number) =>
      ipcRenderer.invoke('dots:getRuns', dotId, limit) as Promise<import('../../shared/types').DotRun[]>,
    unreadCounts: (pairs: Array<{ dotId: string; since: number }>) =>
      ipcRenderer.invoke('dots:unreadCounts', pairs) as Promise<Record<string, number>>,
    getWebhookUrl: (dotId: string) => ipcRenderer.invoke('dots:getWebhookUrl', dotId) as Promise<string | null>,
    getSettings: () => ipcRenderer.invoke('dots:getSettings') as Promise<import('../../shared/types').DotSettings>,
    setSettings: (patch: Partial<import('../../shared/types').DotSettings>) =>
      ipcRenderer.invoke('dots:setSettings', patch) as Promise<import('../../shared/types').DotSettings>,
  },

  // Встроенный браузер (правая панель, webview). Renderer хостит webview-
  // элементы и регистрирует их в main; операции идут через BrowserManager.
  browser: {
    // Регистрация таба: did-attach → webContentsId guest-процесса.
    registerTab: (tabId: string, webContentsId: number) =>
      ipcRenderer.invoke('browser:registerTab', tabId, webContentsId) as Promise<boolean>,
    unregisterTab: (tabId: string) =>
      ipcRenderer.invoke('browser:unregisterTab', tabId) as Promise<boolean>,
    // UI-навигация (адресная строка, кнопки).
    navigate: (tabId: string, url: string) =>
      ipcRenderer.invoke('browser:navigate', tabId, url) as Promise<boolean>,
    back: (tabId: string) => ipcRenderer.invoke('browser:back', tabId) as Promise<boolean>,
    forward: (tabId: string) => ipcRenderer.invoke('browser:forward', tabId) as Promise<boolean>,
    reload: (tabId: string) => ipcRenderer.invoke('browser:reload', tabId) as Promise<boolean>,
    // Табы: создание/закрытие/активация (main пушит BROWSER_TAB_STATE).
    newTab: (url?: string) => ipcRenderer.invoke('browser:newTab', url) as Promise<string>,
    closeTab: (tabId: string) => ipcRenderer.invoke('browser:closeTab', tabId) as Promise<boolean>,
    selectTab: (tabId: string) => ipcRenderer.invoke('browser:selectTab', tabId) as Promise<boolean>,
    getState: () => ipcRenderer.invoke('browser:getState') as Promise<{
      tabs: Array<{ tabId: string; webContentsId: number; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; favicon?: string; discarded?: boolean }>
      activeTabId: string | null
    }>,
    // Видимый таб (панель открыта + таб «Браузер» + этот таб активен) —
    // main мьютит звук остальных. null = браузер не виден.
    setVisibleTab: (tabId: string | null) =>
      ipcRenderer.invoke('browser:setVisibleTab', tabId) as Promise<boolean>,
    // Кэш сессии браузера: размер (байты) + очистка.
    getCacheSize: () => ipcRenderer.invoke('browser:getCacheSize') as Promise<number>,
    clearCache: () => ipcRenderer.invoke('browser:clearCache') as Promise<boolean>,
    // Событие: состояние табов изменилось (URL/title/loading/favicon).
    onTabState: (cb: (state: {
      tabs: Array<{ tabId: string; webContentsId: number; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; favicon?: string; discarded?: boolean }>
      activeTabId: string | null
    }) => void) => {
      const listener = (_e: unknown, state: Parameters<typeof cb>[0]) => cb(state)
      ipcRenderer.on('browser:tab-state', listener)
      return () => ipcRenderer.removeListener('browser:tab-state', listener)
    },
    // Событие: browserMode чата переключён (тумблером или confirm'ом AI).
    onModeChanged: (cb: (info: { chatId: string; enabled: boolean }) => void) => {
      const listener = (_e: unknown, info: { chatId: string; enabled: boolean }) => cb(info)
      ipcRenderer.on('browser:mode-changed', listener)
      return () => ipcRenderer.removeListener('browser:mode-changed', listener)
    },
    // ── Расширения браузера ──
    extList: () => ipcRenderer.invoke('browser:extensions:list') as Promise<Array<{
      id: string; name: string; version: string; description?: string
      source: 'webstore' | 'local'; enabled: boolean; dir: string
    }>>,
    extInstallWebStore: (input: string) => ipcRenderer.invoke('browser:extensions:installWebStore', input) as Promise<{
      ok: boolean; info?: { id: string; name: string; version: string }; error?: string; canceled?: boolean
    }>,
    extInstallLocal: (mode: 'file' | 'folder') => ipcRenderer.invoke('browser:extensions:installLocal', mode) as Promise<{
      ok: boolean; info?: { id: string; name: string; version: string }; error?: string; canceled?: boolean
    }>,
    extRemove: (extId: string) => ipcRenderer.invoke('browser:extensions:remove', extId) as Promise<boolean>,
    extToggle: (extId: string, enabled: boolean) => ipcRenderer.invoke('browser:extensions:toggle', extId, enabled) as Promise<boolean>,
  },

  // Чат
  chat: {
    create: (incognito?: boolean, mode?: 'code' | 'work', projectId?: string, model?: { modelId?: string; modelProvider?: string; reasoningValue?: string }) => ipcRenderer.invoke('chat:create', incognito, mode, projectId, model),
    getAll: () => ipcRenderer.invoke('chat:getAll'),
    // Активный чат (зеркало currentChatId из zustand renderer'а) — для
    // Spotlight "спросить в текущем чате". setActive вызывается App.tsx
    // при смене currentChatId, getActive — Spotlight-окном.
    setActive: (chatId: string | null) => ipcRenderer.invoke('chat:setActive', chatId),
    getActive: () => ipcRenderer.invoke('chat:getActive') as Promise<string | null>,
    // Превью финального system prompt (просмотр в UI: карточка плагина,
    // настройки агента). Возвращает { ok, prompt } или { ok: false, error }.
    previewSystemPrompt: (chatId?: string) =>
      ipcRenderer.invoke('chat:previewSystemPrompt', chatId) as Promise<{ ok: boolean; prompt?: string; error?: string }>,
    getMessages: (chatId: string) => ipcRenderer.invoke('chat:getMessages', chatId),
    // Окно сообщений для пагинации. Возвращает { messages, hasMore }.
    // limit — размер страницы (по умолчанию 20). beforeCreatedAt/beforeId —
    // курсор для догрузки старых сообщений вверх (пара из oldest текущего окна).
    getMessagesPage: (chatId: string, limit?: number, beforeCreatedAt?: number, beforeId?: string) =>
      ipcRenderer.invoke('chat:getMessagesPage', chatId, limit, beforeCreatedAt, beforeId) as Promise<{ messages: import('../../shared/types').Message[]; hasMore: boolean }>,
    send: (params: {
      chatId: string
      content: string
      displayContent?: string
      slashCommand?: { name: string; args: string }
      incognito?: boolean
      userMsgId?: string
      planningMode?: boolean
      askMode?: boolean
      imageMode?: boolean
      /** Тумблер «Управление браузером»: browser_* тулы + request_access. */
      browserMode?: boolean
      mode?: 'code' | 'work'
      /** Single-select persona run mode (classic/architect/debugger/...).
       *  Orthogonal to planning/ask/image toggles. */
      persona?: import('../../shared/modes').PersonaId
      oneShotSkill?: { name: string; instructions: string }
      oneShotAllowedTools?: string[]
      oneShotMode?: 'ask' | 'plan' | 'code'
      /** Per-message persona override (/debug, /review, ...). */
      oneShotPersona?: import('../../shared/modes').PersonaId
      /** Уровень мышления из UI на момент отправки (source of truth для main). */
      reasoningValue?: string
      attachments?: import('../../shared/types').Attachment[]
      /** Реплай-цитаты: сообщения, на которые отвечает эта отправка. */
      replyTo?: import('../../shared/types').ReplyTarget[]
    }) => ipcRenderer.invoke('chat:send', params),
    delete: (chatId: string) => ipcRenderer.invoke('chat:delete', chatId),
    rename: (chatId: string, title: string) => ipcRenderer.invoke('chat:rename', chatId, title),
    pin: (messageId: string) => ipcRenderer.invoke('chat:pinMsg', messageId),
    unpin: (messageId: string) => ipcRenderer.invoke('chat:unpinMsg', messageId),
    // ── Редактор чата ──
    // Правка текста сообщения (возвращает true если сообщение найдено).
    // iterTexts — новые значения textBefore по индексу итерации (для
    // сообщений с тулами: текст правится по сегментам между тулами).
    editMessage: (messageId: string, content: string, iterTexts?: string[]) =>
      ipcRenderer.invoke('chat:editMessage', messageId, content, iterTexts) as Promise<boolean>,
    // Скрыть/вернуть сообщение в AI-контекст (пользователь видит, модель — нет).
    setMessageHidden: (messageId: string, hidden: boolean) =>
      ipcRenderer.invoke('chat:setMessageHidden', messageId, hidden) as Promise<boolean>,
    // Удалить сообщение навсегда (и из чата, и из AI-контекста).
    deleteMessage: (messageId: string) =>
      ipcRenderer.invoke('chat:deleteMessage', messageId) as Promise<boolean>,
    reloadClient: () => ipcRenderer.invoke('chat:reloadClient'),
    stop: (chatId?: string) => ipcRenderer.invoke('chat:stop', chatId),
    getLiveState: (chatId: string) => ipcRenderer.invoke('chat:getLiveState', chatId),
    archive: (chatId: string, archived: boolean) => ipcRenderer.invoke('chat:archive', chatId, archived),
    pinChat: (chatId: string, pinned: boolean) => ipcRenderer.invoke('chat:pinChat', chatId, pinned),
    setColor: (chatId: string, color: string | null) => ipcRenderer.invoke('chat:setColor', chatId, color),
    duplicate: (chatId: string) => ipcRenderer.invoke('chat:duplicate', chatId),
    export: (chatId: string, format: 'txt' | 'md') => ipcRenderer.invoke('chat:export', chatId, format),
    // ── Очередь запросов чата ──
    // getQueue возвращает meta ожидающих запросов (без активного).
    // queueRemove убирает запрос из очереди по queueId.
    // queueReorder переставляет очередь под новый порядок queueId.
    getQueue: (chatId: string) => ipcRenderer.invoke('chat:getQueue', chatId),
    queueRemove: (chatId: string, queueId: string) => ipcRenderer.invoke('chat:queueRemove', chatId, queueId),
    queueReorder: (chatId: string, queueIds: string[]) => ipcRenderer.invoke('chat:queueReorder', chatId, queueIds),
    // ── Checkpoint / rewind ──
    // getSessionTimeline — список всех точек отката чата (для правой панели).
    // getLastTurnFilesChanged — кол-во файлов в последнем turn'е (для badge).
    // rewindTo — откатить сессию к указанному user-сообщению.
    getSessionTimeline: (chatId: string) => ipcRenderer.invoke('chat:getSessionTimeline', chatId),
    getLastTurnFilesChanged: (chatId: string) => ipcRenderer.invoke('chat:getLastTurnFilesChanged', chatId),
    rewindTo: (chatId: string, userMessageId: string) => ipcRenderer.invoke('chat:rewindTo', chatId, userMessageId),
    redo: (chatId: string, rewindMessageId: string) => ipcRenderer.invoke('chat:redo', chatId, rewindMessageId),
    canRedo: (chatId: string, rewindMessageId: string) => ipcRenderer.invoke('chat:canRedo', chatId, rewindMessageId),
    // ── ChangesBadge: изменения последнего запроса + undo файлов ──
    // getLastTurnChanges — per-file added/deleted для последнего turn'а с правками.
    // undoLastTurnFiles — откатить все файлы последнего turn'а (без удаления сообщений).
    // undoFile — откатить один файл последнего turn'а.
    getLastTurnChanges: (chatId: string) => ipcRenderer.invoke('chat:getLastTurnChanges', chatId) as Promise<import('../../shared/types').LastTurnChanges | null>,
    undoLastTurnFiles: (chatId: string) => ipcRenderer.invoke('chat:undoLastTurnFiles', chatId) as Promise<{ restored?: number; failed?: string[]; error?: string }>,
    undoFile: (chatId: string, path: string) => ipcRenderer.invoke('chat:undoFile', chatId, path) as Promise<{ success?: boolean; error?: string }>,
    // ── Undo файлов любого чекпоинта (правая панель «Сессия») ──
    // undoCheckpointFiles — откатить все файлы указанного turn'а (по userMessageId).
    // undoCheckpointFile — откатить один файл указанного turn'а.
    // getLastRewind — последнее rewind-сообщение (для redo-баннера).
    undoCheckpointFiles: (chatId: string, userMessageId: string) => ipcRenderer.invoke('chat:undoCheckpointFiles', chatId, userMessageId) as Promise<{ restored?: number; failed?: string[]; error?: string }>,
    undoCheckpointFile: (chatId: string, userMessageId: string, path: string) => ipcRenderer.invoke('chat:undoCheckpointFile', chatId, userMessageId, path) as Promise<{ success?: boolean; error?: string }>,
    getLastRewind: (chatId: string) => ipcRenderer.invoke('chat:getLastRewind', chatId) as Promise<{ rewindMessageId: string; createdAt: number } | null>,
    // ── Сжатие контекста (/compact) ──
    // Ручной запуск applyRollingWindowAsync с forceCompress=true. Возвращает
    // обновлённую ленту сообщений (включая новый system-разделитель компакции)
    // и stats { removedCount, tokensBefore, tokensAfter, tokensSaved,
    // dividerMessageId } для toast'а. При активном чате / пустом чате —
    // { error: string }.
    compact: (chatId: string, mode?: string) => ipcRenderer.invoke('chat:compact', chatId, mode),
    // Отмена ручной /compact по Stop-кнопке. Прерывает LLM-стрим резюме
    // БЕЗ применения частичного результата к чату (summary/divider не
    // пишутся). Возвращает { cancelled: boolean }.
    compactCancel: (chatId: string) => ipcRenderer.invoke('chat:compact:cancel', chatId),
    // ── /fork — дублировать чат с этого места ──
    // Создаёт новый чат, копируя сообщения+working memory+summary+project.
    // Возвращает { chatId, messages, title } нового чата или { error }.
    fork: (chatId: string, title?: string) => ipcRenderer.invoke('chat:fork', chatId, title),
    // ── /snapshot <name> — именованный снапшот ──
    // Создаёт именованную точку отката на основе последнего чекпоинта.
    // Восстанавливается через /restore (list + rewindTo).
    snapshotCreate: (chatId: string, name: string) => ipcRenderer.invoke('chat:snapshot:create', chatId, name),
    // ── /restore — список именованных снапшотов для пикера ──
    // Возвращает массив снапшотов (новые первыми). Восстановление — через
    // rewindTo с userMessageId выбранного снапшота.
    snapshotList: (chatId: string) => ipcRenderer.invoke('chat:snapshot:list', chatId),
    // ── Параллельный доп-чат (side chat) ──
    // Эфемерный чат-в-чате: incognito, не пишется в БД. ИИ получает сводку
    // родителя + тул get_main_chat_messages. chatId = 'sidechat:'+parentChatId.
    sideSend: (params: { parentChatId: string; content: string; sideMessages: unknown[] }) =>
      ipcRenderer.invoke('chat:sideSend', params),

    // ── Multi-source поиск по истории для Spotlight ──
    // Возвращает SearchSourceResult[]: messages / summaries / agent_logs /
    // pinned / memory. Запускается в main против better-sqlite3 singleton.
    searchHistory: (query: string, limit?: number) =>
      ipcRenderer.invoke('chat:searchHistory', { query, limit }) as Promise<Array<{
        source: 'memory' | 'messages' | 'summaries' | 'agent_logs' | 'pinned'
        content: string
        score: number
        chatId?: string
        chatTitle?: string
        messageId?: string
        role?: string
        date?: number
      }>>,

    // ── Per-chat UI state: режимы инпут-бара + черновик + история ввода ──
    // Сохраняются в chats/messages, переживают перезапуск. Рендерер не
    // вызывает их для инкогнито-чатов (guard в ChatPage).
    getModes: (chatId: string) => ipcRenderer.invoke('chat:getModes', chatId) as Promise<{ planningMode: boolean; imageMode: boolean; askMode: boolean }>,
    setModes: (chatId: string, modes: { planningMode: boolean; imageMode: boolean; askMode: boolean }) => ipcRenderer.invoke('chat:setModes', chatId, modes),
    // Индивидуальные сеттеры — пишут один режим, не затрагивая остальные.
    setPlanningMode: (chatId: string, val: boolean) => ipcRenderer.invoke('chat:setPlanningMode', chatId, val),
    setImageMode: (chatId: string, val: boolean) => ipcRenderer.invoke('chat:setImageMode', chatId, val),
    setAskMode: (chatId: string, val: boolean) => ipcRenderer.invoke('chat:setAskMode', chatId, val),
    // Тумблер «Управление браузером» (browser_* тулы для AI).
    getBrowserMode: (chatId: string) => ipcRenderer.invoke('browser:getMode', chatId) as Promise<boolean>,
    setBrowserMode: (chatId: string, val: boolean) => ipcRenderer.invoke('browser:setMode', chatId, val),
    /** Single-select persona run mode (classic/architect/debugger/...). */
    getPersona: (chatId: string) => ipcRenderer.invoke('chat:getPersona', chatId) as Promise<import('../../shared/modes').PersonaId>,
    setPersona: (chatId: string, persona: import('../../shared/modes').PersonaId) => ipcRenderer.invoke('chat:setPersona', chatId, persona),
    /** Per-chat модель: null = глобальное назначение role:'main'. */
    getModel: (chatId: string) => ipcRenderer.invoke('chat:getModel', chatId) as Promise<{ modelId: string; modelProvider: string } | null>,
    setModel: (chatId: string, modelId: string | null, modelProvider: string | null) => ipcRenderer.invoke('chat:setModel', chatId, modelId, modelProvider),
    /** Per-chat уровень мышления: null = глобальный settings.reasoningValue. */
    getReasoning: (chatId: string) => ipcRenderer.invoke('chat:getReasoning', chatId) as Promise<string | null>,
    setReasoning: (chatId: string, value: string | null) => ipcRenderer.invoke('chat:setReasoning', chatId, value),
    getDraft: (chatId: string) => ipcRenderer.invoke('chat:getDraft', chatId) as Promise<string>,
    setDraft: (chatId: string, draft: string) => ipcRenderer.invoke('chat:setDraft', chatId, draft),
    getInputHistory: (chatId: string) => ipcRenderer.invoke('chat:getInputHistory', chatId) as Promise<string[]>,
  },

  // Проекты (рабочие директории) — сущность верхнего уровня над чатами.
  // Проект = папка + зафиксированный скан. Чаты создаются внутри проекта.
  projects: {
    pickWorkdir: () => ipcRenderer.invoke('projects:pickWorkdir'),
    pickNewWorkdir: () => ipcRenderer.invoke('projects:pickNewWorkdir'),
    create: (workdir: string) => ipcRenderer.invoke('projects:create', workdir),
    getAll: () => ipcRenderer.invoke('projects:getAll'),
    rename: (id: string, name: string) => ipcRenderer.invoke('projects:rename', id, name),
    delete: (id: string, deleteChats: boolean) => ipcRenderer.invoke('projects:delete', id, deleteChats),
    getById: (id: string) => ipcRenderer.invoke('projects:getById', id),
    touch: (id: string) => ipcRenderer.invoke('projects:touch', id),
    setVerificationCommand: (id: string, command: string | null) => ipcRenderer.invoke('projects:setVerificationCommand', id, command),
    setContextFiles: (id: string, files: string[], autoDiscover: boolean, disabledDiscoveryFiles?: string[]) => ipcRenderer.invoke('projects:setContextFiles', id, files, autoDiscover, disabledDiscoveryFiles),
    setAppearance: (id: string, color: string, icon: string) => ipcRenderer.invoke('projects:setAppearance', id, color, icon),
  },

  // Fast Context — статус индекса проекта, реиндекс, live progress
  fastContext: {
    getStatus: (projectId: string) => ipcRenderer.invoke('fastcontext:getStatus', projectId),
    reindex: (projectId: string) => ipcRenderer.invoke('fastcontext:reindex', projectId),
    clearIndex: (projectId: string) => ipcRenderer.invoke('fastcontext:clearIndex', projectId),
    setActive: (projectId: string | null) => ipcRenderer.invoke('fastcontext:setActive', projectId),
    onProgress: (cb: (data: { projectId: string; stage: string; detail?: string; filesProcessed?: number; filesTotal?: number }) => void) => {
      const handler = (_e: unknown, data: { projectId: string; stage: string; detail?: string; filesProcessed?: number; filesTotal?: number }) => cb(data)
      ipcRenderer.on('fastcontext:progress', handler)
      return () => ipcRenderer.removeListener('fastcontext:progress', handler)
    },
    onUpdated: (cb: (projectId: string) => void) => {
      const handler = (_e: unknown, projectId: string) => cb(projectId)
      ipcRenderer.on('fastcontext:updated', handler)
      return () => ipcRenderer.removeListener('fastcontext:updated', handler)
    },
  },

  // Память (MemoryStore: гибридный TF-IDF + embeddings, 4 kind, 3 scope)
  memory: {
    getAll: (filter?: unknown) => ipcRenderer.invoke('memory:getAll', filter),
    save: (entry: unknown) => ipcRenderer.invoke('memory:save', entry),
    delete: (id: string) => ipcRenderer.invoke('memory:delete', id),
    search: (params: unknown) => ipcRenderer.invoke('memory:search', params),
    pin: (id: string, pinned: boolean) => ipcRenderer.invoke('memory:pin', id, pinned),
    setImportance: (id: string, importance: number) => ipcRenderer.invoke('memory:setImportance', id, importance),
    stats: () => ipcRenderer.invoke('memory:stats'),
    prune: (maxAgeDays?: number, minImportance?: number) => ipcRenderer.invoke('memory:prune', maxAgeDays, minImportance),
    reindex: () => ipcRenderer.invoke('memory:reindex'),
    extractOutcomes: (params?: { chatId?: string; projectId?: string }) => ipcRenderer.invoke('memory:extractOutcomes', params),
    pruneAgentLogs: (maxAgeDays?: number) => ipcRenderer.invoke('memory:pruneAgentLogs', maxAgeDays),
    getCategories: (projectId?: string) => ipcRenderer.invoke('memory:getCategories', projectId),
    createCategory: (input: unknown) => ipcRenderer.invoke('memory:createCategory', input),
    deleteCategory: (id: string) => ipcRenderer.invoke('memory:deleteCategory', id),
  },

  // Knowledge Graph (per-project: узлы + рёбра, force-directed визуализация)
  graph: {
    get: (projectId: string, opts?: unknown) => ipcRenderer.invoke('graph:get', projectId, opts),
    stats: (projectId: string) => ipcRenderer.invoke('graph:stats', projectId),
    rebuild: (projectId: string) => ipcRenderer.invoke('graph:rebuild', projectId),
    deleteNode: (id: string) => ipcRenderer.invoke('graph:deleteNode', id),
    pinNode: (id: string, pinned: boolean) => ipcRenderer.invoke('graph:pinNode', id, pinned),
    pruneIsolated: (projectId?: string) => ipcRenderer.invoke('graph:pruneIsolated', projectId),
  },

  // Агент
  agent: {
    run: (query: string) => ipcRenderer.invoke('agent:run', query),
    cancel: (id?: string) => ipcRenderer.invoke('agent:cancel', id),
    list: () => ipcRenderer.invoke('agent:list'),
    get: (id: string) => ipcRenderer.invoke('agent:get', id),
    children: (parentId: string) => ipcRenderer.invoke('agent:children', parentId),
    clearChat: (chatId: string) => ipcRenderer.invoke('agent:clearChat', chatId),
    getSettings: () => ipcRenderer.invoke('agent:getSettings'),
    setSettings: (s: unknown) => ipcRenderer.invoke('agent:setSettings', s),
    // ── Разрешения (глобальные + per-project overrides) ──
    getPermissions: () => ipcRenderer.invoke('agent:getPermissions'),
    setAutoPermissions: (auto: unknown) => ipcRenderer.invoke('agent:setAutoPermissions', auto),
    getProjectPermissions: (projectId: string) => ipcRenderer.invoke('agent:getProjectPermissions', projectId),
    setProjectPermissions: (projectId: string, override: unknown) => ipcRenderer.invoke('agent:setProjectPermissions', projectId, override),
    onConfirm: (cb: (data: { reqId: string; toolName: string; args: unknown; dangerLevel?: string; dangerReason?: string; previewDiff?: string }) => void) => {
      const wrapper = (_: unknown, data: unknown) => cb(data as { reqId: string; toolName: string; args: unknown; dangerLevel?: string; dangerReason?: string; previewDiff?: string })
      ipcRenderer.on('agent:confirm', wrapper)
      return wrapper  // возвращаем wrapper для последующего offConfirm
    },
    offConfirm: (wrapper: (...args: unknown[]) => void) => {
      ipcRenderer.removeListener('agent:confirm', wrapper)
    },
    confirmResponse: (reqId: string, approved: boolean, always?: 'session' | 'project' | 'global') => {
      ipcRenderer.send(`agent:confirm:response:${reqId}`, approved, always)
    },
    // Dismiss — notification overlay уже обработал ответ, закрыть диалог
    onConfirmDismiss: (cb: (reqId: string) => void) => {
      const handler = (_: unknown, reqId: string) => cb(reqId)
      ipcRenderer.on('agent:confirm:dismiss', handler)
      return () => ipcRenderer.removeListener('agent:confirm:dismiss', handler)
    },
    // ── ask_user: тул уточняющих вопросов ──
    // onQuestion — подписка на входящие вопросы от AI (renderer показывает
    // QuestionPanel над инпутом). questionResponse — ответ пользователя.
    onQuestion: (cb: (data: { reqId: string; questions: unknown[]; chatId: string; msgId: string }) => void) => {
      const wrapper = (_: unknown, data: unknown) => cb(data as { reqId: string; questions: unknown[]; chatId: string; msgId: string })
      ipcRenderer.on('agent:question', wrapper)
      return wrapper
    },
    offQuestion: (wrapper: (...args: unknown[]) => void) => {
      ipcRenderer.removeListener('agent:question', wrapper)
    },
    questionResponse: (reqId: string, answers: unknown[]) => {
      ipcRenderer.send(`agent:question:response:${reqId}`, answers)
    },
    // Dismiss — notification overlay уже обработал ответ, закрыть панель
    onQuestionDismiss: (cb: (reqId: string) => void) => {
      const handler = (_: unknown, reqId: string) => cb(reqId)
      ipcRenderer.on('agent:question:dismiss', handler)
      return () => ipcRenderer.removeListener('agent:question:dismiss', handler)
    },
  },

  // Защищённые переменные (секреты → system prompt). Значения НЕ покидают
  // main-процесс: list возвращает только метаданные.
  protectedVars: {
    list: () => ipcRenderer.invoke('protectedVars:list') as Promise<import('../shared/types/protectedVars').ProtectedVarMeta[]>,
    save: (input: import('../shared/types/protectedVars').ProtectedVarSaveInput) =>
      ipcRenderer.invoke('protectedVars:save', input) as Promise<{ ok: true; meta: import('../shared/types/protectedVars').ProtectedVarMeta } | { ok: false; error: string }>,
    delete: (id: string) => ipcRenderer.invoke('protectedVars:delete', id) as Promise<boolean>,
  },

  // Провайдеры и модели
  providers: {
    getAll: () => ipcRenderer.invoke('providers:getAll'),
    save: (provider: unknown) => ipcRenderer.invoke('providers:save', provider),
    delete: (id: string) => ipcRenderer.invoke('providers:delete', id),
    testKey: (providerId: string) => ipcRenderer.invoke('providers:testKey', providerId),
    fetchModels: (providerId: string) => ipcRenderer.invoke('providers:fetchModels', providerId),
  },

  // Счётчик контекста
  context: {
    estimateInput: (params: { text: string }) =>
      ipcRenderer.invoke('context:estimateInput', params),
    calculate: (chatId: string) =>
      ipcRenderer.invoke('context:calculate', chatId),
  },

  models: {
    getAll: () => ipcRenderer.invoke('models:getAll'),
    saveCustom: (model: unknown) => ipcRenderer.invoke('models:saveCustom', model),
    deleteCustom: (modelId: string, providerId: string) => ipcRenderer.invoke('models:deleteCustom', modelId, providerId),
    getAssignments: () => ipcRenderer.invoke('models:getAssignments'),
    setAssignment: (assignment: unknown) => ipcRenderer.invoke('models:setAssignment', assignment),
    getParams: () => ipcRenderer.invoke('models:getParams'),
    setParams: (params: unknown) => ipcRenderer.invoke('models:setParams', params),
    getRecent: () => ipcRenderer.invoke('models:getRecent'),
    addRecent: (modelId: string, providerId: string) => ipcRenderer.invoke('models:addRecent', modelId, providerId),
    getPinned: () => ipcRenderer.invoke('models:getPinned'),
    togglePin: (modelId: string, providerId: string) => ipcRenderer.invoke('models:togglePin', modelId, providerId),
  },

  // События (подписка)
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const handler = (_: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  // callback не используется — removeAllListeners снимает все подписки на
  // канал сразу, без разбора по конкретной функции. Параметр оставлен в
  // сигнатуре для симметрии с on()/once() в публичном preload-контракте.
  off: (channel: string, _callback: (...args: unknown[]) => void) => {
    ipcRenderer.removeAllListeners(channel)
  },

  once: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.once(channel, (_, ...args) => callback(...args))
  },

  // Диагностика — вызывается из DevTools консоли:
  // window.syntee.debug.streamTest().then(r => console.log(JSON.stringify(r, null, 2)))
  debug: {
    streamTest: () => ipcRenderer.invoke('debug:stream-test'),
    openDevTools: () => ipcRenderer.invoke('debug:open-devtools'),
  },

  // Генерация изображений
  image: {
    generate: (params: unknown) => ipcRenderer.invoke('image:generate', params),
    getSettings: () => ipcRenderer.invoke('image:getSettings'),
    setSettings: (s: unknown) => ipcRenderer.invoke('image:setSettings', s),
  },

  // Shell
  shell: {
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    showItemInFolder: (path: string) => ipcRenderer.invoke('shell:showItemInFolder', path),
    getExtensionsPaths: () => ipcRenderer.invoke('extensions:getPaths'),
  },

  // PTY-терминал (xterm.js + node-pty). create/write/resize/kill — invoke;
  // стриминг данных — через on('pty:data'/'pty:premount'/'pty:exit'). Сессии per-chat.
  pty: {
    detectShells: () => ipcRenderer.invoke('pty:detectShells'),
    create: (params: { chatId: string; shell: string; cwd?: string; source?: 'user' | 'agent'; title?: string }) =>
      ipcRenderer.invoke('pty:create', params),
    list: (chatId: string) => ipcRenderer.invoke('pty:list', chatId),
    write: (sessionId: string, data: string) => ipcRenderer.invoke('pty:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('pty:resize', sessionId, cols, rows),
    kill: (sessionId: string) => ipcRenderer.invoke('pty:kill', sessionId),
    consumePreMount: (sessionId: string) => ipcRenderer.invoke('pty:consumePreMount', sessionId),
    getMeta: (sessionId: string) => ipcRenderer.invoke('pty:getMeta', sessionId),
    // Consumer-протокол стриминга: attach (получить pre-mount snapshot
    // событием 'pty:premount'), detach (xterm уничтожен), ack (поглощено N байт).
    attach: (sessionId: string) => ipcRenderer.invoke('pty:attach', sessionId),
    detach: (sessionId: string) => { ipcRenderer.send('pty:detach', sessionId) },
    ack: (sessionId: string, bytes: number) => { ipcRenderer.send('pty:ack', sessionId, bytes) },
  },

  // Файловый просмотрщик/редактор для правой панели и основной области
  fs: {
    getWorkdir: (chatId: string) => ipcRenderer.invoke('fs:getWorkdir', chatId),
    listDirectory: (params: { root: string; relPath?: string; maxEntries?: number }) =>
      ipcRenderer.invoke('fs:listDirectory', params),
    readFile: (params: { root: string; relPath: string; maxBytes?: number }) =>
      ipcRenderer.invoke('fs:readFile', params),
    searchFiles: (params: { root: string; query: string; maxResults?: number; scopeId?: string }) =>
      ipcRenderer.invoke('fs:searchFiles', params),
    cancelSearch: (scopeId: string) => ipcRenderer.send('fs:cancelSearch', scopeId),
    writeFile: (params: { root: string; relPath: string; content: string }) =>
      ipcRenderer.invoke('fs:writeFile', params),
    checkFilesExist: (params: { root: string; relPaths: string[] }) =>
      ipcRenderer.invoke('fs:checkFilesExist', params),
    // Stat по абсолютному пути (файл/папка/существует) — для кликабельных путей
    statPath: (absPath: string) =>
      ipcRenderer.invoke('fs:statPath', absPath) as Promise<{ exists: boolean; isDir: boolean; isFile: boolean; size: number; resolved: string }>,
  },

  // Git-статус для правой панели
  git: {
    status: (workdir: string) => ipcRenderer.invoke('git:status', workdir),
    diff: (params: { workdir: string; file?: string; staged?: boolean }) =>
      ipcRenderer.invoke('git:diff', params),
    show: (params: { workdir: string; hash: string; file?: string }) =>
      ipcRenderer.invoke('git:show', params),
    log: (params: { workdir: string; limit?: number }) =>
      ipcRenderer.invoke('git:log', params),
    branch: (workdir: string) => ipcRenderer.invoke('git:branch', workdir),
    isRepo: (workdir: string) => ipcRenderer.invoke('git:isRepo', workdir),
    add: (params: { workdir: string; files: string[] }) =>
      ipcRenderer.invoke('git:add', params),
    reset: (params: { workdir: string; files: string[] }) =>
      ipcRenderer.invoke('git:reset', params),
    discard: (params: { workdir: string; files: string[]; untracked: boolean }) =>
      ipcRenderer.invoke('git:discard', params),
    diffStat: (params: { workdir: string; file?: string; staged?: boolean }) =>
      ipcRenderer.invoke('git:diffStat', params),
    commit: (params: { workdir: string; message: string; amend?: boolean }) =>
      ipcRenderer.invoke('git:commit', params),
    push: (params: { workdir: string; remote?: string; branch?: string }) =>
      ipcRenderer.invoke('git:push', params),
    pull: (params: { workdir: string; remote?: string; branch?: string }) =>
      ipcRenderer.invoke('git:pull', params),
    fetch: (params: { workdir: string; remote?: string }) =>
      ipcRenderer.invoke('git:fetch', params),
    fileVersions: (params: { workdir: string; file: string; ref?: string }) =>
      ipcRenderer.invoke('git:fileVersions', params),
    showFiles: (params: { workdir: string; hash: string }) =>
      ipcRenderer.invoke('git:showFiles', params),
    branchList: (workdir: string) =>
      ipcRenderer.invoke('git:branchList', workdir),
    checkout: (params: { workdir: string; branch: string }) =>
      ipcRenderer.invoke('git:checkout', params),
    branchCreate: (params: { workdir: string; branch: string; checkout?: boolean }) =>
      ipcRenderer.invoke('git:branchCreate', params),
    stash: (params: { workdir: string; message?: string }) =>
      ipcRenderer.invoke('git:stash', params),
    stashPop: (params: { workdir: string }) =>
      ipcRenderer.invoke('git:stashPop', params),
    stashList: (workdir: string) =>
      ipcRenderer.invoke('git:stashList', workdir),
    logFile: (params: { workdir: string; file: string; limit?: number }) =>
      ipcRenderer.invoke('git:logFile', params),
  },

  // Skills — markdown-инструкции в system prompt.
  // getAll — все скиллы (с состоянием) для popover; projectId опционально.
  // setState — обновить enabled/scope скилла.
  // reload — сбросить кэш и перечитать .md с диска.
  // getActive — активные скиллы для конкретного чата (для бейджа).
  skills: {
    getAll: (params?: { projectId?: string; chatId?: string }) => ipcRenderer.invoke('skills:getAll', params),
    setState: (params: { skillId: string; state: unknown; source: 'builtin' | 'user' | 'project' }) =>
      ipcRenderer.invoke('skills:setState', params),
    setFolderState: (params: SkillFolderUpdate) => ipcRenderer.invoke('skills:setFolderState', params),
    reload: () => ipcRenderer.invoke('skills:reload'),
    getActive: (params: { chatId: string; isIncognito?: boolean }) =>
      ipcRenderer.invoke('skills:getActive', params),
    installFromUrl: (params: { url: string; scope: 'global' | { workdir: string } }) =>
      ipcRenderer.invoke('skills:installFromUrl', params),
  },

  // Кастомные slash-команды — .md-файлы с расширенным frontmatter.
  // list — все custom-команды (без builtin из SLASH_COMMANDS — renderer
  // добавляет их сам через filterCommands). projectWorkdir — для проектных.
  // reload — сбросить кэш и перечитать .md с диска (после правки файлов).
  commands: {
    list: (params?: { projectWorkdir?: string; chatId?: string }) => ipcRenderer.invoke('commands:list', params),
    reload: () => ipcRenderer.invoke('commands:reload'),
  },

  // MCP (Model Context Protocol) — внешние серверы с инструментами.
  // getAll — все серверы с runtime-состоянием (для popover).
  // save/delete — CRUD глобальных серверов.
  // connect/disconnect/reconnect — управление подключением.
  // setServerState — enabled/scope сервера.
  // setToolState — per-tool enabled/requireApproval.
  mcp: {
    getAll: (params?: { projectId?: string; chatId?: string }) => ipcRenderer.invoke('mcp:getAll', params),
    getActiveForChat: (params: { chatId: string; isIncognito?: boolean }) =>
      ipcRenderer.invoke('mcp:getActiveForChat', params),
    save: (config: unknown) => ipcRenderer.invoke('mcp:save', config),
    delete: (id: string) => ipcRenderer.invoke('mcp:delete', id),
    connect: (serverId: string) => ipcRenderer.invoke('mcp:connect', serverId),
    disconnect: (serverId: string) => ipcRenderer.invoke('mcp:disconnect', serverId),
    reconnect: (serverId: string) => ipcRenderer.invoke('mcp:reconnect', serverId),
    setServerState: (params: { serverId: string; enabled?: boolean; scope?: unknown }) =>
      ipcRenderer.invoke('mcp:setServerState', params),
    setToolState: (params: { serverId: string; toolFullName: string; state: unknown }) =>
      ipcRenderer.invoke('mcp:setToolState', params),
    installDirect: (params: {
      name: string
      transport: 'stdio' | 'sse' | 'streamable-http'
      command?: string
      args?: string[]
      env?: Record<string, string>
      url?: string
      headers?: Record<string, string>
      scope: 'global' | { workdir: string }
    }) => ipcRenderer.invoke('mcp:installDirect', params),
    updateServer: (params: {
      serverId: string
      env?: Record<string, string>
      args?: string[]
    }) => ipcRenderer.invoke('mcp:updateServer', params),
  },

  // Plugins — локальные расширения приложения (тулы + логика в
  // utilityProcess). getAll — все плагины с состоянием/runtime для popover;
  // setState — enabled/scope (вкл = запуск процесса); reload — hot reload;
  // installFromFolder — нативный диалог + копирование в plugins dir.
  plugins: {
    getAll: (params?: { projectId?: string; chatId?: string }) =>
      ipcRenderer.invoke('plugins:getAll', params),
    // Статус Python-интерпретатора (runtime:'python' плагины).
    checkPython: () => ipcRenderer.invoke('plugins:checkPython') as Promise<
      { found: boolean; exe?: string; version?: string }
    >,
    // Установка Python-зависимостей плагина (кнопка в карточке).
    installDeps: (params: { pluginId: string }) =>
      ipcRenderer.invoke('plugins:installDeps', params) as Promise<
        { ok: boolean; error?: string; output?: string }
      >,
    setState: (params: { pluginId: string; enabled?: boolean; scope?: unknown; consented?: boolean }) =>
      ipcRenderer.invoke('plugins:setState', params),
    reload: (pluginId: string) => ipcRenderer.invoke('plugins:reload', pluginId),
    uninstall: (params: { pluginId: string; source: 'global' | 'project'; dir?: string }) =>
      ipcRenderer.invoke('plugins:uninstall', params),
    installFromFolder: (params?: { scope?: 'global' | { workdir: string } }) =>
      ipcRenderer.invoke('plugins:installFromFolder', params),
    getPaths: () => ipcRenderer.invoke('plugins:getPaths'),
    // Выполнение слэш-команды плагина. Возвращает { ok, error?, userMsg, assistantMsg }
    // — сообщения уже сохранены в БД, renderer добавляет их в стор.
    executeCommand: (params: { chatId: string; pluginId: string; name: string; args: string; text: string }) =>
      ipcRenderer.invoke('plugins:executeCommand', params),
    // Мост iframe-панель → процесс плагина.
    uiMessage: (params: { pluginId: string; data: unknown }) =>
      ipcRenderer.invoke('plugins:uiMessage', params),
    // RPC-мост: synteeBridge.call(method, args) из iframe → ui.handle плагина.
    uiCall: (params: { pluginId: string; method: string; args?: Record<string, unknown> }) =>
      ipcRenderer.invoke('plugins:uiCall', params),
    // Хук chat:before-send — спросить плагины перед отправкой сообщения.
    // Возвращает { allowed, content, reason? }.
    beforeSend: (params: { chatId: string; content: string }) =>
      ipcRenderer.invoke('plugins:beforeSend', params),
    // Панель плагина открыта/закрыта → событие panel:opened/closed в процесс.
    panelLifecycle: (params: { pluginId: string; panelId: string; action: 'opened' | 'closed' }) =>
      ipcRenderer.invoke('plugins:panelLifecycle', params),
    // Тема сменилась → main рассылает theme:changed в процессы плагинов.
    themeChanged: (params: { theme: string; accentColor: string }) =>
      ipcRenderer.invoke('plugins:themeChanged', params),
    // DevTools (отладка iframe-панелей плагинов).
    openDevTools: () => ipcRenderer.invoke('plugins:openDevTools'),
    // Сохранить ответ плагина (chat.reply) в текущий чат.
    saveReply: (params: { chatId: string; text: string }) =>
      ipcRenderer.invoke('plugins:saveReply', params),
    // Сохранить значения настроек плагина (форма в карточке).
    setConfig: (params: { pluginId: string; values: Record<string, unknown> }) =>
      ipcRenderer.invoke('plugins:setConfig', params),
    // Поиск по провайдерам плагинов (Spotlight): секции результатов.
    search: (params: { query: string }) =>
      ipcRenderer.invoke('plugins:search', params) as Promise<Array<{
        pluginId: string
        providerId: string
        label: string
        items: Array<{ id: string; label: string; sub?: string; icon?: string }>
      }>>,
    // Клик по результату поиска плагина → хендлер провайдера.
    searchClick: (params: {
      pluginId: string
      providerId: string
      item: { id: string; label: string; sub?: string; icon?: string }
    }) =>
      ipcRenderer.invoke('plugins:searchClick', params),
    // Autocomplete-провайдеры: текст поля → подсказки (null — триггера нет).
    autocomplete: (params: { text: string }) =>
      ipcRenderer.invoke('plugins:autocomplete', params) as Promise<{
        pluginId: string
        trigger: string
        suggestions: Array<{ label: string; insertText?: string; command?: string }>
      } | null>,
    // Клик по пункту контекстного меню сообщений плагина.
    contextMenuClick: (params: {
      pluginId: string
      itemId: string
      payload: { messageId: string; chatId: string; content: string; selection?: string }
    }) =>
      ipcRenderer.invoke('plugins:contextMenuClick', params),
    // Клик по кнопке rich-уведомления плагина → выполнить его команду.
    notificationAction: (params: { pluginId: string; command: string }) =>
      ipcRenderer.invoke('plugins:notificationAction', params),
    // Клик по кнопке плагина над инпутом (без command) → событие плагину.
    inputAction: (params: { pluginId: string; actionId: string }) =>
      ipcRenderer.invoke('plugins:inputAction', params),
    // Прямой host-метод из iframe-панели (белый список read-only методов).
    iframeCall: (params: { pluginId: string; method: string; args?: Record<string, unknown> }) =>
      ipcRenderer.invoke('plugins:iframeCall', params) as Promise<{ ok: boolean; result?: unknown; error?: string }>,
  },

  // Marketplace — каталог MCP-серверов (официальный registry) и Skills
  // (GitHub Search API). Только поиск/детали — установка идёт через агента.
  marketplace: {
    searchMcp: (params: { query: string; limit?: number; cursor?: string }) =>
      ipcRenderer.invoke('marketplace:searchMcp', params),
    cancelMcpSearch: () => ipcRenderer.invoke('marketplace:cancelMcpSearch'),
    searchSkills: (params: { query: string; page?: number; perPage?: number }) =>
      ipcRenderer.invoke('marketplace:searchSkills', params),
    cancelSkillsSearch: () => ipcRenderer.invoke('marketplace:cancelSkillsSearch'),
    getSkillReadme: (params: { fullName: string }) =>
      ipcRenderer.invoke('marketplace:getSkillReadme', params),
    buildMcpInstruction: (params: unknown) => ipcRenderer.invoke('marketplace:buildMcpInstruction', params),
    buildSkillInstruction: (params: unknown) => ipcRenderer.invoke('marketplace:buildSkillInstruction', params),
    buildMcpUrlInstruction: (params: { url: string; scope: 'global' | { workdir: string } }) =>
      ipcRenderer.invoke('marketplace:buildMcpUrlInstruction', params),
  },

  // ── @mention-пикер ──────────────────────────────────────────────────────
  // search — главный канал: возвращает плоский MentionItem[] (files + chats +
  // projects + skills + commands), отфильтрованный через fuzzy-поиск. При
  // пустом query — недавние файлы/чаты/проекты + все скиллы/команды.
  // workdir — для файлового индекса, chatId — исключить текущий чат из списка.
  // startIndexing/stopIndexing — управление chokidar-watcher'ом для workdir.
  mentions: {
    search: (params: { workdir?: string; query: string; limit?: number; chatId?: string }) =>
      ipcRenderer.invoke('mentions:search', params),
    startIndexing: (workdir: string) =>
      ipcRenderer.invoke('mentions:startIndexing', workdir),
    stopIndexing: (workdir: string) =>
      ipcRenderer.invoke('mentions:stopIndexing', workdir),
  },

  // ── Вложения (attachments) ──────────────────────────────────────────────
  // readFile — прочитать текстовый файл для инлайна в content (бинарные → isBinary).
  // saveImageFromBase64 — paste/drag&drop картинки → файл в userData + путь.
  // saveFileFromPath — копировать файл с диска в userData (для drag&drop не из workdir).
  // deleteFile — удалить файл вложения из userData (при удалении чипа).
  // pickFile — native dialog Electron (кнопка «Прикрепить файл»).
  attachments: {
    readFile: (params: { path: string }) =>
      ipcRenderer.invoke('attachments:readFile', params),
    saveImageFromBase64: (params: { chatId: string; base64: string; mime?: string; suggestedName?: string }) =>
      ipcRenderer.invoke('attachments:saveImageFromBase64', params),
    saveFileFromPath: (params: { chatId: string; sourcePath: string }) =>
      ipcRenderer.invoke('attachments:saveFileFromPath', params),
    deleteFile: (params: { path: string }) =>
      ipcRenderer.invoke('attachments:deleteFile', params),
    pickFile: () =>
      ipcRenderer.invoke('attachments:pickFile'),
    // Резолв прямого пути drag&drop файла, когда webUtils.getPathForFile
    // не сработал: { name, dir? } → { ok, path?, name, mime, size, foundName? }.
    resolveDropPath: (params: { name: string; dir?: string }) =>
      ipcRenderer.invoke('attachments:resolveDropPath', params),
    // Поиск файлов черновика чата по имени (для восстановления чипа-заглушки):
    // { chatId, name } → { ok, matches: string[] }.
    repairDraft: (params: { chatId: string; attachments: unknown[] }) =>
      ipcRenderer.invoke('attachments:repairDraft', params),
    // Удаление осиротевших файлов черновика (не упомянутых ни в одном
    // сообщении чата — main сверяет с БД): { chatId } → { ok, removed }.
    cleanupOrphans: (params: { chatId: string }) =>
      ipcRenderer.invoke('attachments:cleanupOrphans', params),
    // В Electron 32+ File.path удалён (contextIsolation + nodeIntegration:false).
    // webUtils.getPathForFile — официальный replacement, доступен в preload
    // при sandbox:false. Принимает File из renderer (drag&drop/paste) и
    // возвращает абсолютный путь.
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },

  // ── Вложения черновика (draft attachments) ──────────────────────────────
  // Переживают рестарт, не пропадают при смене чата. Хранятся в БД + файлы в
  // userData/draft-attachments/{chatId}/. getAttachments — список чипов.
  // setAttachments — заменить все (debounce в renderer). clear — после отправки.
  draft: {
    getAttachments: (chatId: string) =>
      ipcRenderer.invoke('draft:getAttachments', chatId),
    setAttachments: (chatId: string, attachments: import('../../shared/types').Attachment[]) =>
      ipcRenderer.invoke('draft:setAttachments', chatId, attachments),
    clearAttachments: (chatId: string) =>
      ipcRenderer.invoke('draft:clearAttachments', chatId),
  },

  // ── Голосовой ввод (STT) в инпут-баре ──────────────────────────────────
  //   - transcribe(audio, opts): локальный Whisper в worker_thread. Принимает
  //     16kHz mono Float32Array PCM, возвращает распознанный текст.
  //   - transcribeGroq(audioData): Groq Whisper API fallback. Принимает webm
  //     ArrayBuffer (как есть из MediaRecorder), нужен groqApiKey в настройках.
  //   - onProgress(cb): live-прогресс загрузки модели и инференса (main → renderer).
  //   - tts(text): text-to-speech через OpenAI TTS endpoint (используется VoicePage).
  //   - sendQuery(text): форвард голосового запроса в main window (VoicePage).
  voice: {
    show: () => ipcRenderer.invoke('voice:show'),
    hide: () => ipcRenderer.invoke('voice:hide'),
    transcribe: (audio: Float32Array, opts?: { modelSize?: 'tiny' | 'base' }) =>
      ipcRenderer.invoke('voice:transcribe', audio, opts) as Promise<string>,
    transcribeGroq: (audioData: ArrayBuffer) =>
      ipcRenderer.invoke('voice:transcribeGroq', audioData) as Promise<string>,
    // Статус модели: { status, cached, modelSize, modelId, displaySize }.
    status: (modelSize?: string) =>
      ipcRenderer.invoke('voice:status', modelSize) as Promise<{ status: string; cached: boolean; modelSize: string; modelId: string; displaySize: string }>,
    // Явное скачивание модели. Прогресс приходит через onProgress/onStatus.
    download: (modelSize?: string) =>
      ipcRenderer.invoke('voice:download', modelSize) as Promise<{ ok: boolean; error?: string }>,
    onProgress: (cb: (info: { stage: string; progress?: number; message?: string }) => void) => {
      const handler = (_e: unknown, info: { stage: string; progress?: number; message?: string }) => cb(info)
      ipcRenderer.on('voice:progress', handler)
      return () => ipcRenderer.removeListener('voice:progress', handler)
    },
    onStatus: (cb: (info: { status: string; cached: boolean; modelSize: string; modelId: string; displaySize: string }) => void) => {
      const handler = (_e: unknown, info: { status: string; cached: boolean; modelSize: string; modelId: string; displaySize: string }) => cb(info)
      ipcRenderer.on('voice:status', handler)
      return () => ipcRenderer.removeListener('voice:status', handler)
    },
    tts: (text: string) => ipcRenderer.invoke('voice:tts', text) as Promise<string>,
    sendQuery: (text: string) => ipcRenderer.invoke('voice:sendQuery', text) as Promise<void>,
  },

  // ── Автообновление клиента ──────────────────────────────────────────────
  // In-app informational checker. The Go launcher (syntee-launcher) does the
  // real download+apply; this API only exposes state for the titlebar badge,
  // the changelog modal, the force modal, and the settings "Changelog" tab.
  //   - check(): manual re-check (settings button). Returns the new state.
  //   - getStatus(): snapshot of current state (badge visibility, manifest).
  //   - getHistory(): list of ever-activated releases for the settings tab.
  //   - dismiss(version): hide the badge for this version (force ignores it).
  //   - quitAndInstall(): spawn updater.exe, then app.exit(0). Resolves with
  //     { ok: false, error } when the updater couldn't be started (app keeps
  //     running in that case).
  //   - onStateChanged(cb): subscribe to live updates from the main process.
  updates: {
    check: () => ipcRenderer.invoke('updates:check') as Promise<import('../../shared/types').UpdateState>,
    getStatus: () => ipcRenderer.invoke('updates:getStatus') as Promise<import('../../shared/types').UpdateState>,
    getHistory: (params?: { channel?: string; limit?: number }) =>
      ipcRenderer.invoke('updates:getHistory', params) as Promise<import('../../shared/types').ChangelogEntry[]>,
    dismiss: (version: string) => ipcRenderer.invoke('updates:dismiss', version) as Promise<import('../../shared/types').UpdateState>,
    quitAndInstall: () => ipcRenderer.invoke('updates:quitAndInstall') as Promise<import('../../shared/types').QuitAndInstallResult>,
    onStateChanged: (cb: (state: import('../../shared/types').UpdateState) => void) => {
      const handler = (_e: unknown, state: import('../../shared/types').UpdateState) => cb(state)
      ipcRenderer.on('updates:state-changed', handler)
      return () => ipcRenderer.removeListener('updates:state-changed', handler)
    },
  },

  // Clipboard — нативный буфер обмена через IPC (работает на file://).
  // navigator.clipboard.writeText в production (file:// — не secure context)
  // молча реджектит промис → копирование не работает. Этот канал идёт через
  // electron.clipboard в main-процессе и не зависит от secure context.
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text) as Promise<boolean>,
    readText: () => ipcRenderer.invoke('clipboard:readText') as Promise<string>,
  },

  // Заметки — проектные (видны во всех чатах проекта) и чат-заметки (только в чате).
  // CRUD через IPC, live-обновление через событие 'notes:changed'.
  notes: {
    list: (params: { scope: 'project' | 'chat'; projectId?: string; chatId?: string }) =>
      ipcRenderer.invoke('notes:list', params) as Promise<Array<{
        id: string; scope: string; projectId: string | null; chatId: string | null
        title: string; content: string; createdAt: number; updatedAt: number
      }>>,
    getProjectId: (chatId: string) => ipcRenderer.invoke('notes:getProjectId', chatId) as Promise<string | null>,

    create: (params: { scope: 'project' | 'chat'; projectId?: string; chatId?: string; title: string; content?: string }) =>
      ipcRenderer.invoke('notes:create', params) as Promise<{ success: boolean; note?: unknown; error?: string }>,
    update: (params: { id: string; title?: string; content?: string }) =>
      ipcRenderer.invoke('notes:update', params) as Promise<{ success: boolean; note?: unknown; error?: string }>,
    delete: (id: string) =>
      ipcRenderer.invoke('notes:delete', id) as Promise<{ success: boolean; error?: string }>,
  },
}

contextBridge.exposeInMainWorld('syntee', synteeAPI)

// Типы для TypeScript в renderer
export type SynteeAPI = typeof synteeAPI
