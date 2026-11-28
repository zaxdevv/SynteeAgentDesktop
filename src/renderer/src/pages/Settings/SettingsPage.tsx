import { useState, useEffect, useRef, useLayoutEffect, useCallback, memo, useMemo } from 'react'
import { createPortal, flushSync } from 'react-dom'
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
import ToolsSettingsTab from '../../components/settings/ToolsSettingsTab/ToolsSettingsTab'
import AssistantsSettingsTab from '../../components/settings/AssistantsSettingsTab/AssistantsSettingsTab'
import ProjectMapSettingsTab from '../../components/settings/ProjectMapSettingsTab/ProjectMapSettingsTab'
import ChangelogSettingsTab from '../../components/settings/ChangelogSettingsTab/ChangelogSettingsTab'
import ProfileSection from '../../components/settings/ProfileSection/ProfileSection'
import ModelStatusSection from '../../components/settings/ModelStatusSection/ModelStatusSection'
import StatisticsSection from '../../components/settings/StatisticsSection/StatisticsSection'
import ApprovalModeSelector from '../../components/ui/ApprovalModeSelector/ApprovalModeSelector'
import ResetButton from '../../components/ui/ResetButton/ResetButton'
import Select from '../../components/ui/Select/Select'
import SegmentedControl from '../../components/ui/SegmentedControl/SegmentedControl'
import Stepper from '../../components/ui/Stepper/Stepper'
import { SectionTitle, Field, Group, ConfirmButton, GROUP_TOGGLE_EVENT } from '../../components/settings/SettingsPrimitives'
import { MSG_ANIM_VARIANTS } from '../../components/ui/MessageBubble/MessageBubble'
import { playNavigateSound, setSoundVolume as setSoundVolumeModule, setSoundAssignmentsFlag } from '../../utils/sounds'
import { applyFontToDOM, applyMonoToDOM, injectCustomFonts, applyAccentToDOM, applyGlassToDOM, applyDensityToDOM, applyGradientAccentToDOM, applyCustomThemeToDOM, applyBgImageToDOM, applyRainbowAccentToDOM, applyFontSizeToDOM } from '../../App'
import type { CustomFont } from '../../App'
import { BUILTIN_THEMES } from '../../utils/builtinThemes'
import { applyPluginThemeToDOM, isPluginThemeKey } from '../../utils/pluginTheme'
import {
  startAudioVisualizerDemo,
  stopAudioVisualizerDemo,
  startSystemAudioVisualizer,
  stopSystemAudioVisualizer,
  subscribeAudioVisualizer,
  subscribeAudioOutputDevices,
  subscribeAudioDeviceStatus,
  startAudioOutputDeviceMonitor,
  stopAudioOutputDeviceMonitor,
  normalizeVisualizerPreset,
  type AudioOutputDevice,
} from '../../utils/systemAudioVisualizer'
import { AudioVisualizerLayer } from '../../components/ui/ChatInput/AudioVisualizerLayer'
import { collectPluginBackgrounds, collectPluginThemes, collectSettingsSections, selectRunningPlugins } from '../../utils/pluginExtApi'
import { useExtensionsStore } from '../../store/extensions.store'
import PluginIframe from '../../components/ui/PluginSlot/PluginIframe'
import { whileHoverWide, whileTapWide, whileHoverSm, whileTapSm, whileHoverTiny, whileTapTiny, springHover } from '../../utils/motionPresets'
import { DEFAULT_AGENT_SETTINGS, DEFAULT_AUTO_MODE_SETTINGS, type AgentSettings as SharedAgentSettings, type AutoModeSettings, type NetworkPolicy, type ApprovalAllowlistEntry, type CustomTheme } from '../../../../shared/types'
import { DEFAULT_HOTKEYS } from '../../../../shared/constants'
import './SettingsPage.css'

type Section =
  | 'profile' | 'general' | 'ai' | 'voice' | 'hotkeys' | 'modelStatus'
  | 'agent' | 'security' | 'data' | 'appearance' | 'integrations' | 'context'
|  'changelog' | 'notifications' | 'stats' | 'tools' | 'assistants' | 'projectMap'

interface SectionDef { id: Section; label: string; icon: IconName; keywords?: string[] }
interface SectionGroup { title: string; items: SectionDef[] }

// Сайдбар сгруппирован по категориям — как в VS Code / Notion.
// Каждая группа получает uppercase-подзаголовок (см. .settings-nav-group-title).
// keywords — слова для поиска по настройкам (кроме label).
const SECTION_GROUPS: SectionGroup[] = [
  {
    title: 'Аккаунт',
    items: [
      { id: 'profile', label: 'Профиль', icon: 'user', keywords: ['имя', 'аккаунт', 'пользователь'] },
    ],
  },
  {
    title: 'Внешний вид',
    items: [
      { id: 'general',      label: 'Общие',       icon: 'settings', keywords: ['запуск', 'автозапуск', 'язык', 'интерфейс', 'трей'] },
      { id: 'appearance',   label: 'Внешний вид', icon: 'palette', keywords: ['тема', 'фон', 'шрифт', 'акцент', 'анимация', 'аватар', 'звук', 'стекло'] },
    ],
  },
  {
    title: 'ИИ и контекст',
    items: [
      { id: 'ai',         label: 'ИИ и Модели',    icon: 'brain',  keywords: ['модели', 'провайдер', 'api', 'ключ', 'llm'] },
      { id: 'modelStatus', label: 'Статус моделей', icon: 'server', keywords: ['статус', 'сервер', 'доступность'] },
      { id: 'context',    label: 'Контекст',       icon: 'layers', keywords: ['компакция', 'токены', 'лимит'] },
      { id: 'tools',      label: 'Инструменты',    icon: 'wrench', keywords: ['tools', 'тулы', 'встроенные', 'дополнительные'] },
      { id: 'agent',      label: 'Агент',          icon: 'bot',    keywords: ['агент', 'инструменты', 'суб-агент', 'циклы'] },
      { id: 'assistants', label: 'Мини-агенты',   icon: 'bot',    keywords: ['мини-агенты', 'помощники', 'watcher', 'janitor', 'локальная', 'llm', 'подсказки', 'сжатие'] },
      { id: 'projectMap', label: 'Карта проекта', icon: 'gauge',  keywords: ['карта', 'граф', 'код', 'зависимости', 'индексация', 'скорость', 'символы', 'вызовы'] },
      { id: 'security',   label: 'Безопасность',   icon: 'shield', keywords: ['безопасность', 'права', 'подтверждение', 'approval', 'запрещённые', 'опасные'] },
    ],
  },
  {
    title: 'Управление',
    items: [
      { id: 'voice',   label: 'Голос',           icon: 'mic',      keywords: ['голос', 'stt', 'whisper', 'микрофон', 'распознавание'] },
      { id: 'hotkeys', label: 'Горячие клавиши', icon: 'command',  keywords: ['клавиши', 'хоткеи', 'комбинации', 'shortcut'] },
      { id: 'notifications', label: 'Уведомления', icon: 'bell',   keywords: ['уведомления', 'нотификации'] },
    ],
  },
  {
    title: 'Система',
    items: [
      { id: 'integrations', label: 'Интеграции', icon: 'link',          keywords: ['интеграции', 'тавли', 'телеграм', 'github', 'spotify', 'токен'] },
      { id: 'data',         label: 'Данные',     icon: 'database',      keywords: ['данные', 'база', 'экспорт', 'бэкап', 'память'] },
      { id: 'stats',        label: 'Статистика', icon: 'chart',         keywords: ['статистика', 'токены', 'расходы', 'usage', 'активность', 'ссылки', 'вложения'] },
      { id: 'changelog',    label: 'Обновления', icon: 'downloadCloud', keywords: ['обновления', 'версия', 'changelog'] },
    ],
  },
]

// Быстрый lookup секции по id (для результатов поиска полей).
const SECTION_LOOKUP = Object.fromEntries(
  SECTION_GROUPS.flatMap(g => g.items.map(s => [s.id, { label: s.label, icon: s.icon }]))
) as Record<Section, { label: string; icon: IconName }>

// ── Индекс полей для глобального поиска по настройкам ──
// Вводишь «токен» → получаешь конкретное поле «GitHub Token → Интеграции»
// с переходом в секцию, автоскроллом к полю и вспышкой-подсветкой.
// id должен совпадать с data-field-id соответствующего <Field>.
const FIELD_INDEX: { section: Section; id: string; label: string; keywords?: string[] }[] = [
  // Общие
  { section: 'general', id: 'userName', label: 'Имя пользователя', keywords: ['имя', 'ник', 'nickname'] },
  { section: 'general', id: 'autostart', label: 'Запуск при входе в систему', keywords: ['автозапуск', 'автостарт', 'старт'] },
  { section: 'general', id: 'gitSyncEnabled', label: 'Git Sync Monitor', keywords: ['git', 'github', 'fetch', 'репозиторий', 'коммиты', 'синхронизация'] },
  { section: 'general', id: 'language', label: 'Язык интерфейса', keywords: ['язык', 'english', 'русский', 'language'] },
  { section: 'general', id: 'closeAction', label: 'При закрытии окна', keywords: ['трей', 'закрытие', 'выход', 'quit'] },
  { section: 'general', id: 'showContextRing', label: 'Счётчик контекста', keywords: ['контекст', 'кольцо', 'ring'] },
  { section: 'general', id: 'chatMinimap', label: 'Миникарта сообщений', keywords: ['миникарта', 'навигация'] },
  { section: 'general', id: 'mouseNavEnabled', label: 'Боковые кнопки мыши', keywords: ['мышь', 'x1', 'x2', 'назад'] },
  // Внешний вид
  { section: 'appearance', id: 'theme', label: 'Цветовая палитра', keywords: ['тема', 'палитра', 'dark', 'светлая'] },
  { section: 'appearance', id: 'themeSchedule', label: 'Автосмена темы', keywords: ['автосмена', 'день', 'ночь', 'расписание'] },
  { section: 'appearance', id: 'systemThemeSync', label: 'Тема Windows', keywords: ['системная', 'windows', 'синхронизация', 'система'] },
  { section: 'appearance', id: 'fontSizeUI', label: 'Размер шрифта интерфейса', keywords: ['шрифт', 'размер', 'масштаб', 'текст'] },
  { section: 'appearance', id: 'fontSizeChat', label: 'Размер шрифта сообщений', keywords: ['шрифт', 'размер', 'чат', 'сообщения', 'текст'] },
  { section: 'appearance', id: 'accentColor', label: 'Цвет акцента', keywords: ['акцент', 'цвет'] },
  { section: 'appearance', id: 'rainbowAccent', label: 'Радужный акцент', keywords: ['радуга', 'rainbow'] },
  { section: 'appearance', id: 'accentGradient', label: 'Градиентный акцент', keywords: ['градиент'] },
  { section: 'appearance', id: 'fontFamily', label: 'Шрифт интерфейса', keywords: ['шрифт', 'font'] },
  { section: 'appearance', id: 'fontMono', label: 'Шрифт кода', keywords: ['моно', 'mono', 'код'] },
  { section: 'appearance', id: 'density', label: 'Плотность интерфейса', keywords: ['плотность', 'компактно', 'просторно'] },
  { section: 'appearance', id: 'glassBlur', label: 'Стекло (Glass blur)', keywords: ['блюр', 'стекло', 'размытие', 'glass'] },
  { section: 'appearance', id: 'bgStyle', label: 'Стиль фона', keywords: ['фон', 'частицы', 'матрица', 'анимация'] },
  { section: 'appearance', id: 'msgAnim', label: 'Анимация сообщений', keywords: ['анимация', 'сообщения'] },
  { section: 'appearance', id: 'avatarStyle', label: 'Аватар ассистента', keywords: ['аватар'] },
  { section: 'appearance', id: 'showTime', label: 'Время сообщений', keywords: ['время', 'таймстамп'] },
  { section: 'appearance', id: 'userMarkdown', label: 'Markdown в своих сообщениях', keywords: ['markdown', 'разметка'] },
  { section: 'appearance', id: 'sendEffect', label: 'Эффект отправки', keywords: ['эффект', 'ripple'] },
  // Голос
  { section: 'voice', id: 'wakeWord', label: 'Wake word', keywords: ['вейк', 'слово', 'активация'] },
  { section: 'voice', id: 'voiceId', label: 'Голос ассистента', keywords: ['голос', 'tts', 'озвучка'] },
  { section: 'voice', id: 'sttProvider', label: 'Распознавание речи', keywords: ['stt', 'whisper', 'распознавание', 'микрофон'] },
  { section: 'voice', id: 'sttModelSize', label: 'Размер модели Whisper', keywords: ['whisper', 'модель', 'tiny', 'base'] },
  { section: 'voice', id: 'groqApiKey', label: 'Groq API key', keywords: ['groq', 'ключ'] },
  // Агент
  { section: 'agent', id: 'enableThinking', label: 'Режим размышлений', keywords: ['мышление', 'thinking', 'мысли'] },
  { section: 'agent', id: 'toolOutputMode', label: 'Вывод инструментов', keywords: ['инструменты', 'тул', 'вывод'] },
  { section: 'agent', id: 'maxParallelSubAgents', label: 'Параллельных суб-агентов', keywords: ['суб-агент', 'параллельно'] },
  { section: 'agent', id: 'autoMemoryInterval', label: 'Автосохранение рабочей памяти', keywords: ['память', 'автосохранение'] },
  { section: 'agent', id: 'maxRepeatedToolCalls', label: 'Повтор tool-call', keywords: ['зацикливание', 'повтор'] },
  { section: 'agent', id: 'maxRepeatedErrors', label: 'Повтор одной ошибки', keywords: ['ошибка', 'повтор'] },
  { section: 'tools', id: 'customToolsEnabled', label: 'Дополнительные инструменты', keywords: ['tools', 'встроенные'] },
  // Безопасность
  { section: 'security', id: 'approvalMode', label: 'Режим подтверждения действий', keywords: ['подтверждение', 'approval', 'авто', 'спрашивать'] },
  { section: 'security', id: 'autoAskOnDangerous', label: 'Опасные действия', keywords: ['опасно', 'удаление', 'подтверждение'] },
  { section: 'security', id: 'autoAskOnWarn', label: 'Потенциально опасные', keywords: ['warn', 'chmod', 'подтверждение'] },
  { section: 'security', id: 'autoAskGitPush', label: 'Git push', keywords: ['git', 'push', 'отправка'] },
  { section: 'security', id: 'autoAskNetwork', label: 'Сетевые команды', keywords: ['сеть', 'install', 'curl', 'npm'] },
  { section: 'security', id: 'autoAskOutsideWorkdir', label: 'Вне папки проекта', keywords: ['workdir', 'вне', 'папка'] },
  { section: 'security', id: 'autoCodeModePolicy', label: 'Code Mode в авто-режиме', keywords: ['code mode', 'typescript', 'скрипт', 'авто', 'подтверждение'] },
  { section: 'security', id: 'forbiddenPaths', label: 'Запрещённые папки', keywords: ['папки', 'запрет', 'пути'] },
  // Интеграции
  { section: 'integrations', id: 'tavilyKey', label: 'Tavily API ключ', keywords: ['тавли', 'поиск', 'tavily'] },
  { section: 'integrations', id: 'telegramToken', label: 'Telegram Bot Token', keywords: ['телеграм', 'бот'] },
  { section: 'integrations', id: 'githubToken', label: 'GitHub Token', keywords: ['github', 'гитхаб', 'токен'] },
  { section: 'integrations', id: 'spotifyClientId', label: 'Spotify Client ID', keywords: ['spotify', 'спотифай'] },
  // Данные
  { section: 'data', id: 'backupEnabled', label: 'Автобэкап', keywords: ['бэкап', 'копия', 'резервная'] },
  { section: 'data', id: 'exportHistory', label: 'Экспорт истории', keywords: ['экспорт', 'выгрузка'] },
  { section: 'data', id: 'clearHistory', label: 'Очистить историю чатов', keywords: ['очистить', 'история', 'удалить'] },
  { section: 'data', id: 'clearMemory', label: 'Очистить память Syntee', keywords: ['память', 'сброс'] },
  // Уведомления
  { section: 'notifications', id: 'notifEnabled', label: 'Показывать уведомления', keywords: ['уведомления', 'нотификации'] },
  { section: 'notifications', id: 'activityMonitor', label: 'Показывать активность ИИ', keywords: ['активность', 'информер'] },
  // Хоткеи
  { section: 'hotkeys', id: 'hk-mainWindow', label: 'Открыть/скрыть окно', keywords: ['окно', 'показать'] },
  { section: 'hotkeys', id: 'hk-overlay', label: 'Оверлей', keywords: ['оверлей', 'выделение'] },
  { section: 'hotkeys', id: 'hk-spotlight', label: 'Spotlight', keywords: ['спотлайт', 'поиск'] },
  { section: 'hotkeys', id: 'hk-voice', label: 'Голосовой режим', keywords: ['голос'] },
  { section: 'hotkeys', id: 'hk-quickQuestion', label: 'Быстрый вопрос', keywords: ['вопрос'] },
  { section: 'hotkeys', id: 'hk-chatAskMode', label: 'Режим чтения', keywords: ['чтение', 'read-only'] },
  { section: 'hotkeys', id: 'hk-chatPlanningMode', label: 'Режим планирования', keywords: ['планирование', 'plan'] },
  // Контекст
  { section: 'context', id: 'ctx-toolTrunc', label: 'Обрезка результатов тулов', keywords: ['обрезка', 'truncation', 'лимит', 'символы'] },
  { section: 'context', id: 'ctx-toolMaxChars', label: 'Макс. символов на тул-результат', keywords: ['обрезка', 'символы', 'тул'] },
  { section: 'context', id: 'ctx-rolling', label: 'Сжатие истории (Rolling Window)', keywords: ['компакция', 'сжатие', 'rolling', 'резюме'] },
  { section: 'context', id: 'ctx-rollingTriggerPct', label: 'Триггер сжатия', keywords: ['процент', 'триггер', 'порог'] },
  { section: 'context', id: 'ctx-rollingKeepFirst', label: 'Сохранять первых сообщений', keywords: ['сообщения', 'история'] },
  { section: 'context', id: 'ctx-rollingKeepLast', label: 'Сохранять последних сообщений', keywords: ['сообщения', 'история'] },
  { section: 'context', id: 'ctx-tokenCounter', label: 'Счётчик токенов', keywords: ['токены', 'счётчик', 'кольцо', 'контекст'] },
  { section: 'context', id: 'ctx-diffJournal', label: 'Diff журнал правок', keywords: ['diff', 'журнал', 'правки'] },
  { section: 'context', id: 'ctx-fileMap', label: 'File Map', keywords: ['карта', 'файлы'] },
  { section: 'context', id: 'ctx-readFileCache', label: 'Кэш файлов внутри запроса', keywords: ['кэш', 'файлы'] },
]

export default function SettingsPage() {
  const navSection = useNavStore(s => s.settingsSection)
  const setNavSection = useNavStore(s => s.setSettingsSection)
  const setMainPage = useNavStore(s => s.setMainPage)
  const [section, setSection] = useState<Section | string>(
    (navSection as Section) || 'general'
  )
  // Синхронизация: при изменении settingsSection извне (openSettings) —
  // переключаемся. Официальный паттерн «adjust state during render»
  // (react.dev/learn/you-might-not-need-an-effect) вместо setState в effect.
  const [lastNavSection, setLastNavSection] = useState(navSection)
  if (navSection !== lastNavSection) {
    setLastNavSection(navSection)
    if (navSection) setSection(navSection as Section)
  }
  // Поиск по разделам настроек (фильтрует сайдбар, подсвечивает совпадения)
  const [navQuery, setNavQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLElement>(null)
  const navigationRef = useRef<HTMLElement>(null)
  const sectionTransition = useRef<ViewTransition | null>(null)
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [section])
  useEffect(() => () => {
    sectionTransition.current?.skipTransition()
    sectionTransition.current = null
  }, [])
  // Результаты поиска по конкретным полям (FIELD_INDEX) — «GitHub Token → Интеграции»
  const fieldResults = useMemo(() => {
    const q = navQuery.trim().toLowerCase()
    if (!q) return []
    return FIELD_INDEX
      .filter(f =>
        f.label.toLowerCase().includes(q) ||
        (f.keywords ?? []).some(k => k.toLowerCase().includes(q))
      )
      .slice(0, 8)
  }, [navQuery])
  // Переход к конкретному полю: секция + автоскролл + вспышка-подсветка.
  // pendingField обрабатывается в effect ниже (поле монтируется после
  // переключения секции — AnimatePresence popLayout).
  const [pendingField, setPendingField] = useState<string | null>(null)
  const goToField = (sec: Section, fieldId: string) => {
    if (sec !== section) handleSectionChange(sec)
    setNavQuery('')
    setPendingField(fieldId)
  }
  useEffect(() => {
    if (!pendingField) return
    let cancelled = false
    const attempt = (tries: number) => {
      if (cancelled) return
      const el = document.querySelector(`[data-field-id="${pendingField}"]`)
      if (el) {
        // Если поле внутри свёрнутой карточки — раскрываем её.
        // Достаточно dispatch события: Group сам удалит id из
        // collapsedGroups и развернётся (состояние инкапсулировано
        // в SettingsPrimitives).
        const card = el.closest('.settings-card') as HTMLElement | null
        const groupId = card?.dataset.groupId
        if (groupId && card?.classList.contains('settings-card--collapsed')) {
          window.dispatchEvent(new CustomEvent(GROUP_TOGGLE_EVENT, { detail: groupId }))
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('settings-field--flash')
        setTimeout(() => el.classList.remove('settings-field--flash'), 2400)
        setPendingField(null)
      } else if (tries > 0) {
        setTimeout(() => attempt(tries - 1), 100)
      } else {
        setPendingField(null)
      }
    }
    attempt(15)
    return () => { cancelled = true }
  }, [pendingField, section])
  // Ctrl+K / Ctrl+F — фокус в поиск настроек
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'f')) {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const filteredGroups = useMemo(() => {
    const q = navQuery.trim().toLowerCase()
    if (!q) return SECTION_GROUPS
    return SECTION_GROUPS
      .map(g => ({
        ...g,
        items: g.items.filter(s =>
          s.label.toLowerCase().includes(q) ||
          g.title.toLowerCase().includes(q) ||
          (s.keywords ?? []).some(k => k.toLowerCase().includes(q))
        ),
      }))
      .filter(g => g.items.length > 0)
  }, [navQuery])
  // Подсветка совпавшего куска label в сайдбаре
  const highlightLabel = (text: string): React.ReactNode => {
    const q = navQuery.trim().toLowerCase()
    if (!q) return text
    const idx = text.toLowerCase().indexOf(q)
    if (idx === -1) return text
    return (
      <>
        {text.slice(0, idx)}
        <span className="settings-nav-hl">{text.slice(idx, idx + q.length)}</span>
        {text.slice(idx + q.length)}
      </>
    )
  }
  // Узкие селекторы: раньше useSettingsStore() и useUIStore() без селекторов
  // → ре-рендер SettingsPage на любое изменение любого поля. Теперь:
  // - settings — выбираем объект (нужен для передачи в секции)
  // - load/set — стабильные actions
  // - UI setters — стабильные actions через useShallow
  const settings = useSettingsStore(s => s.settings)
  const load = useSettingsStore(s => s.load)
  const set = useSettingsStore(s => s.set)
  // Бейдж конфликта хоткеев в сайдбаре: сколько хоткеев делят занятые комбинации
  const hotkeyConflictCount = useMemo(() => {
    const hk = (settings['hotkeys'] as Record<string, string>) || {}
    const seen = new Map<string, number>()
    for (const bind of Object.values(hk)) {
      if (!bind) continue
      seen.set(bind, (seen.get(bind) || 0) + 1)
    }
    let count = 0
    for (const n of seen.values()) if (n > 1) count += n
    return count
  }, [settings])
  const { setTheme, setAccentColor, setBgStyle, setMsgAnim,
    setAvatarStyle, setShowTime, setUserMarkdown, setUiSounds, setSendEffect,
    setGlassBlur, setDensity, setAccentGradient, setRainbowAccent, setBgImage,
    setBgImageEnabled, setAnimatedBackground, setAnimatedBgOpacity, setAnimatedBgSpeed, setBgStyleParams,
    setCustomThemes, setActiveCustomThemeId, setThemeSchedule, setRecentAccents,
    setSoundVolume, setSoundAssignments, setMouseNavEnabled,
    setFavoriteThemes, setFontSizeUI, setFontSizeChat,
    setSystemThemeSync, setSystemSyncDark, setSystemSyncLight } = useUIStore(useShallow(s => ({
    setTheme: s.setTheme, setAccentColor: s.setAccentColor, setBgStyle: s.setBgStyle,
    setMsgAnim: s.setMsgAnim, setAvatarStyle: s.setAvatarStyle, setShowTime: s.setShowTime,
    setUserMarkdown: s.setUserMarkdown, setUiSounds: s.setUiSounds, setSendEffect: s.setSendEffect,
    setGlassBlur: s.setGlassBlur, setDensity: s.setDensity, setAccentGradient: s.setAccentGradient,
    setRainbowAccent: s.setRainbowAccent, setBgImage: s.setBgImage,
    setBgImageEnabled: s.setBgImageEnabled, setAnimatedBackground: s.setAnimatedBackground,
    setAnimatedBgOpacity: s.setAnimatedBgOpacity,
    setAnimatedBgSpeed: s.setAnimatedBgSpeed, setBgStyleParams: s.setBgStyleParams,
    setCustomThemes: s.setCustomThemes, setActiveCustomThemeId: s.setActiveCustomThemeId,
    setThemeSchedule: s.setThemeSchedule, setRecentAccents: s.setRecentAccents,
    setSoundVolume: s.setSoundVolume, setSoundAssignments: s.setSoundAssignments,
    setMouseNavEnabled: s.setMouseNavEnabled,
    setFavoriteThemes: s.setFavoriteThemes, setFontSizeUI: s.setFontSizeUI,
    setFontSizeChat: s.setFontSizeChat, setSystemThemeSync: s.setSystemThemeSync,
    setSystemSyncDark: s.setSystemSyncDark, setSystemSyncLight: s.setSystemSyncLight,
  })))
  const { add: toast } = useToast()

  // ── Секции настроек плагинов (registerSettingsSection) ──
  // Собираем из запущенных плагинов; ключ секции — plugin:{pluginId}:{sectionId}
  // (уникален и не конфликтует с встроенными Section). Заголовок пункта —
  // title секции, в контенте показываем «{title} · {pluginName}».
  const extPlugins = useExtensionsStore(s => s.plugins)
  const pluginSections = useMemo(() => {
    const running = selectRunningPlugins()
    const nameById = new Map(running.map(p => [p.id, p.name]))
    return collectSettingsSections().map(s => ({
      key: `plugin:${s.pluginId}:${s.id}`,
      pluginId: s.pluginId,
      sectionId: s.id,
      title: s.title,
      entry: s.entry,
      icon: (s.icon ?? 'puzzle') as IconName,
      pluginName: nameById.get(s.pluginId) ?? s.pluginId,
    }))
  }, [extPlugins])

  const handleSectionChange = (next: Section | string) => {
    if (next === section) return
    playNavigateSound()
    const openSection = () => {
      setSection(next)
      setNavSection(next)
    }
    sectionTransition.current?.skipTransition()
    const content = contentRef.current
    if (!content || !document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      sectionTransition.current = null
      content?.removeAttribute('data-transitioning')
      openSection()
      return
    }
    const previous = navigationRef.current?.querySelector('.settings-nav-selection')?.getBoundingClientRect()
    content.dataset.transitioning = ''
    const transition = document.startViewTransition(() => {
      if (sectionTransition.current !== transition) return
      flushSync(openSection)
      const selection = navigationRef.current?.querySelector('.settings-nav-selection')
      if (previous && selection) {
        const distance = previous.top - selection.getBoundingClientRect().top
        selection.animate(
          [{ transform: `translateY(${distance}px) scale(.97)` }, { transform: 'none' }],
          { duration: 310, easing: 'cubic-bezier(.2,.85,.2,1)' }
        )
      }
    })
    sectionTransition.current = transition
    void transition.finished.catch(() => {}).finally(() => {
      if (sectionTransition.current !== transition) return
      sectionTransition.current = null
      content.removeAttribute('data-transitioning')
    })
  }

  useEffect(() => { load() }, [])

  const handleSet = useCallback(async (key: string, value: unknown) => {
    await set(key, value)
    if (key === 'theme') {
      // Темы плагинов (registerTheme): value = 'plugin:{pluginId}:{name}'.
      if (isPluginThemeKey(value as string)) {
        const ok = applyPluginThemeToDOM(value as string)
        if (!ok) {
          // Плагин выключен — откатываем сохранённое значение на дефолт.
          setTheme('dark' as any)
          applyPluginThemeToDOM(null)
          void set('theme', 'dark')
        }
      } else {
        applyPluginThemeToDOM(null)
        setTheme(value as any)
        if (value === 'custom') {
          const ct = useUIStore.getState().customThemes.find(t => t.id === useUIStore.getState().activeCustomThemeId)
          if (ct) applyCustomThemeToDOM(ct)
        } else {
          applyCustomThemeToDOM(null)
        }
      }
    }
    if (key === 'accentColor') {
      setAccentColor(value as string)
      if (!useUIStore.getState().rainbowAccent) applyAccentToDOM(value as string)
    }
    if (key === 'bgStyle') setBgStyle(value as string)
    // Кнопка «Выкл» в сетке стилей пишет animatedBackground=false. Без этой
    // ветки значение уходило только в electron-store — живой zustand-стор
    // не обновлялся, AnimatedBackground продолжал рендерить до перезапуска.
    if (key === 'animatedBackground') setAnimatedBackground(value as boolean)
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
    if (key === 'favoriteThemes') setFavoriteThemes(value as string[])
    if (key === 'fontSizeUI' || key === 'fontSizeChat') {
      if (key === 'fontSizeUI') setFontSizeUI(value as number)
      else setFontSizeChat(value as number)
      const st = useUIStore.getState()
      applyFontSizeToDOM(st.fontSizeUI, st.fontSizeChat)
    }
    if (key === 'systemThemeSync') setSystemThemeSync(value as boolean)
    if (key === 'systemSyncDark') setSystemSyncDark(value as string)
    if (key === 'systemSyncLight') setSystemSyncLight(value as string)
  }, [set, setTheme, setAccentColor, setBgStyle, setMsgAnim, setAvatarStyle, setShowTime,
    setUserMarkdown, setUiSounds, setSendEffect, setGlassBlur, setDensity, setAccentGradient,
    setRainbowAccent, setBgImage, setBgImageEnabled, setAnimatedBackground, setAnimatedBgOpacity, setAnimatedBgSpeed,
    setFavoriteThemes, setFontSizeUI, setFontSizeChat,
    setSystemThemeSync, setSystemSyncDark, setSystemSyncLight,
    setBgStyleParams,
    setCustomThemes, setActiveCustomThemeId, setThemeSchedule, setRecentAccents,
    setSoundVolume, setSoundAssignments, setMouseNavEnabled])

  return (
    <div className="settings-root">
      <nav ref={navigationRef} className="settings-nav" aria-label="Разделы настроек">
        <button
          type="button"
          className="settings-back-btn"
          onClick={() => setMainPage('chat')}
          title="Назад к чату"
        >
          <AppIcon name="chevronLeft" size="sm" />
          <span>Назад</span>
        </button>
        <div className="settings-nav-title">Настройки</div>
        <div className="settings-nav-search">
          <AppIcon name="search" size="xs" tone="muted" />
          <input
            ref={searchInputRef}
            className="settings-nav-search-input"
            value={navQuery}
            onChange={e => setNavQuery(e.target.value)}
            aria-label="Поиск настроек"
            placeholder="Поиск… Ctrl+K"
            spellCheck={false}
          />
          {navQuery && (
            <button
              type="button"
              className="settings-nav-search-clear"
              onClick={() => setNavQuery('')}
              aria-label="Очистить поиск"
            >
              <AppIcon name="x" size="xs" tone="muted" />
            </button>
          )}
        </div>
        {/* Поиск и кнопка «Назад» остаются над прокручиваемым списком. */}
        <div className="settings-nav-scroll">
          {navQuery.trim() && filteredGroups.length === 0 && fieldResults.length === 0 && (
            <div className="settings-nav-empty">Ничего не найдено</div>
          )}
          {/* Результаты поиска по конкретным полям — переход + подсветка */}
          {navQuery.trim() && fieldResults.length > 0 && (
            <div className="settings-search-results">
              <div className="settings-search-results-title">Найдено в настройках</div>
              {fieldResults.map(f => {
                const sec = SECTION_LOOKUP[f.section]
                return (
                  <button
                    key={`${f.section}-${f.id}`}
                    type="button"
                    className="settings-search-result"
                    onClick={() => goToField(f.section, f.id)}
                    title={sec?.label}
                  >
                    <span className="settings-search-result-icon">
                      <AppIcon name={sec?.icon ?? 'settings'} size="xs" tone="muted" />
                    </span>
                    <span className="settings-search-result-label">{f.label}</span>
                    <span className="settings-search-result-section">{sec?.label}</span>
                  </button>
                )
              })}
            </div>
          )}
          {filteredGroups.map(group => (
            <div key={group.title} className="settings-nav-group">
              <div className="settings-nav-group-title">{group.title}</div>
              {group.items.map(s => (
                <button
                  key={s.id}
                  type="button"
                  className={`settings-nav-item no-drag ${section === s.id ? 'settings-nav-item--active' : ''}`}
                  aria-current={section === s.id ? 'page' : undefined}
                  onClick={() => handleSectionChange(s.id)}
                >
                  {section === s.id && <span className="settings-nav-selection" aria-hidden="true" />}
                  <span className="settings-nav-icon"><AppIcon name={s.icon} size="sm" /></span>
                  <span className="settings-nav-item-label">{highlightLabel(s.label)}</span>
                  {/* Бейдж: количество хоткеев в конфликте (одинаковые комбинации) */}
                  {s.id === 'hotkeys' && hotkeyConflictCount > 0 && (
                    <span className="settings-nav-badge" title="Конфликтующие комбинации клавиш">
                      {hotkeyConflictCount}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
          {/* Секции настроек плагинов (registerSettingsSection) — в конец навигации */}
          {pluginSections.length > 0 && (
            <div className="settings-nav-group">
              <div className="settings-nav-group-title">Плагины</div>
              {pluginSections.map(ps => (
                <button
                  key={ps.key}
                  type="button"
                  className={`settings-nav-item no-drag ${section === ps.key ? 'settings-nav-item--active' : ''}`}
                  aria-current={section === ps.key ? 'page' : undefined}
                  onClick={() => handleSectionChange(ps.key)}
                >
                  {section === ps.key && <span className="settings-nav-selection" aria-hidden="true" />}
                  <span className="settings-nav-icon"><AppIcon name={ps.icon} size="sm" /></span>
                  <span className="settings-nav-item-label">{highlightLabel(ps.title)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </nav>

      <main ref={contentRef} className="settings-content">
        <div key={section} className="settings-section">
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
            {section === 'stats' && (
              <StatisticsSection />
            )}
            {section === 'context' && (
              <ContextSettingsTab />
            )}
            {section === 'tools' && <ToolsSettingsTab />}
            {section === 'assistants' && <AssistantsSettingsTab />}
            {section === 'projectMap' && <ProjectMapSettingsTab />}
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
            {section === 'security' && (
              <SecuritySection settings={settings} onSet={handleSet} />
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
            {/* Секция настроек плагина (plugin:{pluginId}:{sectionId}) — iframe */}
            {section.startsWith('plugin:') && (() => {
              const ps = pluginSections.find(x => x.key === section)
              return ps ? (
                <div className="settings-plugin-section">
                  <SectionTitle description={`Секция настроек плагина «${ps.pluginName}»`}>
                    {ps.title} · {ps.pluginName}
                  </SectionTitle>
                  <PluginIframe
                    pluginId={ps.pluginId}
                    entry={ps.entry}
                    title={`${ps.title} · ${ps.pluginName}`}
                    className="plugin-iframe settings-plugin-iframe"
                  />
                </div>
              ) : null
            })()}
        </div>
      </main>
    </div>
  )
}

// ===== Разделы =====
// Примитивы (SectionTitle, GroupHeader, Field, Group, ConfirmButton) —
// в components/settings/SettingsPrimitives.tsx, общие с саб-табами.

const GeneralSection = memo(function GeneralSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => Promise<void> }) {
  const { add: toast } = useToast()
  const [autostart, setAutostart] = useState<boolean>(!!settings['autostart'])
  const [autostartBusy, setAutostartBusy] = useState(false)

  useEffect(() => {
    window.syntee.settings.getAutostartStatus().then(setAutostart).catch(() => {})
  }, [])

  const toggleAutostart = async (v: boolean) => {
    setAutostartBusy(true)
    try {
      await onSet('autostart', v)
      setAutostart(await window.syntee.settings.getAutostartStatus())
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Не удалось изменить автозапуск', 'error')
    } finally {
      setAutostartBusy(false)
    }
  }

  return (
    <>
      <SectionTitle description="Базовые параметры приложения и поведения окна">
        Общие
      </SectionTitle>

      <Group id="general-basic" icon="settings" title="Основные">
        <Field id="userName" label="Имя пользователя" description="Syntee будет обращаться к вам по имени">
          <input
            className="settings-input"
            value={(settings['userName'] as string) || ''}
            onChange={e => onSet('userName', e.target.value)}
            placeholder="Введите имя..."
          />
        </Field>
        <Field id="autostart" label="Запуск при входе в систему">
          <Toggle value={autostart} onChange={toggleAutostart} disabled={autostartBusy} />
        </Field>
        <Field id="gitSyncEnabled" label="Git Sync Monitor" description="Проверять Git-репозитории при запуске и каждые 15 минут; показывать новые remote-коммиты над полем ввода">
          <Toggle value={(settings['gitSyncEnabled'] as boolean) ?? true} onChange={v => onSet('gitSyncEnabled', v)} />
        </Field>
        <Field id="language" label="Язык интерфейса">
          <Select
            value={(settings['language'] as string) || 'ru'}
            onChange={v => onSet('language', v)}
            options={[
              { value: 'ru', label: 'Русский' },
              { value: 'en', label: 'English' },
            ]}
          />
        </Field>
        <Field id="closeAction" label="При закрытии окна">
          <Select
            value={(settings['closeAction'] as string) || 'tray'}
            onChange={v => onSet('closeAction', v)}
            options={[
              { value: 'tray', label: 'Убрать в трей' },
              { value: 'quit', label: 'Выйти' },
            ]}
          />
        </Field>
      </Group>

      <Group id="general-ui" icon="eye" title="Интерфейс">
        <Field id="showContextRing" label="Счётчик контекста" description="Кружок с заполнением контекста в поле ввода">
          <Toggle value={(settings['showContextRing'] as boolean) ?? true} onChange={v => onSet('showContextRing', v)} />
        </Field>
        <Field id="chatMinimap" label="Миникарта сообщений" description="Точки навигации по сообщениям справа в чате">
          <Toggle value={(settings['chatMinimap'] as boolean) ?? true} onChange={v => onSet('chatMinimap', v)} />
        </Field>
        <Field id="mouseNavEnabled" label="Боковые кнопки мыши" description="X1 — назад, X2 — вперёд между разделами (как в браузере)">
          <Toggle value={(settings['mouseNavEnabled'] as boolean) ?? true} onChange={v => onSet('mouseNavEnabled', v)} />
        </Field>
      </Group>
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


const BG_STYLES: { id: string; label: string; icon: IconName; desc: string }[] = [
  { id: 'aurora',  label: 'Сияние',    icon: 'rainbow',  desc: 'Северное сияние со звёздами' },
  { id: 'silk',    label: 'Шёлк',      icon: 'waves',    desc: 'Переливающиеся волны' },
  { id: 'warp',    label: 'Варп',      icon: 'zap',      desc: 'Гиперпространство со шлейфами' },
  { id: 'nebula',  label: 'Туманность', icon: 'orbit',   desc: 'Космические облака + звёзды' },
  { id: 'plasma',  label: 'Плазма',    icon: 'sparkle',  desc: 'Жидкое иридесцентное свечение' },
  { id: 'caustics', label: 'Блики',    icon: 'droplets', desc: 'Подводные световые каустики' },
  { id: 'network',  label: 'Сеть',     icon: 'share2',   desc: 'Точки с линиями возле мыши' },
  { id: 'vortex',   label: 'Вихрь',    icon: 'aperture', desc: 'Вращающаяся чёрная дыра со спиралями' },
  { id: 'flow',     label: 'Поток',    icon: 'wind',     desc: 'Текучие линии тока, как ветер' },
  { id: 'crystal',  label: 'Кристалл', icon: 'gem',      desc: 'Кристаллические ячейки со светящимися гранями' },
  { id: 'magma',    label: 'Магма',    icon: 'flame',    desc: 'Жидкие капли, сливаются друг с другом + мышь' },
  { id: 'interference', label: 'Рябь', icon: 'radio',   desc: 'Интерференция волн + мышь' },
  { id: 'hexgrid',  label: 'Энергосетка', icon: 'hexagon', desc: 'Кристаллическая решётка с бегущими импульсами + мышь' },
  { id: 'oil',      label: 'Нефть',    icon: 'paintBucket', desc: 'Радужная плёнка на воде' },
  { id: 'solar',    label: 'Солнце',   icon: 'sun',       desc: 'Кипящая поверхность и корона' },
  { id: 'dream',    label: 'Мечта',    icon: 'moonStar',  desc: 'Мягкие пастельные градиенты' },
  { id: 'smoke',    label: 'Дым',      icon: 'cloudFog',  desc: 'Стелющиеся объёмные клубы' },
  { id: 'tide',     label: 'Прилив',   icon: 'shell',     desc: 'Биолюминесцентные волны с пеной' },
  { id: 'none',    label: 'Выкл',      icon: 'x',        desc: 'Без анимации' },
]

// Аватар ассистента: icon=null → показываем букву «S» (сам контент аватара)
const AVATAR_STYLES: { id: string; label: string; icon: IconName | null }[] = [
  { id: 'hex',    label: 'Гекс',   icon: 'hexagon' },
  { id: 'circle', label: 'Круг',   icon: 'circle' },
  { id: 'letter', label: 'Буква',  icon: null },
  { id: 'emoji',  label: 'Эмодзи', icon: 'bot' },
  { id: 'none',   label: 'Нет',    icon: 'x' },
]
// 36 встроенных тем (25 тёмных + 11 светлых) — данные из builtinThemes.ts
// (единый источник: карточки здесь, шаблоны редактора тем, проверка isBuiltin).
const THEMES = BUILTIN_THEMES.map(t => ({ id: t.id, label: t.label, group: t.group, colors: t.card }))

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
      <Field id="fontFamily" label="Шрифт интерфейса" description="Основной шрифт приложения">
        <div className="font-picker-row">
          <Select
            className="font-picker-select"
            value={currentUiFont}
            onChange={v => onSet('fontFamily', v)}
            options={allUiFonts.map(f => ({
              value: f,
              label: f,
              previewStyle: f === 'system' ? undefined : { fontFamily: `'${f}', sans-serif` },
            }))}
          />
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

      <Field id="fontMono" label="Шрифт кода" description="Для блоков кода, путей, ID">
        <Select
          value={currentMonoFont}
          onChange={v => onSet('fontMono', v)}
          options={allMonoFonts.map(f => ({
            value: f,
            label: f,
            previewStyle: { fontFamily: `'${f}', monospace` },
          }))}
        />
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


// Проверка WebGL2 кэшируется: каждый getContext('webgl2') создаёт НОВЫЙ WebGL-контекст,
// а блок настроек фона рендерится на каждый апдейт live-уровней звука (10×/сек) —
// контексты утекали («Too many active WebGL contexts»).
let webgl2Checked = false
let webgl2Available = true
function isWebgl2Available(): boolean {
  if (!webgl2Checked) {
    webgl2Checked = true
    if (typeof OffscreenCanvas !== 'undefined') {
      const testCanvas = new OffscreenCanvas(1, 1)
      const gl2 = testCanvas.getContext('webgl2')
      webgl2Available = !!gl2
      gl2?.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
  return webgl2Available
}

const AppearanceSection = memo(function AppearanceSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const { add: toast } = useToast()
  const [audioDemoPlaying, setAudioDemoPlaying] = useState(false)
  useEffect(() => () => stopAudioVisualizerDemo(), [])
  const [audioSignal, setAudioSignal] = useState({ level: 0, muted: false, active: false })
  const [audioDevices, setAudioDevices] = useState<AudioOutputDevice[]>([])
  const [audioDeviceError, setAudioDeviceError] = useState<string | null>(null)
  // false при пустом списке = монитор умер (PowerShell упал), а не «ещё ищет».
  const [audioDevicesAlive, setAudioDevicesAlive] = useState(false)
  useEffect(() => subscribeAudioDeviceStatus(setAudioDevicesAlive), [])
  // Детект «мёртвого» loopback: выбранное устройство показывает уровень
  // (Windows-метр), но визуализатор молчит >3 сек — виртуальное устройство
  // (напр. Razer 7.1) не отдаёт PCM. Подсказываем выбрать другое.
  const [deadDeviceHint, setDeadDeviceHint] = useState(false)
  const deadSinceRef = useRef(0)
  useEffect(() => {
    const selectedId = settings['audioVisualizerDeviceId'] as string | undefined
    const dev = selectedId ? audioDevices.find(d => d.id === selectedId) : undefined
    const silent = !!dev && dev.level > 0.05 && audioSignal.active && audioSignal.level < 0.01
    deadSinceRef.current = silent ? (deadSinceRef.current || Date.now()) : 0
  }, [audioDevices, audioSignal, settings])
  useEffect(() => {
    const timer = setInterval(() => {
      const dead = !!deadSinceRef.current && Date.now() - deadSinceRef.current > 3000
      setDeadDeviceHint(prev => (prev === dead ? prev : dead))
    }, 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    let lastUpdate = 0
    return subscribeAudioVisualizer(frame => {
      const now = performance.now()
      if (frame && now - lastUpdate < 100) return
      lastUpdate = now
      setAudioSignal({ level: frame?.level ?? 0, muted: !!frame?.muted, active: !!frame })
    })
  }, [])
  useEffect(() => {
    let cancelled = false
    const unsubscribe = subscribeAudioOutputDevices(devices => {
      if (!cancelled) setAudioDevices(devices)
    })
    startAudioOutputDeviceMonitor().catch(error => {
      if (!cancelled) setAudioDeviceError(error instanceof Error ? error.message : 'Не удалось получить аудиоустройства')
    })
    return () => {
      cancelled = true
      unsubscribe()
      void stopAudioOutputDeviceMonitor()
    }
  }, [])
  const [accentPickerOpen, setAccentPickerOpen] = useState(false)
  const [accentPickerPos, setAccentPickerPos] = useState<{ top: number; left: number } | null>(null)
  const accentBtnRef = useRef<HTMLButtonElement>(null)
  const accentPickerRef = useRef<HTMLDivElement>(null)

  // Тот же безопасный outside-click, что и у Popover/Select: без невидимого
  // полноэкранного слоя, который может пережить закрытие второго меню.
  useEffect(() => {
    if (!accentPickerOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (accentPickerRef.current?.contains(target) || accentBtnRef.current?.contains(target)) return
      setAccentPickerOpen(false)
    }
    const id = window.setTimeout(() => document.addEventListener('pointerdown', onPointerDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [accentPickerOpen])

  // rAF-throttle для applyAccentToDOM — без него каждый pointermove
  // переписывает CSS-переменные на :root → полная пересчётка стилей 60+ раз/сек.
  const accentRafRef = useRef<number | null>(null)
  const [themeEditorOpen, setThemeEditorOpen] = useState(false)
  // id темы для редактора: null → создание новой (выбор шаблона), string → правка существующей.
  const [themeEditorEditId, setThemeEditorEditId] = useState<string | null>(null)
  const customThemes = (settings['customThemes'] as CustomTheme[]) || []
  const activeCustomThemeId = settings['activeCustomThemeId'] as string | null
  const recentAccents = (settings['recentAccents'] as string[]) || []
  const rainbowAccent = settings['rainbowAccent'] as boolean
  const accentGradient = (settings['accentGradient'] as { enabled: boolean; color2: string; angle: number }) || { enabled: false, color2: '#a78bfa', angle: 135 }
  const themeSchedule = (settings['themeSchedule'] as any) || DEFAULT_THEME_SCHEDULE
  // ── Фильтры/поиск/избранное/случайная тема ──
  const [themeFilter, setThemeFilter] = useState<'all' | 'dark' | 'light' | 'custom'>('all')
  const [themeSearch, setThemeSearch] = useState('')
  // useMemo — стабильная ссылка для deps useCallback/useMemo ниже
  // (иначе `|| []` создаёт новый массив каждый рендер → exhaustive-deps warning).
  const favoriteThemes = useMemo(() => (settings['favoriteThemes'] as string[]) || [], [settings])
  const systemThemeSync = !!settings['systemThemeSync']
  const systemSyncDark = (settings['systemSyncDark'] as string) || 'dark'
  const systemSyncLight = (settings['systemSyncLight'] as string) || 'light'
  const fontSizeUI = (settings['fontSizeUI'] as number) ?? 14
  const fontSizeChat = (settings['fontSizeChat'] as number) ?? 14

  // Клик по карточке: встроенная → theme=id; кастомная → activeCustomThemeId + theme='custom'.
  // (Старый код для неактивной кастомной карточки писал uuid в theme — чиним.)
  const handleThemePick = useCallback((t: { id: string; isCustom?: boolean }) => {
    if (t.isCustom) {
      onSet('activeCustomThemeId', t.id)
      onSet('theme', 'custom')
    } else {
      onSet('theme', t.id)
    }
  }, [onSet])

  const toggleFavoriteTheme = useCallback((id: string) => {
    const next = favoriteThemes.includes(id)
      ? favoriteThemes.filter(x => x !== id)
      : [...favoriteThemes, id]
    onSet('favoriteThemes', next)
  }, [favoriteThemes, onSet])

  // ── Сброс внешнего вида к дефолтам ──
  // Дефолты те же, что используются как fallback'и во всём рендере
  // (settings['x'] || default). Кастомные темы, галерея фонов и расписание
  // НЕ трогаем — это пользовательский контент, а не настройка.
  const appearanceHasCustom = useMemo(() => {
    const g = (settings['accentGradient'] as { enabled: boolean }) || { enabled: false }
    return (
      (settings['theme'] as string || 'dark') !== 'dark' ||
      (settings['accentColor'] as string || '#ffffff') !== '#ffffff' ||
      !!settings['rainbowAccent'] ||
      !!g.enabled ||
      (settings['fontFamily'] as string || 'Inter') !== 'Inter' ||
      (settings['fontMono'] as string || 'JetBrains Mono') !== 'JetBrains Mono' ||
      (settings['density'] as string || 'comfortable') !== 'comfortable' ||
      ((settings['glassBlur'] as number) ?? 20) !== 20 ||
      (settings['bgStyle'] as string || 'particles') !== 'particles' ||
      (settings['msgAnim'] as string || 'slide') !== 'slide' ||
      (settings['avatarStyle'] as string || 'hex') !== 'hex' ||
      (settings['showTime'] as string || 'hover') !== 'hover' ||
      !!settings['userMarkdown'] ||
      settings['sendEffect'] === false
    )
  }, [settings])

  const handleAppearanceReset = useCallback(() => {
    onSet('theme', 'dark')
    onSet('accentColor', '#ffffff')
    onSet('rainbowAccent', false)
    onSet('accentGradient', { enabled: false, color2: '#a78bfa', angle: 135 })
    onSet('fontFamily', 'Inter')
    onSet('fontMono', 'JetBrains Mono')
    onSet('density', 'comfortable')
    onSet('glassBlur', 20)
    onSet('bgStyle', 'particles')
    onSet('animatedBackground', true)
    onSet('msgAnim', 'slide')
    onSet('avatarStyle', 'hex')
    onSet('showTime', 'hover')
    onSet('userMarkdown', false)
    onSet('sendEffect', true)
  }, [onSet])

  const commitAccent = useCallback((c: string) => {
    onSet('accentColor', c)
    const next = [c, ...recentAccents.filter(x => x !== c)].slice(0, 8)
    onSet('recentAccents', next)
  }, [onSet, recentAccents])

  const allThemes = useMemo(() => [
    ...THEMES.map(t => ({ ...t, isCustom: false as const })),
    ...customThemes.map(t => ({
      id: t.id,
      label: t.name,
      group: 'custom' as const,
      colors: {
        bg: t.colors.bodyBg,
        surface: t.colors.bgSecondary,
        text: t.colors.textPrimary,
        accent: t.colors.accent,
      },
      isCustom: true as const,
    })),
    // Темы от плагинов (registerTheme) — ключ plugin:{pluginId}:{name}.
    ...collectPluginThemes().map(t => {
      const c = t.colors ?? {}
      const fallback = t.dark ? { bg: '#12121a', surface: '#1d1d27', text: '#e8e8ec', accent: '#e8e8ec' } : { bg: '#f4f1ec', surface: '#f3efe8', text: '#2a2620', accent: '#4a3f2f' }
      return {
        id: t.key,
        label: t.name,
        group: (t.dark ? 'dark' : 'light') as 'dark' | 'light',
        colors: {
          bg: c['--body-bg'] || c['--bg'] || c['bg'] || fallback.bg,
          surface: c['--bg-secondary'] || c['--surface'] || c['surface'] || fallback.surface,
          text: c['--text-primary'] || c['--text'] || c['text'] || fallback.text,
          accent: c['--accent'] || c['accent'] || fallback.accent,
        },
        isCustom: false as const,
        isPlugin: true as const,
      }
    }),
  ], [customThemes])

  // Фильтр (таб) + поиск + избранное сверху. Поиск — по названию (case-insensitive).
  const visibleThemes = useMemo(() => {
    const q = themeSearch.trim().toLowerCase()
    let list = allThemes
    if (themeFilter !== 'all') {
      list = list.filter(t => themeFilter === 'custom' ? t.group === 'custom' : t.group === themeFilter)
    }
    if (q) list = list.filter(t => t.label.toLowerCase().includes(q))
    return [...list].sort((a, b) => {
      const fa = favoriteThemes.includes(a.id) ? 0 : 1
      const fb = favoriteThemes.includes(b.id) ? 0 : 1
      return fa - fb
    })
  }, [allThemes, themeFilter, themeSearch, favoriteThemes])

  // Случайная тема — из всех (встроенных + кастомных), кроме текущей.
  const pickRandomTheme = useCallback(() => {
    const pool = allThemes.filter(t => {
      const isActive = settings['theme'] === t.id || (t.id === activeCustomThemeId && settings['theme'] === 'custom')
      return !isActive
    })
    if (pool.length === 0) return
    const t = pool[Math.floor(Math.random() * pool.length)]
    handleThemePick(t)
  }, [allThemes, settings, activeCustomThemeId, handleThemePick])

  return (
    <>
      <SectionTitle description="Тема, акцент, шрифты, фон и поведение сообщений">
        Внешний вид
      </SectionTitle>
      {appearanceHasCustom && (
        <motion.button
          className="settings-reset-link"
          onClick={handleAppearanceReset}
          whileHover={whileHoverSm}
          whileTap={whileTapSm}
          transition={springHover}
          title="Сбросить тему, акцент, шрифты, фон и сообщения к значениям по умолчанию"
        >
          <AppIcon name="refreshCw" size="xs" />
          <span>Сбросить к умолчаниям</span>
        </motion.button>
      )}

      <Group id="appearance-theme" icon="palette" title="Тема">
      <Field id="theme" label="Цветовая палитра" description="27 встроенных тем + свои. Клик — применить, звёздочка — в избранное." block>
        {/* .settings-field-control — flex-row, поэтому тулбар и сетку
            оборачиваем в колонку-панель, иначе тулбар становится левой колонкой */}
        <div className="settings-theme-panel">
        {/* Тулбар: фильтры по типу + поиск + случайная тема */}
        <div className="settings-theme-toolbar">
          <div className="settings-theme-filters">
            {([
              { id: 'all',    label: 'Все' },
              { id: 'dark',   label: 'Тёмные' },
              { id: 'light',  label: 'Светлые' },
              { id: 'custom', label: 'Мои' },
            ] as const).map(f => (
              <motion.button
                key={f.id}
                type="button"
                className={`settings-theme-filter${themeFilter === f.id ? ' settings-theme-filter--active' : ''}`}
                onClick={() => setThemeFilter(f.id)}
                whileTap={{ scale: 0.94 }}
              >{f.label}</motion.button>
            ))}
          </div>
          <div className="settings-theme-search">
            <AppIcon name="search" size="xs" tone="muted" />
            <input
              type="text"
              placeholder="Поиск темы..."
              value={themeSearch}
              onChange={e => setThemeSearch(e.target.value)}
            />
          </div>
          <motion.button
            type="button"
            className="settings-theme-random"
            onClick={pickRandomTheme}
            whileTap={{ scale: 0.94 }}
            whileHover={{ scale: 1.03 }}
            title="Случайная тема"
          >
            <AppIcon name="shuffle" size="xs" />
            <span>Случайная</span>
          </motion.button>
        </div>

        <div className="settings-theme-cards">
          {visibleThemes.map(t => {
            const isActive = settings['theme'] === t.id || (t.id === activeCustomThemeId && settings['theme'] === 'custom')
            const isFav = favoriteThemes.includes(t.id)
            return (
              <motion.div
                key={t.id}
                className={`settings-theme-card${isActive ? ' settings-theme-card--active' : ''}`}
                onClick={() => handleThemePick(t)}
                whileTap={{ scale: 0.96 }}
                whileHover={{ y: -2 }}
                transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                title={t.label}
                role="button"
                tabIndex={0}
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
                {/* Избранное — звёздочка в углу (stopPropagation, чтобы не применять тему) */}
                <motion.button
                  type="button"
                  className={`settings-theme-card__fav${isFav ? ' settings-theme-card__fav--active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggleFavoriteTheme(t.id) }}
                  whileTap={{ scale: 0.8 }}
                  title={isFav ? 'Убрать из избранного' : 'В избранное'}
                >
                  <AppIcon name="star" size="xs" />
                </motion.button>
                {/* Правка кастомной темы — карандаш рядом со звёздочкой */}
                {t.isCustom && (
                  <motion.button
                    type="button"
                    className="settings-theme-card__edit"
                    onClick={(e) => { e.stopPropagation(); setThemeEditorEditId(t.id); setThemeEditorOpen(true) }}
                    whileTap={{ scale: 0.8 }}
                    title="Редактировать в редакторе тем"
                  >
                    <AppIcon name="edit" size="xs" />
                  </motion.button>
                )}
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
              </motion.div>
            )
          })}
          {visibleThemes.length === 0 && (
            <div className="settings-theme-empty">
              {themeSearch ? `Ничего не найдено по запросу «${themeSearch}»` : 'Здесь пусто'}
            </div>
          )}
          <motion.button
            type="button"
            className="settings-theme-card settings-theme-card--add"
            onClick={() => { setThemeEditorEditId(null); setThemeEditorOpen(true) }}
            whileTap={{ scale: 0.96 }}
            whileHover={{ y: -2 }}
            title="Создать свою тему в редакторе"
          >
            <div className="settings-theme-card__preview settings-theme-card__preview--add">
              <span>+</span>
            </div>
            <div className="settings-theme-card__label">Создать</div>
          </motion.button>
        </div>
        </div>
      </Field>

      {/* Редактор тем — полноэкранная модалка с живым превью */}
      <CustomThemeEditor
        open={themeEditorOpen}
        editId={themeEditorEditId}
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
        onClose={() => setThemeEditorOpen(false)}
      />

      <Field id="themeSchedule" label="Автосмена темы" description="День → светлая, ночь → тёмная">
        <Toggle value={!!themeSchedule.enabled} onChange={v => {
          onSet('themeSchedule', { ...themeSchedule, enabled: v })
          // Расписание и синхронизация с Windows взаимоисключают друг друга.
          if (v && systemThemeSync) onSet('systemThemeSync', false)
        }} />
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
              <Select
                value={themeSchedule.dayTheme}
                onChange={v => onSet('themeSchedule', { ...themeSchedule, dayTheme: v })}
                options={[
                  ...THEMES.map(t => ({ value: t.id, label: t.label })),
                  ...customThemes.map(t => ({ value: t.id, label: t.name })),
                ]}
              />
            </Field>
            <Field label="Ночная тема">
              <Select
                value={themeSchedule.nightTheme}
                onChange={v => onSet('themeSchedule', { ...themeSchedule, nightTheme: v })}
                options={[
                  ...THEMES.map(t => ({ value: t.id, label: t.label })),
                  ...customThemes.map(t => ({ value: t.id, label: t.name })),
                ]}
              />
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

      <Field id="systemThemeSync" label="Тема Windows" description="Следовать системной теме Windows — переключается мгновенно, без перезапуска">
        <Toggle value={systemThemeSync} onChange={v => {
          onSet('systemThemeSync', v)
          if (v && themeSchedule.enabled) onSet('themeSchedule', { ...themeSchedule, enabled: false })
        }} />
      </Field>
      <AnimatePresence>
        {systemThemeSync && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            style={{ overflow: 'hidden' }}
          >
            <Field label="Когда в Windows тёмная">
              <Select
                value={systemSyncDark}
                onChange={v => onSet('systemSyncDark', v)}
                options={[
                  ...THEMES.filter(t => t.group === 'dark').map(t => ({ value: t.id, label: t.label })),
                  ...customThemes.filter(t => t.base === 'dark').map(t => ({ value: t.id, label: t.name })),
                ]}
              />
            </Field>
            <Field label="Когда в Windows светлая">
              <Select
                value={systemSyncLight}
                onChange={v => onSet('systemSyncLight', v)}
                options={[
                  ...THEMES.filter(t => t.group === 'light').map(t => ({ value: t.id, label: t.label })),
                  ...customThemes.filter(t => t.base === 'light').map(t => ({ value: t.id, label: t.name })),
                ]}
              />
            </Field>
          </motion.div>
        )}
      </AnimatePresence>
      </Group>

      <Group id="appearance-audio-visualizer" icon="activity" title="Музыкальная визуализация">
        <Field id="audioVisualizerEnabled" label="Реакция на системный звук" description="Захват Windows loopback, без микрофона. Работает только на странице чата." >
          <Toggle value={!!settings['audioVisualizerEnabled']} onChange={enabled => {
            if (!enabled) {
              stopAudioVisualizerDemo()
              setAudioDemoPlaying(false)
              stopSystemAudioVisualizer()
              onSet('audioVisualizerEnabled', false)
              onSet('audioVisualizerStatus', 'off')
              return
            }
            onSet('audioVisualizerEnabled', true)
            // Включил — подключаем сразу, без ручного тыка «Подключить»
            onSet('audioVisualizerStatus', 'connecting')
            startSystemAudioVisualizer(settings['audioVisualizerDeviceId'] as string | undefined)
              .then(() => onSet('audioVisualizerStatus', 'connected'))
              .catch(error => {
                onSet('audioVisualizerStatus', 'error')
                toast(error instanceof Error ? error.message : 'Не удалось подключить системный звук', 'error')
              })
          }} />
        </Field>
        {!!settings['audioVisualizerEnabled'] && (
          <>
            <Field label="Статус захвата" description="Системное аудио обрабатывается только в памяти">
              <div className="settings-audio-visualizer-actions">
                <span className="settings-audio-visualizer-status">{{ connecting: 'Подключение…', connected: !audioSignal.active ? 'Поток прерван' : audioSignal.muted ? 'Аудиотрек заглушен' : audioSignal.level > 0.01 ? 'Звук обнаружен' : 'Подключено · тишина', error: 'Нет доступа', off: 'Выключено', disconnected: 'Не подключено' }[String(settings['audioVisualizerStatus'] || 'disconnected')] || 'Ожидание подключения'}</span>
                <meter min="0" max="1" value={audioSignal.level} title={`Уровень системного звука: ${Math.round(audioSignal.level * 100)}%`} />
                <button className="settings-audio-visualizer-connect" type="button" onClick={async () => {
                  onSet('audioVisualizerStatus', 'connecting')
                  try {
                    await startSystemAudioVisualizer(settings['audioVisualizerDeviceId'] as string | undefined)
                    onSet('audioVisualizerStatus', 'connected')
                  } catch (error) {
                    onSet('audioVisualizerStatus', 'error')
                    toast(error instanceof Error ? error.message : 'Не удалось подключить системный звук', 'error')
                  }
                }}>Подключить</button>
              </div>
            </Field>
          </>
        )}
        <Field id="audioVisualizerDeviceId" label="Аудиоустройство" description="Выбери выход, на котором играет музыка. Полоска справа показывает живой уровень звука.">
          <div className="settings-audio-devices" role="listbox" aria-label="Аудиоустройства вывода">
            <span className="settings-audio-devices-note">Звук берётся в память только для визуализатора — устройство Windows по умолчанию не меняется.</span>
            {audioDevices.length === 0 && (
              audioDevicesAlive ? (
                <span className="settings-audio-devices-empty">Поиск устройств…</span>
              ) : (
                <span className="settings-audio-devices-error">
                  Не удалось получить список устройств — монитор аудиоустройств остановился.
                  Закрой и заново открой настройки, чтобы перезапустить его.
                </span>
              )
            )}
            {audioDevices.map(device => {
              const selectedDeviceId = settings['audioVisualizerDeviceId'] as string | undefined
              const selected = device.id === selectedDeviceId || (!selectedDeviceId && device.isDefault)
              const level = Math.round(device.level * 100)
              return (
                <button
                  key={device.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`settings-audio-device${selected ? ' settings-audio-device--selected' : ''}`}
                  onClick={async () => {
                    setAudioDeviceError(null)
                    try {
                      await onSet('audioVisualizerDeviceId', device.id)
                      if (settings['audioVisualizerEnabled']) {
                        onSet('audioVisualizerStatus', 'connecting')
                        await startSystemAudioVisualizer(device.id)
                        onSet('audioVisualizerStatus', 'connected')
                      }
                    } catch (error) {
                      const message = error instanceof Error ? error.message : 'Не удалось выбрать аудиоустройство'
                      setAudioDeviceError(message)
                      toast(message, 'error')
                    }
                  }}
                >
                  <span className="settings-audio-device-main">
                    <span className="settings-audio-device-name">{device.name}</span>
                    <span className="settings-audio-device-meta">
                      {selected ? 'Выбрано · источник визуализатора' : device.isDefault ? 'По умолчанию в Windows' : 'Доступно'}
                      {selected && deadDeviceHint && <span className="settings-audio-device-dead"> · не отдаёт звук, попробуй другое</span>}
                    </span>
                  </span>
                  <span className="settings-audio-device-meter" aria-label={`Уровень звука ${level}%`}>
                    <span style={{ width: `${Math.max(level, device.level > 0 ? 3 : 0)}%` }} />
                  </span>
                  <span className={`settings-audio-device-level${device.level > 0.01 ? ' settings-audio-device-level--active' : ''}`}>
                    {device.level > 0.01 ? `${level}%` : 'тишина'}
                  </span>
                </button>
              )
            })}
          </div>
          {audioDeviceError && <span className="settings-audio-devices-error">{audioDeviceError}</span>}
        </Field>
        {!!settings['audioVisualizerEnabled'] && (
          <>
            <Field id="audioVisualizerPreset" label="Эффект" description="Шейдерный стиль реакции вокруг поля ввода">
              <Select value={normalizeVisualizerPreset(settings['audioVisualizerPreset'])} onChange={v => onSet('audioVisualizerPreset', v)} options={[
                { value: 'fire', label: 'Огонь' },
                { value: 'sparks', label: 'Искры' },
                { value: 'wave', label: 'Волна' },
                { value: 'spectrum', label: 'Спектр' },
              ]} />
            </Field>
            <Field id="audioVisualizerColorMode" label="Источник цвета">
              <Select value={(settings['audioVisualizerColorMode'] as string) || 'accent'} onChange={v => onSet('audioVisualizerColorMode', v)} options={[
                { value: 'accent', label: 'Цвет акцента' },
                { value: 'custom', label: 'Свой цвет' },
                { value: 'gradient', label: 'Акцентный градиент' },
                { value: 'rainbow', label: 'Плавная радуга' },
              ]} />
            </Field>
            {(settings['audioVisualizerColorMode'] as string) === 'custom' && (
              <Field id="audioVisualizerColor" label="Цвет визуализатора">
                <input type="color" className="settings-input" value={(settings['audioVisualizerColor'] as string) || '#4d9fff'} onChange={e => onSet('audioVisualizerColor', e.target.value)} />
              </Field>
            )}
            <Field id="audioVisualizerAgc" label="Авто-чувствительность" description="Тихая музыка даёт такую же яркую реакцию, как громкая — усиление подстраивается автоматически">
              <Toggle value={(settings['audioVisualizerAgc'] as boolean) ?? true} onChange={v => {
                onSet('audioVisualizerAgc', v)
                void window.syntee.audioVisualizer?.setAgc(v)
              }} />
            </Field>
            <Field id="audioVisualizerQuality" label="Производительность" description="WebGL2-шейдеры, как у анимированного фона">
              <span className="settings-audio-visualizer-status">WebGL2 · 60 FPS</span>
            </Field>
            <Field label="Превью" description="Демо-сигнал не использует аудиоустройства">
              <div className="settings-audio-visualizer-preview">
                <AudioVisualizerLayer demo={audioDemoPlaying} />
                <span>Syntee готова слушать</span>
              </div>
              <button className="settings-audio-visualizer-connect" type="button" onClick={() => {
                if (audioDemoPlaying) stopAudioVisualizerDemo()
                else startAudioVisualizerDemo()
                setAudioDemoPlaying(value => !value)
              }}>{audioDemoPlaying ? 'Остановить демо' : 'Запустить демо'}</button>
            </Field>
          </>
        )}
      </Group>

      <Group id="appearance-accent" icon="sparkles" title="Акцент">
      <Field id="accentColor" label="Цвет акцента" description="Дополнительный акцент поверх темы">
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
            <motion.div
              key="accent-picker"
              ref={accentPickerRef}
              className="settings-accent-popover"
              style={{ top: accentPickerPos.top, left: accentPickerPos.left }}
              initial={{ opacity: 0, scale: 0.9, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: -8 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              onPointerDown={e => e.stopPropagation()}
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
          )}
        </AnimatePresence>,
        document.body
      )}

      <Field id="rainbowAccent" label="Радужный акцент" description="Accent медленно циклит по всем цветам">
        <Toggle value={!!rainbowAccent} onChange={v => onSet('rainbowAccent', v)} />
      </Field>

      <Field id="accentGradient" label="Градиентный акцент" description="Accent как градиент из двух цветов">
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
      </Group>

      <Group id="appearance-typography" icon="fileText" title="Типографика">
      <FontSettingsBlock settings={settings} onSet={onSet} />

      <Field id="fontSizeUI" label="Размер шрифта интерфейса" description={`${fontSizeUI}px — масштаб всего UI (меню, кнопки, настройки)`}>
        <input
          type="range" min={12} max={17} step={0.5} value={fontSizeUI}
          onChange={e => onSet('fontSizeUI', Number(e.target.value))}
          className="settings-slider"
        />
      </Field>

      <Field id="fontSizeChat" label="Размер шрифта сообщений" description={`${fontSizeChat}px — текст сообщений в чате`}>
        <input
          type="range" min={12} max={18} step={0.5} value={fontSizeChat}
          onChange={e => onSet('fontSizeChat', Number(e.target.value))}
          className="settings-slider"
        />
      </Field>

      <Field id="density" label="Плотность интерфейса" description="Отступы и размеры элементов">
        <SegmentedControl
          value={(settings['density'] as string) || 'comfortable'}
          onChange={v => onSet('density', v)}
          options={[
            { value: 'compact', label: 'Компактно' },
            { value: 'comfortable', label: 'Комфорт' },
            { value: 'spacious', label: 'Просторно' },
          ]}
        />
      </Field>
      </Group>

      <Group id="appearance-bg" icon="image" title="Фон">
      <Field id="glassBlur" label="Стекло (Glass blur)" description={`${settings['glassBlur'] ?? 20}px — размытие Liquid Glass`}>
        <input
          type="range" min={0} max={40} value={(settings['glassBlur'] as number) ?? 20}
          onChange={e => onSet('glassBlur', Number(e.target.value))}
          className="settings-slider"
        />
      </Field>

      <Field id="bgStyle" label="Стиль фона" description="Анимация на заднем плане" block>
        <div className="settings-bg-grid">
          {BG_STYLES.map(s => (
            <motion.button
              key={s.id}
              className={`settings-bg-btn ${(settings['bgStyle'] || 'aurora') === s.id ? 'settings-bg-btn--active' : ''}`}
              onClick={() => { onSet('bgStyle', s.id); onSet('animatedBackground', s.id !== 'none') }}
              whileTap={{ scale: 0.94 }}
              title={s.desc}
            >
              <AppIcon name={s.icon} size="sm" />
              <span className="settings-bg-label">{s.label}</span>
            </motion.button>
          ))}
          {/* Фоны от плагинов (registerBackground) */}
          {collectPluginBackgrounds().map(b => (
            <motion.button
              key={b.key}
              className={`settings-bg-btn settings-bg-btn--plugin ${(settings['bgStyle']) === b.key ? 'settings-bg-btn--active' : ''}`}
              onClick={() => { onSet('bgStyle', b.key); onSet('animatedBackground', true) }}
              whileTap={{ scale: 0.94 }}
              title={`Фон плагина: ${b.pluginId} (${b.kind})`}
            >
              <AppIcon name={(({ shader: 'sparkle', video: 'image', image: 'image' })[b.kind] as Parameters<typeof AppIcon>[0]['name']) || 'image'} size="sm" />
              <span className="settings-bg-label">{b.name}</span>
            </motion.button>
          ))}
        </div>
        <AnimatedBgGear settings={settings} onSet={onSet} />
        {!isWebgl2Available() && (
          <div className="settings-info-note">
            ⚠️ WebGL2 недоступен — анимированный фон отключён.
          </div>
        )}
      </Field>

      <Field label="Фоновое изображение" description="Картинка как фон (под анимацией). Несколько картинок, переключение, параметры." block>
        <BgImageGallery onSet={onSet} />
      </Field>
      </Group>

      <Group id="appearance-messages" icon="messageSquare" title="Сообщения">
      <Field id="msgAnim" label="Анимация сообщений" description="Наведи на карточку чтобы увидеть превью" block>
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

      <Field id="avatarStyle" label="Аватар ассистента" description="Иконка рядом с ответами">
        <div className="settings-theme-grid">
          {AVATAR_STYLES.map(a => (
            <motion.button
              key={a.id}
              className={`settings-theme-btn ${(settings['avatarStyle'] || 'hex') === a.id ? 'settings-theme-btn--active' : ''}`}
              style={{ background: 'var(--bg-tertiary)', fontSize: 12 }}
              onClick={() => onSet('avatarStyle', a.id)}
              whileTap={{ scale: 0.94 }}
            >
              <span className="settings-avatar-opt">
                {a.icon
                  ? <AppIcon name={a.icon} size="xs" tone="muted" />
                  : <span className="settings-avatar-letter">S</span>}
                {a.label}
              </span>
            </motion.button>
          ))}
        </div>
      </Field>

      <Field id="showTime" label="Время сообщений" description="Когда показывать время рядом с сообщением">
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

      <Field id="userMarkdown" label="Markdown в своих сообщениях" description="Рендерить жирный, курсив, код в ваших сообщениях">
        <Toggle value={!!(settings['userMarkdown'])} onChange={v => onSet('userMarkdown', v)} />
      </Field>

      <Field id="sendEffect" label="Эффект отправки" description="Ripple-вспышка на кнопке при отправке">
        <Toggle value={settings['sendEffect'] !== false} onChange={v => onSet('sendEffect', v)} />
      </Field>
      </Group>

      <Group id="appearance-sounds" icon="volume" title="Звуки">
      <SoundsPanel settings={settings} onSet={onSet} />
      </Group>
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
      <SectionTitle description="Голосовая активация и озвучка ответов">Голос</SectionTitle>

      <Group id="voice-output" icon="volume" title="Голосовой вывод">
        <Field id="wakeWord" label="Wake word" description="Слово для активации голосового режима">
          <input className="settings-input" value={(settings['wakeWord'] as string) || 'синти'} onChange={e => onSet('wakeWord', e.target.value)} />
        </Field>
        <Field id="voiceId" label="Голос ассистента">
          <Select
            value={(settings['voiceId'] as string) || 'alloy'}
            onChange={v => onSet('voiceId', v)}
            options={['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map(v => ({ value: v, label: v }))}
          />
        </Field>
      </Group>

      <SectionTitle description="Движок для кнопки микрофона в строке ввода">Голосовой ввод в чате</SectionTitle>

      <Group id="voice-stt" icon="mic" title="Распознавание речи">
        <Field id="sttProvider" label="Провайдер STT">
          <Select
            value={sttProvider}
            onChange={v => onSet('sttProvider', v)}
            options={[
              { value: 'local', label: 'Локальный Whisper', hint: 'оффлайн, без лимитов' },
              { value: 'groq', label: 'Groq Whisper API', hint: 'нужен ключ' },
            ]}
          />
        </Field>
        {sttProvider === 'local' && (
          <>
            <Field id="sttModelSize" label="Размер модели Whisper" description="Меньше — быстрее и экономнее. tiny по умолчанию, base точнее на русском.">
              <Select
                value={sttModelSize}
                onChange={v => onSet('sttModelSize', v)}
                options={[
                  { value: 'tiny', label: 'tiny', hint: '~40MB, быстро — рекомендуется' },
                  { value: 'base', label: 'base', hint: '~140MB, точнее на русском' },
                ]}
              />
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
          <Field id="groqApiKey" label="Groq API key" description="Ключ с console.groq.com/keys. Хранится локально, отправляется только на api.groq.com.">
            <input className="settings-input" type="password" value={(settings['groqApiKey'] as string) || ''} onChange={e => onSet('groqApiKey', e.target.value)} placeholder="gsk_..." />
          </Field>
        )}
      </Group>

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
  silk: [
    { key: 'silk.scale', label: 'Масштаб', min: 2, max: 8, step: 0.5, def: 4, fmt: v => v.toFixed(1) },
  ],
  warp: [
    { key: 'warp.amount', label: 'Интенсивность', min: 0.5, max: 3, step: 0.1, def: 1.5, fmt: v => v.toFixed(1) },
  ],
  nebula: [
    { key: 'nebula.scale', label: 'Масштаб', min: 2, max: 6, step: 0.5, def: 3, fmt: v => v.toFixed(1) },
  ],
  plasma: [
    { key: 'plasma.scale', label: 'Масштаб', min: 3, max: 10, step: 0.5, def: 6, fmt: v => v.toFixed(1) },
  ],
  caustics: [
    { key: 'caustics.scale', label: 'Масштаб', min: 3, max: 10, step: 0.5, def: 5, fmt: v => v.toFixed(1) },
  ],
  network: [
    { key: 'network.count', label: 'Количество', min: 20, max: 100, step: 5, def: 100 },
    { key: 'network.linkDist', label: 'Радиус связи', min: 0.05, max: 0.30, step: 0.01, def: 0.15, fmt: v => v.toFixed(2) },
  ],
  vortex: [
    { key: 'vortex.scale', label: 'Плотность спиралей', min: 2, max: 8, step: 0.5, def: 4, fmt: v => v.toFixed(1) },
  ],
  flow: [
    { key: 'flow.scale', label: 'Масштаб потока', min: 3, max: 10, step: 0.5, def: 5, fmt: v => v.toFixed(1) },
  ],
  crystal: [
    { key: 'crystal.scale', label: 'Размер ячеек', min: 3, max: 10, step: 0.5, def: 5, fmt: v => v.toFixed(1) },
  ],
  magma: [
    { key: 'magma.size', label: 'Размер капель', min: 3, max: 8, step: 0.5, def: 5, fmt: v => v.toFixed(1) },
  ],
  interference: [
    { key: 'interference.scale', label: 'Длина волны', min: 5, max: 20, step: 0.5, def: 10, fmt: v => v.toFixed(1) },
  ],
  hexgrid: [
    { key: 'hexgrid.scale', label: 'Размер сот', min: 2, max: 8, step: 0.5, def: 4, fmt: v => v.toFixed(1) },
  ],
  oil: [
    { key: 'oil.scale', label: 'Масштаб', min: 2, max: 6, step: 0.5, def: 3.5, fmt: v => v.toFixed(1) },
  ],
  solar: [
    { key: 'solar.scale', label: 'Размер гранул', min: 2, max: 8, step: 0.5, def: 4, fmt: v => v.toFixed(1) },
  ],
  dream: [
    { key: 'dream.scale', label: 'Масштаб', min: 1, max: 4, step: 0.5, def: 2, fmt: v => v.toFixed(1) },
  ],
  smoke: [
    { key: 'smoke.scale', label: 'Плотность', min: 2, max: 8, step: 0.5, def: 4, fmt: v => v.toFixed(1) },
  ],
  tide: [
    { key: 'tide.waves', label: 'Волны', min: 2, max: 6, step: 1, def: 3 },
  ],
}

// Гирька параметров анимированного фона: пер-стиль + прозрачность + скорость.
function AnimatedBgGear({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const [open, setOpen] = useState(false)
  const gearRef = useRef<HTMLButtonElement>(null)
  const opacity = (settings['animatedBgOpacity'] as number) ?? 60
  const speed = (settings['animatedBgSpeed'] as number) ?? 1
  const bgStyle = (settings['bgStyle'] as string) || 'aurora'
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
            <input type="range" min={0.05} max={1.5} step={0.05} value={speed}
              onChange={e => onSet('animatedBgSpeed', Number(e.target.value))}
              className="settings-slider" />
          </label>
        </div>
      </Popover>
    </div>
  )
}

// Статические данные для секции хоткеев — вынесены за компонент,
// чтобы не пересоздавались каждый рендер и не попадали в deps useMemo.
// icon — имя иконки из AppIcon (раньше были эмодзи 🪟🔍⚡ — выглядело чужеродно).
type HkGroup = { title: string; icon: IconName; note?: string; items: { id: keyof typeof DEFAULT_HOTKEYS; label: string; desc: string; icon: IconName }[] }
const HK_GROUPS: HkGroup[] = [
  {
    title: 'Окна',
    icon: 'layers',
    items: [
      { id: 'mainWindow',    label: 'Открыть/скрыть окно',  desc: 'Показать или скрыть главное окно Syntee',          icon: 'appWindow' },
      { id: 'overlay',       label: 'Оверлей',              desc: 'Circle to Search — выделение области экрана',     icon: 'search' },
      { id: 'spotlight',     label: 'Spotlight',            desc: 'Быстрая строка запроса в один клик',              icon: 'zap' },
    ],
  },
  {
    title: 'Действия',
    icon: 'bot',
    items: [
      { id: 'voice',         label: 'Голосовой режим',      desc: 'Открыть окно голосового ввода',                   icon: 'mic' },
      { id: 'quickQuestion', label: 'Быстрый вопрос',       desc: 'Задать вопрос без открытия главного окна',        icon: 'messageCircle' },
    ],
  },
  {
    title: 'В приложении',
    icon: 'messageSquare',
    note: 'только в приложении',
    items: [
      { id: 'chatAskMode',      label: 'Режим чтения',        desc: 'Read-only: ответы без правок кода. Ctrl+1 когда панель закрыта',  icon: 'eye' },
      { id: 'chatPlanningMode', label: 'Режим планирования',  desc: 'Read-only research → ответ в <plan>. Ctrl+2 когда панель закрыта', icon: 'listChecks' },
    ],
  },
]
const HK_ALL_IDS = HK_GROUPS.flatMap(g => g.items.map(i => i.id))

const HotkeysSection = memo(function HotkeysSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const hotkeys = (settings['hotkeys'] as Record<string, string>) || {}
  // Ref чтобы effect keydown/keyup не ре-подписывался при каждом изменении
  // settings (hotkeys меняется → новый ref → effect teardown+resubscribe).
  // Обновляем ref в effect после рендера — не во время (react-hooks/refs).
  const hotkeysRef = useRef(hotkeys)
  useEffect(() => { hotkeysRef.current = hotkeys })
  const [recording, setRecording] = useState<string | null>(null)
  const [pressed, setPressed] = useState<string>('')

  // Проверка конфликтов: одинаковые комбинации у разных хоткеев.
  // conflictMap — id → конфликтует ли; conflictCombos — сами комбинации
  // (для баннера: «Конфликтуют: Ctrl+K, Ctrl+1»).
  const { conflictMap, conflictCombos } = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const id of HK_ALL_IDS) {
      const bind = hotkeys[id]
      if (!bind) continue
      if (!map[bind]) map[bind] = []
      map[bind].push(id)
    }
    // Оставить только конфликты (2+ хоткея с одинаковой комбинацией)
    const conflicts: Record<string, boolean> = {}
    const combos: string[] = []
    for (const [bind, ids] of Object.entries(map)) {
      if (ids.length > 1) {
        combos.push(bind)
        for (const id of ids) conflicts[id] = true
      }
    }
    return { conflictMap: conflicts, conflictCombos: combos }
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
      <SectionTitle description="Глобальные комбинации клавиш и хоткеи в приложении">
        Горячие клавиши
      </SectionTitle>
      {hasCustom && (
        <motion.button
          className="settings-reset-link"
          onClick={handleReset}
          whileHover={whileHoverSm}
          whileTap={whileTapSm}
          transition={springHover}
          title="Сбросить все хоткеи к значениям по умолчанию"
        >
          <AppIcon name="refreshCw" size="xs" />
          <span>Сбросить к умолчаниям</span>
        </motion.button>
      )}

      {conflictCombos.length > 0 && (
        <div className="hk-conflict-banner">
          <AppIcon name="alertTriangle" size="sm" />
          <span>
            Конфликт{conflictCombos.length > 1 ? 'уют' : 'ует'} ({conflictCombos.length}):{' '}
            <strong>{conflictCombos.join(', ')}</strong>{' '}
            — сработает только первое действие.
          </span>
        </div>
      )}

      {HK_GROUPS.map(group => (
        <Group key={group.title} id={`hotkeys-${group.title}`} icon={group.icon} title={group.title} note={group.note}>
          <div className="hk-list">
            {group.items.map(k => {
              const isConflict = !!conflictMap[k.id]
              return (
                <div key={k.id} className={`hk-row${isConflict ? ' hk-row--conflict' : ''}`} data-field-id={`hk-${k.id}`}>
                  <div className="hk-info">
                    <span className="hk-icon"><AppIcon name={k.icon} size="sm" tone="muted" /></span>
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
                      <motion.button className="hk-clear" onClick={() => onSet('hotkeys', { ...hotkeys, [k.id]: '' })} title="Очистить" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}><AppIcon name="x" size="xs" /></motion.button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </Group>
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

  const OUTPUT_MODES = [
    { value: 'compact',  label: 'Компактный', desc: 'Только иконки инструментов в одну строку' },
    { value: 'normal',   label: 'Обычный',    desc: 'Название + первый аргумент каждого шага' },
    { value: 'detailed', label: 'Подробный',  desc: 'Все аргументы и результаты, раскрываются' },
  ]

  return (
    <>
      <SectionTitle description="Поведение агента и лимиты циклов">
        Агент
      </SectionTitle>

      <Group id="agent-behavior" icon="bot" title="Поведение">
        <Field id="enableThinking" label="Режим размышлений" description="AI показывает ход своих мыслей перед ответом — цепочка рассуждений видна в свёрнутом блоке">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Toggle value={agentSettings.enableThinking} onChange={v => updateAgent({ enableThinking: v })} />
            <ResetButton current={agentSettings.enableThinking} defaultValue={DEFAULT_AGENT_SETTINGS.enableThinking} onReset={() => updateAgent({ enableThinking: DEFAULT_AGENT_SETTINGS.enableThinking })} />
          </div>
        </Field>

        <Field id="toolOutputMode" label="Вывод инструментов" description="Как отображать цепочку действий агента в чате">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <SegmentedControl
              value={agentSettings.toolOutputMode}
              onChange={v => updateAgent({ toolOutputMode: v as SharedAgentSettings['toolOutputMode'] })}
              options={OUTPUT_MODES.map(m => ({ value: m.value, label: m.label }))}
            />
            <ResetButton current={agentSettings.toolOutputMode} defaultValue={DEFAULT_AGENT_SETTINGS.toolOutputMode} onReset={() => updateAgent({ toolOutputMode: DEFAULT_AGENT_SETTINGS.toolOutputMode })} />
          </div>
        </Field>
      </Group>

      <Group id="agent-limits" icon="shield" title="Лимиты и защита от циклов">
        <Field id="maxParallelSubAgents" label="Параллельных суб-агентов" description="Сколько дочерних агентов можно держать активными одновременно">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Stepper
              value={agentSettings.maxParallelSubAgents}
              onChange={v => updateAgent({ maxParallelSubAgents: v })}
              values={[5, 6, 7, 8, 9, 10]}
            />
            <ResetButton current={agentSettings.maxParallelSubAgents} defaultValue={DEFAULT_AGENT_SETTINGS.maxParallelSubAgents} onReset={() => updateAgent({ maxParallelSubAgents: DEFAULT_AGENT_SETTINGS.maxParallelSubAgents })} />
          </div>
        </Field>

        <Field id="autoMemoryInterval" label="Автосохранение рабочей памяти" description="Через сколько шагов агент обновляет working memory во время длинной сессии">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Stepper
              value={agentSettings.autoMemoryInterval}
              onChange={v => updateAgent({ autoMemoryInterval: v })}
              values={[0, 3, 5, 8, 12]}
              format={n => (n === 0 ? 'выкл' : `${n} ${n === 3 ? 'шага' : 'шагов'}`)}
            />
            <ResetButton current={agentSettings.autoMemoryInterval} defaultValue={DEFAULT_AGENT_SETTINGS.autoMemoryInterval} onReset={() => updateAgent({ autoMemoryInterval: DEFAULT_AGENT_SETTINGS.autoMemoryInterval })} />
          </div>
        </Field>

        <Field id="maxRepeatedToolCalls" label="Повтор одного и того же tool-call" description="После этого количества одинаковых вызовов агент получает защиту от зацикливания">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Stepper
              value={agentSettings.maxRepeatedToolCalls}
              onChange={v => updateAgent({ maxRepeatedToolCalls: v })}
              values={[2, 3, 4, 5]}
            />
            <ResetButton current={agentSettings.maxRepeatedToolCalls} defaultValue={DEFAULT_AGENT_SETTINGS.maxRepeatedToolCalls} onReset={() => updateAgent({ maxRepeatedToolCalls: DEFAULT_AGENT_SETTINGS.maxRepeatedToolCalls })} />
          </div>
        </Field>

        <Field id="maxRepeatedErrors" label="Повтор одной и той же ошибки" description="Если инструмент падает одинаково несколько раз подряд, агенту запрещается тупо повторять вызов">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Stepper
              value={agentSettings.maxRepeatedErrors}
              onChange={v => updateAgent({ maxRepeatedErrors: v })}
              values={[2, 3, 4]}
            />
            <ResetButton current={agentSettings.maxRepeatedErrors} defaultValue={DEFAULT_AGENT_SETTINGS.maxRepeatedErrors} onReset={() => updateAgent({ maxRepeatedErrors: DEFAULT_AGENT_SETTINGS.maxRepeatedErrors })} />
          </div>
        </Field>
      </Group>
    </>
  )
})

// ── Безопасность: режим подтверждений + гранулярные настройки авто-режима ──
// Вынесено из AgentSection в отдельную категорию настроек (§security-section).
// Быстрый доступ к тем же значениям — шестерёнка в ApprovalModeSelector в чате.
const SecuritySection = memo(function SecuritySection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
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

  // Гранулярные настройки авто-режима (глобальный scope; per-project —
  // в панели ApprovalModeSelector в чате). Мерж с дефолтами для UI.
  const autoPerms: AutoModeSettings = { ...DEFAULT_AUTO_MODE_SETTINGS, ...((perms['autoMode'] as Partial<AutoModeSettings>) || {}) }
  const setAutoPerm = (patch: Partial<AutoModeSettings>) =>
    onSet('agentPermissions', { ...perms, autoMode: { ...autoPerms, ...patch } })

  return (
    <>
      <SectionTitle description="Подтверждения действий агента и защита от опасных операций">
        Безопасность
      </SectionTitle>

      <Group id="security-mode" icon="shield" title="Режим подтверждения">
        <Field id="approvalMode" label="Режим подтверждения действий" description="Когда агент запрашивает подтверждение перед выполнением">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ApprovalModeSelector
              value={agentSettings.approvalMode as import('../../../../shared/types').ApprovalMode}
              onChange={mode => { if (mode) updateAgent({ approvalMode: mode }) }}
              globalAuto={autoPerms}
              onAutoChange={patch => setAutoPerm(patch)}
            />
            <ResetButton current={agentSettings.approvalMode} defaultValue={DEFAULT_AGENT_SETTINGS.approvalMode} onReset={() => updateAgent({ approvalMode: DEFAULT_AGENT_SETTINGS.approvalMode })} />
          </div>
        </Field>
      </Group>

      <Group id="security-auto" icon="zap" title="Авто-режим: что спрашивать" note="действует при режиме «Авто»">
        <Field id="autoAskOnDangerous" label="Опасные действия" description="Удаление файлов, реестр, force push — спрашивать в авто-режиме">
          <Toggle value={autoPerms.askOnDangerous} onChange={v => setAutoPerm({ askOnDangerous: v })} />
        </Field>

        <Field id="autoAskOnWarn" label="Потенциально опасные" description="chmod, планировщик задач, eval — спрашивать в авто-режиме">
          <Toggle value={autoPerms.askOnWarn} onChange={v => setAutoPerm({ askOnWarn: v })} />
        </Field>

        <Field id="autoAskGitPush" label="Git push" description="Отправка в удалённый репозиторий — спрашивать в авто-режиме">
          <Toggle value={autoPerms.askGitPush} onChange={v => setAutoPerm({ askGitPush: v })} />
        </Field>

        <Field id="autoNetworkPolicy" label="Сетевые команды" description="Умно: пакеты из официальных реестров (npm/pip/winget) — без вопроса; произвольные URL, ssh и публикация — спрашивать">
          <div style={{ display: 'flex', gap: 4 }}>
            {([
              { v: 'ask-all', l: 'Спрашивать всё' },
              { v: 'smart', l: 'Умно' },
              { v: 'off', l: 'Не спрашивать' },
            ] as Array<{ v: NetworkPolicy; l: string }>).map(o => (
              <button
                key={o.v}
                className={`settings-chip-btn ${autoPerms.networkPolicy === o.v ? 'settings-chip-btn--active' : ''}`}
                onClick={() => setAutoPerm({ networkPolicy: o.v })}
              >{o.l}</button>
            ))}
          </div>
        </Field>

        <Field id="autoAskOutsideWorkdir" label="Вне папки проекта" description="Правка файлов и команды вне workdir чата — спрашивать в авто-режиме">
          <Toggle value={autoPerms.askOutsideWorkdir} onChange={v => setAutoPerm({ askOutsideWorkdir: v })} />
        </Field>

        <Field id="autoCodeModePolicy" label="Code Mode: внутренние вызовы" description="Определяет, как спрашивать разрешение для инструментов, вызванных TypeScript-программой">
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {([
              { v: 'inherit', l: 'Обычная политика' },
              { v: 'ask', l: 'Спрашивать' },
              { v: 'read-only', l: 'Только чтение' },
            ] as const).map(o => (
              <button
                key={o.v}
                className={`settings-chip-btn ${autoPerms.codeModePolicy === o.v ? 'settings-chip-btn--active' : ''}`}
                onClick={() => setAutoPerm({ codeModePolicy: o.v })}
              >{o.l}</button>
            ))}
          </div>
        </Field>
      </Group>

      <Group id="security-allowlist" icon="check" title="Всегда разрешать" note="правила из кнопки «Всегда разрешать» в диалоге подтверждения">
        <Field id="approvalAllowlist" label="Разрешённые команды и пути" description="Не требуют подтверждения в авто-режиме (кроме опасных действий). Опасные (dangerous) действия разрешить навсегда нельзя.">
          {(() => {
            const entries = (perms['approvalAllowlist'] as ApprovalAllowlistEntry[]) || []
            if (entries.length === 0) {
              return <div className="settings-hint">Пока пусто — при следующем подтверждении отметь «Всегда разрешать»</div>
            }
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                {entries.map((e, i) => (
                  <div key={`${e.tool}-${e.pattern}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="settings-allowlist-tool">{e.tool === 'run_command' ? '$' : e.tool === 'write_file' ? 'W' : 'E'}</span>
                    <code className="settings-allowlist-pattern" title={e.pattern}>{e.pattern}</code>
                    <span className="settings-allowlist-scope">{e.scope === 'global' ? 'всегда' : e.scope === 'project' ? 'проект' : 'чат'}</span>
                    <button
                      className="settings-allowlist-del"
                      title="Удалить правило"
                      onClick={() => onSet('agentPermissions', { ...perms, approvalAllowlist: entries.filter((_, j) => j !== i) })}
                    >✕</button>
                  </div>
                ))}
              </div>
            )
          })()}
        </Field>
      </Group>

      <Group id="security-sandbox" icon="lock" title="Песочница">
        <Field id="forbiddenPaths" label="Запрещённые папки" description="Через запятую — агент не трогает эти пути">
          <input
            className="settings-input"
            value={((perms['forbiddenPaths'] as string[]) || []).join(', ')}
            onChange={e => onSet('agentPermissions', { ...perms, forbiddenPaths: e.target.value.split(',').map(s => s.trim()) })}
            placeholder="C:\Windows, C:\..."
          />
        </Field>
      </Group>
    </>
  )
})

const IntegrationsSection = memo(function IntegrationsSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const integrations = (settings['integrations'] as Record<string, Record<string, string>>) || {}
  return (
    <>
      <SectionTitle description="Ключи внешних сервисов — хранятся локально на вашем ПК">
        Интеграции
      </SectionTitle>

      <Group id="integrations-keys" icon="link" title="Ключи и токены">
        <Field id="tavilyKey" label="Tavily API ключ" description="Для поиска в интернете">
          <input className="settings-input" type="password"
            value={integrations['tavily']?.key || ''}
            onChange={e => onSet('integrations', { ...integrations, tavily: { ...integrations['tavily'], key: e.target.value } })}
            placeholder="tvly-..."
          />
        </Field>
        <Field id="telegramToken" label="Telegram Bot Token" description="Бот для связи с мессенджером">
          <input className="settings-input" type="password"
            value={integrations['telegram']?.token || ''}
            onChange={e => onSet('integrations', { ...integrations, telegram: { ...integrations['telegram'], token: e.target.value } })}
            placeholder="123456:ABC..."
          />
        </Field>
        <Field id="githubToken" label="GitHub Token" description="Доступ к репозиториям и API">
          <input className="settings-input" type="password"
            value={integrations['github']?.token || ''}
            onChange={e => onSet('integrations', { ...integrations, github: { ...integrations['github'], token: e.target.value } })}
            placeholder="ghp_..."
          />
        </Field>
        <Field id="spotifyClientId" label="Spotify Client ID" description="Управление воспроизведением музыки">
          <input className="settings-input"
            value={integrations['spotify']?.clientId || ''}
            onChange={e => onSet('integrations', { ...integrations, spotify: { ...integrations['spotify'], clientId: e.target.value } })}
            placeholder="Client ID..."
          />
        </Field>
      </Group>
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
      <SectionTitle description="База данных, бэкапы и управление историей">
        Данные и Память
      </SectionTitle>

      <Group id="data-backup" icon="database" title="Бэкапы и экспорт">
        <Field id="backupEnabled" label="Автобэкап" description="Ежедневная копия базы данных">
          <Toggle value={!!settings['backupEnabled']} onChange={v => onSet('backupEnabled', v)} />
        </Field>
        <Field id="exportHistory" label="Экспорт истории" description="Выгрузка переписки в файл">
          <div style={{ display: 'flex', gap: 8 }}>
            {['JSON', 'Markdown', 'TXT'].map(fmt => (
              <motion.button key={fmt} className="settings-btn" whileTap={{ scale: 0.95 }}
                onClick={() => toast(`Экспорт ${fmt} — будет готово в стадии 09`, 'info')}>
                {fmt}
              </motion.button>
            ))}
          </div>
        </Field>
      </Group>

      <Group id="data-danger" icon="alertTriangle" title="Опасная зона" note="действие необратимо">
        <Field id="clearHistory" label="Очистить историю чатов" description="Удалит все переписки из базы данных">
          <ConfirmButton
            label="Очистить"
            onConfirm={() => toast('Очистка истории — будет в стадии 09', 'info')}
          />
        </Field>
        <Field id="clearMemory" label="Очистить память Syntee" description="Полный сброс долгосрочной памяти ассистента">
          <ConfirmButton
            label="Сбросить память"
            onConfirm={() => toast('Очистка памяти — будет в стадии 07', 'info')}
          />
        </Field>
      </Group>
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
  { id: 'git_sync', label: 'Git Sync Monitor' },
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
      <SectionTitle description="Overlay-уведомления и информер активности агента">
        Уведомления
      </SectionTitle>

      <Group id="notifications-general" icon="bell" title="Общие">
        <Field id="notifEnabled" label="Показывать уведомления" description="Глобальный вкл/выкл overlay-уведомлений">
          <Toggle value={notifConfig.enabled} onChange={toggleGlobal} />
        </Field>
      </Group>

      {notifConfig.enabled && (
        <Group id="notifications-types" icon="messageCircle" title="Типы уведомлений" note="что и когда показывать">
          {NOTIF_TYPES.map(({ id, label }) => {
            const typeConfig = notifConfig.types?.[id] ?? { enabled: true, showWhen: 'inactive' }
            return (
              <Field key={id} label={label} description="Включить и выбрать когда показывать">
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <Toggle
                    value={typeConfig.enabled}
                    onChange={(v) => updateType(id, 'enabled', v)}
                  />
                  <Select
                    value={typeConfig.showWhen}
                    onChange={(v) => updateType(id, 'showWhen', v)}
                    options={[
                      { value: 'inactive', label: SHOW_WHEN_LABELS.inactive },
                      { value: 'minimized', label: SHOW_WHEN_LABELS.minimized },
                      { value: 'always', label: SHOW_WHEN_LABELS.always },
                    ]}
                    minWidth={200}
                  />
                </div>
              </Field>
            )
          })}
        </Group>
      )}

      <Group id="notifications-activity" icon="zap" title="Информер активности">
        <Field
          id="activityMonitor"
          label="Показывать активность ИИ"
          description="Компактный индикатор что делает агент (думает / вызывает тул), пока окно неактивно или свёрнуто"
        >
          <Toggle value={activityConfig.enabled} onChange={toggleActivity} />
        </Field>
      </Group>
    </>
  )
})


