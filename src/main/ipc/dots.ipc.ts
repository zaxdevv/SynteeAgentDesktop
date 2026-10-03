// ── Dots IPC: управление always-on агентами из renderer ─────────────────
import { ipcMain } from 'electron'
import type Store from 'electron-store'
import type { BrowserWindow } from 'electron'
import { dotManager } from '../managers/DotManager'
import type { DotConfig, DotSettings } from '../../shared/types'

/**
 * Регистрация IPC Dots. Вызывается из main/index.ts ПОСЛЕ registerChatIPC:
 * DotManager.wakeUp использует programmatic chat:send (chatSendImpl уже
 * установлен), initDB уже выполнен (registerChatIPC вызывает initDB).
 */
export function registerDotsIPC(store: Store, getWindow: () => BrowserWindow | null): void {
  dotManager.init(store, getWindow)

  // Список всех Dot'ов с живым состоянием.
  ipcMain.handle('dots:list', () => dotManager.getDots())

  // Один Dot (с состоянием).
  ipcMain.handle('dots:get', (_e, dotId: string) => dotManager.getDot(dotId))

  // Создать Dot (чат + конфиг + триггеры).
  ipcMain.handle('dots:create', (_e, input: {
    name: string
    icon: string
    color: string
    purpose: string
    rules?: string
    schedule?: { kind: 'cron' | 'interval'; value: string }
    watchPaths?: string[]
    webhookEnabled?: boolean
    modelId?: string | null
    modelProvider?: string | null
  }) => {
    try {
      return { ok: true, dot: dotManager.createDot(input) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Обновить конфиг Dot'а.
  ipcMain.handle('dots:update', (_e, dotId: string, patch: Partial<DotConfig>) => {
    try {
      return { ok: true, dot: dotManager.updateDot(dotId, patch) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Удалить Dot (+ его чат).
  ipcMain.handle('dots:delete', (_e, dotId: string) => {
    dotManager.deleteDot(dotId)
    return { ok: true }
  })

  // Разбудить вручную (кнопка «Разбудить»). Возвращает результат: если
  // пробуждение пропущено (Dot выключен / глобальная пауза / чат занят) —
  // reason, чтобы UI показал честный тост вместо «разбужен».
  ipcMain.handle('dots:runNow', (_e, dotId: string) => {
    try {
      return dotManager.runNow(dotId)
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  })

  // История пробуждений Dot'а.
  ipcMain.handle('dots:getRuns', (_e, dotId: string, limit?: number) =>
    dotManager.getRuns(dotId, limit ?? 20))

  // Unread-счётчики пачкой: [{dotId, since}] → {dotId: nОтчётовПослеSince}.
  ipcMain.handle('dots:unreadCounts', (_e, pairs: Array<{ dotId: string; since: number }>) =>
    dotManager.getUnreadCounts(Array.isArray(pairs) ? pairs : []))

  // Webhook-URL Dot'а (для копирования в UI).
  ipcMain.handle('dots:getWebhookUrl', (_e, dotId: string) => dotManager.getWebhookUrl(dotId))

  // ── Глобальные настройки Dots ──
  ipcMain.handle('dots:getSettings', () => dotManager.getSettings())
  ipcMain.handle('dots:setSettings', (_e, patch: Partial<DotSettings>) =>
    dotManager.setSettings(patch))
}
