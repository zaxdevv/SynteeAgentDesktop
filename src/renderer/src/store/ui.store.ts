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
//
// Табы плагинов имеют вид 'plugin:{pluginId}:{panelId}' — набор динамический,
// поэтому union расширяется через (string & {}) (тип-эскейп для паттерна
// «открытый union»). Builtin-список остаётся строгим для статических панелей.
export type BuiltinRightPanelTab = 'agents' | 'files' | 'git' | 'session' | 'sidechat' | 'terminal' | 'notes' | 'chart'
export type RightPanelTab = BuiltinRightPanelTab | (string & {})

/** Префикс табов плагинов в правой панели. */
export const PLUGIN_TAB_PREFIX = 'plugin:'

/** Собрать id таба плагина: plugin:{pluginId}:{panelId}. */
export function buildPluginTabId(pluginId: string, panelId: string): string {
  return `${PLUGIN_TAB_PREFIX}${pluginId}:${panelId}`
}

/** Разобрать id таба плагина; для не-plugin табов — null. */
export function parsePluginTabId(tabId: string): { pluginId: string; panelId: string } | null {
  if (!tabId.startsWith(PLUGIN_TAB_PREFIX)) return null
  const rest = tabId.slice(PLUGIN_TAB_PREFIX.length)
  const idx = rest.indexOf(':')
  if (idx <= 0 || idx === rest.length - 1) return null
  return { pluginId: rest.slice(0, idx), panelId: rest.slice(idx + 1) }
}

const VALID_TABS: BuiltinRightPanelTab[] = ['sidechat', 'agents', 'files', 'git', 'session', 'terminal', 'notes']
export { VALID_TABS }
export function isValidTab(v: unknown): v is RightPanelTab {
  return typeof v === 'string'
    && ((VALID_TABS as string[]).includes(v) || v.startsWith(PLUGIN_TAB_PREFIX))
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
  // Активная тема плагина: ключ `plugin:{pluginId}:{name}` (persist в 'theme'),
  // либо null. Нужен чтобы не затирать CSS-переменные плагина при смене base.
  pluginTheme: string | null
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
  // ── ChangesBadge → SessionChangesPanel фокус ──
  // focusSessionChanges вызывается при клике по бейджу/файлу в popup:
  // инкрементит nonce (SessionChangesPanel по нему перезагружает последний
  // чекпоинт с правками) и запоминает файл для выделения в diff-списке.
  sessionFocusFile: string | null
  sessionFocusNonce: number
  setTheme: (theme: Theme) => void
  setAccentColor: (color: string) => void
  setAgentPanelWidth: (width: number) => void
  setAgentPanelOpen: (open: boolean) => void
  setAgentPanelTab: (tab: RightPanelTab) => void
  focusSessionChanges: (file?: string | null) => void
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
  setPluginTheme: (v: string | null) => void
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
  pluginTheme: null,
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
  sessionFocusFile: null,
  sessionFocusNonce: 0,

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
  focusSessionChanges: (file) => set({
    sessionFocusFile: file ?? null,
    sessionFocusNonce: get().sessionFocusNonce + 1,
  }),
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
  setPluginTheme: (pluginTheme) => set({ pluginTheme }),
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
