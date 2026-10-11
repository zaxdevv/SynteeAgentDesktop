import Store from 'electron-store'

let settingsStore: Store | null = null

export function setGlobalMemorySettingsStore(store: Store): void {
  settingsStore = store
}

export function getMemorySettings(): { enabled: boolean; global: boolean; project: boolean; chat: boolean; auto: boolean } {
  const get = (key: string, fallback: boolean) => settingsStore?.get(key, fallback) === true
  return {
    enabled: get('memoryEnabled', true),
    global: get('globalMemoryEnabled', true),
    project: get('projectMemoryEnabled', true),
    chat: get('chatMemoryEnabled', true),
    auto: get('autoMemoryEnabled', true),
  }
}

export function isMemoryEnabled(): boolean {
  return getMemorySettings().enabled
}

export function getGlobalMemoryEnabled(): boolean {
  const s = getMemorySettings()
  return s.enabled && s.global
}
