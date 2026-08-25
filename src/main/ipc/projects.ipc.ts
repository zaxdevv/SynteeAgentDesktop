import { ipcMain, BrowserWindow, dialog } from 'electron'
import { analyzeProject } from '../../core/tools'
import { stopWatching as stopFastContextWatch, registerProjectWorkdir } from '../../core/context/fastContextWatcher'
import {
  createProject, getAllProjects, renameProject, deleteProject, getProjectById, touchProject,
  setProjectVerificationCommand, setProjectContextFiles,
} from '../../core/db'
import { log } from '../../core/logger'

export interface ProjectsIPCWindow {
  getWindow: () => BrowserWindow | null
}

// ── Проекты (рабочие директории) ────────────────────────────────────
// Проект = именованная привязка к папке + зафиксированный при создании
// контекст (analyzeProject). Чаты создаются внутри проекта и наследуют
// его workdir. Пикер папки теперь часть создания проекта, а не чата.
export function registerProjectsIPC(mainWindow: ProjectsIPCWindow): void {
  ipcMain.handle('projects:pickWorkdir', async () => {
    const win = mainWindow.getWindow()
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow(), {
      properties: ['openDirectory'],
      title: 'Выберите папку проекта',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Создание НОВОЙ пустой папки для проекта. Используем showSaveDialog, чтобы
  // пользователь мог задать имя папки и выбрать родительский каталог; затем
  // физически создаём каталог через mkdirSync. Если каталог уже существует и
  // не пуст — отказываемся, чтобы не превращать «пустой проект» в скан
  // существующего содержимого.
  ipcMain.handle('projects:pickNewWorkdir', async () => {
    const win = mainWindow.getWindow()
    const result = await dialog.showSaveDialog(win ?? new BrowserWindow(), {
      title: 'Создать папку для нового проекта',
      buttonLabel: 'Создать проект',
      defaultPath: 'new-project',
      properties: ['createDirectory'],
    })
    if (result.canceled || !result.filePath) return null
    try {
      const fs = require('fs') // require: нативный import() не работает в V8-байткоде
      if (fs.existsSync(result.filePath)) {
        const entries = fs.readdirSync(result.filePath)
        if (entries.length > 0) {
          log('[projects:pickNewWorkdir] dir not empty, abort: %s', result.filePath)
          return null
        }
      } else {
        fs.mkdirSync(result.filePath, { recursive: true })
      }
    } catch (e) {
      log('[projects:pickNewWorkdir] mkdir failed: %s', (e as Error).message)
      return null
    }
    return result.filePath
  })

  ipcMain.handle('projects:create', async (_, workdir: string) => {
    // Если проект с таким workdir уже существует — createProject вернёт его
    // (UNIQUE constraint). Скан запускаем только если project_context пуст.
    const existing = getAllProjects().find(p => p.workdir === workdir)
    if (existing && existing.projectContext) {
      // Регистрируем workdir — watcher стартует при активации проекта (setActiveProject).
      registerProjectWorkdir(existing.id, existing.workdir)
      return existing
    }
    let projectContext: string | undefined
    try {
      const scan = await analyzeProject(workdir)
      if (scan.success && scan.output) projectContext = scan.output
      else log('[projects:create] analyzeProject не удался для workdir=%s: %s', workdir, scan.error ?? 'no output')
    } catch (e) {
      log('[projects:create] analyzeProject exception для workdir=%s: %s', workdir, (e as Error).message)
    }
    const project = createProject(workdir, projectContext)
    // Регистрируем workdir нового проекта — watcher стартует при активации.
    registerProjectWorkdir(project.id, project.workdir)
    return project
  })

  ipcMain.handle('projects:getAll', () => getAllProjects())
  ipcMain.handle('projects:rename', (_, id: string, name: string) => renameProject(id, name))
  ipcMain.handle('projects:delete', async (_, id: string, deleteChats: boolean) => {
    // Останавливаем fast context watcher перед удалением проекта
    try { await stopFastContextWatch(id) } catch { /* watcher опционален */ }
    deleteProject(id, deleteChats)
  })
  ipcMain.handle('projects:getById', (_, id: string) => getProjectById(id))
  ipcMain.handle('projects:touch', (_, id: string) => touchProject(id))
  ipcMain.handle('projects:setVerificationCommand', (_, id: string, command: string | null) => setProjectVerificationCommand(id, command))
  ipcMain.handle('projects:setContextFiles', (_, id: string, files: string[], autoDiscover: boolean, disabledDiscoveryFiles?: string[]) => setProjectContextFiles(id, files, autoDiscover, disabledDiscoveryFiles))
}
