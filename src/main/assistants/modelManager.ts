import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, createWriteStream, statSync, unlinkSync, renameSync } from 'fs'
import { get } from 'https'
import type { IncomingMessage } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { log } from '../../core/logger'
import { createHash } from 'node:crypto'
import type { AssistantCtxSize, AssistantModelSize } from '../../shared/assistants'
import { assessAssistantHardware } from './hardware'

export type ModelSize = AssistantModelSize

export interface ModelInfo {
  size: ModelSize
  fileName: string
  url: string
  expectedBytes: number
  quant: string
  label: string
  sha256?: string
}

const MODELS: Record<ModelSize, ModelInfo> = {
  'lfm-350m': {
    size: 'lfm-350m',
    fileName: 'LFM2.5-350M-Q4_K_M.gguf',
    url: 'https://huggingface.co/LiquidAI/LFM2.5-350M-GGUF/resolve/657e078c94084481950a2d555a941481f715536b/LFM2.5-350M-Q4_K_M.gguf',
    sha256: '7e6f72643caafc9a68256686638c4d7916f2cec76d1df478d4c3ddcd95a6aed4',
    expectedBytes: 229_312_224,
    quant: 'Q4_K_M',
    label: 'LFM2.5 350M',
  },
  '1.2B': {
    size: '1.2B',
    fileName: 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/main/LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
    expectedBytes: 731_000_000,
    quant: 'Q4_K_M',
    label: 'LFM2.5-1.2B',
  },
  '1B': {
    size: '1B',
    fileName: 'gemma-3-1b-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf',
    expectedBytes: 810_000_000,
    quant: 'Q4_K_M',
    label: 'Gemma 3 1B',
  },
  '0.8B': {
    size: '0.8B',
    fileName: 'Qwen_Qwen3.5-0.8B-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Qwen_Qwen3.5-0.8B-GGUF/resolve/main/Qwen_Qwen3.5-0.8B-Q4_K_M.gguf',
    expectedBytes: 580_000_000,
    quant: 'Q4_K_M',
    label: 'Qwen3.5-0.8B',
  },
  'qwen-instruct-1.5b': {
    size: 'qwen-instruct-1.5b',
    fileName: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    expectedBytes: 1_117_320_736,
    quant: 'Q4_K_M',
    label: 'Qwen2.5 1.5B Instruct',
  },
  'qwen-coder-1.5b': {
    size: 'qwen-coder-1.5b',
    fileName: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/f86cb2c1fa58255f8052cc32aeede1b7482d4361/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    sha256: 'cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046',
    expectedBytes: 1_117_320_768,
    quant: 'Q4_K_M',
    label: 'Qwen2.5 Coder 1.5B',
  },
  'qwen-coder-abliterated': {
    size: 'qwen-coder-abliterated',
    fileName: 'Qwen2.5-Coder-1.5B-Instruct-abliterated-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-abliterated-GGUF/resolve/823ab8183896816dec7d29899310b556e655ad73/Qwen2.5-Coder-1.5B-Instruct-abliterated-Q4_K_M.gguf',
    sha256: '389b8172028c874b79a11358d258222dbce272b56ab3512ccc743893a25e06b4',
    expectedBytes: 1_117_321_696,
    quant: 'Q4_K_M',
    label: 'Qwen2.5 Coder 1.5B Abliterated',
  },
}

export function isModelSize(value: unknown): value is ModelSize {
  return typeof value === 'string' && Object.hasOwn(MODELS, value)
}

export function detectModelSize(): ModelSize {
  return assessAssistantHardware().recommendation?.modelSize ?? '0.8B'
}

export function getModelsDir(): string {
  const dir = join(app.getPath('userData'), 'assistants', 'models')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getModelPath(size: ModelSize): string {
  return join(getModelsDir(), MODELS[size].fileName)
}

/** Настройка контекста локального сервера: 'auto' или фиксированный размер. */
export type CtxSizeSetting = AssistantCtxSize

export const CTX_SIZE_OPTIONS: Array<{ value: CtxSizeSetting; label: string }> = [
  { value: 'auto', label: 'Авто (по ОЗУ и ядрам)' },
  { value: 4096, label: '4K токенов' },
  { value: 8192, label: '8K токенов' },
  { value: 16384, label: '16K токенов' },
  { value: 24576, label: '24K токенов' },
  { value: 32768, label: '32K токенов' },
]

export function resolveCtxSize(setting: CtxSizeSetting): number {
  if (typeof setting === 'number' && CTX_SIZE_OPTIONS.some(option => option.value === setting)) return setting
  return assessAssistantHardware().recommendation?.ctxSize ?? 4096
}

export function isModelDownloaded(size: ModelSize): boolean {
  const p = getModelPath(size)
  if (!existsSync(p)) return false
  try {
    const st = statSync(p)
    const info = MODELS[size]
    return info.sha256 ? st.size === info.expectedBytes : st.size > info.expectedBytes * 0.9
  } catch { return false }
}

export type DownloadProgress = { phase: 'downloading' | 'done' | 'error'; percent: number; bytes: number; error?: string }

const downloads = new Map<ModelSize, { promise: Promise<string>; listeners: Set<(p: DownloadProgress) => void> }>()

export function downloadModel(size: ModelSize, onProgress: (p: DownloadProgress) => void): Promise<string> {
  const existing = downloads.get(size)
  if (existing) {
    existing.listeners.add(onProgress)
    return existing.promise
  }
  const listeners = new Set([onProgress])
  const promise = downloadModelFile(size, progress => {
    for (const listener of listeners) {
      try { listener(progress) } catch { /* progress observers do not own the download */ }
    }
  }).finally(() => downloads.delete(size))
  downloads.set(size, { promise, listeners })
  return promise
}

async function downloadModelFile(size: ModelSize, onProgress: (p: DownloadProgress) => void): Promise<string> {
  const info = MODELS[size]
  const dest = getModelPath(size)
  if (isModelDownloaded(size)) {
    onProgress({ phase: 'done', percent: 100, bytes: statSync(dest).size })
    return dest
  }

  const request = (url: string, redirects: number): Promise<IncomingMessage> => {
    return new Promise((resolve, reject) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return }
      const connection = get(url, { headers: { 'User-Agent': 'SynteeHelper/1.0' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          resolve(request(new URL(res.headers.location, url).href, redirects + 1))
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`Model download failed (HTTP ${res.statusCode})`))
          return
        }
        resolve(res)
      })
      connection.setTimeout(60_000, () => connection.destroy(new Error('Model download timed out')))
      connection.on('error', reject)
    })
  }
  const tmp = dest + '.tmp'
  const digest = info.sha256 ? createHash('sha256') : null
  let received = 0
  try {
    const response = await request(info.url, 0)
    const total = parseInt(response.headers['content-length'] ?? '0', 10) || info.expectedBytes
    response.on('data', (chunk: Buffer) => {
      received += chunk.length
      digest?.update(chunk)
      onProgress({ phase: 'downloading', percent: Math.min(99, Math.round(received / total * 100)), bytes: received })
    })
    await pipeline(response, createWriteStream(tmp))
    if (digest && (received !== info.expectedBytes || digest.digest('hex') !== info.sha256)) {
      throw new Error('Model download failed integrity verification')
    }
    if (existsSync(dest)) unlinkSync(dest)
    renameSync(tmp, dest)
    onProgress({ phase: 'done', percent: 100, bytes: received })
    log('[ModelManager] downloaded %s (%d bytes)', info.fileName, received)
    return dest
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* a failed HTTP request may not create a file */ }
    throw error
  }
}

export function deleteModel(size: ModelSize): void {
  const p = getModelPath(size)
  if (existsSync(p)) {
    try { unlinkSync(p) } catch (e) { log('[ModelManager] delete failed: %s', (e as Error).message) }
  }
}

export function getModelInfo(size: ModelSize): ModelInfo {
  return MODELS[size]
}
