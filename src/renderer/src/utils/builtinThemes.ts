import type { CustomTheme } from '../../../shared/types'

// ── Встроенные темы ─────────────────────────────────────────────
// Единый источник правды о встроенных темах:
// 1) card — 4 цвета для мини-превью в селекторе тем (SettingsPage)
// 2) template — полный набор CustomTheme['colors'] для «Создать из шаблона»
//    в редакторе тем (значения зеркалируют блоки [data-theme] в globals.css)
// ID совпадают с [data-theme="..."] в globals.css и типом Theme в ui.store.

export interface BuiltinTheme {
  id: string
  label: string
  group: 'dark' | 'light'
  card: { bg: string; surface: string; text: string; accent: string }
  template: CustomTheme['colors']
}

function tpl(
  bodyBg: string,
  bgPrimary: string,
  bgSecondary: string,
  bgTertiary: string,
  textPrimary: string,
  textSecondary: string,
  textMuted: string,
  accent: string,
  sidebarBg: string,
): CustomTheme['colors'] {
  return {
    bodyBg, bgPrimary, bgSecondary, bgTertiary,
    textPrimary, textSecondary, textMuted, accent, sidebarBg,
    border: '', borderStrong: '', accentGradient: '', shadowColor: '',
  }
}

export const BUILTIN_THEMES: BuiltinTheme[] = [
  // ── Тёмные ──────────────────────────────────────────────────
  { id: 'dark', label: 'Тёмная', group: 'dark',
    card: { bg: '#0e0e12', surface: '#1c1c24', text: '#e8e8ec', accent: '#e8e8ec' },
    template: tpl('#0e0e12', 'rgba(20, 20, 26, 0.82)', 'rgba(28, 28, 36, 0.85)', 'rgba(38, 38, 48, 0.88)', '#e8e8ec', '#9a9aa5', '#5c5c68', '#e8e8ec', 'rgba(14, 14, 18, 0.88)') },
  { id: 'midnight', label: 'Полночь', group: 'dark',
    card: { bg: '#060912', surface: '#0f1525', text: '#e0e8ff', accent: '#4d9fff' },
    template: tpl('#060912', 'rgba(10, 14, 26, 0.82)', 'rgba(15, 21, 37, 0.85)', 'rgba(21, 29, 50, 0.88)', '#e0e8ff', '#7888bb', '#445577', '#4d9fff', 'rgba(8, 12, 22, 0.88)') },
  { id: 'forest', label: 'Лес', group: 'dark',
    card: { bg: '#070e09', surface: '#122014', text: '#d4f0d8', accent: '#4caf60' },
    template: tpl('#070e09', 'rgba(13, 26, 15, 0.82)', 'rgba(18, 32, 20, 0.85)', 'rgba(23, 40, 24, 0.88)', '#d4f0d8', '#6a9970', '#3d5c42', '#4caf60', 'rgba(10, 21, 12, 0.88)') },
  { id: 'slate', label: 'Сталь', group: 'dark',
    card: { bg: '#0a0d14', surface: '#1a1f2c', text: '#e2e8f0', accent: '#5b8def' },
    template: tpl('#0a0d14', 'rgba(18, 22, 32, 0.82)', 'rgba(26, 31, 44, 0.85)', 'rgba(36, 42, 58, 0.88)', '#e2e8f0', '#8295b0', '#4a5870', '#5b8def', 'rgba(14, 17, 25, 0.88)') },
  { id: 'amber', label: 'Янтарь', group: 'dark',
    card: { bg: '#100a05', surface: '#26190e', text: '#f5e6d3', accent: '#ff9b3d' },
    template: tpl('#100a05', 'rgba(28, 18, 10, 0.82)', 'rgba(38, 25, 14, 0.85)', 'rgba(50, 33, 18, 0.88)', '#f5e6d3', '#b89878', '#6b5538', '#ff9b3d', 'rgba(22, 14, 8, 0.88)') },
  { id: 'rose', label: 'Роза', group: 'dark',
    card: { bg: '#120810', surface: '#2a1620', text: '#fce8ee', accent: '#ff6b9d' },
    template: tpl('#120810', 'rgba(30, 16, 24, 0.82)', 'rgba(42, 22, 32, 0.85)', 'rgba(56, 30, 42, 0.88)', '#fce8ee', '#c89aar', '#7a5566', '#ff6b9d', 'rgba(24, 12, 18, 0.88)') },
  { id: 'crimson', label: 'Багровый', group: 'dark',
    card: { bg: '#100406', surface: '#281012', text: '#ffe8ea', accent: '#ff5a4d' },
    template: tpl('#100406', 'rgba(28, 10, 12, 0.82)', 'rgba(40, 16, 18, 0.85)', 'rgba(54, 22, 24, 0.88)', '#ffe8ea', '#c88088', '#6b4044', '#ff5a4d', 'rgba(22, 8, 10, 0.88)') },
  { id: 'pitch', label: 'Антрацит', group: 'dark',
    card: { bg: '#000000', surface: '#141414', text: '#e0e0e0', accent: '#737373' },
    template: tpl('#000000', 'rgba(8, 8, 8, 0.85)', 'rgba(14, 14, 14, 0.88)', 'rgba(20, 20, 20, 0.90)', '#e0e0e0', '#888888', '#555555', '#737373', 'rgba(6, 6, 6, 0.92)') },
  { id: 'ocean', label: 'Океан', group: 'dark',
    card: { bg: '#020a0e', surface: '#0a1a22', text: '#d0f0f5', accent: '#22d3ee' },
    template: tpl('#020a0e', 'rgba(6, 18, 24, 0.82)', 'rgba(10, 26, 34, 0.85)', 'rgba(14, 34, 44, 0.88)', '#d0f0f5', '#6a9aa8', '#3d6772', '#22d3ee', 'rgba(4, 14, 18, 0.88)') },
  { id: 'carbon', label: 'Карбон', group: 'dark',
    card: { bg: '#0c0c0c', surface: '#1c1c1c', text: '#e0e0e0', accent: '#a3a3a3' },
    template: tpl('#0c0c0c', 'rgba(20, 20, 20, 0.85)', 'rgba(28, 28, 28, 0.88)', 'rgba(38, 38, 38, 0.90)', '#e0e0e0', '#909090', '#5a5a5a', '#a3a3a3', 'rgba(16, 16, 16, 0.90)') },
  { id: 'nord', label: 'Норд', group: 'dark',
    card: { bg: '#2e3440', surface: '#3b4252', text: '#eceff4', accent: '#88c0d0' },
    template: tpl('#2e3440', 'rgba(59, 66, 82, 0.82)', 'rgba(67, 76, 94, 0.85)', 'rgba(76, 86, 106, 0.88)', '#eceff4', '#a8b2c3', '#6b7688', '#88c0d0', 'rgba(36, 41, 51, 0.88)') },
  { id: 'dracula', label: 'Дракула', group: 'dark',
    card: { bg: '#21222c', surface: '#343746', text: '#f8f8f2', accent: '#bd93f9' },
    template: tpl('#21222c', 'rgba(40, 42, 54, 0.82)', 'rgba(52, 55, 70, 0.85)', 'rgba(68, 71, 90, 0.88)', '#f8f8f2', '#b3b9d1', '#6272a4', '#bd93f9', 'rgba(27, 28, 36, 0.88)') },
  { id: 'gruvbox', label: 'Грувбокс', group: 'dark',
    card: { bg: '#1d2021', surface: '#3c3836', text: '#ebdbb2', accent: '#fabd2f' },
    template: tpl('#1d2021', 'rgba(40, 40, 40, 0.82)', 'rgba(60, 56, 54, 0.85)', 'rgba(80, 73, 69, 0.88)', '#ebdbb2', '#bdae93', '#7c6f64', '#fabd2f', 'rgba(24, 26, 27, 0.88)') },
  { id: 'tokyonight', label: 'Токио Найт', group: 'dark',
    card: { bg: '#1a1b26', surface: '#24283e', text: '#c0caf5', accent: '#7aa2f7' },
    template: tpl('#1a1b26', 'rgba(31, 35, 53, 0.82)', 'rgba(36, 40, 62, 0.85)', 'rgba(52, 59, 88, 0.88)', '#c0caf5', '#9aa5ce', '#565f89', '#7aa2f7', 'rgba(22, 22, 30, 0.88)') },
  { id: 'mocha', label: 'Мокка', group: 'dark',
    card: { bg: '#181825', surface: '#313244', text: '#cdd6f4', accent: '#cba6f7' },
    template: tpl('#181825', 'rgba(30, 30, 46, 0.82)', 'rgba(49, 50, 68, 0.85)', 'rgba(69, 71, 90, 0.88)', '#cdd6f4', '#a6adc8', '#6c7086', '#cba6f7', 'rgba(17, 17, 27, 0.88)') },
  { id: 'onedark', label: 'One Dark', group: 'dark',
    card: { bg: '#21252b', surface: '#323842', text: '#abb2bf', accent: '#61afef' },
    template: tpl('#21252b', 'rgba(40, 44, 52, 0.82)', 'rgba(50, 56, 66, 0.85)', 'rgba(62, 68, 82, 0.88)', '#abb2bf', '#828997', '#5c6370', '#61afef', 'rgba(28, 32, 38, 0.88)') },
  { id: 'monokai', label: 'Монокай', group: 'dark',
    card: { bg: '#22231c', surface: '#31322a', text: '#f8f8f2', accent: '#a6e22e' },
    template: tpl('#22231c', 'rgba(39, 40, 34, 0.82)', 'rgba(49, 50, 42, 0.85)', 'rgba(62, 63, 52, 0.88)', '#f8f8f2', '#a9a894', '#75715e', '#a6e22e', 'rgba(30, 31, 24, 0.88)') },
  { id: 'everforest', label: 'Эверфорест', group: 'dark',
    card: { bg: '#272e33', surface: '#343f44', text: '#d3c6aa', accent: '#a7c080' },
    template: tpl('#272e33', 'rgba(45, 53, 59, 0.82)', 'rgba(52, 63, 68, 0.85)', 'rgba(61, 72, 77, 0.88)', '#d3c6aa', '#9da9a0', '#7a8478', '#a7c080', 'rgba(35, 43, 47, 0.88)') },
  { id: 'solarized', label: 'Солярис', group: 'dark',
    card: { bg: '#002b36', surface: '#073642', text: '#93a1a1', accent: '#268bd2' },
    template: tpl('#002b36', 'rgba(7, 54, 66, 0.82)', 'rgba(12, 64, 78, 0.85)', 'rgba(20, 78, 94, 0.88)', '#93a1a1', '#839496', '#586e75', '#268bd2', 'rgba(0, 37, 46, 0.88)') },

  // ── Светлые ─────────────────────────────────────────────────
  { id: 'light', label: 'Светлая', group: 'light',
    card: { bg: '#f4f1ec', surface: '#f3efe8', text: '#2a2620', accent: '#4a3f2f' },
    template: tpl('#f4f1ec', 'rgba(252, 249, 244, 0.88)', 'rgba(243, 239, 232, 0.9)', 'rgba(232, 226, 216, 0.92)', '#2a2620', '#6b655c', '#a39c91', '#4a3f2f', 'rgba(240, 235, 226, 0.92)') },
  { id: 'paper', label: 'Бумага', group: 'light',
    card: { bg: '#f6f8fa', surface: '#f0f3f6', text: '#1f2328', accent: '#0969da' },
    template: tpl('#f6f8fa', 'rgba(255, 255, 255, 0.88)', 'rgba(246, 248, 250, 0.9)', 'rgba(233, 236, 240, 0.92)', '#1f2328', '#59636e', '#8c959f', '#0969da', 'rgba(240, 243, 246, 0.92)') },
  { id: 'latte', label: 'Латте', group: 'light',
    card: { bg: '#e6e9ef', surface: '#eff1f5', text: '#4c4f69', accent: '#8839ef' },
    template: tpl('#e6e9ef', 'rgba(239, 241, 245, 0.88)', 'rgba(230, 233, 239, 0.9)', 'rgba(220, 224, 232, 0.92)', '#4c4f69', '#6c6f85', '#9ca0b0', '#8839ef', 'rgba(220, 224, 232, 0.92)') },
  { id: 'sepia', label: 'Сепия', group: 'light',
    card: { bg: '#ece0c8', surface: '#f4ecd8', text: '#5b4636', accent: '#9a6b2f' },
    template: tpl('#ece0c8', 'rgba(244, 236, 216, 0.88)', 'rgba(233, 221, 193, 0.9)', 'rgba(222, 208, 176, 0.92)', '#5b4636', '#8a7360', '#b0a08a', '#9a6b2f', 'rgba(228, 214, 184, 0.92)') },
  { id: 'dawn', label: 'Рассвет', group: 'light',
    card: { bg: '#f4ede6', surface: '#faf4ed', text: '#575279', accent: '#b4637a' },
    template: tpl('#f4ede6', 'rgba(250, 244, 237, 0.88)', 'rgba(242, 233, 225, 0.9)', 'rgba(234, 222, 211, 0.92)', '#575279', '#797593', '#9893a5', '#b4637a', 'rgba(240, 230, 222, 0.92)') },
  { id: 'mist', label: 'Туман', group: 'light',
    card: { bg: '#e8edf2', surface: '#f3f6fa', text: '#33415c', accent: '#3b82f6' },
    template: tpl('#e8edf2', 'rgba(243, 246, 250, 0.88)', 'rgba(228, 234, 242, 0.9)', 'rgba(212, 221, 233, 0.92)', '#33415c', '#5c6b8a', '#94a3b8', '#3b82f6', 'rgba(222, 230, 240, 0.92)') },
  { id: 'mint', label: 'Мята', group: 'light',
    card: { bg: '#e4f0e8', surface: '#f2f9f4', text: '#2d4a38', accent: '#2f9e6e' },
    template: tpl('#e4f0e8', 'rgba(242, 249, 244, 0.88)', 'rgba(226, 241, 231, 0.9)', 'rgba(209, 233, 217, 0.92)', '#2d4a38', '#52705e', '#8aa596', '#2f9e6e', 'rgba(218, 238, 226, 0.92)') },
  { id: 'sakura', label: 'Сакура', group: 'light',
    card: { bg: '#f7e9ee', surface: '#fdf4f7', text: '#6b3a4d', accent: '#d65c8a' },
    template: tpl('#f7e9ee', 'rgba(253, 244, 247, 0.88)', 'rgba(248, 228, 236, 0.9)', 'rgba(241, 213, 225, 0.92)', '#6b3a4d', '#96617a', '#c09aa9', '#d65c8a', 'rgba(246, 222, 232, 0.92)') },
]

export const BUILTIN_THEME_IDS: string[] = BUILTIN_THEMES.map(t => t.id)

export function isBuiltinTheme(id: string): boolean {
  return BUILTIN_THEME_IDS.includes(id)
}

export function getBuiltinTheme(id: string): BuiltinTheme | undefined {
  return BUILTIN_THEMES.find(t => t.id === id)
}
