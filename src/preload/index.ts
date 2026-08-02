import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Типизированный API bridge для renderer
const synteeAPI = {
  // Окно
  window: {
    hide: () => ipcRenderer.invoke('window:hide'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    show: () => ipcRenderer.invoke('window:show'),
  },

  // Настройки
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
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

  // Spotlight
  spotlight: {
    show: () => ipcRenderer.invoke('spotlight:show'),
    hide: () => ipcRenderer.invoke('spotlight:hide'),
    expand: () => ipcRenderer.invoke('spotlight:expand'),
    collapse: () => ipcRenderer.invoke('spotlight:collapse'),
  },

  // Кастомное трей-меню (frameless glass-окно). action — id действия
  // (showMain/showVoice/showSpotlight/openSettings/quit), выполняется в
  // main-процессе. getMeta — версия приложения для хедера/блока «О программе».
  trayMenu: {
    hide: () => ipcRenderer.invoke('tray-menu:hide'),
    action: (actionId: string) => ipcRenderer.invoke('tray-menu:action', actionId),
    getMeta: () => ipcRenderer.invoke('tray-menu:getMeta') as Promise<{ version: string }>,
  },

  // Чат
  chat: {
    create: (incognito?: boolean, mode?: 'code' | 'work', projectId?: string) => ipcRenderer.invoke('chat:create', incognito, mode, projectId),
    getAll: () => ipcRenderer.invoke('chat:getAll'),
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
      mode?: 'code' | 'work'
      oneShotSkill?: { name: string; instructions: string }
      oneShotAllowedTools?: string[]
      oneShotMode?: 'ask' | 'plan' | 'code'
      attachments?: import('../../shared/types').Attachment[]
    }) => ipcRenderer.invoke('chat:send', params),
    delete: (chatId: string) => ipcRenderer.invoke('chat:delete', chatId),
    rename: (chatId: string, title: string) => ipcRenderer.invoke('chat:rename', chatId, title),
    pin: (messageId: string) => ipcRenderer.invoke('chat:pinMsg', messageId),
    unpin: (messageId: string) => ipcRenderer.invoke('chat:unpinMsg', messageId),
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
    // ── Сжатие контекста (/compact) ──
    // Ручной запуск applyRollingWindowAsync с forceCompress=true. Возвращает
    // обновлённую ленту сообщений (включая новый system-разделитель компакции)
    // и stats { removedCount, tokensBefore, tokensAfter, tokensSaved,
    // dividerMessageId } для toast'а. При активном чате / пустом чате —
    // { error: string }.
    compact: (chatId: string) => ipcRenderer.invoke('chat:compact', chatId),
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

    // ── Per-chat UI state: режимы инпут-бара + черновик + история ввода ──
    // Сохраняются в chats/messages, переживают перезапуск. Рендерер не
    // вызывает их для инкогнито-чатов (guard в ChatPage).
    getModes: (chatId: string) => ipcRenderer.invoke('chat:getModes', chatId) as Promise<{ planningMode: boolean; imageMode: boolean; askMode: boolean }>,
    setModes: (chatId: string, modes: { planningMode: boolean; imageMode: boolean; askMode: boolean }) => ipcRenderer.invoke('chat:setModes', chatId, modes),
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
    delete: (id: string) => ipcRenderer.invoke('projects:delete', id),
    getById: (id: string) => ipcRenderer.invoke('projects:getById', id),
    touch: (id: string) => ipcRenderer.invoke('projects:touch', id),
    setVerificationCommand: (id: string, command: string | null) => ipcRenderer.invoke('projects:setVerificationCommand', id, command),
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
    onConfirm: (cb: (data: { reqId: string; toolName: string; args: unknown; dangerLevel?: string; dangerReason?: string; previewDiff?: string }) => void) => {
      const wrapper = (_: unknown, data: unknown) => cb(data as { reqId: string; toolName: string; args: unknown; dangerLevel?: string; dangerReason?: string; previewDiff?: string })
      ipcRenderer.on('agent:confirm', wrapper)
      return wrapper  // возвращаем wrapper для последующего offConfirm
    },
    offConfirm: (wrapper: (...args: unknown[]) => void) => {
      ipcRenderer.removeListener('agent:confirm', wrapper)
    },
    confirmResponse: (reqId: string, approved: boolean) => {
      ipcRenderer.send(`agent:confirm:response:${reqId}`, approved)
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
    getExtensionsPaths: () => ipcRenderer.invoke('extensions:getPaths'),
  },

  // PTY-терминал (xterm.js + node-pty). create/write/resize/kill — invoke;
  // стриминг данных — через on('pty:data'/'pty:exit'). Сессии per-chat.
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
  },

  // Файловый просмотрщик (read-only) для правой панели
  fs: {
    getWorkdir: (chatId: string) => ipcRenderer.invoke('fs:getWorkdir', chatId),
    listDirectory: (params: { root: string; relPath?: string; maxEntries?: number }) =>
      ipcRenderer.invoke('fs:listDirectory', params),
    readFile: (params: { root: string; relPath: string; maxBytes?: number }) =>
      ipcRenderer.invoke('fs:readFile', params),
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
  },

  // Skills — markdown-инструкции в system prompt.
  // getAll — все скиллы (с состоянием) для popover; projectId опционально.
  // setState — обновить enabled/scope скилла.
  // reload — сбросить кэш и перечитать .md с диска.
  // getActive — активные скиллы для конкретного чата (для бейджа).
  skills: {
    getAll: (params?: { projectId?: string }) => ipcRenderer.invoke('skills:getAll', params),
    setState: (params: { skillId: string; state: unknown; source: 'builtin' | 'user' | 'project' }) =>
      ipcRenderer.invoke('skills:setState', params),
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
    list: (params?: { projectWorkdir?: string }) => ipcRenderer.invoke('commands:list', params),
    reload: () => ipcRenderer.invoke('commands:reload'),
  },

  // MCP (Model Context Protocol) — внешние серверы с инструментами.
  // getAll — все серверы с runtime-состоянием (для popover).
  // save/delete — CRUD глобальных серверов.
  // connect/disconnect/reconnect — управление подключением.
  // setServerState — enabled/scope сервера.
  // setToolState — per-tool enabled/requireApproval.
  mcp: {
    getAll: (params?: { projectId?: string }) => ipcRenderer.invoke('mcp:getAll', params),
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
  // search — главный канал: возвращает плоский MentionItem[] (files + skills +
  // commands), отфильтрованный через fuzzy-поиск. При пустом query — недавние
  // файлы + все скиллы/команды. workdir — для файлового индекса.
  // startIndexing/stopIndexing — управление chokidar-watcher'ом для workdir.
  mentions: {
    search: (params: { workdir?: string; query: string; limit?: number }) =>
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
}

contextBridge.exposeInMainWorld('syntee', synteeAPI)

// Типы для TypeScript в renderer
export type SynteeAPI = typeof synteeAPI
