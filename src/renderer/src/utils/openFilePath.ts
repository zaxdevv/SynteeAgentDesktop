// ── Общий open-флоу для кликабельных путей ────────────────────────────────
//
// Единая точка входа для сообщений, peek-превью, поповера «файлы чата» и
// терминала. Решает по фактическому stat:
//   папка            → Проводник (shell.openPath)
//   файл вне workdir → системный вьюер (shell.openPath)
//   файл в workdir   → правая панель (fileTabs) + reveal на строку
//   не существует    → тост «не найдено»
//
// rawFull может содержать суффикс позиции: `src/foo.ts:42-58` (splitPathLine).

import { splitPathLine, resolveFilePath, normalizePath } from './remarkFilePaths'
import { invalidatePathStatus } from './pathStatus'
import { useFileTabsStore } from '../store/fileTabs.store'
import { useUIStore } from '../store/ui.store'

interface StatResult {
  exists: boolean
  isDir: boolean
  isFile: boolean
  size: number
  resolved: string
}

const EMPTY_STAT: StatResult = { exists: false, isDir: false, isFile: false, size: 0, resolved: '' }

async function statPath(abs: string): Promise<StatResult> {
  try {
    const r = await window.syntee.fs.statPath(abs)
    return (r as StatResult) ?? EMPTY_STAT
  } catch {
    return EMPTY_STAT
  }
}

function toast(message: string, type: 'error' | 'info' = 'error'): void {
  // Ленивый импорт — не тянем Toast-стор при загрузке модуля (терминал и т.д.)
  import('../components/ui/Toast/Toast').then(({ useToast }) => {
    useToast.getState().add(message, type)
  }).catch(() => { /* noop */ })
}

/** Нормализация под file:// URL (для инлайн-превью картинок). */
export function toFileUrl(absPath: string): string {
  const p = absPath.replace(/\\/g, '/')
  return p.startsWith('/') ? `file://${p}` : `file:///${p}`
}

export interface OpenPathOpts {
  /** Открыть в diff-режиме (Open Changes) вместо обычного просмотра */
  diff?: boolean
}

/**
 * Открыть путь из текста сообщения/терминала.
 * @param rawFull путь, возможно с суффиксом `:42` / `:42-58` / `:42:15`
 * @param workdir рабочая директория чата (для резолва относительных путей)
 */
export async function openFilePath(rawFull: string, workdir?: string, opts?: OpenPathOpts): Promise<void> {
  const { path, line, lineEnd } = splitPathLine(rawFull)
  if (!path) return

  // Нормализуем ДО stat и inside-проверки: `../foo` и `a/b/../c` иначе
  // проходят startsWith(wd) и рвутся в safeJoin («Path outside root»).
  const abs = normalizePath(resolveFilePath(path, workdir))
  const stat = await statPath(abs)
  invalidatePathStatus(abs)

  if (!stat.exists) {
    toast(`Путь не найден: ${path}`)
    return
  }

  // Папка → Проводник
  if (stat.isDir) {
    await window.syntee.shell.openPath(stat.resolved || abs)
    return
  }

  const tabsStore = useFileTabsStore.getState()
  const ui = useUIStore.getState()
  const wd = workdir || tabsStore.workdir || undefined

  // Нет workdir или файл вне проекта → системный вьюер
  const absNorm = normalizePath(stat.resolved || abs)
  const wdNorm = wd ? normalizePath(wd).replace(/\/$/, '') : ''
  const inside = !!wdNorm && absNorm.toLowerCase().startsWith(wdNorm.toLowerCase() + '/')

  if (!inside || !wd) {
    await window.syntee.shell.openPath(stat.resolved || abs)
    return
  }

  const rel = absNorm.slice(wdNorm.length + 1)
  // ВАЖНО: передаём ОРИГИНАЛЬНЫЙ wd (native C:\...), а не wdNorm
  // (C:/...): openFile кладёт workdir в стор табов, а refreshTab/saveFile
  // ходят через safeJoin — с forward-слэшами любой файл отбрасывался
  // как «Path outside root». pathResolve внутри safeJoin уже нормализует.
  if (opts?.diff) {
    await tabsStore.openFileDiff(rel, wd)
  } else {
    await tabsStore.openFile(rel, wd, { line, lineEnd })
  }
  ui.setAgentPanelTab('files')
  ui.setAgentPanelOpen(true)
}

/** Показать файл/папку в Проводнике (с выделением). */
export async function revealInExplorer(rawFull: string, workdir?: string): Promise<void> {
  const { path } = splitPathLine(rawFull)
  if (!path) return
  const abs = normalizePath(resolveFilePath(path, workdir))
  const stat = await statPath(abs)
  if (!stat.exists) {
    toast(`Путь не найден: ${path}`)
    return
  }
  const target = stat.resolved || abs
  if (stat.isDir) {
    await window.syntee.shell.openPath(target)
  } else {
    await window.syntee.shell.showItemInFolder(target)
  }
}

/** Абсолютный путь из raw-текста (для «Копировать путь»). */
export async function resolveAbsolutePath(rawFull: string, workdir?: string): Promise<string> {
  const { path } = splitPathLine(rawFull)
  const abs = normalizePath(resolveFilePath(path, workdir))
  try {
    const r = await window.syntee.fs.statPath(abs)
    if (r?.resolved) return r.resolved
  } catch { /* fallback ниже */ }
  return abs
}
