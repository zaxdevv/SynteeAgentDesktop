/**
 * Whisper Worker Thread — локальное распознавание речи (STT) для инпут-бара.
 *
 * Использует @huggingface/transformers (уже externalized в electron.vite.config.ts)
 * с onnxruntime-node. Модель Xenova/whisper-tiny (мультиязычная, auto-detect
 * языка) скачивается при первом использовании и кэшируется в HF cache.
 *
 * Запускается из main-процесса через registerVoiceIPC. Получает Float32Array
 * (16kHz mono PCM), возвращает распознанный текст. Работает изолированно
 * от main-потока, чтобы инференс не блокировал IPC.
 *
 * Паттерн повторяет ai-worker.ts (parentPort.on('message') + postMessage).
 */

import { parentPort, workerData } from 'worker_threads'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipeline: any = null
let _modelId = ''
let _initPromise: Promise<void> | null = null
// Статус модели: 'idle' | 'downloading' | 'ready' | 'error'. Шлём в main
// через postMessage для UI настроек (отображение «скачана/скачивается»).
let _modelStatus: 'idle' | 'downloading' | 'ready' | 'error' = 'idle'

// modelSize передаётся через workerData как дефолт, может переопределяться
// в сообщении { type: 'init', modelSize }.
const defaultModelSize = ((workerData as Record<string, unknown>).modelSize as string) || 'tiny'

const MODEL_BY_SIZE: Record<string, string> = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
}

// Размеры моделей для отображения в UI настроек.
const MODEL_DISPLAY_SIZE: Record<string, string> = {
  tiny: '~40 MB',
  base: '~140 MB',
}

/**
 * Проверяет, скачана ли модель в кэш transformers.js, БЕЗ инициализации
 * pipeline. transformers.js кэширует модели в env.cacheDir (по умолчанию
 * `node_modules/.cache/` или process.env.TRANSFORMERS_CACHE). Структура:
 *   <cacheDir>/models--Xenova--whisper-tiny/snapshots/<hash>/
 * Проверяем наличие директории snapshots с файлами .onnx.
 */
function isModelCached(modelId: string): { cached: boolean; path?: string } {
  try {
    const { env } = require('@huggingface/transformers')
    const { existsSync, readdirSync, statSync } = require('fs')
    const { join } = require('path')
    // ⚠️ @huggingface/transformers v4 НЕ читает TRANSFORMERS_CACHE из process.env
    // (в отличие от Python-версии). По умолчанию cacheDir = <__dirname библиотеки>/.cache/
    // — в production это внутри app.asar.unpacked (read-only в Program Files).
    // Явно перенаправляем в userData/transformers-cache (writable).
    const cacheDir = process.env.TRANSFORMERS_CACHE || env.cacheDir || './.cache'
    // transformers.js v3: models--{org}--{model}/snapshots/{hash}/
    const [org, model] = modelId.split('/')
    const modelDir = join(cacheDir, `models--${org}--${model}`)
    if (!existsSync(modelDir)) return { cached: false }
    const snapshotsDir = join(modelDir, 'snapshots')
    if (!existsSync(snapshotsDir)) return { cached: false }
    const snapshots = readdirSync(snapshotsDir)
    for (const snap of snapshots) {
      const snapDir = join(snapshotsDir, snap)
      if (!statSync(snapDir).isDirectory()) continue
      const files = readdirSync(snapDir)
      // Модель скачана если есть .onnx файл (encoder/decoder) + config.json.
      const hasOnnx = files.some((f: string) => f.endsWith('.onnx') || f.endsWith('.onnx_data'))
      const hasConfig = files.includes('config.json')
      if (hasOnnx && hasConfig) return { cached: true, path: snapDir }
    }
    return { cached: false }
  } catch {
    return { cached: false }
  }
}

async function ensurePipeline(modelSize: string): Promise<void> {
  const modelId = MODEL_BY_SIZE[modelSize] || MODEL_BY_SIZE.tiny
  if (_pipeline && _modelId === modelId) return
  // Меняем модель — освобождаем старую.
  if (_pipeline) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = _pipeline as any
      if (typeof p.dispose === 'function') p.dispose()
      else if (p.model?.dispose) p.model.dispose()
    } catch { /* ignore */ }
    _pipeline = null
  }
  _modelId = modelId

  if (_initPromise) return _initPromise
  _initPromise = (async () => {
    try {
      _modelStatus = 'downloading'
      postStatus()
      postMessage({ type: 'progress', stage: 'loading-model', progress: 0, message: `Загрузка модели ${modelId}...` })
      // require вместо await import: нативный import() не работает в V8-байткоде
      // (паттерн из core/context/embeddings.ts).
      const { pipeline, env } = require('@huggingface/transformers')
      // ⚠️ КРИТИЧНО: @huggingface/transformers v4 НЕ читает TRANSFORMERS_CACHE
      // из process.env (в отличие от Python-версии). По умолчанию cacheDir =
      // <__dirname библиотеки>/.cache/ — в production это внутри app.asar.unpacked
      // (read-only в Program Files). Явно перенаправляем в userData/transformers-cache.
      if (process.env.TRANSFORMERS_CACHE) {
        env.cacheDir = process.env.TRANSFORMERS_CACHE
      }
      try {
        env.backends.onnx.wasm.numThreads = 1
      } catch { /* onnx may not be configured */ }
      _pipeline = await pipeline('automatic-speech-recognition', modelId, {
        quantized: true,
        // Явно передаём cache_dir в pipeline — FileCache использует
        // file_cache_dir ?? env.cacheDir, и это самый надёжный способ.
        cache_dir: process.env.TRANSFORMERS_CACHE || undefined,
        // Прогресс-колбэк загрузки модели.
        progress_callback: (info: { status?: string; progress?: number; loaded?: number; total?: number }) => {
          if (info.status === 'progress' && typeof info.progress === 'number') {
            postMessage({ type: 'progress', stage: 'loading-model', progress: Math.min(100, Math.round(info.progress)), message: `Загрузка модели... ${Math.round(info.progress)}%` })
          } else if (info.status === 'done') {
            postMessage({ type: 'progress', stage: 'loading-model', progress: 100, message: 'Модель загружена' })
          }
        },
      })
      _modelStatus = 'ready'
      postStatus()
    } catch (e) {
      _pipeline = null
      _modelId = ''
      _initPromise = null
      _modelStatus = 'error'
      postStatus()
      postMessage({ type: 'error', message: `Не удалось загрузить модель Whisper: ${e instanceof Error ? e.message : String(e)}` })
      throw e
    }
  })()
  return _initPromise
}

/** Шлёт статус модели в main (для UI настроек: скачана/скачивается/ошибка). */
function postStatus(): void {
  const modelId = _modelId || MODEL_BY_SIZE[defaultModelSize]
  const cached = isModelCached(modelId)
  postMessage({
    type: 'status',
    status: _modelStatus,
    modelSize: defaultModelSize,
    modelId,
    cached: cached.cached,
    displaySize: MODEL_DISPLAY_SIZE[defaultModelSize] || '',
  })
}

// При первом запуске сразу инициализируем дефолтную модель.
ensurePipeline(defaultModelSize).catch(() => { /* ошибка уже отправлена через postMessage */ })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
parentPort?.on('message', async (msg: Record<string, unknown>) => {
  const type = msg.type as string

  if (type === 'init') {
    // Переинициализация с другой моделью.
    const size = (msg.modelSize as string) || defaultModelSize
    try {
      _initPromise = null
      await ensurePipeline(size)
      postMessage({ type: 'ready' })
    } catch { /* ошибка отправлена */ }
    return
  }

  if (type === 'status') {
    // Запрос статуса модели (для UI настроек). Не скачивает — только проверяет
    // кэш и текущий _modelStatus.
    const size = (msg.modelSize as string) || defaultModelSize
    const modelId = MODEL_BY_SIZE[size] || MODEL_BY_SIZE.tiny
    const cached = isModelCached(modelId)
    postMessage({
      type: 'status',
      status: _modelStatus,
      modelSize: size,
      modelId,
      cached: cached.cached,
      displaySize: MODEL_DISPLAY_SIZE[size] || '',
    })
    return
  }

  if (type === 'download') {
    // Явное скачивание модели (из настроек). Идёт через ensurePipeline с
    // прогрессом. После завершения шлём финальный status.
    const size = (msg.modelSize as string) || defaultModelSize
    try {
      _initPromise = null
      _pipeline = null
      _modelId = ''
      await ensurePipeline(size)
      // ensurePipeline уже шлёт postStatus при ready.
    } catch { /* ошибка отправлена через ensurePipeline */ }
    return
  }

  if (type === 'transcribe') {
    const audio = msg.audio as Float32Array
    const modelSize = (msg.modelSize as string) || defaultModelSize
    const reqId = msg.reqId as string | undefined
    try {
      await ensurePipeline(modelSize)
      if (!_pipeline) throw new Error('pipeline не инициализирован')
      const durSec = audio.length / 16000
      console.log('[whisper-worker] transcribe start: samples=%d (%.1fs), model=%s', audio.length, durSec, _modelId)
      // Параметры для максимальной точности tiny на русском БЕЗ галлюцинаций:
      //  - return_timestamps: true — ОБЯЗАТЕЛЬНО. Без timestamps Whisper
      //    галлюцинирует ("Хмммм..." повторами) на тишине/шуме.
      //  - chunk_length_s: 30 — chunking для длинных (>30с) аудио.
      //  - compression_ratio_threshold: 2.4 — обрезает повторы (Gzip-based).
      //  - no_speech_threshold: 0.6 — на тишине возвращает пустоту (не "Хммм").
      //  - condition_on_prev_tokens: false — не тянуть контекст (меньше зацикливаний).
      const opts: Record<string, unknown> = {
        sampling_rate: 16000,
        language: 'russian',
        return_timestamps: true,
        chunk_length_s: 30,
        compression_ratio_threshold: 2.4,
        no_speech_threshold: 0.6,
        condition_on_prev_tokens: false,
      }
      const output = await _pipeline(audio, opts)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawText: string = (output as any)?.text ?? ''
      let text: string = (rawText || '')
        .replace(/<\|[^|]*\|>/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      // Защита от зацикливаний ("Хмммм..." / повторы слова >8 раз).
      text = text.replace(/(\b\S{2,}\b)(?:\s?\1){8,}/gi, '$1')
      // Если текст > 50 символов/сек аудио — подозрение на галлюцинацию, обрезаем.
      const maxChars = Math.max(20, Math.ceil(durSec * 50))
      if (text.length > maxChars) {
        console.warn('[whisper-worker] SUSPECT hallucination: %d chars for %.1fs audio, truncating', text.length, durSec)
        text = text.slice(0, maxChars).trim()
      }
      console.log('[whisper-worker] transcribe done: %j (%d chars)', text, text.length)
      postMessage({ type: 'progress', stage: 'done', progress: 100, message: '' })
      postMessage({ type: 'result', reqId, text })
    } catch (e) {
      postMessage({ type: 'error', reqId, message: `Ошибка распознавания: ${e instanceof Error ? e.message : String(e)}` })
    }
    return
  }
})

function postMessage(msg: Record<string, unknown>): void {
  parentPort?.postMessage(msg)
}
