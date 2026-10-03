import { useState, memo } from 'react'
// PrismLight вместо полного Prism (~270 грамматик): языки регистрируются
// в MessageBubble.tsx (общий singleton). Здесь дорегистрируем те, что
// нужны только тул-выводам (getLanguage ниже может их вернуть).
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml'
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss'
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell'
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql'
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker'
import type { ToolStep } from './ToolChain'
import type { ToolOutputMode } from '../../../../../shared/types'
import { copyToClipboard } from '../../../utils/clipboard'
import { tabActions } from '../../../store/tabs.store'
import { useNavStore } from '../../../store/nav.store'
import './ToolResultRenderer.css'

// registerLanguage идемпотентен для нашего случая (перезапись тем же набором).
SyntaxHighlighter.registerLanguage('toml', toml)
SyntaxHighlighter.registerLanguage('scss', scss)
SyntaxHighlighter.registerLanguage('powershell', powershell)
SyntaxHighlighter.registerLanguage('graphql', graphql)
SyntaxHighlighter.registerLanguage('docker', docker)

// ── Утилиты ────────────────────────────────────────────────────────────────

function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    css: 'css', scss: 'scss', html: 'html', xml: 'xml',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
    md: 'markdown', sql: 'sql', graphql: 'graphql',
    env: 'bash', dockerfile: 'docker',
  }
  return map[ext] || 'text'
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text, truncated: false }
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true }
}

function tryParseJSON(text: string): unknown | null {
  try { return JSON.parse(text) } catch { return null }
}

// ── Прогрессивное раскрытие («Показать ещё») ────────────────────────────────
// Вместо «60 строк или всё целиком (9999)» — чанки: начальный кап + кнопка
// «Показать ещё N». Длинные выводы не монтируют тысячи DOM-узлов и не
// токенизируются Prism'ом целиком при раскрытии тулчейна/скролле.
// Паттерн `extra`-state: visible = initialLines + extra → при смене режима
// (normal↔detailed) видимое окно подстраивается без сброса state.

const CODE_CHUNK = 60

// ── Суб-рендеры ────────────────────────────────────────────────────────────

const CodeResult = memo(function CodeResult({ content, lang, initialLines }: { content: string; lang: string; initialLines: number }) {
  const [extra, setExtra] = useState(0)
  const visible = initialLines + extra
  const total = content.split('\n').length
  const { text, truncated } = truncateLines(content, visible)
  return (
    <div className="trr-code-wrap">
      <SyntaxHighlighter
        language={lang}
        style={oneDark}
        customStyle={{ margin: 0, borderRadius: 8, fontSize: 12, maxHeight: 400, overflow: 'auto' }}
        showLineNumbers={total > 3}
      >
        {text}
      </SyntaxHighlighter>
      {truncated && (
        <button className="trr-expand-btn" onClick={() => setExtra(e => e + CODE_CHUNK)}>
          Показать ещё {Math.min(CODE_CHUNK, total - visible)} из {total} строк
        </button>
      )}
    </div>
  )
}, (prev, next) => prev.content === next.content && prev.lang === next.lang && prev.initialLines === next.initialLines)

const TerminalResult = memo(function TerminalResult({ content, initialLines }: { content: string; initialLines: number }) {
  const [extra, setExtra] = useState(0)
  const visible = initialLines + extra
  const trimmed = content.trim()
  const total = trimmed.split('\n').length
  const { text, truncated } = truncateLines(trimmed, visible)
  return (
    <div className="trr-terminal">
      <pre className="trr-terminal-pre">{text}</pre>
      {truncated && (
        <button className="trr-expand-btn" onClick={() => setExtra(e => e + CODE_CHUNK)}>
          Показать ещё {Math.min(CODE_CHUNK, total - visible)} из {total} строк
        </button>
      )}
    </div>
  )
}, (prev, next) => prev.content === next.content && prev.initialLines === next.initialLines)

const FILELIST_CHUNK = 200

const FileListResult = memo(function FileListResult({ content }: { content: string }) {
  const [extra, setExtra] = useState(0)
  const visible = FILELIST_CHUNK + extra
  const lines = content.split('\n').filter(l => l.trim())
  const shown = lines.slice(0, visible)
  return (
    <div className="trr-filelist">
      {shown.map((line, i) => {
        const isDir = line.endsWith('/') || line.endsWith('\\') || !line.includes('.')
        return (
          <div key={i} className="trr-filelist-item">
            <span className="trr-filelist-icon">{isDir ? '📁' : '📄'}</span>
            <span className="trr-filelist-name">{line.trim()}</span>
          </div>
        )
      })}
      {lines.length > visible && (
        <button className="trr-expand-btn" onClick={() => setExtra(e => e + FILELIST_CHUNK)}>
          Показать ещё {Math.min(FILELIST_CHUNK, lines.length - visible)} из {lines.length}
        </button>
      )}
    </div>
  )
}, (prev, next) => prev.content === next.content)

const SEARCH_CHUNK = 5

const WebSearchResult = memo(function WebSearchResult({ content }: { content: string }) {
  const [extra, setExtra] = useState(0)
  const visible = SEARCH_CHUNK + extra
  const parsed = tryParseJSON(content)
  if (Array.isArray(parsed)) {
    const arr = parsed as Array<{ title?: string; url?: string; snippet?: string; content?: string }>
    return (
      <div className="trr-search-results">
        {arr.slice(0, visible).map((r, i) => (
          <div key={i} className="trr-search-card">
            {r.title && <div className="trr-search-title">{r.title}</div>}
            {r.url && <div className="trr-search-url">{r.url}</div>}
            {(r.snippet || r.content) && (
              <div className="trr-search-snippet">{String(r.snippet || r.content || '').slice(0, 200)}</div>
            )}
          </div>
        ))}
        {arr.length > visible && (
          <button className="trr-expand-btn" onClick={() => setExtra(e => e + SEARCH_CHUNK)}>
            Показать ещё {Math.min(SEARCH_CHUNK, arr.length - visible)} из {arr.length}
          </button>
        )}
      </div>
    )
  }
  // Plain text fallback
  return <pre className="trr-pre">{content.slice(0, 600)}</pre>
}, (prev, next) => prev.content === next.content)

const KV_CHUNK = 50
const KV_VALUE_MAX = 500

const KeyValueResult = memo(function KeyValueResult({ content }: { content: string }) {
  const [extra, setExtra] = useState(0)
  const visible = KV_CHUNK + extra
  const parsed = tryParseJSON(content)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>)
    return (
      <div className="trr-kv">
        {entries.slice(0, visible).map(([k, v]) => (
          <div key={k} className="trr-kv-row">
            <span className="trr-kv-key">{k}</span>
            <span className="trr-kv-val">{String(v).slice(0, KV_VALUE_MAX)}</span>
          </div>
        ))}
        {entries.length > visible && (
          <button className="trr-expand-btn" onClick={() => setExtra(e => e + KV_CHUNK)}>
            Показать ещё {Math.min(KV_CHUNK, entries.length - visible)} из {entries.length}
          </button>
        )}
      </div>
    )
  }
  return <pre className="trr-pre">{content.slice(0, 400)}</pre>
}, (prev, next) => prev.content === next.content)

function FileWrittenResult({ content, args }: { content: string; args?: Record<string, unknown> }) {
  const path = String(args?.path ?? args?.file_path ?? '')
  return (
    <div className="trr-file-written">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <span>{path ? `Записан: ${path}` : content.slice(0, 120)}</span>
    </div>
  )
}

const MATCHES_CHUNK = 20

const SearchCodeResult = memo(function SearchCodeResult({ content }: { content: string }) {
  const [extra, setExtra] = useState(0)
  const visible = MATCHES_CHUNK + extra
  const allLines = content.split('\n')
  // Парсим шапку статистики: "[search_code: N совпадений в M файлах...]"
  const header = allLines[0] ?? ''
  const statsMatch = header.match(/\[search_code:\s*(.+?)\]/)
  const stats = statsMatch?.[1]
  // Тело — всё кроме шапки; фильтруем пустые строки
  const body = (stats ? allLines.slice(1) : allLines).filter(l => l.trim())
  return (
    <div className="trr-code-matches">
      {stats && (
        <div className="trr-code-matches-stats">
          <span className="trr-code-matches-badge">{stats}</span>
        </div>
      )}
      {body.slice(0, visible).map((line, i) => (
        <div key={i} className="trr-code-match-line">
          <pre>{line}</pre>
        </div>
      ))}
      {body.length > visible && (
        <button className="trr-expand-btn" onClick={() => setExtra(e => e + MATCHES_CHUNK)}>
          Показать ещё {Math.min(MATCHES_CHUNK, body.length - visible)} из {body.length} строк
        </button>
      )}
    </div>
  )
}, (prev, next) => prev.content === next.content)

/** Дефолтный pre-рендер с чанкованием (используется в default-ветке). */
const ChunkedPre = memo(function ChunkedPre({ content, initialLines }: { content: string; initialLines: number }) {
  const [extra, setExtra] = useState(0)
  const visible = initialLines + extra
  const total = content.split('\n').length
  const { text, truncated } = truncateLines(content, visible)
  return (
    <>
      <pre className="trr-pre">{text}</pre>
      {truncated && (
        <button className="trr-expand-btn" onClick={() => setExtra(e => e + CODE_CHUNK)}>
          Показать ещё {Math.min(CODE_CHUNK, total - visible)} из {total} строк
        </button>
      )}
    </>
  )
}, (prev, next) => prev.content === next.content && prev.initialLines === next.initialLines)

// ── Image search result (item 12) — карточки с кнопками, БЕЗ рендера картинок ─

interface ImageResult {
  title: string
  image: string
  thumbnail: string
  url: string
  width: number
  height: number
  source: string
  localPath?: string
}

const IMAGE_CHUNK = 6

const ImageSearchResult = memo(function ImageSearchResult({ content }: { content: string }) {
  const [extra, setExtra] = useState(0)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const parsed = tryParseJSON(content)
  if (!Array.isArray(parsed)) {
    // Fallback: plain text (например "No images found")
    return <pre className="trr-pre">{content.slice(0, 400)}</pre>
  }

  const results = parsed as ImageResult[]
  if (!results.length) {
    return <div className="trr-image-empty">Картинки не найдены. Попробуйте изменить запрос.</div>
  }
  const visible = IMAGE_CHUNK + extra

  const handleCopy = (idx: number, url: string) => {
    void copyToClipboard(url).then((ok) => {
      if (ok) {
        setCopiedIdx(idx)
        setTimeout(() => setCopiedIdx(null), 1500)
      }
    })
  }

  return (
    <div className="trr-image-search">
      <div className="trr-image-list">
        {results.slice(0, visible).map((r, i) => (
          <div key={i} className="trr-image-item">
            <div className="trr-image-item-info">
              <div className="trr-image-item-title">{r.title || `Изображение ${i + 1}`}</div>
              <div className="trr-image-item-meta">
                {r.width}×{r.height} · {r.source}
              </div>
            </div>
            <div className="trr-image-item-actions">
              <button
                className="trr-image-btn trr-image-btn-copy"
                onClick={() => handleCopy(i, r.image)}
                title="Копировать URL картинки в буфер обмена"
              >
                {copiedIdx === i ? '✓' : 'Копировать'}
              </button>
              <button
                className="trr-image-btn trr-image-btn-open"
                onClick={() => window.open(r.image, '_blank')}
                title="Открыть в браузере"
              >
                Открыть
              </button>
              {r.localPath && (
                <span className="trr-image-saved" title={r.localPath}>✓ Сохранено</span>
              )}
            </div>
          </div>
        ))}
      </div>
      {results.length > visible && (
        <button className="trr-expand-btn" onClick={() => setExtra(e => e + IMAGE_CHUNK)}>
          Показать ещё {Math.min(IMAGE_CHUNK, results.length - visible)} из {results.length}
        </button>
      )}
    </div>
  )
}, (prev, next) => prev.content === next.content)

// ── Fetch page result (item 13) — header + ChunkedPre ──

const FetchPageResult = memo(function FetchPageResult({ content, initialLines }: {
  content: string; initialLines: number
}) {
  // Парсим мета-блок
  const metaMatch = content.match(/^---FETCH_META---\n([\s\S]*?)---END_META---\n\n([\s\S]*)$/)
  if (!metaMatch) {
    // Нет мета — fallback на TerminalResult
    return <TerminalResult content={content} initialLines={initialLines} />
  }

  const metaStr = metaMatch[1]
  const body = metaMatch[2]
  const meta: Record<string, string> = {}
  for (const line of metaStr.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (m) meta[m[1]] = m[2]
  }

  return (
    <div className="trr-fetch-page">
      <div className="trr-fetch-header">
        {meta.favicon && (
          <img
            src={meta.favicon}
            className="trr-fetch-favicon"
            loading="lazy"
            alt=""
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        )}
        <div className="trr-fetch-info">
          {meta.title && <div className="trr-fetch-title">{meta.title}</div>}
          {meta.url && <div className="trr-fetch-url">{meta.url}</div>}
          {meta.description && <div className="trr-fetch-desc">{meta.description}</div>}
        </div>
      </div>
      <ChunkedPre content={body} initialLines={initialLines} />
    </div>
  )
}, (prev, next) => prev.content === next.content && prev.initialLines === next.initialLines)

// ── Главный компонент ──────────────────────────────────────────────────────

interface Props {
  call: ToolStep
  result: ToolStep
  mode: ToolOutputMode
}

// Начальный кап строк: normal — 60 (как раньше), detailed — 500 (раньше было
// 9999 = фактически без капа; на файлах в тысячи строк Prism токенизировал
// всё целиком и монтировал тысячи DOM-узлов). Дальше — чанки «Показать ещё».
const NORMAL_LINES = 60
const DETAILED_LINES = 500

// Аргументы этих тулов показываем ВСЕГДА, не только в detailed-режиме:
// для run_command полная команда — ключевая информация (что именно AI
// выполнил). Раньше в normal-режиме команда была видна только обрезанным
// 80-символьным preview в свёрнутом заголовке — раскрытие её прятало.
const ALWAYS_SHOW_ARGS = new Set(['run_command'])

// Полная команда run_command: без обрезки в 500 символов (длинные
// PowerShell-однострочники) + кнопка копирования.
const CommandArgValue = memo(function CommandArgValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    void copyToClipboard(value).then(ok => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }
    })
  }
  return (
    <div className="trr-arg-cmd">
      <pre className="trr-arg-val trr-arg-val--full">{value}</pre>
      <button className="trr-copy-btn" onClick={onCopy} title="Копировать команду">
        {copied ? '✓' : 'Копировать'}
      </button>
    </div>
  )
}, (prev, next) => prev.value === next.value)

const ToolResultRenderer = memo(function ToolResultRenderer({ call, result, mode }: Props) {
  const toolName = call.toolName ?? ''
  const content = result.content ?? ''
  const args = call.toolArgs ?? {}
  const initialLines = mode === 'detailed' ? DETAILED_LINES : NORMAL_LINES

  // ── detailed + ALWAYS_SHOW_ARGS: показываем аргументы ──
  const showArgs = mode === 'detailed' || ALWAYS_SHOW_ARGS.has(toolName)

  return (
    <div className="trr-wrap">
      {showArgs && Object.keys(args).length > 0 && (
        <div className="trr-args-section">
          <div className="trr-section-label">Аргументы</div>
          <div className="trr-args">
            {Object.entries(args).map(([k, v]) => (
              <div key={k} className="trr-arg-row">
                <span className="trr-arg-key">{k}</span>
                {toolName === 'run_command' && k === 'command' ? (
                  <CommandArgValue value={String(v)} />
                ) : (
                  <pre className="trr-arg-val">{String(v).slice(0, 500)}</pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="trr-result-section">
        {mode !== 'compact' && (
          <div className="trr-section-label" style={{ color: result.success === false ? '#f87171' : '#4ade80' }}>
            {result.success === false ? 'Ошибка' : 'Результат'}
          </div>
        )}

        {result.success === false
          ? (
            <div className="trr-error-block">
              <pre className="trr-error-pre">{content || '(нет деталей ошибки)'}</pre>
            </div>
          )
          : renderResult(toolName, content, args, initialLines)}
      </div>
    </div>
  )
}, (prev, next) => prev.call === next.call && prev.result === next.result && prev.mode === next.mode)

export default ToolResultRenderer

function renderResult(toolName: string, content: string, args: Record<string, unknown>, initialLines: number) {
  if (toolName === 'manage_chats') {
    const data = tryParseJSON(content) as { chat_id?: string; title?: string; status?: string; content?: string; chats?: Array<{ chat_id: string; title: string; status?: string }> } | null
    const chats = data?.chats ?? (data?.chat_id ? [{ chat_id: data.chat_id, title: data.title ?? 'Открыть чат', status: data.status }] : [])
    return (
      <div>
        {chats.map(chat => (
          <button key={chat.chat_id} className="trr-expand-btn" onClick={() => {
            useNavStore.getState().setMainPage('chat')
            tabActions.selectChat?.(chat.chat_id)
          }}>
            {chat.title}{chat.status ? ` · ${chat.status}` : ''} ↗
          </button>
        ))}
        <ChunkedPre content={data?.content ?? content} initialLines={initialLines} />
      </div>
    )
  }
  // read_file → code с подсветкой
  if (toolName === 'read_file' || toolName === 'read_files') {
    const path = String(args.path ?? args.file_path ?? '')
    const lang = getLanguage(path)
    return <CodeResult content={content} lang={lang} initialLines={initialLines} />
  }

  // write_file / edit_file → плашка успеха
  if (toolName === 'write_file' || toolName === 'edit_file') {
    return <FileWrittenResult content={content} args={args} />
  }

  // run_command → terminal
  if (toolName === 'run_command') {
    return <TerminalResult content={content} initialLines={initialLines} />
  }

  // find_files / list_directory → файловое дерево
  if (toolName === 'find_files' || toolName === 'list_directory') {
    return <FileListResult content={content} />
  }

  // search_web → карточки
  if (toolName === 'search_web') {
    return <WebSearchResult content={content} />
  }

  // search_code → строки с совпадениями
  if (toolName === 'search_code') {
    return <SearchCodeResult content={content} />
  }

  // get_system_info / get_file_outline → key-value
  if (toolName === 'get_system_info' || toolName === 'get_file_outline') {
    return <KeyValueResult content={content} />
  }

  // fetch_page → header + ChunkedPre (мета-блок + контент)
  if (toolName === 'fetch_page') {
    return <FetchPageResult content={content} initialLines={initialLines} />
  }

  // search_images → карточки с кнопками (БЕЗ рендера картинок)
  if (toolName === 'search_images') {
    return <ImageSearchResult content={content} />
  }

  // list_extensions → key-value (статичный отчёт)
  if (toolName === 'list_extensions') {
    return <KeyValueResult content={content} />
  }

  // MCP-тулы (mcp__server__tool) — пробуем JSON-парсинг, fallback → terminal-стиль
  if (toolName.startsWith('mcp__')) {
    // Пытаемся распарсить JSON-ответ (многие MCP-серверы возвращают JSON)
    try {
      const parsed = JSON.parse(content)
      if (typeof parsed === 'object' && parsed !== null) {
        const formatted = JSON.stringify(parsed, null, 2)
        return <TerminalResult content={formatted} initialLines={initialLines} />
      }
    } catch { /* не JSON — рендерим как текст */ }
    return <TerminalResult content={content} initialLines={initialLines} />
  }

  // default → pre с чанкованием
  return <ChunkedPre content={content} initialLines={initialLines} />
}
