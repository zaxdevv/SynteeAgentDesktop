import { create } from 'zustand'
import type { CustomTheme } from '../../../shared/types'

type Theme =
  | 'dark' | 'light' | 'midnight' | 'forest' | 'amber' | 'rose' | 'paper' | 'slate'
  | 'crimson' | 'pitch' | 'ocean' | 'carbon'
  | 'nord' | 'dracula' | 'gruvbox' | 'tokyonight' | 'mocha' | 'onedark' | 'monokai'
  | 'everforest' | 'solarized' | 'latte' | 'sepia' | 'dawn' | 'mist' | 'mint' | 'sakura'
  | 'custom'
type Page = 'chat' | 'settings' | 'tasks' | 'notes' | 'stats'
type Density = 'compact' | 'comfortable' | 'spacious'

export type AvatarStyle = 'hex' | 'circle' | 'letter' | 'emoji' | 'none'
export type ShowTime = 'always' | 'hover' | 'never'

export interface AccentGradient { enabled: boolean; color2: string; angle: number }
export interface BgImage {
  src: string
  blur: number
  opacity: number
  tint: string
  tintStrength: number
  scale: 'cover' | 'contain' | number
}
export interface ThemeSchedule {
  enabled: boolean
  dayTheme: string
  nightTheme: string
  dayTime: string
  nightTime: string
}

export const AGENT_PANEL_WIDTH_MIN = 280
export const AGENT_PANEL_WIDTH_DEFAULT = 420

// RightPanelTab определён здесь (а не импортируется из RightPanel.tsx),
// чтобы избежать circular import: ui.store → RightPanel → ui.store.
export type RightPanelTab = 'agents' | 'files' | 'git' | 'session' | 'sidechat' | 'terminal' | 'notes'
const VALID_TABS: RightPanelTab[] = ['sidechat', 'agents', 'files', 'git', 'session', 'terminal', 'notes']
export { VALID_TABS }
export function isValidTab(v: unknown): v is RightPanelTab {
  return typeof v === 'string' && (VALID_TABS as string[]).includes(v)
}

export function getAgentPanelWidthMax(): number {
  if (typeof window === 'undefined') return 720
  return Math.min(Math.floor(window.innerWidth * 0.7), 1600)
}

interface UIStore {
  theme: Theme
  accentColor: string
  agentPanelWidth: number
  agentPanelOpen: boolean
  agentPanelTab: RightPanelTab
  agentPanelExpanded: boolean
  animatedBackground: boolean
  bgStyle: string
  msgAnim: string
  avatarStyle: AvatarStyle
  showTime: ShowTime
  userMarkdown: boolean
  uiSounds: boolean
  sendEffect: boolean
  currentPage: Page
  isLoading: boolean
  glassBlur: number
  density: Density
  accentGradient: AccentGradient
  rainbowAccent: boolean
  bgImage: BgImage | null
  bgImageEnabled: boolean
  animatedBgOpacity: number
  animatedBgSpeed: number
  bgStyleParams: Record<string, number>
  customThemes: CustomTheme[]
  activeCustomThemeId: string | null
  themeSchedule: ThemeSchedule
  recentAccents: string[]
  // Избранные темы (id встроенных или кастомных) — закрепляются в начале сетки.
  favoriteThemes: string[]
  // Размеры шрифта (px): интерфейс масштабирует --font-size-*, чат — --chat-font-size.
  fontSizeUI: number
  fontSizeChat: number
  // Синхронизация с системной темой Windows: dark/light выбираются юзером.
  systemThemeSync: boolean
  systemSyncDark: string
  systemSyncLight: string
  soundVolume: number
  soundAssignments: Record<string, string | null>
  // Навигация боковыми кнопками мыши (X1 — назад, X2 — вперёд). По умолчанию
  // включено, как в браузере.
  mouseNavEnabled: boolean
  setTheme: (theme: Theme) => void
  setAccentColor: (color: string) => void
  setAgentPanelWidth: (width: number) => void
  setAgentPanelOpen: (open: boolean) => void
  setAgentPanelTab: (tab: RightPanelTab) => void
  setAgentPanelExpanded: (v: boolean) => void
  setCurrentPage: (page: Page) => void
  setLoading: (loading: boolean) => void
  setBgStyle: (style: string) => void
  setMsgAnim: (anim: string) => void
  setAnimatedBackground: (v: boolean) => void
  setAvatarStyle: (v: AvatarStyle) => void
  setShowTime: (v: ShowTime) => void
  setUserMarkdown: (v: boolean) => void
  setUiSounds: (v: boolean) => void
  setSendEffect: (v: boolean) => void
  setGlassBlur: (v: number) => void
  setDensity: (v: Density) => void
  setAccentGradient: (v: AccentGradient) => void
  setRainbowAccent: (v: boolean) => void
  setBgImage: (v: BgImage | null) => void
  setBgImageEnabled: (v: boolean) => void
  setAnimatedBgOpacity: (v: number) => void
  setAnimatedBgSpeed: (v: number) => void
  setBgStyleParams: (v: Record<string, number>) => void
  setCustomThemes: (v: CustomTheme[]) => void
  setActiveCustomThemeId: (v: string | null) => void
  setThemeSchedule: (v: ThemeSchedule) => void
  setRecentAccents: (v: string[]) => void
  setFavoriteThemes: (v: string[]) => void
  setFontSizeUI: (v: number) => void
  setFontSizeChat: (v: number) => void
  setSystemThemeSync: (v: boolean) => void
  setSystemSyncDark: (v: string) => void
  setSystemSyncLight: (v: string) => void
  setSoundVolume: (v: number) => void
  setSoundAssignments: (v: Record<string, string | null>) => void
  setMouseNavEnabled: (v: boolean) => void
}

function clampAgentPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return AGENT_PANEL_WIDTH_DEFAULT
  return Math.min(getAgentPanelWidthMax(), Math.max(AGENT_PANEL_WIDTH_MIN, Math.round(w)))
}

export const DEFAULT_THEME_SCHEDULE: ThemeSchedule = {
  enabled: false,
  dayTheme: 'light',
  nightTheme: 'dark',
  dayTime: '08:00',
  nightTime: '20:00',
}

export const useUIStore = create<UIStore>((set, get) => ({
  theme: 'dark',
  accentColor: '#ffffff',
  agentPanelWidth: AGENT_PANEL_WIDTH_DEFAULT,
  agentPanelOpen: false,
  agentPanelTab: 'sidechat',
  agentPanelExpanded: false,
  animatedBackground: true,
  bgStyle: 'aurora',
  msgAnim: 'slide',
  avatarStyle: 'hex',
  showTime: 'hover',
  userMarkdown: false,
  uiSounds: true,
  sendEffect: true,
  currentPage: 'chat',
  isLoading: false,
  glassBlur: 20,
  density: 'comfortable',
  accentGradient: { enabled: false, color2: '#a78bfa', angle: 135 },
  rainbowAccent: false,
  bgImage: null,
  bgImageEnabled: true,
  animatedBgOpacity: 60,
  animatedBgSpeed: 1,
  bgStyleParams: {},
  customThemes: [],
  activeCustomThemeId: null,
  themeSchedule: DEFAULT_THEME_SCHEDULE,
  recentAccents: [],
  favoriteThemes: [],
  fontSizeUI: 14,
  fontSizeChat: 14,
  systemThemeSync: false,
  systemSyncDark: 'dark',
  systemSyncLight: 'light',
  soundVolume: 70,
  soundAssignments: {},
  mouseNavEnabled: true,

  setTheme: (theme) => set({ theme }),
  setAccentColor: (accentColor) => set({ accentColor }),
  setAgentPanelWidth: (agentPanelWidth) => set({ agentPanelWidth: clampAgentPanelWidth(agentPanelWidth) }),
  setAgentPanelOpen: (open) => {
    const prev = get().agentPanelOpen
    set({ agentPanelOpen: open })
    if (open !== prev) {
      import('../utils/sounds').then((m) => open ? m.playPanelOpenSound() : m.playPanelCloseSound())
    }
  },
  setAgentPanelTab: (agentPanelTab) => set({ agentPanelTab }),
  setAgentPanelExpanded: (agentPanelExpanded) => set({ agentPanelExpanded }),
  setCurrentPage: (currentPage) => set({ currentPage }),
  setLoading: (isLoading) => set({ isLoading }),
  setBgStyle: (bgStyle) => set({ bgStyle }),
  setMsgAnim: (msgAnim) => set({ msgAnim }),
  setAnimatedBackground: (animatedBackground) => set({ animatedBackground }),
  setAvatarStyle: (avatarStyle) => set({ avatarStyle }),
  setShowTime: (showTime) => set({ showTime }),
  setUserMarkdown: (userMarkdown) => set({ userMarkdown }),
  setUiSounds: (uiSounds) => set({ uiSounds }),
  setSendEffect: (sendEffect) => set({ sendEffect }),
  setGlassBlur: (glassBlur) => set({ glassBlur }),
  setDensity: (density) => set({ density }),
  setAccentGradient: (accentGradient) => set({ accentGradient }),
  setRainbowAccent: (rainbowAccent) => set({ rainbowAccent }),
  setBgImage: (bgImage) => set({ bgImage }),
  setBgImageEnabled: (bgImageEnabled) => set({ bgImageEnabled }),
  setAnimatedBgOpacity: (animatedBgOpacity) => set({ animatedBgOpacity }),
  setAnimatedBgSpeed: (animatedBgSpeed) => set({ animatedBgSpeed }),
  setBgStyleParams: (bgStyleParams) => set({ bgStyleParams }),
  setCustomThemes: (customThemes) => set({ customThemes }),
  setActiveCustomThemeId: (activeCustomThemeId) => set({ activeCustomThemeId }),
  setThemeSchedule: (themeSchedule) => set({ themeSchedule }),
  setRecentAccents: (recentAccents) => set({ recentAccents }),
  setFavoriteThemes: (favoriteThemes) => set({ favoriteThemes }),
  setFontSizeUI: (fontSizeUI) => set({ fontSizeUI }),
  setFontSizeChat: (fontSizeChat) => set({ fontSizeChat }),
  setSystemThemeSync: (systemThemeSync) => set({ systemThemeSync }),
  setSystemSyncDark: (systemSyncDark) => set({ systemSyncDark }),
  setSystemSyncLight: (systemSyncLight) => set({ systemSyncLight }),
  setSoundVolume: (soundVolume) => set({ soundVolume }),
  setSoundAssignments: (soundAssignments) => set({ soundAssignments }),
  setMouseNavEnabled: (mouseNavEnabled) => set({ mouseNavEnabled }),
}))
