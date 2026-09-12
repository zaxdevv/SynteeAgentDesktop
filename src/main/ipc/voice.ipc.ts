import { ipcMain, BrowserWindow, app } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync, statSync } from 'fs'
import type Store from 'electron-store'
import { AIClient } from '../../core/ai/AIClient'

// ── Whisper worker_thread (ленивый, переиспользуется между вызовами) ──
// Спавнится при первом voice:transcribe / voice:download. Модель кэшируется в
// HF cache (один раз скачивается). Пересоздаётся только при смене размера
// модели (через msg type:'init'). Паттерн как у ai-worker.ts.
//
// ⚠️ voice:status НЕ спавнит воркер — проверка «скачана ли модель» это чистый
// fs-lookup, он делается прямо в main (isWhisperModelCached). Раньше статус
// спавнил воркер с ПОЛНОЙ загрузкой модели в RAM — достаточно было один раз
// открыть Настройки, и ~40-140MB висели до закрытия приложения.
let whisperWorker: Worker | null = null
let whisperReqId = 0
const whisperPending = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void }>()

// ── Idle-timeout воркера ─────────────────────────────────────────────
// После последнего transcribe/download воркер живёт WHISPER_IDLE_MS и
// терминируется (модель выгружается из RAM). Следующее использование голоса
// перезагрузит модель из локального кэша за пару секунд — приемлемо.
let whisperIdleTimer: NodeJS.Timeout | null = null
let whisperDownloading = false // guard: не терминировать во время скачивания
const WHISPER_IDLE_MS = 10 * 60 * 1000

function touchWhisperIdle(): void {
  if (whisperIdleTimer) clearTimeout(whisperIdleTimer)
  whisperIdleTimer = setTimeout(() => {
    whisperIdleTimer = null
    if (whisperPending.size > 0 || whisperDownloading) return
    if (whisperWorker) {
      console.log('[voice] whisper worker idle %d min — terminating', WHISPER_IDLE_MS / 60000)
      try { whisperWorker.terminate() } catch { /* ignore */ }
      whisperWorker = null
    }
  }, WHISPER_IDLE_MS)
}

const MODEL_BY_SIZE: Record<string, string> = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
}
const MODEL_DISPLAY_SIZE: Record<string, string> = {
  tiny: '~40 MB',
  base: '~140 MB',
}

/**
 * Проверка «скачана ли модель» без спавна воркера — чистый fs-чек в main.
 * Зеркалит isModelCached из whisper-worker.ts (та же структура HF-кэша:
 * <cacheDir>/models--{org}--{model}/snapshots/<hash>/ с .onnx + config.json).
 */
function isWhisperModelCached(modelId: string): boolean {
  try {
    const cacheDir = process.env.TRANSFORMERS_CACHE || join(app.getPath('userData'), 'transformers-cache')
    const [org, model] = modelId.split('/')
    const snapshotsDir = join(cacheDir, `models--${org}--${model}`, 'snapshots')
    if (!existsSync(snapshotsDir)) return false
    for (const snap of readdirSync(snapshotsDir)) {
      const snapDir = join(snapshotsDir, snap)
      if (!statSync(snapDir).isDirectory()) continue
      const files = readdirSync(snapDir)
      if (files.some(f => f.endsWith('.onnx') || f.endsWith('.onnx_data')) && files.includes('config.json')) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

function getWhisperWorkerPath(): string {
  // В dev/prod после сборки воркер лежит рядом с main-бандлом: out/main/whisper-worker.js
  return join(__dirname, 'whisper-worker.js')
}

function ensureWhisperWorker(modelSize: string): Worker {
  // Redirect HF cache to userData — в packaged-приложении node_modules
  // read-only (asar), модели должны качаться в writable-директорию.
  if (!process.env.TRANSFORMERS_CACHE) {
    process.env.TRANSFORMERS_CACHE = join(app.getPath('userData'), 'transformers-cache')
  }
  if (whisperWorker) return whisperWorker
  whisperWorker = new Worker(getWhisperWorkerPath(), {
    workerData: { modelSize },
    env: process.env,
  })
  // Проксим прогресс, результат и статус обратно в активный mainWin.
  whisperWorker.on('message', (msg: Record<string, unknown>) => {
    const type = msg.type as string
    if (type === 'result' || type === 'error') {
      const reqId = msg.reqId as string | undefined
      const pending = reqId ? whisperPending.get(reqId) : undefined
      if (pending && reqId) {
        whisperPending.delete(reqId)
        if (type === 'result') pending.resolve((msg.text as string) || '')
        else pending.reject(new Error((msg.message as string) || 'Whisper error'))
      }
    }
    // Прогресс шлём в active main window для live-индикации в инпут-баре.
    if (type === 'progress' || type === 'error') {
      const win = getMainWinSafe()
      win?.webContents.send('voice:progress', {
        stage: msg.stage,
        progress: msg.progress,
        message: msg.message,
      })
    }
    // Статус модели шлём в active main window для UI настроек.
    if (type === 'status') {
      const win = getMainWinSafe()
      win?.webContents.send('voice:status', {
        status: msg.status,
        cached: msg.cached,
        modelSize: msg.modelSize,
        modelId: msg.modelId,
        displaySize: msg.displaySize,
      })
    }
  })
  whisperWorker.on('error', (err) => {
    console.error('[whisper-worker] error:', err.message)
    // Завершаем все pending-запросы с ошибкой.
    for (const [, p] of whisperPending) p.reject(err)
    whisperPending.clear()
    whisperWorker = null
  })
  whisperWorker.on('exit', () => {
    whisperWorker = null
  })
  touchWhisperIdle() // стартуем idle-таймер сразу — если голос не используется, воркер умрёт через WHISPER_IDLE_MS
  return whisperWorker
}

// Безопасное получение main window (функция устанавливается при registerVoiceIPC).
let _getMainWin: () => BrowserWindow | null = () => null
function getMainWinSafe(): BrowserWindow | null {
  try { return _getMainWin() } catch { return null }
}

/**
 * Транскрипция через локальный Whisper (переиспользуется voice:transcribe
 * и speech.stt из плагинов). audio — mono 16 кГц Float32Array.
 */
export async function whisperTranscribe(
  store: Store,
  audio: Float32Array,
  modelSize?: 'tiny' | 'base',
): Promise<string> {
  const size = modelSize || (store.get('sttModelSize') as string) || 'tiny'
  const worker = ensureWhisperWorker(size)
  const reqId = `stt-${++whisperReqId}`
  worker.postMessage({ type: 'init', modelSize: size })
  const p = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      whisperPending.delete(reqId)
      reject(new Error('Превышено время ожидания распознавания (180с). Возможно, модель ещё скачивается — повторите через минуту.'))
    }, 180000)
    whisperPending.set(reqId, {
      resolve: (t) => { clearTimeout(timer); resolve(t) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    worker.postMessage({ type: 'transcribe', reqId, audio, modelSize: size })
  })
  return p.finally(() => touchWhisperIdle())
}

export function registerVoiceIPC(
  store: Store,
  getMainWin: () => BrowserWindow | null
): void {
  _getMainWin = getMainWin

  // Текст → речь через OpenAI TTS endpoint
  ipcMain.handle('voice:tts', async (_, text: string) => {
    const client = new AIClient(store)
    const audioBase64 = await client.textToSpeech(text)
    return audioBase64 // base64 mp3
  })

  // Отправить голосовой запрос в чат (после STT в renderer)
  ipcMain.handle('voice:sendQuery', async (_, text: string) => {
    const mainWin = getMainWin()
    if (!mainWin) return
    mainWin.webContents.send('voice:query', { text })
  })

  // ── Локальный Whisper: транскрипция 16kHz mono Float32Array → текст ──
  // Аудио захватывается в renderer (getUserMedia + AudioContext resample),
  // инференс идёт в worker_thread чтобы не блокировать main-поток IPC.
  ipcMain.handle('voice:transcribe', async (_, audio: Float32Array, opts?: { modelSize?: 'tiny' | 'base' }) => {
    return whisperTranscribe(store, audio, opts?.modelSize)
  })

  // ── Groq Whisper fallback (только если sttProvider='groq') ──
  // Принимает webm/opus ArrayBuffer (как есть из MediaRecorder), пишет во
  // временный файл в userData/recordings/, multipart POST на Groq.
  ipcMain.handle('voice:transcribeGroq', async (_, audioData: ArrayBuffer) => {
    const apiKey = (store.get('groqApiKey') as string) || ''
    if (!apiKey) throw new Error('Не указан Groq API key в настройках')
    const recordingsDir = join(app.getPath('userData'), 'recordings')
    if (!existsSync(recordingsDir)) mkdirSync(recordingsDir, { recursive: true })
    const tmpPath = join(recordingsDir, `stt-${Date.now()}.webm`)
    writeFileSync(tmpPath, Buffer.from(audioData))
    try {
      // FormData через multipart-запрос. Node 18+ (Electron 36) имеет fetch+FormData+Blob.
      const form = new FormData()
      form.append('file', new Blob([readFileSync(tmpPath)], { type: 'audio/webm' }), 'recording.webm')
      form.append('model', 'whisper-large-v3')
      form.append('language', 'ru')
      const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(`Groq API error ${resp.status}: ${errText.slice(0, 200)}`)
      }
      const data = await resp.json() as { text?: string }
      return (data.text || '').trim()
    } finally {
      try { unlinkSync(tmpPath) } catch { /* ok */ }
    }
  })

  // ── Статус модели Whisper (для UI настроек) ──
  // Возвращает { status, cached, modelSize, modelId, displaySize }.
  // status: 'idle' | 'downloading' | 'ready' | 'error'.
  // cached: true если модель уже в кэше (можно юзать без скачивания).
  //
  // ⚠️ Если воркер НЕ запущен — НЕ спавним его ради проверки кэша. Раньше
  // этот хендлер звал ensureWhisperWorker() → воркер грузил модель целиком
  // в RAM (~40-140MB + onnxruntime) только потому, что юзер открыл Настройки.
  // Проверка «скачана ли модель» — чистый fs-lookup, делаем прямо в main.
  ipcMain.handle('voice:status', async (_, modelSize?: string) => {
    const size = modelSize || (store.get('sttModelSize') as string) || 'tiny'
    const modelId = MODEL_BY_SIZE[size] || MODEL_BY_SIZE.tiny

    // Воркер уже живёт — спрашиваем у него (у него актуальный _modelStatus).
    if (whisperWorker) {
      return new Promise((resolve) => {
        const worker = whisperWorker!
        const timer = setTimeout(() => resolve({ status: 'unknown', cached: false, modelSize: size }), 5000)
        const handler = (msg: Record<string, unknown>) => {
          if (msg.type === 'status' && msg.modelSize === size) {
            clearTimeout(timer)
            worker.off('message', handler)
            resolve({
              status: msg.status,
              cached: msg.cached,
              modelSize: msg.modelSize,
              modelId: msg.modelId,
              displaySize: msg.displaySize,
            })
          }
        }
        worker.on('message', handler)
        worker.postMessage({ type: 'status', modelSize: size })
      })
    }

    // Воркера нет — fs-чек кэша без спавна.
    return {
      status: 'idle',
      cached: isWhisperModelCached(modelId),
      modelSize: size,
      modelId,
      displaySize: MODEL_DISPLAY_SIZE[size] || '',
    }
  })

  // ── Явное скачивание модели Whisper (из настроек) ──
  // Возвращает { ok: boolean }. Прогресс приходит через 'voice:progress' event.
  ipcMain.handle('voice:download', async (_, modelSize?: string) => {
    const size = modelSize || (store.get('sttModelSize') as string) || 'tiny'
    const worker = ensureWhisperWorker(size)
    whisperDownloading = true // guard: idle-таймер не терминирует воркер во время скачивания
    return new Promise((resolve) => {
      let resolved = false
      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; resolve({ ok: false, error: 'timeout' }) }
      }, 600000) // 10 мин на скачивание
      const handler = (msg: Record<string, unknown>) => {
        if (msg.type === 'status' && msg.status === 'ready' && msg.modelSize === size) {
          resolved = true
          clearTimeout(timer)
          worker.off('message', handler)
          resolve({ ok: true })
        } else if (msg.type === 'error' && !resolved) {
          resolved = true
          clearTimeout(timer)
          worker.off('message', handler)
          resolve({ ok: false, error: msg.message })
        }
      }
      worker.on('message', handler)
      worker.postMessage({ type: 'download', modelSize: size })
    }).finally(() => {
      whisperDownloading = false
      touchWhisperIdle() // скачивание закончилось — воркер может умереть по idle
    })
  })
}

// Cleanup при quit (чтобы worker не держал процесс живым).
app.on('before-quit', () => {
  if (whisperIdleTimer) {
    clearTimeout(whisperIdleTimer)
    whisperIdleTimer = null
  }
  if (whisperWorker) {
    try { whisperWorker.terminate() } catch { /* ignore */ }
    whisperWorker = null
  }
})
