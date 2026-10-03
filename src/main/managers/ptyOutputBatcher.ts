/**
 * Батчер + flow-control для display-потока PTY (main → renderer, pty:data).
 *
 * Чистый модуль: НЕ импортирует electron/node-pty — это позволяет покрывать
 * его детерминированными тестами (scripts/terminal-flow.test.ts) с фейковым
 * планировщиком. Реальные pause()/resume() и webContents.send() передаются
 * колбэками из PtyManager.
 *
 * Что решает:
 *  1) Коалесит множество мелких чанков node-pty в один IPC-вызов за окно
 *     flushIntervalMs — при массовом выводе (npm install / git clone) это
 *     снижает количество IPC-сообщений с тысяч до ~60-120/сек.
 *  2) Ограничивает память: при переполнении батча (>= maxBatchBytes) — flush
 *     немедленно, буфер не растёт.
 *  3) Безопасный backpressure: если renderer подтверждает потребление (ACK) и
 *     не успевает (unacked >= highWatermarkBytes) — pause() PTY. Resume() при
 *     unacked <= lowWatermarkBytes. Если ACK'ов нет вообще (терминал не
 *     смонтирован, потребителя нет) — pause НИКОГДА не вызывается, чтобы не
 *     заблокировать AI-exec. Дополнительно жёсткий safety-таймер maxPauseMs:
 *     даже при активном ACK PTY гарантированно возобновляется.
 *
 * Порядок данных сохраняется: байты отправляются строго в порядке push()
 * (одна сессия = один батчер, join() сохраняет FIFO).
 */

export interface BatcherScheduler {
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

const defaultScheduler: BatcherScheduler = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface PtyOutputBatcherOptions {
  /** Отправка готового батча в renderer (webContents.send('pty:data', ...)). */
  send: (data: string) => void
  /** Притормозить PTY (node-pty IPty.pause). */
  pause?: () => void
  /** Возобновить PTY (node-pty IPty.resume). */
  resume?: () => void
  /** Для логов/тестов — момент смены состояния backpressure. */
  onPausedChange?: (paused: boolean) => void
  /** Порог немедленного flush (байт). */
  maxBatchBytes?: number
  /** Окно коалесинга (мс). */
  flushIntervalMs?: number
  /** Pause при unacked >= high (байт). */
  highWatermarkBytes?: number
  /** Resume при unacked <= low (байт). */
  lowWatermarkBytes?: number
  /** Жёсткий safety: сколько максимум держать PTY на паузе без ACK (мс). */
  maxPauseMs?: number
  scheduler?: BatcherScheduler
}

export const DEFAULT_MAX_BATCH_BYTES = 64 * 1024
export const DEFAULT_FLUSH_INTERVAL_MS = 8
export const DEFAULT_HIGH_WATERMARK_BYTES = 4 * 1024 * 1024
export const DEFAULT_LOW_WATERMARK_BYTES = 1024 * 1024
export const DEFAULT_MAX_PAUSE_MS = 1000

export class PtyOutputBatcher {
  private parts: string[] = []
  private buffered = 0
  private unacked = 0
  /** true после первого ACK — значит у renderer есть живой потребитель. */
  private flowEnabled = false
  private paused = false
  /** Гистерезис: после resume ждём слива до low, прежде чем снова pause. */
  private awaitDrain = false
  private disposed = false
  private timer: unknown = null
  private pauseTimer: unknown = null

  private readonly maxBatchBytes: number
  private readonly flushIntervalMs: number
  private readonly highWatermarkBytes: number
  private readonly lowWatermarkBytes: number
  private readonly maxPauseMs: number
  private readonly scheduler: BatcherScheduler

  constructor(private readonly opts: PtyOutputBatcherOptions) {
    this.maxBatchBytes = opts.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    this.highWatermarkBytes = opts.highWatermarkBytes ?? DEFAULT_HIGH_WATERMARK_BYTES
    this.lowWatermarkBytes = opts.lowWatermarkBytes ?? DEFAULT_LOW_WATERMARK_BYTES
    this.maxPauseMs = opts.maxPauseMs ?? DEFAULT_MAX_PAUSE_MS
    this.scheduler = opts.scheduler ?? defaultScheduler
  }

  /** Добавить чанк вывода. Может отправить батч немедленно при переполнении. */
  push(data: string): void {
    if (this.disposed || !data) return
    this.parts.push(data)
    this.buffered += data.length
    if (this.buffered >= this.maxBatchBytes) {
      this.flush()
      return
    }
    if (this.timer === null) {
      this.timer = this.scheduler.setTimer(() => {
        this.timer = null
        this.flush()
      }, this.flushIntervalMs)
    }
  }

  /** Немедленно отправить накопленный батч (порядок сохраняется). */
  flush(): void {
    if (this.timer !== null) {
      this.scheduler.clearTimer(this.timer)
      this.timer = null
    }
    if (!this.parts.length) return
    const payload = this.parts.length === 1 ? this.parts[0] : this.parts.join('')
    this.parts = []
    this.buffered = 0
    this.unacked += payload.length
    this.opts.send(payload)
    this.maybePause()
  }

  /** Renderer подтвердил потребление N байт (после term.write callback). */
  ack(bytes: number): void {
    if (this.disposed) return
    const n = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0
    if (n > 0) this.flowEnabled = true
    this.unacked = Math.max(0, this.unacked - n)
    if (this.unacked <= this.lowWatermarkBytes) this.awaitDrain = false
    if (this.paused && this.unacked <= this.lowWatermarkBytes) this.resumeNow()
  }

  /**
   * Потребитель исчез (renderer dispose/kill/окно пересоздано): снимаем
   * backpressure и забываем про ACK'и, чтобы не блокировать PTY.
   */
  releaseFlow(): void {
    this.flowEnabled = false
    this.unacked = 0
    this.awaitDrain = false
    if (this.paused) this.resumeNow()
  }

  get isPaused(): boolean {
    return this.paused
  }

  get pendingBytes(): number {
    return this.buffered
  }

  get unackedBytes(): number {
    return this.unacked
  }

  get flowControlActive(): boolean {
    return this.flowEnabled
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== null) {
      this.scheduler.clearTimer(this.timer)
      this.timer = null
    }
    if (this.paused) this.resumeNow()
    this.parts = []
    this.buffered = 0
    this.unacked = 0
    this.flowEnabled = false
  }

  private maybePause(): void {
    if (!this.flowEnabled || this.paused || this.disposed || this.awaitDrain) return
    if (this.unacked < this.highWatermarkBytes) return
    this.paused = true
    try {
      this.opts.pause?.()
    } catch {
      /* PTY уже мёртв — backpressure не нужен */
    }
    this.opts.onPausedChange?.(true)
    this.pauseTimer = this.scheduler.setTimer(() => {
      this.pauseTimer = null
      this.resumeNow()
    }, this.maxPauseMs)
  }

  private resumeNow(): void {
    if (!this.paused) return
    this.paused = false
    if (this.pauseTimer !== null) {
      this.scheduler.clearTimer(this.pauseTimer)
      this.pauseTimer = null
    }
    // Safety resume must not disable backpressure until an arbitrarily large
    // backlog drains: the next emitted batch rechecks the high watermark.
    this.awaitDrain = false
    try {
      this.opts.resume?.()
    } catch {
      /* PTY уже мёртв */
    }
    this.opts.onPausedChange?.(false)
  }
}
