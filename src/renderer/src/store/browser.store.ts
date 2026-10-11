// ── Browser store: табы встроенного браузера (правая панель) ──────────────
//
// Зеркало реестра BrowserManager (main): main — источник истины, пушит
// BROWSER_TAB_STATE при каждом изменении (URL/title/loading/favicon).
// Renderer хранит снапшот для UI + локальные UI-поля (черновик адресной
// строки). Webview-элементы живут в BrowserPanel (keep-alive — не
// анмаунтятся при переключении таба панели, состояние страниц сохраняется).

import { create } from 'zustand'

export interface BrowserTab {
  tabId: string
  /** webContentsId guest-процесса (-1 до did-attach). */
  webContentsId: number
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  favicon?: string
  /** Таб выгружен (idle-discard): webview-процесс убит ради памяти,
   *  восстановится при выборе таба. */
  discarded?: boolean
  partition?: string
}

interface BrowserStore {
  tabs: BrowserTab[]
  activeTabId: string | null
  /** Черновик адресной строки (локальный UI-стейт, не персистится). */
  urlDraft: string
  /** Фокус адресной строки (для авто-выделения). */
  urlFocused: boolean
  /** Активный browser_* тул агента (null — агент сейчас не управляет
   *  браузером). Ставится useBrowserAutoOpen по agent:step — бейдж «AI». */
  agentActiveTool: string | null

  setTabs: (tabs: BrowserTab[], activeTabId: string | null) => void
  setActiveTab: (tabId: string) => void
  setUrlDraft: (v: string) => void
  setUrlFocused: (v: boolean) => void
  setAgentActiveTool: (tool: string | null) => void
}

export const useBrowserStore = create<BrowserStore>(set => ({
  tabs: [],
  activeTabId: null,
  urlDraft: '',
  urlFocused: false,
  agentActiveTool: null,

  setTabs: (tabs, activeTabId) => set({ tabs, activeTabId }),
  setActiveTab: tabId => set({ activeTabId: tabId }),
  setUrlDraft: v => set({ urlDraft: v }),
  setUrlFocused: v => set({ urlFocused: v }),
  setAgentActiveTool: tool => set({ agentActiveTool: tool }),
}))
