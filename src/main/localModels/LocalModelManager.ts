import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { cpus } from 'os'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:net'
import { app, webContents } from 'electron'
import { log } from '../../core/logger'
import { getModelPath, detectModelSize, isModelDownloaded, downloadModel, resolveCtxSize, type ModelSize, type CtxSizeSetting } from '../assistants/modelManager'
import { LLAMA_SERVER_NAME, getLlamaServerPath, isBinaryReady, downloadBinary, type LlamaFlavor } from '../assistants/binaryManager'

export type ManagerState = 'idle' | 'preparing' | 'starting' | 'ready' | 'error'
export type QueuePriority = 'watcher' | 'janitor' | 'default'

/**
 * Где считать мини-агентов: `auto` — Vulkan-GPU, если сервер поднялся и
 * реально offload'ил слои, иначе CPU; `cpu` — всегда CPU; `gpu` — Vulkan с
 * откатом на CPU, если карты нет. Зеркально настройке семантики.
 */
export type LlamaDevice = 'auto' | 'cpu' | 'gpu'

export interface CompleteOptions {
  priority?: QueuePriority
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ManagerStatus {
  state: ManagerState
  modelSize: ModelSize
  /** Действующий контекст сервера (токенов на все слоты). */
  ctxSize: number
  /** Выбранная настройка контекста ('auto' | фиксированный размер). */
  ctxSetting: CtxSizeSetting
  /** Что выбрано в настройках ('auto' | 'cpu' | 'gpu'). */
  device: LlamaDevice
  /** Чем сервер реально работает сейчас: 'gpu' | 'cpu' | null — ещё не запущен. */
  activeDevice: 'gpu' | 'cpu' | null
  modelDownloaded: boolean
  binaryReady: boolean
  port: number
  restarts: number
  queueLength: number
  active: number
  idleUnloaded: boolean
  lastError?: string
}

export interface SetupProgress {
  phase: 'binary' | 'model' | 'starting' | 'ready' | 'error'
  percent: number
  error?: string
}

interface QueueItem {
  priority: QueuePriority
  prompt: string
  maxTokens: number
  temperature: number
  timeoutMs: number
  resolve: (text: string) => void
  reject: (err: Error) => void
  ts: number
  signal?: AbortSignal
  cleanup: () => void
}

const DEFAULT_PORT = 18474
const HEALTH_INTERVAL_MS = 10_000
const IDLE_UNLOAD_MS = 5 * 60_000
const STARTUP_TIMEOUT_MS = 60_000
const MAX_QUEUE = 8
const MAX_QUEUE_WAIT_MS = 45_000
// llama-server стартует с n_slots=4 и общим KV-пулом, но декод CPU-bound:
// при 3 параллельных запросах каждый становится ~2.5× медленнее. Два слота
// дают лучший баланс — длинный janitor/archivist больше не блокирует
// короткие watcher запросы (замер: 9.3с → 6.8с на смешанной пачке).
const MAX_PARALLEL = 2
const TIMEOUT_PER_PEER_MS = 10_000
const MAX_TIMEOUT_MS = 45_000
const MAX_RESTARTS = 3
const RESTART_BACKOFF_MS = [1000, 3000, 8000]
const PRIORITY_ORDER: Record<QueuePriority, number> = { watcher: 0, default: 1, janitor: 2 }

class LocalModelManager {
  private state: ManagerState = 'idle'
  private process: ChildProcess | null = null
  private port = DEFAULT_PORT
  private modelSize: ModelSize = detectModelSize()
  /** Настройка контекста (то, что выбрал пользователь) и её разрешённое значение. */
  private ctxSetting: CtxSizeSetting = 'auto'
  private ctxSize: number = resolveCtxSize('auto')
  /** Устройство из настроек; факт — в activeDevice. */
  private device: LlamaDevice = 'auto'
  /** Чем сервер реально работает: после удачного спавна. */
  private activeDevice: 'gpu' | 'cpu' | null = null
  /** Авто уже откатывалось на CPU — не долбить Vulkan при каждом рестарте,
   * пока настройку не поменяли или приложение не перезапущено. */
  private gpuUnavailable = false
  /** Stderr текущего/последнего спавна — по нему узнаём факт GPU-offload. */
  private logLines: string[] = []
  private ensurePromise: Promise<boolean> | null = null
  private watchdog: NodeJS.Timeout | null = null
  private restarts = 0
  private lastError: string | undefined
  private queue: QueueItem[] = []
  private inFlight = 0
  private backgroundInFlight = 0
  private stateListeners: Array<(s: ManagerState) => void> = []
  private progressListeners: Array<(p: SetupProgress) => void> = []
  private shuttingDown = false
  private lifecycle = new AbortController()
  private restartTimer: NodeJS.Timeout | null = null
  private lastActivity = Date.now()
  private idleUnloaded = false

  // ── Public API ────────────────────────────────────────────────────────────

  getState(): ManagerState { return this.state }
  isReady(): boolean { return this.state === 'ready' }
  getPort(): number { return this.port }
  getBaseUrl(): string { return `http://127.0.0.1:${this.port}` }
  /** Cheap cache identity: no filesystem/status probes on the advisory hot path. */
  getInferenceFingerprint(): string { return `${this.modelSize}|${this.ctxSize}|${this.device}|${this.activeDevice}` }

  /** Действующий размер контекста (токенов всего, на все слоты). */
  getCtxSize(): number { return this.ctxSize }
  getCtxSetting(): CtxSizeSetting { return this.ctxSetting }

  /**
   * Сколько токенов реально доступно ОДНОМУ запросу: llama-server делит
   * --ctx-size между слотами (--parallel), плюс надо оставить место под ответ.
   */
  getPromptTokenBudget(maxTokens = 0): number {
    const perSlot = Math.floor(this.ctxSize / MAX_PARALLEL)
    return Math.max(256, perSlot - maxTokens - 64)
  }

  setCtxSetting(setting: CtxSizeSetting): void {
    const next = resolveCtxSize(setting)
    if (setting === this.ctxSetting && next === this.ctxSize) return
    this.ctxSetting = setting
    if (next === this.ctxSize) return
    this.ctxSize = next
    // Контекст задаётся аргументом запуска — меняется только рестартом.
    if (this.state !== 'idle') this.scheduleRestart()
  }

  getStatus(): ManagerStatus {
    const flavor = this.activeDevice === 'cpu' ? 'cpu' : this.activeDevice === 'gpu' ? 'vulkan' : this.resolveFlavor()
    return {
      state: this.state,
      modelSize: this.modelSize,
      ctxSize: this.ctxSize,
      ctxSetting: this.ctxSetting,
      device: this.device,
      activeDevice: this.activeDevice,
      modelDownloaded: isModelDownloaded(this.modelSize),
      binaryReady: this.findBinary(flavor) !== null,
      port: this.port,
      restarts: this.restarts,
      queueLength: this.queue.length,
      active: this.inFlight,
      idleUnloaded: this.idleUnloaded,
      lastError: this.lastError,
    }
  }

  onStateChange(fn: (s: ManagerState) => void): () => void {
    this.stateListeners.push(fn)
    return () => { this.stateListeners = this.stateListeners.filter(f => f !== fn) }
  }

  onProgress(fn: (p: SetupProgress) => void): () => void {
    this.progressListeners.push(fn)
    return () => { this.progressListeners = this.progressListeners.filter(f => f !== fn) }
  }

  setModelSize(size: ModelSize): void {
    if (size !== this.modelSize) {
      this.modelSize = size
      if (this.state !== 'idle') this.scheduleRestart()
    }
  }

  /** Смена устройства: применяется рестартом сервера (аргумент запуска). */
  setDevice(device: LlamaDevice): void {
    const next: LlamaDevice = device === 'cpu' || device === 'gpu' ? device : 'auto'
    if (next === this.device) return
    this.device = next
    // Явная смена настройки = новая попытка GPU даже после отката.
    this.gpuUnavailable = false
    if (this.state !== 'idle') this.scheduleRestart()
  }

  /** Какую сборку llama-server качать/запускать при текущей настройке. */
  private resolveFlavor(): LlamaFlavor {
    if (this.device === 'cpu') return 'cpu'
    // Явный gpu — ретраим Vulkan при каждом старте (драйвер могли поставить),
    // auto после отката не долбится до смены настройки.
    if (this.device === 'gpu') return 'vulkan'
    return this.gpuUnavailable ? 'cpu' : 'vulkan'
  }

  /** Idempotent, single-flight: download binary+model if needed, start server. */
  ensureReady(): Promise<boolean> {
    if (this.state === 'ready') return Promise.resolve(true)
    if (this.ensurePromise) return this.ensurePromise
    this.shuttingDown = false
    this.lifecycle.abort()
    this.lifecycle = new AbortController()
    const promise = this.doEnsure(this.lifecycle.signal).finally(() => {
      if (this.ensurePromise === promise) this.ensurePromise = null
    })
    this.ensurePromise = promise
    return promise
  }

  /** Queued completion. Auto-ensures readiness; rejects cleanly if unavailable. */
  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    opts.signal?.throwIfAborted()
    this.lastActivity = Date.now()
    const startup = this.ensureReady()
    const ready = opts.signal ? await new Promise<boolean>((resolve, reject) => {
      const signal = opts.signal!
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        reject(signal.reason ?? new Error('Request cancelled'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      startup.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
      if (signal.aborted) onAbort()
    }) : await startup
    opts.signal?.throwIfAborted()
    if (!ready || this.shuttingDown || this.state !== 'ready') throw new Error(this.lastError ?? 'Local model not ready')
    return this.enqueue(prompt, opts)
  }

  shutdown(): void {
    this.shuttingDown = true
    this.lifecycle.abort()
    this.ensurePromise = null
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    this.stopWatchdog()
    this.killProcess()
    this.activeDevice = null
    this.rejectQueued('Manager shutting down')
    this.setState('idle')
  }

  // ── Preparation + spawn ───────────────────────────────────────────────────

  private async doEnsure(signal: AbortSignal, resetRestarts = true): Promise<boolean> {
    try {
      this.setState('preparing')
      // Сборка зависит от устройства: auto/gpu — Vulkan-версия llama-server
      // (скачается сама в bin-vulkan/), cpu — обычная из bin/.
      this.emit({ phase: 'binary', percent: 0 })
      const { flavor } = await this.prepareBinary(this.resolveFlavor(), signal)
      if (signal.aborted) return false
      this.emit({ phase: 'model', percent: 0 })
      if (!isModelDownloaded(this.modelSize)) {
        await downloadModel(this.modelSize, p => {
          if (!signal.aborted) this.emit({ phase: 'model', percent: p.percent, error: p.error })
        })
      }
      if (signal.aborted) return false
      this.emit({ phase: 'starting', percent: 95 })
      const ok = await this.spawnServer(flavor, signal)
      if (signal.aborted) return false
      if (ok) {
        this.lastError = undefined
        if (resetRestarts) this.restarts = 0
        this.setState('ready')
        this.dispatch()
        this.startWatchdog()
        this.emit({ phase: 'ready', percent: 100 })
        return true
      }
      this.setState('error')
      this.rejectQueued('Local model failed to start')
      this.emit({ phase: 'error', percent: 0, error: this.lastError })
      return false
    } catch (err) {
      if (signal.aborted) return false
      this.lastError = (err as Error).message
      log('[LocalModels] ensure failed: %s', this.lastError)
      this.setState('error')
      this.rejectQueued(this.lastError)
      this.emit({ phase: 'error', percent: 0, error: this.lastError })
      return false
    }
  }

  private findBinary(flavor: LlamaFlavor): string | null {
    if (isBinaryReady(flavor)) return getLlamaServerPath(flavor)
    // Fallback для старых установок: бинарь, уложенный в ресурсы при сборке.
    const candidates = [
      join(app.getAppPath(), 'resources', 'llama', LLAMA_SERVER_NAME),
      join(process.resourcesPath ?? '', 'llama', LLAMA_SERVER_NAME),
    ]
    for (const p of candidates) if (existsSync(p)) return p
    return null
  }

  private async prepareBinary(flavor: LlamaFlavor, signal: AbortSignal): Promise<{ binary: string; flavor: LlamaFlavor }> {
    signal.throwIfAborted()
    const installed = this.findBinary(flavor)
    if (installed) return { binary: installed, flavor }
    try {
      const binary = await downloadBinary(flavor, p => {
        if (!signal.aborted) this.emit({ phase: 'binary', percent: p.percent, error: p.error })
      }, signal)
      signal.throwIfAborted()
      return { binary, flavor }
    } catch (err) {
      signal.throwIfAborted()
      if (flavor === 'cpu') throw err
      this.markGpuUnavailable((err as Error).message)
      return this.prepareBinary('cpu', signal)
    }
  }

  private async spawnServer(requested: LlamaFlavor, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    if (!isModelDownloaded(this.modelSize)) { this.lastError = `model ${this.modelSize} not downloaded`; return false }

    this.killProcess()
    const threads = Math.max(2, Math.min(8, cpus().length))
    const args = [
      '--model', getModelPath(this.modelSize),
      '--port', String(this.port),
      '--host', '127.0.0.1',
      '--threads', String(threads),
      // --ctx-size — общий пул на все слоты. --parallel фиксируем равным
      // MAX_PARALLEL: при дефолтном значении llama.cpp контекст делится
      // на неизвестное число слотов и бюджет запроса становится непредсказуемым.
      '--ctx-size', String(this.ctxSize),
      '--parallel', String(MAX_PARALLEL),
      '--batch-size', '512',
      '--log-disable',
    ]
    try {
      const { binary, flavor } = await this.prepareBinary(requested, signal)
      // Vulkan-сборка: сначала дешёвая проверка адаптера (~0.3 с). Регулярка
      // по stderr ненадёжна — новые сборки не печатают «offloaded …» на
      // дефолтном verbosity, а --list-devices даёт прямой ответ.
      if (flavor === 'vulkan') {
        if (!(await this.detectVulkanDevice(binary, signal))) {
          if (signal.aborted) return false
          return this.fallbackToCpu('no Vulkan devices on this machine', signal)
        }
        // Вся модель + KV-кэш в VRAM: 1B-Q4 с контекстом — ~1-1.5 ГБ.
        args.push('--n-gpu-layers', '999')
      }
      if (signal.aborted) return false
      if (!(await this.isPortAvailable(signal))) {
        if (!signal.aborted) this.lastError = `Local model port ${this.port} is already in use`
        return false
      }
      if (signal.aborted) return false
      this.logLines = []
      const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      this.process = child
      child.stderr?.on('data', (d: Buffer) => {
        if (this.process !== child) return
        const line = d.toString().trim()
        if (!line) return
        this.logLines.push(line)
        if (this.logLines.length > 500) this.logLines.shift()
        log('[LocalModels] %s', line.slice(0, 200))
      })
      child.on('exit', (code) => {
        log('[LocalModels] server exited code=%s', code)
        if (this.process !== child) return
        this.process = null
        this.stopWatchdog()
        if (!signal.aborted && this.state === 'ready') void this.handleCrash(signal)
      })
      child.on('error', (err) => {
        log('[LocalModels] spawn error: %s', err.message)
        if (this.process === child) this.process = null
      })
      const up = await this.waitForHealth(child, signal, STARTUP_TIMEOUT_MS)
      if (signal.aborted) return false
      if (!up) {
        if (this.process === child) this.killProcess()
        // Vulkan не поднялся (нет карты / старый драйвер) — тихо пробуем CPU.
        if (flavor === 'vulkan') return this.fallbackToCpu('server did not become healthy', signal)
        this.lastError = 'server did not become healthy'
        return false
      }
      if (this.process !== child) return false
      // Устройство подтверждено: vulkan — адаптер был найден и сервер жив,
      // cpu — либо выбрано явно, либо после отката.
      this.activeDevice = flavor === 'vulkan' ? 'gpu' : 'cpu'
      log('[LocalModels] ready port=%d model=%s device=%s threads=%d', this.port, this.modelSize, this.activeDevice, threads)
      return true
    } catch (err) {
      if (signal.aborted) return false
      this.lastError = (err as Error).message
      return false
    }
  }

  /** Откат Vulkan→CPU: запоминаем и перезапускаемся на CPU-сборке. */
  private fallbackToCpu(reason: string, signal: AbortSignal): Promise<boolean> {
    this.markGpuUnavailable(reason)
    return this.spawnServer('cpu', signal)
  }

  private markGpuUnavailable(reason: string): void {
    log('[LocalModels] GPU недоступен (%s) — откат на CPU', reason)
    this.gpuUnavailable = true
    this.activeDevice = null
  }

  /**
   * Есть ли GPU-адаптер: `llama-server --list-devices` печатает по строке на
   * бэкенд («Vulkan0: NVIDIA GeForce GTX 1660 (… MiB …)»). Пустой список или
   * падение процесса = GPU нет. CPU-сборка флага не достигает — проверяется
   * только Vulkan-бинарь.
   */
  private detectVulkanDevice(binary: string, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let out = ''
      let settled = false
      let child: ChildProcess | null = null
      const done = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        try { child?.kill() } catch { /* already dead */ }
        resolve(ok)
      }
      const onAbort = () => done(false)
      const timer = setTimeout(() => done(false), 15_000)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) { done(false); return }
      child = spawn(binary, ['--list-devices'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { out += d.toString() })
      child.on('error', () => done(false))
      child.on('exit', () => {
        const devices = out.split('\n').filter(l => /^(Vulkan|CUDA|SYCL|ROCm|Metal)\d?\s*[:=]/.test(l.trim()))
        done(devices.length > 0)
      })
    })
  }

  private async waitForHealth(child: ChildProcess, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      // Сервер умер до готовности (например, Vulkan без адаптера) — ждём
      // таймаут бессмысленно: сразу отдаём неудачу, fallback начнётся раньше.
      if (signal.aborted || this.process !== child) return false
      try {
        const res = await fetch(`${this.getBaseUrl()}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) })
        await res.body?.cancel()
        if (res.ok) return this.process === child && !signal.aborted
      } catch { /* not up yet */ }
      await delay(500, undefined, { signal }).catch(() => {})
    }
    return false
  }

  private isPortAvailable(signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.once('close', () => { if (signal.aborted) resolve(false) })
      probe.listen({ host: '127.0.0.1', port: this.port, signal }, () => {
        probe.close(() => resolve(!signal.aborted))
      })
    })
  }

  // ── Watchdog + auto-restart ───────────────────────────────────────────────

  private startWatchdog(): void {
    this.stopWatchdog()
    const signal = this.lifecycle.signal
    this.watchdog = setInterval(async () => {
      if (this.state !== 'ready') return
      if (this.checkIdle()) return
      try {
        const res = await fetch(`${this.getBaseUrl()}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) })
        await res.body?.cancel()
        if (!res.ok) void this.handleCrash(signal)
      } catch {
        void this.handleCrash(signal)
      }
    }, HEALTH_INTERVAL_MS)
  }

  /** Простой > 5 мин без вызовов — выгружаем сервер, RAM свободна; следующий вызов поднимет его сам. */
  private checkIdle(): boolean {
    if (this.queue.length > 0 || this.inFlight > 0) return false
    if (Date.now() - this.lastActivity < IDLE_UNLOAD_MS) return false
    log('[LocalModels] idle >%d min — unloading server to free RAM', IDLE_UNLOAD_MS / 60_000)
    this.stopWatchdog()
    this.lifecycle.abort()
    this.setState('idle')
    this.killProcess()
    this.restarts = 0
    this.idleUnloaded = true
    this.activeDevice = null
    return true
  }

  private stopWatchdog(): void {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null }
  }

  private async handleCrash(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.shuttingDown || this.state !== 'ready') return
    this.stopWatchdog()
    this.setState('error')
    this.killProcess()
    this.lifecycle.abort()
    this.activeDevice = null
    if (this.restarts >= MAX_RESTARTS) {
      this.lastError = `server crashed ${this.restarts}× — giving up`
      log('[LocalModels] %s', this.lastError)
      this.emit({ phase: 'error', percent: 0, error: this.lastError })
      this.rejectQueued(this.lastError)
      return
    }
    const restartDelay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)]
    this.restarts++
    log('[LocalModels] auto-restart #%d in %dms', this.restarts, restartDelay)
    this.lifecycle = new AbortController()
    const nextSignal = this.lifecycle.signal
    const promise = (async () => {
      await delay(restartDelay, undefined, { signal: nextSignal }).catch(() => {})
      if (nextSignal.aborted) return false
      return this.doEnsure(nextSignal, false)
    })().finally(() => {
      if (this.ensurePromise === promise) this.ensurePromise = null
    })
    this.ensurePromise = promise
    await promise
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.restart()
    }, 0)
  }

  private async restart(): Promise<void> {
    this.shutdown()
    await this.ensureReady()
  }

  private killProcess(): void {
    const child = this.process
    this.process = null
    try { child?.kill() } catch { /* already dead */ }
  }

  // ── Request queue ─────────────────────────────────────────────────────────

  private enqueue(prompt: string, opts: CompleteOptions): Promise<string> {
    const priority = opts.priority ?? 'default'
    if (this.queue.length >= MAX_QUEUE) {
      const dropIdx = this.queue.findIndex(q => q.priority === 'janitor')
      if (dropIdx >= 0) {
        const dropped = this.queue.splice(dropIdx, 1)[0]
        dropped.cleanup()
        dropped.reject(new Error('Queue overflow'))
      }
      else return Promise.reject(new Error('Queue full'))
    }
    return new Promise((resolve, reject) => {
      const cancelQueued = (error: Error) => {
        const index = this.queue.indexOf(item)
        if (index < 0) return
        this.queue.splice(index, 1)
        item.cleanup()
        reject(error)
      }
      const onAbort = () => cancelQueued(new Error('Request cancelled'))
      const timer = setTimeout(() => cancelQueued(new Error('Local model queue timed out')), MAX_QUEUE_WAIT_MS)
      const item: QueueItem = {
        priority, prompt,
        maxTokens: opts.maxTokens ?? 100,
        temperature: opts.temperature ?? 0.1,
        timeoutMs: opts.timeoutMs ?? 15_000,
        resolve, reject, ts: Date.now(),
        signal: opts.signal,
        cleanup: () => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort) },
      }
      this.queue.push(item)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (opts.signal?.aborted) { onAbort(); return }
      this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.ts - b.ts)
      this.dispatch()
    })
  }

  /**
   * Диспетчер: запускает до MAX_PARALLEL запросов одновременно, остальное
   * ждёт в приоритетной очереди. Голова очереди берётся на каждый
   * освободившийся слот. Длинная фоновая дистилляция занимает максимум
   * один слот: второй остаётся доступен короткому watcher/navigator.
   */
  private dispatch(): void {
    if (this.shuttingDown || this.state !== 'ready') return
    while (this.inFlight < MAX_PARALLEL && this.queue.length > 0) {
      const next = this.queue.findIndex(item => item.priority !== 'janitor' || this.backgroundInFlight === 0)
      if (next < 0) break
      const item = this.queue.splice(next, 1)[0]
      item.cleanup()
      this.inFlight++
      if (item.priority === 'janitor') this.backgroundInFlight++
      void this.runItem(item)
    }
  }

  private rejectQueued(reason: string): void {
    for (const item of this.queue.splice(0)) {
      item.cleanup()
      item.reject(new Error(reason))
    }
  }

  private async runItem(item: QueueItem): Promise<void> {
    try {
      item.resolve(await this.callLlm(item))
    } catch (err) {
      item.reject(err as Error)
    } finally {
      this.inFlight--
      if (item.priority === 'janitor') this.backgroundInFlight--
      this.dispatch()
    }
  }

  private async callLlm(item: QueueItem): Promise<string> {
    item.signal?.throwIfAborted()
    this.lastActivity = Date.now()
    const controller = new AbortController()
    const lifecycleSignal = this.lifecycle.signal
    // Параллельный декод CPU-bound: при 2 занятых слотах каждый запрос идёт
    // заметно медленнее, поэтому таймаут растёт с числом соседей.
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, item.timeoutMs + (this.inFlight - 1) * TIMEOUT_PER_PEER_MS)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.getBaseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: item.prompt }],
          max_tokens: item.maxTokens,
          temperature: item.temperature,
          stream: false,
        }),
        signal: AbortSignal.any([controller.signal, lifecycleSignal, ...(item.signal ? [item.signal] : [])]),
      })
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`)
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      lifecycleSignal.throwIfAborted()
      item.signal?.throwIfAborted()
      return data.choices?.[0]?.message?.content?.trim() ?? ''
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private setState(s: ManagerState): void {
    this.state = s
    if (s === 'ready') { this.lastActivity = Date.now(); this.idleUnloaded = false }
    for (const fn of this.stateListeners) fn(s)
  }

  private emit(p: SetupProgress): void {
    for (const fn of this.progressListeners) fn(p)
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send('assistants:setupProgress', p)
    }
  }
}

export const localModels = new LocalModelManager()
