import { create } from 'zustand'
import { transitionMainPage } from '../utils/pageNavigationTransition'

export type MainPage = 'chat' | 'settings' | 'memory' | 'messenger' | 'dots'
export type SettingsSection = string

type Navigation = {
  mainPage: MainPage
  settingsSection: SettingsSection
  history: MainPage[]
  historyIndex: number
}
interface NavStore extends Navigation {
  setMainPage: (p: MainPage) => void
  toggleMainPage: (p: MainPage) => void
  openSettings: (section?: SettingsSection) => void
  setSettingsSection: (section: SettingsSection) => void
  goBack: () => boolean
  goForward: () => boolean
  canGoBack: () => boolean
  canGoForward: () => boolean
}

export const useNavStore = create<NavStore>((set, get) => {
  // Native capture is asynchronous. Further clicks must use the latest intent,
  // not the still-visible old page (otherwise rapid toggle cannot close it).
  let requested: Navigation | null = null
  const latest = () => requested ?? get()
  const navigate = (next: Navigation) => {
    const prev = latest()
    if (next.mainPage === prev.mainPage && !requested) {
      set(next)
      return
    }
    requested = next
    transitionMainPage(() => {
      if (requested !== next) return
      requested = null
      set(next)
    }, next.mainPage === 'chat')
  }
  const push = (page: MainPage, section?: string) => {
    const base = latest()
    const history = base.history[base.historyIndex] === page
      ? base.history : [...base.history.slice(0, base.historyIndex + 1), page]
    navigate({
      mainPage: page,
      settingsSection: section ?? base.settingsSection,
      history,
      historyIndex: history === base.history ? base.historyIndex : history.length - 1,
    })
  }
  return {
    mainPage: 'chat',
    settingsSection: 'general',
    history: ['chat'],
    historyIndex: 0,
    setMainPage: (p) => push(p),
    toggleMainPage: (p) => push(latest().mainPage === p ? 'chat' : p),
    openSettings: (section) => push('settings', section ?? 'general'),
    setSettingsSection: (section) => {
      if (requested) requested.settingsSection = section
      set({ settingsSection: section })
    },
    goBack: () => {
      const base = latest()
      if (base.historyIndex <= 0) return false
      const historyIndex = base.historyIndex - 1
      navigate({ ...base, historyIndex, mainPage: base.history[historyIndex] })
      return true
    },
    goForward: () => {
      const base = latest()
      if (base.historyIndex >= base.history.length - 1) return false
      const historyIndex = base.historyIndex + 1
      navigate({ ...base, historyIndex, mainPage: base.history[historyIndex] })
      return true
    },
    canGoBack: () => latest().historyIndex > 0,
    canGoForward: () => latest().historyIndex < latest().history.length - 1,
  }
})
