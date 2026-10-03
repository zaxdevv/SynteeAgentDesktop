/**
 * Детерминированные регрессионные тесты terminal-пайплайна:
 *   - PtyOutputBatcher (main): коалесинг/FIFO, bounded-батч, ACK/pause/resume,
 *     safety-таймер, поведение БЕЗ потребителя (нет ACK → pause никогда),
 *     releaseFlow/dispose;
 *   - TerminalWriteQueue (renderer): FIFO + pacing по колбэку xterm,
 *     fallback-таймер для скрытого окна (rAF не срабатывает), watchdog,
 *     bounded-дренаж, маркер exit в общей очереди;
 *   - resolvePreMountData: snapshot vs held без дублирования/потери;
 *   - сквозной FIFO: batcher → queue → итоговый текст == вход.
 *
 * Запуск (без новых зависимостей, esbuild есть как транзитивная зависимость vite):
 *   npx esbuild scripts/terminal-flow.test.ts --bundle --format=esm --outfile=.tmp-terminal-flow.mjs
 *   node .tmp-terminal-flow.mjs
 */
import { PtyOutputBatcher, type BatcherScheduler } from '../src/main/managers/ptyOutputBatcher'
import {
  TerminalWriteQueue,
  resolvePreMountData,
  type WriteQueueScheduler,
} from '../src/renderer/src/utils/terminalWriteQueue'

// ─── Мини-харнесс ────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
function ok(cond: boolean, name: string): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`  ✗ FAIL: ${name}`)
  }
}
function eq<T>(actual: T, expected: T, name: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(a === b, `${name} (got ${a}, want ${b})`)
}

// ─── Управляемый планировщик (детерминизм вместо реального времени) ───────────
interface FakeTimer {
  id: number
  fn: () => void
  at: number
  cancelled: boolean
}
class FakeScheduler implements BatcherScheduler, WriteQueueScheduler {
  now = 0
  private nextId = 1
  timers: FakeTimer[] = []
  rafs: Array<{ id: number; fn: () => void; cancelled: boolean }> = []

  setTimer(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.push({ id, fn, at: this.now + Math.max(0, ms), cancelled: false })
    return id
  }
  clearTimer(h: unknown): void {
    const t = this.timers.find(t => t.id === h)
    if (t) t.cancelled = true
  }
  raf(fn: () => void): unknown {
    const id = this.nextId++
    this.rafs.push({ id, fn, cancelled: false })
    return id
  }
  cancelRaf(h: unknown): void {
    const r = this.rafs.find(r => r.id === h)
    if (r) r.cancelled = true
  }
  /** Продвинуть время и выполнить все сработавшие таймеры. */
  advance(ms: number): void {
    this.now += ms
    for (let guard = 0; guard < 100000; guard++) {
      const due = this.timers
        .filter(t => !t.cancelled && t.at <= this.now)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      due.cancelled = true
      due.fn()
    }
  }
  /** Выполнить все запланированные rAF-колбэки (эмуляция видимого окна). */
  flushRaf(): void {
    for (const r of this.rafs.filter(r => !r.cancelled)) {
      r.cancelled = true
      r.fn()
    }
  }
}

// ═══════════════════════════ PtyOutputBatcher ═══════════════════════════════
{
  // 1. Коалесинг + FIFO: до срабатывания таймера ничего не уходит, затем один
  //    send с сохранением порядка.
  const s = new FakeScheduler()
  const sent: string[] = []
  const b = new PtyOutputBatcher({
    send: d => sent.push(d),
    scheduler: s,
    flushIntervalMs: 8,
    maxBatchBytes: 1_000_000,
  })
  b.push('a')
  b.push('b')
  b.push('c')
  eq(sent, [], 'batcher: no send before flush window')
  s.advance(8)
  eq(sent, ['abc'], 'batcher: coalesced FIFO send')
  b.push('d')
  b.push('e')
  s.advance(8)
  eq(sent, ['abc', 'de'], 'batcher: second batch preserves order')
  b.dispose()
}
{
  // 2. Bounded: переполнение батча → немедленный flush без ожидания таймера.
  const s = new FakeScheduler()
  const sent: string[] = []
  const b = new PtyOutputBatcher({ send: d => sent.push(d), scheduler: s, maxBatchBytes: 4 })
  b.push('ab')
  b.push('cd')
  eq(sent, ['abcd'], 'batcher: flush immediately at maxBatchBytes')
  b.dispose()
}
{
  // 3. Нет потребителя (нет ACK) → pause НИКОГДА не вызывается, даже при
  //    огромном выводе. Это защита от блокировки AI-exec без терминала.
  const s = new FakeScheduler()
  let pauses = 0
  let resumes = 0
  const b = new PtyOutputBatcher({
    send: () => { /* renderer отсутствует */ },
    pause: () => { pauses++ },
    resume: () => { resumes++ },
    scheduler: s,
    maxBatchBytes: 100,
    highWatermarkBytes: 100,
    maxPauseMs: 10,
  })
  for (let i = 0; i < 500; i++) b.push('x'.repeat(100))
  s.advance(1000)
  eq(pauses, 0, 'batcher/no-consumer: pause never called without ACK')
  eq(resumes, 0, 'batcher/no-consumer: resume never called without ACK')
  ok(!b.isPaused, 'batcher/no-consumer: never paused')
  b.dispose()
}
{
  // 4. ACK flow control: pause при unacked >= high, resume при <= low.
  const s = new FakeScheduler()
  const sent: string[] = []
  let pauses = 0
  let resumes = 0
  const b = new PtyOutputBatcher({
    send: d => sent.push(d),
    pause: () => { pauses++ },
    resume: () => { resumes++ },
    scheduler: s,
    maxBatchBytes: 1_000_000,
    highWatermarkBytes: 1000,
    lowWatermarkBytes: 200,
    maxPauseMs: 100_000,
  })
  b.push('x'.repeat(10))
  s.advance(8)
  b.ack(10) // первый ACK → flowEnabled = true, unacked = 0
  eq(pauses, 0, 'batcher/ack: no pause below high watermark')

  b.push('y'.repeat(2000))
  s.advance(8)
  eq(pauses, 1, 'batcher/ack: pause at high watermark')
  ok(b.isPaused, 'batcher/ack: isPaused true')

  b.ack(1500) // unacked = 500, всё ещё выше low
  eq(resumes, 0, 'batcher/ack: stays paused above low watermark')
  b.ack(500) // unacked = 0 <= low
  eq(resumes, 1, 'batcher/ack: resume at low watermark')
  ok(!b.isPaused, 'batcher/ack: isPaused false after resume')
  b.dispose()
}
{
  // 5. Safety-таймер maxPauseMs: PTY гарантированно возобновляется даже без ACK.
  const s = new FakeScheduler()
  let pauses = 0
  let resumes = 0
  const b = new PtyOutputBatcher({
    send: () => {},
    pause: () => { pauses++ },
    resume: () => { resumes++ },
    scheduler: s,
    maxBatchBytes: 1_000_000,
    highWatermarkBytes: 100,
    lowWatermarkBytes: 10,
    maxPauseMs: 500,
  })
  b.push('z'.repeat(10))
  s.advance(8)
  b.ack(10)
  b.push('q'.repeat(5000))
  s.advance(8)
  eq(pauses, 1, 'batcher/safety: paused on high watermark')
  s.advance(500)
  eq(resumes, 1, 'batcher/safety: force-resumed by maxPauseMs without ACK')
  ok(!b.isPaused, 'batcher/safety: not paused after safety resume')
  b.dispose()
}
{
  // 6. Гистерезис: после форсированного resume не pause'им снова, пока
  //    unacked не сольётся до low.
  const s = new FakeScheduler()
  let pauses = 0
  const b = new PtyOutputBatcher({
    send: () => {},
    pause: () => { pauses++ },
    resume: () => {},
    scheduler: s,
    maxBatchBytes: 1_000_000,
    highWatermarkBytes: 100,
    lowWatermarkBytes: 10,
    maxPauseMs: 100,
  })
  b.push('z'.repeat(10))
  s.advance(8)
  b.ack(10)
  b.push('q'.repeat(5000))
  s.advance(8)
  eq(pauses, 1, 'batcher/hysteresis: first pause')
  s.advance(100) // safety resume, unacked всё ещё 5000 > low
  b.push('r'.repeat(5000))
  s.advance(8)
  eq(pauses, 2, 'batcher/hysteresis: re-pause after safety resume while backlog stays high')
  b.ack(20000) // слить всё
  b.push('s'.repeat(5000))
  s.advance(8)
  eq(pauses, 3, 'batcher/hysteresis: pause again after full drain')
  b.dispose()
}
{
  // 7. releaseFlow: потребитель исчез → resume + pause отключён.
  const s = new FakeScheduler()
  let pauses = 0
  let resumes = 0
  const b = new PtyOutputBatcher({
    send: () => {},
    pause: () => { pauses++ },
    resume: () => { resumes++ },
    scheduler: s,
    maxBatchBytes: 1_000_000,
    highWatermarkBytes: 100,
    lowWatermarkBytes: 10,
    maxPauseMs: 100_000,
  })
  b.push('z'.repeat(10))
  s.advance(8)
  b.ack(10)
  b.push('q'.repeat(5000))
  s.advance(8)
  eq(pauses, 1, 'batcher/release: paused')
  b.releaseFlow()
  eq(resumes, 1, 'batcher/release: resumed on releaseFlow')
  ok(!b.flowControlActive, 'batcher/release: flow control disabled')
  b.push('w'.repeat(5000))
  s.advance(8)
  eq(pauses, 1, 'batcher/release: no pause after releaseFlow')
  b.dispose()
}
{
  // 8. dispose: отменяет отложенный flush (после dispose send не вызывается)
  //    и снимает паузу.
  const s = new FakeScheduler()
  const sent: string[] = []
  let resumes = 0
  const b = new PtyOutputBatcher({
    send: d => sent.push(d),
    pause: () => {},
    resume: () => { resumes++ },
    scheduler: s,
    maxBatchBytes: 1_000_000,
    highWatermarkBytes: 100,
    lowWatermarkBytes: 10,
    maxPauseMs: 100_000,
  })
  b.push('pending')
  b.dispose()
  s.advance(1000)
  eq(sent, [], 'batcher/dispose: pending batch not sent after dispose')
  eq(b.pendingBytes, 0, 'batcher/dispose: buffer cleared')

  const s2 = new FakeScheduler()
  const b2 = new PtyOutputBatcher({
    send: () => {},
    pause: () => {},
    resume: () => { resumes++ },
    scheduler: s2,
    maxBatchBytes: 1_000_000,
    highWatermarkBytes: 100,
    lowWatermarkBytes: 10,
    maxPauseMs: 100_000,
  })
  b2.push('z'.repeat(10))
  s2.advance(8)
  b2.ack(10)
  b2.push('q'.repeat(5000))
  s2.advance(8)
  b2.dispose()
  eq(resumes, 1, 'batcher/dispose: resumes a paused PTY')
}

// ═══════════════════════════ TerminalWriteQueue ═════════════════════════════
interface WriteRec {
  chunk: string
  done: () => void
}
function makeWriter(log: string[], inflight: WriteRec[]) {
  return (chunk: string, done: () => void): void => {
    log.push(chunk)
    inflight.push({ chunk, done })
  }
}
{
  // 9. FIFO + pacing: следующий write начинается только после колбэка xterm.
  const s = new FakeScheduler()
  const log: string[] = []
  const inflight: WriteRec[] = []
  const consumed: number[] = []
  const q = new TerminalWriteQueue({
    write: makeWriter(log, inflight),
    scheduler: s,
    chunkBytes: 10,
    onConsumed: b => consumed.push(b),
  })
  q.enqueue('abc')
  q.enqueue('def')
  s.flushRaf()
  eq(log, ['abcdef'], 'queue: single chunk written on rAF')
  eq(inflight.length, 1, 'queue: one write in flight')
  inflight.shift()!.done()
  eq(consumed, [6], 'queue: consumed bytes reported (ACK)')
  ok(q.bytes === 0, 'queue: drained')

  // Нет второго write, пока не завершился первый.
  const log2: string[] = []
  const inflight2: WriteRec[] = []
  const s2 = new FakeScheduler()
  const q2 = new TerminalWriteQueue({ write: makeWriter(log2, inflight2), scheduler: s2, chunkBytes: 4 })
  q2.enqueue('aaaa')
  q2.enqueue('bbbb')
  q2.enqueue('cccc')
  s2.flushRaf()
  eq(log2, ['aaaa'], 'queue/pacing: only first chunk written')
  inflight2.shift()!.done()
  s2.flushRaf()
  eq(log2, ['aaaa', 'bbbb'], 'queue/pacing: next chunk after callback')
  inflight2.shift()!.done()
  s2.flushRaf()
  eq(log2, ['aaaa', 'bbbb', 'cccc'], 'queue/pacing: all chunks in order')
  inflight2.shift()!.done()
  q2.dispose()
}
{
  // 10. Hidden window: rAF НЕ срабатывает, но fallback-таймер дренит очередь —
  //     она не растёт бесконечно (регрессия на баг «unbounded queue»).
  const s = new FakeScheduler()
  const log: string[] = []
  const inflight: WriteRec[] = []
  const q = new TerminalWriteQueue({
    write: (chunk, done) => { log.push(chunk); done() }, // синхронный xterm
    scheduler: s,
    chunkBytes: 8,
    hiddenTimeoutMs: 16,
  })
  for (let i = 0; i < 100; i++) q.enqueue('01234567') // 800 байт
  ok(q.bytes > 0, 'queue/hidden: bytes queued while hidden')
  // Продвигаем время: каждый тик флашит один чанк (rAF не вызывается вообще).
  for (let i = 0; i < 200 && q.bytes > 0; i++) s.advance(16)
  eq(q.bytes, 0, 'queue/hidden: fully drained via timeout fallback')
  eq(log.join(''), '01234567'.repeat(100), 'queue/hidden: all data preserved in order')
  q.dispose()
}
{
  // 11. Маркер завершения процесса идёт в ту же FIFO-очередь (регрессия: раньше
  //     прямой term.write обгонял ещё не записанные чанки).
  const s = new FakeScheduler()
  const log: string[] = []
  const inflight: WriteRec[] = []
  const q = new TerminalWriteQueue({ write: makeWriter(log, inflight), scheduler: s, chunkBytes: 4 })
  q.enqueue('OUT1')
  q.enqueue('OUT2')
  q.enqueue('\r\nMARK\r\n')
  while (inflight.length || q.bytes > 0) {
    s.flushRaf()
    const w = inflight.shift()
    if (!w) break
    w.done()
  }
  eq(log.join(''), 'OUT1OUT2\r\nMARK\r\n', 'queue/exit: marker after pending output (FIFO)')
  q.dispose()
}
{
  // 12. Watchdog: колбэк xterm не пришёл → планирование восстанавливается,
  // но ACK не отправляется за данные, не подтверждённые xterm.
  const s = new FakeScheduler()
  const log: string[] = []
  const q = new TerminalWriteQueue({
    write: (chunk) => { log.push(chunk) }, // колбэк НЕ вызывается
    scheduler: s,
    chunkBytes: 4,
    writeTimeoutMs: 100,
    hiddenTimeoutMs: 16,
  })
  q.enqueue('aaaa')
  q.enqueue('bbbb')
  s.flushRaf()
  eq(log, ['aaaa'], 'queue/watchdog: first chunk written')
  s.advance(100) // watchdog: stale callback invalidated; re-arm next batch
  s.advance(16)  // следующий тик
  eq(log, ['aaaa', 'bbbb'], 'queue/watchdog: continues after missing callback')
  q.dispose()
}
{
  // 13. dispose: очередь очищается, отложенный flush не выполняется.
  const s = new FakeScheduler()
  const log: string[] = []
  const q = new TerminalWriteQueue({ write: (chunk, done) => { log.push(chunk); done() }, scheduler: s, chunkBytes: 8 })
  q.enqueue('data')
  q.dispose()
  s.flushRaf()
  s.advance(1000)
  eq(log, [], 'queue/dispose: nothing written after dispose')
  eq(q.bytes, 0, 'queue/dispose: buffer cleared')
}
{
  // 14. Большая очередь → крупнее чанк за тик (быстрее дреним, данные не теряем).
  const s = new FakeScheduler()
  const log: string[] = []
  const q = new TerminalWriteQueue({
    write: (chunk, done) => { log.push(chunk); done() },
    scheduler: s,
    chunkBytes: 10,
    softCapBytes: 50,
  })
  for (let i = 0; i < 10; i++) q.enqueue('0123456789') // 100 байт
  s.flushRaf()
  ok(log[0].length > 10, 'queue/softcap: drains faster when queue exceeds soft cap')
  q.dispose()
}
{
  // 15. resolvePreMountData: без дублирования и без потери.
  eq(resolvePreMountData('FULL', ['a', 'b']), 'FULL', 'premount: non-empty snapshot wins (no duplication)')
  eq(resolvePreMountData('', ['a', 'b']), 'ab', 'premount: empty snapshot keeps held data (no loss)')
  eq(resolvePreMountData('', []), '', 'premount: both empty → empty')
}

// ═══════════════════════ Сквозной FIFO (main → renderer) ════════════════════
{
  // 16. Данные, прошедшие через батчер main, затем через очередь renderer,
  //     восстанавливаются байт-в-байт и в правильном порядке (ANSI не рвём).
  const sMain = new FakeScheduler()
  const chunks = ['\x1b[32m', 'hello', '\x1b[0m ', 'world\r\n', '\x1b[1mBOLD\x1b[0m']
  const batched: string[] = []
  const b = new PtyOutputBatcher({
    send: d => batched.push(d),
    scheduler: sMain,
    maxBatchBytes: 1_000_000,
    flushIntervalMs: 8,
  })
  for (const c of chunks) b.push(c)
  sMain.advance(8)
  b.dispose()

  const sR = new FakeScheduler()
  const out: string[] = []
  const q = new TerminalWriteQueue({
    write: (chunk, done) => { out.push(chunk); done() },
    scheduler: sR,
    chunkBytes: 7, // специально мелко → много тиков, проверяем порядок
    hiddenTimeoutMs: 16,
  })
  for (const c of batched) q.enqueue(c)
  while (q.bytes > 0) sR.advance(16)
  eq(out.join(''), chunks.join(''), 'e2e: byte-exact FIFO through batcher + queue')
  q.dispose()
}

console.log(`\nterminal-flow: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
