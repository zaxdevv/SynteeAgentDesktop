import { ipcMain } from 'electron'
import type { OverlayManager } from '../overlay/OverlayManager'
import type { MainWindow } from '../windows/MainWindow'
import { IPC_EVENTS } from '../../shared/constants'
import type { NotificationPayload } from '../../shared/types'

/**
 * registerNotificationIPC — IPC-хендлеры overlay-хаба (уведомления + activity).
 *
 * Мышь: hit-testing происходит в RENDERER hub-окна (elementFromPoint на
 * каждый mousemove, троттлинг rAF). Renderer шлёт overlay:setInteractive
 * ТОЛЬКО на смену состояния → OverlayManager переключает click-through.
 * Main процесс не поллит курсор и не хранит bounds карточек — ноль таймеров.
 */
export function registerNotificationIPC(
  overlayManager: OverlayManager,
  mainWindow: MainWindow,
  onAction?: (payload: { id: string; actionId: string; type: string; chatId?: string }) => void,
): void {
  ipcMain.handle('notification:show', () => {
    overlayManager.showHub()
  })

  ipcMain.handle('notification:hide', () => {
    overlayManager.hideHub()
  })

  // Единая политика мыши overlay-хаба: renderer hit-testing → click-through toggle
  ipcMain.on('overlay:setInteractive', (_, v: boolean) => {
    overlayManager.setInteractive(v)
  })

  // Захват экрана для блюра фона карточки
  ipcMain.handle('notification:captureScreen', async () => {
    return overlayManager.captureHubScreen()
  })

  ipcMain.on(IPC_EVENTS.NOTIFICATION_ACTION, (_, payload: { id: string; actionId: string; type: string; chatId?: string; reqId?: string }) => {
    if (payload.actionId === 'open' || payload.actionId === 'expand') {
      mainWindow.show()
    }
    onAction?.(payload)
  })
}

/**
 * Отправить уведомление в overlay-хаб (показ окна + push в renderer).
 */
export function pushNotification(
  overlayManager: OverlayManager,
  payload: NotificationPayload,
): void {
  overlayManager.showHub()
  overlayManager.sendHub(IPC_EVENTS.NOTIFICATION_PUSH, payload)
}
