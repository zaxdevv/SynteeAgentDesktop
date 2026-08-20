// ── Custom Theme ────────────────────────────────────────────────────────

/** Пользовательская кастомная тема (полный редактор в настройках). */
export interface CustomTheme {
  id: string
  name: string
  base: 'light' | 'dark'
  colors: {
    bodyBg: string
    bgPrimary: string
    bgSecondary: string
    bgTertiary: string
    textPrimary: string
    textSecondary: string
    textMuted: string
    accent: string
    sidebarBg: string
    /** Опциональные поля — для большего контроля. Старые темы без них работают (fallback на вычисление из accent). */
    border?: string
    borderStrong?: string
    accentGradient?: string
    shadowColor?: string
  }
  glass: {
    blur: number
    saturate: number
    opacity: number
  }
  effects?: {
    /** Множитель интенсивности overlay-слоёв (0.5–2.0, default 1). */
    overlayIntensity?: number
  }
}
