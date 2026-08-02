/**
 * LauncherBridge — ensures updater.exe exists next to the client AND is the
 * same build the website currently serves.
 *
 * The Go launcher (syntee-launcher) copies itself into current/updater.exe
 * after every install and update, and (since the self-sync build) on every
 * launch. This module is the client-side safety net for machines where the
 * launcher itself is never run manually:
 *
 *   1. healLauncherJson() — rewrites a stale update_server (old IP/domain) in
 *      the launcher's launcher.json to the URL baked into this client. The
 *      JSON wins over the launcher's baked default, so old installs poll a
 *      dead IP forever until this file is fixed. This alone revives even an
 *      old updater binary.
 *   2. ensureUpdater() — downloads updater.exe when missing, and replaces it
 *      (plus the root syntee-launcher.exe) when its sha256 differs from the
 *      binary published at GET /api/public/launcher/status.
 *
 * The updater.exe is the same binary as syntee-launcher.exe — it just has
 * a different filename so the client can find it by convention.
 */
import { app } from 'electron'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { spawn } from 'child_process'
import { updatesBase } from './config'

/** Base URL of the public launcher API (…/api/public/launcher). */
const LAUNCHER_API = updatesBase.replace('/api/public/updates', '/api/public/launcher')

/** URL for downloading the launcher binary from the gateway. */
const UPDATER_DOWNLOAD_URL = LAUNCHER_API

/** URL of the launcher metadata (sha256/size) used for freshness checks. */
const LAUNCHER_STATUS_URL = `${LAUNCHER_API}/status`

/** Minimum size in bytes for a valid updater (sanity check). */
const MIN_UPDATER_SIZE = 2 * 1024 * 1024 // 2 MB

/**
 * In dev the update URL falls back to localhost — never "heal" a real
 * launcher.json or replace real binaries with a dev-server download, that
 * would break a production install on the developer's own machine.
 */
const IS_DEV_SERVER = /localhost|127\.0\.0\.1/.test(updatesBase)

/** The launcher's install root: %LOCALAPPDATA%\Programs\Syntee Helper\ */
function installDir(): string {
  const localAppData = process.env.LOCALAPPDATA || ''
  return localAppData ? join(localAppData, 'Programs', 'Syntee Helper') : ''
}

/**
 * Find updater.exe in the client's working directory or the install dir.
 * The launcher installs to %LOCALAPPDATA%\Programs\Syntee Helper\ and copies
 * itself to current\updater.exe after every install/update (and, in newer
 * builds, on every launch).
 */
export function findUpdater(): string | null {
  const cwd = process.cwd()
  const exeDir = app.isPackaged ? process.resourcesPath : cwd
  const dir = installDir()

  // Check: cwd/updater.exe, exeDir/updater.exe, ../updater.exe, install dir
  const candidates = [
    join(cwd, 'updater.exe'),
    join(exeDir, 'updater.exe'),
    join(exeDir, '..', 'updater.exe'),
  ]
  if (dir) {
    candidates.push(join(dir, 'current', 'updater.exe'))
    candidates.push(join(dir, 'syntee-launcher.exe'))
  }

  for (const p of candidates) {
    try {
      if (existsSync(p) && statSync(p).size >= MIN_UPDATER_SIZE) {
        return p
      }
    } catch {
      // stat failed — skip
    }
  }
  return null
}

/**
 * Migrate a stale update_server (old IP / old domain) in the launcher's
 * launcher.json to the update URL baked into this client. Returns true when
 * the file was changed. All other fields are preserved; the write is atomic
 * (tmp + rename) so a crash can't corrupt the file the launcher boots from.
 */
export function healLauncherJson(): boolean {
  if (IS_DEV_SERVER) return false
  const dir = installDir()
  if (!dir) return false
  const jsonPath = join(dir, 'launcher.json')
  if (!existsSync(jsonPath)) return false
  try {
    const raw = readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, '')
    const cfg = JSON.parse(raw) as Record<string, unknown>
    if (cfg.update_server === updatesBase) return false
    cfg.update_server = updatesBase
    const tmp = jsonPath + '.tmp'
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n')
    renameSync(tmp, jsonPath)
    console.log(`[LauncherBridge] launcher.json update_server -> ${updatesBase}`)
    return true
  } catch (e) {
    console.error('[LauncherBridge] healLauncherJson failed:', e)
    return false
  }
}

function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

interface LauncherStatus {
  available: boolean
  sha256?: string
  size?: number
}

/** Best-effort metadata probe; null when unreachable/unavailable. */
async function fetchLauncherStatus(timeoutMs = 5000): Promise<LauncherStatus | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(LAUNCHER_STATUS_URL, { signal: controller.signal })
    if (!res.ok) return null
    const body = (await res.json()) as LauncherStatus
    return body.available ? body : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Where a freshly downloaded updater.exe belongs. */
function defaultUpdaterDst(): string {
  const dir = installDir()
  if (dir) {
    const currentDir = join(dir, 'current')
    if (existsSync(currentDir)) return join(currentDir, 'updater.exe')
  }
  return join(process.cwd(), 'updater.exe')
}

/** Write buf to dst via tmp + rename so a crash never leaves a truncated exe. */
function writeFileAtomic(dst: string, buf: Buffer): void {
  mkdirSync(dirname(dst), { recursive: true })
  const tmp = dst + '.tmp'
  writeFileSync(tmp, buf)
  try {
    renameSync(tmp, dst)
  } catch {
    rmSync(dst, { force: true })
    renameSync(tmp, dst)
  }
}

/**
 * Download the launcher binary from the website. Writes to `dst` (defaults to
 * current/updater.exe in the install dir) and returns the path, or null on
 * failure.
 */
export async function downloadUpdater(dst = defaultUpdaterDst()): Promise<string | null> {
  try {
    const res = await fetch(UPDATER_DOWNLOAD_URL, { redirect: 'follow' })
    if (!res.ok) {
      console.error(`[LauncherBridge] download failed: HTTP ${res.status}`)
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < MIN_UPDATER_SIZE) {
      console.error(`[LauncherBridge] downloaded file too small: ${buf.length} bytes`)
      return null
    }
    writeFileAtomic(dst, buf)
    console.log(`[LauncherBridge] updater downloaded -> ${dst} (${buf.length} bytes)`)
    return dst
  } catch (err) {
    console.error(`[LauncherBridge] download error:`, err)
    return null
  }
}

/**
 * Ensure updater.exe exists and is fresh. Called once at app start; every
 * failure is non-fatal (logged only) so update self-healing can never break
 * app startup.
 *
 * Returns the path to the updater, or null if it couldn't be found/downloaded.
 */
export async function ensureUpdater(): Promise<string | null> {
  // 1. Fix a stale update_server first — this alone revives old binaries.
  healLauncherJson()

  // 2. Missing → download (original behaviour).
  const existing = findUpdater()
  if (!existing) {
    console.warn('[LauncherBridge] updater.exe not found, downloading from website...')
    return downloadUpdater()
  }
  if (IS_DEV_SERVER) return existing

  // 3. Present → replace when the website serves a different build. The
  //    launcher also self-syncs on every launch, but only when someone runs
  //    it — this covers machines where the client is the only thing running.
  const status = await fetchLauncherStatus()
  if (!status?.sha256) return existing // can't verify — keep what we have
  if (sha256File(existing) === status.sha256) {
    // updater.exe is fresh; still refresh the root launcher if it's stale.
    refreshRootLauncher(null, status.sha256)
    return existing
  }

  console.log('[LauncherBridge] updater.exe is outdated, downloading fresh build...')
  const dst = defaultUpdaterDst()
  const tmpDst = dst + '.new'
  const downloaded = await downloadUpdater(tmpDst)
  if (!downloaded || sha256File(downloaded) !== status.sha256) {
    console.error('[LauncherBridge] fresh updater failed verification — keeping old one')
    rmSync(tmpDst, { force: true })
    return existing
  }
  try {
    renameSync(downloaded, dst)
  } catch {
    rmSync(dst, { force: true })
    renameSync(downloaded, dst)
  }
  console.log(`[LauncherBridge] updater.exe replaced -> ${dst}`)
  refreshRootLauncher(dst, status.sha256)
  return dst
}

/** Replace the root syntee-launcher.exe when it differs from the fresh build. */
function refreshRootLauncher(srcPath: string | null, expectedSha256: string): void {
  const dir = installDir()
  if (!dir) return
  const rootLauncher = join(dir, 'syntee-launcher.exe')
  try {
    if (!existsSync(rootLauncher)) return
    if (sha256File(rootLauncher) === expectedSha256) return
    const src = srcPath ?? findUpdater()
    if (!src || sha256File(src) !== expectedSha256) return
    writeFileAtomic(rootLauncher, readFileSync(src))
    console.log('[LauncherBridge] root syntee-launcher.exe replaced with fresh build')
  } catch (e) {
    console.error('[LauncherBridge] root launcher replace failed:', e)
  }
}

/**
 * Launch the updater (launcher) with optional arguments.
 * The updater will check for updates, download, apply, and relaunch the client.
 *
 * Resolves once the process has actually been spawned ('spawn' event) and
 * rejects when the OS refuses to start it ('error' event / timeout), so the
 * caller can guarantee the updater is really running before quitting the app.
 */
export function launchUpdater(updaterPath: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(updaterPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    const timer = setTimeout(() => reject(new Error('updater spawn timed out')), 3000)
    child.once('spawn', () => {
      clearTimeout(timer)
      child.unref()
      console.log(`[LauncherBridge] launched updater: ${updaterPath} ${args.join(' ')} (pid=${child.pid})`)
      resolve()
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      console.error(`[LauncherBridge] updater spawn failed: ${updaterPath}:`, err)
      reject(err)
    })
  })
}

/**
 * Check for updates by launching the updater.
 * This is an alternative to the in-app update checker — it launches the
 * Go launcher which has its own GUI for download/apply.
 */
export async function checkUpdatesViaLauncher(): Promise<boolean> {
  const updaterPath = await ensureUpdater()
  if (!updaterPath) {
    console.error('[LauncherBridge] cannot check updates: updater not available')
    return false
  }
  try {
    await launchUpdater(updaterPath)
    return true
  } catch {
    return false
  }
}
