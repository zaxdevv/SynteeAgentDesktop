/**
 * Extensions Detector — простая система обнаружения MCP-серверов и skills
 * для активного проекта. Без chokidar: детект при активации чата + polling
 * каждые few секунд (configurable). Перекрывает и случай когда .mcp.json
 * уже существует при открытии проекта, и когда файл создаётся/меняется
 * в процессе работы (например через /setup).
 *
 * Принцип:
 *   - При setActiveProject(workdir) — немедленный scan + запуск polling.
 *   - Каждые POLL_INTERVAL_MS — повторный scan; если обнаружены новые
 *     .mcp.json-записи или .md в .syntee/skills/ — пуш в McpManager/
 *     SkillManager и renderer.
 *   - Хэши по содержимому файлов — не дёргаем менеджеры если ничего не
 *     изменилось (экономим CPU).
 *
 * Сравнение с chokidar: проще, надёжнее на Windows (нет проблем с
 * watchем несуществующих путей), не требует лишних FS-handles. Минус —
 * задержка до POLL_INTERVAL_MS (2с) — приемлемо для onboarding-флоу.
 */
import { existsSync, statSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { IPC_EVENTS } from '../shared/constants'
import { getMcpManager } from './mcp/McpManager'
import { getSkillManager } from './skills/skillManager'

let _getWindow: (() => BrowserWindow | null) | null = null
let _workdir: string | null = null
let _projectId: string | null = null
let _pollTimer: NodeJS.Timeout | null = null
let _mcpHash: string | ''
let _skillsHash: string = ''
let _mcpFingerprint = '' // stat-фингерпринт .mcp.json (size:mtime)
let _fastUntil = 0 // до этого момента поллинг быстрый (onboarding)

/** Интервалы polling — адаптивные. Первые FAST_WINDOW_MS после активации
 *  проекта — 5с (onboarding-флоу: юзер пишет .mcp.json/скиллы и ждёт).
 *  Потом 30с: scan только stat-фингерпринт (без readFileSync) — доли мс,
 *  пробуждения CPU в 6× реже в простое. */
const POLL_FAST_MS = 5000
const POLL_SLOW_MS = 30_000
const FAST_WINDOW_MS = 120_000

/** Установить getter окна для push-ивентов в renderer. */
export function initExtensionsDetector(getWindow: () => BrowserWindow | null): void {
  _getWindow = getWindow
}

function emitSkillsUpdated(projectId: string): void {
  const win = _getWindow?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_EVENTS.SKILLS_UPDATED, { projectId })
  }
}

/** Быстрый хэш содержимого файла (не крипто-стойкий — просто для сравнения). */
function fileHash(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8')
    // Простой djb2-хэш — достаточно чтобы отличить изменения, дёшево.
    let h = 5381
    for (let i = 0; i < content.length; i++) {
      h = ((h << 5) + h + content.charCodeAt(i)) | 0
    }
    return content.length + ':' + (h >>> 0).toString(36)
  } catch {
    return ''
  }
}

/** Фингерпринт файла по метаданным (size+mtime) — statSync без чтения тела.
 *  Позволяет не делать readFileSync на каждом polling-тике: содержимое
 *  читается ТОЛЬКО когда файл реально менялся. */
function fileFingerprint(filePath: string): string {
  try {
    const st = statSync(filePath)
    return `${st.size}:${Math.round(st.mtimeMs)}`
  } catch {
    return ''
  }
}

/** Хэш папки skills — сумма хэшей всех .md (порядок-independent через sorted). */
function skillsDirHash(dir: string): string {
  if (!existsSync(dir)) return ''
  try {
    const entries = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md'))
    const parts: string[] = []
    for (const entry of entries) {
      const full = join(dir, entry)
      try {
        const st = statSync(full)
        parts.push(entry + ':' + st.size + ':' + st.mtimeMs)
      } catch { /* skip */ }
    }
    parts.sort()
    return parts.join('|')
  } catch {
    return ''
  }
}

/** Один scan-цикл: сравнить хэши, при изменении дернуть менеджеры. */
function scanOnce(): void {
  if (!_workdir || !_projectId) return
  // Пауза когда главное окно скрыто — экономит FS-stat'ы в фоне.
  // При возврате окна следующий тик обновит состояние.
  const win = _getWindow?.()
  if (win && !win.isDestroyed() && !win.isVisible()) return
  const mcpJsonPath = join(_workdir, '.mcp.json')
  const skillsDir = join(_workdir, '.syntee', 'skills')

  // MCP — сначала дешёвый stat-фингерпринт; readFileSync только при изменении.
  const mcpFp = existsSync(mcpJsonPath) ? fileFingerprint(mcpJsonPath) : ''
  if (mcpFp !== _mcpFingerprint) {
    _mcpFingerprint = mcpFp
    const mcpH = mcpFp ? fileHash(mcpJsonPath) : ''
    if (mcpH !== _mcpHash) {
      _mcpHash = mcpH
      try {
        getMcpManager().reloadProjectServers(_workdir, _projectId)
      } catch (e) {
        console.warn('[extensionsDetector] reloadProjectServers failed:', e)
      }
    }
  }

  // Skills
  const skillsH = skillsDirHash(skillsDir)
  if (skillsH !== _skillsHash) {
    _skillsHash = skillsH
    try {
      const changed = getSkillManager().autoEnableProjectSkills(_projectId, _workdir)
      emitSkillsUpdated(_projectId)
      if (changed) {
        console.log('[extensionsDetector] auto-enabled new project skills for', _projectId)
      }
    } catch (e) {
      console.warn('[extensionsDetector] autoEnableProjectSkills failed:', e)
    }
  }
}

/** Останавливает polling и сбрасывает состояние. */
function stopCurrent(): void {
  if (_pollTimer) {
    clearTimeout(_pollTimer)
    _pollTimer = null
  }
  _workdir = null
  _projectId = null
  _mcpHash = ''
  _skillsHash = ''
  _mcpFingerprint = ''
  _fastUntil = 0
}

/** Рекурсивный self-reschedule вместо setInterval: интервал зависит от фазы
 *  (быстрая onboarding-фаза 5с первые 2 мин, потом 30с в простое). */
function scheduleNextPoll(): void {
  const interval = Date.now() < _fastUntil ? POLL_FAST_MS : POLL_SLOW_MS
  _pollTimer = setTimeout(() => {
    _pollTimer = null
    scanOnce()
    scheduleNextPoll()
  }, interval)
}

/**
 * Переключает детектор на активный проект. projectId=null — остановить.
 * Вызывается из fastcontext:setActive handler и/или при активации чата.
 * Немедленный scan + запуск polling на POLL_INTERVAL_MS.
 */
export function setActiveExtensionsProject(projectId: string | null, workdir?: string): void {
  // Нет проекта — останавливаем.
  if (!projectId || !workdir) {
    stopCurrent()
    return
  }
  // Тот же проект — не пересоздаём (polling уже идёт).
  if (_workdir === workdir && _projectId === projectId && _pollTimer) {
    scanOnce()
    return
  }
  stopCurrent()
  _workdir = workdir
  _projectId = projectId
  _fastUntil = Date.now() + FAST_WINDOW_MS
  scanOnce()
  scheduleNextPoll()
}

/** Текущий наблюдаемый projectId (для логов/диагностики). */
export function getWatchedProjectId(): string | null {
  return _projectId
}
