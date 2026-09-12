/**
 * pythonRuntime — инфраструктура Python-плагинов (runtime:'python').
 *
 * Отвечает за:
 *   - детект интерпретатора Python (SYNTEE_PYTHON → python → python3 → py -3)
 *   - синхронизацию Python SDK (resources/python-sdk → {userData}/python-sdk)
 *     — как builtin-плагины: в dev из репозитория, в prod из resources
 *   - маркер установленных зависимостей (.deps.json в папке плагина)
 *   - установку requirements через pip (для авто-установки при старте
 *     и кнопки в карточке UI)
 */

import { spawn } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface PythonInfo {
  /** Путь до исполняемого файла интерпретатора. */
  exe: string
  /** Например '3.12.1'. */
  version: string
}

/** Кэш детекта (spawn асинхронный — кэшируем результат). */
let detected: PythonInfo | null | undefined

/** Кандидаты интерпретатора в порядке приоритета. */
function pythonCandidates(): string[] {
  const list = [
    process.env.SYNTEE_PYTHON,
    'python',
    'python3',
  ].filter((c): c is string => Boolean(c))
  // Windows: py launcher (py -3) — добавляем с аргументом.
  if (process.platform === 'win32') list.push('py -3')
  return list
}

/** Запускает `exe -c "import sys; print(sys.version)"` и возвращает версию. */
function probePython(cmd: string): Promise<PythonInfo | null> {
  return new Promise(resolve => {
    const parts = cmd.split(/\s+/)
    let child
    try {
      child = spawn(parts[0], [...parts.slice(1), '-c', 'import sys; print(sys.version.split()[0])'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve(null)
    }, 8_000)
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', code => {
      clearTimeout(timer)
      const version = out.trim().split(/\s+/)[0] ?? ''
      if (code === 0 && /^\d+\.\d+/.test(version)) {
        resolve({ exe: parts[0], version })
      } else {
        resolve(null)
      }
    })
  })
}

/** Ищет установленный Python. Результат кэшируется. null — не найден. */
export async function detectPython(): Promise<PythonInfo | null> {
  if (detected !== undefined) return detected
  for (const cmd of pythonCandidates()) {
    const info = await probePython(cmd)
    if (info) {
      detected = info
      return info
    }
  }
  detected = null
  return null
}

/** Сброс кэша (после установки Python пользователем / смены runtimePath). */
export function resetPythonCache(): void {
  detected = undefined
}

// ── SDK ────────────────────────────────────────────────────────────────────

/** Папка с исходником SDK (dev — репозиторий, prod — resources). */
function getSdkSourceDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'python-sdk')
  }
  const candidates = [
    join(app.getAppPath(), 'resources', 'python-sdk'),
    join(__dirname, '..', '..', 'resources', 'python-sdk'),
    join(process.cwd(), 'resources', 'python-sdk'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

/**
 * Копирует SDK в {userData}/python-sdk (реальный путь на диске — Python
 * не читает asar). Копируем только при изменении содержимого — дешёво.
 * Возвращает путь до папки SDK (для PYTHONPATH).
 */
export function syncPythonSdk(userDataDir: string): string {
  const sdkDir = join(userDataDir, 'python-sdk')
  try {
    const src = join(getSdkSourceDir(), 'syntee.py')
    if (existsSync(src)) {
      const dst = join(sdkDir, 'syntee.py')
      let same = false
      if (existsSync(dst)) {
        try { same = readFileSync(src).equals(readFileSync(dst)) } catch { same = false }
      }
      if (!same) {
        mkdirSync(sdkDir, { recursive: true })
        copyFileSync(src, dst)
        console.log('[plugins] python-sdk синхронизирован →', sdkDir)
      }
    }
  } catch (e) {
    console.warn('[plugins] python-sdk sync failed:', (e as Error).message)
  }
  return sdkDir
}

// ── Зависимости (requirements) ─────────────────────────────────────────────

interface DepsMarker {
  /** hash списка зависимостей (JSON.stringify). */
  hash: string
  installedAt: string
}

function depsHash(requirements: string[]): string {
  return JSON.stringify([...requirements].sort())
}

function markerPath(pluginDir: string): string {
  return join(pluginDir, '.deps.json')
}

/** Установлены ли зависимости (маркер совпадает с текущим списком). */
export function depsInstalled(pluginDir: string, requirements: string[]): boolean {
  if (!requirements.length) return true
  try {
    const marker = JSON.parse(readFileSync(markerPath(pluginDir), 'utf-8')) as DepsMarker
    return marker.hash === depsHash(requirements)
  } catch {
    return false
  }
}

/** Записывает маркер «зависимости установлены». */
export function markDepsInstalled(pluginDir: string, requirements: string[]): void {
  try {
    const marker: DepsMarker = { hash: depsHash(requirements), installedAt: new Date().toISOString() }
    writeFileSync(markerPath(pluginDir), JSON.stringify(marker), 'utf-8')
  } catch { /* ignore */ }
}

export interface InstallDepsResult {
  ok: boolean
  error?: string
  /** Вывод pip (для журнала/диагностики). */
  output: string
}

/**
 * Устанавливает pip-зависимости плагина: `python -m pip install <reqs>`.
 * onLog вызывается построчно для стрима в журнал плагина.
 * Таймаут — 10 минут (тяжёлые пакеты собираются из исходников).
 */
export function installRequirements(
  exe: string,
  pluginDir: string,
  requirements: string[],
  onLog?: (line: string) => void,
): Promise<InstallDepsResult> {
  return new Promise(resolve => {
    const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...requirements]
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, error: (e as Error).message, output: '' })
      return
    }
    let output = ''
    const push = (d: Buffer) => {
      const text = d.toString()
      output += text
      if (output.length > 100_000) output = output.slice(-100_000)
      for (const line of text.split(/\r?\n/)) {
        const l = line.trim()
        if (l) onLog?.(l)
      }
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve({ ok: false, error: 'pip install: таймаут (10 минут)', output })
    }, 10 * 60_000)
    child.on('error', e => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.message, output })
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) {
        markDepsInstalled(pluginDir, requirements)
        resolve({ ok: true, output })
      } else {
        resolve({ ok: false, error: `pip install завершился с кодом ${code}`, output })
      }
    })
  })
}
