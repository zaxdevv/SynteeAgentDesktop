import { Watcher, type WatcherTrigger, type Capability, prefilterCapabilities, scoreCapabilitiesSemantic, hashContext } from '../../core/agent/watcher'
import { DEFAULT_ASSISTANTS_SETTINGS, type AssistantsSettings, type AssistantsWeights, type HintCandidate, type AssistantLogEntry, type AgentStatsMap, ASSISTANTS_LOG_MAX_ENTRIES, ASSISTANTS_LOG_RETENTION_MS } from '../../shared/assistants'
import { log, isPrivateLogContext, withLogPrivacy } from '../../core/logger'
import { judgeDrift, distillSession, judgeCapability } from './llmClient'
import { getServerState } from './llmServer'
import { saveMemoryItem, decayAutoFacts } from '../../core/memory/MemoryStore'
import { getMemorySettings } from '../../core/memory/globalMemorySettings'
import { sidecarSemanticSearch, resolveSemanticModelPaths } from '../../core/sidecar/sidecarClient'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { localModels, type SetupProgress } from '../localModels/LocalModelManager'
import { detectModelSize, isModelSize } from './modelManager'
import type { Worker } from 'worker_threads'

interface ActiveAssistant {
  watcher: Watcher
  chatId: string
  worker: Worker | null
  settings: AssistantsSettings
  capabilities: Capability[]
  projectWorkdir?: string
  projectId?: string
  incognito?: boolean
  lastHash: string
  lastErrorHash: string
  controller: AbortController
  /** Последний известный круг рана и ревизия задачи (steer). События с
   *  меньшим round / чужой ревизией — устаревшие, их не судим.
   *  `lastNavigatorRound` — раунд, который уже судили (не судим дважды),
   *  `lastUsefulRound` — раунд, где совет navigator'а реально попал в промпт
   *  (сразу после него повторный совет — шум). */
  round: number
  taskRevision: number
  lastNavigatorRound: number
  lastUsefulRound: number
}

const active = new Map<string, ActiveAssistant>()
function isCurrent(a: ActiveAssistant): boolean {
  return active.get(a.chatId) === a && !a.controller.signal.aborted && a.settings.enabled
}

// Singleflight по роли: одного судью на чат+роль за раз достаточно. Раньше
// каждый триггер запускал свой вызов локальной модели, и очередь забивалась
// одинаковыми промптами, пока первый ещё считался.
const inflightRoles = new Map<string, { signal: AbortSignal; promise: Promise<void> }>()
function singleflight(key: string, signal: AbortSignal, job: () => Promise<void>): Promise<void> {
  const running = inflightRoles.get(key)
  if (running && !running.signal.aborted) return running.promise
  if (signal.aborted) return Promise.resolve()
  const p = job().catch((err) => {
    log('[Assistants] advisory job failed %s: %s', key, (err as Error).message)
  }).finally(() => {
    if (inflightRoles.get(key)?.promise === p) inflightRoles.delete(key)
  })
  inflightRoles.set(key, { signal, promise: p })
  return p
}

// Фоновые задачи Archivist живут дольше своего воркера (факты рождаются на
// самом последнем событии рана). Держим их отдельно: detachAssistants() по
// exit их не трогает, а удаление чата / выключение памяти — отменяет.
interface ArchivistJob { controller: AbortController; chatId: string; projectId?: string; existedAtStart: boolean }
const archivistJobs = new Map<string, ArchivistJob>()
// Томбстоны удалённых чатов: дистилляция может финишировать уже после
// deleteChat — писать строку памяти «ожившему» чату нельзя.
const deletedChats = new Set<string>()
/** Существует ли строка chats: true/false — знаем, undefined — резолвер не
 *  задан. Само по себе отсутствие строки НЕ означает удаление (у side-чатов
 *  её нет изначально), поэтому в задаче фиксируется состояние на старте. */
let chatAliveResolver: ((chatId: string) => boolean | undefined) | null = null
function rowExists(chatId: string): boolean | undefined {
  try { return chatAliveResolver?.(chatId) } catch { return undefined }
}
/** Задача стартовала при живой строке — значит её исчезновение = удаление. */
function chatStillAlive(chatId: string, existedAtStart = false): boolean {
  if (deletedChats.has(chatId)) return false
  if (!existedAtStart) return true
  return rowExists(chatId) !== false
}
/** Удаление чата: отменяем фон Archivist и ставим томбстон. */
export function onChatDeleted(chatId: string): void {
  deletedChats.add(chatId)
  if (deletedChats.size > 256) {
    const oldest = deletedChats.values().next().value
    if (oldest) deletedChats.delete(oldest)
  }
  cancelArchivistJob(chatId, 'чат удалён')
  detachAssistants(chatId)
}
export function cancelArchivistJob(chatId: string, reason = 'отмена'): void {
  const job = archivistJobs.get(chatId)
  if (!job) return
  archivistJobs.delete(chatId)
  job.controller.abort()
  appendLog({ ts: Date.now(), role: 'archivist', kind: 'cancel', detail: `фоновая дистилляция отменена (${reason})` })
}
/** Удаление проекта (вместе с чатами): отменяем дистилляции его чатов. */
export function onProjectDeleted(projectId: string): void {
  for (const [chatId, job] of [...archivistJobs]) {
    if (job.projectId === projectId) cancelArchivistJob(chatId, 'проект удалён')
  }
}
/** Выключение памяти (или авто-записи) в настройках: фоновые дистилляции не
 *  должны успеть записать — отменяем их сразу, а не после генерации. */
export function onMemorySettingsChanged(): void {
  const mem = getMemorySettings()
  if (mem.enabled && mem.auto) return
  for (const chatId of [...archivistJobs.keys()]) cancelArchivistJob(chatId, 'память выключена')
}
const assistantLog: AssistantLogEntry[] = []
let persistLogFn: ((entries: AssistantLogEntry[]) => void) | null = null
let logPersistTimer: NodeJS.Timeout | null = null
export function flushAssistantLog(): void {
  if (logPersistTimer) { clearTimeout(logPersistTimer); logPersistTimer = null }
  try { persistLogFn?.(assistantLog.slice()) } catch { log('[Assistants] history persistence failed') }
}
function scheduleLogPersist(): void {
  if (!persistLogFn || logPersistTimer) return
  logPersistTimer = setTimeout(flushAssistantLog, 1000)
  logPersistTimer.unref()
}
// W1 feedback: веса источников и последние инжектированные хинты per chat.
const sourceWeights = new Map<string, number>()
const capabilityWeights = new Map<string, number>()
const injectedHints = new Map<string, Array<{ id: string; source: string; capId?: string; content: string }>>()
// hint_applied приходит от worker'а: id хинтов, реально вставленных в промпт.
// Держим отдельно от active — событие может прийти позже detach.
const appliedHints = new Map<string, Set<string>>()

// Дедуп хинтов по тексту per chat: navigator/capability шлют одно и то же
// («Возвращайся к цели: X») каждые N раундов — для модели шум, для контекста
// мусор. Нормализованный текст не инжектится повторно в пределах чата
// (пересекает и следующие запросы — watcher/Agent свежие, а мост живой).
const recentHintTexts = new Map<string, Set<string>>()
function normalizeHintText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120)
}
/** true — текст впервые (можно инжектить), false — дубль. */
function markHintText(chatId: string, content: string): boolean {
  let set = recentHintTexts.get(chatId)
  if (!set) set = new Set()
  recentHintTexts.delete(chatId)
  recentHintTexts.set(chatId, set)
  if (recentHintTexts.size > 128) {
    const oldestChat = recentHintTexts.keys().next().value
    if (oldestChat) recentHintTexts.delete(oldestChat)
  }
  const key = normalizeHintText(content)
  if (set.has(key)) return false
  set.add(key)
  if (set.size > 40) {
    const oldest = set.values().next().value
    if (oldest) set.delete(oldest)
  }
  return true
}

// Персист W1-весов: без него feedback-петля обнуляется каждым рестартом.
let persistWeightsFn: ((w: AssistantsWeights) => void) | null = null
function clampWeight(v: number): number { return Math.min(1.5, Math.max(0.5, v)) }
function persistWeights(): void {
  if (!persistWeightsFn) return
  try { persistWeightsFn({ sources: Object.fromEntries(sourceWeights), capabilities: Object.fromEntries(capabilityWeights) }) } catch { /* не критично */ }
}

let globalSettings: AssistantsSettings = { ...DEFAULT_ASSISTANTS_SETTINGS }
let dbPathResolver: (() => string) | null = null
let persistFn: ((s: AssistantsSettings) => void) | null = null

// Мини-статистика агентов (сработал/пропустил/сэкономил) — персистится в store.
const agentStats: AgentStatsMap = {}
let persistStatsFn: ((s: AgentStatsMap) => void) | null = null
let statsPersistTimer: NodeJS.Timeout | null = null
function scheduleStatsPersist(): void {
  if (!persistStatsFn || statsPersistTimer) return
  statsPersistTimer = setTimeout(() => { statsPersistTimer = null; persistStatsFn?.(agentStats) }, 2000)
}
function bump(role: string, kind: 'fired' | 'skipped'): void {
  const st = agentStats[role] ?? (agentStats[role] = { fired: 0, skipped: 0, saved: 0 })
  st[kind]++
  scheduleStatsPersist()
}
function bumpSaved(role: string, tokens: number): void {
  const st = agentStats[role] ?? (agentStats[role] = { fired: 0, skipped: 0, saved: 0 })
  st.saved += tokens
  scheduleStatsPersist()
}
export function getAgentStats(): AgentStatsMap { return agentStats }

export function initAssistants(opts: { load: () => Partial<AssistantsSettings> | undefined; persist: (s: AssistantsSettings) => void; dbPath: () => string; loadStats?: () => AgentStatsMap | undefined; persistStats?: (s: AgentStatsMap) => void; loadWeights?: () => AssistantsWeights | undefined; persistWeights?: (w: AssistantsWeights) => void; loadLog?: () => unknown; persistLog?: (entries: AssistantLogEntry[]) => void; chatAlive?: (chatId: string) => boolean | undefined }): void {
  const saved = opts.load()
  if (saved) globalSettings = { ...DEFAULT_ASSISTANTS_SETTINGS, ...saved }
  persistFn = opts.persist
  dbPathResolver = opts.dbPath
  chatAliveResolver = opts.chatAlive ?? null
  const savedStats = opts.loadStats?.()
  if (savedStats) Object.assign(agentStats, savedStats)
  persistStatsFn = opts.persistStats ?? null
  const savedWeights = opts.loadWeights?.()
  if (savedWeights) {
    for (const [k, v] of Object.entries(savedWeights.sources ?? {})) if (typeof v === 'number') sourceWeights.set(k, clampWeight(v))
    for (const [k, v] of Object.entries(savedWeights.capabilities ?? {})) if (typeof v === 'number') capabilityWeights.set(k, clampWeight(v))
  }
  persistWeightsFn = opts.persistWeights ?? null
  persistLogFn = opts.persistLog ?? null
  const savedLog = opts.loadLog?.()
  if (Array.isArray(savedLog)) {
    assistantLog.length = 0
    for (const candidate of savedLog.slice(-ASSISTANTS_LOG_MAX_ENTRIES)) {
      const clean = sanitizeLogEntry(candidate)
      if (clean) assistantLog.push(clean)
    }
  }
  if (globalSettings.enabled) {
    applyModelSize()
  }
}

export function setAssistantsDbPathResolver(resolver: () => string): void {
  dbPathResolver = resolver
}

export function getAssistantsSettings(): AssistantsSettings {
  return globalSettings
}

export function updateAssistantsSettings(patch: Partial<AssistantsSettings>): AssistantsSettings {
  const previous = globalSettings
  const wasEnabled = globalSettings.enabled
  globalSettings = { ...globalSettings, ...patch }
  // Retire pending advisory work even if a role/source is re-enabled before it finishes.
  const advisorySettingsChanged = previous.watcherEnabled !== globalSettings.watcherEnabled
    || previous.navigatorEnabled !== globalSettings.navigatorEnabled
    || previous.janitorEnabled !== globalSettings.janitorEnabled
    || previous.archivistEnabled !== globalSettings.archivistEnabled
    || previous.sources?.memory !== globalSettings.sources?.memory
    || previous.sources?.skills !== globalSettings.sources?.skills
  persistFn?.(globalSettings)
  // Archivist outlives the worker by design — выключение роли или всего
  // модуля обязано отменить и его, иначе факты запишутся «после выключения».
  if (!globalSettings.enabled || !globalSettings.archivistEnabled) {
    for (const chatId of [...archivistJobs.keys()]) cancelArchivistJob(chatId, 'роль выключена')
  }
  for (const a of active.values()) {
    a.settings = globalSettings
    if (!globalSettings.enabled || advisorySettingsChanged) a.controller.abort()
    if (globalSettings.enabled && a.controller.signal.aborted) a.controller = new AbortController()
    a.watcher.updateSettings(globalSettings)
    a.worker?.postMessage({ type: 'assistants_settings', settings: globalSettings })
  }
  if (!globalSettings.enabled && wasEnabled) {
    localModels.shutdown()
  } else if (globalSettings.enabled) {
    applyModelSize()
  }
  return globalSettings
}

function applyModelSize(): void {
  const selected = globalSettings.modelSize
  const size = isModelSize(selected) ? selected : detectModelSize()
  localModels.setModelSize(size)
  // Контекст — аргумент запуска сервера: применяем здесь же, чтобы смена
  // настройки не ждала следующего рестарта.
  localModels.setCtxSetting(globalSettings.ctxSize)
  // Устройство (auto/cpu/gpu) — тоже аргумент запуска; смена рестартит сервер.
  localModels.setDevice(globalSettings.device)
}

export type { SetupProgress }

export function onSetupProgress(fn: (p: SetupProgress) => void): () => void {
  return localModels.onProgress(fn)
}

export async function downloadAndStart(): Promise<{ ok: boolean; error?: string }> {
  if (!globalSettings.enabled) return { ok: false, error: 'Мини-агенты выключены.' }
  applyModelSize()
  const ok = await localModels.ensureReady()
  return { ok, error: ok ? undefined : localModels.getStatus().lastError }
}

export { getServerState } from './llmServer'
export { detectModelSize, isModelDownloaded, getModelPath } from './modelManager'

// После idle-выгрузки сервер поднимается лениво на первом же событии агента.
function serverReady(): boolean {
  if (!globalSettings.enabled) return false
  if (getServerState() === 'ready') return true
  void localModels.ensureReady()
  return false
}

// Ожидание холодного старта: serverReady() лениво запускает ensureReady после
// idle-выгрузки или на старте приложения. Раньше мы не ждали и сразу уходили
// в fallback — инжектили сырые memory-хинты без LLM-судьи (главный источник
// мусора у watcher'а). Несколько секунд ожидания для advisory-события ничего
// не блокируют, а хинт всё равно consumed на следующей границе раунда.
const SERVER_WAKE_TIMEOUT_MS = 12_000
async function serverReadyOrWake(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  if (serverReady()) return true
  const deadline = Date.now() + SERVER_WAKE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!globalSettings.enabled || signal?.aborted) return false
    // 'error' — сервер упал окончательно (исчерпал рестарты): ждём зря.
    if (localModels.getState() === 'error') return false
    await new Promise(r => setTimeout(r, 400))
    if (!signal?.aborted && serverReady()) return true
  }
  return false
}

export function attachAssistants(chatId: string, worker: Worker, opts: { projectWorkdir?: string; projectId?: string; incognito?: boolean } = {}): void {
  if (!globalSettings.enabled) {
    log('[Assistants] attach skipped (disabled) chat=%s', chatId)
    return
  }
  const dbPath = dbPathResolver?.() ?? ''
  const watcher = new Watcher(globalSettings, dbPath, { ...opts, chatId })
  // W1 feedback: веса источников (корректируются в onRunDone) влияют на
  // отбор memory-хинтов — «расстроенный» источник замолкает.
  watcher.setSourceWeightProvider((src) => sourceWeights.get(src) ?? 1)
  active.get(chatId)?.controller.abort()
  const a: ActiveAssistant = {
    watcher, chatId, worker, settings: globalSettings, capabilities: [], projectWorkdir: opts.projectWorkdir,
    projectId: opts.projectId, incognito: opts.incognito, lastHash: '', lastErrorHash: '', controller: new AbortController(),
    round: 0, taskRevision: 0, lastNavigatorRound: -1, lastUsefulRound: -100,
  }
  active.set(chatId, a)
  // Archivist больше не привязан к воркеру (см. agent_archivist): его фоновая
  // задача продолжается после exit и пишет факты в доверенный контекст.
  worker.once('exit', () => { if (active.get(chatId) === a) detachAssistants(chatId, true) })
  worker.postMessage({ type: 'assistants_settings', settings: globalSettings })
  log('[Assistants] attached to chat %s (watcher=%s janitor=%s)', chatId, globalSettings.watcherEnabled, globalSettings.janitorEnabled)
}

export function detachAssistants(chatId: string, preserveHintHistory = false): void {
  const a = active.get(chatId)
  a?.controller.abort()
  if (a) a.worker = null
  active.delete(chatId)
  if (!preserveHintHistory) {
    recentHintTexts.delete(chatId)
    appliedHints.delete(chatId)
  }
  injectedHints.delete(chatId)
  // Фоновые задачи Archivist намеренно НЕ отменяются: они переживают воркер.
  // Отмена — только onChatDeleted / выключение роли / выключение памяти.
}

export async function onAgentEvent(chatId: string, trigger: WatcherTrigger): Promise<void> {
  return withLogPrivacy(!!active.get(chatId)?.incognito, () => onAgentEventScoped(chatId, trigger))
}
async function onAgentEventScoped(chatId: string, trigger: WatcherTrigger): Promise<void> {
  const a = active.get(chatId)
  if (!a || !a.settings.enabled || !a.settings.watcherEnabled) {
    log('[Assistants] watcher skip chat=%s attached=%s enabled=%s', chatId, !!a, a?.settings.enabled)
    return
  }
  const signal = a.controller.signal
  try {
    const ctx = buildTriggerContext(trigger, a.projectWorkdir)
    // Novelty-gate: нет новой информации — нет повода говорить (кроме старта).
    const h = hashContext(ctx)
    if (trigger.kind !== 'task_start' && h === a.lastHash) return
    a.lastHash = h
    if (trigger.kind === 'tool_error') {
      const eh = hashContext(trigger.error)
      if (eh === a.lastErrorHash) return
      a.lastErrorHash = eh
    }
    appendLog({ ts: Date.now(), role: 'watcher', kind: 'trigger', detail: `${trigger.kind}: оценка возможностей` })

    // 1) E5-память и keyword-скиллы считаются ДО пробуждения модели и не
    //    зависят от него: дешёвый локальный retrieval полезен и без LLM.
    //    Один проход на триггер (collect) — иначе minIntervalMs съедал второй.
    const local = await a.watcher.collect(trigger)
    if (signal.aborted || !isCurrent(a) || !a.settings.watcherEnabled) return
    const memoryInjected = injectHint(a, local.memory[0], 'watcher')

    // 2) Каталог возможностей гейтится ДО wake/LLM. Пустой каталог после
    //    prefilter+семантики = нет кандидатов = судье нечего решать, и
    //    локальную модель мы вообще не трогаем.
    let caps = prefilterCapabilities(a.capabilities, ctx, 10)
    if (caps.length === 0 && a.capabilities.length > 0) {
      // Keyword-overlap пуст (RU-запрос против EN-имён скиллов). Семантический
      // скоринг вместо «первых 10 по порядку» — порядок кандидатов для судьи.
      const semantic = await scoreCapabilitiesSemantic(a.capabilities, ctx, signal)
      caps = semantic.filter(s => s.score >= 0.1).slice(0, 10).map(s => s.cap)
    }
    if (signal.aborted || !isCurrent(a) || !a.settings.watcherEnabled) return
    caps = caps.sort((x, y) => (capabilityWeights.get(y.id) ?? 1) - (capabilityWeights.get(x.id) ?? 1))

    if (caps.length === 0) {
      appendLog({ ts: Date.now(), role: 'watcher', kind: 'skip', detail: 'нет кандидатов в каталоге — судья не вызывался' })
      // Не более одного хинта на триггер: скилл — только если память молчала.
      if (!memoryInjected) injectHint(a, local.skills[0], 'watcher')
      bump('watcher', 'skipped')
      return
    }

    const ready = await serverReadyOrWake(signal)
    if (signal.aborted || !isCurrent(a) || !a.settings.watcherEnabled) return
    if (!ready) {
      // Fallback без LLM: скиллы (память уже отдана выше), не более одной подсказки.
      if (!memoryInjected) injectHint(a, local.skills[0], 'watcher')
      if (!memoryInjected && local.skills.length === 0) bump('watcher', 'skipped')
      return
    }

    // Singleflight по чату: пока судья считает, следующие триггеры не плодят
    // одинаковые запросы в очередь локальной модели.
    await singleflight(`watcher:${chatId}`, signal, async () => {
      const verdict = await judgeCapability(ctx, caps, signal)
      if (signal.aborted || !isCurrent(a) || !a.settings.watcherEnabled) return
      if (!(verdict.helpful && verdict.confidence >= 0.6)) {
        appendLog({ ts: Date.now(), role: 'watcher', kind: 'skip', detail: 'нет уверенной рекомендации — пропуск' })
        bump('watcher', 'skipped')
        return
      }
      const cap = a.capabilities.find(c => c.id === verdict.id)
      const hint: HintCandidate = { id: `cap-${verdict.id}-${Date.now()}`, source: 'capability', content: verdict.action, score: verdict.confidence, title: cap?.name ?? verdict.id }
      if (injectHint(a, hint, 'watcher', undefined, verdict.id)) return
      appendLog({ ts: Date.now(), role: 'watcher', kind: 'skip', detail: `дубль текста хинта — не инжектится: ${hint.content.slice(0, 60)}` })
      bump('watcher', 'skipped')
    })
  } catch (err) {
    log('[Assistants] watcher error for chat %s: %s', chatId, (err as Error).message)
  }
}

/** Единая точка инжекта: дедуп текста → postMessage → лог → регистрация для
 *  feedback (hint_applied/onRunDone). Возвращает false, если хинт отфильтрован
 *  (нет хинта / отменено / выключено / дубль текста). */
function injectHint(a: ActiveAssistant, hint: HintCandidate | undefined, role: AssistantLogEntry['role'], signal = a.controller.signal, capId?: string): boolean {
  if (!hint) return false
  if (signal.aborted || !isCurrent(a)) return false
  if (hint.source === 'memory' && (a.incognito || !a.settings.sources.memory || !getMemorySettings().enabled)) return false
  if (hint.source === 'navigator' && !a.settings.navigatorEnabled) return false
  if (!markHintText(a.chatId, hint.content)) return false
  a.worker?.postMessage({ type: 'hint', hint })
  const inj = injectedHints.get(a.chatId) ?? []
  inj.push({ id: hint.id, source: hint.source, capId, content: hint.content.slice(0, 400) })
  injectedHints.set(a.chatId, inj.slice(-20))
  appendLog({ ts: Date.now(), role, kind: 'hint_injected', detail: `[${hint.source}] ${hint.content.slice(0, 80)}` })
  bump(role, 'fired')
  return true
}

const groundingCache = new Map<string, string>()
function readGrounding(workdir?: string): string {
  if (!workdir) return ''
  if (groundingCache.has(workdir)) return groundingCache.get(workdir)!
  let text = ''
  for (const rel of ['AGENTS.md', '.syntee/instructions.md', 'QODER.md']) {
    try {
      const p = join(workdir, rel)
      if (existsSync(p)) { text = readFileSync(p, 'utf8').slice(0, 300); break }
    } catch { /* ok */ }
  }
  groundingCache.set(workdir, text)
  return text
}

function buildTriggerContext(trigger: WatcherTrigger, workdir?: string): string {
  let base: string
  switch (trigger.kind) {
    case 'tool_error': base = `tool ${trigger.toolName} error: ${trigger.error}`; break
    case 'capability_gap': base = `tool ${trigger.toolName} unavailable: ${trigger.text}`; break
    case 'tool_repeat': base = `tool ${trigger.toolName} repeated ${trigger.count} times`; break
    default: base = trigger.text
  }
  const g = readGrounding(workdir)
  return g ? `${base}\nProject rules: ${g}` : base
}

export function onJanitorAction(_chatId: string, kind: string, description: string, tokensSaved: number): void {
  if (active.get(_chatId)?.incognito) return
  appendLog({ ts: Date.now(), role: 'janitor', kind, detail: description, tokensSaved })
  // The same output can already have been counted in a live request. Keep
  // saved-history estimates in the event log without adding them a second time.
  if (kind === 'persist_compress') return
  if (tokensSaved > 0) { bump('janitor', 'fired'); bumpSaved('janitor', tokensSaved) }
  else bump('janitor', 'skipped')
}

// Детерминированная классификация факта Archivist: 0.8–1.2B модели часто
// пишут мусорный kind, а от него зависит тип записи в памяти. Эвристика по
// формулировке — приоритетнее вердикта модели.
function classifyFact(content: string, modelKind: string): 'project' | 'feedback' | 'user' {
  if (/(?:пользовател[ья]?|юзер|\buser\b)[^.\n]{0,60}(?:просит|просил|предпочитает|хочет|сказал)|я (?:предпочитаю|всегда)/i.test(content)) return 'user'
  if (/(?:в проекте|у нас) (?:принято|используется)|конвенц|convention|правило проекта|всегда используем|always use/i.test(content)) return 'feedback'
  return (['project', 'feedback', 'user'] as const).includes(modelKind as 'project') ? modelKind as 'project' : 'project'
}

// E5-дедуп Archivist: почти-дубль уже в памяти (cosine ≥ 0.9) → не плодим записи.
async function isE5Duplicate(content: string, projectId?: string): Promise<boolean> {
  const memory = getMemorySettings()
  if (!memory.enabled || !(projectId ? memory.project : memory.global)) return false
  const paths = resolveSemanticModelPaths()
  const dbPath = dbPathResolver?.()
  if (!paths || !dbPath) return false
  try {
    const hits = await sidecarSemanticSearch(
      { dbPath, query: content, limit: 1, sources: ['memory'], scope: projectId ? 'project' : 'global', projectId: projectId ?? null, crossProject: false, kind: null, memoryEnabled: memory.enabled, memoryGlobal: memory.global, memoryProject: memory.project, memoryChat: memory.chat },
      paths,
    )
    return (hits[0]?.score ?? 0) >= 0.9
  } catch { return false }
}

// Decay авто-фактов — не чаще раза в сутки, по реальному сигналу (конец рана).
let lastDecayAt = 0
function maybeDecay(): void {
  if (Date.now() - lastDecayAt < 24 * 3600 * 1000) return
  lastDecayAt = Date.now()
  try {
    const n = decayAutoFacts()
    if (n > 0) appendLog({ ts: Date.now(), role: 'archivist', kind: 'decay', detail: `понижена importance у ${n} старых авто-фактов` })
  } catch { /* decay не критичен */ }
}

// Archivist: минимум, ниже которого дистилляции нечего взять. Гейт стоит в
// главном процессе и не зависит от того, что решил воркер.
const MIN_ARCHIVIST_TRANSCRIPT_CHARS = 250

// Navigator: сколько раундов «лага» допустимо вердикту. Судья на локальной
// модели считается дольше раунда, поэтому жёсткое «round < current» выбрасывало
// почти все вердикты (а abort на каждом раунде убивал их ещё раньше).
const NAVIGATOR_STALE_ROUNDS = 3
/** После сработавшего совета не судим сразу — модели нужно время его применить. */
const NAVIGATOR_REPEAT_GUARD_ROUNDS = 2

/** Диспетчер LLM-зависимых мини-агентов (события из worker). Все advisory. */
export async function onAssistantEvent(chatId: string, evt: Record<string, unknown>): Promise<void> {
  return withLogPrivacy(!!active.get(chatId)?.incognito, () => onAssistantEventScoped(chatId, evt))
}
async function onAssistantEventScoped(chatId: string, evt: Record<string, unknown>): Promise<void> {
  const a = active.get(chatId)
  if (!a || !a.settings.enabled) return
  const s = a.settings
  const kind = String(evt.kind ?? '')
  // Bookkeeping must never wake/download a local LLM or wait behind startup.
  switch (kind) {
    case 'capabilities': a.capabilities = (evt.capabilities as Capability[]) ?? []; return
    case 'watcher_trigger': {
      const trigger = evt.trigger as WatcherTrigger | undefined
      if (trigger) await onAgentEvent(chatId, trigger)
      return
    }
    case 'hint_applied': applyHintFeedback(a, String(evt.hintId ?? '')); return
    case 'task_revised': {
      // steer: задача переписана — всё, что судилось по старой ревизии, устарело.
      a.taskRevision++
      a.lastHash = ''
      a.controller.abort()
      if (s.enabled) a.controller = new AbortController()
      appendLog({ ts: Date.now(), role: 'navigator', kind: 'skip', detail: `задача переписана (rev ${a.taskRevision}) — старые вердикты отброшены` })
      return
    }
    case 'round_advanced': {
      // Только учёт прогресса: раньше здесь стоял abort контроллера на КАЖДОМ
      // раунде, и судья navigator'а (он считается дольше раунда) не успевал
      // дожить до вердикта — инжект не случался почти никогда. Устаревание
      // теперь решается лагом по номеру раунда (см. NAVIGATOR_STALE_ROUNDS).
      const round = Number(evt.round ?? 0)
      if (Number.isFinite(round) && round > a.round) a.round = round
      return
    }
    case 'briefing': bump('briefing', 'fired'); return
    case 'janitor_skip': bump('janitor', 'skipped'); return
    case 'archivist': {
      // Фоновая задача: не блокирует воркер и переживает его exit.
      startArchivistJob(a, evt)
      return
    }
  }
  if (kind === 'navigator' && !s.navigatorEnabled) return
  if (kind !== 'navigator') return
  // Устаревшее событие: ран ушёл дальше допустимого лага или задачу переписали.
  const evtRound = Number(evt.round ?? NaN)
  if (Number.isFinite(evtRound)) {
    if (evtRound < a.round - NAVIGATOR_STALE_ROUNDS) return
    // Этот раунд уже судили — второй вызов по тому же состоянию не нужен.
    if (evtRound <= a.lastNavigatorRound) return
  }
  const evtRevision = Number(evt.taskRevision ?? NaN)
  if (Number.isFinite(evtRevision) && evtRevision < a.taskRevision) return
  const lastUseful = Number(evt.lastUsefulRound ?? NaN)
  // Совет только что сработал: не повторяем его через раунд-два.
  if (Number.isFinite(lastUseful) && Number.isFinite(evtRound) && evtRound - lastUseful < NAVIGATOR_REPEAT_GUARD_ROUNDS) return
  if (Number.isFinite(evtRound)) a.lastNavigatorRound = evtRound
  const signal = a.controller.signal
  const ready = await serverReadyOrWake(signal)
  if (!ready || !globalSettings.enabled || signal.aborted || !isCurrent(a)) return
  try {
    await singleflight(`navigator:${chatId}`, signal, async () => {
      if (!a.settings.navigatorEnabled) return
      const verdict = await judgeDrift(String(evt.objective ?? ''), String(evt.transcript ?? ''), Array.isArray(evt.constraints) ? evt.constraints as string[] : [], String(evt.todo ?? ''), signal)
      // Пока судья думал, задачу могли переписать (ревизия) или ран ушёл
      // далеко вперёд (лаг). Обычный следующий раунд — НЕ повод выбрасывать
      // вердикт: судья физически не успевает за раундами.
      if (signal.aborted || !isCurrent(a) || !a.settings.navigatorEnabled) return
      if (Number.isFinite(evtRound) && evtRound < a.round - NAVIGATOR_STALE_ROUNDS) return
      if (Number.isFinite(evtRevision) && evtRevision < a.taskRevision) return
      if (verdict.drift || verdict.violation) {
        const content = verdict.violation
          ? `Нарушаешь ограничение: ${verdict.reason || 'соблюдай закреплённые правила.'}`
          : `Возвращайся к цели: ${verdict.reason || 'текущие шаги уходят в сторону.'}`
        const hint: HintCandidate = { id: `nav-${Date.now()}`, source: 'navigator', content, score: 1 }
        if (!injectHint(a, hint, 'navigator', signal)) bump('navigator', 'skipped')
        else if (Number.isFinite(evtRound)) a.lastUsefulRound = evtRound
      } else {
        bump('navigator', 'skipped')
      }
    })
  } catch (err) {
    log('[Assistants] navigator error chat=%s: %s', chatId, (err as Error).message)
  }
}

// ─── Archivist: фоновая дистилляция, привязанная к доверенному контексту ───

/**
 * Идентичность и scope берём из attachAssistants (main-side доверенные opts),
 * а не из evt воркера: chatId/projectId из события можно подделать, и тогда
 * факт уедет в чужой проект.
 */
function startArchivistJob(a: ActiveAssistant, evt: Record<string, unknown>): void {
  if (!a.settings.archivistEnabled || a.incognito) return
  const mem = getMemorySettings()
  if (!mem.enabled || !mem.auto || !(a.projectId ? mem.project : mem.global)) {
    appendLog({ ts: Date.now(), role: 'archivist', kind: 'skip', detail: 'память (или авто-запись) выключена — дистилляция пропущена' })
    bump('archivist', 'skipped')
    return
  }
  const transcript = String(evt.transcript ?? '')
  // Независимый гейт длины: короткий ран («готово») дистиллировать нечего.
  if (transcript.trim().length < MIN_ARCHIVIST_TRANSCRIPT_CHARS) {
    appendLog({ ts: Date.now(), role: 'archivist', kind: 'skip', detail: `транскрипт слишком короткий (${transcript.trim().length} симв.) — дистилляция не запускалась` })
    bump('archivist', 'skipped')
    return
  }
  const chatId = a.chatId
  if (deletedChats.has(chatId)) return
  // Фиксируем состояние на старте: если строка chats есть сейчас, её
  // исчезновение позже = удаление чата. У эфемерных чатов (side/инкогнито)
  // строки нет изначально — их поведение не меняем.
  const existedAtStart = rowExists(chatId) === true
  // Новый ран важнее недоработавшего старого: отменяем предыдущую задачу.
  cancelArchivistJob(chatId, 'новый ран')
  const controller = new AbortController()
  const job: ArchivistJob = { controller, chatId, projectId: a.projectId, existedAtStart }
  archivistJobs.set(chatId, job)
  const files = Array.isArray(evt.modifiedFiles)
    ? (evt.modifiedFiles as unknown[]).filter((f): f is string => typeof f === 'string').slice(0, 10)
    : []
  void (async () => {
    const signal = controller.signal
    try {
      const ready = await serverReadyOrWake(signal)
      if (!ready || signal.aborted) return
      const facts = await distillSession(transcript, files, signal)
      if (signal.aborted || !facts.length) {
        appendLog({ ts: Date.now(), role: 'archivist', kind: 'skip', detail: `0 фактов: модель вернула пустоту/мусор или задача отменена` })
        bump('archivist', 'skipped')
        return
      }
      if (!globalSettings.enabled || !globalSettings.archivistEnabled) return
      // Между дистилляцией и записью чат мог быть удалён, память — выключена.
      if (!chatStillAlive(chatId, job.existedAtStart)) {
        appendLog({ ts: Date.now(), role: 'archivist', kind: 'cancel', detail: 'чат удалён во время дистилляции — факты не записаны' })
        return
      }
      const stillMem = getMemorySettings()
      if (!stillMem.enabled || !stillMem.auto || !(job.projectId ? stillMem.project : stillMem.global)) return
      let savedCount = 0
      for (const f of facts) {
        if (signal.aborted || !chatStillAlive(chatId, job.existedAtStart)) break
        if (await isE5Duplicate(f.content, job.projectId)) {
          appendLog({ ts: Date.now(), role: 'archivist', kind: 'dedup', detail: `E5-дубль пропущен: ${f.content.slice(0, 60)}` })
          continue
        }
        if (signal.aborted || !chatStillAlive(chatId, job.existedAtStart)) break
        const kindMap: Record<string, 'project_decision' | 'convention' | 'user_fact'> = { project: 'project_decision', feedback: 'convention', user: 'user_fact' }
        const writable = getMemorySettings()
        if (!writable.enabled || !writable.auto || !(job.projectId ? writable.project : writable.global)) break
        await saveMemoryItem({
          title: f.content.slice(0, 60), content: f.content, kind: kindMap[classifyFact(f.content, f.kind)] ?? 'project_decision',
          scope: job.projectId ? 'project' : 'global', projectId: job.projectId,
          chatId, source: 'auto_extract', importance: 0.6,
        })
        savedCount++
      }
      if (savedCount) {
        appendLog({ ts: Date.now(), role: 'archivist', kind: 'distilled', detail: `сохранено ${savedCount} фактов в память` })
        bump('archivist', 'fired')
      } else {
        appendLog({ ts: Date.now(), role: 'archivist', kind: 'skip', detail: '0 фактов: модель вернула пустоту/мусор (детали в debug.log) или все E5-дубли' })
        bump('archivist', 'skipped')
      }
      maybeDecay()
    } catch (err) {
      log('[Assistants] archivist error chat=%s: %s', chatId, (err as Error).message)
    } finally {
      if (archivistJobs.get(chatId) === job) archivistJobs.delete(chatId)
    }
  })()
}

/** hint_applied: worker реально вставил хинт в промпт — детерминированный
 *  сигнал полезности (замена LLM-судье feedback'а). Модель не будим. */
function applyHintFeedback(a: ActiveAssistant, hintId: string): void {
  if (!hintId) return
  let applied = appliedHints.get(a.chatId)
  if (!applied) applied = new Set()
  appliedHints.set(a.chatId, applied)
  if (applied.has(hintId)) return
  applied.add(hintId)
  if (applied.size > 64) {
    const first = applied.values().next().value
    if (first) applied.delete(first)
  }
  const inj = injectedHints.get(a.chatId) ?? []
  const hit = inj.find(h => h.id === hintId)
  if (!hit) return
  sourceWeights.set(hit.source, clampWeight((sourceWeights.get(hit.source) ?? 1) + 0.05))
  if (hit.capId) capabilityWeights.set(hit.capId, clampWeight((capabilityWeights.get(hit.capId) ?? 1) + 0.1))
  persistWeights()
  appendLog({ ts: Date.now(), role: 'watcher', kind: 'applied', detail: `хинт принят агентом: ${hit.content.slice(0, 60)}` })
}

/** W1 feedback без LLM: веса корректируются по детерминированным сигналам —
 *  хинт реально вставлен в промпт (hint_applied) и возможность формально
 *  вызвана в ране (`invoked` из collectedSteps). Судья-генерация удалена:
 *  её вердикт был шумом на 0.8–1.2B и держал слот очереди после рана. */
export async function onRunDone(chatId: string, transcriptTail: string, invoked?: { tools: string[]; skills: string[] }): Promise<void> {
  const inj = injectedHints.get(chatId) ?? []
  injectedHints.delete(chatId)
  const applied = appliedHints.get(chatId) ?? new Set<string>()
  appliedHints.delete(chatId)
  if (inj.length === 0 || !globalSettings.enabled) return
  try {
    const invokedSet = new Set([...(invoked?.tools ?? []), ...(invoked?.skills ?? [])])
    for (const h of inj) {
      const wasApplied = applied.has(h.id)
      // Точный сигнал — формальный вызов; includes по транскрипту остаётся
      // фолбэком: модель может последовать скиллу, не упоминая его имя в шагах.
      const used = wasApplied || invokedSet.has(h.source)
        || (!!h.capId && (invokedSet.has(h.capId) || transcriptTail.includes(h.capId)))
      const delta = used ? 0.1 : -0.05
      sourceWeights.set(h.source, clampWeight((sourceWeights.get(h.source) ?? 1) + delta))
      if (h.capId) capabilityWeights.set(h.capId, clampWeight((capabilityWeights.get(h.capId) ?? 1) + delta))
    }
    persistWeights()
  } catch { /* feedback не критичен */ }
}

function appendLog(entry: AssistantLogEntry): void {
  if (isPrivateLogContext()) return
  const clean = sanitizeLogEntry(entry)
  if (!clean) return
  assistantLog.push(clean)
  if (assistantLog.length > ASSISTANTS_LOG_MAX_ENTRIES) {
    assistantLog.splice(0, assistantLog.length - ASSISTANTS_LOG_MAX_ENTRIES)
  }
  scheduleLogPersist()
}

/** Persist decisions and counters, never hint text, tool output or memory facts. */
function sanitizeLogEntry(candidate: unknown): AssistantLogEntry | null {
  if (!candidate || typeof candidate !== 'object') return null
  const entry = candidate as AssistantLogEntry
  if (!Number.isFinite(entry.ts) || entry.ts < Date.now() - ASSISTANTS_LOG_RETENTION_MS || entry.ts > Date.now() + 60_000) return null
  if (!['watcher', 'janitor', 'briefing', 'navigator', 'archivist', 'economist'].includes(entry.role)) return null
  if (typeof entry.kind !== 'string' || !/^[a-z_]{1,64}$/.test(entry.kind)) return null
  const detail = entry.kind === 'hint_injected' ? 'Подсказка передана агенту.'
    : entry.kind === 'applied' ? 'Подсказка добавлена в запрос.'
      : entry.kind === 'trigger' ? 'Начата проверка контекста.'
        : entry.kind === 'dedup' ? 'Повторяющаяся информация пропущена.'
          : entry.kind === 'cancel' ? 'Фоновая задача отменена.'
            : entry.kind === 'distilled' ? 'Факты сохранены в память.'
              : entry.kind === 'skip' ? 'Проверка завершена без новой подсказки.'
                : entry.kind === 'decay' ? 'Обновлена важность старых фактов.' : 'Выполнена оптимизация контекста.'
  return {
    ts: entry.ts, role: entry.role, kind: entry.kind, detail,
    ...(typeof entry.tokensSaved === 'number' && Number.isFinite(entry.tokensSaved) && entry.tokensSaved >= 0 ? { tokensSaved: entry.tokensSaved } : {}),
    ...(typeof entry.hintUsed === 'boolean' ? { hintUsed: entry.hintUsed } : {}),
  }
}

export function getAssistantLog(since?: number, limit?: number): AssistantLogEntry[] {
  const cutoff = Date.now() - ASSISTANTS_LOG_RETENTION_MS
  const filtered = assistantLog.filter(e => e.ts >= cutoff && (!since || e.ts >= since))
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return filtered
  const count = Math.max(0, Math.min(ASSISTANTS_LOG_MAX_ENTRIES, Math.trunc(limit)))
  return count > 0 ? filtered.slice(-count) : []
}

export function pruneAssistantLog(): void {
  const cutoff = Date.now() - ASSISTANTS_LOG_RETENTION_MS
  const before = assistantLog.length
  for (let i = assistantLog.length - 1; i >= 0; i--) {
    if (assistantLog[i].ts < cutoff) assistantLog.splice(i, 1)
  }
  if (assistantLog.length !== before) log('[Assistants] pruned %d log entries', before - assistantLog.length)
  if (assistantLog.length !== before) scheduleLogPersist()
}

export function getActiveAssistantChats(): string[] {
  return [...active.keys()]
}
