/* eslint-disable react-hooks/set-state-in-effect */
// ── ChatFilesPopover — «Файлы, упомянутые в чате» ────────────────────────
//
// Авто-собирает все пути из сообщений диалога (user + AI) и показывает их
// компактной пилюлей в правом верхнем углу чата. Клик → список с иконками
// и счётчиком упоминаний; клик по строке → открытие (правая панель /
// Проводник — общий openFilePath).
//
// ГЛАВНОЕ: показываются ТОЛЬКО пути, существующие на диске (pathStatus).
// Regex в естественном тексте неизбежно ловит мусор (regex-флаги «/g»,
// HTML-теги «</div>», прозу «client/server», примеры из объяснений AI) —
// всё это не существует на диске и отфильтровывается. Арбитр — ФС.
//
// Оптимизация:
// - список пересчитывается по дешёвой сигнатуре (число сообщений + id
//   последнего), а не по identity массива — иначе каждый токен стрима
//   ре-парсил бы все сообщения;
// - PATH_RE-скан только у сообщений, содержащих / или \;
// - stat-проверки дедуплицированы pathStatus-кэшем (один IPC на уникальный
//   путь за сессию), подписка ре-рендерит список только при изменении статуса.

import { memo, useEffect, useMemo, useState } from 'react'
import FileIcon from '../FileIcon/FileIcon'
import { PATH_RE, isValidPathMatch, splitPathLine, resolveFilePath, normalizePath } from '../../../utils/remarkFilePaths'
import { openFilePath } from '../../../utils/openFilePath'
import { getPathStatus, subscribePathStatus, usePathStatus } from '../../../utils/pathStatus'
import { ATTACH_TOKEN_RE } from '../../../../../shared/attachmentMarkdown'
import type { Message } from '../../../../../shared/types'
import './ChatFilesPopover.css'

interface ChatFilesPopoverProps {
  messages: Message[]
  workdir?: string | null
}

interface MentionedFile {
  /** Путь без :строки */
  path: string
  /** Число упоминаний */
  count: number
  /** Последний полный текст (с суффиксом :42) — для перехода к строке */
  lastRaw: string
}

const MAX_FILES = 60

function collectFiles(messages: Message[]): MentionedFile[] {
  const map = new Map<string, MentionedFile>()
  for (const msg of messages) {
    const raw = typeof msg.content === 'string' ? msg.content : ''
    if (!raw || (!raw.includes('/') && !raw.includes('\\'))) continue
    // Токены вложений не считаем — они рендерятся чипами отдельно
    const text = raw.replace(ATTACH_TOKEN_RE, ' ')
    for (const m of text.matchAll(PATH_RE)) {
      const full = m[1]
      if (!isValidPathMatch(full)) continue
      const { path } = splitPathLine(full)
      const prev = map.get(path)
      if (prev) {
        prev.count++
        prev.lastRaw = full
      } else {
        map.set(path, { path, count: 1, lastRaw: full })
      }
    }
  }
  // Без cap: существование фильтруется ДО обрезки, иначе мусор с высоким
  // счётчиком (примеры AI ×12) вытесняет реальные файлы из топа
  return [...map.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
}

// ── Фильтр по существованию: только реальные пути ────────────────────────
// Триггерит stat-проверки (дедуп через кэш) и пересобирает список при
// изменении любого статуса. Синхронный пересчёт в effect нужен для уже
// закэшированных статусов (re-mount поповера).
function useExistingFiles(files: MentionedFile[], workdir?: string | null): MentionedFile[] {
  const [existing, setExisting] = useState<MentionedFile[]>([])
  useEffect(() => {
    if (files.length === 0) {
      setExisting([])
      return
    }
    const wd = workdir || undefined
    const absList = files.map(f => normalizePath(resolveFilePath(f.path, wd)))
    for (const abs of absList) getPathStatus(abs) // запускает проверку, если нет в кэше
    setExisting(files.filter((_f, i) => getPathStatus(absList[i]).status === 'exists'))
    const recompute = () => {
      setExisting(files.filter((_f, i) => getPathStatus(absList[i]).status === 'exists'))
    }
    const unsubs = absList.map(abs => subscribePathStatus(abs, recompute))
    return () => { for (const u of unsubs) u() }
  }, [files, workdir])
  return existing
}

// ── Строка списка: иконка (папка/файл) + путь + счётчик ──────────────────
// isDir берём из pathStatus-кэша (проверки уже сделаны useExistingFiles —
// здесь только чтение, без новых IPC).
const FileRow = memo(function FileRow({ file, workdir }: { file: MentionedFile; workdir?: string | null }) {
  const isAbs = /^[a-zA-Z]:[\\/]/.test(file.path) || file.path.startsWith('/') || file.path.startsWith('~')
  const resolved = useMemo(
    () => (isAbs || workdir ? normalizePath(resolveFilePath(file.path, workdir || undefined)) : undefined),
    [file.path, isAbs, workdir],
  )
  const status = usePathStatus(resolved)
  const isDir = status.status === 'exists' && !!status.isDir
  return (
    <button
      className="chat-files__row"
      onClick={() => { void openFilePath(file.lastRaw, workdir || undefined) }}
      title={file.path}
    >
      <span className="chat-files__row-icon">
        {isDir ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'color-mix(in srgb, var(--accent) 75%, var(--text-primary))' }}>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        ) : (
          <FileIcon name={file.path.split('/').pop() || file.path} size={14} />
        )}
      </span>
      <span className="chat-files__row-path">{file.path}</span>
      {file.count > 1 && <span className="chat-files__row-count">×{file.count}</span>}
    </button>
  )
})

const ChatFilesPopover = memo(function ChatFilesPopover({ messages, workdir }: ChatFilesPopoverProps) {
  const [open, setOpen] = useState(false)

  // Дешёвая сигнатура: identity messages меняется на каждый чанк стрима,
  // а содержимое путей — только при новом сообщении/правке
  const sig = `${messages.length}:${messages[messages.length - 1]?.id ?? ''}:${workdir ?? ''}`
  const files = useMemo(
    () => collectFiles(messages),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig],
  )
  const existing = useExistingFiles(files, workdir)
  const shown = useMemo(() => existing.slice(0, MAX_FILES), [existing])

  if (shown.length === 0) return null

  return (
    <div className={`chat-files${open ? ' chat-files--open' : ''}`}>
      <button
        className="chat-files__pill"
        onClick={() => setOpen(v => !v)}
        title="Файлы, упомянутые в этом чате"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span>{shown.length}</span>
      </button>
      {open && (
        <div className="chat-files__popover">
          <div className="chat-files__header">Файлы в чате</div>
          <div className="chat-files__list">
            {shown.map(f => (
              <FileRow key={f.path} file={f} workdir={workdir} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
})

export default ChatFilesPopover
