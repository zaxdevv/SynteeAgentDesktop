/**
 * Темы от плагинов (registerTheme).
 *
 * Плагин отдаёт набор CSS-переменных ({ '--body-bg': ..., '--accent': ... })
 * + флаг dark/light. Выбор темы хранится в electron-store под ключом 'theme'
 * значением `plugin:{pluginId}:{name}`.
 *
 * Применение:
 *  1. ui.store.theme → базовый билтин 'dark'/'light' (data-theme на корне,
 *     от него наследуется весь набор переменных globals.css).
 *  2. переменные плагина пишутся inline-стилями на <html> — они перекрывают
 *     базовые значения для заданных ключей, остальное остаётся от базы.
 *  3. ui.store.pluginTheme хранит активный ключ — чтобы авто-очистка при
 *     смене темы не затирала плагинные переменные, пока тема плагина активна.
 */
import { useUIStore } from '../store/ui.store'
import { collectPluginThemes } from './pluginExtApi'

const THEME_PREFIX = 'plugin:'

/** Является ли значение ключа настройки темой плагина. */
export function isPluginThemeKey(v: string | null | undefined): v is string {
  return !!v && v.startsWith(THEME_PREFIX)
}

/** Разобрать ключ `plugin:{pluginId}:{name}` → { pluginId, name }. */
export function parsePluginThemeKey(key: string): { pluginId: string; name: string } | null {
  if (!isPluginThemeKey(key)) return null
  const rest = key.slice(THEME_PREFIX.length)
  const idx = rest.indexOf(':')
  if (idx <= 0) return null
  return { pluginId: rest.slice(0, idx), name: rest.slice(idx + 1) }
}

export function buildPluginThemeKey(pluginId: string, name: string): string {
  return `${THEME_PREFIX}${pluginId}:${name}`
}

/** Ключи переменных, применённые в последний раз (для аккуратного снятия). */
let appliedVarKeys: string[] = []

function removePluginVars() {
  const root = document.documentElement
  for (const k of appliedVarKeys) root.style.removeProperty(k)
  appliedVarKeys = []
}

/**
 * Применить тему плагина по ключу (или снять, если key === null).
 * Возвращает true, если key — существующая тема запущенного плагина и она
 * применена; false — плагин выключен/не найден (ключ надо игнорировать).
 */
export function applyPluginThemeToDOM(key: string | null): boolean {
  const st = useUIStore.getState()
  if (!key) {
    st.setPluginTheme(null)
    removePluginVars()
    return false
  }
  const theme = collectPluginThemes().find(t => t.key === key)
  if (!theme) {
    // Плагин не запущен / тема больше не зарегистрирована — снимаем.
    st.setPluginTheme(null)
    removePluginVars()
    return false
  }
  const root = document.documentElement
  removePluginVars()
  const colors = theme.colors ?? {}
  for (const [k, v] of Object.entries(colors)) {
    if (!k.startsWith('--')) continue
    const val = typeof v === 'string' ? v : String(v ?? '')
    if (!val) continue
    root.style.setProperty(k, val)
    appliedVarKeys.push(k)
  }
  // База для не заданных переменных: тёмная/светлая билтин-тема.
  const base = theme.dark ? 'dark' : 'light'
  st.setPluginTheme(key)
  st.setTheme(base as Parameters<typeof st.setTheme>[0])
  return true
}

/** Снять плагинную тему (вызывается при выборе встроенной/кастомной). */
export function clearPluginTheme() {
  applyPluginThemeToDOM(null)
}
