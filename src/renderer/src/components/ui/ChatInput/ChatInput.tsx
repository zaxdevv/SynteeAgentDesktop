import { useState, useRef, useEffect, memo, useCallback, KeyboardEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ApprovalModeSelector from '../ApprovalModeSelector/ApprovalModeSelector'
import ContextRing from '../ContextRing/ContextRing'
import AttachmentPreviewModal from '../AttachmentPreviewModal/AttachmentPreviewModal'
import { ProtectedVarsModal } from '../ProtectedVarsModal/ProtectedVarsModal'
import { filterCommands, resolveSlashContext, getCommandArguments } from '../../../../../shared/slashCommands'
import type { SlashCommand } from '../../../../../shared/slashCommands'
import { findMentionTokenNearCaret, mentionToAttachment } from '../../../../../shared/mentions'
import type { Attachment, MentionItem, ApprovalMode, AutoModeSettings, LastTurnChanges, ProjectPermissionOverride } from '../../../../../shared/types'
import type { OrchestrationModel, OrchestrationSelection } from '../../../../../shared/orchestration'
import { validateOrchestration, type OrchestrationIssueText } from '../../../utils/orchestration'
import type { ContextInfo } from '../../../hooks/useContextCounter'
import { useUIStore } from '../../../store/ui.store'
import { useSettingsStore } from '../../../store/settings.store'
import { useChatStore } from '../../../store/chat.store'
import { tabActions } from '../../../store/tabs.store'
import { playSendSound, playSteerSound } from '../../../utils/sounds'
import { useChatInputVoice } from './useChatInputVoice'
import { useChatInputAttachments } from './useChatInputAttachments'
import { ChatInputStatusRow } from './ChatInputStatusRow'
import { ChatInputPlusMenu } from './ChatInputPlusMenu'
import { ChatInputActionButton, STEER_HOLD_MS } from './ChatInputActionButton'
import { ChatInputEditor, type EditorApi } from './ChatInputEditor'
import { ChatInputMenus } from './ChatInputMenus'
import OrchestrationBar from './OrchestrationBar'
import { AudioVisualizerLayer } from './AudioVisualizerLayer'
import { PluginInputActions } from './PluginInputActions'
import ChatActivityStrip from '../ActivityStrip/ChatActivityStrip'
import { getPluginsExt, type PluginAutoResult } from '../../../utils/pluginExtApi'
import { ATTACH_TOKEN_RE, stripAttachTokens } from '../../../../../shared/attachmentMarkdown'
import './ChatInput.css'

interface ChatInputProps {
  /** ID текущего чата — для панели очереди запросов. */
  chatId?: string
  onSend: (text: string) => void
  /**
   * §steer — внедрить текст в контекст РАБОТАЮЩЕГО агента (long-press кнопки
   * отправки 0,5с). Без колбэка удержание выключено, клик работает как раньше.
   * Второй аргумент — вложения чипов (текст с [[attach:id]]-токенами уходит
   * как есть: main чистит токены и инлайнит файлы в контекст).
   */
  onSteer?: (text: string, attachments: Attachment[]) => void
  disabled?: boolean
  isIncognito?: boolean
  /** Реплаи в инпуте: Message[] из state чата (роль шире — 'system' тоже
   *  допускаем структурно) либо ReplyTarget[]. attachmentsCount — индикатор 📎. */
  replyTo?: Array<{ id: string; role: string; content: string; attachmentsCount?: number }>
  onCancelReply?: (id: string) => void
  isGenerating?: boolean
  onStop?: () => void
  contextInfo?: ContextInfo | null
  showContextRing?: boolean
  /** ВНЕШНЕЕ значение поля ввода (черновик). Родитель держит его как
   *  «снимок»: смена чата (черновик из БД), очистка после отправки, голос,
   *  программная подстановка. Набор текста сюда НЕ идёт — ChatInput держит
   *  живой текст локально и сообщает его через onChangeValue (иначе ре-рендер
   *  всей страницы чата на каждый символ). */
  value: string
  /** Колбэк на каждое изменение текста (локальный стейт + персист). */
  onChangeValue: (text: string) => void
  /** История предыдущих запросов чата (DESC — самый свежий первым),
   *  уже дедуплицирована от подряд-дубликатов. Используется для навигации
   *  по стрелкам вверх/вниз когда слеш-меню закрыто. */
  inputHistory?: string[]
  mainModelId?: string
  /** Провайдер per-chat модели (для корректного бейджа ModelSelector). */
  mainModelProviderId?: string
  onMainModelChange?: (modelId: string, providerId: string) => void
  reasoningValue?: string
  onReasoningChange?: (value: string) => void
  planningMode?: boolean
  onPlanningModeChange?: (v: boolean) => void
  imageMode?: boolean
  onImageModeChange?: (v: boolean) => void
  /** Read-only режим: агент отвечает без правок кода/запуска команд.
    *  Комбинируется с imageMode (ask + image — read-only + генерация картинки).
    *  planningMode имеет приоритет (он строже — требует <plan>). */
  askMode?: boolean
  onAskModeChange?: (v: boolean) => void
  /** Тумблер «Управление браузером»: browser_* тулы для AI (правая панель). */
  browserMode?: boolean
  onBrowserModeChange?: (v: boolean) => void
  rateLimitSec?: number
  /** Рабочая директория текущего чата (режим "Код"). Показывается как
    *  бейдж над инпутом — как cwd-indicator в Codex CLI. */
  workdir?: string
  /** Статистика сжатий сессии для ContextRing (кол-во + сэкономлено токенов). */
  compactSessionStats?: { count: number; totalTokensSaved: number }
  goal?: import('../../../../../shared/types/goal').ChatGoal | null
  onGoalChange?: (goal: import('../../../../../shared/types/goal').ChatGoal | null) => void
  /** Кастомные slash-команды (из .md-файлов). Загружаются в ChatPage и
   *  прокидываются сюда для автокомплита. */
  customCommands?: SlashCommand[]
  /** Прикреплённые вложения черновика (персистятся в БД через ChatPage).
   *  ChatInput — controlled: только отображает и сообщает об изменениях. */
  attachments?: Attachment[]
  /** Колбэк изменения набора вложений (добавление/удаление чипа). ChatPage
   *  персистит в БД (debounce) и очищает после отправки. */
  onAttachmentsChange?: (attachments: Attachment[]) => void
  /** Лимит вложений (default 10). При достижении показываем warning-чип. */
  maxAttachments?: number
  /** Изменения последнего turn'а — для ChangesBadge над инпутом.
   *  null = нет правок / инкогнито / новый запрос сбросил. */
  lastTurnChanges?: LastTurnChanges | null
  /** Бейдж в live-режиме — shimmer/glow анимация, нет undo. */
  badgeLive?: boolean
  /** Колбэк открытия настроек проекта (hover-поповер на workdir-бейдже). */
  onOpenProjectSettings?: () => void
  /** Проект текущего чата (по workdir) — открывает per-project настройки
   *  защиты в ApprovalModeSelector. null/undefined = чат без проекта. */
  projectId?: string | null
  projectName?: string
  gitSyncProjects?: import('../../../../../shared/types').GitSyncProjectState[]
  onGitSyncApply?: (projectId: string) => Promise<void>
  onGitSyncLater?: (projectId: string) => void
  onGitSyncOpenGit?: (projectId: string) => void
  /**
   * One-turn оркестрация (`/orchestrate` или «+» → Оркестрация).
   * null/undefined — выключена. Это НЕ режим: выбор живёт один ход и
   * снимается после принятой отправки (ChatPage).
   */
  orchestration?: OrchestrationSelection | null
  /** Включить оркестрацию (плюс-меню, /orchestrate). Сид выбора строит ChatPage. */
  onOrchestrationActivate?: () => void
  /** Изменить выбор в блоке / снять его (null — выключить). */
  onOrchestrationChange?: (next: OrchestrationSelection | null) => void
  /** Отказ отправки оркестрации (валидация/плагин/ошибка) — показываем в блоке. */
  orchestrationIssue?: OrchestrationIssueText | null
  /**
   * Сигнал «очисти поле» (растущий счётчик). Нужен one-turn оркестрации:
   * ChatInput в этом режиме не чистит ввод оптимистично, а ChatPage снимает
   * черновик только после принятой отправки — и только если пользователь не
   * начал печатать заново (иначе сигнал не приходит вовсе).
   */
  clearDraftToken?: number
}

// memo: ChatPage ре-рендерится ~20×/сек при стриминге и на scroll-range
// изменениях виртуализатора — без memo инпут-бар (1000+ строк JSX,
// mirror-рендер draft'а, ModelSelector) перерисовывался бы каждый раз.
// Пропсы стабилизированы в ChatPage (useCallback-хендлеры).

// ── Пороги «крупного ввода» ────────────────────────────────────────────────
// В инпут можно вставить лог/JSON/base64 на сотни КБ. Линейные проходы по
// такому тексту на каждый ввод (slash-фильтр, разбор аргументов команды,
// @mention-скан, plugin-autocomplete через IPC) не нужны и заметно подвешивают
// окно — ограничиваем их. Всё это влияет только на всплывающие меню, текст и
// черновик обрабатываются как раньше.
const SLASH_MAX_CHARS = 512        // слэш-команда длиннее — уже не команда
const ARG_PICKER_MAX_CHARS = 8192  // пикер аргументов живёт на коротком вводе
const MENTION_SCAN_CHARS = 512     // окно поиска @токена перед кареткой
const PLUGIN_AUTO_MAX_CHARS = 4096 // автокомплит плагинов не шлём мегабайты

function ChatInput({
  chatId,
  onSend, onSteer, disabled, isIncognito,
  goal, onGoalChange,
  replyTo, onCancelReply,
  isGenerating, onStop,
  contextInfo, showContextRing = true,
  value, onChangeValue,
  inputHistory = [],
  mainModelId = '',
  mainModelProviderId,
  onMainModelChange,
  reasoningValue = '',
  onReasoningChange,
  planningMode = false,
  onPlanningModeChange,
  imageMode = false,
  onImageModeChange,
  askMode = false,
  onAskModeChange,
  browserMode = false,
  onBrowserModeChange,
  rateLimitSec = 0,
  workdir,
  compactSessionStats,
  customCommands = [],
  attachments = [],
  onAttachmentsChange,
  maxAttachments = 10,
  lastTurnChanges = null,
  badgeLive = false,
  onOpenProjectSettings,
  projectId,
  projectName,
  gitSyncProjects = [],
  onGitSyncApply,
  onGitSyncLater,
  onGitSyncOpenGit,
  orchestration = null,
  onOrchestrationActivate,
  onOrchestrationChange,
  orchestrationIssue = null,
  clearDraftToken = 0,
}: ChatInputProps) {
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('ask')
  // Глобальные настройки авто-режима (agentPermissions.autoMode) и проектный
  // override — для панели настроек защиты в ApprovalModeSelector.
  const [globalAuto, setGlobalAuto] = useState<Partial<AutoModeSettings>>({})
  const [projOverride, setProjOverride] = useState<ProjectPermissionOverride | null>(null)
  const [slashCmds, setSlashCmds] = useState<SlashCommand[]>([])
  const [slashIdx, setSlashIdx] = useState(0)
  // Превью вложения из чипов инпут-бара (модалка-лайтбокс)
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null)
  // ── Защищённые переменные (секреты) ──
  // protectedVarsOpen — модалка управления; secretsCount — бейдж в + меню
  // (total); secretsEnabled — бейдж в статус-строке (только включённые:
  // enabled = инжектится в system prompt).
  const [protectedVarsOpen, setProtectedVarsOpen] = useState(false)
  const [secretsCount, setSecretsCount] = useState(0)
  const [secretsEnabled, setSecretsEnabled] = useState(0)
  const refreshSecrets = useCallback(() => {
    window.syntee.protectedVars.list().then(l => {
      setSecretsCount(l.length)
      setSecretsEnabled(l.filter(v => v.enabled).length)
    }).catch(() => {})
  }, [])
  // ── Пикер аргументов команды (многоуровневый enum-пикер + free-text hint) ──
  // argPickerCmd — команда, для которой показываем пикер (null = скрыт).
  // argPickerLevel — индекс текущего аргумента в cmd.arguments.
  // argPickerChoices — отфильтрованные по префиксу опции текущего аргумента.
  //   ПУСТОЙ массив при активной команде = free-text режим: аргумент без
  //   choices — CommandArgMenu показывает подсказку-карточку.
  // argPickerIdx — выбранный индекс (как slashIdx).
  // argPrefix — частично введённый токен текущего аргумента (подсветка опций).
  const [argPickerCmd, setArgPickerCmd] = useState<SlashCommand | null>(null)
  const [argPickerLevel, setArgPickerLevel] = useState(0)
  const [argPickerChoices, setArgPickerChoices] = useState<string[]>([])
  const [argPickerIdx, setArgPickerIdx] = useState(0)
  const [argPrefix, setArgPrefix] = useState('')
  // Команда, для которой подсказку закрыли вручную (Esc/клик) — не
  // переоткрывать на каждое нажатие, пока юзер редактирует ту же команду.
  // Сбрасывается при смене команды / уходе из командного контекста.
  const argDismissedRef = useRef<string | null>(null)
  // ── @mention-меню ──
  // mentionItems — текущий список для дропдауна (fuzzy-отфильтрованный).
  // mentionIdx — выбранный индекс (как slashIdx).
  // mentionToken — {start,end,query} текущего @токена у каретки. null = меню скрыто.
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([])
  const [mentionIdx, setMentionIdx] = useState(0)
  const mentionTokenRef = useRef<{ start: number; end: number; query: string } | null>(null)
  const mentionFetchIdRef = useRef(0) // race-condition guard для асинхронных fetchей
  // Debounce IPC mentions:search (main однопоточный — на каждый символ он
  // заново собирал списки скиллов/команд + читал SQLite).
  const mentionDebounceRef = useRef<number | null>(null)
  // ── Autocomplete-провайдеры плагинов (registerAutocomplete) ──
  // pluginAuto — открытое меню: ответ провайдера + выбранный индекс.
  const [pluginAuto, setPluginAuto] = useState<{ data: PluginAutoResult; idx: number } | null>(null)
  const pluginAutoReqRef = useRef(0)
  const [sendBurst, setSendBurst] = useState(false)
  const uiSounds = useUIStore(s => s.uiSounds)
  const sendEffect = useUIStore(s => s.sendEffect)

  const textareaRef = useRef<HTMLDivElement>(null)
  const editorApiRef = useRef<EditorApi | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // ── Живой текст поля (источник истины для UI) ─────────────────────────────
  // value от родителя — ВНЕШНЕЕ значение: смена чата (черновик из БД), очистка
  // после отправки, голос, программная подстановка. Раньше родитель вызывал
  // setDraft на КАЖДЫЙ символ → ре-рендер всей страницы чата (виртуализатор,
  // ~500 строк JSX, минимап) на каждое нажатие; при стриме (20 рендеров/сек)
  // это складывалось в видимые статтеры. Теперь печать меняет только локальный
  // стейт инпут-бара, а наружу текст уходит через onChangeValue (ref + debounce
  // в БД) — страница чата при наборе не перерисовывается вообще.
  //
  // Синхронизация value → liveText строго по условиям: value реально сменился
  // (не ре-рендер с тем же значением), он не равен текущему тексту и это не эхо
  // нашего же ввода (родитель может возвращать то, что мы отдали). Иначе можно
  // затереть более свежий текст и прыгнуть кареткой. Исключение — смена chatId:
  // там value применяется безусловно (см. ниже).
  const [liveText, setLiveText] = useState(value)
  const liveTextRef = useRef(value)
  const lastEmittedRef = useRef<string | null>(null)
  const prevValuePropRef = useRef(value)
  const prevChatIdForTextRef = useRef(chatId)
  useEffect(() => {
    // Смена чата — черновик приходит из БД позже (асинхронно), и если он
    // совпадёт со «старым» значением пропа (например оба пустые), обычная
    // проверка на изменение не сработает — поле сохранило бы текст прошлого
    // чата. Поэтому на смену chatId принимаем value безусловно.
    const chatChanged = prevChatIdForTextRef.current !== chatId
    prevChatIdForTextRef.current = chatId
    const prev = prevValuePropRef.current
    prevValuePropRef.current = value
    if (!chatChanged) {
      if (value === prev) return
      if (value === liveTextRef.current) return
      if (value === lastEmittedRef.current) return
    }
    liveTextRef.current = value
    lastEmittedRef.current = null
    setLiveText(value)
  }, [value, chatId])
  // Единая точка изменения текста: локальный стейт + уведомление родителя.
  const applyLive = useCallback((next: string) => {
    liveTextRef.current = next
    lastEmittedRef.current = next
    setLiveText(next)
    onChangeValue(next)
  }, [onChangeValue])

  // ── Программная очистка поля по сигналу родителя ────────────────────────
  // Единственный путь, которым ChatPage снимает черновик one-turn оркестрации:
  // только после принятой отправки и только если пользователь не начал печатать
  // заново (иначе токен не инкрементится). value-проп для этого не годится —
  // он «снимок» и при обычном наборе не меняется.
  const prevClearTokenRef = useRef(clearDraftToken)
  useEffect(() => {
    if (clearDraftToken === prevClearTokenRef.current) return
    prevClearTokenRef.current = clearDraftToken
    if (liveTextRef.current === '') return
    applyLive('')
    setSlashCmds([])
    setMentionItems([])
    mentionTokenRef.current = null
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [clearDraftToken, applyLive])

  // ── Голосовой ввод (STT) в инпут-баре — вынесен в хук useChatInputVoice ──
  // Провайдер и размер модели читаются из персистентных настроек (electron-store).
  // 'local' — локальный Whisper (оффлайн), 'groq' — Groq API fallback.
  const { voice, isVoiceTyping, handleMicClick } = useChatInputVoice({
    value: liveText,
    onChangeValue: applyLive,
    textareaRef,
  })

  // ── Вложения (drag&drop, paste, диалог, удаление) — вынесено в хук ──
  const {
    isDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handlePaste,
    handlePasteLinks,
    handleAttachClick,
    handleRemoveAttachment,
  } = useChatInputAttachments({
    chatId,
    attachments,
    onAttachmentsChange,
    maxAttachments,
    editorApiRef,
  })

  // ── Синхронизация токенов ↔ массива вложений ──
  // Вызывается редактором ТОЛЬКО на пользовательский ввод (Backspace по чипу):
  // токен исчез из текста → вложение удаляется из массива. Файл на диске НЕ
  // трогаем (осиротевшие после отправки файлы принадлежат сообщению).
  // ВСЕ вложения (включая mention) теперь имеют токены в тексте — удаляются
  // единообразно. Старые черновики с mention-вложениями без токенов будут
  // отфильтрованы при первом же вводе (они и раньше были невидимыми).
  const handleEditorUserInput = useCallback((text: string) => {
    if (!onAttachmentsChange) return
    // Быстрый выход: в тексте нет токенов вложений → ids заведомо пуст.
    // Раньше matchAll гонялся по ВСЕЙ строке на каждый ввод: после вставки
    // мегабайтного текста это лишний проход по нему. Поведение то же —
    // при пустом ids фильтр оставляет [] (вложения-сироты удаляются).
    if (!text.includes('[[attach:')) {
      if (attachments.length > 0) onAttachmentsChange([])
      return
    }
    const ids = new Set(Array.from(text.matchAll(new RegExp(ATTACH_TOKEN_RE.source, 'g'))).map(m => m[1]))
    if (attachments.some(a => !ids.has(a.id))) {
      onAttachmentsChange(attachments.filter(a => ids.has(a.id)))
    }
  }, [attachments, onAttachmentsChange])

  // ── История навигации по стрелкам вверх/вниз ──
  // historyIdx === null — пользователь не в режиме навигации (вводит текст
  // вручную). При ArrowUp на пустом поле или в активной навигации idx
  // указывает на текущую показанную запись из inputHistory (DESC — 0 самый
  // свежий). При ручной правке сбрасывается в null.
  const historyIdxRef = useRef<number | null>(null)

  // ── §steer: удержание Enter (клавиатурный аналог удержания кнопки) ──────
  // Отпустил раньше STEER_HOLD_MS → обычная отправка (в очередь).
  // Дожал до порога → реплика внедряется в контекст работающего агента.
  const [enterHold, setEnterHold] = useState(false)
  const enterHoldTimer = useRef<number | null>(null)
  // Таймер уже сработал → keyup не должен отправлять второй раз.
  const enterSteerFired = useRef(false)

  useEffect(() => {
    window.syntee.agent.getSettings().then((s: { approvalMode: ApprovalMode }) => {
      setApprovalMode(s.approvalMode)
    }).catch(() => {})
    window.syntee.agent.getPermissions().then((p: { agentPermissions?: { autoMode?: Partial<AutoModeSettings> } }) => {
      setGlobalAuto(p.agentPermissions?.autoMode ?? {})
    }).catch(() => {})
    // Счётчики секретов: бейдж в + меню (total) + бейдж в статус-строке (enabled)
    refreshSecrets()
  }, [refreshSecrets])

  // Проектный override разрешений — перезагружается при смене проекта чата
  useEffect(() => {
    if (projectId) {
      window.syntee.agent.getProjectPermissions(projectId)
        .then((o: ProjectPermissionOverride | null) => setProjOverride(o))
        .catch(() => setProjOverride(null))
    } else {
      setProjOverride(null)
    }
  }, [projectId])

  /** Выбор режима: project-scope → override проекта, иначе глобально. */
  const handleApprovalChange = (mode: ApprovalMode | null, scope: 'global' | 'project') => {
    if (scope === 'project' && projectId) {
      const next: ProjectPermissionOverride = { ...(projOverride ?? {}) }
      if (mode) next.approvalMode = mode
      else delete next.approvalMode
      setProjOverride(next)
      window.syntee.agent.setProjectPermissions(projectId, next).catch(() => {})
    } else if (mode) {
      setApprovalMode(mode)
      window.syntee.agent.setSettings({ approvalMode: mode }).catch(() => {})
    }
  }

  /** Гранулярные настройки авто-режима в выбранном scope. */
  const handleAutoChange = (patch: Partial<AutoModeSettings>, scope: 'global' | 'project') => {
    if (scope === 'project' && projectId) {
      const next: ProjectPermissionOverride = {
        ...(projOverride ?? {}),
        auto: { ...(projOverride?.auto ?? {}), ...patch },
      }
      setProjOverride(next)
      window.syntee.agent.setProjectPermissions(projectId, next).catch(() => {})
    } else {
      const next = { ...globalAuto, ...patch }
      setGlobalAuto(next)
      window.syntee.agent.setAutoPermissions(next).catch(() => {})
    }
  }

  // Авто-ресайз contentEditable-редактора.
  // В rAF, а не синхронно в эффекте: `height:'auto'` + чтение scrollHeight —
  // это два полных layout'а содержимого подряд, и в фазе commit они попадали
  // ровно между input-событием и кадром (лишний forced reflow на каждый ввод).
  // В кадре результат тот же — визуально ничего не меняется.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      // Крупный текст (вставленный лог/JSON): высота всё равно упирается в
      // max-height 200px, а замер через height:'auto' + scrollHeight — это два
      // полных layout'а содержимого подряд. Сразу ставим предел.
      if (liveText.length > 50_000) {
        el.style.height = '200px'
        return
      }
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 200) + 'px'
    })
    return () => cancelAnimationFrame(id)
  }, [liveText])

  // Сброс навигации по истории при смене чата — индекс относится к
  // inputHistory предыдущего чата и не валиден для нового. Там же — dismiss
  // подсказок аргументов (относился к набору в предыдущем чате).
  useEffect(() => {
    historyIdxRef.current = null
    argDismissedRef.current = null
  }, [chatId])

  // Обновляем слеш-меню и @mention-меню при вводе
  const handleChange = (raw: string) => {
    // ── /orchestrate — одноразовая оркестрация ───────────────────────────
    // Ведущая команда (набрана руками или вставлена из буфера) включает блок
    // выбора исполнителя/ревьюера и вырезается из текста: остаток остаётся
    // черновиком, вложения не трогаем. Повторно уже включённый режим текст
    // не переписывает (иначе правки пользователя затирались бы).
    let text = raw
    if (!orchestration && /^\/orchestrate(?:\s+|$)/i.test(raw)) {
      text = raw.replace(/^\/orchestrate\s*/i, '')
      onOrchestrationActivate?.()
    }
    // Любой ручной ввод сбрасывает режим навигации по истории — иначе
    // следующий ArrowUp продолжил бы с устаревшего индекса.
    historyIdxRef.current = null
    applyLive(text)
    // Показываем меню только если строка начинается с / и нет пробелов после
    // команды. Длину ограничиваем: после вставки мегабайтного текста фильтр
    // команд по всей строке не нужен (и команда такой длины не бывает).
    if (text.startsWith('/') && text.length <= SLASH_MAX_CHARS && !text.includes(' ')) {
      // Пробелов в строке нет → firstWord совпадает с text целиком
      // (раньше ради этого значения делался split(' ') по всей строке).
      const cmds = filterCommands(text, customCommands)
      setSlashCmds(cmds)
      setSlashIdx(0)
    } else {
      setSlashCmds([])
    }

    // ── Контекст команды: подсказки аргументов (пикер + free-text hint) ──
    // Выводится ИЗ ТЕКСТА (resolveSlashContext), а не только из выбора команды
    // в меню: ручной набор `/compact ` теперь тоже открывает подсказки.
    // Enum-аргументы → пикер опций, свободный текст → карточка-подсказка.
    // Слишком длинный текст (вставка) — подсказки закрываем: разбор /cmd args
    // по сотням КБ не имеет смысла.
    if (text.length > ARG_PICKER_MAX_CHARS) {
      closeArgPicker()
    } else {
      const ctx = text.startsWith('/') ? resolveSlashContext(text, customCommands) : null
      if (!ctx || !ctx.hasArgsRegion) {
        // Вне командного контекста (или `/cmd` ещё без аргументов — там своё
        // слеш-меню) подсказки не нужны, dismiss сбрасываем: новая попытка
        // набора той же команды снова покажет подсказки.
        argDismissedRef.current = null
        if (argPickerCmd) closeArgPicker()
      } else if (argDismissedRef.current === ctx.command.name) {
        // Закрыто вручную (Esc/клик мимо) — не переоткрываем на каждое
        // нажатие, пока юзер редактирует ту же команду.
      } else {
        const args = getCommandArguments(ctx.command)
        const level = Math.min(ctx.level, Math.max(0, args.length - 1))
        const arg = args[level]
        if (!arg) {
          closeArgPicker()
        } else if (arg.choices && arg.choices.length > 0) {
          // Пикер опций. Нет совпадений по префиксу → показываем ВСЕ опции:
          // подсказка не мигает при опечатке, допустимые значения видны.
          const filtered = ctx.endsWithSpace
            ? arg.choices
            : arg.choices.filter(c => c.toLowerCase().startsWith(ctx.prefix.toLowerCase()))
          setArgPickerCmd(ctx.command)
          setArgPickerLevel(level)
          setArgPickerChoices(filtered.length > 0 ? filtered : arg.choices)
          setArgPickerIdx(0)
          setArgPrefix(ctx.endsWithSpace ? '' : ctx.prefix)
        } else {
          // Свободный текст — карточка-подсказка (choices пустой).
          setArgPickerCmd(ctx.command)
          setArgPickerLevel(level)
          setArgPickerChoices([])
          setArgPrefix(ctx.prefix)
        }
      }
    }

    // ── @mention-детект: парсим токен у каретки ──
    // Сканируем ОКНО перед кареткой, а не всю строку (findMentionTokenNearCaret):
    // после вставки сотен КБ проход назад до пробела по всему тексту на каждый
    // ввод — лишний фриз. Индексы возвращаются абсолютные — по ним selectMention
    // заменяет токен в value; поведение для обычного текста идентично прежнему.
    // Позицию каретки спрашиваем ТОЛЬКО если в тексте есть '@': getCaretOffset —
    // это полный обход DOM редактора, и без '@' mention-токена быть не может
    // (findMentionTokenNearCaret всё равно вернёт null).
    const caretPos = text.includes('@')
      ? (editorApiRef.current?.getCaretOffset() ?? text.length)
      : text.length
    const token = findMentionTokenNearCaret(text, caretPos, MENTION_SCAN_CHARS)
    mentionTokenRef.current = token
    if (token) {
      // Активное @mention-меню — закрываем autocomplete-провайдер плагинов
      // (не показываем два меню одновременно).
      pluginAutoReqRef.current++
      setPluginAuto(null)
      // Асинхронный fetch с race-guard — если юзер быстро печатает, оставляем
      // только последний. Плюс debounce: main однопоточный, и на каждый символ
      // он заново собирал скиллы/команды (чтение каталогов с диска) + SQLite —
      // набор `@abc` превращался в лавину IPC, которая тормозила ввод.
      // 120 мс незаметны (меню открывается после паузы в наборе).
      const fetchId = ++mentionFetchIdRef.current
      if (mentionDebounceRef.current !== null) clearTimeout(mentionDebounceRef.current)
      mentionDebounceRef.current = window.setTimeout(() => {
        mentionDebounceRef.current = null
        window.syntee.mentions.search({ workdir, query: token.query, limit: 30, chatId })
          .then((items: MentionItem[]) => {
            if (fetchId !== mentionFetchIdRef.current) return // устарел
            setMentionItems(items)
            setMentionIdx(0)
          })
          .catch(() => {
            if (fetchId !== mentionFetchIdRef.current) return
            setMentionItems([])
          })
      }, 120)
    } else {
      if (mentionDebounceRef.current !== null) {
        clearTimeout(mentionDebounceRef.current)
        mentionDebounceRef.current = null
      }
      setMentionItems([])
    }
  }

  const selectCommand = (cmd: SlashCommand) => {
    // ── /orchestrate — не вставляем текст команды в поле ────────────────
    // Включаем one-turn оркестрацию: снимаем набираемый токен команды,
    // сохраняя остальной черновик и вложения.
    if (cmd.orchestration) {
      historyIdxRef.current = null
      argDismissedRef.current = null
      applyLive(liveText.replace(/^\/\S*\s*/, ''))
      setSlashCmds([])
      closeArgPicker()
      onOrchestrationActivate?.()
      setTimeout(() => editorApiRef.current?.focus(), 0)
      return
    }
    // Заменяем ввод на "/command " и фокусируем
    const next = `/${cmd.name} `
    historyIdxRef.current = null
    argDismissedRef.current = null
    applyLive(next)
    setSlashCmds([])
    // Подсказка первого аргумента: enum → пикер опций, свободный текст →
    // карточка-подсказка (см. getCommandArguments — синтез из placeholder).
    const firstArg = getCommandArguments(cmd)[0]
    if (firstArg?.choices && firstArg.choices.length > 0) {
      setArgPickerCmd(cmd)
      setArgPickerLevel(0)
      setArgPickerChoices(firstArg.choices)
      setArgPickerIdx(0)
      setArgPrefix('')
    } else if (firstArg) {
      setArgPickerCmd(cmd)
      setArgPickerLevel(0)
      setArgPickerChoices([])
      setArgPrefix('')
    } else {
      closeArgPicker()
    }
    setTimeout(() => editorApiRef.current?.focus(), 0)
  }

  // ── Пикер аргументов: выбор опции ──
  // Заменяем последний вводимый токен-префикс на выбранный choice и
  // добавляем пробел. Если есть следующий аргумент с choices — переоткрываем
  // пикер для него; иначе закрываем.
  const selectArgChoice = (choice: string) => {
    const cmd = argPickerCmd
    if (!cmd) return
    // Парсим структуру /cmdname [args...] через slice (а не regex m[2],
    // который жадно съедает trailing-пробел и ломает определение endsWithSpace
    // для начального состояния `/cmd ` → rest="" → push-ветка не срабатывала).
    const head = liveText.match(/^\/(\S+)/)
    if (!head || head[1].toLowerCase() !== cmd.name.toLowerCase()) {
      setArgPickerCmd(null); setArgPickerChoices([]); return
    }
    const after = liveText.slice(head[0].length) // всё после /cmdname
    const trimmed = after.trim()
    const endsWithSpace = after.length > 0 && /\s$/.test(after)
    const tokens = trimmed === '' ? [] : trimmed.split(/\s+/)
    // Если каретка в конце завершённого токена (endsWithSpace) или токенов
    // ещё нет — добавляем новый choice. Иначе заменяем последний (вводимый префикс).
    const newTokens = [...tokens]
    if (endsWithSpace || newTokens.length === 0) {
      newTokens.push(choice)
    } else {
      newTokens[newTokens.length - 1] = choice
    }
    const newText = `/${cmd.name} ` + newTokens.join(' ') + ' '
    historyIdxRef.current = null
    applyLive(newText)
    // Переоткрываем для следующего уровня (если есть choices).
    const nextLevel = argPickerLevel + 1
    const nextArg = cmd.arguments?.[nextLevel]
    if (nextArg?.choices && nextArg.choices.length > 0) {
      setArgPickerLevel(nextLevel)
      setArgPickerChoices(nextArg.choices)
      setArgPickerIdx(0)
    } else {
      setArgPickerCmd(null)
      setArgPickerChoices([])
    }
    setTimeout(() => editorApiRef.current?.focus(), 0)
  }

  // Закрытие пикера аргументов.
  const closeArgPicker = () => {
    setArgPickerCmd(null)
    setArgPickerChoices([])
    setArgPickerLevel(0)
    setArgPickerIdx(0)
    setArgPrefix('')
  }

  // Закрытие подсказки с запоминанием команды: пока та же команда в поле,
  // handleChange её не переоткроет (иначе Esc/клик мимо бессмысленны —
  // следующий же символ снова поднял бы меню).
  const dismissArgHint = () => {
    argDismissedRef.current = argPickerCmd?.name ?? null
    closeArgPicker()
  }

  // ── Блокировка отправки без исполнителя ──────────────────────────────────
  // Оркестрация без валидного выбора (исполнитель не выбран / выбор
  // противоречив) не отправляется вообще: кнопка отправки заблокирована, а
  // причина постоянно видна в блоке над инпутом (OrchestrationBar сама
  // показывает validateOrchestration, если явной ошибки ещё нет). Это не
  // «мягкий» отказ ChatPage — сюда просто нельзя нажать.
  const orchestrationBlocked = !!orchestration && !!validateOrchestration(orchestration)

  const handleSend = () => {
    // Пустой = нет текста (токены не считаем) И нет вложений
    const cleanText = stripAttachTokens(liveText).trim()
    if (!cleanText && attachments.length === 0) return
    if (disabled && !isGenerating) return
    // Оркестрация без исполнителя: ни Enter, ни кнопка ничего не отправляют.
    if (orchestrationBlocked) return
    // One-turn оркестрация: НЕ чистим поле оптимистично. Черновик и вложения
    // снимает ChatPage только после принятой отправки — отказ (валидация,
    // плагин, ошибка старта) не должен съедать набранное. Enter и hover-кнопка
    // ведут сюда же: one-shot нельзя обойти «обычной» отправкой.
    const oneShotOrchestration = !!orchestration
    // Отправляем value С токенами — ChatPage положит его в message.content
    // (рендер в чате восстановит чипы на местах), а в AI уйдёт чистый текст.
    onSend(liveText.trim())
    historyIdxRef.current = null
    pluginAutoReqRef.current++
    setPluginAuto(null)
    if (!oneShotOrchestration) {
      applyLive('')
    }
    setSlashCmds([])
    setMentionItems([])
    mentionTokenRef.current = null
    closeArgPicker()
    // Вложения очищаются в ChatPage после отправки (после chat:send)
    if (!oneShotOrchestration && textareaRef.current) textareaRef.current.style.height = 'auto'
    if (uiSounds) playSendSound()
    if (sendEffect) { setSendBurst(true); setTimeout(() => setSendBurst(false), 400) }
  }

  // §steer — long-press кнопки отправки: текст уходит НЕ в очередь, а прямо в
  // контекст работающего агента (Agent вставит его на границе раунда).
  // Поле очищаем сразу, как при обычном send: если активного рана уже нет,
  // ChatPage откатится на обычную отправку этим же текстом.
  // Вложения поддерживаются как в обычной отправке: текст летит с
  // [[attach:id]]-токенами, main их чистит и инлайнит файлы в контекст рана
  // (processAttachmentsAndStream). Чипы ChatPage снимет после acceptance.
  const handleSteer = () => {
    // One-turn оркестрация всегда идёт через обычную отправку (в очередь):
    // внедрение в контекст активного рана обошло бы одноразовый выбор.
    if (orchestration) { handleSend(); return }
    const hasAttachments = attachments.length > 0
    const cleanText = stripAttachTokens(liveText).trim()
    if (!cleanText && !hasAttachments) return
    if (disabled && !isGenerating) return
    const payload = liveText.trim()
    historyIdxRef.current = null
    pluginAutoReqRef.current++
    setPluginAuto(null)
    applyLive('')
    setSlashCmds([])
    setMentionItems([])
    mentionTokenRef.current = null
    closeArgPicker()
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    if (uiSounds) playSteerSound()
    onSteer?.(payload, attachments)
  }

  // Отправка текста без «живого» значения value (для command-подсказки).
  const handleSendText = (text: string) => {
    if (!text.trim()) return
    onSend(text.trim())
    historyIdxRef.current = null
    setSlashCmds([])
    setMentionItems([])
    mentionTokenRef.current = null
    if (uiSounds) playSendSound()
  }

  // ── Autocomplete-провайдеры плагинов: выбор подсказки ──
  // insertText — заменяет текущий текст целиком (триггер+query, как задумал
  // провайдер). command — выполняется как слэш-команда плагина (/name args,
  // остаток текста после trigger-слова уходит аргументами). Иначе вставляем label.
  const selectPluginAuto = (idx: number) => {
    const st = pluginAuto
    if (!st) return
    const s = st.data.suggestions[idx]
    if (!s) return
    historyIdxRef.current = null
    pluginAutoReqRef.current++
    setPluginAuto(null)
    if (s.command) {
      const parts = liveText.trim().split(/\s+/)
      parts.shift() // trigger-слово провайдера
      const args = parts.join(' ')
      const text = ('/' + s.command + (args ? ' ' + args : '')).trim()
      applyLive('')
      handleSendText(text)
      return
    }
    const insert = s.insertText !== undefined ? s.insertText : s.label
    applyLive(insert)
    setTimeout(() => editorApiRef.current?.focus(), 0)
  }

  // ── Autocomplete-провайдеры плагинов: debounced запрос при вводе ──
  // Показываем меню, только если текст НЕ начинается со '/' (слеш-меню имеет
  // приоритет) и первое слово совпадает с trigger провайдера.
  useEffect(() => {
    const text = liveText.trim()
    const ext = getPluginsExt()
    if (!ext.autocomplete) return
    if (!text || text.startsWith('/') || argPickerCmd || text.length > PLUGIN_AUTO_MAX_CHARS) { setPluginAuto(null); return }
    const reqId = ++pluginAutoReqRef.current
    const timer = setTimeout(async () => {
      try {
        const res = await ext.autocomplete?.({ text })
        if (reqId !== pluginAutoReqRef.current) return
        if (!res || !Array.isArray(res.suggestions) || res.suggestions.length === 0) {
          setPluginAuto(null)
          return
        }
        const firstWord = text.split(/\s+/)[0]?.toLowerCase() ?? ''
        const trigger = (res.trigger || '').toLowerCase()
        if (!trigger || firstWord !== trigger || !text.includes(' ')) {
          setPluginAuto(null)
          return
        }
        setPluginAuto({ data: res, idx: 0 })
      } catch {
        if (reqId === pluginAutoReqRef.current) setPluginAuto(null)
      }
    }, 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveText])

  // Смена чата/очистка поля — закрываем меню.
  useEffect(() => {
    pluginAutoReqRef.current++
    setPluginAuto(null)
  }, [chatId])

  // ── @mention: выбор элемента из дропдауна ──
  // Заменяем @токен в тексте на ЧИП с токеном [[attach:id]] — как все
  // остальные вложения: живёт в тексте на своей позиции, удаляется
  // Backspace/крестиком, позиция переживает рестарт. Раньше mention
  // оставлял только @label-текст без токена → вложение было невидимым и
  // НЕ удалялось при удалении текста (баг «файл не удалился»).
  // Фолбэк на @label — только если лимит исчерпан/дубликат.
  const selectMention = (item: MentionItem) => {
    const token = mentionTokenRef.current
    if (!token) return
    const newAtt = mentionToAttachment(item)
    // Дедуп-ключ: файлы — по path, чаты — по chatId, проекты — по projectId
    // (у сущностей path нет — старая проверка a.path === newAtt.path их не
    // ловила и позволяла добавить один чат дважды).
    const dupKey = (a: Attachment): string | undefined =>
      a.kind === 'chat' ? a.chatId : a.kind === 'project' ? a.projectId : a.path
    const canAdd =
      attachments.length < maxAttachments &&
      !attachments.some(a => a.kind === newAtt.kind && dupKey(a) !== undefined && dupKey(a) === dupKey(newAtt))
    const before = liveText.slice(0, token.start)
    const after = liveText.slice(token.end)
    const insertion = canAdd ? `[[attach:${newAtt.id}]]` : `@${item.label}`
    const newText = `${before}${insertion} ${after}`
    mentionTokenRef.current = null
    setMentionItems([])
    if (canAdd) onAttachmentsChange?.([...attachments, newAtt])
    applyLive(newText)
    // Фокус + каретка после вставки (rebuild DOM в useEffect, потом позиция)
    setTimeout(() => {
      editorApiRef.current?.focus()
      editorApiRef.current?.setCaretOffset(before.length + insertion.length + 1) // +пробел
    }, 0)
  }

  // Подставить запись из истории в поле (rebuild поставит каретку в конец).
  const applyHistoryEntry = (entry: string) => {
    applyLive(entry)
  }

  // ── Клик по чипу в редакторе инпута ──
  // Файлы/картинки — превью-модалка; чаты/проекты — навигация (как в чате):
  // чат → tabActions.selectChat (глобальный мост ChatPage), проект → самый
  // свежий чат проекта. Превью-модалка чатам/проектам не подходит (нет path).
  const handleChipPreview = useCallback((a: Attachment) => {
    if (a.kind === 'mcp') return
    if (a.kind === 'chat' && a.chatId) {
      tabActions.selectChat?.(a.chatId)
      return
    }
    if (a.kind === 'project' && a.projectId) {
      const chat = useChatStore.getState().chats
        .filter(c => c.projectId === a.projectId && !c.isArchived)
        .sort((x, y) => y.updatedAt - x.updatedAt)[0]
      if (chat) tabActions.selectChat?.(chat.id)
      return
    }
    setPreviewAttachment(a)
  }, [])

  // ── Прикрепление из плюс-панели (поиск файлов проекта) ──
  // Тот же чип в тексте, что и у @mention: токен [[attach:id]] на позиции
  // каретки, файл-ссылка без копирования (path принадлежит проекту).
  const handleMenuAttach = useCallback((item: MentionItem): boolean => {
    const newAtt = mentionToAttachment(item)
    const dupKey = (a: Attachment): string | undefined =>
      a.kind === 'chat' ? a.chatId : a.kind === 'project' ? a.projectId : a.path
    if (attachments.length >= maxAttachments) return false
    if (attachments.some(a => a.kind === newAtt.kind && dupKey(a) !== undefined && dupKey(a) === dupKey(newAtt))) return false
    onAttachmentsChange?.([...attachments, newAtt])
    editorApiRef.current?.insertAttachmentAtCaret(newAtt)
    return true
  }, [attachments, maxAttachments, onAttachmentsChange])

  // ── Прикрепление MCP-сервера из плюс-панели ──
  // Чип kind='mcp' в тексте сообщения; main по нему инжектит имя сервера
  // и его инструменты в контекст этого запроса (как файл-вложение).
  const handleMenuAttachMcp = useCallback((server: { id: string; name: string }): boolean => {
    if (attachments.length >= maxAttachments) return false
    if (attachments.some(a => a.kind === 'mcp' && a.mcpServerId === server.id)) return false
    const att: Attachment = {
      id: crypto.randomUUID(),
      kind: 'mcp',
      name: server.name,
      mcpServerId: server.id,
      source: 'mention',
      attachedAt: Date.now(),
    }
    onAttachmentsChange?.([...attachments, att])
    editorApiRef.current?.insertAttachmentAtCaret(att)
    return true
  }, [attachments, maxAttachments, onAttachmentsChange])

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Навигация по пикеру аргументов команды — высший приоритет
    // (открыт после выбора команды, пока юзер выбирает enum-опцию).
    // При активном @mention-меню приоритет у него (юзер явно жестом '@'
    // запросил файлы) — пикер подсказки просто скрыт до конца mention.
    if (argPickerCmd && argPickerChoices.length > 0 && mentionItems.length === 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setArgPickerIdx(i => (i - 1 + argPickerChoices.length) % argPickerChoices.length)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setArgPickerIdx(i => (i + 1) % argPickerChoices.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        selectArgChoice(argPickerChoices[argPickerIdx])
        return
      }
      if (e.key === 'Escape') {
        dismissArgHint()
        return
      }
    }
    // Free-text подсказка аргумента (choices пуст) — клавиши НЕ перехватываем:
    // Enter отправляет сообщение, стрелки двигают каретку. Только Esc скрывает.
    if (argPickerCmd && argPickerChoices.length === 0 && mentionItems.length === 0 && e.key === 'Escape') {
      e.preventDefault()
      dismissArgHint()
      return
    }
    // Autocomplete-провайдер плагинов — навигация. Активен только когда
    // слеш/@mention меню закрыты (приоритет у штатных меню).
    if (pluginAuto && slashCmds.length === 0 && mentionItems.length === 0 && !liveText.startsWith('/')) {
      const n = pluginAuto.data.suggestions.length
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPluginAuto(st => (st ? { ...st, idx: (st.idx - 1 + n) % n } : st))
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPluginAuto(st => (st ? { ...st, idx: (st.idx + 1) % n } : st))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        selectPluginAuto(pluginAuto.idx)
        return
      }
      if (e.key === 'Escape') {
        setPluginAuto(null)
        return
      }
    }
    // Навигация по @mention-меню — высший приоритет (как slash)
    if (mentionItems.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIdx(i => (i - 1 + mentionItems.length) % mentionItems.length)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIdx(i => (i + 1) % mentionItems.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        selectMention(mentionItems[mentionIdx])
        return
      }
      if (e.key === 'Escape') {
        setMentionItems([])
        mentionTokenRef.current = null
        return
      }
    }
    // Навигация по слеш-меню — приоритет
    if (slashCmds.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIdx(i => (i - 1 + slashCmds.length) % slashCmds.length)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIdx(i => (i + 1) % slashCmds.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        selectCommand(slashCmds[slashIdx])
        return
      }
      if (e.key === 'Escape') {
        setSlashCmds([])
        return
      }
    }
    // ── История навигации по стрелкам вверх/вниз ──
    // Активна только когда слеш-меню закрыто и в чате есть user-сообщения.
    // Старт навигации — ArrowUp на пустом поле. Дальше Up/Down перемещаются
    // по inputHistory (DESC — 0 самый свежий). Down ниже 0 → очищает поле
    // и выходит из навигации. Многострочный ввод не ломается: пока поле не
    // пусто, ArrowUp двигает каретку (навигация не стартует).
    if (slashCmds.length === 0 && inputHistory.length > 0) {
      const inNav = historyIdxRef.current !== null
      if (e.key === 'ArrowUp') {
        if (inNav) {
          e.preventDefault()
          const cur = historyIdxRef.current as number
          const nextIdx = Math.min(cur + 1, inputHistory.length - 1)
          historyIdxRef.current = nextIdx
          applyHistoryEntry(inputHistory[nextIdx])
          return
        }
        // Старт навигации только с пустого поля — иначе ArrowUp двигает
        // каретку вверх в многострочном вводе.
        if (liveText === '') {
          e.preventDefault()
          historyIdxRef.current = 0
          applyHistoryEntry(inputHistory[0])
          return
        }
      }
      if (e.key === 'ArrowDown' && inNav) {
        e.preventDefault()
        const cur = historyIdxRef.current as number
        const nextIdx = cur - 1
        if (nextIdx < 0) {
          historyIdxRef.current = null
          applyLive('')
        } else {
          historyIdxRef.current = nextIdx
          applyHistoryEntry(inputHistory[nextIdx])
        }
        return
      }
    }
    // Shift+Enter — перенос строки в contentEditable (plain '\n',
    // сериализуется корректно; execCommand триггерит input → onChange)
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      document.execCommand('insertText', false, '\n')
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Открыт диалог подтверждения тулов — Enter подтверждает ЕГО
      // (AgentConfirmDialog ловит тот же keydown на window и вызывает
      // respond), а не отправляет набранный в инпуте текст.
      if (document.querySelector('.agent-confirm-overlay')) return
      // §steer — удержание Enter = внедрить реплику в контекст работающего
      // агента (клавиатурный аналог удержания кнопки отправки). Условия те же:
      // есть текст или вложения, идёт генерация — то есть обычный Enter ушёл
      // бы в очередь. Отправку НЕ делаем сразу: ждём keyup (короткое нажатие)
      // либо порога STEER_HOLD_MS (внедрение).
      const canSteerKeyboard = !!onSteer &&
        !orchestration &&
        (!!stripAttachTokens(liveText).trim() || attachments.length > 0) &&
        !!isGenerating
      if (canSteerKeyboard) {
        // Автоповтор удержания не должен перезапускать таймер.
        if (e.repeat || enterHoldTimer.current !== null) return
        enterSteerFired.current = false
        setEnterHold(true)
        enterHoldTimer.current = window.setTimeout(() => {
          enterHoldTimer.current = null
          setEnterHold(false)
          enterSteerFired.current = true
          handleSteer()
        }, STEER_HOLD_MS)
        return
      }
      handleSend()
    }
  }

  // §steer — keyup Enter: короткое нажатие отправляет как обычно, удержание
  // уже сработало в таймере (флаг не даёт отправить второй раз).
  const handleKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return
    if (enterHoldTimer.current !== null) {
      clearTimeout(enterHoldTimer.current)
      enterHoldTimer.current = null
      setEnterHold(false)
      if (!enterSteerFired.current) handleSend()
      return
    }
    enterSteerFired.current = false
  }

  // Размонтирование/смена чата посреди удержания — таймер не должен выстрелить.
  // Там же гасим отложенный IPC @mention-поиска.
  useEffect(() => () => {
    if (enterHoldTimer.current !== null) {
      clearTimeout(enterHoldTimer.current)
      enterHoldTimer.current = null
    }
    if (mentionDebounceRef.current !== null) {
      clearTimeout(mentionDebounceRef.current)
      mentionDebounceRef.current = null
    }
  }, [])

  // Логика кнопки (Send/Stop/Mic) вынесена в ChatInputActionButton.
  // Здесь остаётся только micBusy (для бейджа статус-строки) и lang.
  const voiceActive = voice.state === 'recording' || voice.state === 'transcribing' || voice.state === 'requesting'
  // Пока модель качается в фоне (первая загрузка после клика на mic) — на
  // кнопке mic крутится спиннер, но запись можно начать (инференс подождёт
  // готовности модели). Преварма при старте НЕТ — воркер спавнится только
  // по факту использования голоса (см. voice.ipc.ts).
  const micBusy = voice.modelLoading && !voiceActive && !liveText.trim() && !isGenerating
  // language — 'ru' (default) | 'en'. Selects localized toggle labels.
  const lang = useSettingsStore(s => (s.settings['language'] as 'ru' | 'en') ?? 'ru')

  // Breadcrumb пути рабочей директории: показываем последние 2 сегмента
  // с разделителем, если путь длиннее — добавляем многоточие спереди.
  // Например "C:\Projects\MyApp" → "Projects / MyApp",
  // "/home/user/projects/myapp" → "projects / myapp".
  const workdirBreadcrumb = workdir
    ? (() => {
        const segs = workdir.split(/[\\/]/).filter(Boolean)
        if (segs.length <= 2) return segs.join(' / ')
        return '… / ' + segs.slice(-2).join(' / ')
      })()
    : ''

  return (
    // Контейнер .chat-input-wrap абсолютно позиционирован (bottom:0).
    // .chat-input-main — бейджи + инпут. Todo-план вынесен наверх чата
    // в отдельный компонент LiveTodoBar (в ChatPage).
    <div
      className={`chat-input-wrap ${isIncognito ? 'chat-input-wrap--incognito' : ''}`}>

      {/* ОСНОВНОЙ БЛОК — бейджи + инпут. */}
      <div className="chat-input-main">
        {/* Слеш-меню / @mention-меню / пикер аргументов команды */}
        <ChatInputMenus
          slashCmds={slashCmds}
          slashIdx={slashIdx}
          slashQuery={liveText.startsWith('/') && !liveText.includes(' ') ? liveText.slice(1) : ''}
          mentionItems={mentionItems}
          mentionIdx={mentionIdx}
          // Активное @mention-меню скрывает пикер аргументов (два меню на одном
          // якоре перекрывались бы; после резолюции mention пикер вернётся —
          // состояние argPickerCmd не трогаем, гасим только отображение).
          argPickerCmd={mentionItems.length > 0 ? null : argPickerCmd}
          argPickerLevel={argPickerLevel}
          argPickerChoices={argPickerChoices}
          argPickerIdx={argPickerIdx}
          argPrefix={argPrefix}
          boxRef={boxRef}
          onSelectCommand={selectCommand}
          onCloseSlash={() => setSlashCmds([])}
          onSelectMention={selectMention}
          onCloseMention={() => { setMentionItems([]); mentionTokenRef.current = null }}
          onSelectArgChoice={selectArgChoice}
          onCloseArgPicker={dismissArgHint}
          pluginAuto={pluginAuto ? pluginAuto.data : null}
          pluginAutoIdx={pluginAuto?.idx ?? 0}
          onSelectPluginAuto={selectPluginAuto}
          onClosePluginAuto={() => { pluginAutoReqRef.current++; setPluginAuto(null) }}
        />

      {/* Компактный блок one-turn оркестрации — ВЫШЕ строки статуса (модель,
          проект, размышление), только когда режим включён (/orchestrate или
          «+» → Оркестрация). */}
      <AnimatePresence initial={false}>
        {orchestration && (
          <OrchestrationBar
            key="orchestration-bar"
            selection={orchestration}
            error={orchestrationIssue}
            mainModelId={mainModelId}
            mainModelProviderId={mainModelProviderId}
            onExecutorChange={(m: OrchestrationModel) => onOrchestrationChange?.({ ...orchestration, executor: m })}
            onReviewerChange={(m: OrchestrationModel | null) => onOrchestrationChange?.({ executor: orchestration.executor, reviewer: m ?? undefined })}
            onClose={() => onOrchestrationChange?.(null)}
          />
        )}
      </AnimatePresence>

      {/* Строка статуса над инпутом: workdir-бейдж + planning/image-бейджи + бейджи голоса/очереди/расширений/изменений + селектор модели. */}
      <ChatInputStatusRow
        workdir={workdir}
        workdirBreadcrumb={workdirBreadcrumb}
        voice={voice}
        isVoiceTyping={isVoiceTyping}
        micBusy={micBusy}
        chatId={chatId}
        isIncognito={isIncognito}
        lastTurnChanges={lastTurnChanges}
        badgeLive={badgeLive}
        planningMode={planningMode}
        onPlanningModeChange={onPlanningModeChange}
        imageMode={imageMode}
        onImageModeChange={onImageModeChange}
        askMode={askMode}
        onAskModeChange={onAskModeChange}
        browserMode={browserMode}
        onBrowserModeChange={onBrowserModeChange}
        lang={lang}
        mainModelId={mainModelId}
        mainModelProviderId={mainModelProviderId}
        onMainModelChange={onMainModelChange}
        reasoningValue={reasoningValue}
        onReasoningChange={onReasoningChange}
        onOpenProjectSettings={onOpenProjectSettings}
        gitSyncProjects={gitSyncProjects}
        onGitSyncApply={onGitSyncApply}
        onGitSyncLater={onGitSyncLater}
        onGitSyncOpenGit={onGitSyncOpenGit}
        secretsEnabled={secretsEnabled}
        onProtectedVarsClick={() => setProtectedVarsOpen(true)}
      />

      {rateLimitSec > 0 && (
        <div className="chat-input-rate-limit">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
          <span>Rate limit — жду {rateLimitSec}с</span>
        </div>
      )}

      <div
        className="chat-input-box"
        ref={boxRef}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <AudioVisualizerLayer />
        {/* Drag&Drop overlay — подсветка всего инпута + текст «Отпустите для прикрепления» */}
        <AnimatePresence>
          {isDragOver && (
            <motion.div
              className="chat-input-drop-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <span>Отпустите для прикрепления</span>
            </motion.div>
          )}
        </AnimatePresence>
        {/* Горизонтальная строка: + кнопка, редактор, селекторы, action-кнопка.
            Вложения живут ПРЯМО В ТЕКСТЕ редактора (inline-чипы) — ряда снизу нет.
            Реплай-чипы — там же, в начале текста (передаём replies в редактор). */}
        <div className="chat-input-row">
          {/* + кнопка с меню */}
          <ChatInputPlusMenu
            anchorRef={boxRef}
            onAttachClick={handleAttachClick}
            secretsCount={secretsCount}
            onProtectedVarsClick={() => setProtectedVarsOpen(true)}
            planningMode={planningMode}
            onPlanningModeChange={onPlanningModeChange}
            imageMode={imageMode}
            onImageModeChange={onImageModeChange}
            askMode={askMode}
            onAskModeChange={onAskModeChange}
            browserMode={browserMode}
            onBrowserModeChange={onBrowserModeChange}
            lang={lang}
            chatId={chatId}
            workdir={workdir}
            projectId={projectId}
            attachments={attachments}
            maxAttachments={maxAttachments}
            onAttachItem={handleMenuAttach}
            onAttachMcp={handleMenuAttachMcp}
            customCommands={customCommands}
            onInsertCommand={selectCommand}
            orchestrationActive={!!orchestration}
            onOrchestrate={onOrchestrationActivate}
          />

          {/* Кнопки плагинов над инпутом (registerInputAction) */}
          <PluginInputActions
            onInsertCommand={(text) => {
              historyIdxRef.current = null
              applyLive(text)
              setTimeout(() => editorApiRef.current?.focus(), 0)
            }}
          />

          <ChatInputEditor
            value={liveText}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onPasteImages={handlePaste}
            onPasteLinks={handlePasteLinks}
            onUserInput={handleEditorUserInput}
            attachments={attachments}
            onRemoveAttachment={handleRemoveAttachment}
            onPreviewAttachment={handleChipPreview}
            replies={replyTo}
            onRemoveReply={onCancelReply}
            customCommands={customCommands}
            editorApiRef={editorApiRef}
            editorRef={textareaRef}
            placeholder={
              orchestration ? 'Оркестрация — опишите задачу для исполнителя...'
              : planningMode ? 'Режим планирования — опишите задачу...'
              : askMode ? 'Ask-режим — только чтение, задайте вопрос...'
              : imageMode ? 'Режим генерации изображений — опишите картинку...'
              : isIncognito ? 'Режим инкогнито — чат не сохраняется...'
              : 'Сообщение Syntee... (/ для команд, @ для файлов)'
            }
            planningMode={planningMode}
            askMode={askMode}
            disabled={disabled && !isGenerating}
          />

          {!isIncognito && (
            <ApprovalModeSelector
              value={projOverride?.approvalMode ?? approvalMode}
              onChange={handleApprovalChange}
              compact
              projectId={projectId ?? null}
              projectName={projectName}
              globalMode={approvalMode}
              globalAuto={globalAuto}
              projectOverride={projOverride}
              onAutoChange={handleAutoChange}
            />
          )}

          {showContextRing && !isIncognito && (
            <ContextRing info={contextInfo ?? null} compactSessionStats={compactSessionStats} chatId={chatId} goal={goal} onGoalChange={onGoalChange} />
          )}

          <ChatInputActionButton
            value={liveText}
            isGenerating={isGenerating}
            voice={voice}
            micBusy={micBusy}
            sendBurst={sendBurst}
            // Оркестрация без исполнителя — отправка недоступна (см. выше).
            blocked={orchestrationBlocked}
            blockedTitle="Оркестрация: выберите модель-исполнителя"
            onStop={onStop}
            onSend={handleSend}
            onSteer={onSteer && !orchestration ? handleSteer : undefined}
            // §steer — кольцо удержания Enter на кнопке: условие то же, что в
            // canSteerKeyboard (текст ИЛИ вложения).
            // Раньше здесь оставалось «нет вложений» — при вложениях внедрение
            // срабатывало, а анимация на кнопке не показывалась.
            holdActive={enterHold && !!isGenerating && !orchestration &&
              (!!stripAttachTokens(liveText).trim() || attachments.length > 0)}
            onMicClick={handleMicClick}
          />
        </div>
      </div>

      <p className="chat-input-hint">Enter — отправить · Shift+Enter — новая строка · / — команды · @ — файлы</p>
      <ChatActivityStrip />
      </div>

      {/* Модалка превью вложения — лайтбокс для картинок, CodePreview для файлов */}
      <AttachmentPreviewModal
        key={previewAttachment?.id ?? 'none'}
        attachment={previewAttachment}
        onClose={() => setPreviewAttachment(null)}
      />

      {/* Модалка защищённых переменных (секреты → system prompt) */}
      <ProtectedVarsModal
        open={protectedVarsOpen}
        onClose={() => setProtectedVarsOpen(false)}
        onChanged={refreshSecrets}
      />
    </div>
  )
}

export default memo(ChatInput)
