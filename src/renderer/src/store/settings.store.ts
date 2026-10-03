import { create } from 'zustand'
import { DEFAULT_HOTKEYS } from '../../../shared/constants'

interface SettingsStore {
  loaded: boolean
  settings: Record<string, unknown>
  // Actions
  load: () => Promise<void>
  set: (key: string, value: unknown) => Promise<void>
  get: <T>(key: string, fallback?: T) => T
}

// Объединяем только одновременные чтения; явный последующий load всё
// ещё перечитывает настройки (важно после изменения из main/другого окна).
let loadInFlight: Promise<void> | null = null

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  loaded: false,
  settings: {},

  load: () => {
    if (loadInFlight) return loadInFlight
    loadInFlight = (async () => {
    const all = await window.syntee.settings.getAll() as Record<string, unknown>
    // Merge default hotkeys with stored ones. Всегда merge — даже если
    // all.hotkeys отсутствует (новая установка, сброс) или это не объект
    // (повреждённые данные). Недостающие ключи (chatAskMode, chatPlanningMode
    // для существующих юзеров) берутся из DEFAULT_HOTKEYS. Ключи, явно
    // очищенные юзером (значение ''), не перезаписываются.
    const storedHotkeys = (all.hotkeys && typeof all.hotkeys === 'object')
      ? all.hotkeys as Record<string, string>
      : {}
    all.hotkeys = { ...DEFAULT_HOTKEYS, ...storedHotkeys }
    set({ settings: all, loaded: true })
    })().finally(() => { loadInFlight = null })
    return loadInFlight
  },

  set: async (key, value) => {
    await window.syntee.settings.set(key, value)
    set((s) => ({ settings: { ...s.settings, [key]: value } }))
  },

  get: <T>(key: string, fallback?: T): T => {
    return (get().settings[key] as T) ?? (fallback as T)
  },
}))
