import { create } from 'zustand'
import type { RightPanelTab } from './ui.store'

// ── Динамические табы правой панели (Codex-style) ─────────────────────
// Панели (Файлы, Git, Терминал...) открываются как табы по требованию.
// openPanels персистится в electron-store ('rpOpenPanels').
// expanded — панель развёрнута на весь экран (хранится в ui.store).

const SETTINGS_KEY = 'rpOpenPanels'

function persistPanels(panels: RightPanelTab[]) {
  try {
    void window.syntee?.settings?.set(SETTINGS_KEY, panels)
  } catch { /* ок — вне electron */ }
}

interface RightPanelTabsStore {
  openPanels: RightPanelTab[]
  openPanel: (kind: RightPanelTab) => void
  closePanel: (kind: RightPanelTab) => void
  setPanels: (panels: RightPanelTab[]) => void
  restorePanels: (panels: RightPanelTab[]) => void
}

export const useRightPanelTabsStore = create<RightPanelTabsStore>((set, get) => ({
  openPanels: ['sidechat'],
  openPanel: (kind) => {
    if (!get().openPanels.includes(kind)) {
      const next = [...get().openPanels, kind]
      set({ openPanels: next })
      persistPanels(next)
    }
  },
  closePanel: (kind) => {
    const next = get().openPanels.filter(p => p !== kind)
    set({ openPanels: next })
    persistPanels(next)
  },
  setPanels: (panels) => {
    set({ openPanels: panels })
    persistPanels(panels)
  },
  restorePanels: (panels) => {
    if (Array.isArray(panels) && panels.length > 0) {
      set({ openPanels: panels })
    }
  },
}))
