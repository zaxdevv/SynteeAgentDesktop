// ── IPC channel type definitions ────────────────────────────────────────
// Typed map of all IPC channels (main ↔ renderer ↔ preload).

import type { ChatMode } from './chat'
import type { Chat, Message } from './chat'
import type { Attachment } from './attachment'
import type { SystemInfo } from './system'
import type { DisplayInfo } from './system'
import type { PersonaId } from '../modes'

export interface IPCChannels {
  // Window
  'window:hide': () => void
  'window:minimize': () => void
  'window:show': () => void
  // Settings
  'settings:get': (key: string) => unknown
  'settings:set': (key: string, value: unknown) => void
  'settings:getAll': () => Record<string, unknown>
  // Chat
  'chat:send': (params: {
    chatId: string
    content: string
    displayContent?: string
    slashCommand?: { name: string; args: string }
    incognito?: boolean
    userMsgId?: string
    planningMode?: boolean
    askMode?: boolean
    imageMode?: boolean
    mode?: ChatMode
    oneShotSkill?: { name: string; instructions: string }
    oneShotAllowedTools?: string[]
    oneShotMode?: 'ask' | 'plan' | 'code'
    /** Per-message persona override (Aider-style). If set — this single run
     *  uses the named persona, WITHOUT persisting to the chat's sticky
     *  persona. Used by /debug, /review, /architect, ... builtin commands.
     *  The sticky switch is /persona <name>. */
    oneShotPersona?: PersonaId
    /** Single-select persona run mode (classic/architect/debugger/...).
     *  Orthogonal to planning/ask/image toggles — injects a mode-specific
     *  block into the system prompt and may restrict the tool set. */
    persona?: PersonaId
    /** Уровень мышления из UI на момент отправки (source of truth для main:
     *  приоритет над chats.reasoning_value и глобальной настройкой). */
    reasoningValue?: string
    /** Прикреплённые файлы/изображения, добавленные через @mention, drag&drop,
     *  paste или кнопку «Прикрепить». Main-процесс инлайнит текстовые файлы
     *  в content, картинки передаёт как путь (vision — Phase 2). */
    attachments?: Attachment[]
  }) => void
  'chat:create': (incognito?: boolean, mode?: ChatMode, projectId?: string, model?: { modelId?: string; modelProvider?: string; reasoningValue?: string }) => string
  'chat:getAll': () => Chat[]
  'chat:getMessages': (chatId: string) => Message[]
  'chat:delete': (chatId: string) => void
  'chat:rename': (chatId: string, title: string) => void
  // Per-chat модель: null = глобальное назначение role:'main'.
  'chat:getModel': (chatId: string) => { modelId: string; modelProvider: string } | null
  'chat:setModel': (chatId: string, modelId: string | null, modelProvider: string | null) => boolean
  // Per-chat уровень мышления: null = глобальный settings.reasoningValue.
  'chat:getReasoning': (chatId: string) => string | null
  'chat:setReasoning': (chatId: string, value: string | null) => boolean
  // System
  'system:info': () => SystemInfo
  'system:logError': (message: string, stack?: string) => void
  // Overlay
  'overlay:show': () => void
  'overlay:hide': () => void
  'overlay:getDisplays': () => DisplayInfo[]
  // Notification overlay
  'notification:show': () => void
  'notification:hide': () => void
  'overlay:setInteractive': (v: boolean) => void
  'notification:action': (payload: { id: string; actionId: string; type: string; chatId?: string; reqId?: string }) => void
  // Voice
  'voice:toggle': () => void
  'voice:start': () => void
  'voice:stop': () => void
  // Голосовой ввод в инпут-баре: локальный Whisper в worker_thread.
  // Принимает 16kHz mono Float32Array PCM, возвращает распознанный текст.
  // Также поддерживается Groq (через voice:transcribeGroq — webm ArrayBuffer).
  'voice:transcribe': (audio: Float32Array, opts?: { modelSize?: 'tiny' | 'base' }) => string
  // Прогресс загрузки/инференса модели (main → renderer event).
  'voice:progress': (info: { stage: 'loading-model' | 'transcribing' | 'done' | 'error'; progress?: number; message?: string }) => void
  // Spotlight
  'spotlight:show': () => void
  'spotlight:hide': () => void
  // Spotlight relay → main шлёт nav:* в mainWindow.webContents
  'spotlight:quickAsk': (query: string, chatId?: string) => void
  'spotlight:newChat': () => void
  'spotlight:openChat': (chatId: string) => void
  'spotlight:openSettings': (section?: string) => void
  // История запросов Spotlight (персист в electron-store 'spotlightHistory')
  'spotlight:getHistory': () => string[]
  'spotlight:addHistory': (query: string) => void
  'spotlight:clearHistory': () => void
  // Активный чат (зеркало currentChatId) для "спросить в текущем"
  'chat:setActive': (chatId: string | null) => void
  'chat:getActive': () => string | null
  // Multi-source поиск по истории чатов (FTS5 + LIKE + TF-IDF) для Spotlight
  'chat:searchHistory': (params: { query: string; limit?: number }) => Array<{
    source: 'memory' | 'messages' | 'summaries' | 'agent_logs' | 'pinned'
    content: string
    score: number
    chatId?: string
    chatTitle?: string
    messageId?: string
    role?: string
    date?: number
  }>
}
