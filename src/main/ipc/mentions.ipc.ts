/**
 * IPC для @mention-пикера и вложений.
 *
 * Каналы:
 *   mentions:search       — поиск по files + chats + projects + skills +
 *                           commands (плоский список).
 *                           Параметр: { workdir?, query, limit?, chatId? }.
 *   mentions:startIndexing — запустить file indexer для workdir.
 *   mentions:stopIndexing  — остановить.
 *
 *   attachments:readFile  — прочитать текстовый файл для инлайна в content.
 *                           Параметр: { path }. Возвращает { content, mime, size, error? }.
 *   attachments:saveImageFromBase64 — сохранить pasted/dropped картинку в
 *                           userData/draft-attachments/{chatId}/ и вернуть путь.
 *   attachments:saveFileFromPath — скопировать произвольный файл с диска в
 *                           userData/draft-attachments/{chatId}/ (для drag&drop
 *                           файлов не из workdir). Возвращает путь.
 *   attachments:deleteFile — удалить файл вложения из userData.
 *   attachments:pickFile  — native dialog Electron (кнопка «Прикрепить файл»).
 *
 *   draft:getAttachments  — получить вложения черновика чата.
 *   draft:setAttachments  — заменить все вложения черновика (debounce в renderer).
 *   draft:clearAttachments — очистить после отправки.
 */
import { ipcMain, app, dialog } from 'electron'
import { join, basename, extname, resolve as pathResolve } from 'path'
import { readFile, mkdir, writeFile, unlink, stat, copyFile } from 'fs/promises'
import { existsSync, readdirSync, statSync, unlinkSync } from 'fs'
import { getSkillManager } from '../../core/skills/skillManager'
import { getCommandManager } from '../../core/commands/commandManager'
import {
  startIndexing, stopIndexing, searchFiles, getRecentFiles, isIndexReady,
} from '../../core/mentions/fileIndexer'
import {
  getDraftAttachments, setDraftAttachments, clearDraftAttachments,
  getAllChats, getAllProjects,
} from '../../core/db'
import { getMessages } from '../../core/db/messages'
import type { MentionItem, Attachment } from '../../shared/types'
import { filterMentions, isTextMime, mimeFromExt } from '../../shared/mentions'
import { stripAttachTokens } from '../../shared/attachmentMarkdown'

// ── Лимиты ───────────────────────────────────────────────────────────────────
const MAX_TEXT_INLINE_BYTES = 5 * 1024 * 1024  // 5МБ
const MAX_IMAGE_BYTES = 10 * 1024 * 1024       // 10МБ
const MAX_ATTACHMENTS = 10

function draftDir(chatId: string): string {
  return join(app.getPath('userData'), 'draft-attachments', chatId)
}

/**
 * Удаление осиротевших файлов черновика чата (общая логика).
 *
 * Отправленные сообщения ссылаются на файлы в draft-attachments/{chatId}/
 * (message.attachments хранит пути копий) — удалять «все не из текущей
 * отправки» НЕЛЬЗЯ, сломаются превью старых сообщений. Поэтому: собираем
 * пути из attachments ВСЕХ сообщений чата (БД) + extraKeepPaths (пути
 * вложений отправок, которые ещё стоят в очереди — их user-сообщения
 * ещё не сохранены в БД) и удаляем только файлы черновика, на которые
 * никто не ссылается.
 *
 * Вызывается из IPC-хендлера attachments:cleanupOrphans и из runChatSend
 * (chat.ipc.ts) — СТРОГО ПОСЛЕ saveMessage(userMsg), чтобы пути текущей
 * отправки уже были в БД и не попали под удаление.
 *
 * Защитный пояс: файлы младше 2 минут не трогаем — страховка от любых
 * рассинхронов БД/диска (файл мог быть прикреплён к сообщению, которое
 * ещё обрабатывается). Такие файлы подчистит следующая очистка.
 */
export function cleanupOrphanDraftFiles(
  chatId: string,
  extraKeepPaths: string[] = [],
): { ok: boolean; removed: number } {
  chatId = String(chatId ?? '')
  if (!chatId) return { ok: false, removed: 0 }
  const dir = draftDir(chatId)
  if (!existsSync(dir)) return { ok: true, removed: 0 }
  // Пути, на которые ссылаются сообщения чата + явные keep-пути.
  const keep = new Set<string>()
  for (const p of extraKeepPaths) {
    if (p) keep.add(pathResolve(p).toLowerCase())
  }
  try {
    for (const m of getMessages(chatId)) {
      for (const a of (m.attachments ?? []) as Attachment[]) {
        if (a?.path) keep.add(pathResolve(a.path).toLowerCase())
      }
    }
  } catch { /* БД недоступна — ничего не удаляем (безопаснее) */ return { ok: true, removed: 0 } }
  let removed = 0
  try {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f)
      try {
        if (!statSync(full).isFile()) continue
        if (keep.has(pathResolve(full).toLowerCase())) continue
        // Свежие файлы не трогаем (см. защитный пояс в доке функции).
        if (Date.now() - statSync(full).mtimeMs < 120_000) continue
        unlinkSync(full)
        removed++
      } catch { /* занят/пропал — оставляем */ }
    }
  } catch { /* ignore */ }
  return { ok: true, removed }
}

/** Собирает скиллы + команды в плоский MentionItem[] для @пикера. */
function collectInternalItems(workdir?: string): MentionItem[] {
  const items: MentionItem[] = []

  // Скиллы
  try {
    const mgr = getSkillManager()
    const skills = mgr.getAllWithState({ projectWorkdir: workdir })
    for (const s of skills) {
      items.push({
        id: `skill:${s.id}`,
        type: 'skill',
        label: s.name,
        description: s.description,
        skillId: s.id,
      })
    }
  } catch { /* skillManager ещё не инициализирован */ }

  // Кастомные команды (.md из .syntee/commands, userData/commands, resources/commands)
  try {
    const cmds = getCommandManager().getAllForUI({ projectWorkdir: workdir })
    for (const c of cmds) {
      items.push({
        id: `command:${c.name}`,
        type: 'command',
        label: c.label || `/${c.name}`,
        description: c.description,
        commandName: c.name,
      })
    }
  } catch { /* commandManager ещё не инициализирован */ }

  return items
}

/** Превью текста для второй строки дропдауна: без токенов вложений,
 *  без переносов, обрезано. */
function previewText(text: string | undefined, max = 90): string {
  if (!text) return ''
  const clean = stripAttachTokens(text).replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

/**
 * Чаты из БД для @пикера. Исключаем: текущий чат (ссылка на себя бессмысленна),
 * архивные (скрыты в сайдбаре), пустые (messageCount 0 — референсить нечего).
 */
function collectChatItems(currentChatId?: string): MentionItem[] {
  try {
    return getAllChats()
      .filter(c => c.id !== currentChatId && !c.isArchived && (c.messageCount ?? 0) > 0)
      .map(c => ({
        id: `chat:${c.id}`,
        type: 'chat' as const,
        label: c.title || 'Без названия',
        description: previewText(c.lastMessage) || `${c.messageCount} сообщений`,
        chatId: c.id,
        mtime: c.updatedAt,
      }))
  } catch { /* БД недоступна */ return [] }
}

/** Проекты из БД для @пикера — имя + workdir. */
function collectProjectItems(): MentionItem[] {
  try {
    return getAllProjects().map(p => ({
      id: `project:${p.id}`,
      type: 'project' as const,
      label: p.name,
      description: p.workdir,
      projectId: p.id,
      mtime: p.lastUsed,
    }))
  } catch { /* БД недоступна */ return [] }
}

export function registerMentionsIPC(): void {
  // ── mentions:search — главный канал для @пикера ───────────────────────────
  // Возвращает плоский MentionItem[]: файлы проекта (если workdir) + чаты +
  // проекты + скиллы + команды, отфильтрованные через filterMentions.
  // При пустом query — недавние файлы + недавние чаты + проекты + скиллы/команды.
  // currentChatId исключается из списка чатов (ссылка на себя не нужна).
  ipcMain.handle('mentions:search', async (_e, params: { workdir?: string; query: string; limit?: number; chatId?: string }) => {
    const { workdir, query = '', limit = 30, chatId } = params
    const chatItems = collectChatItems(chatId)
    const projectItems = collectProjectItems()

    // 1. Файлы проекта (если workdir и индекс готов)
    let fileItems: MentionItem[] = []
    if (workdir) {
      if (!isIndexReady(workdir)) {
        // Запускаем индексацию в фоне — при следующем вызове будет готов
        void startIndexing(workdir)
      }
      fileItems = query
        ? searchFiles(workdir, query, limit)
        : getRecentFiles(workdir, Math.min(limit, 12))
    }

    // 2. Скиллы + команды (всегда — они маленькие списки)
    const internalItems = collectInternalItems(workdir)

    // 3. Собираем и сортируем общий список
    if (!query) {
      // Без query: недавние файлы → недавние чаты (6) → проекты (4) → скиллы/команды.
      // Файлы урезаны до 12, чтобы чаты/проекты попадали в лимит 30.
      return [
        ...fileItems,
        ...chatItems.slice(0, 6),
        ...projectItems.slice(0, 4),
        ...internalItems,
      ].slice(0, limit)
    }
    return filterMentions(query, [...fileItems, ...chatItems, ...projectItems, ...internalItems], limit)
  })

  // ── mentions:startIndexing — запустить индексацию workdir ─────────────────
  ipcMain.handle('mentions:startIndexing', async (_e, workdir: string) => {
    if (!workdir) return false
    void startIndexing(workdir)
    return true
  })

  // ── mentions:stopIndexing — остановить индексацию ─────────────────────────
  ipcMain.handle('mentions:stopIndexing', async (_e, workdir: string) => {
    if (!workdir) return false
    await stopIndexing(workdir)
    return true
  })

  // ── attachments:readFile — прочитать файл для инлайна в content ───────────
  // Только текстовые файлы. Бинарные возвращает { isBinary: true } — для них
  // в content попадёт только путь+имя. Картинки — отдельный путь (vision Phase 2).
  ipcMain.handle('attachments:readFile', async (_e, params: { path: string }) => {
    const { path } = params
    if (!path) return { success: false, error: 'path is required' }
    try {
      const st = await stat(path)
      if (st.isDirectory()) return { success: false, error: 'Is a directory' }
      const mime = mimeFromExt(path)
      if (!isTextMime(mime)) {
        return { success: true, content: '', mime, size: st.size, isBinary: true }
      }
      if (st.size > MAX_TEXT_INLINE_BYTES) {
        return { success: false, error: `File too large (${(st.size / 1024 / 1024).toFixed(1)} MB). Max 5 MB.` }
      }
      const content = await readFile(path, 'utf-8')
      return { success: true, content, mime, size: st.size, isBinary: false }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── attachments:saveImageFromBase64 — paste/drag&drop картинки ────────────
  // Сохраняет base64-картинку в userData/draft-attachments/{chatId}/{uuid}.ext
  // Возвращает { path, name, size, mime }. Файл удаляется при удалении чипа
  // (attachments:deleteFile) или после отправки (если не нужно сохранять).
  ipcMain.handle('attachments:saveImageFromBase64', async (_e, params: {
    chatId: string
    base64: string
    mime?: string
    suggestedName?: string
  }) => {
    const { chatId, base64 } = params
    if (!chatId || !base64) return { success: false, error: 'chatId and base64 required' }
    try {
      const dir = draftDir(chatId)
      await mkdir(dir, { recursive: true })
      // Определяем расширение по mime
      const mime = params.mime || 'image/png'
      const ext = mime === 'image/jpeg' ? '.jpg'
        : mime === 'image/gif' ? '.gif'
        : mime === 'image/webp' ? '.webp'
        : mime === 'image/bmp' ? '.bmp'
        : mime === 'image/svg+xml' ? '.svg'
        : '.png'
      const baseName = params.suggestedName || `image-${Date.now()}`
      // Защита от коллизии: если файл с таким именем уже есть (две картинки
      // с одинаковым именем при drag&drop/paste) — добавляем счётчик.
      // Без этого второй файл перезапишет первый, и оба attachment будут
      // указывать на один файл (виден только последний).
      let name = baseName + ext
      let dest = join(dir, name)
      let counter = 1
      while (existsSync(dest)) {
        name = `${baseName}-${counter}${ext}`
        dest = join(dir, name)
        counter++
      }
      // Очищаем data:URL prefix если есть
      const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '')
      const buf = Buffer.from(cleanBase64, 'base64')
      if (buf.length > MAX_IMAGE_BYTES) {
        return { success: false, error: `Image too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Max 10 MB.` }
      }
      await writeFile(dest, buf)
      return { success: true, path: dest, name, size: buf.length, mime }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── attachments:saveFileFromPath — копирует файл с диска в draft-attachments ─
  // Для drag&drop файлов не из workdir (чтобы пережили рестарт и не зависели
  // от исходного пути). Для файлов из workdir — НЕ копируем, храним только path.
  ipcMain.handle('attachments:saveFileFromPath', async (_e, params: {
    chatId: string
    sourcePath: string
  }) => {
    const { chatId, sourcePath } = params
    if (!chatId || !sourcePath) return { success: false, error: 'chatId and sourcePath required' }
    try {
      const st = await stat(sourcePath)
      if (st.isDirectory()) return { success: false, error: 'Is a directory', isDirectory: true }
      const dir = draftDir(chatId)
      await mkdir(dir, { recursive: true })
      const name = basename(sourcePath)
      // Уникальное имя если уже есть
      let dest = join(dir, name)
      let counter = 1
      while (existsSync(dest)) {
        const ext = extname(name)
        const base = name.slice(0, name.length - ext.length)
        dest = join(dir, `${base}-${counter}${ext}`)
        counter++
      }
      await copyFile(sourcePath, dest)
      return { success: true, path: dest, name: basename(dest), size: st.size, mime: mimeFromExt(name) }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── attachments:deleteFile — удалить файл вложения из userData ────────────
  // Безопасно: удаляем только из draft-attachments директории.
  ipcMain.handle('attachments:deleteFile', async (_e, params: { path: string }) => {
    const { path } = params
    if (!path) return false
    const allowedRoot = join(app.getPath('userData'), 'draft-attachments')
    if (!path.startsWith(allowedRoot)) return false // защита от path traversal
    try {
      await unlink(path)
      return true
    } catch {
      return false
    }
  })

  // ── attachments:pickFile — native dialog Electron ─────────────────────────
  // Кнопка «Прикрепить файл» в +меню. Открывает нативный файл-пикер.
  // Возвращает массив выбранных путей (или пустой массив при отмене).
  ipcMain.handle('attachments:pickFile', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        title: 'Прикрепить файлы',
      })
      return result.filePaths
    } catch {
      return []
    }
  })

  // ── attachments:resolveDropPath — прямой путь из drag&drop ────────────────
  // File.path удалён в Electron 32+; webUtils.getPathForFile может вернуть
  // ошибку/пусто для некоторых источников (сетевые диски, виртуальные ФС).
  // Резолвим путь на стороне main: имя файла из drop-события + файл должен
  // существовать на диске. Возвращает { path, name, mime, size } или null.
  // Если foundName === false — имя не совпало (одна папка, несколько файлов
  // с одинаковым именем) → renderer не угадал, пусть юзер прикрепит через диалог.
  ipcMain.handle('attachments:resolveDropPath', (_e, params: { name: string; dir?: string }) => {
    const name = String(params?.name ?? '').trim()
    if (!name) return { ok: false as const, error: 'name required' }
    const candidates: string[] = []
    if (params.dir) {
      const dir = String(params.dir)
      const resolved = pathResolve(dir)
      // Не уходим выше корня файловой системы (path traversal не проблема
      // здесь — это read-only stat, но держим путь вменяемым).
      if (resolved.length > 3) candidates.push(join(resolved, name))
    }
    // Fallback: стандартные папки пользователя (Downloads/Desktop/Documents).
    for (const sub of ['Downloads', 'Desktop', 'Documents']) {
      candidates.push(join(app.getPath('home'), sub, name))
    }
    for (const c of candidates) {
      try {
        const resolved = pathResolve(c)
        if (!resolved.toLowerCase().endsWith(name.toLowerCase())) continue
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { statSync } = require('fs') as typeof import('fs')
        const st = statSync(resolved)
        if (st.isFile()) {
          return {
            ok: true as const,
            foundName: true,
            path: resolved,
            name,
            mime: mimeFromExt(name),
            size: st.size,
          }
        }
      } catch { /* не существует — следующий кандидат */ }
    }
    return { ok: true as const, foundName: false }
  })

  // ── attachments:repairDraft — самолечение draft-вложений с битым path ─────
  // Вложение из БД указывает на файл, которого нет на диске (копия удалена
  // cleanup'ом, файл переименован). Для каждого битого ищем в папке черновика
  // чата файл с тем же базовым именем (счётчик -1/-2 от коллизий имён) и
  // восстанавливаем путь. Возвращает исправленный массив (или исходный).
  ipcMain.handle('attachments:repairDraft', (_e, params: { chatId: string; attachments: Attachment[] }) => {
    const chatId = String(params?.chatId ?? '')
    const atts = Array.isArray(params?.attachments) ? params.attachments : []
    if (!chatId || atts.length === 0) return atts
    const dir = draftDir(chatId)
    if (!existsSync(dir)) return atts
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readdirSync, statSync } = require('fs') as typeof import('fs')
    let changed = false
    const out = atts.map(a => {
      if ((a.kind !== 'file' && a.kind !== 'image') || !a.path) return a
      if (existsSync(a.path)) return a
      // Файла нет — ищем в папке черновика по базовому имени.
      const base = a.name.replace(/\.[^.]+$/, '').toLowerCase()
      let matches: string[] = []
      try {
        matches = readdirSync(dir).filter(f => {
          if (!f.toLowerCase().startsWith(base)) return false
          try { return statSync(join(dir, f)).isFile() } catch { return false }
        })
      } catch { return a }
      if (matches.length === 0) return a
      changed = true
      // Последний матч — свежая копия (счётчик растёт).
      return { ...a, path: join(dir, matches[matches.length - 1]) }
    })
    return changed ? out : atts
  })

  // ── attachments:cleanupOrphans — удаление осиротевших черновиков ──────────
  // Логика в cleanupOrphanDraftFiles (общая с runChatSend в chat.ipc.ts):
  // keep-сет из attachments всех сообщений чата (БД), удаляем только файлы
  // черновика, на которые не ссылается ни одно сообщение. ВАЖНО: из renderer
  // при отправке этот хендлер больше НЕ вызывается (удалял свежие вложения
  // до их сохранения в БД) — очистка выполняется в main после saveMessage.
  ipcMain.handle('attachments:cleanupOrphans', (_e, params: { chatId: string }) => {
    return cleanupOrphanDraftFiles(params?.chatId)
  })

  // ── draft:getAttachments — вложения черновика чата ────────────────────────
  ipcMain.handle('draft:getAttachments', (_, chatId: string) => {
    if (!chatId) return []
    return getDraftAttachments(chatId)
  })

  // ── draft:setAttachments — заменить все вложения черновика ────────────────
  // Вызывается при каждом изменении набора чипов над инпутом (debounce в renderer).
  ipcMain.handle('draft:setAttachments', (_, chatId: string, attachments: Attachment[]) => {
    if (!chatId) return false
    // Лимит — не больше MAX_ATTACHMENTS
    const limited = attachments.slice(0, MAX_ATTACHMENTS)
    setDraftAttachments(chatId, limited)
    return true
  })

  // ── draft:clearAttachments — очистить после отправки ──────────────────────
  ipcMain.handle('draft:clearAttachments', (_, chatId: string) => {
    if (!chatId) return false
    clearDraftAttachments(chatId)
    return true
  })
}

/** Останавливает все индексы — вызывается при выходе из приложения. */
export async function shutdownMentions(): Promise<void> {
  // stopAllIndexing экспортируется из fileIndexer
  const { stopAllIndexing } = await import('../../core/mentions/fileIndexer')
  await stopAllIndexing()
}
