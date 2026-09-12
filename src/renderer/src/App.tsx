import { useEffect, useState, lazy, Suspense, type ComponentType } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useUIStore, isValidTab, type RightPanelTab } from './store/ui.store'
import { useRightPanelTabsStore } from './store/rightPanelTabs.store'
import { useSettingsStore } from './store/settings.store'
import { initExtensionsPushEvents, useExtensionsStore } from './store/extensions.store'
import { applyPluginThemeToDOM, isPluginThemeKey } from './utils/pluginTheme'
import { setUiSoundsFlag, setSoundVolume, setSoundAssignmentsFlag } from './utils/sounds'
import { useChatRunSubscription, initChatSend, enqueuePendingUserMsg } from './hooks/useChatRunSubscription'
import { useAuthStore } from './store/auth.store'
import { useNavStore } from './store/nav.store'
import {
  useGatewayModelsStore,
  startGatewayStatusPolling,
} from './store/gatewayModels.store'
import { useBillingStore } from './store/billing.store'
import { useChatStore } from './store/chat.store'
import { useTabsStore } from './store/tabs.store'
import { useFileTabsStore } from './store/fileTabs.store'
import { useMessengerStore } from './store/messenger.store'
import { autoAssignGatewayModels, markAutoAssignDone, isAutoAssignDone } from './store/autoAssign'
import { contrastText, withAlpha, hexToRgb, hslToHex } from './utils/colorUtils'
import { startThemeScheduler } from './utils/themeScheduler'
import type { CustomTheme, Chat as ChatType, Message } from '../../shared/types'
import ChatPage from './pages/Chat/ChatPage'
// ── Lazy loading страниц — каждая страница грузится отдельным chunk'ом
// только при открытии. Это убирает d3-force graph, Settings-компоненты,
// Messenger и Login из основного бандла → минус ~200-400MB RAM.
import './pages/Overlay/OverlayPage.css'
import './pages/Voice/VoicePage.css'
import './pages/Spotlight/SpotlightPage.css'
import './pages/Settings/SettingsPage.css'
import './pages/Memory/MemoryPage.css'
import './pages/Messenger/MessengerPage.css'
import './pages/Login/LoginScreen.css'
import './pages/Notifications/NotificationPage.css'
// ── Восстановление после пересборки out/ на лету ─────────────────
// Если приложение запущено, а out/renderer пересобрали (dev-watch или
// повторный build), старый бандл ссылается на чанки со старыми хэшами,
// которых уже нет на диске → lazy import падает с "Failed to fetch
// dynamically imported module". Лечение — полная перезагрузка окна:
// index.html подхватит свежий бандл. Флаг в sessionStorage защищает от
// бесконечного цикла, если чанк реально отсутствует в сборке.
const CHUNK_RELOAD_GUARD = '__chunk_reload_guard__'

function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /Failed to fetch dynamically imported module|Importing a module script failed/.test(msg)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy сам типизирован через ComponentType<any>
function lazyWithReload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
) {
  return lazy(() =>
    factory().catch((err) => {
      if (isStaleChunkError(err) && !sessionStorage.getItem(CHUNK_RELOAD_GUARD)) {
        sessionStorage.setItem(CHUNK_RELOAD_GUARD, '1')
        window.location.reload()
      }
      throw err
    })
  )
}

const OverlayPage = lazyWithReload(() => import('./pages/Overlay/OverlayPage'))
const VoicePage = lazyWithReload(() => import('./pages/Voice/VoicePage'))
const SpotlightPage = lazyWithReload(() => import('./pages/Spotlight/SpotlightPage'))
const SettingsPage = lazyWithReload(() => import('./pages/Settings/SettingsPage'))
const MemoryPage = lazyWithReload(() => import('./pages/Memory/MemoryPage'))
const MessengerPage = lazyWithReload(() => import('./pages/Messenger/MessengerPage'))
const LoginScreen = lazyWithReload(() => import('./pages/Login/LoginScreen'))
// NotificationPage — НЕ lazy: import напрямую, чтобы overlay-окно не
// показывало Suspense fallback (BootScreen) при первом уведомлении.
import NotificationPage from './pages/Notifications/NotificationPage'
import BootScreen from './components/ui/BootScreen/BootScreen'
import './components/ui/BootScreen/BootScreen.css'
import TitleBar from './components/layout/TitleBar/TitleBar'
import ToastContainer from './components/ui/Toast/Toast'
import PluginPanel from './components/ui/PluginPanel/PluginPanel'
import PluginModalHost from './components/ui/PluginModalHost/PluginModalHost'
import PluginChatOverlayHost from './components/ui/PluginChatOverlayHost/PluginChatOverlayHost'
import PluginPageHost from './components/ui/PluginPageHost/PluginPageHost'
import PluginBottomHost from './components/ui/PluginBottomHost/PluginBottomHost'
import PluginStatusBar from './components/ui/PluginStatusBar/PluginStatusBar'
import AnimatedBackground, { invalidateAccentCache } from './components/ui/AnimatedBackground/AnimatedBackground'
import RightPanelHost from './components/ui/RightPanel/RightPanelHost'
import AgentConfirmDialog from './components/ui/AgentConfirmDialog/AgentConfirmDialog'
import QuestionPanel from './components/ui/QuestionPanel/QuestionPanel'
import BottomDock from './components/ui/BottomDock/BottomDock'
import './components/ui/RightPanel/RightPanel.css'
import UpdateAvailableModal from './components/ui/UpdateAvailableModal/UpdateAvailableModal'
import ForceUpdateModal from './components/ui/ForceUpdateModal/ForceUpdateModal'
import { useUpdateStore, selectForceUpdate } from './store/update.store'

type Route = 'chat' | 'overlay' | 'voice' | 'spotlight' | 'notifications'

function getRoute(): Route {
  const hash = window.location.hash.replace('#/', '')
  if (hash === 'overlay') return 'overlay'
  if (hash === 'voice') return 'voice'
  if (hash === 'spotlight') return 'spotlight'
  if (hash === 'notifications') return 'notifications'
  return 'chat'
}

// ── Шрифты ──────────────────────────────────────────────────────
// UI_FONTS — встроенные шрифты, подключённые локально в fonts.css.
// MONO_FONTS — моноширинные шрифты для кода/путей/ID.
// Кастомные шрифты добавляются динамически через injectCustomFonts().
export interface CustomFont { id: string; name: string }

const UI_FONTS: Record<string, string> = {
  'Inter': "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'Manrope': "'Manrope', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'Unbounded': "'Unbounded', 'Manrope', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'Space Grotesk': "'Space Grotesk', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'Onest': "'Onest', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'Sora': "'Sora', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'system': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}

const MONO_FONTS: Record<string, string> = {
  'JetBrains Mono': "'JetBrains Mono', 'SF Mono', 'Cascadia Code', 'Consolas', monospace",
  'Fira Code': "'Fira Code', 'JetBrains Mono', 'SF Mono', 'Consolas', monospace",
  'system mono': "'SF Mono', 'Cascadia Code', 'Consolas', 'Courier New', monospace",
}

// Динамический реестр кастомных шрифтов: name → font-family stack.
// Заполняется injectCustomFonts() при старте и при импорте нового шрифта.
const customFontStacks: Record<string, string> = {}

// Получает font-stack по ID шрифта. Ищет сначала в кастомных, потом во встроенных.
export function getFontStack(fontId: string, isMono = false): string | undefined {
  if (customFontStacks[fontId]) return customFontStacks[fontId]
  return (isMono ? MONO_FONTS : UI_FONTS)[fontId]
}

// Получить список всех доступных шрифтов (встроенные + кастомные).
export function getAllFonts(isMono = false): string[] {
  return [...Object.keys(isMono ? MONO_FONTS : UI_FONTS), ...Object.keys(customFontStacks)]
}

// Применяет выбранный UI-шрифт к CSS-переменной --font-family на :root.
export function applyFontToDOM(fontId: string) {
  const stack = getFontStack(fontId) ?? UI_FONTS['Inter']
  document.documentElement.style.setProperty('--font-family', stack)
}

// Применяет выбранный моноширинный шрифт к --font-mono.
export function applyMonoToDOM(fontId: string) {
  const stack = getFontStack(fontId, true) ?? MONO_FONTS['JetBrains Mono']
  document.documentElement.style.setProperty('--font-mono', stack)
}

// Инжектит @font-face для кастомных шрифтов через <style id="custom-fonts">.
// Вызывается при старте и при добавлении нового шрифта.
// customFonts — массив { id: "custom-fonts://file.woff2", name: "file.woff2" }.
export async function injectCustomFonts(customFonts: CustomFont[]): Promise<void> {
  let styleEl = document.getElementById('custom-fonts-style') as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'custom-fonts-style'
    document.head.appendChild(styleEl)
  }

  // Очищаем реестр и стиль
  styleEl.textContent = ''
  for (const k of Object.keys(customFontStacks)) delete customFontStacks[k]

  for (const cf of customFonts) {
    try {
      const dataUrl = await window.syntee.fonts.read(cf.id)
      if (!dataUrl) continue
      // Имя шрифта для CSS = имя файла без расширения
      const fontName = cf.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-')
      const css = `@font-face { font-family: '${fontName}'; font-style: normal; font-weight: 100 900; font-display: swap; src: url('${dataUrl}') format('woff2'); }`
      styleEl.textContent += css + '\n'
      // Регистрием в реестре: stack с fallback на Inter
      customFontStacks[fontName] = `'${fontName}', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
    } catch { /* skip broken font */ }
  }
}

// Применяет кастомный accent цвет поверх темы. Меняет --accent и
// связанные переменные (--accent-hover, --accent-subtle, --border,
// --border-strong, --overlay-4/5/6, --glass-bg). Если color пустой —
// сбрасывает к теме (удаляет inline overrides).
export function applyAccentToDOM(color?: string) {
  const root = document.documentElement
  if (!color) {
    root.style.removeProperty('--accent')
    root.style.removeProperty('--accent-hover')
    root.style.removeProperty('--accent-subtle')
    root.style.removeProperty('--accent-rgb')
    root.style.removeProperty('--on-accent')
    root.style.removeProperty('--on-accent-strong')
    root.style.removeProperty('--on-accent-muted')
    invalidateAccentCache()
    return
  }
  const hex = color.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  if (isNaN(r) || isNaN(g) || isNaN(b)) return
  root.style.setProperty('--accent', color)
  root.style.setProperty('--accent-hover', `rgba(${r}, ${g}, ${b}, 0.85)`)
  root.style.setProperty('--accent-subtle', `rgba(${r}, ${g}, ${b}, 0.1)`)
  root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`)
  const onAccent = contrastText(color)
  root.style.setProperty('--on-accent', onAccent === '#000' ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)')
  root.style.setProperty('--on-accent-strong', onAccent)
  root.style.setProperty('--on-accent-muted', onAccent === '#000' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)')
  invalidateAccentCache()
}

export function applyGlassToDOM(blur: number) {
  document.documentElement.style.setProperty('--glass-blur', `${blur}px`)
}

export function applyDensityToDOM(density: 'compact' | 'comfortable' | 'spacious') {
  document.documentElement.setAttribute('data-density', density)
}

// ── Размеры шрифта ─────────────────────────────────────────────
// UI: масштабирует все --font-size-* пропорционально базе (md=14).
// Чат: отдельная переменная --chat-font-size (MessageBubble .message-content).
const FONT_SIZE_BASE: Record<string, number> = { xs: 11, sm: 12, md: 14, lg: 16, xl: 20, '2xl': 28 }
export function applyFontSizeToDOM(uiSize: number, chatSize: number) {
  const root = document.documentElement
  const k = (uiSize || 14) / FONT_SIZE_BASE.md
  for (const [key, base] of Object.entries(FONT_SIZE_BASE)) {
    root.style.setProperty(`--font-size-${key}`, `${Math.round(base * k * 10) / 10}px`)
  }
  root.style.setProperty('--chat-font-size', `${chatSize || 14}px`)
}

export function applyGradientAccentToDOM(enabled: boolean, color2: string, angle: number, color1: string) {
  const root = document.documentElement
  if (!enabled) {
    root.style.removeProperty('--accent-gradient')
    root.style.setProperty('--accent-bg', 'var(--accent)')
    // Восстанавливаем --accent-hover из текущего --accent (solid).
    // applyAccentToDOM уже выставил rgba(r,g,b,0.85); при выключении
    // gradient вызываем его повторно чтобы вернуть корректный hover.
    const accent = root.style.getPropertyValue('--accent').trim()
    if (accent) {
      const hex = accent.replace('#', '')
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
        root.style.setProperty('--accent-hover', `rgba(${r}, ${g}, ${b}, 0.85)`)
      }
    }
    return
  }
  const grad = `linear-gradient(${angle}deg, ${color1}, ${color2})`
  root.style.setProperty('--accent-gradient', grad)
  root.style.setProperty('--accent-bg', grad)
  // Hover-состояния тоже должны использовать gradient — иначе кнопка при
  // наведении резко становится solid. 6 мест используют var(--accent-hover)
  // в background — все они получат gradient.
  root.style.setProperty('--accent-hover', grad)
}

export function applyCustomThemeToDOM(theme: CustomTheme | null) {
  const root = document.documentElement
  const styleEl = document.getElementById('custom-theme-vars') as HTMLStyleElement | null
  if (!theme) {
    if (styleEl) styleEl.remove()
    root.removeAttribute('data-custom-theme')
    invalidateAccentCache()
    return
  }
  const c = theme.colors
  const accent = c.accent
  const accentRgb = hexToRgb(accent)
  const onAccent = contrastText(accent)
  const overlayRgb = theme.base === 'light' ? '31, 35, 40' : '255, 255, 255'
  const shadowRgb = theme.base === 'light'
    ? `${hexToRgb(c.bodyBg)!.r}, ${hexToRgb(c.bodyBg)!.g}, ${hexToRgb(c.bodyBg)!.b}`
    : '0, 0, 0'
  const accentRgbStr = accentRgb ? `${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}` : '255, 255, 255'
  const glassBg = theme.base === 'light'
    ? withAlpha('#ffffff', 0.7 * (theme.glass.opacity / 100))
    : withAlpha(accent, 0.05 * (theme.glass.opacity / 100))
  // ── Опциональные поля с fallback на вычисление из accent ──
  const borderColor = c.border || withAlpha(accent, 0.12)
  const borderStrongColor = c.borderStrong || withAlpha(accent, 0.25)
  const accentBg = c.accentGradient
    ? `linear-gradient(135deg, ${accent}, ${c.accentGradient})`
    : accent
  const overlayMult = theme.effects?.overlayIntensity ?? 1
  let shadowRgbFinal = shadowRgb
  if (c.shadowColor) {
    const sc = hexToRgb(c.shadowColor)
    if (sc) shadowRgbFinal = `${sc.r}, ${sc.g}, ${sc.b}`
  }
  const css = `
[data-theme="custom"][data-custom-theme="${theme.id}"] {
  --body-bg: ${c.bodyBg};
  --bg-primary: ${c.bgPrimary};
  --bg-secondary: ${c.bgSecondary};
  --bg-tertiary: ${c.bgTertiary};
  --text-primary: ${c.textPrimary};
  --text-secondary: ${c.textSecondary};
  --text-muted: ${c.textMuted};
  --accent: ${accent};
  --accent-bg: ${accentBg};
  --accent-hover: ${withAlpha(accent, 0.85)};
  --accent-subtle: ${withAlpha(accent, 0.1)};
  --accent-rgb: ${accentRgbStr};
  --border: ${borderColor};
  --border-strong: ${borderStrongColor};
  --sidebar-bg: ${c.sidebarBg};
  --shadow: 0 8px 32px rgba(${shadowRgbFinal}, 0.5);
  --shadow-lg: 0 20px 60px rgba(${shadowRgbFinal}, 0.7);
  --overlay-1: rgba(${overlayRgb}, ${(0.02 * overlayMult).toFixed(3)});
  --overlay-2: rgba(${overlayRgb}, ${(0.04 * overlayMult).toFixed(3)});
  --overlay-3: rgba(${overlayRgb}, ${(0.06 * overlayMult).toFixed(3)});
  --overlay-4: rgba(${overlayRgb}, ${(0.08 * overlayMult).toFixed(3)});
  --overlay-5: rgba(${overlayRgb}, ${(0.12 * overlayMult).toFixed(3)});
  --overlay-6: rgba(${overlayRgb}, ${(0.16 * overlayMult).toFixed(3)});
  --on-accent: ${onAccent === '#000' ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)'};
  --on-accent-strong: ${onAccent};
  --on-accent-muted: ${onAccent === '#000' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)'};
  --glass-bg: ${glassBg};
  --glass-border: ${withAlpha(accent, 0.1)};
  --glass-blur: ${theme.glass.blur}px;
  --glass-saturate: ${theme.glass.saturate}%;
  --glass-highlight-1: ${theme.base === 'light' ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.06)'};
  --glass-highlight-2: ${withAlpha(accent, 0.03)};
  --shadow-rgb: ${shadowRgbFinal};
  --overlay-rgb: ${overlayRgb};
}`.trim()
  if (styleEl) {
    styleEl.textContent = css
  } else {
    const el = document.createElement('style')
    el.id = 'custom-theme-vars'
    el.textContent = css
    document.head.appendChild(el)
  }
  root.setAttribute('data-custom-theme', theme.id)
  invalidateAccentCache()
}

// ── Применение темы по id (встроенной или кастомной) ──────────
// Единая точка для системной синхронизации, «случайной темы» и
// восстановления после hover-превью. persist=false — только визуально
// (превью), без записи в electron-store.
export function applyThemeById(id: string, opts?: { persist?: boolean }) {
  const st = useUIStore.getState()
  const persist = opts?.persist !== false
  // Темы плагинов (registerTheme): id = 'plugin:{pluginId}:{name}'.
  if (isPluginThemeKey(id)) {
    const ok = applyPluginThemeToDOM(id)
    // Плагин выключен — fallback на дефолтную тёмную тему.
    if (!ok) {
      st.setTheme('dark')
      if (persist) window.syntee.settings.set('theme', 'dark')
    } else if (persist) {
      window.syntee.settings.set('theme', id)
    }
    return
  }
  const ct = st.customThemes.find(t => t.id === id)
  if (ct) {
    applyPluginThemeToDOM(null)
    st.setActiveCustomThemeId(ct.id)
    st.setTheme('custom')
    applyCustomThemeToDOM(ct)
    if (persist) {
      window.syntee.settings.set('activeCustomThemeId', ct.id)
      window.syntee.settings.set('theme', 'custom')
    }
  } else {
    applyPluginThemeToDOM(null)
    st.setTheme(id as Parameters<typeof st.setTheme>[0])
    applyCustomThemeToDOM(null)
    if (persist) window.syntee.settings.set('theme', id)
  }
}

// ── Bg image application ──────────────────────────────────────────────
// Раньше applyBgImageToDOM был async и вызывался одновременно из двух мест
// на старте (applyVisualSettings + useEffect по [bgImage]). Два async-вызова
// без блокировки соревновались за общий DOM: removeChild → два дубликата
// #bg-image-layer с одинаковым id, недетерминированный порядок вставки
// #bg-image-tint относительно AnimatedBackground canvas (оба z-index:0,
// paint идёт по DOM-порядку) → видимое затемнение «разное» при каждом
// перезапуске. Теперь — serial-очередь: вызовы исполняются строго подряд.
let applyBgChain: Promise<void> = Promise.resolve()
// Кэш dataURL картинок фона. Без него каждый тик слайдера блюра/тинта
// триггерил bgImage:load → readFileSync всей картинки + base64 в main-процессе.
// Ключ — src (bg-images://...). Инвалидируется событием bgImage:invalidated
// при save/delete/clear (см. подписку ниже).
const bgDataUrlCache = new Map<string, string>()
// Запоминаем последний применённый src, чтобы при смене только блюра/тинта/
// прозрачности/масштаба — обновлять style существующего узла вместо
// пересоздания (и перечитывания файла с диска).
let lastAppliedBgSrc: string | null = null

export function invalidateBgImageCache(src?: string) {
  if (src) bgDataUrlCache.delete(src)
  else bgDataUrlCache.clear()
}

export function applyBgImageToDOM(bgImage: {
  src: string; blur: number; opacity: number; tint: string; tintStrength: number;
  scale?: 'cover' | 'contain' | number; parallax?: boolean; parallaxStrength?: number;
} | null) {
  // Serial-очередь: каждый вызов ждёт завершения предыдущего, чтобы
  // два одновременных apply не делили DOM и не плодили дубликаты узлов.
  applyBgChain = applyBgChain.then(() => doApplyBgImageToDOM(bgImage)).catch(() => {})
  return applyBgChain
}

async function doApplyBgImageToDOM(bgImage: {
  src: string; blur: number; opacity: number; tint: string; tintStrength: number;
  scale?: 'cover' | 'contain' | number; parallax?: boolean; parallaxStrength?: number;
} | null) {
  // Overlay/Voice/Spotlight окна не показывают фон. У них ранний return
  // в App до .app-root и нет BootScreen.
  const hash = window.location.hash.replace('#/', '')
  if (hash === 'overlay' || hash === 'voice' || hash === 'spotlight') return

  const appRoot = document.querySelector('.app-root')
  // Пока BootScreen показан, .app-root ещё не смонтирован. Чтобы фон
  // появлялся мгновенно (ещё до загрузки UI, как раньше), рисуем на
  // document.body. Когда .app-root монтируется — переносим туда.
  const host: HTMLElement = (appRoot as HTMLElement) || document.body

  // Нет картинки / выключена — убираем слои (с любого из хостов).
  if (!bgImage || !bgImage.src) {
    document.getElementById('bg-image-layer')?.remove()
    document.getElementById('bg-image-tint')?.remove()
    lastAppliedBgSrc = null
    return
  }

  let url = bgImage.src
  if (bgImage.src.startsWith('bg-images://')) {
    let cached = bgDataUrlCache.get(bgImage.src)
    if (!cached) {
      cached = await window.syntee.bgImage.load(bgImage.src)
      if (!cached) return
      bgDataUrlCache.set(bgImage.src, cached)
    }
    url = cached
  }

  const bgSize = typeof bgImage.scale === 'number'
    ? `${bgImage.scale}%`
    : bgImage.scale === 'contain' ? 'contain' : 'cover'

  // ── CSS-only патч: если src не менялся И слой уже на правильном хосте —
  // обновляем только style. Это убирает лаг слайдеров блюра/тинта/прозрачности:
  // раньше каждый тик пересоздавал DOM-узел + перечитывал файл + GPU
  // ре-растеризовал filter:blur с нуля. Теперь — только свойство style.
  // Если же слой на другом хосте (перенос body→app-root после BootScreen) —
  // пересоздаём на новом хосте.
  const existing = document.getElementById('bg-image-layer') as HTMLDivElement | null
  if (existing && lastAppliedBgSrc === bgImage.src && existing.parentElement === host) {
    existing.style.backgroundSize = bgSize
    existing.style.filter = `blur(${bgImage.blur}px)`
    existing.style.opacity = `${bgImage.opacity / 100}`
  } else {
    // Смена src, первый показ, или перенос между хостами — пересоздание.
    document.getElementById('bg-image-layer')?.remove()
    document.getElementById('bg-image-tint')?.remove()
    const el = document.createElement('div')
    el.id = 'bg-image-layer'
    // z-index: 0 — фото, самый нижний слой. Все фоновые слои (layer, tint,
    // animated canvas) имеют z0, порядок покраски — по DOM (фиксирован
    // мьютексом). Контент — z1+ поверх. Раньше DOM-порядок был
    // недетерминированным из-за гонки двух async-вызовов → «разное затемнение»
    // при перезапуске.
    el.style.cssText = `
      position: absolute; inset: 0; z-index: 0; pointer-events: none;
      background-image: url(${url});
      background-size: ${bgSize}; background-position: center;
      background-repeat: no-repeat;
      filter: blur(${bgImage.blur}px);
      opacity: ${bgImage.opacity / 100};
    `
    const first = host.firstChild
    if (first) host.insertBefore(el, first)
    else host.appendChild(el)
    lastAppliedBgSrc = bgImage.src
  }

  // ── Tint (затемнение). Все фоновые слои — z-index: 0 (фото, tint, animated
  // canvas). Порядок покраски определяется DOM-порядком, который зафиксирован
  // мьютексом: layer (первый ребёнок) → tint (после layer) → AnimatedBackground
  // canvas (React-компонент дальше в JSX). Контент (.glass и его дети) — z1+,
  // поверх всех фонов. Раньше z-index был 0 у всех, но DOM-порядок был
  // недетерминированным из-за гонки двух async-вызовов → «разное затемнение».
  // Теперь гонки нет (мьютекс), так что можно оставить z0 у всех и положиться
  // на стабильный DOM-порядок.
  const tintEl = document.getElementById('bg-image-tint') as HTMLDivElement | null
  if (bgImage.tintStrength > 0) {
    const cssText = `
      position: absolute; inset: 0; z-index: 0; pointer-events: none;
      background: ${bgImage.tint || '#000000'};
      opacity: ${bgImage.tintStrength / 100};
    `
    if (tintEl && tintEl.parentElement === host) tintEl.style.cssText = cssText
    else {
      tintEl?.remove()
      const ov = document.createElement('div')
      ov.id = 'bg-image-tint'
      ov.style.cssText = cssText
      const layer = document.getElementById('bg-image-layer')
      if (layer && layer.nextSibling) host.insertBefore(ov, layer.nextSibling)
      else host.appendChild(ov)
    }
  } else {
    tintEl?.remove()
  }
}

let rainbowTimer: number | null = null
export function applyRainbowAccentToDOM(enabled: boolean) {
  if (rainbowTimer !== null) {
    clearInterval(rainbowTimer)
    rainbowTimer = null
  }
  if (!enabled) return
  let hue = 0
  // 250мс вместо 60мс: 60мс-таймер = ~17 обновлений CSS-переменных/сек —
  // постоянная фоновая нагрузка на renderer+GPU (заметно на слабом железе).
  // 4 обновления/сек визуально почти неотличимы (шаг hue 8° вместо 2°),
  // нагрузка падает в ~4 раза.
  rainbowTimer = window.setInterval(() => {
    hue = (hue + 8) % 360
    const c = hslToHex(hue, 75, 58)
    applyAccentToDOM(c)
  }, 250)
}

export default function App() {
  const [route, setRoute] = useState<Route>(getRoute())
  // authBoot: null — проверяем; 'login' — показать экран входа; 'app' — войдено/гость.
  const [authBoot, setAuthBoot] = useState<'login' | 'app' | null>(null)
  // Boot readiness gate: пока не готовы visual settings + auth + chats/projects,
  // показываем BootScreen вместо пустого экрана.
  const [settingsReady, setSettingsReady] = useState(false)
  const [dataReady, setDataReady] = useState(false)
  // modelsReady — модели gateway загружены (для залогиненных) ИЛИ не нужны
  // (гостевой режим). Boot ждёт это, чтобы ModelSelector сразу показал список.
  const [modelsReady, setModelsReady] = useState(false)
  // fontsReady — document.fonts.ready отрезолвился. Убирает мелькание шрифтов
  // (FOUT/FOIT) сразу после исчезновения BootScreen.
  const [fontsReady, setFontsReady] = useState(false)
  // uiPainted — основной UI (login/app-слой) успел сделать первый layout
  // (двойной rAF). BootScreen не запускает exit пока это false, иначе crossfade
  // покажет пустой/недоотрисованный контейнер вместо готового UI.
  const [uiPainted, setUiPainted] = useState(false)
  // minBootShown — минимум ~500мс показа BootScreen, чтобы он не мелькал
  // одним кадром при быстрых загрузках (SQLite IPC ~30-60мс).
  const [minBootShown, setMinBootShown] = useState(false)
  // bootRendered — ChatPage подтвердил первый рендер реального контента.
  // Гейтит исчезновение BootScreen в app-режиме: app-обёртка может отрисоваться
  // раньше, чем ChatPage внутри (virtualizer, sidebar) отрисует данные из store.
  const bootRendered = useChatStore(s => s.bootRendered)

  const mainPage = useNavStore(s => s.mainPage)
  const toggleMainPage = useNavStore(s => s.toggleMainPage)
  const openSettings = useNavStore(s => s.openSettings)
  // useShallow — подписка только на нужные поля.
  const theme = useUIStore(s => s.theme)

  const authUser = useAuthStore(s => s.user)
  const authLoad = useAuthStore(s => s.load)

  // Глобальная IPC-подписка на события чатов (токены, шаги, статусы).
  // Монтируется один раз — пишет в Zustand store по chatId, чтобы
  // параллельные чаты каждый имели свой LiveState.
  useChatRunSubscription()

  // ── Глобальный drag&drop файлов: preventDefault по всему окну ──
  // Без этого drop мимо инпут-бара заставляет Electron открыть файл как
  // страницу (окно «белый экран» до перезапуска). Файлы, брошенные не на
  // инпут, НЕ прикрепляются (только блокируем навигацию) — прикрепление
  // остаётся зоной инпут-бара.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  // Свежая сборка успешно загрузилась и смонтировалась — снимаем guard,
  // чтобы следующая пересборка на лету снова могла авто-перезагрузить окно.
  useEffect(() => {
    sessionStorage.removeItem(CHUNK_RELOAD_GUARD)
  }, [])

  // Загружаем визуальные настройки из electron-store при старте
  useEffect(() => {
    // Сначала грузим весь settings-store (одним IPC-вызовом getAll) —
    // нужно для ChatInput и других компонентов, которые читают настройки
    // через useSettingsStore (sttProvider, sttModelSize, groqApiKey и т.д.).
    // Без этого settings = {} → все селекторы возвращают undefined → fallback.
    useSettingsStore.getState().load().catch((e) => console.error('[settings] load failed:', e))
    const applyVisualSettings = async () => {
      try {
        const [theme, bgStyle, msgAnim, accentColor, animatedBg,
          avatarStyle, showTime, userMarkdown, uiSounds, sendEffect,
          fontFamily, fontMono, customFontsList, savedPanelWidth, savedPanelOpen, savedPanelTab,
          savedPanelExpanded,
          glassBlur, density, accentGradient, rainbowAccent, bgImage, bgImageEnabled,
          animatedBgOpacity, animatedBgSpeed, bgStyleParams,
          customThemes, activeCustomThemeId, themeSchedule, recentAccents,
          soundVolume, soundAssignments, mouseNavEnabled,
          favoriteThemes, fontSizeUI, fontSizeChat,
          systemThemeSync, systemSyncDark, systemSyncLight] = await Promise.all([
          window.syntee.settings.get('theme'),
          window.syntee.settings.get('bgStyle'),
          window.syntee.settings.get('msgAnim'),
          window.syntee.settings.get('accentColor'),
          window.syntee.settings.get('animatedBackground'),
          window.syntee.settings.get('avatarStyle'),
          window.syntee.settings.get('showTime'),
          window.syntee.settings.get('userMarkdown'),
          window.syntee.settings.get('uiSounds'),
          window.syntee.settings.get('sendEffect'),
          window.syntee.settings.get('fontFamily'),
          window.syntee.settings.get('fontMono'),
          window.syntee.fonts.list(),
          window.syntee.settings.get('agentPanelWidth'),
          window.syntee.settings.get('agentPanelOpen'),
          window.syntee.settings.get('agentPanelTab'),
          window.syntee.settings.get('agentPanelExpanded'),
          window.syntee.settings.get('glassBlur'),
          window.syntee.settings.get('density'),
          window.syntee.settings.get('accentGradient'),
          window.syntee.settings.get('rainbowAccent'),
          window.syntee.settings.get('bgImage'),
          window.syntee.settings.get('bgImageEnabled'),
          window.syntee.settings.get('animatedBgOpacity'),
          window.syntee.settings.get('animatedBgSpeed'),
          window.syntee.settings.get('bgStyleParams'),
          window.syntee.settings.get('customThemes'),
          window.syntee.settings.get('activeCustomThemeId'),
          window.syntee.settings.get('themeSchedule'),
          window.syntee.settings.get('recentAccents'),
          window.syntee.settings.get('soundVolume'),
          window.syntee.settings.get('soundAssignments'),
          window.syntee.settings.get('mouseNavEnabled'),
          window.syntee.settings.get('favoriteThemes'),
          window.syntee.settings.get('fontSizeUI'),
          window.syntee.settings.get('fontSizeChat'),
          window.syntee.settings.get('systemThemeSync'),
          window.syntee.settings.get('systemSyncDark'),
          window.syntee.settings.get('systemSyncLight'),
        ])
        const st = useUIStore.getState()
        // Тема плагина (plugin:{pluginId}:{name}) — ставим базу + переменные
        // плагина (если плагин уже загружен), иначе ждём плагины (эффект ниже).
        const storedTheme = (theme as string) || ''
        if (isPluginThemeKey(storedTheme)) {
          const ok = applyPluginThemeToDOM(storedTheme)
          if (!ok) st.setTheme('dark')
        } else if (storedTheme) {
          st.setTheme(theme as any)
        }
        if (bgStyle) st.setBgStyle(bgStyle as string)
        if (msgAnim) st.setMsgAnim(msgAnim as string)
        if (accentColor) st.setAccentColor(accentColor as string)
        if (animatedBg !== undefined && animatedBg !== null) st.setAnimatedBackground(animatedBg as boolean)
        if (avatarStyle) st.setAvatarStyle(avatarStyle as any)
        if (showTime) st.setShowTime(showTime as any)
        if (userMarkdown !== undefined && userMarkdown !== null) st.setUserMarkdown(userMarkdown as boolean)
        if (uiSounds !== undefined && uiSounds !== null) {
          st.setUiSounds(uiSounds as boolean)
          setUiSoundsFlag(uiSounds as boolean)
        }
        if (sendEffect !== undefined && sendEffect !== null) st.setSendEffect(sendEffect as boolean)
        if (typeof savedPanelWidth === 'number' && savedPanelWidth > 0) st.setAgentPanelWidth(savedPanelWidth)
        if (typeof savedPanelOpen === 'boolean') st.setAgentPanelOpen(savedPanelOpen)
        if (isValidTab(savedPanelTab)) st.setAgentPanelTab(savedPanelTab)
        if (typeof savedPanelExpanded === 'boolean') st.setAgentPanelExpanded(savedPanelExpanded)
        // Восстанавливаем открытые панели правой панели
        window.syntee.settings.get('rpOpenPanels').then((v: unknown) => {
          if (Array.isArray(v) && v.length > 0) {
            useRightPanelTabsStore.getState().restorePanels(v as RightPanelTab[])
          }
        }).catch(() => {})
        if (typeof glassBlur === 'number') st.setGlassBlur(glassBlur)
        if (density) st.setDensity(density as any)
        if (accentGradient) st.setAccentGradient(accentGradient as any)
        if (typeof rainbowAccent === 'boolean') st.setRainbowAccent(rainbowAccent)
        if (bgImage) st.setBgImage(bgImage as any)
        if (typeof bgImageEnabled === 'boolean') st.setBgImageEnabled(bgImageEnabled)
        if (typeof animatedBgOpacity === 'number') st.setAnimatedBgOpacity(animatedBgOpacity)
        if (typeof animatedBgSpeed === 'number') st.setAnimatedBgSpeed(animatedBgSpeed)
        if (bgStyleParams && typeof bgStyleParams === 'object') st.setBgStyleParams(bgStyleParams as any)
        if (Array.isArray(customThemes)) st.setCustomThemes(customThemes as any)
        if (activeCustomThemeId !== undefined) st.setActiveCustomThemeId(activeCustomThemeId as any)
        if (themeSchedule) st.setThemeSchedule(themeSchedule as any)
        if (Array.isArray(recentAccents)) st.setRecentAccents(recentAccents as string[])
        if (typeof soundVolume === 'number') { st.setSoundVolume(soundVolume); setSoundVolume(soundVolume) }
        if (soundAssignments && typeof soundAssignments === 'object') { st.setSoundAssignments(soundAssignments as any); setSoundAssignmentsFlag(soundAssignments as any) }
        // mouseNavEnabled: дефолт true (как в браузере) если ключа в store нет.
        // Запись в electron-store идёт через SettingsPage при toggle.
        st.setMouseNavEnabled(typeof mouseNavEnabled === 'boolean' ? mouseNavEnabled : true)
        if (Array.isArray(favoriteThemes)) st.setFavoriteThemes(favoriteThemes as string[])
        if (typeof fontSizeUI === 'number') st.setFontSizeUI(fontSizeUI)
        if (typeof fontSizeChat === 'number') st.setFontSizeChat(fontSizeChat)
        if (typeof systemThemeSync === 'boolean') st.setSystemThemeSync(systemThemeSync)
        if (typeof systemSyncDark === 'string') st.setSystemSyncDark(systemSyncDark)
        if (typeof systemSyncLight === 'string') st.setSystemSyncLight(systemSyncLight)

        // Инжектим кастомные шрифты (если есть) ДО применения fontFamily,
        // чтобы applyFontToDOM нашёл шрифт в customFontStacks.
        if (Array.isArray(customFontsList) && customFontsList.length > 0) {
          await injectCustomFonts(customFontsList)
        }
        if (fontFamily) applyFontToDOM(fontFamily as string)
        if (fontMono) applyMonoToDOM(fontMono as string)
        applyFontSizeToDOM(
          typeof fontSizeUI === 'number' ? fontSizeUI : 14,
          typeof fontSizeChat === 'number' ? fontSizeChat : 14,
        )

        const currentTheme = useUIStore.getState().theme
        const themes = useUIStore.getState().customThemes
        const activeId = useUIStore.getState().activeCustomThemeId
        if (currentTheme === 'custom' && activeId) {
          const ct = themes.find(t => t.id === activeId)
          if (ct) applyCustomThemeToDOM(ct)
        }
        if (!rainbowAccent && accentColor) applyAccentToDOM(accentColor as string)
        if (typeof glassBlur === 'number') applyGlassToDOM(glassBlur)
        if (density) applyDensityToDOM(density as any)
        if (accentGradient) {
          const ag = accentGradient as any
          applyGradientAccentToDOM(ag.enabled, ag.color2, ag.angle, (accentColor as string) || '#ffffff')
        }
        // Применяем bgImage в DOM и здесь, и в useEffect-подписке ниже.
        // Мьютекс (applyBgChain) гарантирует что два вызова исполнятся строго
        // последовательно — без гонки за DOM, которая раньше давала «разное
        // затемнение» при перезапуске. Без этого ручного вызова картинка на
        // старте могла не появиться (useEffect на mount ловил bgImage=null,
        // пока IPC ещё грузился, и повторный запуск не всегда срабатывал).
        if (bgImage) applyBgImageToDOM(bgImageEnabled === false ? null : bgImage as any)
        if (rainbowAccent) applyRainbowAccentToDOM(true)
      } catch { /* ok */ }
      finally {
        // Сигнал boot-gate'у: визуальные настройки применены, можно показывать UI.
        setSettingsReady(true)
      }
    }
    applyVisualSettings()
  }, [])

  // Ждём готовности веб-шрифтов, чтобы после исчезновения BootScreen не было
  // мелькания (FOUT/FOIT) при подмене fallback-шрифтов на целевые.
  useEffect(() => {
    if (!('fonts' in document)) { setFontsReady(true); return }
    let cancelled = false
    document.fonts.ready.then(() => { if (!cancelled) setFontsReady(true) })
    return () => { cancelled = true }
  }, [])

  // Min-display BootScreen: минимум 500мс показа, чтобы при быстрых загрузках
  // он не мелькал одним кадром (SQLite IPC ~30-60мс).
  useEffect(() => {
    const t = setTimeout(() => setMinBootShown(true), 500)
    return () => clearTimeout(t)
  }, [])

  // При ресайзе окна — ре-клампим ширину панели. Адаптивный MAX:
  // маленькие окна (< 900px) → 50%, средние (< 1200px) → 55%, большие → 60%.
  // RightPanel тоже слушает resize и анимирует widthMV — здесь только store.
  useEffect(() => {
    const onResize = () => {
      const st = useUIStore.getState()
      const current = st.agentPanelWidth
      const w = window.innerWidth
      const maxW = w < 900 ? Math.floor(w * 0.5)
        : w < 1200 ? Math.floor(w * 0.55)
        : Math.min(Math.floor(w * 0.6), 1600)
      if (current > maxW) {
        st.setAgentPanelWidth(maxW)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
// ── Keyboard shortcuts для правой панели ──────────────────────────────
  // Ctrl+B — toggle правой панели (только на странице чата, не в input/textarea)
  // Ctrl+1..6 НЕ перехватываем — они принадлежат ChatPage (режимы ask/planning).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return
      // Не перехватываем когда фокус в поле ввода
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // Только на странице чата
      if (useNavStore.getState().mainPage !== 'chat') return

      // Ctrl+B — toggle панели
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault()
        const next = !useUIStore.getState().agentPanelOpen
        useUIStore.getState().setAgentPanelOpen(next)
        window.syntee.settings.set('agentPanelOpen', next)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const onHash = () => setRoute(getRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Запрос на открытие раздела настроек из трей-меню / Spotlight (main шлёт
  // nav:open-settings в webContents главного окна после его show()).
  // Payload — опциональная секция ('voice' | 'memory' | 'general' | ...).
  useEffect(() => {
    const off = window.syntee.on('nav:open-settings', (section: unknown) => {
      const sec = String(section ?? '')
      useNavStore.getState().toggleMainPage('settings')
      if (sec) useNavStore.getState().openSettings(sec)
    })
    return () => { off() }
  }, [])

  // ── Spotlight relay-actions ──────────────────────────────────────────
  // Main-процесс получает spotlight:quickAsk / newChat / openChat от
  // Spotlight-окна, прячет его, показывает главное окно и шлёт nav:* событие
  // сюда. App.tsx — единое место, где слушаем (useChatRunSubscription уже
  // активен, так что live-стрим AI-ответа подхватится автоматически).

  // Быстрый запрос: payload { query, chatId }. Если chatId передан —
  // отправляем в существующий чат (без chat:create). Иначе — создаём новый.
  useEffect(() => {
    const off = window.syntee.on('nav:quick-ask', async (payload: unknown) => {
      // Совместимость со старым форматом (строка) и новым (объект).
      const p = (typeof payload === 'string' ? { query: payload, chatId: null } : (payload ?? {})) as { query?: string; chatId?: string | null }
      const text = String(p.query ?? '').trim()
      const targetId = p.chatId ? String(p.chatId) : null
      if (!text) return
      useNavStore.getState().toggleMainPage('chat')
      try {
        const st = useChatStore.getState()
        let chatId: string

        if (targetId) {
          // Отправить в существующий (текущий) чат.
          chatId = targetId
          // Убедимся что он активен и вкладка открыта.
          st.setCurrentChat(chatId)
          useTabsStore.getState().openTab(chatId)
        } else {
          // Новый чат.
          const chat = await window.syntee.chat.create(false, 'code', undefined) as ChatType
          const all = await window.syntee.chat.getAll() as ChatType[]
          st.setChats(all)
          st.setCurrentChat(chat.id)
          st.setMessages([])
          useTabsStore.getState().openTab(chat.id)
          chatId = chat.id
        }

        const userMsgId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const userMsg: Message = {
          id: userMsgId, chatId, role: 'user',
          content: text, createdAt: Date.now(), isPinned: 0,
        }
        const result = await window.syntee.chat.send({
          chatId, content: text, userMsgId,
        }) as { queued?: boolean; assistantMsgId?: string }

        if (result.queued && result.assistantMsgId) {
          enqueuePendingUserMsg(result.assistantMsgId, userMsg)
        } else {
          st.addMessage(userMsg)
          initChatSend(chatId)
        }
      } catch (e) {
        console.error('[nav:quick-ask] failed', e)
      }
    })
    return () => { off() }
  }, [])

  // Новый пустой чат — просто переключаемся на страницу чата, ChatPage
  // автоматически покажет LRU-кеш или скелетон, а пользователь сам введёт текст.
  useEffect(() => {
    const off = window.syntee.on('nav:new-chat', () => {
      useNavStore.getState().toggleMainPage('chat')
    })
    return () => { off() }
  }, [])

  // Плагин просит проиграть звук приложения (sound.play): { soundId }.
  // playSoundById учитывает настройки звуков пользователя (uiSounds).
  useEffect(() => {
    const off = window.syntee.on('plugins:play-sound', (data: unknown) => {
      const soundId = String((data as { soundId?: string } | null)?.soundId ?? '')
      if (!soundId) return
      void import('./utils/sounds').then(m => { void m.playSoundById(soundId) })
    })
    return () => { off() }
  }, [])

  // Открыть существующий чат по id (из результатов поиска Spotlight).
  useEffect(() => {
    const off = window.syntee.on('nav:open-chat', (chatId: unknown) => {
      const id = String(chatId ?? '')
      if (!id) return
      useNavStore.getState().toggleMainPage('chat')
      const st = useChatStore.getState()
      st.setCurrentChat(id)
      useTabsStore.getState().openTab(id)
    })
    return () => { off() }
  }, [])

  // ── Зеркало currentChatId в main-процесс ──────────────────────────────
  // Spotlight (отдельное BrowserWindow) спрашивает chat:getActive чтобы
  // предложить "спросить в текущем чате". Подписываемся на currentChatId
  // в zustand и синхронизируем его в main через chat:setActive.
  // Заодно перезагружаем MCP/skills — mcp:getAll/skills:getAll сами
  // резолвят проект из chatId, поэтому не зависим от activeProjectId.
  const currentChatIdForMain = useChatStore(s => s.currentChatId)
  useEffect(() => {
    window.syntee.chat.setActive(currentChatIdForMain ?? null).catch(() => {})
    if (currentChatIdForMain) {
      // Даём main-процессу 300ms на обработку chat:setActive (детектор
      // стартует и подхватит .mcp.json), затем перезагружаем списки.
      const t = setTimeout(() => {
        useExtensionsStore.getState().loadMcpServers()
        useExtensionsStore.getState().loadSkills()
      }, 300)
      return () => clearTimeout(t)
    }
  }, [currentChatIdForMain])

  // ── Синхронизация workdir для файловых табов (Monaco editor) ──
  // При смене активного чата — обновляем workdir в fileTabsStore.
  // fileTabsStore.setWorkdir закрывает все файловые табы при смене workdir
  // (пути из другого проекта недействительны).
  useEffect(() => {
    if (!currentChatIdForMain) {
      useFileTabsStore.getState().setWorkdir(null)
      return
    }
    let cancelled = false
    window.syntee.fs.getWorkdir(currentChatIdForMain).then((wd: string | null) => {
      if (!cancelled && wd) useFileTabsStore.getState().setWorkdir(wd)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [currentChatIdForMain])

  useEffect(() => {
    const st = useUIStore.getState()
    document.documentElement.setAttribute('data-theme', theme)
    if (theme === 'custom') {
      const ct = st.customThemes.find(t => t.id === st.activeCustomThemeId)
      if (ct) applyCustomThemeToDOM(ct)
    } else {
      applyCustomThemeToDOM(null)
    }
    // Если активна тема плагина — её переменные уже применены inline и их
    // трогать нельзя. Если нет — подчищаем возможные остатки.
    if (!st.pluginTheme) applyPluginThemeToDOM(null)
    // xterm не читает CSS-переменные — обновляем JS-тему после применения
    requestAnimationFrame(() => {
      import('./utils/terminalRegistry').then(m => m.applyTerminalThemeAll())
    })
  }, [theme])

  // ── Тема плагина: до-применение после загрузки списка плагинов ──
  // Старт: плагины грузятся асинхронно, а 'theme' уже может быть plugin:...
  // Как только список пришёл/изменился (вкл/выкл плагина) — сверяем и
  // применяем/снимаем тему плагина (fallback на dark, если плагин выключен).
  const pluginRuntimeList = useExtensionsStore(s => s.plugins)
  useEffect(() => {
    const st = useUIStore.getState()
    window.syntee.settings.get('theme')
      .then((saved: unknown) => {
        const key = typeof saved === 'string' ? saved : ''
        if (!isPluginThemeKey(key)) {
          if (st.pluginTheme) applyPluginThemeToDOM(null)
          return
        }
        if (st.pluginTheme === key) return
        const ok = applyPluginThemeToDOM(key)
        if (!ok) st.setTheme('dark')
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginRuntimeList])

  const glassBlur = useUIStore(s => s.glassBlur)
  useEffect(() => { applyGlassToDOM(glassBlur) }, [glassBlur])

  const density = useUIStore(s => s.density)
  useEffect(() => { applyDensityToDOM(density) }, [density])

  const accentGradient = useUIStore(s => s.accentGradient)
  const accentColor = useUIStore(s => s.accentColor)
  useEffect(() => {
    applyGradientAccentToDOM(accentGradient.enabled, accentGradient.color2, accentGradient.angle, accentColor)
    requestAnimationFrame(() => {
      import('./utils/terminalRegistry').then(m => m.applyTerminalThemeAll())
    })
  }, [accentGradient, accentColor])

  const bgImage = useUIStore(s => s.bgImage)
  const bgImageEnabled = useUIStore(s => s.bgImageEnabled)
  useEffect(() => { applyBgImageToDOM(bgImageEnabled ? bgImage : null) }, [bgImage, bgImageEnabled])

  const customThemes = useUIStore(s => s.customThemes)
  const activeCustomThemeId = useUIStore(s => s.activeCustomThemeId)
  useEffect(() => {
    if (useUIStore.getState().theme === 'custom' && activeCustomThemeId) {
      const ct = customThemes.find(t => t.id === activeCustomThemeId)
      if (ct) applyCustomThemeToDOM(ct)
    }
    requestAnimationFrame(() => {
      import('./utils/terminalRegistry').then(m => m.applyTerminalThemeAll())
    })
  }, [customThemes, activeCustomThemeId])

  const rainbowAccent = useUIStore(s => s.rainbowAccent)
  useEffect(() => {
    if (rainbowAccent) {
      applyRainbowAccentToDOM(true)
    } else {
      applyRainbowAccentToDOM(false)
      applyAccentToDOM(useUIStore.getState().accentColor)
    }
  }, [rainbowAccent])

  // ── Размеры шрифта (UI + чат) ──
  const fontSizeUI = useUIStore(s => s.fontSizeUI)
  const fontSizeChat = useUIStore(s => s.fontSizeChat)
  useEffect(() => { applyFontSizeToDOM(fontSizeUI, fontSizeChat) }, [fontSizeUI, fontSizeChat])

  // ── Синхронизация с системной темой Windows ──
  // Когда включена — следим за nativeTheme через IPC и применяем
  // выбранные юзером dark/light темы. Взаимоисключается с расписанием
  // на уровне UI (toggle одного выключает другое).
  const systemThemeSync = useUIStore(s => s.systemThemeSync)
  const systemSyncDark = useUIStore(s => s.systemSyncDark)
  const systemSyncLight = useUIStore(s => s.systemSyncLight)
  useEffect(() => {
    if (!systemThemeSync) return
    let cancelled = false
    const applyForSystem = (isDark: boolean) => {
      const st = useUIStore.getState()
      applyThemeById(isDark ? st.systemSyncDark : st.systemSyncLight)
    }
    window.syntee.systemTheme?.isDark()
      .then((d) => { if (!cancelled) applyForSystem(!!d) })
      .catch(() => {})
    const unsub = window.syntee.systemTheme?.onChange((d) => applyForSystem(d))
    return () => { cancelled = true; unsub?.() }
  }, [systemThemeSync, systemSyncDark, systemSyncLight])

  useEffect(() => {
    return startThemeScheduler(
      () => useUIStore.getState().themeSchedule,
      () => useUIStore.getState().customThemes,
      (theme, custom) => {
        const st = useUIStore.getState()
        if (custom) {
          applyPluginThemeToDOM(null)
          st.setCustomThemes(st.customThemes)
          st.setActiveCustomThemeId(custom.id)
          st.setTheme('custom')
          applyCustomThemeToDOM(custom)
          window.syntee.settings.set('activeCustomThemeId', custom.id)
          window.syntee.settings.set('theme', 'custom')
        } else {
          applyPluginThemeToDOM(null)
          st.setTheme(theme as any)
          applyCustomThemeToDOM(null)
          window.syntee.settings.set('theme', theme)
        }
      }
    )
  }, [])

  // Синхронизируем флаг звуков при изменении в store.
  // Селектор — без него useUIStore() подписывается на ВЕСЬ store,
  // и App ре-рендерится при любом изменении (agentPanelOpen, agentPanelWidth и т.д.)
  const uiSounds = useUIStore(s => s.uiSounds)
  useEffect(() => { setUiSoundsFlag(uiSounds) }, [uiSounds])

  // ── Навигация боковыми кнопками мыши (X1/X2) ────────────────────────────
  // X1 (button 3) — назад по истории nav.store, X2 (button 4) — вперёд.
  // suppressEvent обязателен: без него Electron на Windows может триггерить
  // системные navigation-события. Слушатель навешивается на window чтобы
  // ловить клики по любому элементу (сайдбар, контент). main-процесс
  // дополнительно гасит app-command (см. MainWindow.ts).
  // mouseNavEnabled читается через getState() при каждом клике — не нужно
  // перевешивать слушатель при toggle, и App не ре-рендерится на смену флага.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      // button 3 → X1 (back), button 4 → X2 (forward).
      if (e.button !== 3 && e.button !== 4) return
      // Всегда гасим дефолт, даже если feature выключена — чтобы X1/X2
      // не триггерили системные navigation-события.
      e.preventDefault()
      e.stopPropagation()
      if (!useUIStore.getState().mouseNavEnabled) return
      if (e.button === 3) useNavStore.getState().goBack()
      else useNavStore.getState().goForward()
    }
    // auxclick надёжнее для X1/X2 в Chrome/Electron — не конфликтует с
    // double-click. Но mouseup ловится раньше, поэтому вешаем оба и
    // гасим каждый: один сработает раньше, второй no-op из-за changed state.
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('auxclick', onMouseUp)
    return () => {
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('auxclick', onMouseUp)
    }
  }, [])

  // Громкость и назначения звуков синхронизируем с sounds.ts.
  const soundVolume = useUIStore(s => s.soundVolume)
  const soundAssignments = useUIStore(s => s.soundAssignments)
  useEffect(() => { setSoundVolume(soundVolume) }, [soundVolume])
  useEffect(() => { setSoundAssignmentsFlag(soundAssignments) }, [soundAssignments])

  // Звук запуска приложения — после применения визуальных настроек.
  useEffect(() => {
    if (settingsReady) {
      // Импортируем динамически чтобы избежать circular deps на этапе загрузки.
      import('./utils/sounds').then(({ playActionSound }) => playActionSound('appStart'))
    }
  }, [settingsReady])

  // Звук выхода — beforeunload. Может не успеть доиграть (рендерер
  // закрывается), но синтез-звук короткий и обычно успевает.
  useEffect(() => {
    const onBeforeUnload = () => {
      import('./utils/sounds').then(({ playAppExitSound }) => playAppExitSound())
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // Проверяем наличие сохранённой сессии при старте.
  // Логика (порядок важен — чтобы не выкидывать на экран входа того, кто
  // уже решил работать локально, и не дёргать gateway в гостевом режиме):
  //  1. loginSkipped=true → сразу 'app'. Юзер явно выбрал гостевой режим,
  //     gateway не трогаем, экран входа не показываем.
  //  2. Есть токены → тянем профиль (auth:me).
  //     a. Профиль есть → 'app' (залогинен).
  //     b. Профиля нет, но токены на месте → gateway/network лежат →
  //        грузимся в app (оффлайн-деградация как гость, без логина).
  //     c. Токены стёрты (GatewayAuthError → clearTokens в auth.ipc) →
  //        сессия реально протухла → 'login' (нужен перевход).
  //  3. Нет токенов и не гость → 'login' (первый запуск / явный logout).
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        // 1. Гостевой режим проверяем первым — он липкий и не требует сети.
        const skipped = await window.syntee.settings.get('loginSkipped')
        if (cancelled) return
        if (skipped === true) {
          setAuthBoot('app')
          return
        }

        // 2. Есть ли сохранённые токены?
        const isLoggedIn = await window.syntee.auth.isLoggedIn()
        if (cancelled) return
        if (isLoggedIn) {
          await authLoad()
          if (cancelled) return
          const user = useAuthStore.getState().user
          if (user) {
            setAuthBoot('app')
            return
          }
          // Профиля нет. Различаем: токены целы (сеть/gateway лежат) —
          // грузимся как гость без логина; токены стёрты — нужен перевход.
          const stillHasTokens = await window.syntee.auth.isLoggedIn()
          if (cancelled) return
          setAuthBoot(stillHasTokens ? 'app' : 'login')
        } else {
          // 3. Нет токенов и не гость — первый запуск или явный logout.
          setAuthBoot('login')
        }
      } catch {
        // Любой непредвиденный сбой — не валим пользователя на логин,
        // грузим приложение в деградированном (гостевом) режиме.
        if (!cancelled) setAuthBoot('app')
      }
    }
    check()
    // Фолбэк: если IPC завис, грузим app, а не экран входа —
    // зависший чек не должен отбрасывать юзера в логин.
    const fallback = setTimeout(() => {
      if (!cancelled) setAuthBoot(prev => prev ?? 'app')
    }, 5000)
    return () => { cancelled = true; clearTimeout(fallback) }
  }, [authLoad])

  // ── Предзагрузка критичных данных до показа основного UI ─────────────────
  // Срабатывает когда auth определился как 'app' (пользователь вошёл или гость).
  // Грузим chats + projects + первый чат (messages + queue) в store, чтобы
  // ChatPage при монтировании уже имел данные → нет флэша пустого состояния
  // и нет двойной загрузки. Это быстро (~30-60мс, SQLite IPC).
  // Gateway models + billing НЕ входят — они грузятся в фоне со скелетонами.
  useEffect(() => {
    if (authBoot !== 'app' || dataReady) return
    let cancelled = false
    const preload = async () => {
      try {
        const [chats, projects, savedTabs, savedActive, savedSplit] = await Promise.all([
          window.syntee.chat.getAll(),
          window.syntee.projects.getAll(),
          window.syntee.settings.get('openChatTabs').catch(() => null),
          window.syntee.settings.get('activeChatTab').catch(() => null),
          window.syntee.settings.get('splitChatTab').catch(() => null),
        ])
        if (cancelled) return
        const store = useChatStore.getState()
        store.setChats(chats)
        store.setProjects(projects)
        // ── Восстановление вкладок чатов (сессия как в браузере) ──
        // Только живые чаты; активная вкладка — сохранённая, если чат жив.
        // Порядок важен: setTabs ПОСЛЕ setChats, иначе prune-подписка
        // tabs.store увидит пустой chats и снесёт восстановленные вкладки.
        const chatIds = new Set(chats.map((c: { id: string }) => c.id))
        const tabs = (Array.isArray(savedTabs) ? savedTabs : [])
          .filter((id): id is string => typeof id === 'string' && chatIds.has(id))
        if (chats.length > 0) {
          const firstId = (typeof savedActive === 'string' && chatIds.has(savedActive))
            ? savedActive
            : chats[0].id
          if (!tabs.includes(firstId)) tabs.push(firstId)
          useTabsStore.getState().setTabs(tabs)
          // ── Восстановление сплита (второй чат 50/50) ──
          // Только если чат жив, не архив и ≠ активному (сплит на тот же чат
          // бессмысленен — подписка в tabs.store и так бы его закрыла).
          if (typeof savedSplit === 'string' && savedSplit !== firstId) {
            const splitAlive = chats.some(
              (c: { id: string; isArchived?: number }) => c.id === savedSplit && !c.isArchived
            )
            if (splitAlive) store.setSplitChat(savedSplit)
          }
          // Параллельно: последняя страница сообщений + queue для первого чата.
          // Пагинация: грузим хвост (50), остальное догружается тихим фоном
          // (useBackgroundLoadFullChat) или по скроллу для больших чатов.
          const [page, queue] = await Promise.all([
            window.syntee.chat.getMessagesPage(firstId, 50),
            window.syntee.chat.getQueue(firstId).catch(() => []),
          ])
          if (cancelled) return
          store.setCurrentChat(firstId)
          store.setMessagesWindow(firstId, (page as { messages: unknown[] }).messages as any, (page as { hasMore: boolean }).hasMore)
          store.setQueue(firstId, queue as any)
          store.markChatRead(firstId)

          // ── Восстановление файловых табов (Monaco editor) ──
          // Грузим сохранённые пути открытых файлов и workdir первого чата.
          // Восстановление идёт после setWorkdir — openFile использует workdir.
          const [savedFileTabs, fileWorkdir] = await Promise.all([
            window.syntee.settings.get('openFileTabs').catch(() => null),
            window.syntee.fs.getWorkdir(firstId).catch(() => null),
          ])
          if (cancelled) return
          if (typeof fileWorkdir === 'string' && fileWorkdir) {
            useFileTabsStore.getState().setWorkdir(fileWorkdir)
            if (Array.isArray(savedFileTabs) && savedFileTabs.length > 0) {
              // Восстанавливаем каждый файловый таб (загрузка контента идёт
              // внутри openFile через fs:readFile).
              for (const relPath of savedFileTabs) {
                if (typeof relPath === 'string' && relPath) {
                  await useFileTabsStore.getState().openFile(relPath, fileWorkdir)
                }
              }
              // Не активируем файловый таб при восстановлении —
              // пользователь видит чат, не редактор.
              useFileTabsStore.getState().setActiveFileTab(null)
            }
          }
        }
      } catch { /* non-fatal — ChatPage сделает retry при монтировании */ }
      finally {
        if (!cancelled) setDataReady(true)
      }
    }
    preload()
    return () => { cancelled = true }
  }, [authBoot, dataReady])

  // Подписка на logout из main-процесса (например, при истечении сессии)
  useEffect(() => {
    const off = window.syntee.auth.onLoggedOut(() => {
      useAuthStore.setState({ user: null })
      setAuthBoot('login')
    })
    return () => { off() }
  }, [])

  // ── In-app update checker ──────────────────────────────────────────────
  // Hydrate the update store on mount: fetches the current state from the
  // main process and subscribes to live pushes (so the badge / force modal
  // appear without polling from the renderer).
  const [updateModalOpen, setUpdateModalOpen] = useState(false)
  const forceUpdate = useUpdateStore(selectForceUpdate)
  useEffect(() => {
    useUpdateStore.getState().init()
  }, [])

  // Когда юзер появился (успешный вход через браузер) — переключаемся в app.
  // Сбрасываем loginSkipped — юзер явно вошёл, больше не гость.
  // Также сбрасываем bootRendered — ChatPage будет перемонтирован (с login-слоя
  // на app-слой), он снова должен подтвердить первый рендер, иначе BootScreen
  // уйдёт раньше, чем ChatPage отрисует данные вошедшего пользователя.
  useEffect(() => {
    if (authUser && authBoot !== 'app') {
      window.syntee.settings.set('loginSkipped', false)
      useChatStore.getState().setBootRendered(false)
      setAuthBoot('app')
    }
  }, [authUser, authBoot])

  // ── Syntee-Gateway: загрузка моделей + polling статусов ─────────────────
  // При появлении юзера тянем модели и запускаем polling раз в 60с.
  // При logout — store очистится автоматически (load() проверяет user).
  // Boot-gate ждёт modelsReady, чтобы ModelSelector сразу показал список.
  // 8с таймаут — если gateway недоступен, не блокируем boot вечно.
  const gatewayLoad = useGatewayModelsStore(s => s.load)
  const gatewayLastFetch = useGatewayModelsStore(s => s.lastFetchAt)
  useEffect(() => {
    if (authBoot !== 'app') return
    if (!authUser) {
      // Гостевой режим — модели gateway недоступны, не ждём.
      setModelsReady(true)
      return
    }
    let cancelled = false
    Promise.race([
      gatewayLoad(),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]).finally(() => {
      if (!cancelled) setModelsReady(true)
    })
    const stop = startGatewayStatusPolling()
    return () => { cancelled = true; stop() }
  }, [authBoot, authUser, gatewayLoad])

  // Авто-назначение ролей на модели gateway — один раз после первого fetch.
  useEffect(() => {
    if (authUser && gatewayLastFetch > 0 && !isAutoAssignDone()) {
      autoAssignGatewayModels().then((changed) => {
        if (changed) {
          // Перезагружаем чат-клиент чтобы новые назначения подхватились.
          window.syntee.chat.reloadClient().catch(() => {})
        }
        markAutoAssignDone()
      })
    }
  }, [authUser, gatewayLastFetch])

  // ── Биллинг: загрузка при входе + polling раз в 5 минут ──────────────────
  const billingLoad = useBillingStore(s => s.load)
  useEffect(() => {
    if (authUser) {
      billingLoad()
      const timer = setInterval(() => {
        if (document.hidden) return
        billingLoad(true)
      }, 300_000)
      return () => clearInterval(timer)
    }
  }, [authUser, billingLoad])

  // ── Мессенджер: WS-подключение при входе, отключение при выходе ──────────
  const messengerInit = useMessengerStore(s => s.init)
  const messengerDisconnect = useMessengerStore(s => s.disconnect)
  useEffect(() => {
    if (!authUser) return
    void messengerInit()
    return () => { void messengerDisconnect() }
  }, [authUser, messengerInit, messengerDisconnect])

  // Подписка на push-события MCP (статус подключения, обновление тулов).
  // Один раз за сессию — обновляет extensions.store в реальном времени.
  useEffect(() => {
    const cleanup = initExtensionsPushEvents()
    // Предзагрузка mcpServers при старте — иначе бейдж MCP не покажется,
    // пока пользователь не откроет ExtensionsPopover хотя бы раз.
    // warmupGlobalServers в main уже запустил подключение в фоне; здесь мы
    // подтягиваем актуальный список серверов (с runtime-статусом) в стор.
    useExtensionsStore.getState().loadMcpServers()
    // Предзагрузка skills — аналогично MCP, чтобы бейдж и список были
    // доступны сразу при старте, без необходимости открывать ExtensionsPopover.
    useExtensionsStore.getState().loadSkills()
    return cleanup
  }, [])

  // Оверлей, голос, spotlight — отдельные окна (lazy-loaded)
  const lazyFallback = <BootScreen status="Загрузка…" />
  if (route === 'overlay') return <Suspense fallback={lazyFallback}><OverlayPage /></Suspense>
  if (route === 'voice') return <Suspense fallback={lazyFallback}><VoicePage /></Suspense>
  if (route === 'spotlight') return <Suspense fallback={lazyFallback}><SpotlightPage /></Suspense>
  if (route === 'notifications') return <NotificationPage />

  // ── Boot gate: показываем BootScreen пока не готовы критичные данные ──────
  // settingsReady — visual settings (theme/accent/font) применены к DOM,
  //                 иначе UI мелькнёт с default темой.
  // authBoot === null — auth check ещё идёт (auth.me HTTP, до 2с).
  // authBoot === 'app' && !dataReady — chats/projects/messages предзагружаются.
  // authBoot === 'app' && !modelsReady — модели gateway грузятся (до 8с).
  // fontsReady — веб-шрифты загружены, не будет FOUT после исчезновения сплэша.
  // minBootShown — минимум 500мс показа BootScreen, чтобы он не мелькал.
  // uiPainted — основной UI сделал первый layout; BootScreen не уходит раньше.
  // Замечание: при браузер-логине authBoot меняется 'login'→'app', и в этот
  // момент dataReady/modelsReady ещё false → bootDone падает в false →
  // BootScreen сам повторно показывается (без отдельной postLoginLoading-логики).
  const dataBootDone = settingsReady
    && authBoot !== null
    && (authBoot !== 'app' || (dataReady && modelsReady))
  const bootDone = dataBootDone && fontsReady && minBootShown
  const bootStatus = !settingsReady
    ? 'Загрузка интерфейса…'
    : authBoot === null
      ? 'Проверка авторизации…'
      : !dataReady
        ? 'Загрузка чатов…'
        : !modelsReady
          ? 'Загрузка моделей…'
          : 'Готово'
  // BootScreen остаётся, пока не готовы данные ИЛИ UI ещё не отрисован.
  // uiPainted гейтит момент запуска exit-анимации — app-обёртка должна быть
  // отрисована, иначе crossfade покажет пустой контейнер.
  // bootRendered (только для app-режима) — ChatPage внутри app-слоя подтвердил
  // что отрисовал чаты/сообщения, а не пустой шелл. LoginScreen не выставляет
  // этот флаг, поэтому в login-режиме он не гейтит.
  const showBootScreen = !bootDone
    || !uiPainted
    || (authBoot === 'app' && !bootRendered)

  // Когда bootDone готов — даём UI-слою смонтироваться и зафиксировать первый
  // layout (двойной rAF), только тогда помечаем uiPainted=true — BootScreen
  // получает разрешение на exit. При повторном показе (браузер-логин) uiPainted
  // сбрасывается, снова ждём отрисовку.
  useEffect(() => {
    if (bootDone) {
      const raf2 = requestAnimationFrame(() => requestAnimationFrame(() => {
        setUiPainted(true)
      }))
      return () => cancelAnimationFrame(raf2)
    } else {
      setUiPainted(false)
    }
  }, [bootDone])

  // .app-root монтируется только когда bootDone=true (виден в JSX ниже).
  // applyBgImageToDOM ищет .app-root и если его нет — ничего не делает.
  // На старте applyVisualSettings зовёт applyBgImageToDOM ещё ДО того,
  // как bootDone стал true → .app-root нет → картинка не применяется.
  // После setSettingsReady → bootDone=true → .app-root монтируется, но
  // bgImage в Zustand уже установлен и не меняется → useEffect
  // [bgImage, bgImageEnabled] не ре-триггерится → картинка не появлялась
  // до ручного toggle в настройках. Этот эффект ре-применяет bg, когда
  // .app-root появляется.
  useEffect(() => {
    if (!bootDone) return
    const st = useUIStore.getState()
    if (st.bgImage) applyBgImageToDOM(st.bgImageEnabled ? st.bgImage : null)
  }, [bootDone])

  return (
    <AnimatePresence mode="sync">
      {showBootScreen && <BootScreen key="boot" status={bootStatus} />}
      {bootDone && authBoot === 'login' && (
        <motion.div
          key="login"
          className="app-boot-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        >
          <Suspense fallback={<BootScreen status="Загрузка…" />}>
          <LoginScreen
            onContinueAsGuest={() => {
              // Сохраняем флаг чтобы при следующем запуске не показывать
              // экран входа — юзер уже решил работать в гостевом режиме.
              window.syntee.settings.set('loginSkipped', true)
              setAuthBoot('app')
            }}
          />
          </Suspense>
        </motion.div>
      )}
      {bootDone && authBoot === 'app' && (
        <motion.div
          key="app"
          className="app-boot-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        >
          <div className="app-root">
            <AnimatedBackground />
            <TitleBar
              onSettingsClick={() => toggleMainPage('settings')}
              onAgentClick={() => {
                const next = !useUIStore.getState().agentPanelOpen
                useUIStore.getState().setAgentPanelOpen(next)
                window.syntee.settings.set('agentPanelOpen', next)
              }}
              onMemoryClick={() => toggleMainPage('memory')}
              onMessengerClick={() => toggleMainPage('messenger')}
              onProfileClick={() => openSettings('profile')}
              onUpdateClick={() => setUpdateModalOpen(true)}
            />
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative', zIndex: 1 }}>
              <div className="rp-chat-area">
                {/* ChatPage держится всегда смонтированным (keep-alive):
                    сайдбар/virtualizer не ре-инициализируются при переключении
                    вкладок → нет лага при возврате в чат. Скрываем через
                    visibility:hidden (сохраняет размеры для virtualizer). */}
                <div className={`page-host ${mainPage === 'chat' ? '' : 'page-host--hidden'}`}>
                  <ChatPage embedded />
                </div>
                <AnimatePresence>
              {mainPage === 'settings' && (
                <motion.div
                  key="settings-page"
                  className="page-motion-host"
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1, pointerEvents: 'auto' }}
                  exit={{ opacity: 0, scale: 1.05, pointerEvents: 'none' }}
                  transition={{ type: 'spring', stiffness: 340, damping: 30, opacity: { duration: 0.2 } }}
                >
                      <Suspense fallback={<BootScreen status="Загрузка…" />}>
                        <SettingsPage />
                      </Suspense>
                    </motion.div>
                  )}
                  {mainPage === 'memory' && (
                    <motion.div
                      key="memory-page"
                      className="page-motion-host"
                      initial={{ opacity: 0, scale: 0.92 }}
                      animate={{ opacity: 1, scale: 1, pointerEvents: 'auto' }}
                      exit={{ opacity: 0, scale: 1.05, pointerEvents: 'none' }}
                      transition={{ type: 'spring', stiffness: 340, damping: 30, opacity: { duration: 0.2 } }}
                    >
                      <Suspense fallback={<BootScreen status="Загрузка…" />}>
                        <MemoryPage />
                      </Suspense>
                    </motion.div>
                  )}
                  {mainPage === 'messenger' && (
                    <motion.div
                      key="messenger-page"
                      className="page-motion-host"
                      initial={{ opacity: 0, scale: 0.92 }}
                      animate={{ opacity: 1, scale: 1, pointerEvents: 'auto' }}
                      exit={{ opacity: 0, scale: 1.05, pointerEvents: 'none' }}
                      transition={{ type: 'spring', stiffness: 340, damping: 30, opacity: { duration: 0.2 } }}
                    >
                      <Suspense fallback={<BootScreen status="Загрузка…" />}>
                        <MessengerPage />
                      </Suspense>
                    </motion.div>
                  )}
                </AnimatePresence>
                {/* Полноэкранные страницы плагинов (slot 'page') — оверлей
                    поверх keep-alive ChatPage внутри зоны контента. */}
                <PluginPageHost />
              </div>
              <RightPanelHost />
            </div>
            <PluginBottomHost />
            <BottomDock />
            <PluginStatusBar />
            <ToastContainer />
            <PluginPanel />
            <PluginModalHost />
            <PluginChatOverlayHost />
            <AgentConfirmDialog />
            <QuestionPanel />
            <UpdateAvailableModal open={updateModalOpen} onClose={() => setUpdateModalOpen(false)} />
            <ForceUpdateModal open={forceUpdate !== null} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
