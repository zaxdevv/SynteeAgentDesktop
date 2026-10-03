/**
 * Per-session очередь записи pty:data → xterm с pacing'ом через колбэк xterm.
 *
 * Чистый модуль: НЕ импортирует xterm/DOM — планировщик и writer передаются
 * извне (browser-scheduler / фейковый в тестах). Покрывается
 * scripts/terminal-flow.test.ts.
 *
 * Зачем: раньше чанки складывались в неограниченный string[] и флашились
 * ТОЛЬКО по requestAnimationFrame. В скрытом/свёрнутом окне rAF не вызывается
 * → очередь росла бесконечно, а при возврате фокуса один гигантский write
 * фризил рендерер. Теперь:
 *  - FIFO-порядок строго сохраняется (важно для ANSI-последовательностей);
 *  - каждый write идёт через колбэк xterm → не заваливаем парсер (pacing);
 *  - watchdog-таймер: если rAF не сработал (hidden window) — флашим по
 *    таймауту, поэтому очередь НЕ растёт бесконтрольно;
 *  - при переполнении очереди увеличиваем размер чанка за тик — данные
 *    НЕ дропаются (нет truncation), просто дреним быстрее;
 *  - по завершении write сообщаем объём поглощённых байт (ACK → main),
 *    чтобы main мог включить безопасный backpressure.
 */

export interface WriteQueueScheduler {
  raf(fn: () => void): unknown
  cancelRaf(handle: unknown): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface TerminalWriteQueueOptions {
  /** xterm Terminal.write(data, callback) — callback вызывается после парсинга. */
  write: (chunk: string, done: () => void) => void
  scheduler: WriteQueueScheduler
  /** Байт за тик при нормальной очереди. */
  chunkBytes?: number
  /** Fallback-таймер на случай, если rAF не срабатывает (hidden window). */
  hiddenTimeoutMs?: number
  /** Выше этого объёма очереди дреним агрессивнее (x4 за тик). */
  softCapBytes?: number
  /** Watchdog: если колбэк xterm не пришёл — продолжаем, не стопоримся. */
  writeTimeoutMs?: number
  /** Сколько байт реально отдано xterm (для ACK в main). */
  onConsumed?: (bytes: number) => void
}

export const DEFAULT_CHUNK_BYTES = 64 * 1024
export const DEFAULT_HIDDEN_TIMEOUT_MS = 16
export const DEFAULT_SOFT_CAP_BYTES = 2 * 1024 * 1024
export const DEFAULT_WRITE_TIMEOUT_MS = 3000

export class TerminalWriteQueue {
  private parts: Array<{ data: string; ack: number }> = []
  private head = 0
  private pendingBytes = 0
  private rafHandle: unknown = null
  private timerHandle: unknown = null
  private watchdogHandle: unknown = null
  private armed = false
  private writing = false
  private disposed = false
  private seq = 0

  private readonly chunkBytes: number
  private readonly hiddenTimeoutMs: number
  private readonly softCapBytes: number
  private readonly writeTimeoutMs: number
  private readonly scheduler: WriteQueueScheduler
  private readonly opts: TerminalWriteQueueOptions

  constructor(opts: TerminalWriteQueueOptions) {
    this.opts = opts
    this.chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES
    this.hiddenTimeoutMs = opts.hiddenTimeoutMs ?? DEFAULT_HIDDEN_TIMEOUT_MS
    this.softCapBytes = opts.softCapBytes ?? DEFAULT_SOFT_CAP_BYTES
    this.writeTimeoutMs = opts.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS
    this.scheduler = opts.scheduler
  }

  get bytes(): number {
    return this.pendingBytes
  }

  get busy(): boolean {
    return this.writing || this.pendingBytes > 0 || this.armed
  }

  /** Добавить чанк в FIFO-очередь. Данные не теряются никогда. */
  enqueue(data: string, ackBytes = data.length): void {
    if (this.disposed || !data) return
    this.parts.push({ data, ack: ackBytes })
    this.pendingBytes += data.length
    this.arm()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.seq++
    if (this.rafHandle !== null) {
      this.scheduler.cancelRaf(this.rafHandle)
      this.rafHandle = null
    }
    if (this.timerHandle !== null) {
      this.scheduler.clearTimer(this.timerHandle)
      this.timerHandle = null
    }
    if (this.watchdogHandle !== null) {
      this.scheduler.clearTimer(this.watchdogHandle)
      this.watchdogHandle = null
    }
    this.armed = false
    this.writing = false
    this.parts = []
    this.head = 0
    this.pendingBytes = 0
  }

  private arm(): void {
    if (this.disposed || this.armed || this.writing) return
    this.armed = true
    this.rafHandle = this.scheduler.raf(() => this.fire())
    this.timerHandle = this.scheduler.setTimer(() => this.fire(), this.hiddenTimeoutMs)
  }

  private fire(): void {
    if (!this.armed) return
    this.armed = false
    if (this.rafHandle !== null) {
      this.scheduler.cancelRaf(this.rafHandle)
      this.rafHandle = null
    }
    if (this.timerHandle !== null) {
      this.scheduler.clearTimer(this.timerHandle)
      this.timerHandle = null
    }
    this.drain()
  }

  private drain(): void {
    if (this.disposed || this.writing) return
    const chunk = this.takeChunk()
    if (chunk === null) return
    this.writing = true
    const token = ++this.seq
    // ACK is sent ONLY from xterm's real parse-completion callback. A
    // watchdog ACK would falsely claim consumption and reopen the floodgate.
    this.watchdogHandle = this.scheduler.setTimer(() => {
      this.watchdogHandle = null
      // Recover scheduling if xterm never calls back, but don't ACK bytes we
      // cannot prove were parsed. The PTY's bounded safety pause will resume.
      this.writing = false
      this.seq++
      if (!this.disposed && this.pendingBytes > 0) this.arm()
    }, this.writeTimeoutMs)
    this.opts.write(chunk.data, () => this.finishWrite(token, chunk.ack))
  }

  private finishWrite(token: number, bytes: number): void {
    if (token !== this.seq) return // stale callback after timeout/dispose
    if (!this.writing) return
    this.writing = false
    if (this.watchdogHandle !== null) {
      this.scheduler.clearTimer(this.watchdogHandle)
      this.watchdogHandle = null
    }
    this.opts.onConsumed?.(bytes)
    if (this.disposed) return
    if (this.pendingBytes > 0) this.arm()
  }

  /** Забрать из головы очереди пачку до limit байт, не разрывая чанки. */
  private takeChunk(): { data: string; ack: number } | null {
    if (this.head >= this.parts.length) return null
    const limit = this.pendingBytes > this.softCapBytes ? this.chunkBytes * 4 : this.chunkBytes
    let out = ''
    let ack = 0
    while (this.head < this.parts.length && out.length < limit) {
      const next = this.parts[this.head]
      const count = Math.min(next.data.length, limit - out.length)
      out += next.data.slice(0, count)
      const consumedAck = Math.min(next.ack, count)
      ack += consumedAck
      if (count < next.data.length) {
        this.parts[this.head] = { data: next.data.slice(count), ack: next.ack - consumedAck }
        break
      }
      this.parts[this.head] = { data: '', ack: 0 }
      this.head++
    }
    if (this.head >= this.parts.length) {
      this.parts = []
      this.head = 0
    } else if (this.head > 256) {
      this.parts = this.parts.slice(this.head)
      this.head = 0
    }
    if (!out) return null
    this.pendingBytes -= out.length
    return { data: out, ack }
  }
}

/**
 * Решение о содержимом первого write после attach: snapshot из main (preMount
 * буфер) включает в себя все чанки, пришедшие до ответа, поэтому held при
 * непустом snapshot отбрасывается (иначе дублирование). Если snapshot пуст —
 * main ничего не буферизовал, значит held это реальные новые данные и их нужно
 * записать, чтобы ничего не потерять.
 */
export function resolvePreMountData(snapshot: string, held: readonly string[]): string {
  if (snapshot) return snapshot
  return held.join('')
}
