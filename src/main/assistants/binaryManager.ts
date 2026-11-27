import { app } from 'electron'
import { join } from 'path'
import { accessSync, constants, existsSync, mkdirSync, createWriteStream, writeFileSync } from 'fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { get } from 'https'
import AdmZip from 'adm-zip'
import { log } from '../../core/logger'
import { hasAssistantRuntimeTarget } from './hardware'

/**
 * Две сборки llama.cpp из одного релиза:
 *  - `cpu`    — обычная, работает везде;
 *  - `vulkan` — с Vulkan-бэкендом: `--n-gpu-layers` уводит модель в VRAM
 *    на поддерживаемых NVIDIA/AMD/Intel GPU.
 *
 * ⚠️ DLL у сборок конфликтуют по именам (ggml.dll и др.), поэтому cpu живёт
 * в `assistants/bin/` (как раньше — уже скачанное не перекачивается),
 * vulkan — в `assistants/bin-vulkan/`.
 */
export type LlamaFlavor = 'cpu' | 'vulkan'

const RELEASE_TAG = 'b12360'
const RELEASE_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE_TAG}`
export const LLAMA_SERVER_NAME = process.platform === 'linux' ? 'llama-server' : 'llama-server.exe'
const LINUX_ASSETS = {
  cpu: {
    name: `llama-${RELEASE_TAG}-bin-ubuntu-x64.tar.gz`,
    bytes: 23_310_281,
    sha256: 'b60dc211e4ba206bb04bbc9eb06294364c43d0aab8fc308c44a361477466ba4c',
  },
  vulkan: {
    name: `llama-${RELEASE_TAG}-bin-ubuntu-vulkan-x64.tar.gz`,
    bytes: 36_152_335,
    sha256: '2133682fba36e101ec1059ee646287bd1768916d3d0479fa4d6135f40f02e309',
  },
} satisfies Record<LlamaFlavor, { name: string; bytes: number; sha256: string }>
const BINARY_URLS: Record<LlamaFlavor, string> = {
  cpu: `${RELEASE_URL}/llama-${RELEASE_TAG}-bin-win-cpu-x64.zip`,
  vulkan: `${RELEASE_URL}/llama-${RELEASE_TAG}-bin-win-vulkan-x64.zip`,
}
const BINARY_ZIP_NAMES: Record<LlamaFlavor, string> = {
  cpu: 'llama-server-win-x64.zip',
  vulkan: 'llama-server-win-vulkan-x64.zip',
}

function getBinDir(flavor: LlamaFlavor): string {
  const sub = flavor === 'vulkan' ? 'bin-vulkan' : 'bin'
  const directory = process.platform === 'linux' ? `${sub}-linux-${process.arch}-${RELEASE_TAG}` : sub
  return join(app.getPath('userData'), 'assistants', directory)
}

export function getLlamaServerPath(flavor: LlamaFlavor = 'cpu'): string {
  return join(getBinDir(flavor), LLAMA_SERVER_NAME)
}

export function isBinaryReady(flavor: LlamaFlavor = 'cpu'): boolean {
  const binary = getLlamaServerPath(flavor)
  if (process.platform !== 'linux') return existsSync(binary)
  try {
    accessSync(binary, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export type BinaryProgress = { phase: 'downloading' | 'extracting' | 'done' | 'error'; percent: number; error?: string }

const run = promisify(execFile)

async function downloadLinuxBinary(flavor: LlamaFlavor, onProgress: (p: BinaryProgress) => void, signal?: AbortSignal): Promise<string> {
  const cache = join(app.getPath('userData'), 'assistants')
  await mkdir(cache, { recursive: true })
  const temporary = await mkdtemp(join(cache, '.llama-download-'))
  try {
    const asset = LINUX_ASSETS[flavor]
    const archive = join(temporary, asset.name)
    const timeout = AbortSignal.timeout(300_000)
    const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(`${RELEASE_URL}/${asset.name}`, { signal: downloadSignal })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} from GitHub`)

    const hash = createHash('sha256')
    let received = 0
    let previousPercent = -1
    await pipeline(response.body, async function* (source) {
      for await (const chunk of source) {
        received += chunk.length
        if (received > asset.bytes) throw new Error('llama-server archive exceeds its expected size')
        hash.update(chunk)
        const percent = Math.floor(received * 90 / asset.bytes)
        if (percent !== previousPercent) onProgress({ phase: 'downloading', percent })
        previousPercent = percent
        yield chunk
      }
    }, createWriteStream(archive), { signal: downloadSignal })
    if (received !== asset.bytes || hash.digest('hex') !== asset.sha256) {
      throw new Error('llama-server archive did not match the pinned release')
    }

    onProgress({ phase: 'extracting', percent: 92 })
    const extracted = join(temporary, 'bin')
    await mkdir(extracted)
    // tar preserves the executable mode and the shared library soname links.
    await run('tar', ['-xf', archive, '-C', extracted, '--strip-components=1', '--no-same-owner',
      '--wildcards', '*/llama-server', '*/*.so*'], { timeout: 60_000, signal })
    signal?.throwIfAborted()
    accessSync(join(extracted, LLAMA_SERVER_NAME), constants.X_OK)
    try {
      await rename(extracted, getBinDir(flavor))
    } catch (err) {
      if (!isBinaryReady(flavor)) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw err
        const invalid = join(cache, `.llama-invalid-${randomUUID()}`)
        await rename(getBinDir(flavor), invalid).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
        try {
          await rename(extracted, getBinDir(flavor))
        } catch (installError) {
          if (!isBinaryReady(flavor)) {
            await rename(invalid, getBinDir(flavor)).catch(() => {})
            throw installError
          }
        } finally {
          await rm(invalid, { recursive: true, force: true })
        }
      }
    }
    onProgress({ phase: 'done', percent: 100 })
    return getLlamaServerPath(flavor)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export function downloadBinary(flavor: LlamaFlavor, onProgress: (p: BinaryProgress) => void, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (isBinaryReady(flavor)) {
    onProgress({ phase: 'done', percent: 100 })
    return Promise.resolve(getLlamaServerPath(flavor))
  }

  if (!hasAssistantRuntimeTarget()) {
    const error = `llama-server is unavailable on ${process.platform} ${process.arch}`
    onProgress({ phase: 'error', percent: 0, error })
    return Promise.reject(new Error(error))
  }
  if (process.platform === 'linux') {
    return downloadLinuxBinary(flavor, onProgress, signal).catch((error: Error) => {
      log('[BinaryManager] download error: %s', error.message)
      onProgress({ phase: 'error', percent: 0, error: error.message })
      throw error
    })
  }

  const binDir = getBinDir(flavor)
  mkdirSync(binDir, { recursive: true })
  const zipPath = join(binDir, BINARY_ZIP_NAMES[flavor])
  log('[BinaryManager] starting %s download from %s', flavor, BINARY_URLS[flavor])

  return new Promise((resolve, reject) => {
    const download = (url: string, redirects: number) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return }
      get(url, { headers: { 'User-Agent': 'SynteeHelper/1.0' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          log('[BinaryManager] redirect → %s', res.headers.location.slice(0, 100))
          download(res.headers.location, redirects + 1)
          return
        }
        if (res.statusCode !== 200) {
          const err = `HTTP ${res.statusCode} from GitHub`
          log('[BinaryManager] %s', err)
          onProgress({ phase: 'error', percent: 0, error: err })
          reject(new Error(err))
          return
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10) || 40_000_000
        let received = 0
        const file = createWriteStream(zipPath)
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          file.write(chunk)
          onProgress({ phase: 'downloading', percent: Math.min(90, Math.round(received / total * 90)) })
        })
        res.on('end', () => {
          file.end(() => {
            try {
              onProgress({ phase: 'extracting', percent: 92 })
              log('[BinaryManager] downloaded %d bytes, extracting…', received)
              const zip = new AdmZip(zipPath)
              const entries = zip.getEntries()
              let extracted = 0
              for (const entry of entries) {
                const baseName = entry.entryName.split('/').pop() ?? ''
                if (baseName === 'llama-server.exe' || baseName.endsWith('.dll')) {
                  const data = entry.getData()
                  writeFileSync(join(binDir, baseName), data)
                  extracted++
                }
              }
              log('[BinaryManager] extracted %d files to %s', extracted, binDir)
              if (!isBinaryReady(flavor)) {
                const err = 'llama-server.exe not found in zip'
                onProgress({ phase: 'error', percent: 0, error: err })
                reject(new Error(err))
                return
              }
              onProgress({ phase: 'done', percent: 100 })
              resolve(getLlamaServerPath(flavor))
            } catch (e) {
              log('[BinaryManager] extraction failed: %s', (e as Error).message)
              onProgress({ phase: 'error', percent: 0, error: (e as Error).message })
              reject(e)
            }
          })
        })
        res.on('error', (e) => { file.end(); reject(e) })
      }).on('error', (e) => {
        log('[BinaryManager] download error: %s', e.message)
        onProgress({ phase: 'error', percent: 0, error: e.message })
        reject(e)
      })
    }
    download(BINARY_URLS[flavor], 0)
  })
}
