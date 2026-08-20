/**
 * IPC для PTY-терминала: создание/ввод/resize/kill сессий, детект shells,
 * AI-exec (run_command через видимую сессию).
 *
 * Стриминг данных идёт не через invoke, а через webContents.send('pty:data'/'pty:exit')
 * — renderer подписывается через window.syntee.on('pty:data', ...).
 */
import { ipcMain } from 'electron'
import type { MainWindow } from '../windows/MainWindow'
import { ptyManager, detectShells, type ShellType } from '../managers/PtyManager'

export function registerPtyIPC(mainWindow: MainWindow): void {
  // WebContents нужен для стриминга; обновляем при каждом invoke на случай
  // пересоздания окна (dev reload).
  const refreshSender = () => {
    const w = mainWindow.getWindow()
    ptyManager.setSender(w ?? null)
  }

  ipcMain.handle('pty:detectShells', () => {
    refreshSender()
    return detectShells()
  })

  ipcMain.handle('pty:create', (_, params: { chatId: string; shell: ShellType; cwd?: string; source?: 'user' | 'agent'; title?: string }) => {
    refreshSender()
    const id = ptyManager.create(params.chatId, params.shell, params.cwd, params.source ?? 'user', params.title)
    return ptyManager.getMeta(id) ?? null
  })

  ipcMain.handle('pty:list', (_, chatId: string) => {
    refreshSender()
    return ptyManager.listByChat(chatId)
  })

  ipcMain.handle('pty:write', (_, sessionId: string, data: string) => {
    ptyManager.write(sessionId, data)
  })

  ipcMain.handle('pty:resize', (_, sessionId: string, cols: number, rows: number) => {
    ptyManager.resize(sessionId, cols, rows)
  })

  ipcMain.handle('pty:kill', (_, sessionId: string) => {
    ptyManager.kill(sessionId)
  })

  ipcMain.handle('pty:consumePreMount', (_, sessionId: string) => {
    return ptyManager.consumePreMount(sessionId)
  })

  ipcMain.handle('pty:getMeta', (_, sessionId: string) => {
    return ptyManager.getMeta(sessionId) ?? null
  })
}
