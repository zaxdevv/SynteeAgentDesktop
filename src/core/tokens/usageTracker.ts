/**
 * Usage Tracker — единый источник истины для подсчёта токенов и стоимости сессии.
 *
 * Заменяет TokenCounter.ts (удалён) и дублирующий encoder из contextManager.ts.
 * Использует js-tiktoken (cl100k_base) с кэшированным энкодером.
 *
 * Реальные usage-данные от провайдера имеют приоритет над tiktoken-оценкой.
 */

import { getEncoding } from 'js-tiktoken'
import { getExactCatalogModel } from './modelCatalog'
import { getGatewayModelsCache, GATEWAY_PROVIDER_ID } from './gatewayModelsCache'
import { BUILTIN_MODELS } from '../../shared/data/builtinModels'
import { IMAGE_TOKEN_COST } from '../../shared/imageFormat'
import type { ModelPrice } from './ModelPricing'
import { API_OVERHEAD_TOKENS, contextPct, contextStatus } from '../../shared/contextUsage'
import type { ModelMeta } from '../../shared/types'

// ─── Кэшированный энкодер ──────────────────────────────────────────────────────

let _enc: ReturnType<typeof getEncoding> | null = null
function getEncoder(): ReturnType<typeof getEncoding> {
  if (!_enc) _enc = getEncoding('cl100k_base')
  return _enc
}

// ─── Точные оценки через tiktoken ──────────────────────────────────────────────

// LRU-кэш результатов estimateTokens. Текст часто повторяется (system prompt,
// tool schemas, старые сообщения) — tiktoken-encode дорогой, нет смысла
// считать дважды для того же текста.
const _tokenCache = new Map<string, { tokens: number; bytes: number }>()
const TOKEN_CACHE_MAX_ENTRIES = 500
const TOKEN_CACHE_MAX_BYTES = 4 * 1024 * 1024
let _tokenCacheBytes = 0
const _messageTokenCache = new Map<string, { tokens: number; bytes: number }>()
const MESSAGE_TOKEN_CACHE_MAX_ENTRIES = 1_000
const MESSAGE_TOKEN_CACHE_MAX_BYTES = 8 * 1024 * 1024
let _messageTokenCacheBytes = 0
const _utf8Encoder = new TextEncoder()

/** Exact-text LRU. UTF-8 byte accounting bounds retained text independently of entry count. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cached = _tokenCache.get(text)
  if (cached !== undefined) {
    _tokenCache.delete(text)
    _tokenCache.set(text, cached)
    return cached.tokens
  }
  let result: number
  try {
    // Treat special-token spellings as ordinary text. Token counting must not
    // throw (or use an approximate fallback) when user content contains them.
    result = getEncoder().encode(text, [], ['all']).length
  } catch {
    result = Math.ceil(text.length / 3.5)
  }
  const bytes = _utf8Encoder.encode(text).byteLength
  if (bytes <= TOKEN_CACHE_MAX_BYTES) {
    while (_tokenCache.size >= TOKEN_CACHE_MAX_ENTRIES || _tokenCacheBytes + bytes > TOKEN_CACHE_MAX_BYTES) {
      const oldest = _tokenCache.keys().next().value
      if (oldest === undefined) break
      const entry = _tokenCache.get(oldest)!
      _tokenCache.delete(oldest)
      _tokenCacheBytes -= entry.bytes
    }
    _tokenCache.set(text, { tokens: result, bytes })
    _tokenCacheBytes += bytes
  }
  return result
}

/** Exposed for deterministic tests/maintenance; does not affect token results. */
export function clearTokenCountCache(): void {
  _tokenCache.clear()
  _tokenCacheBytes = 0
  _messageTokenCache.clear()
  _messageTokenCacheBytes = 0
}

type MessageLike = {
  role: string
  content: string | Array<{ type: string; text?: string; image_url?: unknown }>
  tool_calls?: unknown
  tool_call_id?: string
  name?: string
  reasoning_content?: string
  thinking_blocks?: Array<{ thinking: string; signature: string }>
}

/**
 * Сколько изображений в multipart-контенте сообщения.
 *
 * Раньше визуальные парты игнорировались полностью: из контента брались только
 * `text`, поэтому 30 МБ пикселей давали «0 токенов». Оценка контекста показывала
 * 25-30%, аварийный клапан не срабатывал, а провайдер отвечал 413 — и чат падал
 * без видимой причины. Теперь каждая картинка имеет цену (IMAGE_TOKEN_COST),
 * так что и контекст-бар, и клапан видят визуальную нагрузку.
 */
function countImageParts(content: MessageLike['content']): number {
  if (!Array.isArray(content)) return 0
  let images = 0
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'image_url' || part.type === 'input_image') images++
  }
  return images
}

/**
 * Reasoning одного сообщения — как список строк, которые РЕАЛЬНО попадают
 * в счёт провайдера.
 *
 * Замерено на живых чатах (диагностика по syntee.db + prompt_tokens от API):
 *   chat 6c9b7189: content 132 453 + tool_calls 42 353 + overhead 2 096
 *                  + system/tools ≈ 206k  →  real 207 491
 *                  а reasoning_content в истории весит ещё 191 375 токенов;
 *   chat a91ae98a: content 113 130 + tool_calls 77 696 + overhead 2 760
 *                  + system/tools ≈ 218k  →  real 219 382
 *                  reasoning_content в истории — 172 322 токена.
 *
 * То есть `reasoning_content` в исторических assistant-сообщениях провайдер
 * НЕ считает (DeepSeek/gateway поле принимают, но в prompt_tokens не включают).
 * Мы же его отправляем (LiteLLM-прокси для GLM иначе отдаёт 400), и старая
 * оценка складывала его в контекст — отсюда «накручено на 100k+».
 *
 * `thinking_blocks` (нативный Anthropic extended thinking) — наоборот, часть
 * входа и считается. Поэтому: считаем блоки, reasoning_content — никогда.
 * Остаточный перекос для моделей, которые reasoning_content всё же учитывают,
 * выравнивает калибровка (recordEstimateCalibration).
 *
 * Единый источник и для синхронного, и для Rust-пути (parity обязательна:
 * иначе оценка зависит от того, доступен ли sidecar).
 */
function reasoningParts(m: MessageLike): string[] {
  const blocks = m.thinking_blocks ?? []
  if (blocks.length) return blocks.flatMap(block => [block.thinking, block.signature])
  return []
}

function lookupMessageTokens(fingerprint: string): number | undefined {
  const cached = _messageTokenCache.get(fingerprint)
  if (cached) {
    _messageTokenCache.delete(fingerprint)
    _messageTokenCache.set(fingerprint, cached)
    return cached.tokens
  }
  return undefined
}

function cacheMessageTokens(fingerprint: string, tokens: number): void {
  const bytes = _utf8Encoder.encode(fingerprint).byteLength
  if (bytes <= MESSAGE_TOKEN_CACHE_MAX_BYTES) {
    const existing = _messageTokenCache.get(fingerprint)
    if (existing) {
      _messageTokenCache.delete(fingerprint)
      _messageTokenCacheBytes -= existing.bytes
    }
    while (_messageTokenCache.size >= MESSAGE_TOKEN_CACHE_MAX_ENTRIES || _messageTokenCacheBytes + bytes > MESSAGE_TOKEN_CACHE_MAX_BYTES) {
      const oldest = _messageTokenCache.keys().next().value
      if (oldest === undefined) break
      const entry = _messageTokenCache.get(oldest)!
      _messageTokenCache.delete(oldest)
      _messageTokenCacheBytes -= entry.bytes
    }
    _messageTokenCache.set(fingerprint, { tokens, bytes })
    _messageTokenCacheBytes += bytes
  }
}

function estimateMessageTokens(message: MessageLike): number {
  const { parts, overhead, key } = messageTokenInputs(message)
  const cached = lookupMessageTokens(key)
  if (cached !== undefined) return cached
  const tokens = parts.reduce((sum, text) => sum + estimateTokens(text), overhead)
  cacheMessageTokens(key, tokens)
  return tokens
}

export function estimateMessagesTokensFull(messages: Array<MessageLike>): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
}

/** Тонкая обёртка над estimateMessagesTokensFull (обратная совместимость). */
export function estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  return estimateMessagesTokensFull(messages as MessageLike[])
}

// ─── Remote (Rust) token counting ─────────────────────────────────────────────
//
// `js-tiktoken` is a pure-JS BPE: encoding a 200-300k-token history costs
// 0.5-2s of CPU on whatever thread calls it. When that thread is the main
// process it blocks IPC and rendering.
//
// The Rust sidecar ships the same cl100k_base tables natively, so the heavy
// callers ask it instead. The counter is *injected* rather than imported so this
// module stays free of node built-ins — the renderer pulls DEFAULT_CONTEXT_SETTINGS
// out of contextManager, which imports this file.
//
// Behaviour when no counter is installed (renderer, tests, sidecar missing):
// every async helper transparently falls back to the synchronous JS estimate.
// Counts are identical either way, only the thread that does the work changes.

export interface RemoteTokenCounter {
  /** Exact counts for many strings in one round-trip; null when unavailable. */
  countBatch(texts: string[]): Promise<number[] | null>
  truncate(text: string, maxTokens: number): Promise<{ text: string; tokens: number; truncated: boolean }>
}

let _remoteCounter: RemoteTokenCounter | null = null

/** Installed by the main process / ai-worker once the sidecar client is ready. */
export function setRemoteTokenCounter(counter: RemoteTokenCounter | null): void {
  _remoteCounter = counter
}

export function hasRemoteTokenCounter(): boolean {
  return _remoteCounter !== null
}

/** All strings that contribute tokens to one message, in a stable order. */
function messageTokenParts(m: MessageLike): string[] {
  const contentStr = typeof m.content === 'string'
    ? m.content
    : (Array.isArray(m.content) ? m.content.map(p => 'text' in p ? (p as { text: string }).text : '').join('') : '')
  const parts: string[] = [contentStr || '']
  if (m.tool_calls && Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
      try {
        const encoded = JSON.stringify(tc)
        if (encoded) parts.push(encoded)
      } catch { /* Unserializable tool call. */ }
    }
  }
  if (m.tool_call_id) parts.push(m.tool_call_id)
  if (m.name) parts.push(m.name)
  parts.push(...reasoningParts(m))
  return parts
}

function messageTokenInputs(message: MessageLike): { parts: string[]; overhead: number; key: string } {
  const parts = messageTokenParts(message)
  const overhead = 4 + countImageParts(message.content) * IMAGE_TOKEN_COST
  // Only fields contributing to the estimate belong in the key. In particular,
  // image bytes and compatibility reasoning echoes can be several megabytes.
  return { parts, overhead, key: JSON.stringify([overhead, parts]) }
}

/**
 * Same result as estimateMessagesTokensFull, but the BPE work happens in Rust
 * off the calling thread. Falls back to the synchronous estimate when the
 * sidecar is unavailable or returns a malformed batch.
 */
export async function estimateMessagesTokensAsync(messages: Array<MessageLike>): Promise<number> {
  if (messages.length === 0) return 0
  const counter = _remoteCounter
  if (!counter) return estimateMessagesTokensFull(messages)

  const parts: string[] = []
  const misses = new Map<string, { start: number; end: number; overhead: number; occurrences: number }>()
  let total = 0
  for (const message of messages) {
    const inputs = messageTokenInputs(message)
    const cached = lookupMessageTokens(inputs.key)
    if (cached !== undefined) {
      total += cached
      continue
    }
    const pending = misses.get(inputs.key)
    if (pending) {
      pending.occurrences++
      continue
    }
    const start = parts.length
    parts.push(...inputs.parts)
    misses.set(inputs.key, { start, end: parts.length, overhead: inputs.overhead, occurrences: 1 })
  }
  if (parts.length === 0) return total

  let counts: number[] | null
  try {
    counts = await counter.countBatch(parts)
  } catch {
    counts = null
  }
  if (!counts || counts.length !== parts.length || counts.some(count => !Number.isSafeInteger(count) || count < 0)) {
    return estimateMessagesTokensFull(messages)
  }

  for (const [key, { start, end, overhead, occurrences }] of misses) {
    let tokens = overhead
    for (let i = start; i < end; i++) tokens += counts[i]
    cacheMessageTokens(key, tokens)
    total += tokens * occurrences
  }
  return total
}

/**
 * Cut text to a token budget without splitting a word. Prefers the Rust
 * implementation; the JS path is only used when the sidecar is unavailable.
 */
export async function truncateToTokensAsync(
  text: string,
  maxTokens: number,
): Promise<{ text: string; tokens: number; truncated: boolean }> {
  const counter = _remoteCounter
  if (counter) {
    try {
      const result = await counter.truncate(text, maxTokens)
      // Trim a partially cut trailing word so the summary does not end mid-word.
      const trimmed = result.truncated ? result.text.replace(/\s+\S*$/, '') : result.text
      return { text: trimmed, tokens: result.tokens, truncated: result.truncated }
    } catch { /* fall through to the JS path */ }
  }
  if (estimateTokens(text) <= maxTokens) return { text, tokens: estimateTokens(text), truncated: false }
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(text.slice(0, middle)) <= maxTokens) low = middle
    else high = middle - 1
  }
  const prefix = text.slice(0, low)
  const trimmed = /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix
  return { text: trimmed, tokens: estimateTokens(trimmed), truncated: true }
}

// ─── Единые пороги компакции контекста ────────────────────────────────────────
// Раньше Agent.ts (аварийный клапан dropOldestRoundsIfOverflow) и
// chat.ipc.ts (applyRollingWindowAsync) считали пороги по-разному и от разных
// оценок contextWindow (Agent.ts занижал пол до 32k) — это давало пилообразные
// скачки реального prompt_tokens. Теперь оба места берут проценты отсюда.

// Аварийный клапан — последняя линия защиты от hard-fail API. Держим близко
// к 100%, он не должен быть рабочим механизмом компакции (эту роль играет
// rolling window).
export const HARD_LIMIT_PCT = 99
// После срабатывания клапана — целимся сюда (% от contextWindow, не от
// hard-лимита), с явным запасом (гистерезис), чтобы клапан не триггерился
// повторно на следующем же раунде из-за пары новых сообщений.
export const HARD_LIMIT_TARGET_PCT = 80

// Rolling window (между сообщениями пользователя, chat.ipc.ts) — срабатывает
// раньше аварийного клапана, с summary вместо жёсткого дропа.
export const ROLLING_TRIGGER_PCT = 92

export function getHardLimitTokens(contextWindow: number): number {
  return Math.floor(contextWindow * HARD_LIMIT_PCT / 100)
}

export function getHardLimitTargetTokens(contextWindow: number): number {
  return Math.floor(contextWindow * HARD_LIMIT_TARGET_PCT / 100)
}

// ─── Снапшоты использования ───────────────────────────────────────────────────

export interface RealUsage {
  promptTokens: number
  completionTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface UsageSnapshot {
  estimated: number
  /** Uncalibrated token estimate for comparison with the same request's provider usage. */
  calibrationBaseTokens?: number
  limit: number
  pct: number
  status: 'ok' | 'warn' | 'critical'
  source: 'real' | 'estimate'
  breakdown: {
    history: number
    system: number
    tools: number
    current: number
    toolResults?: number
    protocol?: number
    completionTokens?: number
    // Prompt caching: токены, прочитанные из кэша (со скидкой) и записанные в кэш
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  compressed?: boolean
  sessionCostCents?: number | null
  sessionRequests?: number
}

// Overhead константы — единственный источник истины. contextManager.ts и
// Agent.ts импортируют TOOL_SCHEMAS_OVERHEAD отсюда (раньше значение было
// продублировано в нескольких местах с риском рассинхрона).
export const TOOL_SCHEMAS_OVERHEAD = 4200
const API_OVERHEAD = API_OVERHEAD_TOKENS

// ─── Калибровка оценки по реальным токенам ───────────────────────────────────
//
// tiktoken (cl100k_base) — не токенизатор модели. Для русского текста и кода
// он даёт систематически больше токенов, чем реальные токенизаторы современных
// моделей: на живых логах оценка истории 478k против реальных 252k (×1.9).
// Пороги компакции и «аварийный клапан» считают по оценке, поэтому завышение
// вредно: клапан срабатывает раньше, а кольцо показывает цифру, которой нет.
//
// Лечим без смены токенизатора: после каждого real-ответа провайдера знаем
// точное значение и сравниваем с оценкой того же запроса → ведём EWMA-коэффициент
// на пару provider:model. Коэффициент применяется к следующим оценкам.
// Калибровка живёт в памяти процесса; main персистит её (electron-store) и
// передаёт воркерам через workerData при старте.

const CALIBRATION_MIN = 0.35
const CALIBRATION_MAX = 1.5
const CALIBRATION_ALPHA = 0.3
/**
 * Версия семантики оценки. Меняется при ЛЮБОМ изменении того, что входит в
 * estimateMessagesTokens (сейчас — исключение reasoning_content из счёта).
 * Коэффициенты, выученные на старой семантике, несовместимы: они компенсировали
 * прошлый перекос и теперь занизили бы контекст. Входит в ключ, поэтому старые
 * записи просто перестают читаться и не требуют миграции стора.
 */
const CALIBRATION_EPOCH = 'v3'
const _calibration = new Map<string, number>()
let _calibrationKey = ''
let _calibrationListener: ((entries: Record<string, number>) => void) | null = null

/** main: вызывается при изменении — чтобы сохранить коэффициенты в стор. */
export function setCalibrationListener(listener: ((entries: Record<string, number>) => void) | null): void {
  _calibrationListener = listener
}

/** Ключ калибровки пары provider:model — единая формула для всех вызывающих. */
export function calibrationKey(providerId: string | undefined, modelId: string | undefined): string {
  return providerId || modelId ? `${CALIBRATION_EPOCH}:${providerId ?? ''}:${modelId ?? ''}` : ''
}

/**
 * Модель по умолчанию для текущего потока (воркер обслуживает один ран).
 *
 * В main-процессе параллельно живут разные чаты с разными моделями, поэтому
 * там ключ передаётся явно в опциях снапшота и в recordEstimateCalibration —
 * иначе расчёт для чата B мог бы применить коэффициент чата A.
 */
export function setCalibrationModel(providerId: string, modelId: string): void {
  _calibrationKey = calibrationKey(providerId, modelId)
}

export function exportCalibration(): Record<string, number> {
  return Object.fromEntries(_calibration)
}

/** main (из стора) и worker (из workerData) загружают общие коэффициенты. */
export function importCalibration(entries: Record<string, number> | undefined | null): void {
  if (!entries) return
  for (const [key, value] of Object.entries(entries)) {
    if (key.startsWith(CALIBRATION_EPOCH + ':') && typeof value === 'number' && Number.isFinite(value)
      && value >= CALIBRATION_MIN && value <= CALIBRATION_MAX) _calibration.set(key, value)
  }
}

/**
 * Учимся на паре «оценка того же запроса → реальный prompt_tokens».
 * Игнорируем выбросы: real должен быть в пределах 0.3x…3x от оценки, иначе
 * это не систематическая ошибка токенизатора, а другой запрос.
 *
 * `key` — явная пара provider:model (main-процесс); без него берётся
 * активная модель потока (воркер).
 */
export function recordEstimateCalibration(
  estimated: number,
  realTokens: number,
  key: string = _calibrationKey,
): void {
  if (!key || !Number.isFinite(estimated) || estimated <= 0 || !Number.isFinite(realTokens) || realTokens <= 0) return
  const ratio = realTokens / estimated
  if (ratio < 0.3 || ratio > 3) return
  const previous = _calibration.get(key)
  // Первое наблюдение берём целиком (alpha=1): ждать 5-6 раундов EWMA опасно —
  // всё это время кольцо и пороги компакции работают на неверной шкале.
  const alpha = previous === undefined ? 1 : CALIBRATION_ALPHA
  const base = previous ?? 1
  const next = Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, base * (1 - alpha) + ratio * alpha))
  if (previous !== undefined && Math.abs(next - previous) < 0.005) return
  _calibration.set(key, next)
  try { _calibrationListener?.(exportCalibration()) } catch { /* калибровка не должна ломать подсчёт */ }
}

/** Текущий коэффициент (1 — калибровки ещё нет). */
export function estimateCalibrationFactor(key: string = _calibrationKey): number {
  return (key && _calibration.get(key)) || 1
}

/**
 * Оценка текста в той же шкале, что и снапшоты контекста (с калибровкой).
 *
 * Нужна всем, кто показывает «сэкономлено токенов» (janitor, economist):
 * иначе цифра считается сырым cl100k (×1.9 к реальности), а рядом в кольце
 * контекста стоит калиброванное значение — два разных числа про одно и то же.
 */
export function estimateTokensCalibrated(text: string, key: string = _calibrationKey): number {
  return Math.round(estimateTokens(text) * estimateCalibrationFactor(key))
}

export function buildSnapshotFromReal(
  real: RealUsage,
  limit: number,
  prevBreakdown?: UsageSnapshot['breakdown'],
): UsageSnapshot {
  const pct = contextPct(real.promptTokens, limit)
  const status = contextStatus(pct)

  // Providers report a total, so category counts are apportioned estimates.
  // Round cumulative totals to keep every share nonnegative and their sum exact.
  const breakdown: UsageSnapshot['breakdown'] = {
    history: 0, system: 0, tools: 0, current: 0,
    completionTokens: real.completionTokens,
    cacheReadTokens: real.cacheReadTokens,
    cacheWriteTokens: real.cacheWriteTokens,
  }
  const categories = ['history', 'system', 'tools', 'current', 'toolResults', 'protocol'] as const
  const baseSum = categories.reduce((sum, key) => sum + (prevBreakdown?.[key] ?? 0), 0)
  if (baseSum > 0) {
    let subtotal = 0
    let allocated = 0
    for (const key of categories) {
      subtotal += prevBreakdown?.[key] ?? 0
      const next = Math.round(subtotal / baseSum * real.promptTokens)
      breakdown[key] = next - allocated
      allocated = next
    }
  }

  return {
    estimated: real.promptTokens,
    limit,
    pct,
    status,
    source: 'real',
    breakdown,
  }
}

/**
 * Единая функция оценки контекста для всех эмиттеров context_usage (chat:send,
 * context:calculate, Agent.onContextUpdate, AIClient.onContextCounted).
 * Заменяет разрозненные inline-формулы и гарантирует консистентный breakdown.
 *
 * `messages` — массив сообщений как есть (может включать system[0], историю
 * с tool_calls/tool results, текущее user-сообщение или нет — зависит от
 * вызывающего кода). Функция НЕ добавляет и НЕ убирает system/current сама;
 * опции `systemPrompt` / `currentMsgTokens` задаются отдельно, чтобы
 * вызывающий код контролировал семантику.
 *
 *   history = estimateMessagesTokensFull(messages)   // всё что передано
 *   system = opts.systemPrompt ? estimateTokens+4 : 0
 *   tools  = opts.includeToolSchemas ? TOOL_SCHEMAS_OVERHEAD : 0
 *   current= opts.currentMsgTokens ?? 0
 *   estimated = history + system + tools + current + API_OVERHEAD
 */
export function computeContextSnapshot(
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: unknown }>; tool_calls?: unknown; tool_call_id?: string; name?: string }>,
  limit: number,
  opts: {
    systemPrompt?: string
    currentMsgTokens?: number
    includeToolSchemas?: boolean
    /** Exact schemas sent to the model (including enabled external tools). */
    toolSchemas?: unknown[]
    toolResultTokens?: number
    /** Явная пара provider:model (main-процесс); иначе активная модель потока. */
    calibrationKey?: string
  } = {},
): UsageSnapshot {
  // Калибровка: tiktoken ≠ токенизатор модели. Коэффициент выучен на реальных
  // prompt_tokens (recordEstimateCalibration) и применяется ко всем частям,
  // чтобы сумма breakdown оставалась равной estimated.
  const factor = estimateCalibrationFactor(opts.calibrationKey)
  const scale = (value: number): number => Math.round(value * factor)
  let dialogTokens = 0
  let resultsTokens = opts.toolResultTokens ?? 0
  for (const message of messages) {
    const tokens = estimateMessageTokens(message)
    if (message.role === 'tool') resultsTokens += tokens
    else dialogTokens += tokens
  }
  const systemTokens = opts.systemPrompt ? estimateTokens(opts.systemPrompt) + 4 : 0
  const schemasTokens = opts.includeToolSchemas === true
    ? opts.toolSchemas !== undefined
      ? (opts.toolSchemas.length ? estimateTokens(JSON.stringify(opts.toolSchemas)) : 0)
      : TOOL_SCHEMAS_OVERHEAD
    : 0
  const historyTokens = scale(dialogTokens)
  const systemPromptTokens = scale(systemTokens)
  const toolSchemasTokens = scale(schemasTokens)
  const currentMsgTokens = scale(opts.currentMsgTokens ?? 0)
  const toolResultTokens = scale(resultsTokens)
  const protocolTokens = scale(API_OVERHEAD)

  const estimated = historyTokens + systemPromptTokens + toolSchemasTokens + currentMsgTokens + toolResultTokens + protocolTokens
  const pct = contextPct(estimated, limit)
  const status = contextStatus(pct)

  return {
    estimated,
    calibrationBaseTokens: dialogTokens + resultsTokens + systemTokens + schemasTokens + (opts.currentMsgTokens ?? 0) + API_OVERHEAD,
    limit,
    pct,
    status,
    source: 'estimate',
    breakdown: {
      history: historyTokens,
      system: systemPromptTokens,
      tools: toolSchemasTokens,
      current: currentMsgTokens,
      toolResults: toolResultTokens > 0 ? toolResultTokens : undefined,
      protocol: protocolTokens,
    },
  }
}

/** Account for the exact messages and schemas of one provider request. */
export function computeRequestContextSnapshot(
  messages: MessageLike[],
  limit: number,
  toolSchemas: unknown[],
  calibration?: string,
): UsageSnapshot {
  const system = messages[0]?.role === 'system' ? messages[0] : undefined
  return computeContextSnapshot(system ? messages.slice(1) : messages, limit, {
    systemPrompt: typeof system?.content === 'string' ? system.content : undefined,
    includeToolSchemas: true,
    toolSchemas,
    calibrationKey: calibration,
  })
}

export function buildSnapshotFromEstimate(
  messages: Array<{ role: string; content: string }>,
  limit: number,
  opts: {
    systemPrompt?: string
    currentMsgTokens?: number
    toolResultTokens?: number
    includeToolSchemas?: boolean
    /** Реальные схемы запроса; без них используется грубая константа. */
    toolSchemas?: unknown[]
    calibrationKey?: string
  } = {},
): UsageSnapshot {
  // Тонкая обёртка: history=messages (без system), system/tools/current — опциями.
  return computeContextSnapshot(messages, limit, {
    systemPrompt: opts.systemPrompt,
    currentMsgTokens: opts.currentMsgTokens,
    includeToolSchemas: opts.includeToolSchemas,
    toolSchemas: opts.toolSchemas,
    toolResultTokens: opts.toolResultTokens,
    calibrationKey: opts.calibrationKey,
  })
}

/** Tariff estimate from provider token usage, never an authoritative invoice.
 * Unknown cache rates use the ordinary input price rather than free tokens.
 */
export function calculateUsageCost(
  pricing: ModelPrice | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number | null {
  if (!pricing || ![pricing.inputPerM, pricing.outputPerM, inputTokens, outputTokens]
    .every(value => Number.isFinite(value) && value >= 0)) return null
  const read = Math.min(inputTokens, Math.max(0, Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0))
  const write = Math.min(inputTokens - read, Math.max(0, Number.isFinite(cacheWriteTokens) ? cacheWriteTokens : 0))
  const cacheRate = (rate: number | undefined): number =>
    rate != null && Number.isFinite(rate) && rate >= 0 ? rate : pricing.inputPerM
  return ((inputTokens - read - write) * pricing.inputPerM + outputTokens * pricing.outputPerM
    + read * cacheRate(pricing.cacheReadPerM) + write * cacheRate(pricing.cacheWritePerM)) / 1_000_000
}

export function getModelPriceInfo(providerId: string, modelId: string, customModels: ModelMeta[] = []): ModelPrice | null {
  if (!modelId) return null

  // 1. Модели Syntee-Gateway — цены отдаёт сам gateway (pricing per_1k →
  // ModelMeta $/1M → центы ×100). Каталог models.dev провайдера не знает и
  // substring-матчингом подменяет модель похожей (glm-5.3 → zai:glm-5).
  if (providerId === GATEWAY_PROVIDER_ID) {
    const gw = getGatewayModelsCache().find(m => m.id === modelId)
    if (gw && gw.inputPrice != null && gw.outputPrice != null
      && [gw.inputPrice, gw.outputPrice].every(p => Number.isFinite(p) && p >= 0)) {
      return {
        inputPerM: (gw.inputPrice ?? 0) * 100,
        outputPerM: (gw.outputPrice ?? 0) * 100,
      }
    }
    // A similarly named public model is not the gateway's actual tariff.
    return null
  }

  // Explicit user tariffs belong to the exact provider+model pair only.
  const custom = Array.isArray(customModels) ? customModels.find(m => m.providerId === providerId && m.id === modelId) : undefined
  if (custom && custom.inputPrice != null && custom.outputPrice != null
    && [custom.inputPrice, custom.outputPrice].every(p => Number.isFinite(p) && p >= 0)) {
    return { inputPerM: custom.inputPrice * 100, outputPerM: custom.outputPrice * 100 }
  }

  // 2. Каталог models.dev
  const fromCatalog = getExactCatalogModel(providerId, modelId)
  if (fromCatalog && [fromCatalog.inputPricePerM, fromCatalog.outputPricePerM].every(rate => Number.isFinite(rate) && rate >= 0)
    && (fromCatalog.hasCompleteTokenPricing || fromCatalog.inputPricePerM > 0 && fromCatalog.outputPricePerM > 0)) {
    return {
      inputPerM: fromCatalog.inputPricePerM,
      outputPerM: fromCatalog.outputPricePerM,
      cacheReadPerM: fromCatalog.cacheReadPerM,
      cacheWritePerM: fromCatalog.cacheWritePerM,
    }
  }

  // 3. Builtin модели (цены в $ за 1M → переводим в центы ×100)
  const builtin = BUILTIN_MODELS.find(m => m.id === modelId && m.providerId === providerId)
  if (builtin?.inputPrice != null && builtin?.outputPrice != null) {
    return { inputPerM: builtin.inputPrice * 100, outputPerM: builtin.outputPrice * 100 }
  }

  return null
}

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  providerId: string,
  modelId: string,
): number | null {
  const price = getModelPriceInfo(providerId, modelId)
  return calculateUsageCost(price, inputTokens, outputTokens)
}
