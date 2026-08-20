import { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { useSettingsStore } from '../../store/settings.store'
import { useUIStore, DEFAULT_THEME_SCHEDULE } from '../../store/ui.store'
import { useNavStore } from '../../store/nav.store'
import { useToast } from '../../components/ui/Toast/Toast'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import Toggle from '../../components/ui/Toggle/Toggle'
import ColorPicker from '../../components/ui/ColorPicker/ColorPicker'
import CustomThemeEditor from '../../components/settings/CustomThemeEditor/CustomThemeEditor'
import BgImageGallery from '../../components/settings/BgImageGallery/BgImageGallery'
import SoundsPanel from '../../components/settings/SoundsPanel/SoundsPanel'
import Popover from '../../components/ui/Popover/Popover'
import AISettingsTab from '../../components/settings/AISettingsTab/AISettingsTab'
import ContextSettingsTab from '../../components/settings/ContextSettingsTab/ContextSettingsTab'
import IndexingSettingsTab from '../../components/settings/IndexingSettingsTab/IndexingSettingsTab'
import ChangelogSettingsTab from '../../components/settings/ChangelogSettingsTab/ChangelogSettingsTab'
import ProfileSection from '../../components/settings/ProfileSection/ProfileSection'
import ModelStatusSection from '../../components/settings/ModelStatusSection/ModelStatusSection'
import ApprovalModeSelector from '../../components/ui/ApprovalModeSelector/ApprovalModeSelector'
import ResetButton from '../../components/ui/ResetButton/ResetButton'
import { MSG_ANIM_VARIANTS } from '../../components/ui/MessageBubble/MessageBubble'
import { playNavigateSound, setSoundVolume as setSoundVolumeModule, setSoundAssignmentsFlag } from '../../utils/sounds'
import { applyFontToDOM, applyMonoToDOM, injectCustomFonts, applyAccentToDOM, applyGlassToDOM, applyDensityToDOM, applyGradientAccentToDOM, applyCustomThemeToDOM, applyBgImageToDOM, applyRainbowAccentToDOM } from '../../App'
import type { CustomFont } from '../../App'
import { whileHoverWide, whileTapWide, whileHoverSm, whileTapSm, whileHoverTiny, whileTapTiny, springHover } from '../../utils/motionPresets'
import { DEFAULT_AGENT_SETTINGS, type AgentSettings as SharedAgentSettings, type CustomTheme } from '../../../../shared/types'
import { DEFAULT_HOTKEYS } from '../../../../shared/constants'
import './SettingsPage.css'

type Section =
  | 'profile' | 'general' | 'ai' | 'voice' | 'hotkeys' | 'modelStatus'
  | 'agent' | 'data' | 'appearance' | 'integrations' | 'context' | 'indexing'
  | 'changelog' | 'notifications'

interface SectionDef { id: Section; label: string; icon: IconName }
interface SectionGroup { title: string; items: SectionDef[] }

// Сайдбар сгруппирован по категориям — как в VS Code / Notion.
// Каждая группа получает uppercase-подзаголовок (см. .settings-nav-group-title).
const SECTION_GROUPS: SectionGroup[] = [
  {
    title: 'Аккаунт',
    items: [
      { id: 'profile', label: 'Профиль', icon: 'user' },
    ],
  },
  {
    title: 'Внешний вид',
    items: [
      { id: 'general',      label: 'Общие',       icon: 'settings' },
      { id: 'appearance',   label: 'Внешний вид', icon: 'palette' },
    ],
  },
  {
    title: 'ИИ и контекст',
    items: [
      { id: 'ai',         label: 'ИИ и Модели', icon: 'brain' },
      { id: 'modelStatus', label: 'Статус моделей', icon: 'server' },
      { id: 'context',    label: 'Контекст',    icon: 'layers' },
      { id: 'indexing',   label: 'Индексация',  icon: 'cpu' },
      { id: 'agent',      label: 'Агент',       icon: 'bot' },
    ],
  },
  {
    title: 'Управление',
    items: [
      { id: 'voice',   label: 'Голос',           icon: 'mic' },
      { id: 'hotkeys', label: 'Горячие клавиши', icon: 'shield' },
      { id: 'notifications', label: 'Уведомления', icon: 'bell' },
    ],
  },
  {
    title: 'Система',
    items: [
      { id: 'integrations', label: 'Интеграции', icon: 'link' },
      { id: 'data',         label: 'Данные',     icon: 'database' },
      { id: 'changelog',    label: 'Обновления', icon: 'downloadCloud' },
    ],
  },
]

export default function SettingsPage() {
  const navSection = useNavStore(s => s.settingsSection)
  const setNavSection = useNavStore(s => s.setSettingsSection)
  const setMainPage = useNavStore(s => s.setMainPage)
  const [section, setSection] = useState<Section>(
    (navSection as Section) || 'general'
  )
  // Узкие селекторы: раньше useSettingsStore() и useUIStore() без селекторов
  // → ре-рендер SettingsPage на любое изменение любого поля. Теперь:
  // - settings — выбираем объект (нужен для передачи в секции)
  // - load/set — стабильные actions
  // - UI setters — стабильные actions через useShallow
  const settings = useSettingsStore(s => s.settings)
  const load = useSettingsStore(s => s.load)
  const set = useSettingsStore(s => s.set)
  const { setTheme, setAccentColor, setBgStyle, setMsgAnim,
    setAvatarStyle, setShowTime, setUserMarkdown, setUiSounds, setSendEffect,
    setGlassBlur, setDensity, setAccentGradient, setRainbowAccent, setBgImage,
    setBgImageEnabled, setAnimatedBgOpacity, setAnimatedBgSpeed, setBgStyleParams,
    setCustomThemes, setActiveCustomThemeId, setThemeSchedule, setRecentAccents,
    setSoundVolume, setSoundAssignments, setMouseNavEnabled } = useUIStore(useShallow(s => ({
    setTheme: s.setTheme, setAccentColor: s.setAccentColor, setBgStyle: s.setBgStyle,
    setMsgAnim: s.setMsgAnim, setAvatarStyle: s.setAvatarStyle, setShowTime: s.setShowTime,
    setUserMarkdown: s.setUserMarkdown, setUiSounds: s.setUiSounds, setSendEffect: s.setSendEffect,
    setGlassBlur: s.setGlassBlur, setDensity: s.setDensity, setAccentGradient: s.setAccentGradient,
    setRainbowAccent: s.setRainbowAccent, setBgImage: s.setBgImage,
    setBgImageEnabled: s.setBgImageEnabled, setAnimatedBgOpacity: s.setAnimatedBgOpacity,
    setAnimatedBgSpeed: s.setAnimatedBgSpeed, setBgStyleParams: s.setBgStyleParams,
    setCustomThemes: s.setCustomThemes, setActiveCustomThemeId: s.setActiveCustomThemeId,
    setThemeSchedule: s.setThemeSchedule, setRecentAccents: s.setRecentAccents,
    setSoundVolume: s.setSoundVolume, setSoundAssignments: s.setSoundAssignments,
    setMouseNavEnabled: s.setMouseNavEnabled,
  })))
  const { add: toast } = useToast()

  // Синхронизация: при изменении settingsSection извне (openSettings) — переключаемся.
  useEffect(() => {
    if (navSection && (navSection !== section)) {
      setSection(navSection as Section)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navSection])

  // Обратная синхронизация: локальный выбор юзера пишем в nav store.
  const handleSectionChange = (s: Section) => {
    if (s !== section) playNavigateSound()
    setSection(s)
    setNavSection(s)
  }

  useEffect(() => { load() }, [])

  const handleSet = useCallback(async (key: string, value: unknown) => {
    await set(key, value)
    if (key === 'theme') {
      setTheme(value as any)
      if (value === 'custom') {
        const ct = useUIStore.getState().customThemes.find(t => t.id === useUIStore.getState().activeCustomThemeId)
        if (ct) applyCustomThemeToDOM(ct)
      } else {
        applyCustomThemeToDOM(null)
      }
    }
    if (key === 'accentColor') {
      setAccentColor(value as string)
      if (!useUIStore.getState().rainbowAccent) applyAccentToDOM(value as string)
    }
    if (key === 'bgStyle') setBgStyle(value as string)
    if (key === 'msgAnim') setMsgAnim(value as string)
    if (key === 'avatarStyle') setAvatarStyle(value as any)
    if (key === 'showTime') setShowTime(value as any)
    if (key === 'userMarkdown') setUserMarkdown(value as boolean)
    if (key === 'uiSounds') setUiSounds(value as boolean)
    if (key === 'sendEffect') setSendEffect(value as boolean)
    if (key === 'glassBlur') { setGlassBlur(value as number); applyGlassToDOM(value as number) }
    if (key === 'density') { setDensity(value as any); applyDensityToDOM(value as any) }
    if (key === 'accentGradient') {
      setAccentGradient(value as any)
      const ag = value as any
      applyGradientAccentToDOM(ag.enabled, ag.color2, ag.angle, useUIStore.getState().accentColor)
    }
    if (key === 'rainbowAccent') {
      setRainbowAccent(value as boolean)
      if (value as boolean) {
        applyRainbowAccentToDOM(true)
      } else {
        applyRainbowAccentToDOM(false)
        applyAccentToDOM(useUIStore.getState().accentColor)
      }
    }
    if (key === 'bgImage') { setBgImage(value as any); applyBgImageToDOM(value as any) }
    if (key === 'bgImageEnabled') {
      setBgImageEnabled(value as boolean)
      const st = useUIStore.getState()
      applyBgImageToDOM(value ? st.bgImage : null)
    }
    if (key === 'animatedBgOpacity') setAnimatedBgOpacity(value as number)
    if (key === 'animatedBgSpeed') setAnimatedBgSpeed(value as number)
    if (key === 'bgStyleParams') setBgStyleParams(value as Record<string, number>)
    if (key === 'soundVolume') { setSoundVolume(value as number); setSoundVolumeModule(value as number) }
    if (key === 'soundAssignments') { setSoundAssignments(value as any); setSoundAssignmentsFlag(value as any) }
    if (key === 'mouseNavEnabled') setMouseNavEnabled(value as boolean)
    if (key === 'customThemes') {
      setCustomThemes(value as CustomTheme[])
      const activeId = useUIStore.getState().activeCustomThemeId
      if (useUIStore.getState().theme === 'custom' && activeId) {
        const ct = (value as CustomTheme[]).find(t => t.id === activeId)
        if (ct) applyCustomThemeToDOM(ct)
      }
    }
    if (key === 'activeCustomThemeId') {
      setActiveCustomThemeId(value as any)
      if (useUIStore.getState().theme === 'custom' && value) {
        const ct = useUIStore.getState().customThemes.find(t => t.id === value)
        if (ct) applyCustomThemeToDOM(ct)
      }
    }
    if (key === 'themeSchedule') setThemeSchedule(value as any)
    if (key === 'recentAccents') setRecentAccents(value as string[])
    if (key === 'fontFamily') applyFontToDOM(value as string)
    if (key === 'fontMono') applyMonoToDOM(value as string)
  }, [set, setTheme, setAccentColor, setBgStyle, setMsgAnim, setAvatarStyle, setShowTime,
    setUserMarkdown, setUiSounds, setSendEffect, setGlassBlur, setDensity, setAccentGradient,
    setRainbowAccent, setBgImage, setBgImageEnabled, setAnimatedBgOpacity, setAnimatedBgSpeed,
    setBgStyleParams,
    setCustomThemes, setActiveCustomThemeId, setThemeSchedule, setRecentAccents,
    setSoundVolume, setSoundAssignments, setMouseNavEnabled])

  return (
    <div className="settings-root">
      {/* Сайдбар разделов (сгруппированный) */}
      <motion.nav
        className="settings-nav glass"
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ type: 'spring', stiffness: 360, damping: 30 }}
      >
        <motion.button
          type="button"
          className="settings-back-btn"
          onClick={() => setMainPage('chat')}
          title="Назад к чату"
          whileHover={whileHoverWide}
          whileTap={whileTapWide}
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30, delay: 0.02 }}
        >
          <AppIcon name="chevronLeft" size="sm" />
          <span>Назад</span>
        </motion.button>
        <motion.div
          className="settings-nav-title"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.05 }}
        >Настройки</motion.div>
        {SECTION_GROUPS.map((group, gi) => (
          <motion.div
            key={group.title}
            className="settings-nav-group"
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30, delay: 0.06 + gi * 0.04 }}
          >
            <div className="settings-nav-group-title">{group.title}</div>
            {group.items.map((s, si) => (
              <motion.button
                key={s.id}
                className={`settings-nav-item no-drag ${section === s.id ? 'settings-nav-item--active' : ''}`}
                onClick={() => handleSectionChange(s.id)}
                whileTap={{ scale: 0.97 }}
                whileHover={{ x: 2 }}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30, delay: 0.08 + gi * 0.04 + si * 0.02 }}
              >
                {/* Скользящий активный индикатор: один motion.div с layoutId,
                    который "переезжает" между пунктами через shared layout-анимацию. */}
                {section === s.id && (
                  <motion.span
                    layoutId="settings-nav-active"
                    className="settings-nav-active-pill"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <AppIcon name={s.icon} size="sm" tone={section === s.id ? 'accent' : 'muted'} />
                <span className="settings-nav-item-label">{s.label}</span>
              </motion.button>
            ))}
          </motion.div>
        ))}
      </motion.nav>

      {/* Контент */}
      <div className="settings-content">
        <AnimatePresence mode="popLayout">
          <motion.div
            key={section}
            className="settings-section"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
          >
            {section === 'profile' && (
              <ProfileSection />
            )}
            {section === 'general' && (
              <GeneralSection settings={settings} onSet={handleSet} />
            )}
            {section === 'ai' && (
              <AISettingsTab />
            )}
            {section === 'modelStatus' && (
              <ModelStatusSection />
            )}
            {section === 'context' && (
              <ContextSettingsTab />
            )}
            {section === 'indexing' && (
              <IndexingSettingsTab />
            )}
            {section === 'appearance' && (
              <AppearanceSection settings={settings} onSet={handleSet} />
            )}
            {section === 'voice' && (
              <VoiceSection settings={settings} onSet={handleSet} />
            )}
            {section === 'hotkeys' && (
              <HotkeysSection settings={settings} onSet={handleSet} />
            )}
            {section === 'agent' && (
              <AgentSection settings={settings} onSet={handleSet} />
            )}
            {section === 'integrations' && (
              <IntegrationsSection settings={settings} onSet={handleSet} />
            )}
            {section === 'data' && (
              <DataSection settings={settings} onSet={handleSet} toast={toast} />
            )}
            {section === 'changelog' && (
              <ChangelogSettingsTab />
            )}
            {section === 'notifications' && (
              <NotificationsSection settings={settings} onSet={handleSet} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

// ===== Разделы =====

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="settings-section-title">{children}</h2>
}

function Field({ label, description, children, block }: {
  label: string; description?: string; children: React.ReactNode; block?: boolean
}) {
  return (
    <div className={`settings-field${block ? ' settings-field--block' : ''}`}>
      <div className="settings-field-label">
        <span>{label}</span>
        {description && <p className="settings-field-desc">{description}</p>}
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  )
}

const GeneralSection = memo(function GeneralSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  return (
    <>
      <SectionTitle>Общие</SectionTitle>
      <Field label="Имя пользователя" description="Syntee будет обращаться к вам по имени">
        <input
          className="settings-input"
          value={(settings['userName'] as string) || ''}
          onChange={e => onSet('userName', e.target.value)}
          placeholder="Введите имя..."
        />
      </Field>
      <Field label="Запуск с Windows">
        <Toggle value={!!settings['autostart']} onChange={v => onSet('autostart', v)} />
      </Field>
      <Field label="Язык интерфейса">
        <select className="settings-select" value={(settings['language'] as string) || 'ru'} onChange={e => onSet('language', e.target.value)}>
          <option value="ru">Русский</option>
          <option value="en">English</option>
        </select>
      </Field>
      <Field label="При закрытии окна">
        <select className="settings-select" value={(settings['closeAction'] as string) || 'tray'} onChange={e => onSet('closeAction', e.target.value)}>
          <option value="tray">Убрать в трей</option>
          <option value="quit">Выйти</option>
        </select>
      </Field>
      <Field label="Счётчик контекста" description="Кружок с заполнением контекста в поле ввода">
        <Toggle value={(settings['showContextRing'] as boolean) ?? true} onChange={v => onSet('showContextRing', v)} />
      </Field>
      <Field label="Миникарта сообщений" description="Точки навигации по сообщениям справа в чате">
        <Toggle value={(settings['chatMinimap'] as boolean) ?? true} onChange={v => onSet('chatMinimap', v)} />
      </Field>
      <Field label="Боковые кнопки мыши" description="X1 — назад, X2 — вперёд между разделами (как в браузере)">
        <Toggle value={(settings['mouseNavEnabled'] as boolean) ?? true} onChange={v => onSet('mouseNavEnabled', v)} />
      </Field>
    </>
  )
})

// Превью анимации — мини-демо при наведении
function AnimPreview({ animId, active, onClick }: { animId: string; active: boolean; onClick: () => void }) {
  const [key, setKey] = useState(0)
  const v = MSG_ANIM_VARIANTS[animId]

  return (
    <motion.button
      className={`anim-preview-btn ${active ? 'anim-preview-btn--active' : ''}`}
      onClick={onClick}
      onMouseEnter={() => setKey(k => k + 1)}
      title={v.desc}
      whileHover={whileHoverWide}
      whileTap={whileTapWide}
      transition={springHover}
    >
      <div className="anim-preview-canvas">
        <AnimatePresence mode="wait">
          <motion.div
            key={key}
            className="anim-preview-bubble anim-preview-bubble--ai"
            initial={v.initial}
            animate={v.animate}
            transition={v.transition}
          >
            Ассистент
          </motion.div>
        </AnimatePresence>
        <AnimatePresence mode="wait">
          <motion.div
            key={key + 1000}
            className="anim-preview-bubble anim-preview-bubble--user"
            initial={v.initial}
            animate={v.animate}
            transition={{ ...v.transition, delay: (v.transition as any).duration ? ((v.transition as any).duration as number) * 0.4 : 0.08 }}
          >
            Вы
          </motion.div>
        </AnimatePresence>
      </div>
      <span className="anim-preview-label">{v.label}</span>
      <span className="anim-preview-desc">{v.desc}</span>
    </motion.button>
  )
}


const BG_STYLES = [
  { id: 'particles',   label: 'Частицы',    icon: '✦', desc: 'Точки с линиями' },
  { id: 'matrix',      label: 'Матрица',    icon: '⌨', desc: 'Дождь символов' },
  { id: 'waves',       label: 'Волны',      icon: '〜', desc: 'Плавные волны' },
  { id: 'aurora',      label: 'Аврора',     icon: '◈', desc: 'Северное сияние' },
  { id: 'fireflies',   label: 'Светлячки',  icon: '✺', desc: 'Мерцающие огни' },
  { id: 'starfield',   label: 'Звёзды',     icon: '✧', desc: 'Звёздное поле с параллаксом' },
  { id: 'nebula',      label: 'Туманность', icon: '◉', desc: 'Облака космоса' },
  { id: 'topographic', label: 'Топо',       icon: '⌒', desc: 'Контурные линии' },
  { id: 'geometric',   label: 'Геометрия',  icon: '⬡', desc: 'Вращающиеся фигуры' },
  { id: 'none',        label: 'Выкл',       icon: '✕', desc: 'Без анимации' },
]
// 9 тем: 4 тёмных + 2 светлых + 3 цветных. Каждая — bg, surface, text,
// accent цвета для мини-превью интерфейса в selector.
const THEMES = [
  { id: 'dark',     label: 'Тёмная',     group: 'dark',  colors: { bg: '#0e0e12', surface: '#1c1c24', text: '#e8e8ec', accent: '#e8e8ec' } },
  { id: 'midnight', label: 'Полночь',    group: 'dark',  colors: { bg: '#060912', surface: '#0f1525', text: '#e0e8ff', accent: '#4d9fff' } },
  { id: 'forest',   label: 'Лес',        group: 'dark',  colors: { bg: '#070e09', surface: '#122014', text: '#d4f0d8', accent: '#4caf60' } },
  { id: 'slate',    label: 'Сталь',      group: 'dark',  colors: { bg: '#0a0d14', surface: '#1a1f2c', text: '#e2e8f0', accent: '#5b8def' } },
  { id: 'amber',    label: 'Янтарь',     group: 'dark',  colors: { bg: '#100a05', surface: '#26190e', text: '#f5e6d3', accent: '#ff9b3d' } },
  { id: 'rose',     label: 'Роза',       group: 'dark',  colors: { bg: '#120810', surface: '#2a1620', text: '#fce8ee', accent: '#ff6b9d' } },
  { id: 'crimson',  label: 'Багровый',   group: 'dark',  colors: { bg: '#100406', surface: '#281012', text: '#ffe8ea', accent: '#ff5a4d' } },
  { id: 'pitch',    label: 'Антрацит',   group: 'dark',  colors: { bg: '#000000', surface: '#141414', text: '#e0e0e0', accent: '#737373' } },
  { id: 'ocean',    label: 'Океан',      group: 'dark',  colors: { bg: '#020a0e', surface: '#0a1a22', text: '#d0f0f5', accent: '#22d3ee' } },
  { id: 'carbon',   label: 'Карбон',     group: 'dark',  colors: { bg: '#0c0c0c', surface: '#1c1c1c', text: '#e0e0e0', accent: '#a3a3a3' } },
  { id: 'light',    label: 'Светлая',    group: 'light', colors: { bg: '#f4f1ec', surface: '#f3efe8', text: '#2a2620', accent: '#4a3f2f' } },
  { id: 'paper',    label: 'Бумага',     group: 'light', colors: { bg: '#f6f8fa', surface: '#f0f3f6', text: '#1f2328', accent: '#0969da' } },
]

// Preset цвета для accent picker — меняет только --accent, не всю тему.
const ACCENT_PRESETS = [
  '#4d9fff', // blue
  '#4caf60', // green
  '#ff6b9d', // pink
  '#ff9b3d', // amber
  '#ff5a4d', // red
  '#a78bfa', // purple
  '#facc15', // yellow
  '#06b6d4', // cyan
]
// Встроенные шрифты, подключённые локально в styles/fonts.css.
// Manrope, Unbounded, Space Grotesk, Onest, Sora — variable fonts.
// Space Grotesk и Sora не имеют Cyrillic subset — кириллица идёт через
// fallback (Inter) в font-stack. Кастомные шрифты добавляются динамически.
const BUILTIN_UI_FONTS = ['Inter', 'Manrope', 'Unbounded', 'Space Grotesk', 'Onest', 'Sora', 'system']
const BUILTIN_MONO_FONTS = ['JetBrains Mono', 'Fira Code', 'system mono']
// Превью-текст для каждого шрифта в dropdown
const FONT_PREVIEW = 'Aa Бб 123'
const MONO_PREVIEW = 'fn x = 1'

// ── FontSettingsBlock ──────────────────────────────────────────
// UI для выбора шрифтов: UI-шрифт, код-шрифт, загрузка кастомных.
// Кастомные шрифты хранятся в userData/custom-fonts/ (через IPC),
// инжектируются в DOM через injectCustomFonts().
function FontSettingsBlock({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const { add: toast } = useToast()
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Загружаем список кастомных шрифтов при монтировании
  useEffect(() => {
    refreshCustomFonts()
  }, [])

  async function refreshCustomFonts() {
    try {
      const list = await window.syntee.fonts.list()
      setCustomFonts(list.map(f => ({ id: f.id, name: f.name })))
    } catch { /* ok */ }
  }

  // Все доступные UI-шрифты: встроенные + кастомные
  const allUiFonts = useMemo(() => {
    const custom = customFonts.map(cf => cf.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-'))
    return [...BUILTIN_UI_FONTS, ...custom]
  }, [customFonts])

  const allMonoFonts = BUILTIN_MONO_FONTS

  async function handleUploadClick() {
    fileInputRef.current?.click()
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // reset для повторного выбора того же файла

    // Проверяем расширение
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (!['woff2', 'woff', 'ttf', 'otf'].includes(ext)) {
      toast('Поддерживаются только .woff2, .woff, .ttf, .otf', 'error')
      return
    }

    setUploading(true)
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      const fontUrl = await window.syntee.fonts.import(buf, file.name)
      if (!fontUrl) {
        toast('Не удалось загрузить шрифт', 'error')
        return
      }
      // Обновляем список кастомных шрифтов
      await refreshCustomFonts()
      // Инжектим в DOM
      const updatedList = await window.syntee.fonts.list()
      await injectCustomFonts(updatedList.map(f => ({ id: f.id, name: f.name })))
      toast(`Шрифт «${file.name}» загружен`, 'success')
    } catch {
      toast('Ошибка загрузки шрифта', 'error')
    } finally {
      setUploading(false)
    }
  }

  async function handleDeleteCustomFont(fontName: string) {
    // Находим кастомный шрифт по имени
    const cf = customFonts.find(f => f.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-') === fontName)
    if (!cf) return
    try {
      await window.syntee.fonts.delete(cf.id)
      await refreshCustomFonts()
      const updatedList = await window.syntee.fonts.list()
      await injectCustomFonts(updatedList.map(f => ({ id: f.id, name: f.name })))
      // Если удалили активный шрифт — сбрасываем на Inter
      if ((settings['fontFamily'] as string) === fontName) {
        onSet('fontFamily', 'Inter')
      }
      toast('Шрифт удалён', 'success')
    } catch {
      toast('Не удалось удалить шрифт', 'error')
    }
  }

  const currentUiFont = (settings['fontFamily'] as string) || 'Inter'
  const currentMonoFont = (settings['fontMono'] as string) || 'JetBrains Mono'
  const isCustomFont = !BUILTIN_UI_FONTS.includes(currentUiFont)

  return (
    <>
      <Field label="Шрифт интерфейса" description="Основной шрифт приложения">
        <div className="font-picker-row">
          <select
            className="settings-select font-picker-select"
            value={currentUiFont}
            onChange={e => onSet('fontFamily', e.target.value)}
          >
            {allUiFonts.map(f => (
              <option key={f} value={f} style={{ fontFamily: f === 'system' ? undefined : `'${f}', sans-serif` }}>
                {f}
              </option>
            ))}
          </select>
          {isCustomFont && (
            <motion.button
              className="font-picker-delete"
              title="Удалить шрифт"
              onClick={() => handleDeleteCustomFont(currentUiFont)}
              whileHover={whileHoverTiny}
              whileTap={whileTapTiny}
              transition={springHover}
            >
              <AppIcon name="trash" size="sm" />
            </motion.button>
          )}
        </div>
      </Field>

      <Field label="Шрифт кода" description="Для блоков кода, путей, ID">
        <select
          className="settings-select"
          value={currentMonoFont}
          onChange={e => onSet('fontMono', e.target.value)}
        >
          {allMonoFonts.map(f => (
            <option key={f} value={f} style={{ fontFamily: `'${f}', monospace` }}>
              {f}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Свой шрифт" description="Загрузить .woff2, .woff, .ttf или .otf">
        <div className="font-upload-area">
          <input
            ref={fileInputRef}
            type="file"
            accept=".woff2,.woff,.ttf,.otf"
            style={{ display: 'none' }}
            onChange={handleFileSelected}
          />
          <motion.button
            className="font-upload-btn"
            onClick={handleUploadClick}
            disabled={uploading}
            whileTap={{ scale: 0.97 }}
          >
            <AppIcon name="upload" size="sm" />
            <span>{uploading ? 'Загрузка...' : 'Загрузить шрифт'}</span>
          </motion.button>
        </div>
      </Field>

      {customFonts.length > 0 && (
        <Field label="Загруженные шрифты" description={`${customFonts.length} шт.`} block>
          <div className="font-custom-list">
            {customFonts.map(cf => {
              const fontName = cf.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-')
              const isActive = currentUiFont === fontName
              return (
                <div key={cf.id} className={`font-custom-item${isActive ? ' font-custom-item--active' : ''}`}>
                  <span className="font-custom-name" style={{ fontFamily: `'${fontName}', sans-serif` }}>
                    {cf.name}
                  </span>
                  <div className="font-custom-actions">
                    {!isActive && (
                      <motion.button
                        className="font-custom-apply"
                        title="Сделать активным"
                        onClick={() => onSet('fontFamily', fontName)}
                        whileHover={whileHoverTiny}
                        whileTap={whileTapTiny}
                        transition={springHover}
                      >
                        <AppIcon name="check" size="sm" />
                      </motion.button>
                    )}
                    <motion.button
                      className="font-custom-delete"
                      title="Удалить"
                      onClick={() => handleDeleteCustomFont(fontName)}
                      whileHover={whileHoverTiny}
                      whileTap={whileTapTiny}
                      transition={springHover}
                    >
                      <AppIcon name="trash" size="sm" />
                    </motion.button>
                  </div>
                </div>
              )
            })}
          </div>
        </Field>
      )}
    </>
  )
}


const AppearanceSection = memo(function AppearanceSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const [accentPickerOpen, setAccentPickerOpen] = useState(false)
  const [accentPickerPos, setAccentPickerPos] = useState<{ top: number; left: number } | null>(null)
  const accentBtnRef = useRef<HTMLButtonElement>(null)
  // rAF-throttle для applyAccentToDOM — без него каждый pointermove
  // переписывает CSS-переменные на :root → полная пересчётка стилей 60+ раз/сек.
  const accentRafRef = useRef<number | null>(null)
  const [themeEditorOpen, setThemeEditorOpen] = useState(false)
  const customThemes = (settings['customThemes'] as CustomTheme[]) || []
  const activeCustomThemeId = settings['activeCustomThemeId'] as string | null
  const recentAccents = (settings['recentAccents'] as string[]) || []
  const rainbowAccent = settings['rainbowAccent'] as boolean
  const accentGradient = (settings['accentGradient'] as { enabled: boolean; color2: string; angle: number }) || { enabled: false, color2: '#a78bfa', angle: 135 }
  const themeSchedule = (settings['themeSchedule'] as any) || DEFAULT_THEME_SCHEDULE

  const commitAccent = useCallback((c: string) => {
    onSet('accentColor', c)
    const next = [c, ...recentAccents.filter(x => x !== c)].slice(0, 8)
    onSet('recentAccents', next)
  }, [onSet, recentAccents])

  const allThemes = useMemo(() => [
    ...THEMES,
    ...customThemes.map(t => ({
      id: t.id,
      label: t.name,
      group: t.base,
      colors: {
        bg: t.colors.bodyBg,
        surface: t.colors.bgSecondary,
        text: t.colors.textPrimary,
        accent: t.colors.accent,
      },
      isCustom: true,
    })),
  ], [customThemes])

  return (
    <>
      <SectionTitle>Внешний вид</SectionTitle>
      <Field label="Тема" description="Выберите цветовую палитру" block>
        <div className="settings-theme-cards">
          {allThemes.map(t => {
            const isActive = settings['theme'] === t.id || (t.id === activeCustomThemeId && settings['theme'] === 'custom')
            return (
              <motion.button
                key={t.id}
                type="button"
                className={`settings-theme-card${isActive ? ' settings-theme-card--active' : ''}`}
                onClick={() => onSet('theme', t.id === activeCustomThemeId ? 'custom' : t.id)}
                whileTap={{ scale: 0.96 }}
                whileHover={{ y: -2 }}
                transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                title={t.label}
              >
                <div
                  className="settings-theme-card__preview"
                  style={{ background: t.colors.bg, borderColor: t.colors.accent + '22' }}
                >
                  <div className="settings-theme-card__sidebar" style={{ background: t.colors.surface }} />
                  <div className="settings-theme-card__content">
                    <div className="settings-theme-card__bubble settings-theme-card__bubble--left" style={{ background: t.colors.surface, borderColor: t.colors.text + '18' }} />
                    <div className="settings-theme-card__bubble settings-theme-card__bubble--right" style={{ background: t.colors.accent }} />
                  </div>
                  <div className="settings-theme-card__dot" style={{ background: t.colors.accent, boxShadow: `0 0 8px ${t.colors.accent}66` }} />
                </div>
                <div className="settings-theme-card__label">{t.label}</div>
                {isActive && (
                  <motion.div
                    className="settings-theme-card__check"
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                    style={{ background: t.colors.accent }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </motion.div>
                )}
              </motion.button>
            )
          })}
          <motion.button
            type="button"
            className="settings-theme-card settings-theme-card--add"
            onClick={() => setThemeEditorOpen(v => !v)}
            whileTap={{ scale: 0.96 }}
            whileHover={{ y: -2 }}
            title="Создать кастомную тему"
          >
            <div className="settings-theme-card__preview settings-theme-card__preview--add">
              <span>+</span>
            </div>
            <div className="settings-theme-card__label">Создать</div>
          </motion.button>
        </div>
      </Field>

      <AnimatePresence>
        {themeEditorOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            style={{ overflow: 'hidden' }}
          >
            <CustomThemeEditor
              themes={customThemes}
              activeId={activeCustomThemeId}
              onChange={(themes, activeId) => {
                onSet('customThemes', themes)
                if (activeId !== undefined) onSet('activeCustomThemeId', activeId)
              }}
              onApply={(id) => {
                onSet('activeCustomThemeId', id)
                onSet('theme', 'custom')
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <Field label="Цвет акцента" description="Дополнительный акцент поверх темы">
        <div className="settings-accent-picker">
          {ACCENT_PRESETS.map(c => {
            const isActive = (settings['accentColor'] as string) === c && !rainbowAccent
            return (
              <motion.button
                key={c}
                type="button"
                className={`settings-accent-swatch${isActive ? ' settings-accent-swatch--active' : ''}`}
                style={{ background: c }}
                onClick={() => { commitAccent(c) }}
                whileTap={{ scale: 0.85 }}
                whileHover={{ scale: 1.15 }}
                transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                title={c}
                disabled={rainbowAccent}
              >
                {isActive && (
                  <motion.svg
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                    width="12" height="12" viewBox="0 0 24 24" fill="none"
                    stroke={c === '#facc15' ? '#000' : '#fff'}
                    strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12"/>
                  </motion.svg>
                )}
              </motion.button>
            )
          })}
          <motion.button
            type="button"
            className={`settings-accent-swatch settings-accent-swatch--custom${accentPickerOpen ? ' settings-accent-swatch--active' : ''}`}
            ref={accentBtnRef}
            onClick={() => {
              if (!accentPickerOpen && accentBtnRef.current) {
                const r = accentBtnRef.current.getBoundingClientRect()
                setAccentPickerPos({ top: r.bottom + 8, left: r.left })
              }
              setAccentPickerOpen(v => !v)
            }}
            whileTap={{ scale: 0.85 }}
            whileHover={{ scale: 1.15 }}
            title="Свой цвет"
            disabled={rainbowAccent}
            style={{ background: rainbowAccent ? 'conic-gradient(red, orange, yellow, green, blue, purple, red)' : (settings['accentColor'] as string) || '#fff' }}
          >
            <span className="settings-accent-swatch-plus">＋</span>
          </motion.button>
        </div>
      </Field>

      {createPortal(
        <AnimatePresence>
          {accentPickerOpen && !rainbowAccent && accentPickerPos && (
            <>
              <div className="settings-accent-popover-overlay" onClick={() => setAccentPickerOpen(false)} />
              <motion.div
                className="settings-accent-popover"
                style={{ top: accentPickerPos.top, left: accentPickerPos.left }}
                initial={{ opacity: 0, scale: 0.9, y: -8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -8 }}
                transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              >
                <ColorPicker
                  value={(settings['accentColor'] as string) || '#ffffff'}
                  onChange={(c) => {
                    useUIStore.getState().setAccentColor(c)
                    // rAF-throttle: applyAccentToDOM переписывает CSS-переменные
                    // на :root → полная пересчётка стилей. Без throttle лагает
                    // на каждый pointermove (десятки раз/сек). С throttle — не
                    // чаще одного раза за кадр (≤60fps).
                    if (accentRafRef.current) cancelAnimationFrame(accentRafRef.current)
                    accentRafRef.current = requestAnimationFrame(() => {
                      if (!useUIStore.getState().rainbowAccent) applyAccentToDOM(c)
                    })
                  }}
                  onCommit={(c) => {
                    if (accentRafRef.current) { cancelAnimationFrame(accentRafRef.current); accentRafRef.current = null }
                    commitAccent(c)
                  }}
                  recent={recentAccents}
                />
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body
      )}

      <Field label="Радужный акцент" description="Accent медленно циклит по всем цветам">
        <Toggle value={!!rainbowAccent} onChange={v => onSet('rainbowAccent', v)} />
      </Field>

      <Field label="Градиентный акцент" description="Accent как градиент из двух цветов">
        <Toggle value={!!accentGradient.enabled} onChange={v => onSet('accentGradient', { ...accentGradient, enabled: v })} disabled={rainbowAccent} />
      </Field>
      <AnimatePresence>
        {accentGradient.enabled && !rainbowAccent && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            style={{ overflow: 'hidden' }}
          >
            <Field label="Второй цвет градиента">
              <div className="settings-accent-picker">
                {ACCENT_PRESETS.map(c => (
                  <motion.button
                    key={c}
                    type="button"
                    className={`settings-accent-swatch${accentGradient.color2 === c ? ' settings-accent-swatch--active' : ''}`}
                    style={{ background: c }}
                    onClick={() => onSet('accentGradient', { ...accentGradient, color2: c })}
                    whileTap={{ scale: 0.85 }}
                    whileHover={{ scale: 1.15 }}
                  />
                ))}
              </div>
            </Field>
            <Field label="Угол градиента" description={`${accentGradient.angle}°`}>
              <input
                type="range" min={0} max={360} value={accentGradient.angle}
                onChange={e => onSet('accentGradient', { ...accentGradient, angle: Number(e.target.value) })}
                className="settings-slider"
              />
            </Field>
          </motion.div>
        )}
      </AnimatePresence>

      <FontSettingsBlock settings={settings} onSet={onSet} />

      <Field label="Плотность интерфейса" description="Компактный / Комфортный / Просторный">
        <div className="settings-theme-grid">
          {[
            { id: 'compact', label: 'Компактно' },
            { id: 'comfortable', label: 'Комфорт' },
            { id: 'spacious', label: 'Просторно' },
          ].map(d => (
            <motion.button
              key={d.id}
              className={`settings-theme-btn ${(settings['density'] || 'comfortable') === d.id ? 'settings-theme-btn--active' : ''}`}
              style={{ background: 'var(--bg-tertiary)', fontSize: 12 }}
              onClick={() => onSet('density', d.id)}
              whileTap={{ scale: 0.94 }}
            >{d.label}</motion.button>
          ))}
        </div>
      </Field>

      <Field label="Стекло (Glass blur)" description={`${settings['glassBlur'] ?? 20}px — размытие Liquid Glass`}>
        <input
          type="range" min={0} max={40} value={(settings['glassBlur'] as number) ?? 20}
          onChange={e => onSet('glassBlur', Number(e.target.value))}
          className="settings-slider"
        />
      </Field>

      <Field label="Стиль фона" description="Анимация на заднем плане" block>
        <div className="settings-bg-grid">
          {BG_STYLES.map(s => (
            <motion.button
              key={s.id}
              className={`settings-bg-btn ${(settings['bgStyle'] || 'particles') === s.id ? 'settings-bg-btn--active' : ''}`}
              onClick={() => { onSet('bgStyle', s.id); onSet('animatedBackground', s.id !== 'none') }}
              whileTap={{ scale: 0.94 }}
              title={s.desc}
            >
              <span className="settings-bg-icon">{s.icon}</span>
              <span className="settings-bg-label">{s.label}</span>
            </motion.button>
          ))}
        </div>
        <AnimatedBgGear settings={settings} onSet={onSet} />
      </Field>

      <Field label="Фоновое изображение" description="Картинка как фон (под анимацией). Несколько картинок, переключение, параметры." block>
        <BgImageGallery onSet={onSet} />
      </Field>

      <Field label="Анимация сообщений" description="Наведи на карточку чтобы увидеть превью" block>
        <div className="anim-preview-grid">
          {Object.entries(MSG_ANIM_VARIANTS).map(([id]) => (
            <AnimPreview
              key={id}
              animId={id}
              active={(settings['msgAnim'] || 'slide') === id}
              onClick={() => onSet('msgAnim', id)}
            />
          ))}
        </div>
      </Field>

      <Field label="Аватар ассистента" description="Иконка рядом с ответами">
        <div className="settings-theme-grid">
          {[
            { id: 'hex',    label: '⬡ Гекс'   },
            { id: 'circle', label: '● Круг'    },
            { id: 'letter', label: 'S Буква'   },
            { id: 'emoji',  label: '🤖 Эмодзи' },
            { id: 'none',   label: '✕ Нет'     },
          ].map(a => (
            <motion.button
              key={a.id}
              className={`settings-theme-btn ${(settings['avatarStyle'] || 'hex') === a.id ? 'settings-theme-btn--active' : ''}`}
              style={{ background: 'var(--bg-tertiary)', fontSize: 12 }}
              onClick={() => onSet('avatarStyle', a.id)}
              whileTap={{ scale: 0.94 }}
            >{a.label}</motion.button>
          ))}
        </div>
      </Field>

      <Field label="Время сообщений" description="Когда показывать время рядом с сообщением">
        <div className="settings-theme-grid">
          {[
            { id: 'always', label: 'Всегда'   },
            { id: 'hover',  label: 'При наведении' },
            { id: 'never',  label: 'Никогда'  },
          ].map(t => (
            <motion.button
              key={t.id}
              className={`settings-theme-btn ${(settings['showTime'] || 'hover') === t.id ? 'settings-theme-btn--active' : ''}`}
              style={{ background: 'var(--bg-tertiary)', fontSize: 12 }}
              onClick={() => onSet('showTime', t.id)}
              whileTap={{ scale: 0.94 }}
            >{t.label}</motion.button>
          ))}
        </div>
      </Field>

      <Field label="Markdown в своих сообщениях" description="Рендерить жирный, курсив, код в ваших сообщениях">
        <Toggle value={!!(settings['userMarkdown'])} onChange={v => onSet('userMarkdown', v)} />
      </Field>

      <SoundsPanel settings={settings} onSet={onSet} />

      <Field label="Эффект отправки" description="Ripple-вспышка на кнопке при отправке">
        <Toggle value={settings['sendEffect'] !== false} onChange={v => onSet('sendEffect', v)} />
      </Field>

      <Field label="Автосмена темы" description="День → светлая, ночь → тёмная">
        <Toggle value={!!themeSchedule.enabled} onChange={v => onSet('themeSchedule', { ...themeSchedule, enabled: v })} />
      </Field>
      <AnimatePresence>
        {themeSchedule.enabled && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            style={{ overflow: 'hidden' }}
          >
            <Field label="Дневная тема">
              <select className="settings-select" value={themeSchedule.dayTheme} onChange={e => onSet('themeSchedule', { ...themeSchedule, dayTheme: e.target.value })}>
                {THEMES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                {customThemes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Ночная тема">
              <select className="settings-select" value={themeSchedule.nightTheme} onChange={e => onSet('themeSchedule', { ...themeSchedule, nightTheme: e.target.value })}>
                {THEMES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                {customThemes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="День начинается в">
              <input type="time" className="settings-input" value={themeSchedule.dayTime} onChange={e => onSet('themeSchedule', { ...themeSchedule, dayTime: e.target.value })} />
            </Field>
            <Field label="Ночь начинается в">
              <input type="time" className="settings-input" value={themeSchedule.nightTime} onChange={e => onSet('themeSchedule', { ...themeSchedule, nightTime: e.target.value })} />
            </Field>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
})

const VoiceSection = memo(function VoiceSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const sttProvider = (settings['sttProvider'] as 'local' | 'groq') || 'local'
  const sttModelSize = (settings['sttModelSize'] as 'tiny' | 'base') || 'tiny'

  // ── Статус модели Whisper (скачана/скачивается/не скачана) ──
  const [modelStatus, setModelStatus] = useState<{ status: string; cached: boolean; displaySize: string } | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  // Запрос статуса при монтировании / смене размера модели.
  const refreshStatus = useCallback(() => {
    if (sttProvider !== 'local') return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).syntee
    api?.voice?.status?.(sttModelSize).then((s: { status: string; cached: boolean; displaySize: string }) => {
      setModelStatus(s)
    }).catch(() => {})
  }, [sttProvider, sttModelSize])

  useEffect(() => { refreshStatus() }, [refreshStatus])

  // Подписка на live-обновления статуса (при фоновом скачивании/преварме).
  useEffect(() => {
    if (sttProvider !== 'local') return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).syntee
    if (!api?.voice) return
    const unsubProgress = api.voice.onProgress?.((info: { stage: string; progress?: number; message?: string }) => {
      if (info.stage === 'loading-model') {
        setDownloading(true)
        setDownloadError(null)
        if (typeof info.progress === 'number') setDownloadProgress(info.progress)
        if (info.progress === 100) setDownloading(false)
      }
      // Сообщения об ошибках приходят без stage (type:'error' в voice.ipc.ts
      // пересылает { stage: undefined, message: "..." }). Раньше они
      // игнорировались — юзер видел «Ошибка загрузки» без деталей.
      if (info.message && !info.stage) {
        setDownloadError(info.message)
        setDownloading(false)
      }
    })
    const unsubStatus = api.voice.onStatus?.((info: { status: string; cached: boolean; displaySize: string }) => {
      setModelStatus(info)
      if (info.status === 'ready' || info.status === 'idle') {
        setDownloading(false)
        setDownloadError(null)
      }
    })
    return () => { unsubProgress?.(); unsubStatus?.() }
  }, [sttProvider])

  const handleDownload = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).syntee
    if (!api?.voice?.download) return
    setDownloading(true)
    setDownloadProgress(0)
    setDownloadError(null)
    try {
      const res = await api.voice.download(sttModelSize)
      if (res?.ok) {
        setDownloadProgress(100)
        refreshStatus()
      }
    } catch { /* ошибка пришла через progress */ }
    finally { setDownloading(false) }
  }, [sttModelSize, refreshStatus])

  const statusBadge = (() => {
    if (!modelStatus) return null
    const isReady = modelStatus.cached || modelStatus.status === 'ready'
    if (downloading) {
      return (
        <div className="voice-model-status voice-model-status--downloading">
          <span className="voice-model-spinner" />
          <span>Скачивание... {downloadProgress > 0 ? `${downloadProgress}%` : ''}</span>
        </div>
      )
    }
    if (isReady) {
      return (
        <div className="voice-model-status voice-model-status--ready">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <span>Скачана ({modelStatus.displaySize})</span>
        </div>
      )
    }
    if (modelStatus.status === 'error' || downloadError) {
      return (
        <div className="voice-model-status voice-model-status--error">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>Ошибка загрузки</span>
        </div>
      )
    }
    return (
      <div className="voice-model-status voice-model-status--idle">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>Не скачана{modelStatus.displaySize ? ` (${modelStatus.displaySize})` : ''}</span>
      </div>
    )
  })()

  return (
    <>
      <SectionTitle>Голос</SectionTitle>
      <Field label="Wake word" description="Слово для активации голосового режима">
        <input className="settings-input" value={(settings['wakeWord'] as string) || 'синти'} onChange={e => onSet('wakeWord', e.target.value)} />
      </Field>
      <Field label="Голос ассистента">
        <select className="settings-select" value={(settings['voiceId'] as string) || 'alloy'} onChange={e => onSet('voiceId', e.target.value)}>
          {['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </Field>

      <SectionTitle>Голосовой ввод в чате</SectionTitle>
      <Field label="Распознавание речи (STT)" description="Движок для кнопки микрофона в строке ввода">
        <select className="settings-select" value={sttProvider} onChange={e => onSet('sttProvider', e.target.value)}>
          <option value="local">Локальный Whisper (оффлайн, без лимитов)</option>
          <option value="groq">Groq Whisper API (нужен ключ)</option>
        </select>
      </Field>
      {sttProvider === 'local' && (
        <>
          <Field label="Размер модели Whisper" description="Меньше — быстрее и экономнее. tiny по умолчанию, base точнее на русском.">
            <select className="settings-select" value={sttModelSize} onChange={e => onSet('sttModelSize', e.target.value)}>
              <option value="tiny">tiny (~40MB, быстро — рекомендуется)</option>
              <option value="base">base (~140MB, точнее на русском)</option>
            </select>
          </Field>
          {/* Блок статуса модели + кнопка скачать */}
          <div className="voice-model-block">
            {statusBadge}
            {!downloading && !(modelStatus?.cached || modelStatus?.status === 'ready') && (
              <motion.button className="voice-model-download-btn" onClick={handleDownload} whileHover={whileHoverWide} whileTap={whileTapWide} transition={springHover}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Скачать модель
              </motion.button>
            )}
            {downloading && (
              <div className="voice-model-progress">
                <div className="voice-model-progress-bar" style={{ width: `${downloadProgress}%` }} />
              </div>
            )}
            {downloadError && (
              <div className="voice-model-error-text" title={downloadError}>
                {downloadError}
              </div>
            )}
          </div>
          <div className="settings-info-note">
            Модель кэшируется локально и скачивается один раз. После этого распознавание
            работает полностью оффлайн. Фоновая загрузка начинается автоматически при старте
            приложения — здесь можно скачать вручную или проверить статус.
          </div>
        </>
      )}
      {sttProvider === 'groq' && (
        <Field label="Groq API key" description="Ключ с console.groq.com/keys. Хранится локально, отправляется только на api.groq.com.">
          <input className="settings-input" type="password" value={(settings['groqApiKey'] as string) || ''} onChange={e => onSet('groqApiKey', e.target.value)} placeholder="gsk_..." />
        </Field>
      )}
      <div className="settings-info-note">
        Модели TTS (озвучивание ответов) задаются в разделе <strong>ИИ и Модели</strong> → Назначения ролей.
      </div>
    </>
  )
})

// Пер-стиль параметры анимированного фона. Каждый стиль имеет свои настройки.
const BG_STYLE_PARAMS: Record<string, {
  key: string; label: string; min: number; max: number; step: number; def: number; fmt?: (v: number) => string
}[]> = {
  particles: [
    { key: 'particles.density', label: 'Плотность', min: 15, max: 80, step: 1, def: 45 },
    { key: 'particles.lineOpacity', label: 'Линии', min: 0, max: 0.2, step: 0.01, def: 0.05, fmt: v => v.toFixed(2) },
  ],
  matrix: [
    { key: 'matrix.fallSpeed', label: 'Скорость', min: 1, max: 20, step: 1, def: 8 },
    { key: 'matrix.colWidth', label: 'Ширина', min: 8, max: 24, step: 1, def: 16 },
  ],
  starfield: [
    { key: 'starfield.count', label: 'Количество', min: 50, max: 300, step: 10, def: 140 },
    { key: 'starfield.parallax', label: 'Параллакс', min: 0, max: 1, step: 0.05, def: 0.6, fmt: v => v.toFixed(2) },
  ],
  fireflies: [
    { key: 'fireflies.count', label: 'Количество', min: 10, max: 60, step: 1, def: 30 },
    { key: 'fireflies.glowRadius', label: 'Свечение', min: 1, max: 5, step: 0.5, def: 2.5, fmt: v => v.toFixed(1) },
  ],
}

// Гирька параметров анимированного фона: пер-стиль + прозрачность + скорость.
function AnimatedBgGear({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const [open, setOpen] = useState(false)
  const gearRef = useRef<HTMLButtonElement>(null)
  const opacity = (settings['animatedBgOpacity'] as number) ?? 60
  const speed = (settings['animatedBgSpeed'] as number) ?? 1
  const bgStyle = (settings['bgStyle'] as string) || 'particles'
  const params = (settings['bgStyleParams'] as Record<string, number>) || {}
  const [localParams, setLocalParams] = useState<Record<string, number>>({})
  const pendingRef = useRef<Record<string, number>>({})
  const debounceRef = useRef<number | null>(null)

  const styleParams = BG_STYLE_PARAMS[bgStyle] || []
  const getParam = (key: string, def: number) => localParams[key] ?? params[key] ?? def

  const setParam = (key: string, value: number) => {
    pendingRef.current[key] = value
    setLocalParams(prev => ({ ...prev, [key]: value }))
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      onSet('bgStyleParams', { ...params, ...pendingRef.current })
      pendingRef.current = {}
      setLocalParams({})
    }, 300)
  }

  return (
    <div className="anim-bg-gear-wrap">
      <motion.button
        ref={gearRef}
        className={`anim-bg-gear${open ? ' anim-bg-gear--active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Параметры анимации"
        whileHover={whileHoverSm}
        whileTap={whileTapSm}
        transition={springHover}
      >
        <AppIcon name="settings" size="sm" />
        <span>Параметры анимации</span>
      </motion.button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={gearRef} side="auto" align="start">
        <div className="bg-gear-panel">
          <div className="bg-gear-title">Анимированный фон</div>
          {styleParams.map(p => (
            <label key={p.key} className="bg-gear-row">
              <span>{p.label}: {p.fmt ? p.fmt(getParam(p.key, p.def)) : getParam(p.key, p.def)}</span>
              <input type="range" min={p.min} max={p.max} step={p.step} value={getParam(p.key, p.def)}
                onChange={e => setParam(p.key, Number(e.target.value))}
                className="settings-slider" />
            </label>
          ))}
          <label className="bg-gear-row">
            <span>Прозрачность: {opacity}%</span>
            <input type="range" min={0} max={100} value={opacity}
              onChange={e => onSet('animatedBgOpacity', Number(e.target.value))}
              className="settings-slider" />
          </label>
          <label className="bg-gear-row">
            <span>Скорость: {speed.toFixed(1)}x</span>
            <input type="range" min={0.2} max={3} step={0.1} value={speed}
              onChange={e => onSet('animatedBgSpeed', Number(e.target.value))}
              className="settings-slider" />
          </label>
        </div>
      </Popover>
    </div>
  )
}

// Статические данные для секции хоткеев — вынесены за компонент,
// чтобы не пересоздаваться каждый рендер и не попадать в deps useMemo.
type HkGroup = { title: string; icon: IconName; items: { id: keyof typeof DEFAULT_HOTKEYS; label: string; desc: string; icon: string }[] }
const HK_GROUPS: HkGroup[] = [
  {
    title: 'Окна',
    icon: 'layers',
    items: [
      { id: 'mainWindow',    label: 'Открыть/скрыть окно',  desc: 'Показать или скрыть главное окно Syntee',          icon: '🪟' },
      { id: 'overlay',       label: 'Оверлей',              desc: 'Circle to Search — выделение области экрана',     icon: '🔍' },
      { id: 'spotlight',     label: 'Spotlight',            desc: 'Быстрая строка запроса в один клик',              icon: '⚡' },
    ],
  },
  {
    title: 'Действия',
    icon: 'bot',
    items: [
      { id: 'voice',         label: 'Голосовой режим',      desc: 'Открыть окно голосового ввода',                   icon: '🎤' },
      { id: 'quickQuestion', label: 'Быстрый вопрос',      desc: 'Задать вопрос без открытия главного окна',        icon: '💬' },
    ],
  },
  {
    title: 'В приложении',
    icon: 'messageSquare',
    items: [
      { id: 'chatAskMode',      label: 'Режим чтения',        desc: 'Read-only: ответы без правок кода. Ctrl+1 когда панель закрыта',  icon: '📖' },
      { id: 'chatPlanningMode', label: 'Режим планирования',  desc: 'Read-only research → ответ в <plan>. Ctrl+2 когда панель закрыта', icon: '📋' },
    ],
  },
]
const HK_ALL_IDS = HK_GROUPS.flatMap(g => g.items.map(i => i.id))

const HotkeysSection = memo(function HotkeysSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const hotkeys = (settings['hotkeys'] as Record<string, string>) || {}
  // Ref чтобы effect keydown/keyup не ре-подписывался при каждом изменении
  // settings (hotkeys меняется → новый ref → effect teardown+resubscribe).
  const hotkeysRef = useRef(hotkeys)
  hotkeysRef.current = hotkeys
  const [recording, setRecording] = useState<string | null>(null)
  const [pressed, setPressed] = useState<string>('')

  // Проверка конфликтов: одинаковые комбинации у разных хоткеев
  const conflictMap = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const id of HK_ALL_IDS) {
      const bind = hotkeys[id]
      if (!bind) continue
      if (!map[bind]) map[bind] = []
      map[bind].push(id)
    }
    // Оставить только конфликты (2+ хоткея с одинаковой комбинацией)
    const conflicts: Record<string, boolean> = {}
    for (const ids of Object.values(map)) {
      if (ids.length > 1) {
        for (const id of ids) conflicts[id] = true
      }
    }
    return conflicts
  }, [hotkeys])

  const formatKey = (e: KeyboardEvent): string => {
    const parts: string[] = []
    if (e.ctrlKey)  parts.push('Ctrl')
    if (e.altKey)   parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey)  parts.push('Meta')
    const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
    if (!['Control','Alt','Shift','Meta'].includes(e.key)) parts.push(key)
    return parts.join('+')
  }

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      const combo = formatKey(e)
      setPressed(combo)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault()
      const combo = formatKey(e)
        if (combo && !['Ctrl','Alt','Shift','Meta'].every(m => combo === m)) {
          onSet('hotkeys', { ...hotkeysRef.current, [recording]: combo })
          setRecording(null)
          setPressed('')
        }
      }
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
      return () => {
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('keyup', onKeyUp)
      }
    }, [recording, onSet])

  const renderBind = (bind: string) => {
    if (!bind) return <span className="hk-empty">Не задано</span>
    return bind.split('+').map((k, i) => (
      <span key={i} className="hk-key">{k}</span>
    ))
  }

  const handleReset = () => {
    onSet('hotkeys', { ...DEFAULT_HOTKEYS })
  }

  const hasCustom = HK_ALL_IDS.some(id => (hotkeys[id] ?? '') !== (DEFAULT_HOTKEYS[id] ?? ''))

  return (
    <>
      <div className="hk-header">
        <SectionTitle>Горячие клавиши</SectionTitle>
        {hasCustom && (
          <motion.button
            className="hk-reset-btn"
            onClick={handleReset}
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
            title="Сбросить все хоткеи к значениям по умолчанию"
          >
            <AppIcon name="refreshCw" size="xs" />
            <span>Сбросить</span>
          </motion.button>
        )}
      </div>

      {Object.entries(conflictMap).length > 0 && (
        <div className="hk-conflict-banner">
          <AppIcon name="alertTriangle" size="sm" />
          <span>Несколько действий используют одинаковую комбинацию — сработает только первое.</span>
        </div>
      )}

      {HK_GROUPS.map(group => (
        <div key={group.title} className="hk-group">
          <div className="hk-group-title">
            <AppIcon name={group.icon} size="xs" tone="muted" />
            <span>{group.title}</span>
          </div>
          <div className="hk-list">
            {group.items.map(k => {
              const isConflict = !!conflictMap[k.id]
              return (
                <div key={k.id} className={`hk-row${isConflict ? ' hk-row--conflict' : ''}`}>
                  <div className="hk-info">
                    <span className="hk-icon">{k.icon}</span>
                    <div className="hk-text">
                      <span className="hk-label">{k.label}</span>
                      <span className="hk-desc">{k.desc}</span>
                    </div>
                  </div>
                  <div className="hk-bind-wrap">
                    <motion.button
                      className={`hk-bind-btn ${recording === k.id ? 'hk-bind-btn--recording' : ''} ${isConflict ? 'hk-bind-btn--conflict' : ''}`}
                      onClick={() => { setRecording(recording === k.id ? null : k.id); setPressed('') }}
                      whileHover={whileHoverWide}
                      whileTap={whileTapWide}
                      transition={springHover}
                    >
                      {recording === k.id
                        ? (pressed
                            ? <>{pressed.split('+').map((p, i) => <span key={i} className="hk-key hk-key--live">{p}</span>)}</>
                            : <span className="hk-recording-hint">Нажмите клавиши...</span>)
                        : renderBind(hotkeys[k.id] || '')}
                    </motion.button>
                    {hotkeys[k.id] && recording !== k.id && (
                      <motion.button className="hk-clear" onClick={() => onSet('hotkeys', { ...hotkeys, [k.id]: '' })} title="Очистить" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>×</motion.button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {recording && (
        <div className="hk-overlay-hint">
          <span>Нажмите комбинацию клавиш для <strong>{HK_ALL_IDS.includes(recording as keyof typeof DEFAULT_HOTKEYS) ? HK_GROUPS.flatMap(g => g.items).find(i => i.id === recording)?.label : recording}</strong></span>
          <motion.button onClick={() => { setRecording(null); setPressed('') }} whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>Отмена</motion.button>
        </div>
      )}
    </>
  )
})

const AgentSection = memo(function AgentSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const [agentSettings, setAgentSettings] = useState<SharedAgentSettings>(DEFAULT_AGENT_SETTINGS)

  useEffect(() => {
    window.syntee.agent.getSettings().then((s: SharedAgentSettings) => {
      setAgentSettings(prev => ({ ...prev, ...s }))
    }).catch(() => {})
  }, [])

  const updateAgent = (patch: Partial<SharedAgentSettings>) => {
    const next = { ...agentSettings, ...patch }
    setAgentSettings(next)
    window.syntee.agent.setSettings(next).catch(() => {})
  }

  const perms = (settings['agentPermissions'] as Record<string, unknown>) || {}

  const OUTPUT_MODES = [
    { value: 'compact',  label: 'Компактный', desc: 'Только иконки инструментов в одну строку' },
    { value: 'normal',   label: 'Обычный',    desc: 'Название + первый аргумент каждого шага' },
    { value: 'detailed', label: 'Подробный',  desc: 'Все аргументы и результаты, раскрываются' },
  ]

  return (
    <>
      <SectionTitle>Агент и Безопасность</SectionTitle>

      <Field label="Режим подтверждения действий" description="Когда агент запрашивает подтверждение перед выполнением">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ApprovalModeSelector
            value={agentSettings.approvalMode as import('../../../../../shared/types').ApprovalMode}
            onChange={mode => updateAgent({ approvalMode: mode })}
          />
          <ResetButton current={agentSettings.approvalMode} defaultValue={DEFAULT_AGENT_SETTINGS.approvalMode} onReset={() => updateAgent({ approvalMode: DEFAULT_AGENT_SETTINGS.approvalMode })} />
        </div>
      </Field>

      <Field label="Режим размышлений" description="AI показывает ход своих мыслей перед ответом — цепочка рассуждений видна в свёрнутом блоке">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Toggle value={agentSettings.enableThinking} onChange={v => updateAgent({ enableThinking: v })} />
          <ResetButton current={agentSettings.enableThinking} defaultValue={DEFAULT_AGENT_SETTINGS.enableThinking} onReset={() => updateAgent({ enableThinking: DEFAULT_AGENT_SETTINGS.enableThinking })} />
        </div>
      </Field>

      <Field label="Вывод инструментов" description="Как отображать цепочку действий агента в чате">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {OUTPUT_MODES.map(m => (
              <motion.button
                key={m.value}
                className={`settings-chip ${agentSettings.toolOutputMode === m.value ? 'settings-chip--active' : ''}`}
                onClick={() => updateAgent({ toolOutputMode: m.value })}
                title={m.desc}
                whileHover={whileHoverSm}
                whileTap={whileTapSm}
                transition={springHover}
              >
                {m.label}
              </motion.button>
            ))}
          </div>
          <ResetButton current={agentSettings.toolOutputMode} defaultValue={DEFAULT_AGENT_SETTINGS.toolOutputMode} onReset={() => updateAgent({ toolOutputMode: DEFAULT_AGENT_SETTINGS.toolOutputMode })} />
        </div>
      </Field>

      <Field label="Параллельных суб-агентов" description="Сколько дочерних агентов можно держать активными одновременно">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select
            className="settings-input"
            value={agentSettings.maxParallelSubAgents}
            onChange={e => updateAgent({ maxParallelSubAgents: Number(e.target.value) })}
          >
            {[5, 6, 7, 8, 9, 10].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <ResetButton current={agentSettings.maxParallelSubAgents} defaultValue={DEFAULT_AGENT_SETTINGS.maxParallelSubAgents} onReset={() => updateAgent({ maxParallelSubAgents: DEFAULT_AGENT_SETTINGS.maxParallelSubAgents })} />
        </div>
      </Field>

      <Field label="Автосохранение рабочей памяти" description="Через сколько шагов агент обновляет working memory во время длинной сессии">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select
            className="settings-input"
            value={agentSettings.autoMemoryInterval}
            onChange={e => updateAgent({ autoMemoryInterval: Number(e.target.value) })}
          >
            {[0, 3, 5, 8, 12].map(n => (
              <option key={n} value={n}>{n === 0 ? 'выкл' : `каждые ${n} шагов`}</option>
            ))}
          </select>
          <ResetButton current={agentSettings.autoMemoryInterval} defaultValue={DEFAULT_AGENT_SETTINGS.autoMemoryInterval} onReset={() => updateAgent({ autoMemoryInterval: DEFAULT_AGENT_SETTINGS.autoMemoryInterval })} />
        </div>
      </Field>

      <Field label="Повтор одного и того же tool-call" description="После этого количества одинаковых вызовов агент получает защиту от зацикливания">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select
            className="settings-input"
            value={agentSettings.maxRepeatedToolCalls}
            onChange={e => updateAgent({ maxRepeatedToolCalls: Number(e.target.value) })}
          >
            {[2, 3, 4, 5].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <ResetButton current={agentSettings.maxRepeatedToolCalls} defaultValue={DEFAULT_AGENT_SETTINGS.maxRepeatedToolCalls} onReset={() => updateAgent({ maxRepeatedToolCalls: DEFAULT_AGENT_SETTINGS.maxRepeatedToolCalls })} />
        </div>
      </Field>

      <Field label="Повтор одной и той же ошибки" description="Если инструмент падает одинаково несколько раз подряд, агенту запрещается тупо повторять вызов">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select
            className="settings-input"
            value={agentSettings.maxRepeatedErrors}
            onChange={e => updateAgent({ maxRepeatedErrors: Number(e.target.value) })}
          >
            {[2, 3, 4].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <ResetButton current={agentSettings.maxRepeatedErrors} defaultValue={DEFAULT_AGENT_SETTINGS.maxRepeatedErrors} onReset={() => updateAgent({ maxRepeatedErrors: DEFAULT_AGENT_SETTINGS.maxRepeatedErrors })} />
        </div>
      </Field>

      <Field label="Подтверждение опасных действий" description="Удаление файлов, системные команды">
        <Toggle value={!!perms['confirmDangerous']} onChange={v => onSet('agentPermissions', { ...perms, confirmDangerous: v })} />
      </Field>

      <Field label="Запрещённые папки" description="Через запятую — агент не трогает эти пути">
        <input
          className="settings-input"
          value={((perms['forbiddenPaths'] as string[]) || []).join(', ')}
          onChange={e => onSet('agentPermissions', { ...perms, forbiddenPaths: e.target.value.split(',').map(s => s.trim()) })}
          placeholder="C:\Windows, C:\..."
        />
      </Field>
    </>
  )
})

const IntegrationsSection = memo(function IntegrationsSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const integrations = (settings['integrations'] as Record<string, Record<string, string>>) || {}
  return (
    <>
      <SectionTitle>Интеграции</SectionTitle>
      <Field label="Tavily API ключ" description="Для поиска в интернете">
        <input className="settings-input" type="password"
          value={integrations['tavily']?.key || ''}
          onChange={e => onSet('integrations', { ...integrations, tavily: { ...integrations['tavily'], key: e.target.value } })}
          placeholder="tvly-..."
        />
      </Field>
      <Field label="Telegram Bot Token">
        <input className="settings-input" type="password"
          value={integrations['telegram']?.token || ''}
          onChange={e => onSet('integrations', { ...integrations, telegram: { ...integrations['telegram'], token: e.target.value } })}
          placeholder="123456:ABC..."
        />
      </Field>
      <Field label="GitHub Token">
        <input className="settings-input" type="password"
          value={integrations['github']?.token || ''}
          onChange={e => onSet('integrations', { ...integrations, github: { ...integrations['github'], token: e.target.value } })}
          placeholder="ghp_..."
        />
      </Field>
      <Field label="Spotify Client ID">
        <input className="settings-input"
          value={integrations['spotify']?.clientId || ''}
          onChange={e => onSet('integrations', { ...integrations, spotify: { ...integrations['spotify'], clientId: e.target.value } })}
        />
      </Field>
    </>
  )
})

const DataSection = memo(function DataSection({ settings, onSet, toast }: {
  settings: Record<string, unknown>
  onSet: (k: string, v: unknown) => void
  toast: (msg: string, type?: string) => void
}) {
  return (
    <>
      <SectionTitle>Данные и Память</SectionTitle>
      <Field label="Автобэкап" description="Ежедневная копия базы данных">
        <Toggle value={!!settings['backupEnabled']} onChange={v => onSet('backupEnabled', v)} />
      </Field>
      <Field label="Экспорт истории">
        <div style={{ display: 'flex', gap: 8 }}>
          {['JSON', 'Markdown', 'TXT'].map(fmt => (
            <motion.button key={fmt} className="settings-btn" whileTap={{ scale: 0.95 }}
              onClick={() => toast(`Экспорт ${fmt} — будет готово в стадии 09`, 'info')}>
              {fmt}
            </motion.button>
          ))}
        </div>
      </Field>
      <Field label="Очистить историю чатов">
        <motion.button className="settings-btn settings-btn--danger" whileTap={{ scale: 0.95 }}
          onClick={() => toast('Очистка истории — будет в стадии 09', 'info')}>
          Очистить
        </motion.button>
      </Field>
      <Field label="Очистить память Syntee">
        <motion.button className="settings-btn settings-btn--danger" whileTap={{ scale: 0.95 }}
          onClick={() => toast('Очистка памяти — будет в стадии 07', 'info')}>
          Сбросить память
        </motion.button>
      </Field>
    </>
  )
})

// ── Notifications section ──────────────────────────────────────────────
const NOTIF_TYPES: { id: import('../../../../shared/types').NotificationType; label: string }[] = [
  { id: 'ai_response', label: 'Ответ AI' },
  { id: 'agent_done', label: 'Агент выполнил задачу' },
  { id: 'permission', label: 'Запрос разрешения' },
  { id: 'ask_user', label: 'Вопросы от агента' },
  { id: 'messenger', label: 'Сообщения мессенджера' },
  { id: 'updates', label: 'Обновления' },
  { id: 'system', label: 'Системные события' },
]

const SHOW_WHEN_LABELS: Record<string, string> = {
  inactive: 'Когда окно неактивно',
  minimized: 'Только когда свёрнуто',
  always: 'Всегда',
}

const NotificationsSection = memo(function NotificationsSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const notifConfig = (settings['notifications'] as {
    enabled: boolean
    types: Record<string, { enabled: boolean; showWhen: string }>
  }) || { enabled: true, types: {} }

  const activityConfig = (settings['activityMonitor'] as { enabled: boolean }) || { enabled: false }

  const updateType = (typeId: string, field: 'enabled' | 'showWhen', value: unknown) => {
    const types = { ...(notifConfig.types ?? {}) }
    types[typeId] = { ...(types[typeId] ?? { enabled: true, showWhen: 'inactive' }), [field]: value }
    onSet('notifications', { ...notifConfig, types })
  }

  const toggleGlobal = () => {
    onSet('notifications', { ...notifConfig, enabled: !notifConfig.enabled })
  }

  const toggleActivity = () => {
    onSet('activityMonitor', { enabled: !activityConfig.enabled })
  }

  return (
    <>
      <h2 className="settings-section-title">Уведомления</h2>

      <Field label="Показывать уведомления" description="Глобальный вкл/выкл overlay-уведомлений">
        <Toggle value={notifConfig.enabled} onChange={toggleGlobal} />
      </Field>

      {notifConfig.enabled && (
        <>
          <div className="settings-divider" />

          {NOTIF_TYPES.map(({ id, label }) => {
            const typeConfig = notifConfig.types?.[id] ?? { enabled: true, showWhen: 'inactive' }
            return (
              <Field key={id} label={label} description="Включить и выбрать когда показывать">
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <Toggle
                    value={typeConfig.enabled}
                    onChange={(v) => updateType(id, 'enabled', v)}
                  />
                  <select
                    className="settings-select"
                    value={typeConfig.showWhen}
                    onChange={(e) => updateType(id, 'showWhen', e.target.value)}
                    style={{ fontSize: 12, padding: '6px 10px' }}
                  >
                    <option value="inactive">{SHOW_WHEN_LABELS.inactive}</option>
                    <option value="minimized">{SHOW_WHEN_LABELS.minimized}</option>
                    <option value="always">{SHOW_WHEN_LABELS.always}</option>
                  </select>
                </div>
              </Field>
            )
          })}
        </>
      )}

      <div className="settings-divider" />

      <h3 className="settings-subsection-title">Информер активности</h3>
      <Field
        label="Показывать активность ИИ"
        description="Компактный индикатор что делает агент (думает / вызывает тул), пока окно неактивно или свёрнуто"
      >
        <Toggle value={activityConfig.enabled} onChange={toggleActivity} />
      </Field>
    </>
  )
})
