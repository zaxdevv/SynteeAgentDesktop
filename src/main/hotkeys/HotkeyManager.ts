import { globalShortcut } from 'electron'
import type Store from 'electron-store'
import { DEFAULT_HOTKEYS } from '../../shared/constants'

interface HotkeyCallbacks {
  toggleMain: () => void
  showOverlay: () => void
  toggleVoice: () => void
  toggleSpotlight: () => void
  quickQuestion: () => void
}

export class HotkeyManager {
  constructor(
    private store: Store,
    private callbacks: HotkeyCallbacks
  ) {}

  registerAll(): void {
    this.unregisterAll()
    const hotkeys = (this.store.get('hotkeys') as typeof DEFAULT_HOTKEYS) ?? DEFAULT_HOTKEYS

    const bindings: Array<[string, () => void]> = [
      [hotkeys.mainWindow ?? DEFAULT_HOTKEYS.mainWindow, this.callbacks.toggleMain],
      [hotkeys.overlay ?? DEFAULT_HOTKEYS.overlay, this.callbacks.showOverlay],
      [hotkeys.voice ?? DEFAULT_HOTKEYS.voice, this.callbacks.toggleVoice],
      [hotkeys.spotlight ?? DEFAULT_HOTKEYS.spotlight, this.callbacks.toggleSpotlight],
      [hotkeys.quickQuestion ?? DEFAULT_HOTKEYS.quickQuestion, this.callbacks.quickQuestion],
    ]

    for (const [accelerator, fn] of bindings) {
      // Пустой accelerator — юзер очистил хоткей. Пропускаем, чтобы не
      // выбросить exception из globalShortcut.register('').
      if (!accelerator) continue
      try {
        const ok = globalShortcut.register(accelerator, fn)
        if (!ok) console.warn(`[Hotkeys] Failed to register: ${accelerator}`)
      } catch (e) {
        console.warn(`[Hotkeys] Error registering ${accelerator}:`, e)
      }
    }
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll()
  }

  // Перерегистрировать при смене настроек
  reload(): void {
    this.registerAll()
  }
}
