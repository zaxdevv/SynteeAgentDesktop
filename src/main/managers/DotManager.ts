// ── DotManager: always-on фоновые агенты (Syntee Dots) ───────────────────
//
// Dot = отдельный чат + конфиг + планировщик (см. shared/types/dot.ts).
// Менеджер владеет жизненным циклом Dot'ов:
//   • триггеры пробуждения: cron/interval (минутный тикер + таймеры),
//     fs.watch (изменения файлов), webhook (локальный HTTP), ручной запуск;
//   • wakeUp() — пробуждение = обычный agent-run через programmatic
//     chat:send с oneShotSkill-инъекцией персоны Dot'а и oneShotMode:'ask'
//     (read-only: фоновый Dot не пишет файлы и не запускает команды);
//   • механика молчания: ответ, начинающийся с [SILENT], удаляется из
//     чата — ран логируется как silent, пользователь не отвлекается;
//   • уведомления: report-раны шлют NotificationManager.push (трей/overlay).
//
// Инициализация: registerDotsIPC (main/index.ts) ПОСЛЕ registerChatIPC —
// chatSendImpl уже установлен, programmatic-отправка доступна.
import { BrowserWindow } from 'electron'
import { watch, type FSWatcher } from 'fs'
import http from 'http'
import type Store from 'electron-store'
import { v4 as uuid } from 'uuid'
import { matchesCronExpression } from '../../core/plugins/pluginScheduler'
import {
  createChat, renameChat, deleteChat, setChatModel,
  createDot, getAllDots, getDotById, updateDot, deleteDot as deleteDotRow,
  startDotRun, finishDotRun, getDotRunStats, getLastDotRun, getDotRuns,
  getLastDotReport, getDotReportCountSince,
  repairStaleDotRuns,
  getMessageById, deleteMessageById,
} from '../../core/db'
import { runStatusListeners, activeRuns, emitRunStatus } from '../ipc/chatShared'
import { sendChatMessageProgrammatic } from '../ipc/chat.ipc'
import { getNotificationManager } from './NotificationManager'
import { IPC_EVENTS } from '../../shared/constants'
import {
  DOT_SILENT_MARKER, DEFAULT_DOT_SETTINGS,
  type Dot, type DotConfig, type DotRun, type DotTrigger, type DotState, type DotSettings,
} from '../../shared/types'
import { log } from '../../core/logger'

/** Порт webhook-сервера Dots (localhost). Включается только если у хоть
 *  одного Dot'а есть webhookEnabled — иначе сервер не поднимается. */
export const DOTS_WEBHOOK_PORT = 48765
/** Лимит тела webhook-запроса (симметрично плагинам). */
const WEBHOOK_MAX_BODY = 1_048_576
/** Дебаунс fs.watch-событий на один Dot (мс) — batch изменений файлов. */
const FS_DEBOUNCE_MS = 3_000
/** Минимальный интервал между fs-пробуждениями одного Dot'а (мс). */
const FS_MIN_GAP_MS = 30_000
/** Минимальный интервал между webhook-пробуждениями одного Dot'а (мс) —
 *  защита от спама POST-запросами (каждое пробуждение = LLM-вызов). */
const WEBHOOK_MIN_GAP_MS = 10_000
/** Окно догоняющих пробуждений: пропущенная матча cron старше этого не
 *  догоняется (приложение было закрыто слишком давно — новость устарела). */
const CATCHUP_WINDOW_MS = 24 * 3600_000
/** Задержка перед запуском отложенного (queued) wake после освобождения чата. */
const QUEUED_WAKE_DELAY_MS = 1_500

/** Что передаётся в wakeUp как контекст триггера. */
export interface WakeContext {
  /** Изменённые пути (fs-триггер) / тело webhook'а и т.п. */
  detail?: string
}

/** Результат wakeUp: ok=false + причина, если пробуждение пропущено. */
export interface WakeResult {
  ok: boolean
  /** 'not_found' | 'disabled' | 'globally_disabled' | 'busy' */
  reason?: string
}

interface PendingWake {
  runId: string
  dotId: string
  userMsgId: string
  assistantMsgId: string
  trigger: DotTrigger
}

/** Отложенное пробуждение (чат занят — разбудим, когда освободится). */
interface QueuedWake {
  dotId: string
  trigger: DotTrigger
  ctx?: WakeContext
}

class DotManager {
  private store: Store | null = null
  private getWindow: (() => BrowserWindow | null) | null = null
  private dots = new Map<string, DotConfig>()
  /** interval-таймеры: dotId → timer. */
  private intervalTimers = new Map<string, NodeJS.Timeout>()
  /** Следующее плановое пробуждение: dotId → ts (для UI). */
  private nextRunAt = new Map<string, number>()
  /** Минутный тикер для cron-расписаний. */
  private cronTicker: NodeJS.Timeout | null = null
  /** fs.watch-наблюдатели: dotId → watchers[]. */
  private fsWatchers = new Map<string, FSWatcher[]>()
  /** Дебаунс fs-событий: dotId → { timer, paths }. */
  private fsDebounce = new Map<string, { timer: NodeJS.Timeout; paths: Set<string> }>()
  /** Последнее fs-пробуждение: dotId → ts. Живёт ОТДЕЛЬНО от fsDebounce
   *  (entry дебаунса удаляется после batch — иначе lastWake обнуляется и
   *  мин-гэп между пробуждениями никогда не срабатывает). */
  private fsLastWake = new Map<string, number>()
  /** Последнее webhook-пробуждение: dotId → ts (rate-limit). */
  private webhookLastWake = new Map<string, number>()
  /** Единый webhook-сервер (поднимается лениво). */
  private webhookServer: http.Server | null = null
  /** Webhook-сервер реально слушает порт (false = не поднят/упал). */
  private webhookListening = false
  /** Отложенные пробуждения: chatId → wake (чат занят пользователем/раном). */
  private queuedWakes = new Map<string, QueuedWake>()
  /** Активные wake-раны: chatId → pending. */
  private activeWakeRuns = new Map<string, PendingWake>()
  private listenerAttached = false

  // ── Инициализация ─────────────────────────────────────────────────────

  init(store: Store, getWindow: () => BrowserWindow | null): void {
    this.store = store
    this.getWindow = getWindow
    // Ремонт «застрявших» ранов: приложение могло закрыться во время
    // wake-рана — строка в dot_runs осталась status='running' навсегда.
    try {
      const repaired = repairStaleDotRuns()
      if (repaired > 0) log('[dots] init: отремонтировано %d зависших ранов', repaired)
    } catch (e) {
      log('[dots] init: ремонт dot_runs не удался: %s', (e as Error).message)
    }
    try {
      for (const d of getAllDots()) this.dots.set(d.id, d)
    } catch (e) {
      log('[dots] init: чтение dots из БД не удалось: %s', (e as Error).message)
    }
    if (!this.listenerAttached) {
      runStatusListeners.add(this.onRunStatus)
      this.listenerAttached = true
    }
    if (this.getSettings().enabled) {
      this.startAll()
      this.catchUpMissedCron()
    }
    log('[dots] init: %d dot(ов) загружено', this.dots.size)
  }

  /** Остановить всё (app quit). */
  shutdown(): void {
    this.stopAll()
    runStatusListeners.delete(this.onRunStatus)
    this.listenerAttached = false
  }

  private startAll(): void {
    for (const dot of this.dots.values()) {
      if (dot.enabled) this.startTriggers(dot)
    }
  }

  private stopAll(): void {
    if (this.cronTicker) { clearInterval(this.cronTicker); this.cronTicker = null }
    for (const t of this.intervalTimers.values()) clearTimeout(t)
    this.intervalTimers.clear()
    this.nextRunAt.clear()
    this.queuedWakes.clear()
    this.stopAllFsWatchers()
    this.stopWebhookServer()
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  /** Создать Dot: чат + модель + конфиг + триггеры. */
  createDot(input: {
    name: string
    icon: string
    color: string
    purpose: string
    rules?: string
    schedule?: { kind: 'cron' | 'interval'; value: string }
    watchPaths?: string[]
    webhookEnabled?: boolean
    modelId?: string | null
    modelProvider?: string | null
  }): Dot {
    if (!input.name.trim()) throw new Error('Придумай имя Dot’а')
    if (!input.purpose.trim()) throw new Error('Опиши задачу Dot’а (purpose)')
    if (input.schedule?.kind === 'cron') {
      // Валидация cron-выражения сразу — не отложенная ошибка в тикере.
      matchesCronExpression(input.schedule.value, new Date())
    }
    if (input.schedule?.kind === 'interval') {
      const sec = Number(input.schedule.value)
      if (!Number.isFinite(sec) || sec < 60) throw new Error('Интервал — минимум 60 секунд')
    }

    // Чат Dot'а: обычный чат, режим 'work' (без workdir).
    const chat = createChat(false, 'work')
    renameChat(chat.id, `Dot · ${input.name.trim()}`)

    // Модель: персональная → глобальная dots-модель → назначение main.
    const settings = this.getSettings()
    const modelId = input.modelId ?? settings.modelId ?? null
    const modelProvider = input.modelProvider ?? settings.modelProvider ?? null
    if (modelId && modelProvider) setChatModel(chat.id, modelId, modelProvider)

    const config = createDot({
      id: uuid(),
      name: input.name.trim(),
      icon: input.icon || 'bot',
      color: input.color || '#7c6cff',
      purpose: input.purpose.trim(),
      rules: input.rules?.trim() || undefined,
      schedule: input.schedule,
      watchPaths: input.watchPaths && input.watchPaths.length > 0 ? input.watchPaths : undefined,
      webhookEnabled: !!input.webhookEnabled,
      webhookSecret: input.webhookEnabled ? uuid().slice(0, 8) : undefined,
      modelId,
      modelProvider,
      chatId: chat.id,
      enabled: true,
    })
    this.dots.set(config.id, config)
    if (config.enabled && this.getSettings().enabled) this.startTriggers(config)
    this.broadcast(IPC_EVENTS.DOTS_CHANGED)
    log('[dots] создан Dot "%s" (%s), chatId=%s', config.name, config.id, config.chatId)
    return this.withState(config)
  }

  /** Обновить конфиг Dot'а (перезапускает триггеры). */
  updateDot(id: string, patch: Partial<DotConfig>): Dot {
    const dot = this.dots.get(id)
    if (!dot) throw new Error('Dot не найден')
    if (patch.schedule?.kind === 'cron') matchesCronExpression(patch.schedule.value, new Date())
    if (patch.schedule?.kind === 'interval') {
      const sec = Number(patch.schedule.value)
      if (!Number.isFinite(sec) || sec < 60) throw new Error('Интервал — минимум 60 секунд')
    }
    updateDot(id, patch)
    // Модель обновляем и на чате Dot'а (per-chat модель — механизм runChatSend).
    if (patch.modelId !== undefined || patch.modelProvider !== undefined) {
      const modelId = patch.modelId !== undefined ? patch.modelId : dot.modelId
      const modelProvider = patch.modelProvider !== undefined ? patch.modelProvider : dot.modelProvider
      if (modelId && modelProvider) setChatModel(dot.chatId, modelId, modelProvider)
      else setChatModel(dot.chatId, null, null)
    }
    const updated = getDotById(id)
    if (updated) {
      this.dots.set(id, updated)
      this.stopTriggers(id)
      if (updated.enabled && this.getSettings().enabled) this.startTriggers(updated)
    }
    this.pruneSharedTriggers()
    this.broadcast(IPC_EVENTS.DOTS_CHANGED)
    return this.withState(updated ?? dot)
  }

  /** Удалить Dot (+ его чат). Активный wake-ран останавливается. */
  deleteDot(id: string): void {
    const dot = this.dots.get(id)
    if (!dot) return
    this.stopTriggers(id)
    this.dots.delete(id)
    this.pruneSharedTriggers()
    // Останавливаем активный wake-ран: воркер продолжает стримить в уже
    // удалённый чат (жечь токены в никуда). Механика — как chat:stop.
    this.abortChatRun(dot.chatId)
    this.queuedWakes.delete(dot.chatId)
    this.fsLastWake.delete(id)
    this.webhookLastWake.delete(id)
    deleteDotRow(id)
    try { deleteChat(dot.chatId) } catch { /* чат мог быть уже удалён */ }
    this.broadcast(IPC_EVENTS.DOTS_CHANGED)
    log('[dots] удалён Dot "%s" (%s)', dot.name, id)
  }

  /** Удалить Dot по chatId (каскад из chat:delete — чат Dot'а удалили из
   *  сайдбара). Возвращает true, если Dot был найден и удалён. */
  deleteDotByChatId(chatId: string): boolean {
    for (const dot of this.dots.values()) {
      if (dot.chatId === chatId) {
        this.deleteDot(dot.id)
        return true
      }
    }
    return false
  }

  /**
   * Остановить активный ран в чате Dot'а (воркер + очередь статусов).
   * Минимальная версия chat:stop: чат всё равно удаляется — сохранять
   * частичный ответ не нужно, достаточно корректно погасить воркер.
   */
  private abortChatRun(chatId: string): void {
    const run = activeRuns.get(chatId)
    if (!run) return
    try {
      if (run.attachmentAbort) run.attachmentAbort.abort()
      if (run.streamCheckpointTimer) {
        clearInterval(run.streamCheckpointTimer)
        run.streamCheckpointTimer = null
      }
      ;(run.worker as unknown as { _terminated?: boolean })._terminated = true
      run.worker.terminate()
      run.doneSent = true
    } catch { /* воркер уже мёртв */ }
    activeRuns.delete(chatId)
    // Статус 'cancelled' с msgId рана: onRunStatus почистит activeWakeRuns.
    emitRunStatus(this.getWindow?.() ?? null, chatId, 'cancelled', run.msgId)
  }

  // ── Триггеры ──────────────────────────────────────────────────────────

  /** Запустить триггеры одного Dot'а (cron/interval/fs/webhook). */
  private startTriggers(dot: DotConfig): void {
    // cron → минутный тикер (общий, ленивый)
    if (dot.schedule?.kind === 'cron') {
      this.ensureCronTicker()
      this.nextRunAt.set(dot.id, nextCronMatch(dot.schedule.value))
    }
    // interval → персональный таймер
    if (dot.schedule?.kind === 'interval') {
      const sec = Math.max(60, Number(dot.schedule.value) || 3600)
      this.scheduleInterval(dot, sec * 1000)
    }
    // fs.watch
    if (dot.watchPaths && dot.watchPaths.length > 0) this.startFsWatch(dot)
    // webhook (общий сервер — лениво)
    if (dot.webhookEnabled) this.ensureWebhookServer()
  }

  private stopTriggers(dotId: string): void {
    const t = this.intervalTimers.get(dotId)
    if (t) { clearTimeout(t); this.intervalTimers.delete(dotId) }
    this.nextRunAt.delete(dotId)
    this.stopFsWatch(dotId)
    // Общие триггеры пересчитываются ПОСЛЕ update/delete, чтобы не
    // закрывать сервер между stopTriggers/startTriggers того же Dot'а.
  }

  private pruneSharedTriggers(): void {
    const enabled = this.getSettings().enabled
    let needsCron = false
    let needsWebhook = false
    for (const dot of this.dots.values()) {
      if (!enabled || !dot.enabled) continue
      needsCron ||= dot.schedule?.kind === 'cron'
      needsWebhook ||= !!dot.webhookEnabled
    }
    if (!needsCron && this.cronTicker) {
      clearInterval(this.cronTicker)
      this.cronTicker = null
    }
    if (!needsWebhook) this.stopWebhookServer()
  }

  private scheduleInterval(dot: DotConfig, ms: number): void {
    const t = setTimeout(() => {
      this.intervalTimers.delete(dot.id)
      const fresh = this.dots.get(dot.id)
      if (!fresh?.enabled || !this.getSettings().enabled) return
      this.wakeUp(fresh.id, 'interval')
      // Перепланируем следующий тик (Dot мог быть обновлён — берём свежий конфиг).
      const current = this.dots.get(dot.id)
      if (current?.schedule?.kind === 'interval') {
        const sec = Math.max(60, Number(current.schedule.value) || 3600)
        this.scheduleInterval(current, sec * 1000)
      }
    }, ms)
    t.unref?.()
    this.intervalTimers.set(dot.id, t)
    this.nextRunAt.set(dot.id, Date.now() + ms)
  }

  private ensureCronTicker(): void {
    if (this.cronTicker) return
    this.cronTicker = setInterval(() => {
      if (!this.getSettings().enabled) return
      const now = new Date()
      for (const dot of this.dots.values()) {
        if (!dot.enabled || dot.schedule?.kind !== 'cron') continue
        try {
          if (matchesCronExpression(dot.schedule.value, now)) {
            this.wakeUp(dot.id, 'cron')
          }
          this.nextRunAt.set(dot.id, nextCronMatch(dot.schedule.value))
        } catch { /* битый cron — уже провалидирован при создании */ }
      }
    }, 60_000)
    this.cronTicker.unref?.()
  }

  private startFsWatch(dot: DotConfig): void {
    const watchers: FSWatcher[] = []
    for (const p of dot.watchPaths ?? []) {
      try {
        const w = watch(p, { recursive: true }, (_event, filename) => {
          const path = filename ? `${p}\\${filename}` : p
          this.onFsEvent(dot.id, path)
        })
        w.on('error', () => { /* путь пропал — молча */ })
        watchers.push(w)
      } catch (e) {
        log('[dots] fs.watch(%s) не удался: %s', p, (e as Error).message)
      }
    }
    if (watchers.length > 0) this.fsWatchers.set(dot.id, watchers)
  }

  private stopFsWatch(dotId: string): void {
    const watchers = this.fsWatchers.get(dotId)
    if (watchers) {
      for (const w of watchers) { try { w.close() } catch { /* ignore */ } }
      this.fsWatchers.delete(dotId)
    }
    const d = this.fsDebounce.get(dotId)
    if (d) { clearTimeout(d.timer); this.fsDebounce.delete(dotId) }
  }

  private stopAllFsWatchers(): void {
    for (const id of [...this.fsWatchers.keys()]) this.stopFsWatch(id)
  }

  /** Событие fs.watch — дебаунсим (batch), затем будим Dot'а. */
  private onFsEvent(dotId: string, path: string): void {
    const dot = this.dots.get(dotId)
    if (!dot?.enabled || !this.getSettings().enabled) return
    let d = this.fsDebounce.get(dotId)
    if (!d) {
      d = { timer: null as unknown as NodeJS.Timeout, paths: new Set() }
      this.fsDebounce.set(dotId, d)
    }
    d.paths.add(path)
    if (d.timer) clearTimeout(d.timer)
    d.timer = setTimeout(() => {
      const entry = this.fsDebounce.get(dotId)
      if (!entry) return
      this.fsDebounce.delete(dotId)
      // Минимальный гэп: редактор может дёргать файлы сотнями событий.
      // lastWake живёт в отдельной персистентной мапе — иначе каждый новый
      // batch обнулял его и гэп никогда не срабатывал (будил каждые 3с).
      const lastWake = this.fsLastWake.get(dotId) ?? 0
      if (Date.now() - lastWake < FS_MIN_GAP_MS) {
        log('[dots] fs: мин-гэп %dс — batch из %d путей пропущен', FS_MIN_GAP_MS / 1000, entry.paths.size)
        return
      }
      this.fsLastWake.set(dotId, Date.now())
      const paths = [...entry.paths].slice(0, 20).join('\n')
      this.wakeUp(dotId, 'fs', { detail: `Изменились наблюдаемые файлы:\n${paths}` })
    }, FS_DEBOUNCE_MS)
    d.timer.unref?.()
  }

  // ── Webhook ───────────────────────────────────────────────────────────

  private ensureWebhookServer(): void {
    if (this.webhookServer) return
    this.webhookServer = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > WEBHOOK_MAX_BODY) {
          res.writeHead(413); res.end('payload too large'); req.destroy(); return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${DOTS_WEBHOOK_PORT}`)
        const body = Buffer.concat(chunks).toString('utf-8')
        // Маршрут: /dot/{dotId}?secret=...
        const m = url.pathname.match(/^\/dot\/([a-zA-Z0-9-]+)$/)
        if (!m) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end('{"ok":false,"error":"unknown route"}')
          return
        }
        const dot = this.dots.get(m[1])
        if (!dot || !dot.webhookEnabled) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end('{"ok":false,"error":"dot not found"}')
          return
        }
        const secret = url.searchParams.get('secret') ?? req.headers['x-dot-secret']
        if (dot.webhookSecret && secret !== dot.webhookSecret) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end('{"ok":false,"error":"bad secret"}')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        // Rate-limit: спам POST-запросами = последовательные LLM-вызовы.
        const lastWake = this.webhookLastWake.get(dot.id) ?? 0
        if (Date.now() - lastWake < WEBHOOK_MIN_GAP_MS) {
          res.end('{"ok":true,"skipped":"rate-limited"}')
          log('[dots] webhook(%s): rate-limit — пробуждение пропущено', dot.name)
          return
        }
        this.webhookLastWake.set(dot.id, Date.now())
        res.end('{"ok":true}')
        // Пробуждение — асинхронно, после ответа клиенту.
        const bodyPreview = body.slice(0, 500)
        this.wakeUp(dot.id, 'webhook', bodyPreview
          ? { detail: `Webhook-событие:\n${bodyPreview}` }
          : { detail: 'Webhook-событие (без тела)' })
      })
      req.on('error', () => { res.writeHead(400); res.end() })
    })
    this.webhookServer.once('error', e => {
      log('[dots] webhook-сервер на порту %d не поднялся: %s', DOTS_WEBHOOK_PORT, (e as Error).message)
      this.webhookServer = null
      this.webhookListening = false
    })
    this.webhookServer.once('listening', () => { this.webhookListening = true })
    this.webhookServer.listen(DOTS_WEBHOOK_PORT, '127.0.0.1')
    log('[dots] webhook-сервер слушает http://127.0.0.1:%d/dot/{id}', DOTS_WEBHOOK_PORT)
  }

  private stopWebhookServer(): void {
    if (this.webhookServer) {
      try { this.webhookServer.close() } catch { /* ignore */ }
      this.webhookServer = null
    }
    this.webhookListening = false
  }

  /** URL webhook'а Dot'а (для показа в UI). null, если сервер не слушает —
   *  UI не должен показывать мёртвый URL (порт занят другим процессом). */
  getWebhookUrl(dotId: string): string | null {
    const dot = this.dots.get(dotId)
    if (!dot?.webhookEnabled || !this.webhookListening) return null
    return `http://127.0.0.1:${DOTS_WEBHOOK_PORT}/dot/${dot.id}${dot.webhookSecret ? `?secret=${dot.webhookSecret}` : ''}`
  }

  // ── Пробуждение (сердце фичи) ─────────────────────────────────────────

  /** Ручное пробуждение (кнопка «Разбудить» / dots:runNow). */
  runNow(dotId: string): WakeResult {
    return this.wakeUp(dotId, 'manual')
  }

  /**
   * Разбудить Dot'а: agent-run в его чате с read-only тулами.
   * Если Dot уже работает — тихо пропускаем. Если с ним говорит пользователь
   * (чат занят) — НЕ теряем пробуждение: кладём в очередь и разбудим, когда
   * чат освободится (догоняющий запуск для cron/interval/fs/webhook).
   * Возвращает результат — ручной запуск сообщает пользователю причину пропуска.
   */
  wakeUp(dotId: string, trigger: DotTrigger, ctx?: WakeContext): WakeResult {
    const dot = this.dots.get(dotId)
    if (!dot) return { ok: false, reason: 'not_found' }
    if (!dot.enabled) return { ok: false, reason: 'disabled' }
    if (!this.getSettings().enabled) return { ok: false, reason: 'globally_disabled' }
    if (this.activeWakeRuns.has(dot.chatId)) return { ok: false, reason: 'busy' }
    if (activeRuns.has(dot.chatId)) {
      // Чат занят пользовательским запросом. Ручной запуск просто отклоняем
      // (кнопка и так залочена), плановые триггеры — откладываем.
      if (trigger === 'manual') {
        log('[dots] wakeUp(%s): чат занят — ручной запуск отклонён', dot.name)
        return { ok: false, reason: 'busy' }
      }
      log('[dots] wakeUp(%s): чат занят — пробуждение отложено в очередь', dot.name)
      this.queuedWakes.set(dot.chatId, { dotId: dot.id, trigger, ctx })
      this.broadcast(IPC_EVENTS.DOTS_STATE)
      return { ok: true }
    }

    const run = startDotRun(dotId, trigger)
    log('[dots] wakeUp: Dot "%s" (%s), триггер=%s, runId=%s', dot.name, dotId, trigger, run.id)
    this.broadcast(IPC_EVENTS.DOTS_STATE)
    // Тост в рендерере: пользователь видит, что триггер сработал (кроме manual).
    this.broadcast(IPC_EVENTS.DOTS_WAKE, { dotId: dot.id, name: dot.name, trigger })

    const wakePrompt = this.buildWakePrompt(dot, trigger, ctx)
    const displayContent = this.buildWakeDisplay(dot, trigger)
    void sendChatMessageProgrammatic({
      chatId: dot.chatId,
      content: wakePrompt,
      displayContent,
      oneShotSkill: { name: `dot-${dot.id}`, instructions: this.buildPersona(dot) },
      // Read-only в фоне — как у OpenAI Dots: фоновый агент не пишет
      // файлы и не запускает команды. Пользователь в чате Dot'а может
      // писать как обычно (тогда работает штатная permission-модель).
      oneShotMode: 'ask',
    }).then(result => {
      this.activeWakeRuns.set(dot.chatId, {
        runId: run.id,
        dotId: dot.id,
        userMsgId: result.userMsg.id,
        assistantMsgId: result.assistantMsgId,
        trigger,
      })
      this.broadcast(IPC_EVENTS.DOTS_STATE)
    }).catch(e => {
      log('[dots] wakeUp(%s): отправка не удалась: %s', dot.name, (e as Error).message)
      finishDotRun(run.id, 'error', (e as Error).message)
      this.broadcast(IPC_EVENTS.DOTS_STATE)
    })
    return { ok: true }
  }

  /**
   * Догоняющие пробуждения при старте: расписание сработало, пока
   * приложение было закрыто — обычный wake пропущен навсегда. Догоняем,
   * если последняя прошедшая матча cron новее последнего рана и не старше
   * 24ч. Новые Dot'ы (ни одного рана) не догоняем — ждём плановой матчи.
   */
  private catchUpMissedCron(): void {
    const now = Date.now()
    let stagger = 0
    for (const dot of this.dots.values()) {
      if (!dot.enabled || dot.schedule?.kind !== 'cron') continue
      try {
        const last = getLastDotRun(dot.id)
        if (!last) continue
        const missedAt = lastCronMatch(dot.schedule.value)
        if (missedAt > last.startedAt && now - missedAt < CATCHUP_WINDOW_MS) {
          const delay = stagger
          stagger += 3_000
          const t = setTimeout(() => {
            const fresh = this.dots.get(dot.id)
            if (!fresh?.enabled || !this.getSettings().enabled) return
            log('[dots] catch-up: Dot "%s" — пропущенная матча %s', dot.name, new Date(missedAt).toLocaleString())
            this.wakeUp(dot.id, 'cron', {
              detail: 'Догоняющее пробуждение: расписание сработало, пока приложение было закрыто. Проверь, не произошло ли что-то важное за это время.',
            })
          }, delay)
          t.unref?.()
        }
      } catch { /* битый cron — уже провалидирован при создании */ }
    }
  }

  /** Слушатель статусов ранов: ловим завершение wake-рана Dot'а. */
  private onRunStatus = (
    chatId: string,
    status: 'running' | 'done' | 'error' | 'cancelled' | 'queued' | 'compacting',
    msgId?: string,
    error?: string,
  ): void => {
    // Чат освободился (терминальный статус ЛЮБОГО рана — пользовательского
    // или wake) — запускаем отложенное пробуждение, если оно копилось.
    if (status === 'done' || status === 'error' || status === 'cancelled') {
      this.drainQueuedWake(chatId)
    }
    const pending = this.activeWakeRuns.get(chatId)
    if (!pending) return
    if (status !== 'done' && status !== 'error' && status !== 'cancelled') return
    // Точность: терминальный статус должен принадлежать именно wake-рану
    // (в чате Dot'а может параллельно работать пользовательский запрос).
    if (msgId && msgId !== pending.assistantMsgId) return
    this.activeWakeRuns.delete(chatId)

    const dot = this.dots.get(pending.dotId)
    if (!dot) return

    if (status === 'error') {
      finishDotRun(pending.runId, 'error', error)
      this.notify(dot, 'Dot: ошибка пробуждения', error ?? 'Dot упал с ошибкой')
    } else if (status === 'cancelled') {
      finishDotRun(pending.runId, 'cancelled')
    } else {
      // done → механика молчания
      const deletedMessageIds: string[] = []
      const msg = getMessageById(pending.assistantMsgId)
      const text = (msg?.content ?? '').trim()
      // Пустой ответ = нечего сообщать: считаем тихим (иначе летело
      // уведомление «Есть обновление» с пустым телом).
      if (!text || isSilentReply(text)) {
        // Тихий ран: удаляем пару сообщений из чата — пользователь не
        // должен видеть «я проснулся, всё без изменений».
        try { deleteMessageById(pending.userMsgId); deletedMessageIds.push(pending.userMsgId) } catch { /* ignore */ }
        try { deleteMessageById(pending.assistantMsgId); deletedMessageIds.push(pending.assistantMsgId) } catch { /* ignore */ }
        finishDotRun(pending.runId, 'silent')
        log('[dots] Dot "%s": тихий ран (SILENT)', dot.name)
      } else {
        const summary = text.replace(/\s+/g, ' ').slice(0, 200)
        finishDotRun(pending.runId, 'report', summary, {
          promptTokens: msg?.promptTokens,
          completionTokens: msg?.completionTokens,
        })
        this.notify(dot, `Dot «${dot.name}» проснулся`, summary || 'Есть обновление')
        log('[dots] Dot "%s": report (%d симв.)', dot.name, text.length)
      }
      // DotChat перезагружает ленту (silent удалил сообщения, report добавил).
      this.broadcast(IPC_EVENTS.DOTS_RUN_FINISHED, { chatId, dotId: dot.id, status, deletedMessageIds })
    }
    this.broadcast(IPC_EVENTS.DOTS_STATE)
  }

  /** Запустить отложенное пробуждение (чат освободился после терминального
   *  статуса любого рана — пользовательского или wake). Задержка даёт UI
   *  мгновение спокойствия; wakeUp сам перепоставит в очередь, если чат
   *  снова занят (пользователь продолжил писать). */
  private drainQueuedWake(chatId: string): void {
    const queued = this.queuedWakes.get(chatId)
    if (!queued) return
    this.queuedWakes.delete(chatId)
    const t = setTimeout(() => {
      const dot = this.dots.get(queued.dotId)
      if (!dot?.enabled || dot.chatId !== chatId || !this.getSettings().enabled) return
      this.wakeUp(queued.dotId, queued.trigger, queued.ctx)
    }, QUEUED_WAKE_DELAY_MS)
    t.unref?.()
  }

  /** Уведомление о пробуждении (только если включены уведомления Dots). */
  private notify(dot: DotConfig, title: string, body: string): void {
    if (!this.getSettings().notify) return
    try {
      getNotificationManager()?.push({
        type: 'agent_done',
        title,
        body,
        priority: 'info',
        actions: [{ id: 'open', label: 'Открыть чат' }],
        chatId: dot.chatId,
      })
    } catch { /* уведомления не должны ломать Dots */ }
  }

  // ── Промпты ───────────────────────────────────────────────────────────

  /** Персона Dot'а — oneShotSkill-инъекция в system prompt рана. */
  private buildPersona(dot: DotConfig): string {
    const parts: string[] = [
      `Ты — Dot «${dot.name}» — всегда-активный фоновый агент пользователя Syntee.`,
      `## Твоя задача`,
      dot.purpose,
    ]
    if (dot.rules) {
      parts.push(`## Правила (границы, которые нельзя переходить)`)
      parts.push(dot.rules)
    }
    parts.push(`## Формат ответа`)
    parts.push([
      '- Если есть что сообщить пользователю (изменения, находки, важные события, выполнение задачи) — напиши краткий и конкретный отчёт в markdown.',
      `- Если изменений или новостей НЕТ — ответь ровно одним маркером: ${DOT_SILENT_MARKER} (без объяснений, без markdown). Такой ответ не будет показан пользователю.`,
      '- Ты работаешь в фоновом read-only режиме: не изменяй файлы, не запускай команды, не отправляй ничего наружу.',
      '- Пользователь может написать тебе в чат напрямую — тогда отвечай как обычный ассистент, помогая с твоей задачей.',
    ].join('\n'))
    return parts.join('\n\n')
  }

  /** Промпт пробуждения — user-сообщение, которое «будит» Dot'а. */
  private buildWakePrompt(dot: DotConfig, trigger: DotTrigger, ctx?: WakeContext): string {
    const triggerLabel: Record<DotTrigger, string> = {
      cron: 'расписание (cron)',
      interval: 'интервал',
      webhook: 'webhook-событие',
      fs: 'изменение наблюдаемых файлов',
      manual: 'ручной запуск пользователем',
    }
    const lines = [
      `СИСТЕМНОЕ ПРОБУЖДЕНИЕ — триггер: ${triggerLabel[trigger]}.`,
    ]
    if (ctx?.detail) lines.push('', ctx.detail)
    lines.push('', `Выполни свою задачу (см. системный промпт): ${dot.purpose}`)
    return lines.join('\n')
  }

  /** Короткий текст user-сообщения для UI (displayContent). */
  private buildWakeDisplay(_dot: DotConfig, trigger: DotTrigger): string {
    const label: Record<DotTrigger, string> = {
      cron: 'Пробуждение по расписанию',
      interval: 'Пробуждение по интервалу',
      webhook: 'Пробуждение по webhook',
      fs: 'Пробуждение: изменились файлы',
      manual: 'Ручное пробуждение',
    }
    return label[trigger]
  }

  // ── Настройки ─────────────────────────────────────────────────────────

  getSettings(): DotSettings {
    if (!this.store) return { ...DEFAULT_DOT_SETTINGS }
    return { ...DEFAULT_DOT_SETTINGS, ...(this.store.get('dotsSettings') as Partial<DotSettings> | undefined) }
  }

  setSettings(patch: Partial<DotSettings>): DotSettings {
    if (!this.store) return this.getSettings()
    const current = this.getSettings()
    const next = { ...current, ...patch }
    this.store.set('dotsSettings', next)
    // Главный тумблер: включение/выключение всех триггеров.
    if (patch.enabled !== undefined) {
      if (patch.enabled) this.startAll()
      else this.stopAll()
    }
    this.pruneSharedTriggers()
    this.broadcast(IPC_EVENTS.DOTS_CHANGED)
    return next
  }

  // ── Состояние для UI ──────────────────────────────────────────────────

  /** Все Dot'ы с живым состоянием (для dots:list). */
  getDots(): Dot[] {
    return [...this.dots.values()].map(d => this.withState(d))
  }

  getDot(dotId: string): Dot | null {
    const d = this.dots.get(dotId)
    return d ? this.withState(d) : null
  }

  private withState(dot: DotConfig): Dot {
    const stats = getDotRunStats(dot.id)
    const last = getLastDotRun(dot.id)
    const lastReport = getLastDotReport(dot.id)
    const isRunning = this.activeWakeRuns.has(dot.chatId)
    let status: DotState['status']
    if (!dot.enabled) status = 'disabled'
    else if (isRunning) status = 'running'
    else if (last?.status === 'error') status = 'error'
    else status = 'sleeping'
    return {
      ...dot,
      state: {
        status,
        lastRunAt: last?.startedAt,
        lastRunTrigger: last?.trigger,
        nextRunAt: dot.enabled ? this.nextRunAt.get(dot.id) : undefined,
        lastError: last?.status === 'error' ? last.summary : undefined,
        lastReport: lastReport
          ? { at: lastReport.startedAt, summary: (lastReport.summary ?? '').slice(0, 140) }
          : undefined,
        ...stats,
      },
    }
  }

  /** История ранов Dot’а. */
  getRuns(dotId: string, limit = 20): DotRun[] {
    try {
      return getDotRuns(dotId, limit)
    } catch {
      return []
    }
  }

  /** Unread-счётчики: сколько отчётов у каждого Dot'а после его lastSeen.
   *  Renderer хранит lastSeen локально (localStorage) и спрашивает пачкой —
   *  один IPC на весь список вместо N запросов. */
  getUnreadCounts(pairs: Array<{ dotId: string; since: number }>): Record<string, number> {
    const out: Record<string, number> = {}
    for (const p of pairs) {
      if (!this.dots.has(p.dotId)) continue
      try { out[p.dotId] = getDotReportCountSince(p.dotId, p.since) } catch { out[p.dotId] = 0 }
    }
    return out
  }

  // ── Broadcast ─────────────────────────────────────────────────────────

  private broadcast(event: string, payload?: unknown): void {
    try {
      const win = this.getWindow?.()
      win?.webContents.send(event, payload ?? null)
    } catch { /* окно может быть закрыто */ }
  }
}

/** Ответ считается «тихим», если начинается с маркера SILENT. */
function isSilentReply(text: string): boolean {
  const t = text.trim()
  return t === DOT_SILENT_MARKER || t.startsWith(DOT_SILENT_MARKER)
}

/** Следующая минута, матчащая cron-выражение (для UI nextRunAt). */
function nextCronMatch(expr: string): number {
  const now = new Date()
  // Начинаем со следующей минуты (текущая уже проверена тикером).
  const d = new Date(now.getTime() + 60_000)
  d.setSeconds(0, 0)
  // Максимум год минут — защита от вечноматчащихся выражений.
  for (let i = 0; i < 366 * 24 * 60; i++) {
    try {
      if (matchesCronExpression(expr, d)) return d.getTime()
    } catch {
      return Date.now() + 60_000
    }
    d.setMinutes(d.getMinutes() + 1)
  }
  return Date.now() + 60_000
}

/** Последняя прошедшая матча cron-выражения (≤ now, для catch-up).
 *  Идём назад от текущей минуты; не нашли за 24ч (например, «29 февраля»)
 *  — считаем, что матчи не было. */
function lastCronMatch(expr: string): number {
  const d = new Date()
  d.setSeconds(0, 0)
  for (let i = 0; i < 24 * 60; i++) {
    try {
      if (matchesCronExpression(expr, d)) return d.getTime()
    } catch {
      return 0
    }
    d.setMinutes(d.getMinutes() - 1)
  }
  return 0
}

export const dotManager = new DotManager()
