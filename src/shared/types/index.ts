// Shared types for IPC communication
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
    /** РџСЂРёРєСЂРµРїР»С‘РЅРЅС‹Рµ С„Р°Р№Р»С‹/РёР·РѕР±СЂР°Р¶РµРЅРёСЏ, РґРѕР±Р°РІР»РµРЅРЅС‹Рµ С‡РµСЂРµР· @mention, drag&drop,
     *  paste РёР»Рё РєРЅРѕРїРєСѓ В«РџСЂРёРєСЂРµРїРёС‚СЊВ». Main-РїСЂРѕС†РµСЃСЃ РёРЅР»Р°Р№РЅРёС‚ С‚РµРєСЃС‚РѕРІС‹Рµ С„Р°Р№Р»С‹
     *  РІ content, РєР°СЂС‚РёРЅРєРё РїРµСЂРµРґР°С‘С‚ РєР°Рє РїСѓС‚СЊ (vision вЂ” Phase 2). */
    attachments?: Attachment[]
  }) => void
  'chat:create': (incognito?: boolean, mode?: ChatMode) => string
  'chat:getAll': () => Chat[]
  'chat:getMessages': (chatId: string) => Message[]
  'chat:delete': (chatId: string) => void
  'chat:rename': (chatId: string, title: string) => void
  // System
  'system:info': () => SystemInfo
  'system:logError': (message: string, stack?: string) => void
  // Overlay
  'overlay:show': () => void
  'overlay:hide': () => void
  'overlay:getDisplays': () => DisplayInfo[]
  // Voice
  'voice:toggle': () => void
  'voice:start': () => void
  'voice:stop': () => void
  // Spotlight
  'spotlight:show': () => void
  'spotlight:hide': () => void
}

export interface Chat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  isIncognito: number
  isPinned: number
  isArchived: number
  mode: ChatMode
  color?: string
  workdir?: string  // РґРµРЅРѕСЂРјР°Р»РёР·РѕРІР°РЅРЅС‹Р№ РєСЌС€ РёР· projects (РѕР±СЂР°С‚РЅР°СЏ СЃРѕРІРјРµСЃС‚РёРјРѕСЃС‚СЊ)
  projectId?: string  // FK РЅР° projects.id; NULL = В«Р‘РµР· РїСЂРѕРµРєС‚Р°В»
  lastMessage?: string
  messageCount?: number
}

export interface Project {
  id: string
  name: string
  workdir: string
  projectContext?: string  // СЂРµР·СѓР»СЊС‚Р°С‚ analyzeProject РїСЂРё СЃРѕР·РґР°РЅРёРё; РЅРµ РіРѕРЅСЏРµРј РїРѕ IPC РІ РєР°Р¶РґС‹Р№ chats.list
  verificationCommand?: string  // РєРѕРјР°РЅРґР° Р°РІС‚Рѕ-РїСЂРѕРІРµСЂРєРё РїРѕСЃР»Рµ СЃРµСЂРёРё РїСЂР°РІРѕРє (РЅР°РїСЂ. "npm test")
  createdAt: number
  lastUsed: number
}

export interface Message {
  id: string
  chatId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  isPinned: number
  model?: string
  toolSteps?: ToolStep[]
  thinking?: string
  thinkingMs?: number
  slashCommand?: { name: string; args: string }
  iterations?: Array<{ label?: string; textBefore: string; thinking?: string; thinkingMs?: number; steps: ToolStep[] }>
  liveSegments?: Array<{ text: string; steps: ToolStep[] }>
  imageUrl?: string
  planData?: { title: string; content: string; summary: string; filePath: string }
  todo?: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
  /** РћС‚РІРµС‚С‹ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ РЅР° ask_user-С‚СѓР» (РґР»СЏ СЂРµРЅРґРµСЂР° РІ ToolChain). */
  questionAnswers?: QuestionAnswer[]
  /** РџСЂРёРєСЂРµРїР»С‘РЅРЅС‹Рµ РїРѕР»СЊР·РѕРІР°С‚РµР»РµРј С„Р°Р№Р»С‹/РёР·РѕР±СЂР°Р¶РµРЅРёСЏ (РґР»СЏ СЂРµРЅРґРµСЂР° С‡РёРїРѕРІ РЅР°Рґ
   *  СЃРѕРѕР±С‰РµРЅРёРµРј). РўРµРєСЃС‚РѕРІРѕРµ СЃРѕРґРµСЂР¶РёРјРѕРµ СѓР¶Рµ РёРЅР»Р°Р№РЅРёР»РѕСЃСЊ РІ content РЅР° СЌС‚Р°РїРµ
   *  РѕС‚РїСЂР°РІРєРё, Р·РґРµСЃСЊ вЂ” С‚РѕР»СЊРєРѕ РјРµС‚Р°РґР°РЅРЅС‹Рµ РґР»СЏ UI. */
  attachments?: Attachment[]
  /** Р РµР·СѓР»СЊС‚Р°С‚ РѕР±СЂР°Р±РѕС‚РєРё РІР»РѕР¶РµРЅРёР№ (processAttachmentsAndStream) вЂ” РґР»СЏ
   *  РѕС‚РѕР±СЂР°Р¶РµРЅРёСЏ AttachmentProcessingBlock РІ СЃРѕС…СЂР°РЅС‘РЅРЅРѕРј СЃРѕРѕР±С‰РµРЅРёРё.
   *  Р—Р°РїРѕР»РЅСЏРµС‚СЃСЏ С‚РѕР»СЊРєРѕ Сѓ user-СЃРѕРѕР±С‰РµРЅРёР№ СЃ attachments. Live-СЃС‚СЂРёРјРёРЅРі
   *  РёРґС‘С‚ С‡РµСЂРµР· toolProgress['process_attachments'] РІ Zustand, РїРѕСЃР»Рµ
   *  Р·Р°РІРµСЂС€РµРЅРёСЏ СЂРµР·СѓР»СЊС‚Р°С‚ СЃРѕС…СЂР°РЅСЏРµС‚СЃСЏ РІ Р‘Р” РґР»СЏ РѕС‚РѕР±СЂР°Р¶РµРЅРёСЏ РїРѕСЃР»Рµ СЂРµСЃС‚Р°СЂС‚Р°. */
  attachmentResult?: AttachmentProcessingResult
  /** РЎРЅРёРјРѕРє СЂРµР·СЋРјРµ РЅР° РјРѕРјРµРЅС‚ СЃР¶Р°С‚РёСЏ РєРѕРЅС‚РµРєСЃС‚Р° (РґР»СЏ СЂР°Р·РІРѕСЂР°С‡РёРІР°РЅРёСЏ СЂР°Р·РґРµР»РёС‚РµР»СЏ).
   *  Р—Р°РїРѕР»РЅСЏРµС‚СЃСЏ С‚РѕР»СЊРєРѕ Сѓ system-СЃРѕРѕР±С‰РµРЅРёР№ СЃ slashCommand.name === 'compact'. */
  compactSummary?: string
  /** РЎС‚Р°С‚РёСЃС‚РёРєР° СЃР¶Р°С‚РёСЏ (Р·Р°РїРѕР»РЅСЏРµС‚СЃСЏ С‚РѕР»СЊРєРѕ Сѓ compact-СЂР°Р·РґРµР»РёС‚РµР»РµР№).
   *  РСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ ContextRing РґР»СЏ РїРѕРєР°Р·Р° РєРѕР»-РІР° СЃР¶Р°С‚РёР№ Рё СЃСЌРєРѕРЅРѕРјР»РµРЅРЅС‹С… С‚РѕРєРµРЅРѕРІ. */
  compactStats?: { removedCount: number; tokensBefore: number; tokensAfter: number; tokensSaved: number }
  /** Полная длительность ответа (мс от начала запроса до завершения стрима/агента).
   *  Заполняется только у assistant-сообщений; для user/system — undefined. */
  durationMs?: number
  /** Реальные токены от провайдера (суммарно по всем LLM-вызовам turn'а).
   *  Заполняется только у assistant-сообщений при наличии usage от провайдера. */
  promptTokens?: number
  completionTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Кол-во вызванных тулов в этом turn'е (число tool_call шагов). */
  toolCallsCount?: number
}

// в”Ђв”Ђв”Ђ Attachments & Mentions в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// Attachment вЂ” РїСЂРёРєСЂРµРїР»С‘РЅРЅС‹Р№ С„Р°Р№Р»/РёР·РѕР±СЂР°Р¶РµРЅРёРµ Рє СЃРѕРѕР±С‰РµРЅРёСЋ. РњРѕР¶РµС‚ РїСЂРёР№С‚Рё РёР·:
//   1. @mention-РїРёРєРµСЂР° (files РїСЂРѕРµРєС‚Р°, skills, commands)
//   2. Drag&Drop РёР· РїСЂРѕРІРѕРґРЅРёРєР° РІ РёРЅРїСѓС‚
//   3. Paste РёР·РѕР±СЂР°Р¶РµРЅРёСЏ РёР· Р±СѓС„РµСЂР° РѕР±РјРµРЅР° (Ctrl+V)
//   4. РљРЅРѕРїРєРё В«РџСЂРёРєСЂРµРїРёС‚СЊ С„Р°Р№Р»В» (native dialog Electron)
//
// РўРµРєСЃС‚РѕРІС‹Рµ С„Р°Р№Р»С‹ РёРЅР»Р°Р№РЅСЏС‚СЃСЏ РІ content РїСЂРё РѕС‚РїСЂР°РІРєРµ (main-РїСЂРѕС†РµСЃСЃ).
// РР·РѕР±СЂР°Р¶РµРЅРёСЏ РІ Phase 1 РїРµСЂРµРґР°СЋС‚СЃСЏ С‚РѕР»СЊРєРѕ РєР°Рє РїСѓС‚СЊ+РёРјСЏ (vision вЂ” Phase 2).
// Р‘РёРЅР°СЂРЅС‹Рµ С„Р°Р№Р»С‹ вЂ” С‚РѕР»СЊРєРѕ РїСѓС‚СЊ+РёРјСЏ Р±РµР· СЃРѕРґРµСЂР¶РёРјРѕРіРѕ.

/** РўРёРї РІР»РѕР¶РµРЅРёСЏ РїРѕ РёСЃС‚РѕС‡РЅРёРєСѓ/СЃРїРѕСЃРѕР±Сѓ РґРѕР±Р°РІР»РµРЅРёСЏ. */
export type AttachmentKind = 'file' | 'image' | 'skill' | 'command'

/** РСЃС‚РѕС‡РЅРёРє РїСЂРёРєСЂРµРїР»РµРЅРёСЏ (РґР»СЏ UI-Р±РµР№РґР¶Р° Рё Р»РѕРіРёСЂРѕРІР°РЅРёСЏ). */
export type AttachmentSource = 'mention' | 'dragdrop' | 'paste' | 'dialog'

/**
 * Attachment вЂ” РїСЂРёРєСЂРµРїР»С‘РЅРЅС‹Р№ Рє СЃРѕРѕР±С‰РµРЅРёСЋ С„Р°Р№Р»/РёР·РѕР±СЂР°Р¶РµРЅРёРµ/СЃСѓС‰РЅРѕСЃС‚СЊ.
 *
 * РџРѕР»СЏ:
 *  - id: СѓРЅРёРєР°Р»СЊРЅС‹Р№ РёРґРµРЅС‚РёС„РёРєР°С‚РѕСЂ (uuid) РґР»СЏ key РІ React + СѓРґР°Р»РµРЅРёСЏ РёР· draft.
 *  - kind: 'file' | 'image' | 'skill' | 'command' вЂ” РѕРїСЂРµРґРµР»СЏРµС‚ СЂРµРЅРґРµСЂ С‡РёРїР°.
 *  - name: РѕС‚РѕР±СЂР°Р¶Р°РµРјРѕРµ РёРјСЏ (basename РґР»СЏ С„Р°Р№Р»РѕРІ, label РґР»СЏ skill/command).
 *  - path: Р°Р±СЃРѕР»СЋС‚РЅС‹Р№ РїСѓС‚СЊ Рє С„Р°Р№Р»Сѓ (РґР»СЏ file/image). undefined РґР»СЏ skill/command.
 *  - relPath: РѕС‚РЅРѕСЃРёС‚РµР»СЊРЅС‹Р№ РїСѓС‚СЊ РѕС‚ workdir (РґР»СЏ РѕС‚РѕР±СЂР°Р¶РµРЅРёСЏ РІ tooltip).
 *  - mime: MIME-С‚РёРї (РґР»СЏ image вЂ” image/png Рё С‚.Рґ.; РґР»СЏ text вЂ” text/plain).
 *  - size: СЂР°Р·РјРµСЂ С„Р°Р№Р»Р° РІ Р±Р°Р№С‚Р°С… (РґР»СЏ Р»РёРјРёС‚РѕРІ Рё РѕС‚РѕР±СЂР°Р¶РµРЅРёСЏ).
 *  - source: СЃРїРѕСЃРѕР± РґРѕР±Р°РІР»РµРЅРёСЏ (mention/dragdrop/paste/dialog).
 *  - dataUrl: data: URL РґР»СЏ РёР·РѕР±СЂР°Р¶РµРЅРёР№ РёР· paste/dragdrop (РєРѕРіРґР° С„Р°Р№Р» РµС‰С‘ РЅРµ
 *    СЃРѕС…СЂР°РЅС‘РЅ РЅР° РґРёСЃРє). РџРѕСЃР»Рµ СЃРѕС…СЂР°РЅРµРЅРёСЏ РІ userData вЂ” Р·Р°РјРµРЅСЏРµС‚СЃСЏ РЅР° path.
 *  - skillId / commandName: РґР»СЏ kind='skill'/'command' вЂ” РёРґРµРЅС‚РёС„РёРєР°С‚РѕСЂ СЃСѓС‰РЅРѕСЃС‚Рё.
 *  - snippet: РєСЂР°С‚РєРёР№ preview СЃРѕРґРµСЂР¶РёРјРѕРіРѕ (РїРµСЂРІС‹Рµ ~200 СЃРёРјРІРѕР»РѕРІ) РґР»СЏ tooltip.
 */
export interface Attachment {
  id: string
  kind: AttachmentKind
  name: string
  path?: string
  relPath?: string
  mime?: string
  size?: number
  source: AttachmentSource
  dataUrl?: string
  skillId?: string
  commandName?: string
  snippet?: string
  /** Р’СЂРµРјСЏ РїСЂРёРєСЂРµРїР»РµРЅРёСЏ (РґР»СЏ СЃРѕСЂС‚РёСЂРѕРІРєРё РЅРµРґР°РІРЅРёС… РІ @-РїРёРєРµСЂРµ). */
  attachedAt: number
}

/**
 * Р РµР·СѓР»СЊС‚Р°С‚ РѕР±СЂР°Р±РѕС‚РєРё РІР»РѕР¶РµРЅРёР№ РґР»СЏ AttachmentProcessingBlock.
 *
 * Р—Р°РїРѕР»РЅСЏРµС‚СЃСЏ РІ main-РїСЂРѕС†РµСЃСЃРµ (processAttachmentsAndStream) Рё СЃРѕС…СЂР°РЅСЏРµС‚СЃСЏ
 * РІ message.attachmentResult РґР»СЏ РѕС‚РѕР±СЂР°Р¶РµРЅРёСЏ РїРѕСЃР»Рµ СЂРµСЃС‚Р°СЂС‚Р°. Live-СЃС‚СЂРёРјРёРЅРі
 * РёРґС‘С‚ С‡РµСЂРµР· toolProgress['process_attachments'] СЃ РїРѕР»СЏРјРё {stage, detail,
 * filesProcessed, filesTotal}.
 *
 * РЎС‚СЂСѓРєС‚СѓСЂР° РєР°Рє Сѓ FastContextResultData вЂ” files[], summary, ms.
 */
export interface AttachmentProcessingFile {
  name: string
  kind: string
  status: 'text_inlined' | 'image_described' | 'binary_path' | 'error' | 'skipped'
  size?: number
  detail?: string
  /** Р”Р»СЏ image_described вЂ” РєСЂР°С‚РєРѕРµ РѕРїРёСЃР°РЅРёРµ (РїРµСЂРІС‹Рµ ~200 СЃРёРјРІРѕР»РѕРІ). */
  description?: string
}

export interface AttachmentProcessingResult {
  files: AttachmentProcessingFile[]
  totalProcessed: number
  totalErrors: number
  totalImages: number
  ms: number
  hasErrors: boolean
}

/**
 * MentionItem вЂ” СЌР»РµРјРµРЅС‚ РїР»РѕСЃРєРѕРіРѕ СЃРїРёСЃРєР° РІ @-РґСЂРѕРїРґР°СѓРЅРµ.
 *
 * types: 'file' | 'image' | 'skill' | 'command' вЂ” СЃРѕРѕС‚РІРµС‚СЃС‚РІСѓРµС‚ AttachmentKind,
 *  РЅРѕ 'image' РІС‹РґРµР»РµРЅ РѕС‚РґРµР»СЊРЅРѕ С‡С‚РѕР±С‹ РІ @-РїРёРєРµСЂРµ РїРѕРєР°Р·С‹РІР°С‚СЊ РєР°СЂС‚РёРЅРєРё СЃ РґРёСЃРєР°
 *  (РґР°Р¶Рµ РµСЃР»Рё РѕРЅРё РІРЅРµ workdir) СЃ РїСЂРµРІСЊСЋ.
 *
 * РЎРѕСЂС‚РёСЂРѕРІРєР° РІ filterMentions: С‚РѕС‡РЅС‹Рµ СЃРѕРІРїР°РґРµРЅРёСЏ РїРѕ РёРјРµРЅРё в†’ РЅРµРґР°РІРЅРёРµ в†’ РѕСЃС‚Р°Р»СЊРЅС‹Рµ.
 */
export type MentionItemType = 'file' | 'image' | 'skill' | 'command'

export interface MentionItem {
  id: string
  type: MentionItemType
  label: string
  /** РљСЂР°С‚РєРѕРµ РѕРїРёСЃР°РЅРёРµ/РїСѓС‚СЊ РґР»СЏ РІС‚РѕСЂРѕР№ СЃС‚СЂРѕРєРё РІ РґСЂРѕРїРґР°СѓРЅРµ. */
  description?: string
  /** РђР±СЃРѕР»СЋС‚РЅС‹Р№ РїСѓС‚СЊ (РґР»СЏ file/image). */
  path?: string
  /** РћС‚РЅРѕСЃРёС‚РµР»СЊРЅС‹Р№ РїСѓС‚СЊ РѕС‚ workdir. */
  relPath?: string
  /** id СЃРєРёР»Р»Р° (РґР»СЏ type='skill'). */
  skillId?: string
  /** РРјСЏ РєРѕРјР°РЅРґС‹ (РґР»СЏ type='command'). */
  commandName?: string
  /** MIME-С‚РёРї (РґР»СЏ image вЂ” С‡С‚РѕР±С‹ СЂРµС€РёС‚СЊ, РїСЂРµРІСЊСЋ РёР»Рё РёРєРѕРЅРєСѓ). */
  mime?: string
  /** Р Р°Р·РјРµСЂ С„Р°Р№Р»Р° (РґР»СЏ РѕС‚РѕР±СЂР°Р¶РµРЅРёСЏ Рё Р»РёРјРёС‚РѕРІ). */
  size?: number
  /** mtime С„Р°Р№Р»Р° (РґР»СЏ СЃРѕСЂС‚РёСЂРѕРІРєРё РЅРµРґР°РІРЅРёС…). */
  mtime?: number
  /** РљРѕР»РёС‡РµСЃС‚РІРѕ СѓРїРѕРјРёРЅР°РЅРёР№ РІ СЌС‚РѕРј С‡Р°С‚Рµ (РґР»СЏ Р±СѓСЃС‚Р° РІ fuzzy). */
  useCount?: number
}

export interface ToolStep {
  id: string
  type: 'tool_call' | 'tool_result'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  timestamp: number
  imageUrl?: string  // РїСѓС‚СЊ Рє СЃРіРµРЅРµСЂРёСЂРѕРІР°РЅРЅРѕРјСѓ РёР·РѕР±СЂР°Р¶РµРЅРёСЋ
  diff?: string      // unified diff РґР»СЏ edit_file / multi_edit_file
  callId?: string    // ID tool_call РґР»СЏ СЃРІСЏР·Рё callв†’result (СЂРµРєРѕРЅСЃС‚СЂСѓРєС†РёСЏ РёСЃС‚РѕСЂРёРё)
  /** РРјСЏ MCP-СЃРµСЂРІРµСЂР° РґР»СЏ MCP-С‚СѓР»РѕРІ (mcp__server__tool). undefined РґР»СЏ РІСЃС‚СЂРѕРµРЅРЅС‹С…. */
  serverName?: string
}

// в”Ђв”Ђв”Ђ ask_user: С‚СѓР» СѓС‚РѕС‡РЅСЏСЋС‰РёС… РІРѕРїСЂРѕСЃРѕРІ РїРѕР»СЊР·РѕРІР°С‚РµР»СЋ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// РЎРїРµС†РёС„РёРєР°С†РёСЏ РѕРґРЅРѕРіРѕ РІРѕРїСЂРѕСЃР°, РєРѕС‚РѕСЂС‹Р№ AI Р·Р°РґР°С‘С‚ РїРѕР»СЊР·РѕРІР°С‚РµР»СЋ С‡РµСЂРµР· UI-РїР°РЅРµР»СЊ.
export interface QuestionOption {
  /** РРґРµРЅС‚РёС„РёРєР°С‚РѕСЂ РѕРїС†РёРё (РґР»СЏ РјР°РїРїРёРЅРіР° РѕС‚РІРµС‚Р° РѕР±СЂР°С‚РЅРѕ Рє РјРѕРґРµР»Рё). */
  value: string
  /** РћС‚РѕР±СЂР°Р¶Р°РµРјС‹Р№ С‚РµРєСЃС‚ РѕРїС†РёРё. */
  label: string
  /** РќРµРѕР±СЏР·Р°С‚РµР»СЊРЅРѕРµ РѕРїРёСЃР°РЅРёРµ РѕРїС†РёРё (РїРѕСЏСЃРЅРµРЅРёРµ). */
  description?: string
}

/** РўРёРї РІРѕРїСЂРѕСЃР° вЂ” РѕРїСЂРµРґРµР»СЏРµС‚ UI-СЂРµРЅРґРµСЂ РІ QuestionPanel. */
export type QuestionType = 'text' | 'choice' | 'yesno'

/** РЈСЃР»РѕРІРёРµ РїРѕРєР°Р·Р° РІРѕРїСЂРѕСЃР° (conditional). Р’РѕРїСЂРѕСЃ СЃРєСЂС‹С‚ РїРѕРєР° СѓСЃР»РѕРІРёРµ РЅРµ РІС‹РїРѕР»РЅРµРЅРѕ. */
export interface QuestionCondition {
  /** ID РІРѕРїСЂРѕСЃР°, РѕС‚РІРµС‚ РєРѕС‚РѕСЂРѕРіРѕ РїСЂРѕРІРµСЂСЏРµС‚СЃСЏ. */
  questionId: string
  /** Р—РЅР°С‡РµРЅРёРµ (РёР»Рё РјР°СЃСЃРёРІ Р·РЅР°С‡РµРЅРёР№), РїСЂРё РєРѕС‚РѕСЂРѕРј СЌС‚РѕС‚ РІРѕРїСЂРѕСЃ РїРѕРєР°Р·С‹РІР°РµС‚СЃСЏ. */
  equals: string | string[]
}

export interface QuestionSpec {
  /** ID РІРѕРїСЂРѕСЃР° вЂ” РјРѕРґРµР»СЊ РјРѕР¶РµС‚ СѓРєР°Р·Р°С‚СЊ СЃРІРѕР№; РёРЅР°С‡Рµ РіРµРЅРµСЂРёСЂСѓРµС‚СЃСЏ. */
  id?: string
  /** РўРµРєСЃС‚ РІРѕРїСЂРѕСЃР°. */
  question: string
  /** РљРѕСЂРѕС‚РєРёР№ Р·Р°РіРѕР»РѕРІРѕРє (РЅРµРѕР±СЏР·Р°С‚РµР»СЊРЅРѕ). */
  header?: string
  /**
   * РўРёРї РІРѕРїСЂРѕСЃР° вЂ” РѕРїСЂРµРґРµР»СЏРµС‚ UI-СЂРµРЅРґРµСЂ.
   * - text (default) вЂ” СЃРІРѕР±РѕРґРЅС‹Р№ С‚РµРєСЃС‚РѕРІС‹Р№ РѕС‚РІРµС‚
   * - choice вЂ” РІС‹Р±РѕСЂ РёР· options (СЃ radio/checkbox)
   * - yesno вЂ” РґРІРµ Р±РѕР»СЊС€РёРµ РєРЅРѕРїРєРё Р”Р°/РќРµС‚ (Р±С‹СЃС‚СЂРѕРµ РїРѕРґС‚РІРµСЂР¶РґРµРЅРёРµ)
   * Р•СЃР»Рё РЅРµ СѓРєР°Р·Р°РЅ, Р°РІС‚Рѕ-detect: РµСЃС‚СЊ options в†’ choice, РёРЅР°С‡Рµ text.
   */
  type?: QuestionType
  /** Р“РѕС‚РѕРІС‹Рµ РІР°СЂРёР°РЅС‚С‹ РѕС‚РІРµС‚Р° (РґР»СЏ type=choice). */
  options?: QuestionOption[]
  /** Р Р°Р·СЂРµС€РёС‚СЊ РјРЅРѕР¶РµСЃС‚РІРµРЅРЅС‹Р№ РІС‹Р±РѕСЂ (С‚РѕР»СЊРєРѕ РґР»СЏ type=choice). */
  multiple?: boolean
  /** Р Р°Р·СЂРµС€РёС‚СЊ СЃРІРѕР№ РѕС‚РІРµС‚ (default true). Р”Р»СЏ yesno вЂ” РёРіРЅРѕСЂРёСЂСѓРµС‚СЃСЏ. */
  allowCustom?: boolean
  /** Р’РѕРїСЂРѕСЃ РѕР±СЏР·Р°С‚РµР»СЊРЅС‹Р№ (РЅРµР»СЊР·СЏ РїСЂРѕРїСѓСЃС‚РёС‚СЊ). */
  required?: boolean
  /** РџСЂРµРґР·Р°РїРѕР»РЅРµРЅРЅС‹Р№ РѕС‚РІРµС‚ вЂ” РјРѕРґРµР»СЊ РїСЂРµРґР»Р°РіР°РµС‚ РїСЂРµРґРїРѕР»РѕР¶РµРЅРёРµ, СЋР·РµСЂ РїСЂР°РІРёС‚. */
  defaultValue?: string
  /** РљР°СЃС‚РѕРјРЅС‹Р№ placeholder РґР»СЏ С‚РµРєСЃС‚РѕРІРѕРіРѕ РїРѕР»СЏ. */
  placeholder?: string
  /** РџРѕСЏСЃРЅРµРЅРёРµ РїРѕРґ РІРѕРїСЂРѕСЃРѕРј (СЂР°СЃРєСЂС‹РІР°СЋС‰РёР№СЃСЏ Р±Р»РѕРє). Р”Р»СЏ РєРѕРЅС‚РµРєСЃС‚Р°. */
  helpText?: string
  /** РњРЅРѕРіРѕСЃС‚СЂРѕС‡РЅРѕРµ С‚РµРєСЃС‚РѕРІРѕРµ РїРѕР»Рµ (5+ СЃС‚СЂРѕРє РІРјРµСЃС‚Рѕ 2). Р”Р»СЏ РѕРїРёСЃР°С‚РµР»СЊРЅС‹С… РѕС‚РІРµС‚РѕРІ. */
  multiline?: boolean
  /** РљР°СЃС‚РѕРјРЅС‹Р№ С‚РµРєСЃС‚ РєРЅРѕРїРєРё РїСЂРѕРїСѓСЃРєР° (default 'РџСЂРѕРїСѓСЃС‚РёС‚СЊ'). */
  skipLabel?: string
  /** РЈСЃР»РѕРІРёРµ РїРѕРєР°Р·Р° вЂ” РІРѕРїСЂРѕСЃ СЃРєСЂС‹С‚ РїРѕРєР° РѕС‚РІРµС‚ РЅР° questionId РЅРµ СЂР°РІРµРЅ equals. */
  showIf?: QuestionCondition
}

/** РћС‚РІРµС‚ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ РЅР° РѕРґРёРЅ РІРѕРїСЂРѕСЃ. */
export interface QuestionAnswer {
  /** ID РІРѕРїСЂРѕСЃР° РёР· QuestionSpec (РёР»Рё СЃРіРµРЅРµСЂРёСЂРѕРІР°РЅРЅС‹Р№). */
  id: string
  /** Р’С‹Р±СЂР°РЅРЅС‹Рµ Р·РЅР°С‡РµРЅРёСЏ РѕРїС†РёР№ (РґР»СЏ choice/multiple). */
  values?: string[]
  /** РЎРІРѕР±РѕРґРЅС‹Р№ С‚РµРєСЃС‚РѕРІС‹Р№ РѕС‚РІРµС‚ (text/choice+allowCustom). */
  text?: string
  /** Р”Р°/РќРµС‚ (РґР»СЏ yesno). */
  value?: boolean
}

// в”Ђв”Ђв”Ђ Checkpoint / Rewind в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// РўРѕС‡РєР° РѕС‚РєР°С‚Р° СЃРµСЃСЃРёРё: РїР°СЂР° (user_message_id, assistant_message_id) РѕРґРЅРѕРіРѕ turn'Р°.
// РСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ РїСЂР°РІРѕР№ РїР°РЅРµР»СЊСЋ "РЎРµСЃСЃРёСЏ" РґР»СЏ С‚Р°Р№РјР»Р°Р№РЅР° Рё РєРЅРѕРїРєРѕР№ "РћС‚РєР°С‚РёС‚СЊ" РЅР°
// user-СЃРѕРѕР±С‰РµРЅРёСЏС….
export interface CheckpointMeta {
  id: string
  chatId: string
  userMessageId: string
  assistantMessageId: string | null
  userPromptPreview: string  // РїРµСЂРІС‹Рµ 120 СЃРёРјРІРѕР»РѕРІ user-РїСЂРѕРјРїС‚Р°
  filesChanged: number       // РєРѕР»-РІРѕ С„Р°Р№Р»РѕРІ, РёР·РјРµРЅС‘РЅРЅС‹С… РІ СЌС‚РѕРј turn'Рµ
  filePaths: string[]        // СЃРїРёСЃРѕРє РїСѓС‚РµР№ РёР·РјРµРЅС‘РЅРЅС‹С… С„Р°Р№Р»РѕРІ
  createdAt: number
  /** РРјСЏ СЃРЅР°РїС€РѕС‚Р° РґР»СЏ /snapshot <name> + /restore <name>. NULL Сѓ РѕР±С‹С‡РЅС‹С…
   *  auto-checkpoint'РѕРІ РЅР° РєР°Р¶РґС‹Р№ turn. РРјРµРЅРѕРІР°РЅРЅС‹Рµ вЂ” СЏРІРЅРѕ СЃРѕР·РґР°РЅС‹ РїРѕР»СЊР·РѕРІР°С‚РµР»РµРј. */
  name?: string | null
}

// Р РµР·СѓР»СЊС‚Р°С‚ chat:rewindTo вЂ” Р»РёР±Рѕ РѕР±РЅРѕРІР»С‘РЅРЅС‹Р№ РјР°СЃСЃРёРІ СЃРѕРѕР±С‰РµРЅРёР№, Р»РёР±Рѕ РѕС€РёР±РєР°.
export interface RewindResult {
  messages?: Message[]
  error?: string
}

// РњРµС‚Р°РґР°РЅРЅС‹Рµ РѕРґРЅРѕРіРѕ Р·Р°РїСЂРѕСЃР° РІ РѕС‡РµСЂРµРґРё РёР»Рё Р°РєС‚РёРІРЅРѕРіРѕ Р·Р°РїСѓСЃРєР° С‡Р°С‚Р°.
// РСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ UI-РїР°РЅРµР»СЊСЋ РѕС‡РµСЂРµРґРё РґР»СЏ РѕС‚РѕР±СЂР°Р¶РµРЅРёСЏ preview/СѓРїСЂР°РІР»РµРЅРёСЏ.
export interface QueueItemMeta {
  queueId: string       // СѓРЅРёРєР°Р»СЊРЅС‹Р№ ID СЌР»РµРјРµРЅС‚Р° (uuid)
  chatId: string
  msgId: string         // assistantMsgId (Р±СѓРґСѓС‰РµРіРѕ РѕС‚РІРµС‚Р°)
  userMsgId: string     // id user-СЃРѕРѕР±С‰РµРЅРёСЏ
  preview: string       // РїРµСЂРІС‹Рµ ~80 СЃРёРјРІ. С‚РµРєСЃС‚Р° Р·Р°РїСЂРѕСЃР°
  enqueuedAt: number    // ts РїРѕСЃС‚Р°РЅРѕРІРєРё РІ РѕС‡РµСЂРµРґСЊ
  startedAt?: number    // ts СЃС‚Р°СЂС‚Р° РІРѕСЂРєРµСЂР° (РґР»СЏ active run)
}

export interface DisplayInfo {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  isPrimary: boolean
}

export interface SystemInfo {
  platform: string
  version: string
  appVersion: string
}

export interface AgentAction {
  type: 'tool_call' | 'tool_result' | 'thinking' | 'done' | 'error'
  tool?: string
  args?: unknown
  result?: string
  error?: string
  timestamp: number
}

// в”Ђв”Ђв”Ђ AI Providers & Models в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export type ProviderType =
  | 'openai' | 'anthropic' | 'google' | 'groq' | 'cerebras' | 'mistral'
  | 'ollama' | 'cohere' | 'together' | 'fireworks' | 'deepseek'
  | 'xai' | 'voidai' | 'custom'
  | 'opencode' | 'opencode-free' | 'opencode-go'
  | 'openrouter'
  | 'syntee-gateway'

export interface Provider {
  id: string               // СѓРЅРёРєР°Р»СЊРЅС‹Р№ slug: 'openai', 'my-custom-1'
  type: ProviderType
  name: string             // РѕС‚РѕР±СЂР°Р¶Р°РµРјРѕРµ РЅР°Р·РІР°РЅРёРµ
  baseUrl: string          // https://api.openai.com/v1
  apiKey: string           // РѕСЃРЅРѕРІРЅРѕР№ РєР»СЋС‡ (РѕР±СЂР°С‚РЅР°СЏ СЃРѕРІРјРµСЃС‚РёРјРѕСЃС‚СЊ)
  apiKeys?: string[]       // РЅРµСЃРєРѕР»СЊРєРѕ РєР»СЋС‡РµР№ вЂ” round-robin
  rrIndex?: number         // С‚РµРєСѓС‰РёР№ РёРЅРґРµРєСЃ round-robin
  enabled: boolean
  isCustom: boolean
  iconUrl?: string         // РґР»СЏ РєР°СЃС‚РѕРјРЅС‹С… РїСЂРѕРІР°Р№РґРµСЂРѕРІ
  lastModelsFetch?: number // timestamp РїРѕСЃР»РµРґРЅРµРіРѕ РїР°СЂСЃРёРЅРіР°
  modelsOverride?: string[]// СЂСѓС‡РЅС‹Рµ РјРѕРґРµР»Рё РґРѕР±Р°РІР»РµРЅРЅС‹Рµ РїРѕР»СЊР·РѕРІР°С‚РµР»РµРј
  /** РџСЂРѕРІР°Р№РґРµСЂ СЂР°Р±РѕС‚Р°РµС‚ Р±РµР· API-РєР»СЋС‡Р° (Р°РЅРѕРЅРёРјРЅС‹Р№, С€Р»С‘С‚ Bearer public). */
  anonymous?: boolean
}

export type ModelCapability = 'vision' | 'tools' | 'reasoning' | 'code' | 'embedding' | 'tts' | 'stt' | 'image_gen'

export type ModelSpeed = 'fast' | 'medium' | 'slow'

export interface ModelMeta {
  id: string               // 'gpt-4o', 'claude-3-5-sonnet-20241022'
  providerId: string       // СЃСЃС‹Р»РєР° РЅР° Provider.id
  name: string             // РєСЂР°СЃРёРІРѕРµ РЅР°Р·РІР°РЅРёРµ
  contextWindow: number    // РІ С‚РѕРєРµРЅР°С…
  inputPrice?: number      // $ Р·Р° 1M input С‚РѕРєРµРЅРѕРІ
  outputPrice?: number     // $ Р·Р° 1M output С‚РѕРєРµРЅРѕРІ
  speed: ModelSpeed
  capabilities: ModelCapability[]
  description?: string
  isCustom?: boolean       // РґРѕР±Р°РІР»РµРЅР° РїРѕР»СЊР·РѕРІР°С‚РµР»РµРј РІСЂСѓС‡РЅСѓСЋ
}

export type ModelRole =
  | 'main'        // РѕСЃРЅРѕРІРЅРѕР№ С‡Р°С‚
  | 'fast'        // Р±С‹СЃС‚СЂС‹Рµ РѕС‚РІРµС‚С‹, Р°РІС‚РѕС‚Р°Р№С‚Р»С‹
  | 'fastContext' // fast context retrieval (tree-sitter + fast LLM)
  | 'vision'      // Р°РЅР°Р»РёР· РёР·РѕР±СЂР°Р¶РµРЅРёР№
  | 'stt'         // speech-to-text
  | 'tts'         // text-to-speech
  | 'embedding'   // РІРµРєС‚РѕСЂРЅС‹Р№ РїРѕРёСЃРє / РїР°РјСЏС‚СЊ
  | 'memory'      // Р°РЅР°Р»РёР· РїР°РјСЏС‚Рё
  | 'summary'     // Р°РІС‚Рѕ-Р·Р°РіРѕР»РѕРІРєРё С‡Р°С‚РѕРІ
  | 'subagent'    // СЃСѓР±-Р°РіРµРЅС‚С‹

export interface ModelAssignment {
  role: ModelRole
  modelId: string
  providerId: string
}

export interface ModelParams {
  systemPrompt: string     // РіР»РѕР±Р°Р»СЊРЅР°СЏ РґРѕРї. РёРЅСЃС‚СЂСѓРєС†РёСЏ (Р°РїРїРµРЅРґРёС‚СЃСЏ, РЅРµ РїРµСЂРµР·Р°РїРёСЃС‹РІР°РµС‚)
  streaming: boolean
}

export type ApprovalMode = 'ask' | 'auto' | 'full'
export type ToolOutputMode = 'compact' | 'normal' | 'detailed'
export type ChatMode = 'code' | 'work'

export interface AgentSettings {
  approvalMode: ApprovalMode
  maxSteps: number
  toolOutputMode: ToolOutputMode
  enableThinking: boolean
  maxParallelSubAgents: number
  readFileCache: boolean
  autoMemoryInterval: number
  maxRepeatedToolCalls: number
  maxRepeatedErrors: number
}

// Р”РµС„РѕР»С‚РЅС‹Рµ РЅР°СЃС‚СЂРѕР№РєРё Р°РіРµРЅС‚Р°. Р’С‹РЅРµСЃРµРЅС‹ РІ shared, С‡С‚РѕР±С‹ renderer (SettingsPage)
// РјРѕРі РёСЃРїРѕР»СЊР·РѕРІР°С‚СЊ РёС… РґР»СЏ РєРЅРѕРїРѕРє В«РІРѕСЃСЃС‚Р°РЅРѕРІРёС‚СЊ РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋВ» Р±РµР· IPC-Р·Р°РїСЂРѕСЃР°.
// main/ipc/agent.ipc.ts Рё main/ipc/chat.ipc.ts РёРјРїРѕСЂС‚РёСЂСѓСЋС‚ РѕС‚СЃСЋРґР° Р¶Рµ.
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  approvalMode: 'ask',
  maxSteps: 50,
  toolOutputMode: 'normal',
  enableThinking: false,
  maxParallelSubAgents: 3,
  readFileCache: true,
  autoMemoryInterval: 5,
  maxRepeatedToolCalls: 3,
  maxRepeatedErrors: 2,
}

// IPC channels РґР»СЏ РїСЂРѕРІР°Р№РґРµСЂРѕРІ/РјРѕРґРµР»РµР№
export interface ProviderIPC {
  'providers:getAll': () => Provider[]
  'providers:save': (provider: Provider) => void
  'providers:delete': (id: string) => void
  'providers:fetchModels': (providerId: string) => ModelMeta[]
  'providers:testKey': (providerId: string) => { ok: boolean; error?: string }
  'models:getAll': () => ModelMeta[]
  'models:saveCustom': (model: ModelMeta) => void
  'models:deleteCustom': (modelId: string, providerId: string) => void
  'models:getAssignments': () => ModelAssignment[]
  'models:setAssignment': (assignment: ModelAssignment) => void
  'models:getParams': () => ModelParams
  'models:setParams': (params: Partial<ModelParams>) => void
}

// в”Ђв”Ђв”Ђ MCP (Model Context Protocol) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/** РўСЂР°РЅСЃРїРѕСЂС‚ РїРѕРґРєР»СЋС‡РµРЅРёСЏ Рє MCP-СЃРµСЂРІРµСЂСѓ. */
export type McpTransport = 'stdio' | 'sse' | 'streamable-http'

/**
 * РћР±Р»Р°СЃС‚СЊ РїСЂРёРјРµРЅРµРЅРёСЏ СЂР°СЃС€РёСЂРµРЅРёСЏ (MCP-СЃРµСЂРІРµСЂР° РёР»Рё СЃРєРёР»Р»Р°).
 * - global  в†’ РїСЂРёРјРµРЅСЏРµС‚СЃСЏ РєРѕ РІСЃРµРј С‡Р°С‚Р°Рј
 * - projects в†’ РїСЂРёРјРµРЅСЏРµС‚СЃСЏ С‚РѕР»СЊРєРѕ Рє С‡Р°С‚Р°Рј РІС‹Р±СЂР°РЅРЅС‹С… РїСЂРѕРµРєС‚РѕРІ (projectIds)
 */
export interface ExtensionScope {
  type: 'global' | 'projects'
  projectIds?: string[]
}

/** РљРѕРЅС„РёРіСѓСЂР°С†РёСЏ MCP-СЃРµСЂРІРµСЂР° (С…СЂР°РЅРёС‚СЃСЏ РІ electron-store / .mcp.json). */
export interface McpServerConfig {
  /** РЈРЅРёРєР°Р»СЊРЅС‹Р№ slug. Р”Р»СЏ РїСЂРѕРµРєС‚РЅС‹С… СЃРµСЂРІРµСЂРѕРІ вЂ” РёРјСЏ РёР· .mcp.json. */
  id: string
  /** РћС‚РѕР±СЂР°Р¶Р°РµРјРѕРµ РёРјСЏ. */
  name: string
  transport: McpTransport
  // stdio-only
  command?: string
  args?: string[]
  env?: Record<string, string>
  // sse-only
  url?: string
  headers?: Record<string, string>
  /** Р’РєР»СЋС‡С‘РЅ Р»Рё СЃРµСЂРІРµСЂ (РіР»РѕР±Р°Р»СЊРЅС‹Р№ С‚СѓРјР±Р»РµСЂ). */
  enabled: boolean
  scope: ExtensionScope
  /** 'global' (РёР· electron-store) РёР»Рё 'project' (РёР· .mcp.json). */
  source: 'global' | 'project'
  /** Р”Р»СЏ РїСЂРѕРµРєС‚РЅС‹С… СЃРµСЂРІРµСЂРѕРІ вЂ” id РїСЂРѕРµРєС‚Р°, РёР· workdir РєРѕС‚РѕСЂРѕРіРѕ Р·Р°РіСЂСѓР¶РµРЅ. */
  projectId?: string
}

/** Per-tool СЃРѕСЃС‚РѕСЏРЅРёРµ (РІРєР»СЋС‡С‘РЅ / РїРѕРґС‚РІРµСЂР¶РґРµРЅРёРµ) вЂ” С…СЂР°РЅРёС‚СЃСЏ РѕС‚РґРµР»СЊРЅРѕ РѕС‚ РєРѕРЅС„РёРіР°. */
export interface McpToolState {
  enabled: boolean
  /** РЎРїСЂР°С€РёРІР°С‚СЊ РїРѕРґС‚РІРµСЂР¶РґРµРЅРёРµ РїРµСЂРµРґ РІС‹Р·РѕРІРѕРј СЌС‚РѕРіРѕ С‚СѓР»Р°. */
  requireApproval: boolean
}

/** Runtime-РѕРїРёСЃР°РЅРёРµ С‚СѓР»Р·Р° MCP, Р°РіСЂРµРіРёСЂРѕРІР°РЅРЅРѕРµ McpManager-РѕРј РґР»СЏ Р°РіРµРЅС‚Р°. */
export interface McpToolRuntime {
  serverId: string
  serverName: string
  /** РџРѕР»РЅРѕРµ РёРјСЏ С‚СѓР»Р°: mcp__{serverName}__{toolName}. */
  name: string
  /** РљРѕСЂРѕС‚РєРѕРµ РёРјСЏ С‚СѓР»Р° (Р±РµР· РїСЂРµС„РёРєСЃР°). */
  shortName: string
  description: string
  inputSchema: Record<string, unknown>
}

/** РЎС‚Р°С‚СѓСЃ РїРѕРґРєР»СЋС‡РµРЅРёСЏ MCP-СЃРµСЂРІРµСЂР°. */
export type McpConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

/** РЈСЂРѕРІРµРЅСЊ Р·Р°РїРёСЃРё РІ Р¶СѓСЂРЅР°Р»Рµ РїРѕРґРєР»СЋС‡РµРЅРёСЏ MCP-СЃРµСЂРІРµСЂР°. */
export type McpLogLevel = 'info' | 'warn' | 'error'

/** РћРґРЅР° Р·Р°РїРёСЃСЊ Р¶СѓСЂРЅР°Р»Р° РїРѕРґРєР»СЋС‡РµРЅРёСЏ MCP-СЃРµСЂРІРµСЂР° (РґР»СЏ UI Р»РѕРі-РІСЊСЋРµСЂР°). */
export interface McpLogEntry {
  /** Unix ms. */
  ts: number
  level: McpLogLevel
  message: string
}

/** РџРѕР»РЅРѕРµ СЃРѕСЃС‚РѕСЏРЅРёРµ СЃРµСЂРІРµСЂР° РґР»СЏ UI (РєРѕРЅС„РёРі + runtime). */
export interface McpServerRuntime extends McpServerConfig {
  status: McpConnectionStatus
  error?: string
  tools: McpToolRuntime[]
  /** Per-tool СЃРѕСЃС‚РѕСЏРЅРёРµ, СЃРіСЂСѓРїРїРёСЂРѕРІР°РЅРЅРѕРµ РїРѕ РїРѕР»РЅРѕРјСѓ РёРјРµРЅРё С‚СѓР»Р°. */
  toolStates: Record<string, McpToolState>
  /** Timestamp РЅР°С‡Р°Р»Р° РїРѕСЃР»РµРґРЅРµР№ РїРѕРїС‹С‚РєРё РїРѕРґРєР»СЋС‡РµРЅРёСЏ (РґР»СЏ UI-С‚Р°Р№РјРµСЂР°). */
  connectStartedAt?: number
  /** Р–СѓСЂРЅР°Р» РїРѕРґРєР»СЋС‡РµРЅРёСЏ (С…СЂРѕРЅРѕР»РѕРіРёС‡РµСЃРєРё; РЅР°РєРѕРїРёС‚РµР»СЊРЅРѕ, cap РЅР° СЃС‚РѕСЂРѕРЅРµ main). */
  logs?: McpLogEntry[]
}

// в”Ђв”Ђв”Ђ Skills в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/** РСЃС‚РѕС‡РЅРёРє СЃРєРёР»Р»Р°. */
export type SkillSource = 'builtin' | 'user' | 'project'

/**
 * РЎРєРёР»Р» = markdown-РёРЅСЃС‚СЂСѓРєС†РёСЏ, РёРЅР¶РµРєС‚РёС‰Р°СЏСЃСЏ РІ system prompt РєРѕРіРґР° РІРєР»СЋС‡С‘РЅ.
 * Р—Р°РіСЂСѓР¶Р°РµС‚СЃСЏ РёР· .md-С„Р°Р№Р»Р° СЃ YAML frontmatter.
 */
export interface Skill {
  /** РЎС‚Р°Р±РёР»СЊРЅС‹Р№ id: source + ':' + РѕС‚РЅРѕСЃРёС‚РµР»СЊРЅС‹Р№ РїСѓС‚СЊ/РёРјСЏ. */
  id: string
  name: string
  description: string
  /** РўРµР»Рѕ С„Р°Р№Р»Р° (РёРЅСЃС‚СЂСѓРєС†РёРё) вЂ” РїРѕРїР°РґР°РµС‚ РІ system prompt. */
  instructions: string
  source: SkillSource
  /** РђР±СЃРѕР»СЋС‚РЅС‹Р№ РїСѓС‚СЊ Рє С„Р°Р№Р»Сѓ. */
  filePath: string
  /** Р”Р»СЏ РїСЂРѕРµРєС‚РЅС‹С… вЂ” id РїСЂРѕРµРєС‚Р°. */
  projectId?: string
  /** mtime С„Р°Р№Р»Р° РґР»СЏ РёРЅРІР°Р»РёРґР°С†РёРё РєСЌС€Р°. */
  mtimeMs: number
}

/** Per-skill СЃРѕСЃС‚РѕСЏРЅРёРµ (РІРєР»СЋС‡С‘РЅ + РѕР±Р»Р°СЃС‚СЊ РїСЂРёРјРµРЅРµРЅРёСЏ). */
export interface SkillState {
  enabled: boolean
  scope: ExtensionScope
}

// в”Ђв”Ђв”Ђ Marketplace (РєР°С‚Р°Р»РѕРі MCP-СЃРµСЂРІРµСЂРѕРІ Рё Skills) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/** РўСЂРµР±РѕРІР°РЅРёРµ Рє РїРµСЂРµРјРµРЅРЅРѕР№ РѕРєСЂСѓР¶РµРЅРёСЏ MCP-СЃРµСЂРІРµСЂР° (РёР· registry). */
export interface McpEnvVarRequirement {
  name: string
  description: string
  isRequired: boolean
  isSecret: boolean
}

/** РўСЂРµР±РѕРІР°РЅРёРµ Рє HTTP-Р·Р°РіРѕР»РѕРІРєСѓ СѓРґР°Р»С‘РЅРЅРѕРіРѕ MCP-СЃРµСЂРІРµСЂР°. */
export interface McpHeaderRequirement {
  name: string
  description: string
  isRequired: boolean
  isSecret: boolean
  value?: string
}

/** Р’Р°СЂРёР°РЅС‚ СѓСЃС‚Р°РЅРѕРІРєРё С‡РµСЂРµР· СѓРґР°Р»С‘РЅРЅС‹Р№ С‚СЂР°РЅСЃРїРѕСЂС‚ (sse / streamable-http). */
export interface McpRemoteOption {
  type: 'sse' | 'streamable-http'
  url: string
  headers?: McpHeaderRequirement[]
}

/** Р’Р°СЂРёР°РЅС‚ СѓСЃС‚Р°РЅРѕРІРєРё С‡РµСЂРµР· Р»РѕРєР°Р»СЊРЅС‹Р№ РїР°РєРµС‚ (stdio). */
export interface McpPackageOption {
  registryType: 'npm' | 'pypi' | 'oci'
  identifier: string
  version: string
  /** РџРѕРґСЃРєР°Р·РєР° РёСЃРїРѕР»РЅСЏРµРјРѕР№ СЃСЂРµРґС‹: 'npx' | 'uvx' | 'docker'. */
  runtimeHint?: string
  packageArguments?: string[]
  environmentVariables?: McpEnvVarRequirement[]
  /** РџРѕР·РёС†РёРѕРЅРЅС‹Рµ РїР°СЂР°РјРµС‚СЂС‹ РґР»СЏ GUI (РїСѓС‚Рё, СЃС‚СЂРѕРєРё РїРѕРґРєР»СЋС‡РµРЅРёСЏ Рё С‚.Рґ.). */
  positionalArgs?: Array<{
    label: string
    placeholder: string
    defaultValue?: string
    isRequired?: boolean
  }>
}

/** Р­Р»РµРјРµРЅС‚ РєР°С‚Р°Р»РѕРіР° MCP Registry РґР»СЏ РјР°СЂРєРµС‚РїР»РµР№СЃР°. */
export interface MarketplaceMcpServer {
  id: string
  title: string
  description: string
  version: string
  repositoryUrl?: string
  websiteUrl?: string
  iconUrl?: string
  remotes: McpRemoteOption[]
  packages: McpPackageOption[]
}

/** Р­Р»РµРјРµРЅС‚ РєР°С‚Р°Р»РѕРіР° Skills (GitHub-СЂРµРїРѕР·РёС‚РѕСЂРёР№) РґР»СЏ РјР°СЂРєРµС‚РїР»РµР№СЃР°. */
export interface MarketplaceSkill {
  id: string
  name: string
  fullName: string
  description: string
  htmlUrl: string
  stars: number
  language: string | null
  topics: string[]
  license: string | null
  updatedAt: string
}

/** РџРѕР»СЊР·РѕРІР°С‚РµР»СЊСЃРєР°СЏ РєР°СЃС‚РѕРјРЅР°СЏ С‚РµРјР° (РїРѕР»РЅС‹Р№ СЂРµРґР°РєС‚РѕСЂ РІ РЅР°СЃС‚СЂРѕР№РєР°С…). */
export interface CustomTheme {
  id: string
  name: string
  base: 'light' | 'dark'
  colors: {
    bodyBg: string
    bgPrimary: string
    bgSecondary: string
    bgTertiary: string
    textPrimary: string
    textSecondary: string
    textMuted: string
    accent: string
    sidebarBg: string
  }
  glass: {
    blur: number
    saturate: number
    opacity: number
  }
}

// ── Client auto-update (SynteeHelper desktop) ────────────────────────────
// Mirrors the manifest returned by GET /api/public/updates/check on the
// gateway. The launcher (syntee-launcher, Go) does the actual download+apply;
// this in-app checker only displays UI and triggers quitAndInstall().

export interface UpdateManifest {
  version: string
  channel: string
  zip_url: string
  zip_size: number
  sha256: string
  force: boolean
  min_version: string | null
  changelog: string | null
  released_at: string
}

export interface ChangelogEntry {
  version: string
  changelog: string | null
  released_at: string
  force: boolean
  is_current: boolean
}

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'no-update' | 'error'

export interface UpdateState {
  status: UpdateStatus
  available: UpdateManifest | null
  dismissed: string[]
  lastCheckedAt: number
  error: string | null
}

/**
 * Result of the quit-and-install flow (updates:quitAndInstall IPC). When
 * ok=false the app did NOT exit and the updater never started — the UI shows
 * `error` and lets the user retry instead of dying silently.
 */
export interface QuitAndInstallResult {
  ok: boolean
  error?: string
}