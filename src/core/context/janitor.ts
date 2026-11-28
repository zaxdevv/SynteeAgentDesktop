import type { ChatMessage } from './contextManager'
import { estimateTokensCalibrated } from '../tokens/usageTracker'
import { JANITOR_MARKER, type JanitorAction, type JanitorActionKind, type JanitorReport, type AssistantsSettings } from '../../shared/assistants'

// ── Классификация тулов ──────────────────────────────────────────────────────
/** Тулы, чьи результаты — структурное состояние для агента: не трогаем. */
export const PINNED_TOOLS = new Set(['update_todo', 'update_working_memory', 'ask_user', 'request_access', 'recall_context', 'read_mcp_result'])
/** Явные мутаторы файла: правка после чтения делает чтение устаревшим. */
export const FILE_MUTATORS = new Set(['edit_file', 'write_file'])
/** Недетерминированное влияние на диск: между дедуплицируемыми вызовами
 *  такого тула не должно быть — иначе «идентичные» результаты могли отличаться. */
export const UNKNOWN_MUTATORS = new Set(['run_command', 'execute_code'])
export const READ_TOOLS = new Set(['read_file', 'read_files'])

export const STALE_MIN_CHARS = 1200   // короче — резюме не дешевле
export const STALE_MIN_SAVED = 150    // замена должна окупиться
export const MIN_STUB_CHARS = 800     // дедуп/перечитывание коротких результатов — шум
export const MAX_JANITOR_ARCHIVE_ENTRIES = 50
export const MAX_JANITOR_ARCHIVE_CHARS = 4_000_000

// ── Разбор результатов чтения ────────────────────────────────────────────────
export interface ReadRange {
  from: number
  to: number
  total?: number
}

export interface ParsedReadSection {
  /** Нормализованный путь (lowercase, \). */
  path: string
  /** Путь как в заголовке результата. */
  displayPath: string
  range: ReadRange | null
  body: string
}

export function normalizePath(p: string): string {
  const path = String(p)
  // POSIX paths are case sensitive. Only Windows paths share a folded key.
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? path.toLowerCase().replace(/\//g, '\\') : path
}

/**
 * Разбирает результат read_file/read_files на секции с путями и диапазонами
 * строк. Форматы (см. fileRead.ts):
 *  - `[File: path | Lines A-B of Z | full mode]`
 *  - `[File: path | Lines A-B of Z]`
 *  - `[File: path | Z lines]` (+ опц. `...[shown N of Z lines ...]`)
 *  - read_files: `=== path | Z lines ===` на секцию.
 */
export function parseReadSections(toolName: string, content: string): ParsedReadSection[] {
  if (toolName === 'read_file') {
    let m = content.match(/\[File: ([^\]|]+?)\s*\|\s*Lines (\d+)-(\d+) of (\d+)/)
    if (m) {
      return [{ path: normalizePath(m[1]), displayPath: m[1], body: content.slice(content.indexOf('\n') + 1), range: { from: Number(m[2]), to: Number(m[3]), total: Number(m[4]) } }]
    }
    m = content.match(/\[File: ([^\]|]+?)\s*\|\s*(\d+) lines?\]/)
    if (m) {
      const total = Number(m[2])
      const shown = content.match(/\.\.\.\[shown (\d+) of (\d+) lines/)
      const to = shown ? Number(shown[1]) : total
      return [{ path: normalizePath(m[1]), displayPath: m[1], body: content.slice(content.indexOf('\n') + 1), range: { from: 1, to, total } }]
    }
    return []
  }
  if (toolName === 'read_files') {
    const sections: ParsedReadSection[] = []
    const headerRe = /^=== (.+?) \| (\d+) lines? ===\r?$/gm
    const matches = [...content.matchAll(headerRe)]
    // Mixed batches also contain error/binary/not-found sections without a
    // line count. Their diagnostics cannot be replaced by later file reads.
    // Decline range-based collapse unless every section was understood.
    if ([...content.matchAll(/^=== .+ ===\r?$/gm)].length !== matches.length) return []
    for (let index = 0; index < matches.length; index++) {
      const m = matches[index]
      const headerEnd = (m.index ?? 0) + m[0].length
      const body = content.slice(headerEnd, matches[index + 1]?.index ?? content.length)
      const total = Number(m[2])
      const shown = body.match(/\.\.\.\[shown (\d+) of (\d+) lines/)
      const numbered = body.match(/^\d+\|/gm)?.length ?? 0
      const to = Math.min(total, shown ? Number(shown[1]) : (numbered || Math.min(total, 250)))
      sections.push({ path: normalizePath(m[1]), displayPath: m[1], body, range: { from: 1, to, total } })
    }
    return sections
  }
  return []
}

/** Целевой диапазон полностью покрыт объединением более поздних диапазонов. */
export function rangesCover(target: ReadRange, later: ReadRange[]): boolean {
  const sorted = [...later].sort((a, b) => a.from - b.from)
  let cursor = target.from
  for (const r of sorted) {
    if (r.to < cursor) continue
    if (r.from > cursor) return false // дыра: старые строки нигде не перечитаны
    cursor = Math.max(cursor, r.to + 1)
    if (cursor > target.to) return true
  }
  return cursor > target.to
}

const parsedRows = new WeakMap<ParsedReadSection, Map<number, string>>()

function rowsOf(section: ParsedReadSection): Map<number, string> {
  const cached = parsedRows.get(section)
  if (cached) return cached
  const rows = new Map<number, string>()
  for (const match of section.body.matchAll(/^(\d+)\|([^\r\n]*)/gm)) rows.set(Number(match[1]), match[2])
  parsedRows.set(section, rows)
  return rows
}

/** A later read must reproduce every actual line, not merely cover its line numbers. */
export function hasIdenticalReadCoverage(target: ParsedReadSection, later: ParsedReadSection[]): boolean {
  if (!target.range) return false
  const candidates = later.filter(section => section.path === target.path && section.range)
  if (!rangesCover(target.range, candidates.map(section => section.range!))) return false
  const targetRows = rowsOf(target)
  if (target.range.to - target.range.from + 1 > targetRows.size || !Number.isSafeInteger(target.range.to)) return false
  const candidateRows = candidates.map(rowsOf)
  for (let line = target.range.from; line <= target.range.to; line++) {
    const original = targetRows.get(line)
    if (original === undefined || !candidateRows.some(rows => rows.get(line) === original)) return false
  }
  return true
}

/** Стабильно канонизирует аргументы тула для фингерпринта (сортировка ключей). */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(x => stableStringify(x)).join(',') + ']'
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',') + '}'
  }
  return JSON.stringify(v)
}

function headTail(body: string, headLen = 160, tailLen = 80): string {
  const head = body.slice(0, headLen).replace(/\n/g, ' ')
  const tail = tailLen > 0 && body.length > headLen + tailLen ? ` … ${body.slice(-tailLen).replace(/\n/g, ' ')}` : ''
  return `${head}${tail}`
}

/** Аргумент вызова для атрибуции в резюме: команда / паттерн / путь. */
export function toolCallDetail(args: Record<string, unknown> | null | undefined): string {
  if (!args) return ''
  for (const key of ['command', 'code', 'pattern', 'query', 'path']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * Структурное резюме tool-результата с точной атрибуцией: сохраняет путь и
 * ДИАПАЗОН прочитанных строк, запрос поиска и топ-файлы, команду и ошибки.
 * `note` — вердикт о свежести («файл после чтения не менялся» и т.п.).
 * Используется и в ране (summarize_stale), и в персистентной компрессии БД.
 */
export function summarizeToolResult(toolName: string, content: string, detail?: string, note?: string): string {
  const lines = content.split('\n').length
  const notePart = note ? ` — ${note}` : ''

  if (toolName === 'read_file' || toolName === 'read_files') {
    const body = content.replace(/\[(?:Файл|File):[^\]]*\]/g, '').trim()
    const sections = parseReadSections(toolName, content)
    if (sections.length) {
      const list = sections.slice(0, 4).map(s => {
        const r = s.range
        return `${s.displayPath}${r ? `, строки ${r.from}-${r.to}${r.total ? ` из ${r.total}` : ''}` : ''}`
      }).join('; ')
      const more = sections.length > 4 ? ` +${sections.length - 4}` : ''
      return `[read] ${list}${more}${notePart}: ${headTail(body)}`
    }
    return `[read] ${detail ?? '?'} (${lines} строк)${notePart}: ${headTail(body)}`
  }
  if (toolName === 'search_code' || toolName === 'find_files') {
    const header = content.match(/\[(?:search_code|find_files): ([^\]]+)\]/)?.[1]
    const files = [...content.matchAll(/^● (.+?)$/gm)].map(m => m[1].trim()).slice(0, 5)
    const detailPart = detail ? `«${detail.slice(0, 80)}»` : ''
    if (header || files.length) {
      const filesPart = files.length ? `: ${files.join(', ')}` : ''
      return `[search] ${detailPart}${header ? ` — ${header}` : ''}${filesPart}${notePart}. Повтори поиск при необходимости.`.replace('  ', ' ')
    }
    return `[search] ${detailPart} ${content.length} симв, ${lines} строк${notePart}: ${headTail(content)}`
  }
  if (toolName === 'run_command' || toolName === 'execute_code') {
    const errLines = content.split('\n').filter(l => /error|failed|exception|не найден|not found/i.test(l)).slice(0, 3)
    const tail = content.slice(-200).replace(/\n/g, ' ').trim()
    const cmdPart = detail ? `${detail.slice(0, 120)} — ` : ''
    const errPart = errLines.length ? ` ошибки: ${errLines.join(' | ').slice(0, 200)};` : ''
    return `[cmd] ${cmdPart}${lines} строк вывода;${errPart} хвост: ${tail}`
  }
  if (toolName === 'edit_file' || toolName === 'write_file') {
    const fileMatch = content.match(/([^\s]+\.[a-z]+)/i)
    return `[${toolName}] ${fileMatch?.[1] ?? detail ?? '?'} (${content.length} симв)${notePart}`
  }
  const namePart = detail ? `${detail.slice(0, 80)} — ` : ''
  return `[${toolName}] ${namePart}${content.length} симв, ${lines} строк: ${headTail(content, 150, 0)}…`
}

/** Граница «активного хвоста»: индекс последнего из N ходов (assistant-сообщений
 *  с тулами). Всё с этим индексом и позже джанитор не трогает. Если ходов
 *  меньше N — возвращает 0 (заморожена вся история). */
export function computeTailBoundary(messages: ChatMessage[], tailSteps: number): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.tool_calls?.length) {
      count++
      if (count >= tailSteps) return i
    }
  }
  return 0
}

export interface JanitorArchiveEntry {
  id: string
  originalMessages: ChatMessage[]
  summary: string
  ts: number
}

/** Индекс живых сообщений для проверки достижимости архивных записей. */
export interface LiveMessageIndex {
  /** id архивных записей, на которые ссылается живая история: `[recall:id]`. */
  referenced: Set<string>
  /** tool_call_id → контенты живых tool-сообщений (оригинал ещё в контексте). */
  toolContents: Map<string, string[]>
}

/**
 * Один проход по живым сообщениям: какие recall-ссылки в них есть и какие
 * оригиналы tool-результатов ещё лежат в контексте. Нужен только когда
 * бюджет архива реально упёрся — на обычных сканах не строится.
 */
export function indexLiveReferences(messages: ChatMessage[] | null | undefined): LiveMessageIndex {
  const referenced = new Set<string>()
  const toolContents = new Map<string, string[]>()
  for (const message of messages ?? []) {
    const content = message?.content
    if (typeof content !== 'string') continue
    if (message.role === 'tool' && message.tool_call_id) {
      const list = toolContents.get(message.tool_call_id)
      if (list) list.push(content)
      else toolContents.set(message.tool_call_id, [content])
    }
    if (!content.includes('[recall:')) continue
    for (const match of content.matchAll(/\[recall:([^\]\s]+)\]/g)) referenced.add(match[1])
  }
  return { referenced, toolContents }
}

export interface ArchiveReclaimOptions {
  /** Не освобождать записи моложе этого возраста (мс) — защита от гонки с
   *  персистом, который может ещё не видеть свежие ссылки. */
  keepRecentMs?: number
  /** Максимум освобождаемых записей за один вызов (по умолчанию — все). */
  limit?: number
}

export interface ArchiveReclaimReport {
  reclaimedIds: string[]
  freedChars: number
  keptReferenced: number
  keptLive: number
  keptRecent: number
}

/**
 * Джанитор рана: сжимает контекст в памяти. Принципы точности:
 *  - Активный хвост = последние janitorTailSteps ходов — не трогаем вовсе.
 *  - Заменяется ТОЛЬКО content у tool-результатов (парные tool_call остаются):
 *    структура сообщений валидна для провайдера, кэш инвалидируется минимально.
 *  - Свёрнутые сообщения помечаются janitorCollapsed: rereadGuard не считает
 *    их «контентом в контексте» — перечитывание после свёртки не блокируется.
 *  - Свежие чтения (файл не правился, не перекрыт) не трогаем: контент
 *    актуален, агент опирается на него в следующих правках (old_str).
 *  - Чтения с активной правкой (последняя правка файла — в активном хвосте)
 *    не трогаем: это живой срез файла для продолжающейся работы.
 *  - Перечитывания сворачиваются диапазонно: covered-правило; устаревшие
 *    чтения с завершённой работой сворачиваются с подсказкой перечитать.
 *  - Дедуп идентичных вызовов валиден, только если между ними не было мутаций.
 *  - Результаты правок (diff) и визуала никогда не сжимаются.
 *  - Бюджет архива (50 записей / 4M символов) учитывается счётчиками, а
 *    недостающее место освобождается только у недостижимых записей (нет
 *    `[recall:id]` в живой истории и нет оригинала в ней) — битых
 *    recall-ссылок не появляется.
 */
export class Janitor {
  private archive = new Map<string, JanitorArchiveEntry>()
  private pendingArchive = new Map<string, JanitorArchiveEntry>()
  /** Суммарный объём originalMessages — бюджет места считается за O(1) на
   *  кандидата. Перебор всех записей на каждого кандидата превращал скан с
   *  сотнями кандидатов в O(k·n) по большим строкам. */
  private archiveChars = 0
  private pendingChars = 0
  private archiveCounter = 0
  private lastScanRound = 0
  private lastScanState: unknown[] | null = null
  private lastScanPolicy = ''
  private settings: AssistantsSettings

  constructor(settings: AssistantsSettings) {
    this.settings = settings
  }

  updateSettings(settings: AssistantsSettings): void {
    if (JSON.stringify(settings) !== JSON.stringify(this.settings)) this.lastScanState = null
    this.settings = settings
  }

  shouldScan(currentRound: number, messages?: ChatMessage[], mode: 'light' | 'deep' = 'deep', tailStepsOverride?: number, force = false): boolean {
    if (!this.settings.enabled || !this.settings.janitorEnabled) return false
    if (!force && currentRound - this.lastScanRound < this.settings.janitorScanInterval) return false
    if (!messages) return true
    if (computeTailBoundary(messages, Math.max(1, tailStepsOverride ?? this.settings.janitorTailSteps ?? 10)) === 0) return false
    const state = this.scanState(messages)
    return this.lastScanPolicy !== this.scanPolicy(mode, tailStepsOverride)
      || !this.lastScanState || state.length !== this.lastScanState.length
      || state.some((value, index) => value !== this.lastScanState![index])
  }

  /** Compare string references/values without parsing or tokenizing old outputs.
   * Hints and plain assistant prose do not make an unproductive scan useful. */
  private scanState(messages: ChatMessage[]): unknown[] {
    const state: unknown[] = []
    for (const message of messages) {
      if (message.role === 'assistant' && message.tool_calls?.length) {
        state.push('assistant', message.tool_calls.length)
        for (const call of message.tool_calls) state.push(call.id, call.function?.name, call.function?.arguments)
      } else if (message.role === 'tool') {
        state.push('tool', message.tool_call_id, message.name, message.content, message.janitorProtected, message.imagePaths?.length)
      }
    }
    return state
  }

  private scanPolicy(mode: 'light' | 'deep', tailStepsOverride?: number): string {
    return `${mode}:${tailStepsOverride ?? 'normal'}`
  }

  scan(messages: ChatMessage[], currentRound: number, mode: 'light' | 'deep' = 'deep', tailStepsOverride?: number): JanitorReport {
    const start = Date.now()
    this.pendingArchive.clear()
    this.pendingChars = 0
    if (!this.settings.enabled || !this.settings.janitorEnabled) {
      return { actions: [], totalTokensSaved: 0, scannedMessages: messages.length, durationMs: 0 }
    }
    this.lastScanRound = currentRound
    this.lastScanState = this.scanState(messages)
    this.lastScanPolicy = this.scanPolicy(mode, tailStepsOverride)
    const total = messages.length
    // tailStepsOverride — emergency-режим economist'а (stage 2): активный хвост
    // режется вдвое, при реальном давлении на окно свежесть хвоста дешевле
    // переполнения контекста. Emergency также разрешает сжимать свежие чтения.
    const emergency = tailStepsOverride !== undefined
    const boundary = computeTailBoundary(messages, Math.max(1, tailStepsOverride ?? this.settings.janitorTailSteps ?? 10))

    // callId → аргументы; callId → индекс tool-сообщения. Анализ — по всей
    // истории (чтения в хвосте тоже перекрывают старые), замены — только
    // за границей хвоста.
    interface CallInfo { name: string; args: Record<string, unknown> | null }
    const callInfo = new Map<string, CallInfo>()
    const resultIndex = new Map<string, number>()
    const mutationIdxs: number[] = []
    const editsByPath = new Map<string, number[]>()
    const unknownMutIdxs: number[] = []
    for (let i = 0; i < total; i++) {
      const msg = messages[i]
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> | null = null
          try { args = JSON.parse(tc.function?.arguments ?? '{}') } catch { args = null }
          callInfo.set(tc.id, { name: tc.function?.name ?? '', args })
        }
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        resultIndex.set(msg.tool_call_id, i)
        const info = callInfo.get(msg.tool_call_id)
        if (info) {
          if (FILE_MUTATORS.has(info.name)) {
            const p = normalizePath(String(info.args?.path ?? ''))
            if (p) {
              const arr = editsByPath.get(p)
              if (arr) arr.push(i)
              else editsByPath.set(p, [i])
            }
            mutationIdxs.push(i)
          } else if (UNKNOWN_MUTATORS.has(info.name)) {
            unknownMutIdxs.push(i)
            mutationIdxs.push(i)
          }
        }
      }
    }

    const editedAfter = (path: string, idx: number): boolean => (editsByPath.get(path) ?? []).some(mi => mi > idx)
    const unknownAfter = (idx: number): boolean => unknownMutIdxs.some(mi => mi > idx)
    const hasMutationBetween = (a: number, b: number): boolean => mutationIdxs.some(mi => mi > a && mi < b)

    const contentOf = (i: number): string => {
      const c = messages[i]?.content
      return typeof c === 'string' ? c : ''
    }
    const frozen = (idx: number): boolean => idx >= boundary
    const protectedResult = (idx: number): boolean => !!messages[idx]?.janitorProtected
      || (messages[idx]?.imagePaths?.length ?? 0) > 0 || typeof messages[idx]?.content !== 'string'
    const summarized = (idx: number): boolean => contentOf(idx).includes(JANITOR_MARKER)
    const skippable = (idx: number): boolean => frozen(idx) || summarized(idx) || protectedResult(idx)

    // Замены: индекс tool-сообщения → финальный контент (с маркером).
    const replacements = new Map<number, string>()
    const reasons = new Map<number, { kind: JanitorActionKind; what: string; saved: number }>()
    const archiveIdByIndex = new Map<number, string>()

    // Бюджет архива: индекс живых ссылок строится лениво — только когда места
    // реально не хватает, и только один раз на скан. Освобождаем лишь записи,
    // на которые нет [recall:id] в текущей истории и чьих оригиналов в ней
    // больше нет; остальные (живые ссылки) не трогаем.
    let liveRefs: LiveMessageIndex | null = null
    const ensureArchiveRoom = (extraChars: number): boolean => {
      if (this.hasArchiveRoom(extraChars)) return true
      if (!liveRefs) liveRefs = indexLiveReferences(messages)
      this.reclaimArchiveIndexed(liveRefs)
      return this.hasArchiveRoom(extraChars)
    }

    const put = (idx: number, text: string, kind: JanitorActionKind, what: string): void => {
      if (replacements.has(idx) || skippable(idx)) return
      const content = contentOf(idx)
      let finalText = `${JANITOR_MARKER} ${text}`
      let archiveEntry: JanitorArchiveEntry | undefined
      if (kind === 'summarize_stale') {
        if (!messages[idx].tool_call_id) return
        const existing = this.findArchivedEntry(messages[idx].tool_call_id, content)
        if (!existing && !ensureArchiveRoom(content.length)) return
        const archiveId = existing?.id ?? `jan-${++this.archiveCounter}-${Date.now()}`
        archiveIdByIndex.set(idx, archiveId)
        finalText += ` [recall:${archiveId}]`
        archiveEntry = { id: archiveId, originalMessages: [{ ...messages[idx] }], summary: finalText, ts: existing?.ts ?? Date.now() }
      }
      // В той же шкале, что и снапшоты контекста (с калибровкой по реальным
      // prompt_tokens): иначе «−2459 tok» в карточке janitor'а и «≈1300»
      // в кольце — два разных числа об одном и том же сжатии.
      const saved = estimateTokensCalibrated(content) - estimateTokensCalibrated(finalText)
      if (saved < STALE_MIN_SAVED) return
      if (archiveEntry) {
        this.pendingArchive.set(archiveEntry.id, archiveEntry)
        this.pendingChars += this.entryChars(archiveEntry)
      }
      replacements.set(idx, finalText)
      reasons.set(idx, { kind, what, saved })
    }

    // 1) Дедуп: тот же тул с теми же аргументами. Не для чтений (их ведёт
    //    диапазонная логика ниже), не для мутаторов/pinned-тулов. Свёртка
    //    валидна, только если между повторами не было мутаций — иначе
    //    результаты могли различаться и «идентичен» было бы ложью.
    const byFingerprint = new Map<string, Array<{ name: string; idx: number }>>()
    for (const [callId, info] of callInfo) {
      if (!info.name || READ_TOOLS.has(info.name)) continue
      if (FILE_MUTATORS.has(info.name) || UNKNOWN_MUTATORS.has(info.name) || PINNED_TOOLS.has(info.name)) continue
      const ri = resultIndex.get(callId)
      // Recent results remain raw, but are valid anchors for older duplicates.
      if (ri === undefined || summarized(ri) || protectedResult(ri)) continue
      const key = `${info.name}|${stableStringify(info.args ?? {})}`
      const arr = byFingerprint.get(key)
      if (arr) arr.push({ name: info.name, idx: ri })
      else byFingerprint.set(key, [{ name: info.name, idx: ri }])
    }
    for (const arr of byFingerprint.values()) {
      arr.sort((x, y) => x.idx - y.idx)
      for (let k = 0; k < arr.length - 1; k++) {
        const a = arr[k]
        const content = contentOf(a.idx)
        if (content.length < MIN_STUB_CHARS) continue
        if (hasMutationBetween(a.idx, arr[k + 1].idx)) continue
        if (content !== contentOf(arr[k + 1].idx)) continue
        put(a.idx, `Повтор ${a.name}: тот же результат сохранён ниже.`, 'dedup_tool_call', `${a.name}: точный дубликат`)
      }
    }

    // 2) Перечитывания: диапазонная логика. Чтение сворачивается, только если
    //    (а) файл после него правился — чтение устарело, или (б) его диапазон
    //    строк полностью перекрыт более поздними чтениями того же файла.
    //    Иначе — информативное резюме: точно что прочитано и как.
    //    Анализ — по всей истории (чтение в хвосте тоже перекрывает старое),
    //    замена — только за границей хвоста.
    interface ReadOcc { idx: number; frozen: boolean; sections: ParsedReadSection[] }
    const readOccs: ReadOcc[] = []
    for (const [callId, info] of callInfo) {
      if (!READ_TOOLS.has(info.name)) continue
      const ri = resultIndex.get(callId)
      if (ri === undefined || summarized(ri) || protectedResult(ri)) continue
      readOccs.push({ idx: ri, frozen: frozen(ri), sections: parseReadSections(info.name, contentOf(ri)) })
    }
    readOccs.sort((x, y) => x.idx - y.idx)
    for (let k = 0; k < readOccs.length; k++) {
      const occ = readOccs[k]
      if (occ.frozen || replacements.has(occ.idx)) continue
      const content = contentOf(occ.idx)
      const later = readOccs.slice(k + 1)
      const decisions = occ.sections.map(sec => {
        if (hasIdenticalReadCoverage(sec, later.flatMap(o => o.sections))) return { sec, kind: 'covered' as const }
        if (editedAfter(sec.path, occ.idx)) return { sec, kind: 'stale-edit' as const }
        return { sec, kind: 'keep' as const }
      })
      const allCovered = decisions.length > 0 && decisions.every(d => d.kind === 'covered')
      const hasStale = decisions.some(d => d.kind === 'stale-edit')

      if (allCovered) {
        const list = decisions.map(d => `${d.sec.displayPath} (${d.sec.range ? `строки ${d.sec.range.from}-${d.sec.range.to}` : 'часть файла'}) — перекрыто свежим чтением ниже`).join('; ')
        put(occ.idx, `Результат чтения свёрнут: ${list}. При необходимости перечитай — свёртка не блокирует перечитывание.`, 'collapse_reread', 'перечитывание свёрнуто')
        continue
      }

      if (hasStale && decisions.every(d => d.kind !== 'keep')) {
        // B: правки по файлу продолжаются СЕЙЧАС (последняя — в активном хвосте)
        // → чтение и есть живой срез файла, патчить/сжимать нельзя: на его
        // точные строки агент опирается в следующих old_str. Работа с файлом
        // ушла в историю → свёртка; точный контент агент доберёт перечитыванием
        // (rereadGuard свёрнутое «контентом» не считает — см. hasReadInContext).
        let lastEditIdx = -1
        for (const d of decisions) {
          for (const ei of editsByPath.get(d.sec.path) ?? []) {
            if (ei > occ.idx && ei > lastEditIdx) lastEditIdx = ei
          }
        }
        if (lastEditIdx >= boundary) continue // активная правка — не трогаем
        const list = decisions.map(d => `${d.sec.displayPath} (${d.sec.range ? `строки ${d.sec.range.from}-${d.sec.range.to}` : 'часть файла'}) — устарело: файл правился после чтения`).join('; ')
        put(occ.idx, `Результат чтения свёрнут: ${list}. Исходная версия сохранена в архиве контекста.`, 'summarize_stale', 'сохранён снимок старой версии файла')
        continue
      }

      // A: свежее чтение (файл не правился, не перекрыто) — контент актуален
      // на 100%, не трогаем вовсе. Сжимаем только в emergency-скане
      // (economist stage 2): под реальным давлением экономика важнее.
      if (emergency && mode === 'deep' && content.length >= STALE_MIN_CHARS) {
        const note = unknownAfter(occ.idx)
          ? 'после чтения выполнялись команды — файл мог измениться'
          : 'правок файла после чтения в истории нет, при необходимости перечитай с нужным offset'
        const name = callInfo.get(messages[occ.idx].tool_call_id ?? '')?.name ?? 'read_file'
        put(occ.idx, summarizeToolResult(name, content, undefined, note), 'summarize_stale', `чтение → резюме (emergency)`)
      }
    }

    // 3) Старьё: прочие большие результаты старых сообщений → структурное
    //    резюме с атрибуцией. Результаты правок (diff) не трогаем — они
    //    несут уникальное состояние файлов.
    if (mode === 'deep') {
      for (let i = 0; i < boundary; i++) {
        if (replacements.has(i)) continue
        const msg = messages[i]
        if (msg.role !== 'tool' || !msg.tool_call_id) continue
        if (skippable(i)) continue
        const info = callInfo.get(msg.tool_call_id)
        if (!info) continue
        if (PINNED_TOOLS.has(info.name) || FILE_MUTATORS.has(info.name) || READ_TOOLS.has(info.name)) continue
        const content = contentOf(i)
        if (content.length < STALE_MIN_CHARS) continue
        const detail = toolCallDetail(info.args)
        put(i, summarizeToolResult(info.name, content, detail || undefined), 'summarize_stale', `[${info.name}] ${content.length} симв → резюме`)
      }
    }

    if (replacements.size === 0) {
      return { actions: [], totalTokensSaved: 0, scannedMessages: total, durationMs: Date.now() - start }
    }

    // Отчёт: по одному действию на каждую замену — описание честно говорит,
    // что именно свёрнуто и почему (UI рендерит их списком в карточке).
    const actions: JanitorAction[] = []
    for (const [idx, finalText] of replacements) {
      const { kind, what, saved } = reasons.get(idx)!
      actions.push({
        kind,
        messageIndices: [idx],
        description: `${what} (−${saved} ток.)`,
        tokensSaved: saved,
        replacement: finalText,
        ...(kind === 'summarize_stale' ? { archiveId: archiveIdByIndex.get(idx) } : {}),
      })
    }
    const totalTokensSaved = actions.reduce((s, a) => s + a.tokensSaved, 0)
    return { actions, totalTokensSaved, scannedMessages: total, durationMs: Date.now() - start }
  }

  apply(messages: ChatMessage[], report: JanitorReport): ChatMessage[] {
    if (report.actions.length === 0) return messages
    const result = [...messages]
    for (const action of report.actions) {
      for (const idx of action.messageIndices) {
        const msg = result[idx]
        if (!msg || msg.role !== 'tool' || typeof msg.content !== 'string') continue
        if (action.kind === 'summarize_stale' && action.archiveId) {
          const entry = this.pendingArchive.get(action.archiveId) ?? this.archive.get(action.archiveId)
          if (!entry || entry.originalMessages[0]?.content !== msg.content) continue
          this.commitArchiveEntry(entry)
        }
        const text = action.replacement ?? `${JANITOR_MARKER} ${action.description}`
        result[idx] = { ...msg, content: text, janitorCollapsed: true }
      }
    }
    this.pendingArchive.clear()
    this.pendingChars = 0
    this.lastScanState = this.scanState(result)
    return result
  }

  recall(archiveId: string): ChatMessage[] | null {
    return this.archive.get(archiveId)?.originalMessages ?? null
  }

  recallPage(archiveId: string, offset = 0, limit = 4000): string | null {
    const original = this.recall(archiveId)
    if (!original) return null
    const text = original.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
    const count = Number.isFinite(limit) ? Math.max(1, Math.min(8000, Math.floor(limit))) : 4000
    const end = Math.min(text.length, start + count)
    return `[recall:${archiveId} | chars ${start}-${end} of ${text.length}${end < text.length ? ` | next offset=${end}` : ''}]\n${text.slice(start, end)}`
  }

  getArchiveSize(): number {
    return this.archive.size
  }

  /** Текущий объём архива в символах оригиналов (учёт бюджета — O(1)). */
  getArchiveChars(): number {
    return this.archiveChars
  }

  /**
   * Освобождает место в архиве, не порождая битых `[recall:id]`.
   *
   * Запись удаляется, только если одновременно:
   *  1. на неё нет ссылки `[recall:id]` ни в одном переданном live-сообщении
   *     (иначе модель получила бы ссылку в пустоту);
   *  2. её оригинал больше не лежит в переданных live-сообщениях (тот же
   *     tool_call_id + точный контент) — вспоминать нечего;
   *  3. она старше keepRecentMs.
   *
   * Персист: уникальные tool-результаты остаются в БД сырыми, а постоянная
   * компрессия БД (historyCompressor) пишет резюме БЕЗ recall-ссылок.
   * Значит удаление записи из памяти не порождает битую ссылку в сохранённой
   * истории: при рестарте `restoreSummaries` восстановит по записи только то,
   * что осталось в архиве, а остальное прочитается из БД сырым. Поэтому
   * «безопасно освободить» = «оригинала нет в live + ссылок нет».
   */
  reclaimArchive(messages: ChatMessage[], options: ArchiveReclaimOptions = {}): ArchiveReclaimReport {
    return this.reclaimArchiveIndexed(indexLiveReferences(messages), options)
  }

  /** Снимок архива для персиста (recorder пишет per chat — worker живёт
   *  один запрос, без этого [recall:id] в истории БД теряют источник). */
  getArchiveEntries(): JanitorArchiveEntry[] {
    return [...this.archive.values()]
  }

  /** Восстановление архива из персиста. Дедуп по id, счётчик jan-N
   *  отводится дальше восстановленных, чтобы новые id не пересекались. */
  hydrateArchive(entries: JanitorArchiveEntry[]): void {
    for (const e of entries ?? []) {
      if (!e?.id || !Array.isArray(e.originalMessages) || typeof e.summary !== 'string' || this.archive.has(e.id)) continue
      // Бюджет — по счётчику, без пересчёта всех записей на каждую входящую.
      if (this.archive.size >= MAX_JANITOR_ARCHIVE_ENTRIES
        || this.archiveChars + this.entryChars(e) > MAX_JANITOR_ARCHIVE_CHARS) continue
      const summary = e.summary.includes(JANITOR_MARKER) ? e.summary : `${JANITOR_MARKER} ${e.summary} [recall:${e.id}]`
      this.commitArchiveEntry({ ...e, summary })
      const m = /^jan-(\d+)-/.exec(e.id)
      if (m) this.archiveCounter = Math.max(this.archiveCounter, Number(m[1]))
    }
  }

  /** Reapply committed summaries when a new worker reconstructs raw DB history. */
  restoreSummaries(messages: ChatMessage[]): void {
    for (const entry of this.archive.values()) {
      const original = entry.originalMessages[0]
      if (!original?.tool_call_id) continue
      for (const message of messages) {
        if (message.role === 'tool' && message.tool_call_id === original.tool_call_id && message.content === original.content) {
          message.content = entry.summary
          message.janitorCollapsed = true
        }
      }
    }
  }

  private entryChars(entry: JanitorArchiveEntry): number {
    return entry.originalMessages.reduce((n, message) => n + (typeof message?.content === 'string' ? message.content.length : JSON.stringify(message?.content ?? '').length), 0)
  }

  /** Учёт бюджета места: архив + ещё не принятые (pending) записи скана. */
  private hasArchiveRoom(extraChars: number): boolean {
    return this.archive.size + this.pendingArchive.size < MAX_JANITOR_ARCHIVE_ENTRIES
      && this.archiveChars + this.pendingChars + Math.max(0, extraChars) <= MAX_JANITOR_ARCHIVE_CHARS
  }

  /** Поиск уже архивированного оригинала по callId+контенту без копирования
   *  обоих словарей в массив на каждого кандидата. */
  private findArchivedEntry(toolCallId: string, content: string): JanitorArchiveEntry | undefined {
    for (const entry of this.archive.values()) {
      const original = entry.originalMessages[0]
      if (original?.tool_call_id === toolCallId && original.content === content) return entry
    }
    for (const entry of this.pendingArchive.values()) {
      const original = entry.originalMessages[0]
      if (original?.tool_call_id === toolCallId && original.content === content) return entry
    }
    return undefined
  }

  /** Фиксация записи в архиве с поддержкой счётчика объёма. */
  private commitArchiveEntry(entry: JanitorArchiveEntry): void {
    const previous = this.archive.get(entry.id)
    if (previous === entry) return
    if (previous) this.archiveChars = Math.max(0, this.archiveChars - this.entryChars(previous))
    this.archive.set(entry.id, entry)
    this.archiveChars += this.entryChars(entry)
    this.lastScanState = null
  }

  private reclaimArchiveIndexed(live: LiveMessageIndex, options: ArchiveReclaimOptions = {}): ArchiveReclaimReport {
    const report: ArchiveReclaimReport = { reclaimedIds: [], freedChars: 0, keptReferenced: 0, keptLive: 0, keptRecent: 0 }
    if (this.archive.size === 0) return report
    const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.limit))
    if (limit <= 0) return report
    const keepRecentMs = Math.max(0, options.keepRecentMs ?? 0)
    const now = Date.now()
    for (const [id, entry] of this.archive) {
      if (report.reclaimedIds.length >= limit) break
      if (live.referenced.has(id)) { report.keptReferenced++; continue }
      const original = entry.originalMessages[0]
      const stillLive = original && typeof original.content === 'string'
        && (live.toolContents.get(String(original.tool_call_id ?? ''))?.some(c => c === original.content) ?? false)
      if (stillLive) { report.keptLive++; continue }
      if (keepRecentMs > 0 && now - entry.ts < keepRecentMs) { report.keptRecent++; continue }
      const chars = this.entryChars(entry)
      this.archive.delete(id)
      this.archiveChars = Math.max(0, this.archiveChars - chars)
      report.reclaimedIds.push(id)
      report.freedChars += chars
    }
    if (report.reclaimedIds.length) this.lastScanState = null
    return report
  }

  /** Устаревшие записи: только те, что старше maxAgeMs И недостижимы из
   *  переданной истории. Записи с живой ссылкой [recall:id] остаются всегда —
   *  иначе в контексте появились бы битые recall-ссылки. */
  pruneArchive(maxAgeMs: number, messages: ChatMessage[] = []): ArchiveReclaimReport {
    return this.reclaimArchive(messages, { keepRecentMs: Math.max(0, maxAgeMs) })
  }
}
