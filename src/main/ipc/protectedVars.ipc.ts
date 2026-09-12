/**
 * IPC for protected variables (user secrets).
 *
 * Channels:
 * - protectedVars:list   → ProtectedVarMeta[] (metadata only, no values)
 * - protectedVars:save   → ProtectedVarSaveInput → ProtectedVarMeta
 * - protectedVars:delete → id → boolean
 *
 * Decrypted values never cross the IPC boundary — they are resolved in the
 * main process only for system-prompt injection (chat.ipc.ts).
 */
import { ipcMain } from 'electron'
import { listVars, saveVar, deleteVar } from '../services/protectedVarsStore'
import type { ProtectedVarMeta, ProtectedVarSaveInput } from '../../shared/types/protectedVars'

export function registerProtectedVarsIPC(): void {
  ipcMain.handle('protectedVars:list', (): ProtectedVarMeta[] => {
    try {
      return listVars()
    } catch (e) {
      console.error('[protectedVars:list]', e)
      return []
    }
  })

  ipcMain.handle('protectedVars:save', (_, input: ProtectedVarSaveInput): { ok: true; meta: ProtectedVarMeta } | { ok: false; error: string } => {
    try {
      return { ok: true, meta: saveVar(input) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('protectedVars:delete', (_, id: string): boolean => {
    try {
      return deleteVar(id)
    } catch (e) {
      console.error('[protectedVars:delete]', e)
      return false
    }
  })
}
