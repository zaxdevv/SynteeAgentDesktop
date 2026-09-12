/**
 * npmRuntime — инфраструктура npm-зависимостей Node-плагинов.
 *
 * Node-плагины исполняются в utilityProcess — это полноценный Node-процесс
 * со стандартным module resolution: require('pkg') из {pluginDir}/dist/index.js
 * резолвится в {pluginDir}/node_modules. Поэтому достаточно один раз
 * выполнить `npm install` в папке плагина.
 *
 * Отвечает за:
 *   - маркер установленных зависимостей (.npm-deps.json в папке плагина)
 *   - установку dependencies через npm install (авто-установка при старте
 *     и кнопка в карточке UI)
 *
 * Ограничения (документируются в docs/runtimes.md):
 *   - пакеты должны быть CJS-совместимыми (require() ESM-only пакета упадёт)
 *   - нативные .node-модули должны быть собраны под ABI Electron — не гарантировано
 */

import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

interface DepsMarker {
  /** hash списка зависимостей (JSON.stringify). */
  hash: string
  installedAt: string
}

function depsHash(dependencies: string[]): string {
  return JSON.stringify([...dependencies].sort())
}

function markerPath(pluginDir: string): string {
  return join(pluginDir, '.npm-deps.json')
}

/** Установлены ли npm-зависимости (маркер совпадает с текущим списком). */
export function npmDepsInstalled(pluginDir: string, dependencies: string[]): boolean {
  if (!dependencies.length) return true
  try {
    const marker = JSON.parse(readFileSync(markerPath(pluginDir), 'utf-8')) as DepsMarker
    return marker.hash === depsHash(dependencies)
  } catch {
    return false
  }
}

/** Записывает маркер «зависимости установлены». */
export function markNpmDepsInstalled(pluginDir: string, dependencies: string[]): void {
  try {
    const marker: DepsMarker = { hash: depsHash(dependencies), installedAt: new Date().toISOString() }
    writeFileSync(markerPath(pluginDir), JSON.stringify(marker), 'utf-8')
  } catch { /* ignore */ }
}

/**
 * Гарантирует наличие package.json в папке плагина. Без него `npm install`
 * поднимается по дереву до ЧУЖОГО package.json (например, корня проекта
 * пользователя для проектных плагинов) и ставит пакеты туда. Стаб пиннит
 * npm к папке плагина; существующий package.json пользователя не трогаем.
 */
function ensurePackageJson(pluginDir: string): void {
  const p = join(pluginDir, 'package.json')
  if (existsSync(p)) return
  try {
    const name = 'plugin-' + pluginDir.split(/[\\/]/).filter(Boolean).pop()!.toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
    writeFileSync(p, JSON.stringify({ name, version: '0.0.0', private: true }, null, 2) + '\n', 'utf-8')
  } catch { /* ignore — npm сам разберётся */ }
}

export interface InstallNpmDepsResult {
  ok: boolean
  error?: string
  /** Вывод npm (для журнала/диагностики). */
  output: string
}

/**
 * Устанавливает npm-зависимости плагина: `npm install <specs>` в папке
 * плагина (cwd = pluginDir — npm создаёт node_modules рядом с entry).
 * onLog вызывается построчно для стрима в журнал плагина.
 * Таймаут — 10 минут (крупные деревья зависимостей).
 */
export function installNpmDependencies(
  pluginDir: string,
  dependencies: string[],
  onLog?: (line: string) => void,
): Promise<InstallNpmDepsResult> {
  return new Promise(resolve => {
    ensurePackageJson(pluginDir)
    // Windows: npm — это npm.cmd, а Node ≥18.20 запрещает spawn .cmd без
    // shell (CVE-2024-27980) — EINVAL. Поэтому на win32 запускаем через
    // shell, аргументы квотим (npm-спецификации могут содержать @ ^ > ~).
    const isWin = process.platform === 'win32'
    const npmCmd = isWin ? 'npm.cmd' : 'npm'
    const args = [
      'install', '--no-audit', '--no-fund', '--no-package-lock', '--no-save',
      '--loglevel=error', '--omit=dev', ...dependencies,
    ]
    const safeArgs = isWin ? args.map(a => `"${a.replace(/"/g, '')}"`) : args
    let child
    try {
      child = spawn(npmCmd, safeArgs, {
        cwd: pluginDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(isWin ? { shell: true } : {}),
      })
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
      resolve({ ok: false, error: 'npm install: таймаут (10 минут)', output })
    }, 10 * 60_000)
    child.on('error', e => {
      clearTimeout(timer)
      resolve({
        ok: false,
        error: `npm не найден (${e.message}). npm ставится вместе с Node.js`,
        output,
      })
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) {
        markNpmDepsInstalled(pluginDir, dependencies)
        resolve({ ok: true, output })
      } else {
        resolve({ ok: false, error: `npm install завершился с кодом ${code}`, output })
      }
    })
  })
}
