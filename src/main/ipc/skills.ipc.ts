/**
 * IPC handlers для Skills.
 *
 * Каналы:
 *   skills:getAll      — все скиллы (с состоянием) для UI; опционально projectId
 *                        чтобы включить проектные скиллы указанного проекта.
 *   skills:setState    — обновить состояние скилла (enabled + scope).
 *   skills:reload      — сбросить кэш и перечитать скиллы с диска.
 *   skills:getActive   — активные скиллы для конкретного чата (для бейджа).
 *
 * SkillManager — синглтон, инициализируется в main/index.ts через initSkillManager.
 */
import { ipcMain, app } from 'electron'
import Store from 'electron-store'
import { join, basename } from 'path'
import { mkdirSync, writeFileSync, cpSync, rmSync, lstatSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { getSkillManager } from '../../core/skills/skillManager'
import { scanSkillDirectory } from '../../core/skills/skillLoader'
import { getProjectById, getChatWorkdirContext, getAllProjects } from '../../core/db'
import type { SkillState, SkillFolderUpdate } from '../../shared/types'

/**
 * Достаёт { projectId, workdir } для чата из БД.
 * getChatWorkdirContext возвращает только workdir/verificationCommand —
 * projectId получаем через projects-таблицу по workdir, либо напрямую из chats.
 */
function getChatProjectInfo(chatId: string): { projectId?: string; workdir?: string } {
  try {
    const ctx = getChatWorkdirContext(chatId)
    if (!ctx.workdir) return {}
    // getChatWorkdirContext уже делает JOIN projects, но не отдаёт id.
    // Перебираем проекты по workdir (он уникален по схеме — UNIQUE constraint).
    const projects = listProjectIdsByWorkdir(ctx.workdir)
    return { workdir: ctx.workdir, projectId: projects[0] }
  } catch {
    return {}
  }
}

/** Возвращает id проектов с данным workdir (обычно 0 или 1 — workdir UNIQUE). */
function listProjectIdsByWorkdir(workdir: string): string[] {
  return getAllProjects().filter(p => p.workdir === workdir).map(p => p.id)
}

export function registerSkillsIPC(store: Store): void {
  void store

  ipcMain.handle('skills:getAll', (_e, params?: { projectId?: string; chatId?: string }) => {
    const mgr = getSkillManager()
    let projectWorkdir: string | undefined
    let projectId = params?.projectId
    if (!projectId && params?.chatId) {
      try {
        const ctx = getChatWorkdirContext(params.chatId)
        if (ctx.workdir) {
          projectWorkdir = ctx.workdir
          const found = getAllProjects().find(p => p.workdir === ctx.workdir)
          projectId = found?.id
        }
      } catch { /* ignore */ }
    }
    if (projectId) {
      const proj = getProjectById(projectId)
      projectWorkdir = proj?.workdir
    }
    // Refresh when the installed view is opened: packages copied manually become visible.
    mgr.invalidate()
    return mgr.getAllWithState({ projectWorkdir, projectId })
  })

  ipcMain.handle('skills:setState', (_e, params: { skillId: string; state: SkillState; source: 'builtin' | 'user' | 'project' }) => {
    const mgr = getSkillManager()
    mgr.setState(params.skillId, params.state)
    return { ok: true }
  })

  ipcMain.handle('skills:setFolderState', (_e, params: SkillFolderUpdate) => {
    let workdir: string | undefined
    let projectId = params.projectId
    if (params.source === 'project') {
      if (projectId) workdir = getProjectById(projectId)?.workdir
      if (!workdir && params.chatId) {
        const info = getChatProjectInfo(params.chatId)
        workdir = info.workdir
        projectId = info.projectId ?? (workdir ? encodeURIComponent(workdir.toLowerCase()) : undefined)
      }
      if (!workdir) throw new Error('Проект для папки скиллов не найден')
    }
    const mgr = getSkillManager()
    mgr.setFolderState({ ...params, projectId: params.source === 'project' ? projectId : undefined }, workdir)
    return mgr.getAllWithState({ projectWorkdir: workdir, projectId })
  })

  ipcMain.handle('skills:reload', () => {
    getSkillManager().invalidate()
    return { ok: true }
  })

  ipcMain.handle('skills:getActive', (_e, params: { chatId: string; isIncognito?: boolean }) => {
    const mgr = getSkillManager()
    const info = getChatProjectInfo(params.chatId)
    return mgr.getActiveSkillsForChat({
      projectWorkdir: info.workdir,
      projectId: info.projectId,
      isIncognito: params.isIncognito,
    })
  })

  // Прямая установка скилла по URL — без агента.
  // Принимает URL на .md-файл (raw) или GitHub-репозиторий.
  // Для .md-файла: скачиваем и копируем в skills-папку.
  // Для репозитория: git clone → ищем .md → копируем → удаляем clone.
  ipcMain.handle('skills:installFromUrl', async (_e, params: {
    url: string
    scope: 'global' | { workdir: string }
  }): Promise<{ ok: boolean; installed: number; error?: string }> => {
    const { url } = params
    if (!url?.trim()) return { ok: false, installed: 0, error: 'URL обязателен' }

    // Целевая папка
    const targetDir = params.scope === 'global'
      ? join(app.getPath('userData'), 'skills')
      : join(params.scope.workdir, '.syntee', 'skills')
    try { mkdirSync(targetDir, { recursive: true }) } catch { /* ok */ }

    // Прямая ссылка на .md-файл (raw.githubusercontent.com или прямой URL)
    if (url.endsWith('.md') || url.includes('raw.githubusercontent.com')) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) return { ok: false, installed: 0, error: `HTTP ${res.status}` }
        const content = await res.text()
        if (!content.trim()) return { ok: false, installed: 0, error: 'Файл пустой' }
        const filename = url.split('/').pop() || `skill-${Date.now()}.md`
        const dest = join(targetDir, filename)
        writeFileSync(dest, content, 'utf-8')
        // Инвалидируем кэш чтобы новый скилл подхватился
        getSkillManager().invalidate()
        return { ok: true, installed: 1 }
      } catch (e) {
        return { ok: false, installed: 0, error: (e as Error).message }
      }
    }

    // Keep the entire package structure, including reference files, assets and scripts.
    const execFileAsync = promisify(execFile)
    const tmpDir = join(app.getPath('temp'), `.syntee-skill-${randomUUID()}`)
    try {
      const parsed = new URL(url)
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Нужна HTTP(S)-ссылка на репозиторий')
      await execFileAsync('git', ['clone', '--depth', '1', '--', url, tmpDir], { timeout: 30_000 })
      const discovered = scanSkillDirectory(tmpDir, 'user')
      if (!discovered.length) return { ok: false, installed: 0, error: 'В репозитории не найдено скиллов' }
      const packageName = basename(parsed.pathname).replace(/\.git$/i, '').replace(/[^\p{L}\p{N}_.-]/gu, '-')
      if (!packageName || packageName === '.' || packageName === '..') throw new Error('Некорректное имя пакета')
      cpSync(tmpDir, join(targetDir, packageName), {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: src => !['.git', 'node_modules'].includes(basename(src)) && !lstatSync(src).isSymbolicLink(),
      })
      getSkillManager().invalidate()
      return { ok: true, installed: discovered.length }
    } catch (e) {
      return { ok: false, installed: 0, error: (e as Error).message }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* Cleanup must not mask the installation result. */ }
    }
  })
}
