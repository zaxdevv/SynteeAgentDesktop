// ── Attachments & Mentions ───────────────────────────────────────────────
// Attachment — прикреплённый файл/изображение к сообщению. Может прийти из:
//   1. @mention-пикера (files проекта, skills, commands)
//   2. Drag&Drop из проводника в инпут
//   3. Paste изображения из буфера обмена (Ctrl+V)
//   4. Кнопки «Прикрепить файл» (native dialog Electron)
//
// Текстовые файлы инлайнятся в content при отправке (main-процесс).
// Изображения в Phase 1 передаются только как путь+имя (vision — Phase 2).
// Бинарные файлы — только путь+имя без содержимого.

/** Тип вложения по источнику/способу добавления.
 *  'chat' — ссылка на другой чат (@пикер; инлайнится в контекст как
 *           summary + последние сообщения, клик в чате → переход в чат).
 *  'project' — ссылка на проект (@пикер; инлайнится имя+workdir+контекст,
 *           клик → переход в последний чат проекта). */
export type AttachmentKind = 'file' | 'image' | 'skill' | 'command' | 'chat' | 'project'

/** Источник прикрепления (для UI-бейджа и логирования).
 *  'reply' — вложение пришло из реплайнутого сообщения (дублируется в
 *  отправку, чтобы AI видел файлы/картинки исходного сообщения). */
export type AttachmentSource = 'mention' | 'dragdrop' | 'paste' | 'dialog' | 'reply'

/**
 * Attachment — прикреплённый к сообщению файл/изображение/сущность.
 *
 * Поля:
 *  - id: уникальный идентификатор (uuid) для key в React + удаления из draft.
 *  - kind: 'file' | 'image' | 'skill' | 'command' — определяет рендер чипа.
 *  - name: отображаемое имя (basename для файлов, label для skill/command).
 *  - path: абсолютный путь к файлу (для file/image). undefined для skill/command.
 *  - relPath: относительный путь от workdir (для отображения в tooltip).
 *  - mime: MIME-тип (для image — image/png и т.д.; для text — text/plain).
 *  - size: размер файла в байтах (для лимитов и отображения).
 *  - source: способ добавления (mention/dragdrop/paste/dialog).
 *  - dataUrl: data: URL для изображений из paste/dragdrop (когда файл ещё не
 *    сохранён на диск). После сохранения в userData — заменяется на path.
 *  - skillId / commandName: для kind='skill'/'command' — идентификатор сущности.
 *  - chatId / projectId: для kind='chat'/'project' — ссылка на сущность
 *    (path у них нет — файловой привязки нет).
 *  - snippet: краткий preview содержимого (первые ~200 символов) для tooltip.
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
  /** ID чата (для kind='chat') — ссылка на другой чат. */
  chatId?: string
  /** ID проекта (для kind='project') — ссылка на проект. */
  projectId?: string
  snippet?: string
  /** Время прикрепления (для сортировки недавних в @-пикере). */
  attachedAt: number
}

/**
 * Результат обработки вложений для AttachmentProcessingBlock.
 *
 * Заполняется в main-процессе (processAttachmentsAndStream) и сохраняется
 * в message.attachmentResult для отображения после рестарта. Live-стриминг
 * идёт через toolProgress['process_attachments'] с полями {stage, detail,
 * filesProcessed, filesTotal}.
 *
 * Структура как у FastContextResultData — files[], summary, ms.
 */
export interface AttachmentProcessingFile {
  name: string
  kind: string
  status: 'text_inlined' | 'image_described' | 'binary_path' | 'error' | 'skipped'
  size?: number
  detail?: string
  /** Для image_described — краткое описание (первые ~200 символов). */
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
 * MentionItem — элемент плоского списка в @-дропдауне.
 *
 * types: 'file' | 'image' | 'skill' | 'command' | 'chat' | 'project' —
 *  соответствует AttachmentKind, но 'image' выделен отдельно чтобы в
 *  @-пикере показывать картинки с диска (даже если они вне workdir) с превью.
 *  'chat'/'project' — ссылки на сущности приложения (не файлы).
 *
 * Сортировка в filterMentions: точные совпадения по имени → недавние → остальные.
 */
export type MentionItemType = 'file' | 'image' | 'skill' | 'command' | 'chat' | 'project'

export interface MentionItem {
  id: string
  type: MentionItemType
  label: string
  /** Краткое описание/путь для второй строки в дропдауне. */
  description?: string
  /** Абсолютный путь (для file/image). */
  path?: string
  /** Относительный путь от workdir. */
  relPath?: string
  /** id скилла (для type='skill'). */
  skillId?: string
  /** Имя команды (для type='command'). */
  commandName?: string
  /** ID чата (для type='chat'). */
  chatId?: string
  /** ID проекта (для type='project'). */
  projectId?: string
  /** MIME-тип (для image — чтобы решить, превью или иконку). */
  mime?: string
  /** Размер файла (для отображения и лимитов). */
  size?: number
  /** mtime файла (для сортировки недавних). */
  mtime?: number
  /** Количество упоминаний в этом чате (для буста в fuzzy). */
  useCount?: number
}
