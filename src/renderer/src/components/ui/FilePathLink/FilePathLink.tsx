// ── FilePathLink — кликабельный путь файла/папки в сообщении ─────────────
//
// Рендерит markdown-link (file-path://) из remarkFilePaths как чип:
// - иконка типа файла (FileIcon) или папки;
// - статус существования (pathStatus): exists → акцентный чип,
//   missing → приглушённый пунктир, pending/unknown → обычная ссылка;
// - клик: файл в проекте → правая панель (+ reveal на строку :42),
//   папка/вне проекта → Проводник / системный вьюер (openFilePath);
// - правый клик → контекстное меню (Проводник, копирование, diff);
// - ховер 250мс → peek-превью первых строк файла (LRU-кэш 24, 16KB);
// - пути-картинки → инлайн-миниатюра (file://), клик → системный вьюер.
//
// Оптимизация: memo + useSyncExternalStore на статус пути — ре-рендерится
// только конкретная ссылка, когда её путь проверился (не всё сообщение).

import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import FileIcon from '../FileIcon/FileIcon'
import {
  usePathStatus,
} from '../../../utils/pathStatus'
import { splitPathLine, resolveFilePath, normalizePath } from '../../../utils/remarkFilePaths'
import { openFilePath, revealInExplorer, resolveAbsolutePath, toFileUrl } from '../../../utils/openFilePath'
import './FilePathLink.css'

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i

// ── Peek-кэш: первые строки файла (LRU 24) ──────────────────────────────
interface PeekData {
  content: string | null // null — файл недоступен/слишком большой
  lang: string
}

const peekCache = new Map<string, PeekData>()
const PEEK_CACHE_MAX = 24
const PEEK_MAX_BYTES = 16 * 1024
const PEEK_LINES = 14

function splitAbsPath(abs: string): { root: string; base: string } {
  const norm = abs.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  if (idx <= 0) return { root: norm, base: '' }
  return { root: norm.slice(0, idx), base: norm.slice(idx + 1) }
}

function extOf(p: string): string {
  const m = /\.(\w+)$/.exec(p)
  return m ? m[1].toLowerCase() : ''
}

async function fetchPeek(abs: string): Promise<PeekData> {
  const cached = peekCache.get(abs)
  if (cached) {
    // LRU: обновляем позицию
    peekCache.delete(abs)
    peekCache.set(abs, cached)
    return cached
  }
  const { root, base } = splitAbsPath(abs)
  let data: PeekData
  if (!base) {
    data = { content: null, lang: '' }
  } else {
    try {
      const r = await window.syntee.fs.readFile({ root, relPath: base, maxBytes: PEEK_MAX_BYTES }) as
        { success: boolean; content: string; error?: string }
      data = {
        content: r.success
          ? r.content.split('\n').slice(0, PEEK_LINES).join('\n')
          : null,
        lang: extOf(base),
      }
    } catch {
      data = { content: null, lang: '' }
    }
  }
  peekCache.set(abs, data)
  if (peekCache.size > PEEK_CACHE_MAX) {
    const oldest = peekCache.keys().next().value
    if (oldest !== undefined) peekCache.delete(oldest)
  }
  return data
}

// ── Контекстное меню — синглтон на императивном DOM ─────────────────────
// Один экземпляр на всё приложение, закрывается по клику вне/Escape/скроллу.
interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

let menuEl: HTMLElement | null = null
let menuCleanup: (() => void) | null = null

export function closePathContextMenu(): void {
  menuCleanup?.()
  menuCleanup = null
  menuEl?.remove()
  menuEl = null
}

function showPathContextMenu(x: number, y: number, items: Array<MenuItem | 'sep'>): void {
  closePathContextMenu()
  const el = document.createElement('div')
  el.className = 'path-ctx-menu'
  for (const item of items) {
    if (item === 'sep') {
      const sep = document.createElement('div')
      sep.className = 'path-ctx-menu__sep'
      el.appendChild(sep)
      continue
    }
    const btn = document.createElement('button')
    btn.className = 'path-ctx-menu__item' + (item.danger ? ' path-ctx-menu__item--danger' : '')
    btn.textContent = item.label
    btn.addEventListener('click', () => {
      closePathContextMenu()
      item.onClick()
    })
    el.appendChild(btn)
  }
  document.body.appendChild(el)
  menuEl = el

  // Позиция с клампом к вьюпорту
  const rect = el.getBoundingClientRect()
  const left = Math.min(x, window.innerWidth - rect.width - 8)
  const top = rect.height + y > window.innerHeight - 8 ? y - rect.height - 8 : y
  el.style.left = `${Math.max(8, left)}px`
  el.style.top = `${Math.max(8, top)}px`

  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) closePathContextMenu()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePathContextMenu()
  }
  const onClose = () => closePathContextMenu()
  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onClose)
  window.addEventListener('resize', onClose)
  menuCleanup = () => {
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', onClose)
    window.removeEventListener('resize', onClose)
  }
}

// ── Компонент ────────────────────────────────────────────────────────────
interface FilePathLinkProps {
  /** Полный текст совпадения: путь + опциональный суффикс :42-58 */
  raw: string
  workdir?: string
}

interface PeekState {
  x: number
  y: number
  content: string | null
  path: string
}

const FilePathLink = memo(function FilePathLink({ raw, workdir }: FilePathLinkProps) {
  const { path, line, lineEnd } = useMemo(() => splitPathLine(raw), [raw])
  // Нормализуем (сворачиваем ../) — единый ключ кэша статуса и корректные
  // inside-проверки; без этого `a/../b` и `b` давали разные записи кэша.
  const resolved = useMemo(() => normalizePath(resolveFilePath(path, workdir)), [path, workdir])

  const isAbs = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('~')
  const canCheck = isAbs || !!workdir
  const statusRec = usePathStatus(canCheck ? resolved : undefined)
  const isImage = IMAGE_RE.test(path)
  const isDir = statusRec.status === 'exists' && !!statusRec.isDir

  const [peek, setPeek] = useState<PeekState | null>(null)
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const peekAbort = useRef(false)

  const lineSuffix = line ? `:${line}${lineEnd ? `-${lineEnd}` : ''}` : ''

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    void openFilePath(raw, workdir)
  }, [raw, workdir])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const items: Array<MenuItem | 'sep'> = []
    items.push({ label: 'Показать в Проводнике', onClick: () => { void revealInExplorer(raw, workdir) } })
    if (!isDir) {
      items.push({ label: 'Открыть', onClick: () => { void openFilePath(raw, workdir) } })
      if (workdir) {
        const wdNorm = workdir.replace(/\\/g, '/').replace(/\/$/, '')
        const absNorm = resolved.replace(/\\/g, '/')
        if (absNorm.toLowerCase().startsWith(wdNorm.toLowerCase() + '/')) {
          items.push({ label: 'Open Changes (diff)', onClick: () => { void openFilePath(raw, workdir, { diff: true }) } })
        }
      }
    }
    items.push('sep')
    items.push({
      label: 'Копировать путь',
      onClick: () => { void resolveAbsolutePath(raw, workdir).then(p => navigator.clipboard.writeText(p)) },
    })
    if (workdir) {
      const wdNorm = workdir.replace(/\\/g, '/').replace(/\/$/, '')
      const absNorm = resolved.replace(/\\/g, '/')
      if (absNorm.toLowerCase().startsWith(wdNorm.toLowerCase() + '/')) {
        const rel = absNorm.slice(wdNorm.length + 1)
        items.push({ label: 'Копировать относительный путь', onClick: () => { void navigator.clipboard.writeText(rel) } })
      }
    }
    showPathContextMenu(e.clientX, e.clientY, items)
  }, [raw, workdir, resolved, isDir])

  // ── Peek-превью (не для папок и картинок) ──
  const startPeek = useCallback(() => {
    if (isDir || isImage) return
    peekAbort.current = false
    if (peekTimer.current) clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(async () => {
      if (peekAbort.current) return
      const data = await fetchPeek(resolved)
      if (peekAbort.current) return
      const host = peekAnchorRef.current
      if (!host) return
      const r = host.getBoundingClientRect()
      // Кламп к вьюпорту: не влезает снизу (~300px высота карточки) → показываем сверху
      const below = r.bottom + 6
      const top = below + 300 > window.innerHeight ? Math.max(8, r.top - 306) : below
      setPeek({ x: r.left, y: top, content: data.content, path: resolved })
    }, 250)
  }, [resolved, isDir, isImage])

  const stopPeek = useCallback(() => {
    peekAbort.current = true
    if (peekTimer.current) clearTimeout(peekTimer.current)
    peekTimer.current = null
    setPeek(null)
  }, [])

  const peekAnchorRef = useRef<HTMLAnchorElement | null>(null)

  // ── Гейтинг по существованию: подсветка ТОЛЬКО у реальных путей ──
  // Статус pending/missing/unknown → обычный текст без какого-либо
  // форматирования. Это убивает все ложные срабатывания regex («24/7»,
  // «и/или», «client/server», опечатки AI) — проза никогда не существует
  // на диске, поэтому никогда не подсвечивается. Статус кэшируется
  // (pathStatus), так что повторные рендеры бесплатны.
  if (statusRec.status !== 'exists') {
    return <span>{raw}</span>
  }

  // ── Картинка по пути → инлайн-миниатюра ──
  if (isImage) {
    return (
      <span className="file-path-img-wrap">
        <img
          className="file-path-img"
          src={toFileUrl(resolved)}
          alt={path}
          title={path}
          loading="lazy"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void window.syntee.shell.openPath(resolved)
          }}
          onContextMenu={handleContextMenu}
        />
      </span>
    )
  }

  const cls = [
    'file-path-link',
    'file-path-link--exists',
    isDir ? 'file-path-link--dir' : '',
  ].filter(Boolean).join(' ')

  return (
    <a
      ref={peekAnchorRef}
      href="#"
      className={cls}
      title={resolved}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={startPeek}
      onMouseLeave={stopPeek}
    >
      <span className="file-path-link__icon">
        {isDir
          ? (
            <svg className="file-path-link__dir-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          )
          : <FileIcon name={path.split('/').pop() || path} size={12} />}
      </span>
      <span className="file-path-link__text">{path}</span>
      {lineSuffix && <span className="file-path-link__line">{lineSuffix}</span>}
      {peek && peek.content !== null && createPortal(
        <div className="path-peek" style={{ left: Math.max(8, Math.min(peek.x, window.innerWidth - 500)), top: peek.y }}>
          <div className="path-peek__header">
            <span className="path-peek__path">{peek.path}</span>
          </div>
          <pre className="path-peek__pre">{peek.content}</pre>
        </div>,
        document.body,
      )}
    </a>
  )
})

export default FilePathLink
