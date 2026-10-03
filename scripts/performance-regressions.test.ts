import assert from 'node:assert/strict'
import { clearFileCache, getFileCacheSnapshot, mergeFileCache } from '../src/core/context/fileReadCache'
import { indexById, mergeTail, prependOlder } from '../src/renderer/src/utils/messageWindow'
import { PtyOutputBatcher } from '../src/main/managers/ptyOutputBatcher'
import { TerminalWriteQueue } from '../src/renderer/src/utils/terminalWriteQueue'

let checks = 0
function check(fn: () => void) { fn(); checks++ }
const old = [{ id: 'a' }, { id: 'b' }]
check(() => assert.equal(mergeTail(old, []), old))
check(() => assert.deepEqual(mergeTail(old, [{ id: 'b' }, { id: 'c' }]).map(x => x.id), ['a', 'b', 'c']))
check(() => assert.deepEqual(prependOlder(old, [{ id: 'z' }, { id: 'a' }, { id: 'z' }]).map(x => x.id), ['z', 'a', 'b']))
check(() => assert.equal(indexById(old).get('b'), old[1]))
for (let n = 0; n < 25; n++) mergeFileCache(`test-${n}`, { file: { output: 'content', cachedAt: n, mtimeMs: 0, size: 7 } })
check(() => assert.deepEqual(getFileCacheSnapshot('test-0'), {}))
check(() => assert.ok(getFileCacheSnapshot('test-24').file))
getFileCacheSnapshot('test-5')
mergeFileCache('test-25', { file: { output: 'last', cachedAt: 26, mtimeMs: 0, size: 4 } })
check(() => assert.ok(getFileCacheSnapshot('test-5').file))
check(() => assert.deepEqual(getFileCacheSnapshot('test-6'), {}))
for (let n = 0; n < 26; n++) clearFileCache(`test-${n}`)

const timers: Array<() => void> = []
let paused = 0
const batch = new PtyOutputBatcher({send:()=>{},pause:()=>{paused++},resume:()=>{},maxBatchBytes:1,highWatermarkBytes:5,lowWatermarkBytes:1,scheduler:{setTimer:fn=>{timers.push(fn);return fn},clearTimer:()=>{}}})
batch.ack(1)
batch.push('123456')
check(() => assert.equal(paused,1))
timers.pop()?.()
batch.push('next')
check(() => assert.equal(paused,2))
batch.dispose()

let scheduled: (()=>void) | null = null
const writes: string[] = []
const done: Array<()=>void> = []
let ack = 0
const queue = new TerminalWriteQueue({write:(text,cb)=>{writes.push(text);done.push(cb)},onConsumed:n=>{ack+=n},chunkBytes:4,scheduler:{raf:fn=>{scheduled=fn;return fn},cancelRaf:()=>{},setTimer:()=>0,clearTimer:()=>{}}})
queue.enqueue('12345678')
queue.enqueue('END',0)
while (queue.bytes || done.length) { const fire=scheduled as (()=>void)|null;scheduled=null;fire?.();done.shift()?.() }
check(() => assert.equal(writes.join(''),'12345678END'))
check(() => assert.ok(writes.every(x=>x.length<=4)))
check(() => assert.equal(ack,8))
queue.dispose()
console.log(`performance-regressions: ${checks} PASS`)
