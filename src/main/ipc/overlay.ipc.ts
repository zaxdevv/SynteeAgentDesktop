import { ipcMain, desktopCapturer, screen, BrowserWindow } from 'electron'
import { join } from 'path'
import { app } from 'electron'
import type Store from 'electron-store'
import { AIClient } from '../../core/ai/AIClient'
import { IPC_EVENTS } from '../../shared/constants'

export function registerOverlayIPC(
  store: Store,
  overlayWindow: { getWindow: () => BrowserWindow | null; show: () => void; hide: () => void }
): void {
  // Захват экрана
  ipcMain.handle('overlay:captureScreen', async () => {
    const displays = screen.getAllDisplays()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    })

    // Возвращаем base64 скриншоты для каждого дисплея
    return sources.map((src, i) => ({
      id: src.id,
      displayId: displays[i]?.id,
      bounds: displays[i]?.bounds,
      thumbnail: src.thumbnail.toDataURL().split(',')[1], // base64
    }))
  })

  // Анализ выделенной области через Vision AI
  ipcMain.handle('overlay:analyze', async (_, params: {
    imageBase64: string
    prompt: string
    action: 'analyze' | 'translate' | 'summarize' | 'read'
  }) => {
    const win = overlayWindow.getWindow()
    const client = new AIClient(store)

    const prompts: Record<string, string> = {
      analyze: params.prompt || 'What is shown in this screenshot? Describe in detail and answer in Russian.',
      translate: 'Translate all text in this image into Russian. Translation only, no explanations.',
      summarize: 'Briefly summarize the contents of this image. Answer in Russian.',
      read: 'Read and return all text from this image (OCR). Preserve formatting.',
    }

    const finalPrompt = prompts[params.action] || params.prompt

    await client.analyzeImage(
      params.imageBase64,
      finalPrompt,
      {
        onToken: (token) => {
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, { token, source: 'overlay' })
        },
        onDone: (text) => {
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_DONE, { text, source: 'overlay' })
        },
        onError: (err) => {
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, { error: err.message, source: 'overlay' })
        },
        onRateLimit: (waitSec) => {
          win?.webContents.send(IPC_EVENTS.RATE_LIMIT, { waitSec })
        },
      }
    )
  })

  // Сохранить скриншот в файл
  ipcMain.handle('overlay:saveScreenshot', async (_, base64: string) => {
    // require вместо await import: нативный import() не работает в V8-байткоде
    const { writeFileSync } = require('fs')
    const { mkdirSync } = require('fs')
    const dir = join(app.getPath('userData'), 'screenshots')
    mkdirSync(dir, { recursive: true })
    const filename = `screenshot-${Date.now()}.png`
    const path = join(dir, filename)
    const buf = Buffer.from(base64, 'base64')
    writeFileSync(path, buf)
    return path
  })
}
