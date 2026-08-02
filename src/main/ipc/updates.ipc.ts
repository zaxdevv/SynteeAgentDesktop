/**
 * IPC handlers for the in-app update checker.
 *
 * The renderer calls these to:
 *   - check for updates (manual "Check now" button in settings)
 *   - get the current update state (badge visibility, manifest)
 *   - subscribe to state changes (badge appears/disappears in real time)
 *   - fetch the changelog history (for the settings "Changelog" tab)
 *   - dismiss the current update (badge goes away until a new version ships)
 *   - quit-and-install (triggers app.quit() → launcher applies staged update)
 *
 * The actual download + apply happens in syntee-launcher (Go); this module
 * only coordinates UI state. See src/main/updater/UpdateChecker.ts for the
 * polling logic and src/shared/types for UpdateManifest/UpdateState shapes.
 */
import { ipcMain, type BrowserWindow } from 'electron'
import type { ChangelogEntry, QuitAndInstallResult, UpdateState } from '../../shared/types'
import {
  checkForUpdates,
  dismissUpdate,
  getUpdateState,
  quitAndInstall,
  subscribeUpdates,
} from '../updater/UpdateChecker'
import { changelogUrl } from '../updater/config'

export function registerUpdatesIPC(getMainWindow: () => BrowserWindow | null): void {
  // Manual check — returns the new state so the renderer can react inline.
  ipcMain.handle('updates:check', async (): Promise<UpdateState> => {
    return checkForUpdates()
  })

  // Snapshot of current state (badge, manifest, dismissed versions).
  ipcMain.handle('updates:getStatus', (): UpdateState => {
    return getUpdateState()
  })

  // Changelog history for the settings tab. Fetched here (not in renderer)
  // so the request goes through the main process and stays CSP-clean.
  ipcMain.handle(
    'updates:getHistory',
    async (_e, params?: { channel?: string; limit?: number }): Promise<ChangelogEntry[]> => {
      const channel = params?.channel ?? 'stable'
      const limit = Math.min(params?.limit ?? 50, 100)
      const url = changelogUrl(channel, limit)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      try {
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as ChangelogEntry[]
      } finally {
        clearTimeout(timer)
      }
    },
  )

  // Dismiss the current update so the badge disappears. Force updates ignore
  // this (handled in the renderer — the ForceUpdateModal can't be closed).
  ipcMain.handle('updates:dismiss', async (_e, version: string): Promise<UpdateState> => {
    dismissUpdate(version)
    return getUpdateState()
  })

  // Launch the updater and exit the client so the update can be applied.
  // Returns { ok: false, error } when the updater couldn't be started — in
  // that case the app keeps running and the UI shows the error.
  ipcMain.handle('updates:quitAndInstall', async (): Promise<QuitAndInstallResult> => {
    return quitAndInstall()
  })

  // Push state changes to the main window. The renderer listens via
  // window.syntee.updates.onStateChanged(cb) exposed in the preload.
  subscribeUpdates((state: UpdateState) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('updates:state-changed', state)
    }
  })
}
