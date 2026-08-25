/**
 * Реестр xterm.js инстансов. Мутабельные объекты (Terminal, FitAddon) нельзя
 * класть в zustand — поэтому живёт отдельно как синглтон. Один Terminal на
 * sessionId, переживает unmount/mount (reparenting между right-tab и bottom-dock)
 * без потери буфера и скроллбэка.
 *
 * Стриминг: глобальная подписка на 'pty:data'/'pty:exit' один раз при первом
 * обращении к реестру; данные пишутся в соответствующий term по sessionId.
 */
import { Terminal } from '@xterm/xterm'
import type { ITheme, ILinkProvider, ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { PATH_RE, isValidPathMatch, splitPathLine, resolveFilePath, normalizePath } from './remarkFilePaths'
import { openFilePath } from './openFilePath'
import { awaitPathStatus } from './pathStatus'
import { useFileTabsStore } from '../store/fileTabs.store'

interface Entry {
  term: Terminal
  fit: FitAddon
  /** Контейнер, к которому сейчас приаттачен term.element. */
  attachedTo: HTMLElement | null
  unsub: (() => void) | null
}

const entries = new Map<string, Entry>()
let globalSubscribed = false

// ── Динамическая тема xterm из CSS-переменных ────────────────────────
// xterm.js не читает CSS-переменные — его тема это JS-объект. Чтобы
// терминал адаптировался под тему приложения (dark/light/custom),
// читаем переменные из :root через getComputedStyle и мапим в ITheme.
// ANSI-цвета оставляем фиксированными (One Dark palette) — они
// универсально читаемы и на тёмном, и на светлом фоне.
function getTerminalThemeFromCSS(): ITheme {
  const cs = getComputedStyle(document.documentElement)
  const get = (name: string, fallback: string): string =>
    cs.getPropertyValue(name).trim() || fallback
  return {
    background: get('--body-bg', '#0e0e12'),
    foreground: get('--text-primary', '#e8e8ec'),
    cursor: get('--text-primary', '#e8e8ec'),
    selectionBackground: get('--accent-subtle', 'rgba(255,255,255,0.12)'),
    black: '#000000',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#d4d4d4',
    brightBlack: '#5c5c5c',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  }
}

/** Обновляет тему всех живых xterm-инстансов. Вызывать при смене темы
 *  приложения (dark→light→custom и т.д.). Должна вызываться ПОСЛЕ того,
 *  как CSS-переменные уже применены к DOM — используйте requestAnimationFrame. */
export function applyTerminalThemeAll(): void {
  const theme = getTerminalThemeFromCSS()
  for (const e of entries.values()) {
    e.term.options.theme = theme
  }
}

// ── Throttling pty:data → term.write через rAF ──────────────────────────
// Без этого каждый чанк pty:data синхронно пишет в xterm → при большом
// выводе (npm install, git clone) renderer фризит на каждом чанке. Батчим
// чанки за один rAF-кадр — ~60fps, один term.write на кадр.
const writeQueues = new Map<string, string[]>()
let rafScheduled = false

function flushWriteQueues(): void {
  rafScheduled = false
  for (const [sid, chunks] of writeQueues) {
    // Очищаем очередь ДО проверки entries — если term уже диспознут,
    // очередь не должна утекать (раньше delete только если entries.get truthy)
    const e = entries.get(sid)
    if (e) {
      e.term.write(chunks.join(''))
    }
    chunks.length = 0
    writeQueues.delete(sid)
  }
}

function scheduleWrite(sessionId: string, data: string): void {
  let chunks = writeQueues.get(sessionId)
  if (!chunks) {
    chunks = []
    writeQueues.set(sessionId, chunks)
  }
  chunks.push(data)
  if (!rafScheduled) {
    rafScheduled = true
    requestAnimationFrame(flushWriteQueues)
  }
}

// ── LinkProvider: кликабельные пути файлов в выводе терминала ───────────
// Тот же PATH_RE что в сообщениях: src/foo.ts:42 → открыть файл в панели
// (с reveal на строку), папку — в Проводнике. Workdir берём из fileTabs-стора
// на момент клика (терминалы привязаны к чату, стор синхронизирован с ним).
// Подчёркивание — ТОЛЬКО у существующих путей (stat через pathStatus-кэш):
// вывод терминала полон «/g», «/div» и прочего мусора, который не должен
// выглядеть кликабельным. xterm callback асинхронный — фильтруем после
// проверки (кэш делает повторные ховеры бесплатными).
function registerPathLinks(term: Terminal): void {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
      let line: string
      try {
        line = term.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true) ?? ''
      } catch {
        callback(undefined)
        return
      }
      if (!line || (!line.includes('/') && !line.includes('\\'))) {
        callback(undefined)
        return
      }
      const links: ILink[] = []
      for (const m of line.matchAll(PATH_RE)) {
        const full = m[1]
        if (!isValidPathMatch(full)) continue
        const start = m.index + 1 // xterm-координаты 1-based
        const end = m.index + full.length
        links.push({
          range: { start: { x: start, y: bufferLineNumber }, end: { x: end, y: bufferLineNumber } },
          text: full,
          decorations: { underline: true, pointerCursor: true },
          activate: (_e: MouseEvent, text: string) => {
            const wd = useFileTabsStore.getState().workdir ?? undefined
            void openFilePath(text, wd)
          },
        })
      }
      if (!links.length) {
        callback(undefined)
        return
      }
      // Существование: кэш → мгновенно, новые пути → один IPC (дедуп)
      const wd = useFileTabsStore.getState().workdir ?? undefined
      Promise.all(links.map(async l => {
        const abs = normalizePath(resolveFilePath(splitPathLine(l.text).path, wd))
        return (await awaitPathStatus(abs)).status === 'exists'
      }))
        .then(flags => {
          const ok = links.filter((_, i) => flags[i])
          callback(ok.length ? ok : undefined)
        })
        .catch(() => callback(undefined))
    },
  }
  term.registerLinkProvider(provider)
}

function ensureGlobalSubscription(): void {
  if (globalSubscribed) return
  globalSubscribed = true
  window.syntee.on('pty:data', (sessionId: unknown, data: unknown) => {
    const e = entries.get(sessionId as string)
    if (e) scheduleWrite(sessionId as string, data as string)
  })
  window.syntee.on('pty:exit', (sessionId: unknown, _exitCode: unknown) => {
    // Ничего не делаем с term — юзер видит финальный вывод. Store обновится
    // через poll/refresh. Можно добавить маркер смерти в самом term.
    const e = entries.get(sessionId as string)
    if (e) e.term.write('\r\n\x1b[2m[процесс завершён]\x1b[0m\r\n')
  })
}

export interface GetOrCreateOpts {
  sessionId: string
  onData: (data: string) => void
}

/** Возвращает (или создаёт) xterm-инстанс для sessionId. */
export function getOrCreateTerminal({ sessionId, onData }: GetOrCreateOpts): Entry {
  ensureGlobalSubscription()
  const existing = entries.get(sessionId)
  if (existing) return existing

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, monospace',
    theme: getTerminalThemeFromCSS(),
    allowProposedApi: true,
    scrollback: 5000,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  // Кликабельные пути файлов в выводе (src/foo.ts:42 → панель, папка → Проводник)
  registerPathLinks(term)

  const disposeData = term.onData(d => onData(d))

  const entry: Entry = { term, fit, attachedTo: null, unsub: () => disposeData.dispose() }
  entries.set(sessionId, entry)
  return entry
}

/** Аттачит term в контейнер. При re-attach (другой контейнер) — переносит
 *  term.element. Повторный attach в тот же контейнер — no-op. */
export function attachToContainer(sessionId: string, container: HTMLElement): void {
  const e = entries.get(sessionId)
  if (!e) return
  if (e.attachedTo === container) return
  // Если уже был открыт в другом контейнере — переносим DOM-узел.
  // term.open(container) нельзя вызывать дважды, поэтому работаем через
  // term.element (создаётся при первом open).
  if (!e.term.element) {
    e.term.open(container)
  } else {
    container.appendChild(e.term.element)
  }
  e.attachedTo = container
  // fit после переноса/первого открытия — размеры могли измениться.
  try { e.fit.fit() } catch { /* container ещё не имеет размеров */ }
  // Отправляем актуальный размер в PTY
  sendResize(e)
}

/** Достаёт pre-mount буфер (вывод до первого attach) и пишет в term
 *  чанками через rAF — чтобы не блокировать рендерер одним гигантским write. */
export function flushPreMount(sessionId: string): void {
  const e = entries.get(sessionId)
  if (!e) return
  window.syntee.pty.consumePreMount(sessionId).then((buf: string) => {
    if (!buf) return
    const CHUNK_SIZE = 16384 // 16 KB per frame — баланс между плавностью и overhead
    let offset = 0
    const writeChunk = () => {
      if (offset >= buf.length || entries.get(sessionId) !== e) return
      e.term.write(buf.slice(offset, offset + CHUNK_SIZE))
      offset += CHUNK_SIZE
      if (offset < buf.length) {
        requestAnimationFrame(writeChunk)
      }
    }
    requestAnimationFrame(writeChunk)
  }).catch(() => { /* consumePreMount failed — ignore */ })
}

function sendResize(e: Entry): void {
  // cols/rows читаем из term после fit()
  // Не делаем это здесь — resize шлётся из TerminalView через ResizeObserver,
  // т.к. нужно привязать к конкретному sessionId.
  void e
}

export function fitTerminal(sessionId: string): { cols: number; rows: number } | null {
  const e = entries.get(sessionId)
  if (!e) return null
  try {
    e.fit.fit()
    return { cols: e.term.cols, rows: e.term.rows }
  } catch {
    return null
  }
}

export function focusTerminal(sessionId: string): void {
  const e = entries.get(sessionId)
  if (e) e.term.focus()
}

export function disposeTerminal(sessionId: string): void {
  const e = entries.get(sessionId)
  if (!e) return
  e.unsub?.()
  e.term.dispose()
  entries.delete(sessionId)
  // Очищаем очередь write — иначе утекает (rAF может держать chunks)
  writeQueues.delete(sessionId)
}
