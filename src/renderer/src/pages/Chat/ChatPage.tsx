import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Reply, Copy } from 'lucide-react'
import { copyToClipboard } from '@renderer/utils/clipboard'
import { AnimatePresence, motion } from 'framer-motion'
import { springHover, whileHoverSm, whileTapSm, whileHoverTiny, whileTapTiny, whileHoverListItem, whileTapListItem } from '../../utils/motionPresets'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useShallow } from 'zustand/react/shallow'
import { v4 as uuid } from 'uuid'
import { useContextCounter } from '../../hooks/useContextCounter'
import { useChatAutoscroll } from '../../hooks/useChatAutoscroll'
import { useBackgroundLoadFullChat } from '../../hooks/useBackgroundLoadFullChat'
import { initChatSend, hydrateFromMain, enqueuePendingUserMsg, appendPendingSteer, removePendingSteer } from '../../hooks/useChatRunSubscription'
import TitleBar from '../../components/layout/TitleBar/TitleBar'
import Sidebar from '../../components/layout/Sidebar/Sidebar'
import { playDoneSound } from '../../utils/sounds'
import MessageBubble from '../../components/ui/MessageBubble/MessageBubble'
import { ChatRemeasureContext } from '../../components/ui/MessageBubble/remeasure'
import ChatInput from '../../components/ui/ChatInput/ChatInput'
import { useChatEditor } from '../../hooks/useChatEditor'
import LiveTodoBar from '../../components/ui/LiveTodoBar/LiveTodoBar'
import GitTools from '../../components/ui/GitTools/GitTools'
import GoalCard from '../../components/ui/GoalCard/GoalCard'
import ChatFilesPopover from '../../components/ui/ChatFilesPopover/ChatFilesPopover'
import AnimatedBackground from '../../components/ui/AnimatedBackground/AnimatedBackground'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import ToastContainer, { useToast } from '../../components/ui/Toast/Toast'
import ChatSearch from '../../components/ui/ChatSearch/ChatSearch'
import HelpModal from '../../components/ui/HelpModal/HelpModal'
import { ProjectSettingsModal } from '../../components/ui/ProjectSettingsModal/ProjectSettingsModal'
import Logo from '../../components/ui/Logo/Logo'
import SplitChatPane from '../../components/ui/SplitChatPane/SplitChatPane'
import ChatMinimap from '../../components/ui/ChatMinimap/ChatMinimap'
import { useSettingsStore } from '../../store/settings.store'
import { useChatStore, EMPTY_LIVE, selectIsLargeChat } from '../../store/chat.store'
import { computeLiveChanges } from '../../utils/changes'
import { useExtensionsStore } from '../../store/extensions.store'
import { useNavStore } from '../../store/nav.store'
import { useUIStore } from '../../store/ui.store'
import { useRightPanelTabsStore } from '../../store/rightPanelTabs.store'
import { useTabsStore, tabActions } from '../../store/tabs.store'
import { parseSlashCommandWithCustom, hydrateCommands } from '../../../../shared/slashCommands'
import type { SlashCommand } from '../../../../shared/slashCommands'
import type { OrchestrationSelection } from '../../../../shared/orchestration'
import type { OrchestrationResume } from '../../../../shared/orchestration'
import { collectFileChanges } from '../../../../shared/fileChanges'
import {
  ORCHESTRATION_BY_CHAT_KEY,
  ORCHESTRATION_DEFAULTS_KEY,
  isOrchestrationModel,
  normalizeOrchestrationDefaults,
  readOrchestrationForChat,
  validateOrchestration,
  writeOrchestrationForChat,
  type OrchestrationDefaults,
  type OrchestrationIssueText,
} from '../../utils/orchestration'
import { stripAttachTokens } from '../../../../shared/attachmentMarkdown'
import { toSteerAttachmentMeta } from '../../../../shared/steer'
import { attachmentKindFromMime, mimeFromExt } from '../../../../shared/mentions'
import type { Chat, Message, ToolOutputMode, Project, QueueItemMeta, CheckpointMeta, Attachment, ReplyTarget } from '../../../../shared/types'

// ── Самолечение draft-вложений с битым path ────────────────────────────────
// Одним IPC-вызовом: main проверяет существование файлов и ищет копии в
// папке черновика чата (fs недоступен в renderer — browser-external).
async function repairDraftAttachments(chatId: string, atts: Attachment[]): Promise<Attachment[]> {
  try {
    const fixed = await window.syntee.attachments.repairDraft({ chatId, attachments: atts })
    return Array.isArray(fixed) ? (fixed as Attachment[]) : atts
  } catch {
    return atts
  }
}
import { DEFAULT_HOTKEYS } from '../../../../shared/constants'
import './ChatPage.css'
import type { ChatGoal } from '../../../../shared/types/goal'

const itemStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
}

/** Команды, которые ChatPage обрабатывает сама (не уходят в агент как промпт). */
const GOAL_COMMANDS = ['goal', 'goal-pause', 'goal-stop', 'goal-resume']
/** Алиасы снятия цели — как `/goal clear` в Claude Code. */
const GOAL_CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])

/** Дождаться кадра, в котором браузер уже ОТРИСОВАЛ текущий коммит.
 *  requestAnimationFrame срабатывает ДО paint, поэтому после него нужен ещё
 *  макротаск: setTimeout(0) выполняется уже после отрисовки кадра.
 *  Нужно при переключении чата: сначала показать вуаль (cheap-коммит),
 *  отдать кадр — и только потом запускать тяжёлый рендер ленты нового чата,
 *  иначе React заблокирует main thread и вуаль никогда не отрисуется. */
function settleFrame(): Promise<void> {
  return new Promise<void>(resolve => {
    requestAnimationFrame(() => { setTimeout(resolve, 0) })
  })
}

/** Грубая оценка «тяжести» окна сообщений для решения «нужна ли вуаль».
 *  Фриз даёт markdown-рендер: react-markdown + подсветка кода + KaTeX +
 *  Mermaid на длинных сообщениях. На коротком окне рендер занимает единицы
 *  миллисекунд — маскировать нечего, а любая вуаль там выглядит как
 *  мелькание. Порог подобран по символам контента (не по числу сообщений:
 *  10 коротких реплик дешевле одного ответа с блоком кода). */
function isHeavyMessageWindow(msgs: readonly Message[]): boolean {
  if (msgs.length === 0) return false
  if (msgs.length >= 10) return true
  let chars = 0
  for (const m of msgs) chars += m.content?.length ?? 0
  return chars > 2000
}

// ── Module-level empty константы для узких live-селекторов ──────────────
// setLiveState делает { ...prev, ...partial } — при text-флаше (50мс)
// меняется только text, остальные поля сохраняют ссылки. Селекторы
// возвращают эти ссылки → Object.is → без ре-рендера по неизменным полям.
// Пустые массивы/объекты — стабильные ссылки на случай undefined.
const EMPTY_STEPS = EMPTY_LIVE.steps
const EMPTY_ITERS = EMPTY_LIVE.iters
const EMPTY_TODO = EMPTY_LIVE.todo
const EMPTY_TOOL_PROGRESS = EMPTY_LIVE.toolProgress

const VirtualMessageItem = memo(function VirtualMessageItem({
  msg, vItemStart, vItemIndex, measureRef,
  toolOutputMode, onPin, onCopy, onReply, onRewind,
  searchQuery, liveThinking, isStreaming, isWaiting, rateLimitSec, shouldAnimate,
  workdir, editorAvailable, onOrchestrationContinue, orchestrationContinued,
}: {
  msg: Message
  vItemStart: number
  vItemIndex: number
  measureRef: (el: Element | null) => void
  toolOutputMode: ToolOutputMode
  onPin?: (id: string) => void
  onCopy?: () => void
  onReply?: (message: Message) => void
  onRewind?: (userMessageId: string) => void
  searchQuery?: string
  liveThinking?: { isLive: boolean; ms?: number; storeChatId?: string }
  isStreaming?: boolean
  isWaiting?: boolean
  rateLimitSec?: number
  shouldAnimate?: boolean
  workdir?: string
  editorAvailable?: boolean
  onOrchestrationContinue?: (message: Message) => void
  orchestrationContinued?: boolean
}) {
  return (
    <div
      data-index={vItemIndex}
      data-msg-id={msg.id}
      ref={measureRef}
      style={{ ...itemStyle, transform: `translateY(${vItemStart}px)` }}
    >
      <MessageBubble
        message={msg}
        toolOutputMode={toolOutputMode}
        onPin={onPin}
        onCopy={onCopy}
        onReply={onReply}
        onRewind={onRewind}
        searchQuery={searchQuery}
        liveThinking={liveThinking}
        isStreaming={isStreaming}
        isWaiting={isWaiting}
        rateLimitSec={rateLimitSec}
        shouldAnimate={shouldAnimate}
        workdir={workdir}
        editorAvailable={editorAvailable}
        onOrchestrationContinue={onOrchestrationContinue}
        orchestrationContinued={orchestrationContinued}
      />
    </div>
  )
}, (prev, next) =>
  prev.msg === next.msg &&
  prev.vItemStart === next.vItemStart &&
  // vItemIndex обязателен: индекс ряда (data-index) — единственный канал, по
  // которому виртуализатор сопоставляет DOM-ноду со слотом измерений. Если
  // индекс сменился при совпавшем start (редко, но возможно при сдвиге окна),
  // без этого сравнения data-index протухнет → RO-замеры уйдут в чужой слот.
  prev.vItemIndex === next.vItemIndex &&
  prev.toolOutputMode === next.toolOutputMode &&
  prev.onPin === next.onPin &&
  prev.onCopy === next.onCopy &&
  prev.onReply === next.onReply &&
  prev.onRewind === next.onRewind &&
  prev.searchQuery === next.searchQuery &&
  prev.liveThinking === next.liveThinking &&
  prev.isStreaming === next.isStreaming &&
  prev.isWaiting === next.isWaiting &&
  prev.rateLimitSec === next.rateLimitSec &&
  prev.shouldAnimate === next.shouldAnimate &&
  prev.workdir === next.workdir &&
  prev.editorAvailable === next.editorAvailable &&
  prev.onOrchestrationContinue === next.onOrchestrationContinue &&
  prev.orchestrationContinued === next.orchestrationContinued
)

function ChatPage({ embedded = false }: { embedded?: boolean }) {
  // Узкие селекторы: подписываемся только на нужные поля. Раньше был
  // useChatStore() без селектора — ре-рендер на любое изменение store
  // (чужой чат стримит → liveByChat меняется → ChatPage ре-рендер 20×/сек).
  // Теперь data-поля выбираем по одному, actions — через useShallow
  // (стабильные ссылки, shallow-сравнение всегда равно → без ре-рендеров).
  const currentChatId = useChatStore(s => s.currentChatId)
  const [chatGoal, setChatGoal] = useState<ChatGoal | null>(null)
  const goalActionRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    let eventReceived = false
    setChatGoal(null)
    if (!currentChatId) return
    const off = window.syntee.on('goal:updated', (data: unknown) => {
      const update = data as { chatId: string; goal: ChatGoal | null }
      if (cancelled || update?.chatId !== currentChatId) return
      eventReceived = true
      setChatGoal(update.goal)
    })
    void window.syntee.goal.get(currentChatId).then(goal => {
      if (!cancelled && !eventReceived) setChatGoal(goal)
    }).catch(() => { if (!cancelled && !eventReceived) setChatGoal(null) })
    return () => { cancelled = true; off?.() }
  }, [currentChatId])
  const applyGoal = useCallback((goal: ChatGoal | null) => {
    if (!goal) return
    if (useChatStore.getState().currentChatId === goal.chatId) {
      setChatGoal(prev => prev && prev.updatedAt > goal.updatedAt ? prev : goal)
    }
  }, [])
  const stopChatRun = useCallback(async (chatId: string) => {
    useChatStore.getState().clearLiveState(chatId)
    await window.syntee.chat.stop(chatId)
  }, [])
  const messages = useChatStore(s => s.messages)
  const hasOlderMessages = useChatStore(s => s.hasOlderMessages)
  const isLoadingOlder = useChatStore(s => s.isLoadingOlder)
  const chats = useChatStore(s => s.chats)
  // isLargeChat — по messageCount из списка chats (БД COUNT(*)). Большие чаты
  // (> LARGE_CHAT_THRESHOLD) не догружаются фоном целиком — для них остаётся
  // reverse-infinite scroll со спиннером; малые грузятся тихо в фоне.
  const isLargeChat = useChatStore(s => selectIsLargeChat(s.chats, s.currentChatId))
  const isIncognito = useChatStore(s => s.isIncognito)
  const activeMode = useChatStore(s => s.activeMode)
  const projects = useChatStore(s => s.projects)
  const activeProjectId = useChatStore(s => s.activeProjectId)
  const [gitSyncState, setGitSyncState] = useState<import('../../../../shared/types').GitSyncState | null>(null)
  // Сплит-режим: второй чат рядом с основным (50/50). Рендерим панель только
  // если сплит-чат жив, ≠ текущему (подписка в tabs.store закрывает такой
  // сплит, здесь — страховка от кадра-гонки) и не в архиве.
  const splitChatId = useChatStore(s => s.splitChatId)
  const setSplitChat = useChatStore(s => s.setSplitChat)
  // ── Узкие live-селекторы: подписка на каждое поле отдельно ─────────────
  // setLiveState делает { ...prev, ...partial } — при text-флаше (каждые
  // 50мс) меняется только text, остальные поля сохраняют ссылки →
  // Object.is → ChatPage НЕ ре-рендерится по неизменным полям. Раньше
  // один широкий селектор возвращал новый объект каждые 50мс → ChatPage
  // ре-рендерился 20×/сек со всем телом (2279 строк, 17 селекторов, 10
  // useMemo). Теперь live.text читается только в live-пузыре (MessageBubble
  // подписан на store сам), ChatPage — только булевы/стабильные поля.
  const liveIsTyping = useChatStore(s => s.currentChatId ? s.liveByChat[s.currentChatId]?.isTyping : false) ?? false
  const liveIsAgentRunning = useChatStore(s => s.currentChatId ? s.liveByChat[s.currentChatId]?.isAgentRunning : false) ?? false
  const liveIsThinkingLive = useChatStore(s => s.currentChatId ? s.liveByChat[s.currentChatId]?.isThinkingLive : false) ?? false
  const liveThinkingMs = useChatStore(s => s.currentChatId ? s.liveByChat[s.currentChatId]?.thinkingMs : undefined)
  const liveSteps = useChatStore(s => s.currentChatId ? s.liveByChat[s.currentChatId]?.steps : undefined) ?? EMPTY_STEPS
  const liveIters = useChatStore(s => s.currentChatId ? s.liveByChat[s.currentChatId]?.iters : undefined) ?? EMPTY_ITERS
  const liveTodo = useChatStore(s => s.currentChatId ? s.liveByChat[s.currentChatId]?.todo : undefined) ?? EMPTY_TODO
  const liveMsgId = useChatStore(s => s.currentChatId ? s.liveByChat[s.currentChatId]?.msgId : undefined) ?? null
  const liveToolProgress = useChatStore(s => s.currentChatId ? s.liveByChat[s.currentChatId]?.toolProgress : undefined) ?? EMPTY_TOOL_PROGRESS
  const liveRateLimitSec = useChatStore(s => s.currentChatId ? s.liveByChat[s.currentChatId]?.rateLimitSec : 0) ?? 0
  // language — 'ru' (default) | 'en'. Нужен для текстов Git-инструментов в углу.
  const lang = useSettingsStore(s => (s.settings['language'] as 'ru' | 'en') ?? 'ru')
  // hasLiveText — boolean: true пока live.text непустой. Примитив →
  // Object.is → НЕ ре-рендерит когда текст растёт (true → true).
  // Ре-рендер только при переходе empty→non-empty и обратно.
  const hasLiveText = useChatStore(s => !!(s.currentChatId && s.liveByChat[s.currentChatId]?.text))
  const runStatus = useChatStore(s => s.currentChatId ? s.runStatusByChat[s.currentChatId] : undefined)
  // runStatus переживает переключение чатов и приходит раньше live-гидрации.
  // Используем его как быстрый источник истины для кнопки Send/Stop, чтобы
  // при возврате в работающий чат не было короткого idle-состояния.
  const runStatusBusy = runStatus?.status === 'queued'
    || runStatus?.status === 'running'
    || runStatus?.status === 'compacting'
  const lastTurnChanges = useChatStore(s => s.currentChatId ? s.lastTurnChangesByChat[s.currentChatId] : null)
  // Live-изменения: вычисляем из liveSteps во время выполнения запроса.
  const liveChanges = useMemo(() => computeLiveChanges(liveSteps), [liveSteps])
  const badgeChanges = lastTurnChanges ?? (liveIsAgentRunning ? liveChanges : null)
  const badgeLive = liveIsAgentRunning && !!liveChanges && !lastTurnChanges
  const { setChats, setCurrentChat, setMessages, setMessagesWindow, prependOlderMessages,
    setIsLoadingOlder, setHasOlderMessages, addMessage, pinMessage,
    setProjects, setActiveProject, markChatRead } = useChatStore(useShallow(s => ({
    setChats: s.setChats, setCurrentChat: s.setCurrentChat, setMessages: s.setMessages,
    setMessagesWindow: s.setMessagesWindow, prependOlderMessages: s.prependOlderMessages,
    setIsLoadingOlder: s.setIsLoadingOlder, setHasOlderMessages: s.setHasOlderMessages,
    addMessage: s.addMessage, pinMessage: s.pinMessage, setProjects: s.setProjects,
    setActiveProject: s.setActiveProject, markChatRead: s.markChatRead,
  })))
  const isTyping = liveIsTyping
  const isAgentRunning = liveIsAgentRunning

  // ── Редактор чата: режим inline-правки сообщений ─────────────────────────
  // Общая логика (применение черновиков, перезагрузка окна) — в useChatEditor,
  // тот же хук использует SplitChatPane.
  const {
    editorMode,
    draftsCount: editorDraftsCount,
    editsCount: editorEditsCount,
    hiddenCount: editorHiddenCount,
    deletedCount: editorDeletedCount,
    applying: editorApplying,
    apply: handleApplyEditorDrafts,
    discard: discardEditorDrafts,
  } = useChatEditor(currentChatId)

  // Смена чата в режиме редактора — черновики принадлежат сообщениям старого
  // чата, применять их к новому нельзя. Сбрасываем без записи в БД.
  useEffect(() => {
    if (useChatStore.getState().editorChatId) discardEditorDrafts()
  }, [currentChatId, discardEditorDrafts])

  const { add: toast } = useToast()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const chatInputWrapRef = useRef<HTMLDivElement>(null)
  const [toolOutputMode, setToolOutputMode] = useState<ToolOutputMode>('normal')
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  // ── Индикатор переключения чата (см. selectChat + .chat-switch-veil в CSS,
  //    имя класса осталось от первой версии с затемнением) ──
  // off   — не смонтирован;
  // shown — проявлен (fade-in 110ms, стартует сразу при монтировании);
  // out   — плавное затухание (160ms) поверх уже отрисованного нового чата.
  const [veilPhase, setVeilPhase] = useState<'off' | 'shown' | 'out'>('off')
  const veilHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Смонтирован ли индикатор прямо сейчас — без этого hideVeil в «клике по
  // активному чату» монтировал бы невидимый элемент на 200мс вхолостую.
  const veilVisibleRef = useRef(false)
  // Номер попытки переключения: при быстрых кликах A→B→C каждая ветка
  // selectChat проверяет, что её не перебили, — иначе поздний await
  // вернул бы UI на уже покинутый чат и снял вуаль поверх чужого контента.
  const chatSwitchSeqRef = useRef(0)
  const isInitialScrollRef = useRef(true)
  // Guard: при manual /compact мы сами вызываем setMessages(result.messages)
  // с синхронным возвратом IPC. Но main также эмитит CHAT_COMPACTED, и
  // листенер дёрнет getMessagesPage(20)→setMessagesWindow — второй апдейт
  // массива. С id-based getItemKey это безопасно, но лишний IPC-раунд и
  // ререндр. Флаг выставается до invoke, гасится в листенере.
  const manualCompactJustDoneRef = useRef(false)

  // Fix C: множество id сообщений, чья entrance-анимация уже отыграла.
  // Виртуализатор монтирует/демонтирует элементы при скролле; без этого
  // флага motion.div каждый раз пере-проигрывает initial→animate →
  // «интерфейс плывёт». Анимируем только первое появление сообщения.
  // При смене чата (currentChatId) множество чистится — новые сообщения
  // анимируются свежо, как и было раньше при полном перемонте.
  const animatedMsgIdsRef = useRef<Set<string>>(new Set())

  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIds, setSearchMatchIds] = useState<string[]>([])
  const [replyTo, setReplyTo] = useState<Message[]>([])
  const [selectionPopup, setSelectionPopup] = useState<{ x: number; y: number; text: string } | null>(null)
  // ── Per-chat UI state (переживает перезапуск приложения) ──
  // draft — ВНЕШНЕЕ значение поля ввода (снимок черновика: загрузка чата,
  // программная подстановка, очистка после отправки). Набор текста сюда НЕ
  // идёт — живой текст живёт внутри ChatInput, иначе setDraft на каждый символ
  // ре-рендерил бы всю страницу чата (виртуализатор + ~500 строк JSX) и при
  // стриме это складывалось в статтеры. Актуальный текст для персиста —
  // draftRef (обновляется сразу), для ContextRing — draftLive (зеркало с
  // троттлингом). inputHistory — предыдущие user-запросы чата (DESC, самый
  // свежий первым), для навигации стрелками.
  // planning/image/askMode — тумблеры плюсика-меню инпут-бара.
  // Всё это сохраняется в chats/messages через IPC. Для инкогнито —
  // только in-memory на сессию (после рестарта чисто).
  const [draft, setDraft] = useState('')
  // Зеркало живого текста для ContextRing (кольцо контекста): обновляется не
  // чаще ~350мс вместо setState на каждый символ. Сам хук всё равно
  // дебаунсит расчёт на 500мс — визуально поведение кольца не меняется.
  const [draftLive, setDraftLive] = useState('')
  const draftLiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Время последнего ввода — фоновая догрузка истории не стартует, пока
  // пользователь печатает (idle-окна между нажатиями иначе принимались за
  // простой и догрузка страницы совпадала с набором).
  const lastInputAtRef = useRef(0)
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [planningMode, setPlanningMode] = useState(false)
  const [imageMode, setImageMode] = useState(false)
  const [askMode, setAskMode] = useState(false)
  // Тумблер «Управление браузером»: browser_* тулы для AI. Включается
  // вручную (плюс-меню) или через подтверждение request_access от AI.
  const [browserMode, setBrowserMode] = useState(false)
  const browserModeRef = useRef(false)
  // ── One-turn оркестрация (/orchestrate) ────────────────────────────────
  // Не режим и не глобальная настройка: выбор исполнителя/ревьюера живёт
  // один ход и снимается после ПРИНЯТОЙ отправки. Сам выбор запоминается
  // ПО ЧАТАМ в настройках (settings['orchestrationByChat']) — переживает
  // перезапуск; глобальные дефолты лежат в settings['orchestrationDefaults'].
  const [orchestration, setOrchestration] = useState<OrchestrationSelection | null>(null)
  const [orchestrationIssue, setOrchestrationIssue] = useState<OrchestrationIssueText | null>(null)
  // Сообщения, по которым уже нажали «Продолжить»: кнопка не должна висеть и
  // давать создать второй ход повторным кликом.
  const [continuedMsgIds, setContinuedMsgIds] = useState<Set<string>>(() => new Set())
  // Сигнал ChatInput «очисти поле» (см. clearDraftToken в ChatInput): нужен
  // потому, что в режиме оркестрации инпут не чистит ввод оптимистично.
  const [draftClearToken, setDraftClearToken] = useState(0)
  // ── Вложения черновика (attachments) — переживают рестарт как и draft. ──
  // Хранятся в chat_draft_attachments + файлы в userData/draft-attachments/.
  // При отправке передаются в chat.send, draft очищается.
  const [draftAttachments, setDraftAttachments] = useState<Attachment[]>([])

  // ── Boot gate: сигнал App.tsx что ChatPage отрисовал контент ────────────
  // Двойной rAF после монтирования — к этому моменту первый paint уже прошёл,
  // store-данные (chats/messages из preload) отражены в DOM. App удерживает
  // BootScreen пока это false, иначе UI мелькал пустым шеллом. rAF даёт
  // браузеру шанс выполнить layout/paint перед снятием сплэша.
  useEffect(() => {
    const raf2 = requestAnimationFrame(() => requestAnimationFrame(() => {
      useChatStore.getState().setBootRendered(true)
    }))
    return () => cancelAnimationFrame(raf2)
  }, [])
  // замыкание в useEffect видит значения на момент создания, а нам нужны
  // свежие draft/modes при переключении chatId.
  const draftRef = useRef('')
  const draftAttachmentsRef = useRef<Attachment[]>([])
  const planningModeRef = useRef(false)
  const imageModeRef = useRef(false)
  const askModeRef = useRef(false)
  const prevChatIdRef = useRef<string | null>(null)
  const prevIsIncognitoRef = useRef(false)
  // In-memory история для инкогнито-чатов (chatId → DESC массив), чтобы
  // стрелки работали в инкогнито в рамках сессии, но не писались в БД.
  const incognitoHistoryRef = useRef<Map<string, string[]>>(new Map())
  // Debounce-таймер для черновика — чтобы не писать в БД на каждый символ.
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Debounce-таймер для вложений черновика — аналогично draft.
  const attachmentsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { draftRef.current = draft }, [draft])
  // Таймер зеркала draftLive не должен дёргать setState после размонтирования.
  useEffect(() => () => {
    if (draftLiveTimerRef.current !== null) {
      clearTimeout(draftLiveTimerRef.current)
      draftLiveTimerRef.current = null
    }
  }, [])
  useEffect(() => { draftAttachmentsRef.current = draftAttachments }, [draftAttachments])
  useEffect(() => { planningModeRef.current = planningMode }, [planningMode])
  useEffect(() => { imageModeRef.current = imageMode }, [imageMode])
  useEffect(() => { askModeRef.current = askMode }, [askMode])
  useEffect(() => { browserModeRef.current = browserMode }, [browserMode])

  const [showContextRing, setShowContextRing] = useState(true)
  const [mainModelId, setMainModelId] = useState('claude-sonnet-4-6')
  // Провайдер per-chat модели (mainModelId без провайдера бесполезен: одинаковые
  // id моделей бывают у разных провайдеров). Синхронизируется с mainModelId.
  const [mainModelProviderId, setMainModelProviderId] = useState('anthropic')
  // Глобальное назначение role:'main' (дефолт для чатов без своей модели).
  // Нужен как fallback при переключении на чат с model_id = NULL.
  const globalMainModelRef = useRef<{ modelId: string; providerId: string } | null>(null)
  // Текущие per-chat значения в ref — для handleMainModelChange и наследования
  // при создании нового чата (стейт в замыкании протухает в useCallback).
  const mainModelRef = useRef<{ modelId: string; providerId: string } | null>(null)
  const currentChatIdRef = useRef<string | null>(null)

  // ── One-turn оркестрация: дефолты из настроек + per-chat быстрый выбор ──
  // Дефолты (Settings → AI → Оркестрация) — только сид для блока над инпутом;
  // сам выбор живёт один ход и НЕ пишется глобально.
  const orchestrationDefaultsRaw = useSettingsStore(s => s.settings[ORCHESTRATION_DEFAULTS_KEY])
  const orchestrationDefaults: OrchestrationDefaults = useMemo(
    () => normalizeOrchestrationDefaults(orchestrationDefaultsRaw),
    [orchestrationDefaultsRaw]
  )

  /** Выбор исполнителя явный: основная модель никогда не подставляется за него. */
  const handleOrchestrationActivate = useCallback(() => {
    if (orchestration) { setOrchestrationIssue(null); return }
    // Сначала — что выбирали в ЭТОМ чате раньше (переживает перезапуск),
    // потом глобальные дефолты из настроек, иначе пустой исполнитель.
    const remembered = readOrchestrationForChat(
      useSettingsStore.getState().settings[ORCHESTRATION_BY_CHAT_KEY],
      currentChatId,
    )
    setOrchestration(remembered ?? {
      ...orchestrationDefaults,
      executor: orchestrationDefaults.executor ?? { providerId: '', modelId: '' },
    })
    setOrchestrationIssue(null)
  }, [orchestration, orchestrationDefaults, currentChatId])

  /** Изменить выбор в блоке над инпутом (null — выключить оркестрацию). */
  const handleOrchestrationChange = useCallback((next: OrchestrationSelection | null) => {
    setOrchestration(next)
    setOrchestrationIssue(null)
    // Пишем в стор на каждое изменение (модель, effort, ревьюер): иначе выбор
    // терялся после перезапуска и при возврате в чат. Закрытие блока (null) и
    // ещё не выбранный исполнитель сохранённое НЕ затирают.
    if (!currentChatId || !next || !isOrchestrationModel(next.executor)) return
    const store = useSettingsStore.getState()
    void store.set(
      ORCHESTRATION_BY_CHAT_KEY,
      writeOrchestrationForChat(store.settings[ORCHESTRATION_BY_CHAT_KEY], currentChatId, next),
    )
  }, [currentChatId])

  // Переключение чата — подставляем выбор этого чата. Если в чате ещё ничего
  // не выбирали, оставляем текущий (не закрываем блок молча).
  useEffect(() => {
    const saved = readOrchestrationForChat(
      useSettingsStore.getState().settings[ORCHESTRATION_BY_CHAT_KEY],
      currentChatId,
    )
    if (saved) setOrchestration(saved)
    setOrchestrationIssue(null)
  }, [currentChatId])

  const [reasoningValue, setReasoningValue] = useState('')
  // Глобальный reasoning (дефолт для чатов без своего значения) и ref текущего
  // значения — для наследования при создании нового чата.
  const globalReasoningRef = useRef<string>('')
  const reasoningRef = useRef<string>('')
  // Pick-guard: { chatId, ts } последнего ручного выбора пользователя
  // (модель или reasoning). Restore-цепочка при переключении чата НЕ должна
  // перезаписывать значение, которое пользователь уже выбрал в этом чате
  // после свитча — иначе поздний restore затирал свежий выбор (баг:
  // «выбрал max — ушло medium»).
  const lastUserPickRef = useRef<{ chatId: string; ts: number } | null>(null)
  // ChatId чата, в котором сейчас идёт manual /compact (null — нигде).
  // Привязан к chatId, а не boolean: при переключении на другой чат
  // compacting-индикатор НЕ должен утекать в чужую ленту (раньше
  // isCompacting:boolean рисовал блок внизу любого открытого чата).
  const [compactingChatId, setCompactingChatId] = useState<string | null>(null)
  // Стрим резюме при manual /compact: AI пишет резюме контекста в реальном
  // времени, токены приходят через IPC chat:compact-stream и показываются
  // в compacting-индикаторе (внизу чата). Копим по chatId в ref-Map — без
  // фильтра по текущему чату, чтобы при переключении и возврате резюме
  // было целиком (раньше фильтр по currentChatId терял начало стрима).
  // В state — текст только для текущего чата (для рендера).
  const [compactingSummary, setCompactingSummary] = useState('')
  const compactingSummariesRef = useRef<Map<string, string>>(new Map())
  // Сжатие идёт ИМЕННО в открытом сейчас чате — для индикатора/инпута.
  const isCompactingHere = compactingChatId !== null && compactingChatId === currentChatId

  // ── Кастомные slash-команды (из .md-файлов через CommandManager) ──
  // Загружаются при mount и при смене workdir (проектные команды).
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([])
  // ── /help модалка ──
  const [showHelp, setShowHelp] = useState(false)
  // ── /restore пикер именованных снапшотов ──
  const [snapshotPicker, setSnapshotPicker] = useState<CheckpointMeta[] | null>(null)
  // ── Модалка настроек проекта (открывается из hover-поповера на workdir-бейдже) ──
  const [settingsModalProject, setSettingsModalProject] = useState<Project | null>(null)

  // Хендлеры ниже обёрнуты в useCallback — ChatInput/Sidebar/LiveTodoBar
  // мемоизированы (React.memo), нестабильные ссылки на функции пробивали
  // бы memo при каждом ре-рендере ChatPage (стриминг 20×/сек, скролл).
  const handleReasoningChange = useCallback((value: string) => {
    setReasoningValue(value)
    reasoningRef.current = value
    // Per-chat: уровень мышления пишется в чат. Глобальная настройка тоже
    // обновляется — она дефолт для новых чатов и чатов без своего значения.
    const cid = currentChatIdRef.current
    if (cid) {
      lastUserPickRef.current = { chatId: cid, ts: Date.now() }
      window.syntee.chat.setReasoning(cid, value).catch(() => {})
    }
    window.syntee.settings.set('reasoningValue', value).catch(() => {})
  }, [])

  const handleMainModelChange = useCallback(async (modelId: string, providerId: string) => {
    setMainModelId(modelId)
    setMainModelProviderId(providerId)
    mainModelRef.current = { modelId, providerId }
    // Per-chat: модель пишется в чат (chats.model_id/model_provider), а НЕ в
    // глобальное назначение — у каждого чата своя модель. Глобальное main
    // меняется только из настроек и служит дефолтом для чатов без своей модели.
    const cid = currentChatIdRef.current
    if (cid) {
      lastUserPickRef.current = { chatId: cid, ts: Date.now() }
      window.syntee.chat.setModel(cid, modelId, providerId).catch((e: unknown) => {
        console.error('[ChatPage] chat:setModel error', e)
      })
    }
  }, [])

  // Смена модели чата извне (fork/импорт/дубликат пока чат открыт) — держим
  // UI-стейт синхронным с БД.
  useEffect(() => { currentChatIdRef.current = currentChatId }, [currentChatId])
  useEffect(() => { mainModelRef.current = mainModelId ? { modelId: mainModelId, providerId: mainModelProviderId } : null }, [mainModelId, mainModelProviderId])
  useEffect(() => { reasoningRef.current = reasoningValue }, [reasoningValue])

  useEffect(() => {
    window.syntee.settings.get('showContextRing').then((v: unknown) => {
      if (v !== null && v !== undefined) setShowContextRing(v as boolean)
    }).catch(() => {})
    window.syntee.settings.get('modelAssignments').then(async (v: unknown) => {
      if (Array.isArray(v)) {
        const main = (v as Array<{ role: string; modelId: string; providerId?: string }>).find(a => a.role === 'main')
        if (main) {
          globalMainModelRef.current = { modelId: main.modelId, providerId: main.providerId ?? 'anthropic' }
          // Ре-резолв для уже открытого чата: если у него нет своей модели —
          // применяем глобальную (chat-switch эффект мог отработать раньше
          // этой загрузки и застрять на дефолтном стейте).
          const cid = currentChatIdRef.current
          let chatModel: { modelId: string; modelProvider: string } | null = null
          if (cid) {
            try { chatModel = await window.syntee.chat.getModel(cid) } catch { /* ok */ }
          }
          const resolved = chatModel
            ? { modelId: chatModel.modelId, providerId: chatModel.modelProvider }
            : globalMainModelRef.current
          if (resolved && (!mainModelRef.current || mainModelRef.current.modelId !== resolved.modelId)) {
            setMainModelId(resolved.modelId)
            setMainModelProviderId(resolved.providerId)
          }
        }
      }
    }).catch(() => {})
    window.syntee.settings.get('reasoningValue').then(async (v: unknown) => {
      if (typeof v === 'string') globalReasoningRef.current = v
      // Ре-резолв для уже открытого чата: если у него нет своего значения —
      // применяем глобальное (как с моделью выше).
      const cid = currentChatIdRef.current
      let chatReasoning: string | null = null
      if (cid) {
        try { chatReasoning = await window.syntee.chat.getReasoning(cid) } catch { /* ok */ }
      }
      const resolved = chatReasoning ?? globalReasoningRef.current
      if (resolved && reasoningRef.current !== resolved) setReasoningValue(resolved)
    }).catch(() => {})
  }, [])

  // Уведомляем extensions-detector о смене активного проекта —
  // авто-детект MCP/skills сканирует .mcp.json / .syntee/skills/ проекта.
  // Туда же карта: активный проект получает весь приоритет индексации
  // (mapBuilder ставит его первым в очередь, семантика вычищает первой),
  // иначе main не знает, чей прогресс показывать и кого индексировать.
  useEffect(() => {
    window.syntee.extensions.setActiveProject(activeProjectId).catch(() => {})
    window.syntee.projectMap.setActiveProject(activeProjectId).catch(() => {})
    // Перезагружаем списки MCP/skills для этого проекта — иначе бейдж и
    // ExtensionsPopover показывают только глобальные серверы, без проектных
    // из .mcp.json. Без этого проектные MCP появляются только после ручного
    // открытия popover.
    if (activeProjectId) {
      useExtensionsStore.getState().loadMcpServers(activeProjectId)
      useExtensionsStore.getState().loadSkills(activeProjectId)
    } else {
      useExtensionsStore.getState().loadMcpServers()
      useExtensionsStore.getState().loadSkills()
    }
  }, [activeProjectId])

  // rateLimitSec читаем напрямую из узкого селектора (liveRateLimitSec) —
  // раньше был зеркальный local state + effect, что добавляло лишний
  // ре-рендер на каждый тик countdown'а при rate-limit.

  // Тосты при терминальных статусах запуска (ошибка/отмена) — только для текущего чата.
  // RACE GUARD (смена чата): при переключении на чат, чей последний запуск
  // упал с error, тост «Ошибка» не должен выстреливать — это СТАРЫЙ статус,
  // а не свежая ошибка. При смене чата синхронизируем baseline без тоста.
  const prevRunStatusRef = useRef<string | undefined>(undefined)
  const prevRunStatusChatIdRef = useRef<string | null>(currentChatId)
  useEffect(() => {
    if (!runStatus) return
    if (prevRunStatusChatIdRef.current !== currentChatId) {
      prevRunStatusChatIdRef.current = currentChatId
      prevRunStatusRef.current = runStatus.status
      return
    }
    const prev = prevRunStatusRef.current
    // Показываем тост только при переходе в error (не при cancel — это штатная остановка)
    if (runStatus.status === 'error' && prev !== 'error') {
      console.log('[chat-flow] runStatus=error chatId=%s error=%s', currentChatId, runStatus.error)
      toast('Ошибка: ' + (runStatus.error ?? 'неизвестная'), 'error')
    }
    prevRunStatusRef.current = runStatus.status
  }, [runStatus, toast, currentChatId])

  // Звук завершения привязан к явному IPC run-status, а не к isTyping.
  // isTyping меняется и при переключении чата/гидрации live-состояния, поэтому
  // переход true → false здесь давал ложный «ответ завершён» при навигации.
  // CHAT_RUN_STATUS приходит с chatId и является единственным источником
  // терминального завершения конкретного запуска.
  const prevRunSoundStatusRef = useRef<{ chatId: string | null; status?: string }>({ chatId: currentChatId })
  useEffect(() => {
    const previous = prevRunSoundStatusRef.current
    if (previous.chatId !== currentChatId) {
      prevRunSoundStatusRef.current = { chatId: currentChatId, status: runStatus?.status }
      return
    }
    const status = runStatus?.status
    const terminal = status === 'done' || status === 'error' || status === 'cancelled'
    const wasActive = previous.status === 'running' || previous.status === 'compacting'
    if (terminal && wasActive) {
      if (status === 'done') playDoneSound()
      // НЕ прыгаем в низ, если пользователь читает выше: раньше pin(true) на
      // каждом завершении прогона утаскивал его к последнему сообщению. Догон
      // низа остаётся только для тех, кто и так прилип к низу.
      if (pinnedRef.current) requestAnimationFrame(() => pinAutoscroll(true))
    }
    prevRunSoundStatusRef.current = { chatId: currentChatId, status }
    // pinAutoscroll объявлен ниже по коду (const), включать в deps нельзя —
    // упадёт с TDZ. Ссылка внутри тела эффекта безопасна после рендера.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatus?.status, currentChatId])

  // CHAT_COMPACTED — реакция на сжатие контекста в main (как авто-компакция
  // внутри chat:send когда токенов накопилось > rollingTriggerPct, так и
  // ручной /compact из другого окна). Перечитываем ленту из БД, чтобы в
  // renderer-store появился новый system-разделитель «Контекст сжат» —
  // иначе при авто-компакции renderer не знает что divider был сохранён.
  useEffect(() => {
    const off = window.syntee.on('chat:compacted', (data: unknown) => {
      const d = data as { chatId: string; trigger: 'auto' | 'manual' }
      if (d.chatId !== currentChatId) return
      // Manual /compact: invoke уже сделал setMessages(allMessages) — в ленте
      // есть новый divider (createdAt = граница middle|tail, поэтому он стоит
      // ПЕРЕД сохранённым tail'ом, а не в конце). НЕ дублируем getMessagesPage —
      // перезапись страницей последних 50 сообщений потеряла бы divider, если
      // сохранённый tail длиннее этой страницы. Guard пропускает
      // setMessagesWindow. Скроллим в низ (свежие сообщения ниже divider'а)
      // + пересчитываем контекст.
      if (manualCompactJustDoneRef.current) {
        manualCompactJustDoneRef.current = false
        isInitialScrollRef.current = true
        requestAnimationFrame(() => pinAutoscroll(true))
        window.syntee.context.calculate(d.chatId).catch(() => {})
        return
      }
      // Compact меняет историю (удаляет старые сообщения, добавляет divider
      // у хвоста). Сбрасываем окно к свежей последней странице — это корректно
      // отражает пост-compact состояние и авто-скроллит к низу.
      window.syntee.chat.getMessagesPage(d.chatId, 50).then((res: { messages: Message[]; hasMore: boolean }) => {
        if (useChatStore.getState().currentChatId !== d.chatId) return
        // Авто-компакция случается ПОСРЕДИ прогона: если пользователь читает
        // выше, не выдёргиваем его к низу — окно истории заменяется, но
        // scrollTop остаётся где был.
        const wasPinned = pinnedRef.current
        setMessagesWindow(d.chatId, res.messages, res.hasMore)
        if (wasPinned) {
          isInitialScrollRef.current = true
          requestAnimationFrame(() => pinAutoscroll(true))
        }
        if (d.trigger === 'auto') {
          toast('Контекст автоматически сжат', 'info')
        }
        // Двойная страховка: main уже эмитит CONTEXT_USAGE с source:'real'
        // после compaction, но если push не дошёл — попросим свежий расчёт.
        // lastRealRef в useContextCounter уже сброшен по этому же событию,
        // так что context:calculate (даже с source:'estimate') будет принят.
        window.syntee.context.calculate(d.chatId).catch(() => {})
      }).catch(() => {})
    })
    return () => { off() }
    // pinAutoscroll объявлен ниже по коду (const), включать его в deps нельзя —
    // deps вычисляется во время рендера и упал бы с TDZ (ReferenceError:
    // cannot access before initialization). Ссылка внутри тела эффекта
    // безопасна — оно выполняется после рендера.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatId, setMessagesWindow, toast])

  // CHAT_COMPACT_STREAM — стрим резюме при manual /compact. AI пишет резюме
  // контекста в реальном времени; токены аккумулируются по chatId в
  // compactingSummariesRef и показываются в compacting-индикаторе (внизу
  // чата) как live-markdown. При start-сигнале — сброс, при chunk —
  // аккумуляция. Только для manual /compact (авто-компакция стрим не шлёт).
  const compactingCurrentChatIdRef = useRef(currentChatId)
  compactingCurrentChatIdRef.current = currentChatId
  useEffect(() => {
    // Coalesce chunks arriving within one display frame. Text stays in the
    // per-chat Map immediately; only redundant React commits are deferred.
    let frame = 0
    const publish = () => {
      frame = 0
const chatId = compactingCurrentChatIdRef.current
      setCompactingSummary(chatId ? compactingSummariesRef.current.get(chatId) ?? '' : '')
    }
    const off = window.syntee.on('chat:compact-stream', (data: unknown) => {
      const d = data as { chatId: string; chunk?: string; start?: boolean }
      // Без фильтра по currentChatId: стрим может идти в чат, который
      // пользователь сейчас не открыл — копим в Map, чтобы при возврате
      // резюме показалось целиком.
      if (d.start) {
        compactingSummariesRef.current.delete(d.chatId)
        if (d.chatId === currentChatId) {
          if (frame) cancelAnimationFrame(frame)
          frame = 0
          setCompactingSummary('')
        }
        return
      }
      if (d.chunk) {
        const next = (compactingSummariesRef.current.get(d.chatId) ?? '') + d.chunk
        compactingSummariesRef.current.set(d.chatId, next)
        if (compactingCurrentChatIdRef.current === d.chatId && !frame) frame = requestAnimationFrame(publish)
      }
    })
    return () => { off(); if (frame) cancelAnimationFrame(frame) }
  }, [currentChatId])

  // Смена чата — показываем накопленное резюме сжимаемого чата (если
  // вернулись в него), иначе пусто. Сама Map чистится по завершении /compact.
  useEffect(() => {     setCompactingSummary(currentChatId ? compactingSummariesRef.current.get(currentChatId) ?? '' : '') }, [currentChatId])

  // Смена чата — очищаем множество анимированных id, чтобы сообщения нового
  // чата анимировались при появлении (как при полном перемонте раньше).
  useEffect(() => { animatedMsgIdsRef.current = new Set() }, [currentChatId])

  // Счётчик контекста
  const contextInfo = useContextCounter({
    chatId: currentChatId || '',
    // draftLive, а не draft: живой текст поля больше не поднимается в стейт
    // страницы (иначе ре-рендер на каждый символ) — кольцу хватает зеркала
    // с троттлингом, хук всё равно дебаунсит расчёт на 500мс.
    currentInput: draftLive,
    modelId: mainModelId,
    providerId: mainModelProviderId,
    incognito: isIncognito,
    enabled: showContextRing && !isIncognito,
    messageCount: messages.length,
    isRunning: isTyping,
  })

  // ── Wrapper'ы режимов инпут-бара ──
  // Каждый тумблер сохраняет ТОЛЬКО свой режим в БД (chats.planning_mode /
  // image_mode / ask_mode) — индивидуальный IPC-сеттер, не затрагивая
  // остальные два. Раньше писали все 3 разом через setModes, что вызывало
  // кросс-контаминацию: stale ref'ы других режимов затирали значения
  // чужого чата при race condition. Инкогнито не пишется — только in-memory.
  const handlePlanningModeChange = useCallback((v: boolean) => {
    setPlanningMode(v)
    if (!currentChatId || isIncognito) return
    window.syntee.chat.setPlanningMode(currentChatId, v).catch(e => console.error('[planningMode] IPC fail:', e))
  }, [currentChatId, isIncognito])
  const handleImageModeChange = useCallback((v: boolean) => {
    setImageMode(v)
    if (!currentChatId || isIncognito) return
    window.syntee.chat.setImageMode(currentChatId, v).catch(e => console.error('[imageMode] IPC fail:', e))
  }, [currentChatId, isIncognito])
  const handleAskModeChange = useCallback((v: boolean) => {
    setAskMode(v)
    if (!currentChatId || isIncognito) return
    window.syntee.chat.setAskMode(currentChatId, v).catch(e => console.error('[askMode] IPC fail:', e))
  }, [currentChatId, isIncognito])
  // Тумблер «Управление браузером»: пишет chats.browser_mode (main шлёт
  // BROWSER_MODE_CHANGED — но локальный флаг обновляем сразу, без эха).
  const handleBrowserModeChange = useCallback((v: boolean) => {
    setBrowserMode(v)
    browserModeRef.current = v
    if (!currentChatId || isIncognito) return
    window.syntee.chat.setBrowserMode(currentChatId, v).catch(e => console.error('[browserMode] IPC fail:', e))
  }, [currentChatId, isIncognito])

  // request_access подтверждён AI (диалог AgentConfirmDialog) — синкаем
  // режимы текущего чата с main-процессом.
  useEffect(() => {
    const offBrowser = window.syntee.browser.onModeChanged(({ chatId, enabled }) => {
      if (chatId !== prevChatIdRef.current) return
      setBrowserMode(enabled)
      browserModeRef.current = enabled
    })
    const offImage = window.syntee.chat.onImageModeChanged(({ chatId, enabled }) => {
      if (chatId !== prevChatIdRef.current) return
      setImageMode(enabled)
      imageModeRef.current = enabled
    })
    return () => { offBrowser(); offImage() }
  }, [])

  // ── In-app hotkeys для переключения режимов чата ──────────────────────
  // Ctrl+1 — toggle Ask (режим чтения), Ctrl+2 — toggle Planning.
  // Хоткеи читаются из settings.hotkeys (настраиваются в Настройки → Горячие клавиши).
  // Работают только внутри приложения (не глобальные).
  // Не перехватываем в полях ввода и вне страницы чата.
  useEffect(() => {
    const formatCombo = (e: KeyboardEvent): string => {
      const parts: string[] = []
      if (e.ctrlKey)  parts.push('Ctrl')
      if (e.altKey)   parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      if (e.metaKey)  parts.push('Meta')
      const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
      if (!['Control','Alt','Shift','Meta'].includes(e.key)) parts.push(key)
      return parts.join('+')
    }
    const handler = (e: KeyboardEvent) => {
      // Только на странице чата
      if (useNavStore.getState().mainPage !== 'chat') return

      // Fallback к DEFAULT_HOTKEYS: если settings ещё не загружен (load()
      // не завершился или упал), hotkeys будет пустым — используем дефолты,
      // чтобы кейбинды работали сразу при старте, без открытия настроек.
      const hotkeys = (useSettingsStore.getState().settings['hotkeys'] as Record<string, string>)
        ?? DEFAULT_HOTKEYS as Record<string, string>
      const combo = formatCombo(e)

      // Режим чтения (Ask) — fallback к DEFAULT_HOTKEYS.chatAskMode
      const askKey = hotkeys.chatAskMode ?? DEFAULT_HOTKEYS.chatAskMode
      if (askKey && combo === askKey) {
        e.preventDefault()
        const next = !askModeRef.current
        handleAskModeChange(next)
        // Снимаем planning если включаем ask (взаимоисключающие по смыслу)
        if (next && planningModeRef.current) handlePlanningModeChange(false)
        return
      }
      // Режим планирования (Planning) — fallback к DEFAULT_HOTKEYS.chatPlanningMode
      const planKey = hotkeys.chatPlanningMode ?? DEFAULT_HOTKEYS.chatPlanningMode
      if (planKey && combo === planKey) {
        e.preventDefault()
        const next = !planningModeRef.current
        handlePlanningModeChange(next)
        // Снимаем ask если включаем planning
        if (next && askModeRef.current) handleAskModeChange(false)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleAskModeChange, handlePlanningModeChange])

  // ── Черновик: debounced-сохранение в БД ──
  // 300мс задержка — чтобы не дёргать IPC на каждое нажатие. При смене
  // чата / размонтировании pending-таймер отменяется и сохранение идёт
  // синхронно в эффекте ниже.
  const handleDraftChange = useCallback((text: string) => {
    // ВАЖНО: setDraft здесь НЕ вызывается — иначе каждый символ ре-рендерит
    // страницу чата (главный источник статтеров при наборе). Живой текст
    // хранит сам ChatInput; сюда приходит уведомление для персиста.
    draftRef.current = text
    lastInputAtRef.current = performance.now()
    if (text === '') {
      // Очистка поля (отправка/сброс) — состояние родителя синхронизируем
      // сразу: пустой черновик должен быть виден всем потребителям.
      if (draftLiveTimerRef.current !== null) {
        clearTimeout(draftLiveTimerRef.current)
        draftLiveTimerRef.current = null
      }
      setDraft('')
      setDraftLive('')
    } else if (draftLiveTimerRef.current === null) {
      draftLiveTimerRef.current = setTimeout(() => {
        draftLiveTimerRef.current = null
        setDraftLive(draftRef.current)
      }, 350)
    }
    if (currentChatId && !isIncognito) {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current)
      // Крупный черновик (вставленный лог/JSON на сотни КБ) пишем реже:
      // UPDATE chats с мегабайтной строкой занимает main-процесс (он
      // однопоточный), и сразу после вставки это лишний фриз. Данные не
      // теряются — при смене чата/размонтировании draft сохраняется
      // синхронно в эффекте ниже.
      const delay = text.length > 50_000 ? 1500 : 300
      draftSaveTimerRef.current = setTimeout(() => {
        window.syntee.chat.setDraft(currentChatId, text).catch(() => {})
        draftSaveTimerRef.current = null
      }, delay)
    }
  }, [currentChatId, isIncognito])

  // Стабильный колбэк для инпут-бара: инлайн-стрелка в JSX (`onGoalChange=
  // {async g => ...}`) создавала новую ссылку на каждом ре-рендере страницы и
  // пробивала React.memo у ChatInput (при стриме страница рендерится ~20×/сек).
  const handleGoalChange = useCallback(async (g: ChatGoal | null) => {
    if (!currentChatId) return
    const saved = await window.syntee.goal.set(currentChatId, g)
    setChatGoal(saved)
  }, [currentChatId])

  // ── Вложения черновика: debounced-сохранение в БД ──
  // Аналогично draft — 300мс дебаунс. При смене чата сохраняем синхронно.
  // Инкогнито-чаты: только in-memory (не персистим).
  const handleAttachmentsChange = useCallback((atts: Attachment[]) => {
    setDraftAttachments(atts)
    draftAttachmentsRef.current = atts
    if (currentChatId && !isIncognito) {
      if (attachmentsSaveTimerRef.current) clearTimeout(attachmentsSaveTimerRef.current)
      attachmentsSaveTimerRef.current = setTimeout(() => {
        window.syntee.draft.setAttachments(currentChatId, atts).catch(() => {})
        attachmentsSaveTimerRef.current = null
      }, 300)
    }
  }, [currentChatId, isIncognito])

  // ── Загрузка/сохранение per-chat UI state при смене чата ──
  // При переключении chatId: сначала сохраняем draft/modes предыдущего
  // чата (если не инкогнито), затем загружаем draft/modes/history нового.
  // Инкогнито-чаты: сбрасываем режимы/черновик в дефолт, историю берём
  // из in-memory Map (если уже обращались к этому инкогнито-чату).
  useEffect(() => {
    const prevId = prevChatIdRef.current
    const prevIncog = prevIsIncognitoRef.current
    // Сохраняем старый чат (если был и не инкогнито)
    if (prevId && prevId !== currentChatId && !prevIncog) {
      if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null }
      if (attachmentsSaveTimerRef.current) { clearTimeout(attachmentsSaveTimerRef.current); attachmentsSaveTimerRef.current = null }
      window.syntee.chat.setDraft(prevId, draftRef.current).catch(() => {})
      window.syntee.draft.setAttachments(prevId, draftAttachmentsRef.current).catch(() => {})
      // Режимы (planning/image/ask) НЕ сохраняем при свитче — они пишутся
      // немедленно при тумблинге через индивидуальные IPC-сеттеры. Save-on-switch
      // здесь вызывал race condition: stale ref'ы затирали режимы чужого чата.
    }
    prevChatIdRef.current = currentChatId
    prevIsIncognitoRef.current = isIncognito

    if (!currentChatId) {
      setDraft('')
      setDraftLive('')
      setInputHistory([])
      setPlanningMode(false); setImageMode(false); setAskMode(false)
      setDraftAttachments([])
      draftRef.current = ''
      draftAttachmentsRef.current = []
      // Без чата — глобальные значения.
      if (globalMainModelRef.current) {
        setMainModelId(globalMainModelRef.current.modelId)
        setMainModelProviderId(globalMainModelRef.current.providerId)
      }
      setReasoningValue(globalReasoningRef.current)
      return
    }
    // Отменяем pending-debounce от прежнего чата
    if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null }
    if (attachmentsSaveTimerRef.current) { clearTimeout(attachmentsSaveTimerRef.current); attachmentsSaveTimerRef.current = null }

    if (isIncognito) {
      // Инкогнито: дефолт-значения, история из in-memory Map
      setDraft('')
      setDraftLive('')
      setPlanningMode(false); setImageMode(false); setAskMode(false)
      setDraftAttachments([])
      draftRef.current = ''
      draftAttachmentsRef.current = []
      setInputHistory(incognitoHistoryRef.current.get(currentChatId) ?? [])
      // Инкогнито не имеет per-chat модели/reasoning — глобальные значения.
      if (globalMainModelRef.current) {
        setMainModelId(globalMainModelRef.current.modelId)
        setMainModelProviderId(globalMainModelRef.current.providerId)
      }
      setReasoningValue(globalReasoningRef.current)
      return
    }

    // ── Восстановление модели + уровня мышления ────────────────────────────
    // ОТДЕЛЬНАЯ цепочка от modes/draft-загрузки: раньше модель сидела в общем
    // Promise.all, и падение ЛЮБОГО запроса (draft/history) уводило
    // весь chain в .catch — модель прошлого чата оставалась висеть. Теперь
    // модель восстанавливается независимо, с индивидуальными catch.
    // PICK-GUARD: если пользователь уже выбрал модель/reasoning в этом чате
    // ПОСЛЕ свитча — поздний restore не должен затирать свежий выбор.
    {
      const targetChatId = currentChatId
      const restoreStartedAt = Date.now()
      Promise.all([
        window.syntee.chat.getModel(targetChatId).catch(() => null),
        window.syntee.chat.getReasoning(targetChatId).catch(() => null),
      ]).then(([chatModel, chatReasoning]) => {
        // Guard: пользователь мог уйти на другой чат, пока грузилось.
        if (targetChatId !== prevChatIdRef.current) return
        // Pick-guard: свежий ручной выбор в этом чате важнее restore.
        const pick = lastUserPickRef.current
        if (pick && pick.chatId === targetChatId && pick.ts > restoreStartedAt) return
        const cm = chatModel as { modelId: string; modelProvider: string } | null
        const resolvedModel = cm
          ? { modelId: cm.modelId, providerId: cm.modelProvider }
          : globalMainModelRef.current
        if (resolvedModel) {
          setMainModelId(resolvedModel.modelId)
          setMainModelProviderId(resolvedModel.providerId)
        }
        const resolvedReasoning = (chatReasoning as string | null) ?? globalReasoningRef.current
        setReasoningValue(resolvedReasoning)
      }).catch(() => { /* оба промиса уже имеют catch — сюда не попадём */ })
    }

    // Обычный чат: грузим modes/draft/history/attachments из БД параллельно.
    // Сначала сбрасываем режимы в false синхронно — чтобы UI не показывал
    // вспышку режимов предыдущего чата пока async-load не завершится.
    setPlanningMode(false); setImageMode(false); setAskMode(false); setBrowserMode(false)
    planningModeRef.current = false; imageModeRef.current = false; askModeRef.current = false
    browserModeRef.current = false
    let cancelled = false
    Promise.all([
      window.syntee.chat.getModes(currentChatId).catch(() => null),
      window.syntee.chat.getBrowserMode(currentChatId).catch(() => null),
      window.syntee.chat.getDraft(currentChatId).catch(() => null),
      window.syntee.chat.getInputHistory(currentChatId).catch(() => null),
      window.syntee.draft.getAttachments(currentChatId).catch(() => null),
      window.syntee.chat.getLastTurnChanges?.(currentChatId).catch(() => null),
    ]).then(([modes, browserModeLoaded, draftText, history, attachments, lastChanges]) => {
      if (cancelled || currentChatId !== prevChatIdRef.current) return
      useChatStore.getState().setLastTurnChanges(currentChatId, lastChanges ?? null)
      if (modes) {
        setPlanningMode(!!modes.planningMode)
        setImageMode(!!modes.imageMode)
        setAskMode(!!modes.askMode)
        planningModeRef.current = !!modes.planningMode
        imageModeRef.current = !!modes.imageMode
        askModeRef.current = !!modes.askMode
      }
      // Тумблер «Управление браузером» (chats.browser_mode).
      if (typeof browserModeLoaded === 'boolean') {
        setBrowserMode(browserModeLoaded)
        browserModeRef.current = browserModeLoaded
      }
      const d = typeof draftText === 'string' ? draftText : ''
      setDraft(d)
      setDraftLive(d)
      draftRef.current = d
      // Вложения черновика
      const atts = Array.isArray(attachments) ? attachments : []
      setDraftAttachments(atts)
      draftAttachmentsRef.current = atts
      // Самолечение чипов-заглушек: битый path → поиск копии в draft-папке.
      void repairDraftAttachments(currentChatId, atts).then(fixed => {
        if (cancelled || currentChatId !== prevChatIdRef.current) return
        const changed = fixed.some((a, i) => a.path !== atts[i]?.path)
        if (changed) {
          setDraftAttachments(fixed)
          draftAttachmentsRef.current = fixed
          window.syntee.draft.setAttachments(currentChatId, fixed).catch(() => {})
        }
      }).catch(() => {})
      // Дедупликация подряд идущих дубликатов + reverse → DESC (свежий первым)
      const raw = Array.isArray(history) ? history : []
      const dedup: string[] = []
      for (const s of raw) {
        if (dedup.length === 0 || dedup[dedup.length - 1] !== s) dedup.push(s)
      }
      dedup.reverse()
      setInputHistory(dedup)
    }).catch(() => {
      if (cancelled) return
      setDraft(''); setDraftLive(''); setPlanningMode(false); setImageMode(false); setAskMode(false); setBrowserMode(false)
      browserModeRef.current = false
      setInputHistory([])
      setDraftAttachments([]); draftAttachmentsRef.current = []
    })
    return () => { cancelled = true }
  }, [currentChatId, isIncognito])

  // ── beforeunload: сохраняем черновик текущего чата при закрытии окна ──
  // Debounce 300мс может не успеть сработать перед закрытием. Fire-and-forget
  // через ipcRenderer.send — без ожидания ответа. Не гарантируется доставка,
  // но покрывает большинство случаев.
  useEffect(() => {
    const handler = () => {
      const id = prevChatIdRef.current
      if (id && !prevIsIncognitoRef.current) {
        try {
          window.syntee.chat.setDraft(id, draftRef.current).catch(() => {})
          window.syntee.draft.setAttachments(id, draftAttachmentsRef.current).catch(() => {})
          // Режимы НЕ сохраняем — они уже сохранены при тумблинге.
        } catch { /* окно уже закрывается — ок */ }
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Selection reply — выделил текст в чате → popup с кнопкой Reply
  useEffect(() => {
    let lastFireTime = 0
    const handleMouseUp = (e: MouseEvent) => {
      // ChatPage keep-alive — игнорируем выделение, пока чат не активен.
      if (useNavStore.getState().mainPage !== 'chat') return
      const now = Date.now()
      if (now - lastFireTime < 100) return
      lastFireTime = now

      const sel = window.getSelection()
      const text = sel?.toString().trim()
      if (!text || text.length < 5) { setSelectionPopup(null); return }
      const anchor = sel?.anchorNode?.parentElement
      if (!anchor?.closest('.chat-messages')) { setSelectionPopup(null); return }
      const range = sel?.getRangeAt(0)
      if (!range) return
      // Позиционируем popup по концу выделения (где курсор), а не по полному rect —
      // иначе при многострочном выделении popup улетает далеко.
      const endRange = document.createRange()
      endRange.setStart(range.endContainer, range.endOffset)
      endRange.setEnd(range.endContainer, range.endOffset)
      let r = endRange.getBoundingClientRect()
      // Если caret-rect пустой — fallback на полный rect
      if (!r || (r.width === 0 && r.height === 0)) {
        r = range.getBoundingClientRect()
      }
      if (!r) return
      const POPUP_W = 200, POPUP_H = 40, MARGIN = 8
      let px = r.left + r.width / 2
      let py = r.bottom + MARGIN
      if (py + POPUP_H > window.innerHeight - MARGIN) {
        py = r.top - POPUP_H - MARGIN
      }
      if (py < MARGIN) py = MARGIN
      px = Math.max(POPUP_W / 2 + MARGIN, Math.min(px, window.innerWidth - POPUP_W / 2 - MARGIN))
      setSelectionPopup({ x: px, y: py, text })
    }
    const handleMouseDown = (e: MouseEvent) => {
      if (useNavStore.getState().mainPage !== 'chat') return
      if ((e.target as HTMLElement)?.closest('.selection-reply-popup')) return
      setSelectionPopup(null)
    }
    const handleScroll = () => {
      if (useNavStore.getState().mainPage !== 'chat') return
      setSelectionPopup(null)
    }
    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('scroll', handleScroll, true)
    }
  }, [])

  useEffect(() => {
    window.syntee.agent.getSettings().then((s: { toolOutputMode?: ToolOutputMode }) => {
      if (s.toolOutputMode) setToolOutputMode(s.toolOutputMode)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ChatPage теперь keep-alive (всегда смонтирован) — не реагируем на
      // горячие клавиши чата, пока активна другая вкладка (settings/memory/...).
      if (useNavStore.getState().mainPage !== 'chat') return
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(v => !v)
      }
      if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); setSearchMatchIds([]) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Загрузка чатов и проектов.
  // На ПЕРВОМ старте (currentChatId === null) — открываем первый чат.
  // На REMOUNT (возврат из настроек/памяти, currentChatId уже есть) — НЕ
  // дёргаем selectChat (он бы перерисовал текущий чат с stale-сообщениями
  // из store, а потом ещё раз перезагрузил из БД → двойная загрузка).
  // Вместо этого тихо освежаем chats (sidebar) и в фоне подтягиваем
  // свежие messages для текущего чата — но только если они отличаются,
  // иначе нулевой ре-рендер (нулевой визуальный флэш).
  useEffect(() => {
    window.syntee.projects.getAll().then((all: Project[]) => {
      setProjects(all)
    })
    window.syntee.chat.getAll().then((all: Chat[]) => {
      setChats(all)
      const store = useChatStore.getState()
      const curId = store.currentChatId
      // Чат удалён/архивирован пока пользователя не было — сброс.
      const curExists = curId && all.some(c => c.id === curId)
      if (!curExists) {
        if (all.length > 0) selectChat(all[0].id)
        return
      }
      // Первый запуск — выбираем первый чат.
      if (!curId) {
        if (all.length > 0) selectChat(all[0].id)
        return
      }
      // Remount: тихий фоновый refresh хвоста сообщений для текущего чата.
      // С пагинацией: если окно полное (hasOlder=false) — сверяем хвост с
      // свежей последней страницей и при расхождении заменяем окно. Если
      // hasOlder=true (пользователь догрузил старые страницы) — НЕ трогаем
      // messages, чтобы не сбросить позицию прокрутки; лишь правим флаг hasMore.
      window.syntee.chat.getMessagesPage(curId, 50).then((res: { messages: Message[]; hasMore: boolean }) => {
        const st = useChatStore.getState()
        const isCurrent = st.currentChatId === curId
        // НЕ отменяем сверку при свитче — обновляем кеш silently.
        if (isCurrent && st.hasOlderMessages) {
          if (st.hasOlderMessages !== res.hasMore) setHasOlderMessages(res.hasMore)
          return
        }
        // RACE GUARD: пока стрим активен, checkpoint-таймер main сохраняет
        // partial-сообщение в БД каждые 3с. getMessagesPage может вернуть
        // partial (незаконченный ответ) → попадёт в кэш → раздвоение с
        // live-пузырём. Не трогаем кэш пока liveByChat[chatId].isTyping.
        if (st.liveByChat[curId]?.isTyping) return
        const cached = st.messagesByChat[curId]
        const curLastId = cached?.messages.length ? cached.messages[cached.messages.length - 1].id : null
        const freshLastId = res.messages.length ? res.messages[res.messages.length - 1].id : null
        if (curLastId !== freshLastId) {
          setMessagesWindow(curId, res.messages, res.hasMore)
        } else if (isCurrent && st.hasOlderMessages !== res.hasMore) {
          setHasOlderMessages(res.hasMore)
        }
      }).catch(() => { /* ok — оставляем stale, не критично */ })
    })
    // Намеренно mount-once: selectChat объявлен ниже по коду (const), включать
    // его в deps нельзя — deps вычисляется во время рендера и упал бы с TDZ
    // (ReferenceError: cannot access before initialization). Ссылки внутри
    // тела эффекта безопасны — оно выполняется после рендера.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // АВТОСКРОЛЛ — умный движок «прилип/отлип» (useChatAutoscroll).
  // Прилип к низу → rAF-loop плавно догоняет любой рост контента; колесо
  // вверх / touch-drag вверх / скроллбар вверх → мгновенный отлип; ручной
  // доезд до низа / отправка / кнопка «вниз» → прилип. Подробности — в хуке.
  // Хук подключается ниже (после loadOlderMessagesRef — onScrollExtra едит его).

  // ── Reverse-infinite scroll: догрузка старых сообщений вверх ──────────────
  // prependingRef хранит scroll-геометрию ДО догрузки; useLayoutEffect после
  // рендера компенсирует прирост высоты, выставляя scrollTop так, чтобы
  // визуальная позиция чтения не прыгнула (иначе prepend «уезжает» к низу).
  const prependingRef = useRef<{ oldScrollHeight: number; oldScrollTop: number } | null>(null)

  const loadOlderMessages = useCallback(async () => {
    const st = useChatStore.getState()
    if (st.isLoadingOlder || !st.hasOlderMessages || !st.currentChatId) return
    const oldest = st.messages[0]
    if (!oldest) return
    const el = scrollContainerRef.current
    if (el) prependingRef.current = { oldScrollHeight: el.scrollHeight, oldScrollTop: el.scrollTop }
    setIsLoadingOlder(true)
    try {
      const res = await window.syntee.chat.getMessagesPage(st.currentChatId, 50, oldest.createdAt, oldest.id) as { messages: Message[]; hasMore: boolean }
      // Пока грузили — пользователь мог сменить чат. Не пишем в чужое окно.
      if (useChatStore.getState().currentChatId !== st.currentChatId) return
      prependOlderMessages(st.currentChatId, res.messages, res.hasMore)
    } catch {
      setIsLoadingOlder(false)
    }
  }, [prependOlderMessages, setIsLoadingOlder])

  // Стабильный ref для handleScroll (чтобы не плодить её ре-рендеры).
  const loadOlderMessagesRef = useRef(loadOlderMessages)
  loadOlderMessagesRef.current = loadOlderMessages

  // Подключение движка автоскролла. onScrollExtra — догрузка старых сообщений
  // у верхнего края (reverse-infinite scroll), вызывается в rAF-throttled
  // scroll-хендлере хука.
  const {
    pinnedRef,
    showScrollDownBtn,
    pin: pinAutoscroll,
    unpin: unpinAutoscroll,
    syncScrollState,
    handleScroll,
    handleWheel,
    handleMouseDown,
    handleTouchStart,
    handleTouchMove,
  } = useChatAutoscroll({
    scrollContainerRef,
    isStreaming: isTyping,
    onScrollExtra: () => {
      const el = scrollContainerRef.current
      if (!el) return
      // Reverse-infinite scroll: близко к верху и есть ещё старые → грузим.
      if (el.scrollTop < 200 && hasOlderMessages && !isLoadingOlder && currentChatId) {
        loadOlderMessagesRef.current()
      }
    },
  })

  // Мгновенный скролл вниз по клику на floating-кнопку + закрепление.
  // instant=true — прыжок без анимации даже во время стрима (иначе rAF-loop
  // догона ползёт шагом ≤90px/кадр — в длинном чате секунды) + «липкий низ».
  const handleScrollDownClick = () => pinAutoscroll(true)

  // Компенсация скролла после prepend: визуальная позиция чтения сохраняется.
  // Срабатывает только когда prependingRef выставлен (т.е. после догрузки).
  useLayoutEffect(() => {
    const snap = prependingRef.current
    if (!snap) return
    const el = scrollContainerRef.current
    prependingRef.current = null
    if (!el) return
    const delta = el.scrollHeight - snap.oldScrollHeight
    if (delta > 0) {
      el.scrollTop = snap.oldScrollTop + delta
      // Внешняя запись scrollTop — синхронизируем refs движка автоскролла.
      syncScrollState()
    }
  }, [messages.length, syncScrollState])

  // ── Тихая фоновая догрузка всей истории (для чатов ≤ LARGE_CHAT_THRESHOLD)
  // Переиспользует prependingRef для скролл-компенсации (тот же useLayoutEffect
  // выше). Большие чаты пропускаются — для них reverse-infinite scroll со
  // спиннером. Дедуп со скролл-триггером — через стор-флаг isLoadingOlder
  // (он же используется loadOlderMessages). Подробности — в хуке.
  useBackgroundLoadFullChat({
    chatId: currentChatId,
    isLargeChat,
    prependingRef,
    scrollContainerRef,
    isBusy: () => useChatStore.getState().isLoadingOlder,
    setBusy: (v) => useChatStore.getState().setIsLoadingOlder(v),
    // Не догружаем историю, пока в инпуте была активность за последние 1.2с.
    isUserTyping: () => performance.now() - lastInputAtRef.current < 1200,
  })

  // Загрузка тоггла миникарты сообщений в settings store — дальше компонент
  // ChatMinimap читает его оттуда (переключение в настройках применяется live,
  // без перезапуска; дефолт — включено).
  useEffect(() => {
    window.syntee.settings.get('chatMinimap').then((v: unknown) => {
      if (v !== null && v !== undefined) {
        useSettingsStore.setState(s => ({ settings: { ...s.settings, chatMinimap: v } }))
      }
    }).catch(() => {})
  }, [])

  // Динамический отступ под ChatInput
  // ChatInput всегда смонтирован (FileEditorPane перенесён в RightPanel),
  // поэтому deps пустой — ResizeObserver живёт всё время.
  useEffect(() => {
    const holder = chatInputWrapRef.current
    const container = holder?.parentElement
    const wrap = holder?.firstElementChild as HTMLElement | undefined
    if (!wrap || !container) return
    const apply = () => {
      container.style.setProperty('--chat-input-h', `${wrap.offsetHeight}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // Первый скролл при открытии чата — мгновенно к низу + прилип. Дальнейшее
  // следование за ростом контента (токены, тулы, todo) делает rAF-loop
  // движка автоскролла — отдельные эффекты/RO не нужны.
  useEffect(() => {
    if (isLoadingMessages || displayMessages.length === 0) return
    if (isInitialScrollRef.current) {
      requestAnimationFrame(() => { pinAutoscroll(true); isInitialScrollRef.current = false })
    }
    // currentChatId в deps обязателен: окно истории почти всегда ровно 50
    // сообщений (или вся короткая история), поэтому при переключении между
    // двумя чатами длина ленты ЧАСТО НЕ МЕНЯЕТСЯ. Без currentChatId эффект
    // не перезапускался → новый чат открывался с сохранённым scrollTop
    // предыдущего (середина ленты вместо низа).
    // В deps именно messages.length, а не displayMessages.length: displayMessages
    // объявлен НИЖЕ по коду, его чтение в массиве зависимостей — TDZ.
  }, [messages.length, isTyping, isLoadingMessages, isCompactingHere, pinAutoscroll, currentChatId])

  // ── Индикатор переключения чата: показать / убрать ──────────────────────
  // showVeil монтирует индикатор и сразу же отдаёт кадр браузеру: fade-in
  // (CSS-transition на compositor) успевает стартовать ДО тяжёлого рендера
  // ленты, поэтому продолжает идти, даже пока main thread заблокирован.
  const showVeil = useCallback(() => {
    if (veilHideTimerRef.current) { clearTimeout(veilHideTimerRef.current); veilHideTimerRef.current = null }
    veilVisibleRef.current = true
    setVeilPhase('shown')
  }, [])

  // hideVeil — плавное затухание. Элемент снимаем только после окончания
  // transition (160ms + запас): иначе он исчезнет резко, без fade-out.
  const hideVeil = useCallback(() => {
    if (!veilVisibleRef.current) return
    veilVisibleRef.current = false
    if (veilHideTimerRef.current) clearTimeout(veilHideTimerRef.current)
    setVeilPhase('out')
    veilHideTimerRef.current = setTimeout(() => {
      veilHideTimerRef.current = null
      setVeilPhase('off')
    }, 200)
  }, [])

  // Чистка таймера вуали при размонтировании (ChatPage keep-alive, но
  // при выходе из приложения таймер не должен дёргать setState).
  useEffect(() => () => {
    if (veilHideTimerRef.current) clearTimeout(veilHideTimerRef.current)
  }, [])

  const selectChat = useCallback(async (id: string) => {
    // Номер попытки: при быстрых кликах A→B→C каждая ветка ниже проверяет,
    // что её не перебили, — иначе поздний await вернул бы UI на уже
    // покинутый чат и снял вуаль поверх чужого контента.
    const seq = ++chatSwitchSeqRef.current
    const st0 = useChatStore.getState()
    // Клик по уже активному чату — ничего не перерисовываем. Сюда же
    // попадает возврат в текущий чат, пока предыдущий свич ещё ждал кадр
    // под вуалью: отменяем его (seq уже сдвинут) и вуаль убираем.
    if (st0.currentChatId === id) {
      hideVeil()
      return
    }
    // Был ли уже открыт какой-то чат. При первом открытии (boot, экран пуст)
    // вуаль не нужна — маскировать нечего, и лишний кадр задержки ни к чему.
    const hadChat = !!st0.currentChatId

    isInitialScrollRef.current = true
    pinAutoscroll(true)
    // Сбрасываем unread-бейдж этого чата (пользователь его увидел)
    markChatRead(id)

    // Активный чат переключаем СРАЗУ: подсветка вкладки/строки сайдбара и
    // верхний кластер должны отреагировать на клик мгновенно. Лента при этом
    // ещё показывает сообщения старого чата (messages — общее поле стора),
    // их подменит ветка ниже — уже под вуалью.
    setCurrentChat(id)

    const cached = useChatStore.getState().messagesByChat[id]

    // ── Вуаль: отдаём браузеру кадр ДО тяжёлого рендера ──
    // Коммит выше дешёвый (ряды ленты мемоизированы по msg, массив messages
    // не менялся). settleFrame() гарантирует, что кадр с уже идущим
    // fade-in вуали отрисован, поэтому тяжёлый рендер новой ленты ниже
    // идёт ПОД вуалью, а не вместо неё.
    //
    // Вуаль нужна не всегда:
    //  • cache hit на лёгком окне — рендер занимает единицы миллисекунд,
    //    фриза нет, а вуаль только мелькала бы. Пропускаем;
    //  • cache miss — вуаль работает ещё и индикатором ожидания IPC.
    const needsVeil = hadChat && (!cached || isHeavyMessageWindow(cached.messages))
    if (needsVeil) {
      showVeil()
      await settleFrame()
      if (seq !== chatSwitchSeqRef.current) return
    }

    // ── Мгновенный показ из LRU-кеша (если есть) ──
    // Кэш-хит: показываем сообщения сразу, БЕЗ скелетона и БЕЗ ожидания IPC.
    // hydrateFromMain + getQueue + фоновая сверка хвоста запускаются параллельно
    // и не блокируют первый рендер. Раньше 2 последовательных IPC-раунда
    // (getLiveState → getQueue) стояли ДО проверки кеша → скелетон на 120мс+.
    if (cached) {
      setMessagesWindow(id, cached.messages, cached.hasOlder)
      // Запускаем 3 фоновых IPC параллельно (не блокируют рендер):
      void Promise.all([
        // 1. Гидрируем live-состояние из main — если в чате работает агент,
        //    показываем накопленный прогресс (текст/шаги/thinking).
        hydrateFromMain(id),
        // 2. Очередь ожидающих запросов — для бейджа очереди в сайдбаре.
        window.syntee.chat.getQueue(id).then((q: unknown) => {
          if (useChatStore.getState().currentChatId === id) {
            useChatStore.getState().setQueue(id, q as QueueItemMeta[])
          }
        }).catch(() => {}),
        // 3. Фоновая сверка хвоста: если пришли новые сообщения — заменяем окно.
        window.syntee.chat.getMessagesPage(id, 50).then((res: unknown) => {
          const r = res as { messages: Message[]; hasMore: boolean }
          const st = useChatStore.getState()
          const isCurrent = st.currentChatId === id
          // RACE GUARD: пока стрим активен, checkpoint-таймер main сохраняет
          // partial-сообщение в БД каждые 3с. getMessagesPage может вернуть
          // partial (незаконченный ответ) → попадёт в кэш → раздвоение с
          // live-пузырём. Не трогаем кэш пока liveByChat[chatId].isTyping.
          if (st.liveByChat[id]?.isTyping) return
          const c = st.messagesByChat[id]
          const cachedLastId = c?.messages.length ? c.messages[c.messages.length - 1].id : null
          const freshLastId = r.messages.length ? r.messages[r.messages.length - 1].id : null
          if (cachedLastId !== freshLastId) {
            setMessagesWindow(id, r.messages, r.hasMore)
            if (isCurrent) {
              isInitialScrollRef.current = true
              requestAnimationFrame(() => pinAutoscroll(true))
            }
          } else if (isCurrent && st.hasOlderMessages !== r.hasMore) {
            setHasOlderMessages(r.hasMore)
          }
        }).catch(() => {}),
      ])
      // Новый чат уже отрисован → плавно снимаем вуаль.
      await settleFrame()
      if (seq === chatSwitchSeqRef.current) hideVeil()
      return
    }

    // ── Cache miss: история грузится по IPC, всё это время лента закрыта
    // вуалью со спиннером (раньше здесь был скелетон с задержкой 120мс:
    // первые 120мс висел замороженный СТАРЫЙ чат, потом скелетон, потом
    // новый чат — три состояния подряд вместо одного). Скелетон вдобавок
    // размонтировал .chat-messages, теряя scroll-контейнер и позицию.
    setIsLoadingMessages(true)
    // hydrateFromMain + getQueue — параллельно с getMessagesPage (не блокируют
    // первый рендер сообщений). Раньше они шли последовательно ДО getMessagesPage.
    try {
      const [res] = await Promise.all([
        window.syntee.chat.getMessagesPage(id, 50) as Promise<{ messages: Message[]; hasMore: boolean }>,
        hydrateFromMain(id),
        window.syntee.chat.getQueue(id).then((q: unknown) => {
          if (useChatStore.getState().currentChatId === id) {
            useChatStore.getState().setQueue(id, q as QueueItemMeta[])
          }
        }).catch(() => {}),
      ])
      // Race-guard: пока шли await'ы, пользователь мог кликнуть другой чат.
      // cleanup в finally всё равно отработает — isLoadingMessages не залипнет.
      if (useChatStore.getState().currentChatId === id) {
        setMessagesWindow(id, res.messages, res.hasMore)
      }
    } catch {
      // getMessagesPage упал — оставляем пустой чат (или stale кэш если есть).
      // Не показываем ошибку: пользователь увидит empty-state и может повторить.
    } finally {
      // Гарантированно сбрасываем loading-флаг и вуаль, даже при ошибке
      // или race (пользователь кликнул другой чат). Без finally isLoadingMessages
      // мог залипнуть → ломало автоскролл.
      setIsLoadingMessages(false)
      await settleFrame()
      if (seq === chatSwitchSeqRef.current) hideVeil()
    }
    // Deps: все используемые значения — стабильные store-actions/useCallback'и.
  }, [setCurrentChat, markChatRead, setMessagesWindow, setHasOlderMessages, pinAutoscroll, showVeil, hideVeil])

  const createNewChat = useCallback(async (projectId?: string) => {
    let pid = projectId ?? activeProjectId
    if (!pid) {
      const picked = await window.syntee.projects.pickWorkdir()
      if (!picked) return
      const project: Project = await window.syntee.projects.create(picked)
      const allProjects: Project[] = await window.syntee.projects.getAll()
      setProjects(allProjects)
      setActiveProject(project.id)
      pid = project.id
    }
    // Новый чат наследует модель и уровень мышления текущего чата (ref'ы, не
    // стейт: переживают протухшее замыкание useCallback).
    // ВНИМАНИЕ: ключи IPC-контракта — modelId/modelProvider, а ref хранит
    // providerId. Раньше спред {...mainModelRef.current} переносил providerId,
    // который main игнорировал → model_provider = NULL в БД → getChatModel
    // возвращал null → чат падал на глобальную модель.
    const cur = mainModelRef.current
    const inherit = cur
      ? { modelId: cur.modelId, modelProvider: cur.providerId, reasoningValue: reasoningRef.current || undefined }
      : (reasoningRef.current ? { reasoningValue: reasoningRef.current } : undefined)
    const chat: Chat = await window.syntee.chat.create(isIncognito, activeMode, pid, inherit)
    const all: Chat[] = await window.syntee.chat.getAll()
    setChats(all)
    setCurrentChat(chat.id)
    setMessages([])
    pinAutoscroll()
    isInitialScrollRef.current = true
  }, [activeProjectId, isIncognito, activeMode, setProjects, setActiveProject, setChats, setCurrentChat, setMessages, pinAutoscroll])

  const createNewProject = useCallback(async (mode: 'empty' | 'existing' = 'existing') => {
    const picked = mode === 'empty'
      ? await window.syntee.projects.pickNewWorkdir()
      : await window.syntee.projects.pickWorkdir()
    if (!picked) return
    const project: Project = await window.syntee.projects.create(picked)
    const allProjects: Project[] = await window.syntee.projects.getAll()
    setProjects(allProjects)
    setActiveProject(project.id)
  }, [setProjects, setActiveProject])

  const createChatWithoutProject = useCallback(async () => {
    // Наследуем модель и уровень мышления текущего чата (см. createNewChat;
    // ключи маппим явно: providerId → modelProvider).
    const cur = mainModelRef.current
    const inherit = cur
      ? { modelId: cur.modelId, modelProvider: cur.providerId, reasoningValue: reasoningRef.current || undefined }
      : (reasoningRef.current ? { reasoningValue: reasoningRef.current } : undefined)
    const chat: Chat = await window.syntee.chat.create(isIncognito, activeMode, undefined, inherit)
    const all: Chat[] = await window.syntee.chat.getAll()
    setChats(all)
    setCurrentChat(chat.id)
    setMessages([])
    pinAutoscroll()
    isInitialScrollRef.current = true
  }, [isIncognito, activeMode, setChats, setCurrentChat, setMessages, pinAutoscroll])

  /**
   * Вызывается после установки MCP/Skill через маркетплейс расширений —
   * чат уже создан и chat:send уже отправлен (агент начал работать).
   * Переключаемся на чат и инициализируем live-стрим ТОЧНО как в handleSend:
   * addMessage(userMsg) + initChatSend(chatId) — без этого live-буфер стрима
   * не инициализируется (streamMsgId остаётся null) и прогресс агента/финальный
   * ответ не отображаются, хотя агент реально работает в фоне.
   */
  const handleExtensionInstalled = useCallback(async (chatId: string, projectId: string | undefined, userMsg: Message) => {
    if (projectId) {
      const allProjects: Project[] = await window.syntee.projects.getAll()
      setProjects(allProjects)
      setActiveProject(projectId)
    }
    const all: Chat[] = await window.syntee.chat.getAll()
    setChats(all)
    setCurrentChat(chatId)
    setMessages([])
    addMessage(userMsg)
    initChatSend(chatId)
    pinAutoscroll()
    isInitialScrollRef.current = true
  }, [setProjects, setActiveProject, setChats, setCurrentChat, setMessages, addMessage, pinAutoscroll])

  // ── Вкладки чатов в шапке ──
  // Любой путь выбора чата (сайдбар, boot, fork, slash-команды, установка
  // расширений) идёт через setCurrentChat → вкладка открывается здесь,
  // одной точкой. Заодно персистим активную вкладку для восстановления
  // сессии при следующем запуске.
  useEffect(() => {
    if (!currentChatId) return
    useTabsStore.getState().openTab(currentChatId)
    window.syntee.settings.set('activeChatTab', currentChatId)
  }, [currentChatId])

  // Мост для TitleBar (он рендерится в App и не видит колбэки ChatPage).
  // ChatPage keep-alive (всегда смонтирован) → регистрация живёт всю сессию.
  useEffect(() => {
    tabActions.selectChat = (id) => { void selectChat(id) }
    tabActions.createInContext = () => {
      // Новый чат в контексте текущего: чат проекта → новый чат в том же
      // проекте; чат без проекта → новый чат без проекта.
      const st = useChatStore.getState()
      const chat = st.chats.find(c => c.id === st.currentChatId)
      if (chat?.projectId) void createNewChat(chat.projectId)
      else void createChatWithoutProject()
    }
    return () => { tabActions.selectChat = null; tabActions.createInContext = null }
  }, [selectChat, createNewChat, createChatWithoutProject])

  const handleSend = useCallback(async (text: string, override?: { orchestration?: OrchestrationSelection | null; orchestrationResume?: OrchestrationResume | null }) => {
    const raw = text.trim()
    const slash = parseSlashCommandWithCustom(raw, customCommands)

    // ── /orchestrate — one-turn оркестрация ─────────────────────────────
    // Обычно команду снимает ChatInput (активация без потери черновика).
    // Сюда попадает «сырой» путь (плагин/silent send): включаем блок выбора
    // моделей и оставляем остаток текста в поле — ничего не отправляем.
    if (slash?.command.orchestration || /^\/orchestrate(?:\s+|$)/i.test(raw)) {
      const rest = raw.replace(/^\/orchestrate\s*/i, '')
      handleOrchestrationActivate()
      if (rest !== draftRef.current) {
        draftRef.current = rest
        setDraft(rest)
        setDraftLive(rest)
      }
      return
    }

    // Валидация one-turn выбора ДО любых side-effect'ов: при отказе текст и
    // вложения остаются в поле (ChatInput в этом режиме их не чистит).
    // override — «Продолжить» с карточки: выбор берётся из сохранённого за
    // чат, а не из блока над инпутом (он может быть закрыт).
    const activeOrchestration = override?.orchestration !== undefined ? override.orchestration : orchestration
    const orchestrationIssueNow = validateOrchestration(activeOrchestration)
    if (orchestrationIssueNow) {
      setOrchestrationIssue(orchestrationIssueNow)
      toast(orchestrationIssueNow.ru, 'error')
      return
    }
    // Снапшот выбора на момент клика: дальше пользователь может менять блок,
    // а отправка уходит ровно с тем, что видно сейчас.
    const orchestrationToSend: OrchestrationSelection | undefined = activeOrchestration ?? undefined

    // При отправке сообщения — принудительно закрепляем автоскролл.
    // Пользователь ожидает увидеть своё сообщение и ответ, даже если до этого
    // скроллил вверх по истории. instant=true — мгновенный прыжок (не ждём
    // rAF-loop), работает даже если предыдущий стрим ещё не завершился.
    pinAutoscroll(true)

    // ── Команда плагина (registerCommand) — перехватываем ДО агента ──
    // RPC в процесс плагина, результат сохраняется в БД как пара
    // user+assistant сообщений (переживает перезагрузку).
    // ── /goal — семантика Claude Code ───────────────────────────────────
    //   /goal <условие>  — поставить/заменить цель и сразу начать ход;
    //   /goal            — статус цели (условие, время, ходы, токены, вердикт);
    //   /goal clear|stop|off|reset|none|cancel — снять цель досрочно.
    // Работу судит независимый оценщик — см. goalEvaluator.ts.
    const isGoalCommand = slash && GOAL_COMMANDS.includes(slash.command.name)
    if (isGoalCommand && isIncognito) {
      toast('Цели недоступны в инкогнито: их состояние сохраняется в базе', 'info'); return
    }
    if (isGoalCommand && goalActionRef.current) return
    const goalArg = slash?.command.name === 'goal' ? slash.args.trim() : ''
    const clearsGoal = slash?.command.name === 'goal-stop'
      || (!!goalArg && GOAL_CLEAR_ALIASES.has(goalArg.toLowerCase()))
    if (clearsGoal) {
      if (!currentChatId) { toast('Активной цели нет', 'info'); return }
      goalActionRef.current = true
      try {
        const current = await window.syntee.goal.get(currentChatId)
        await window.syntee.goal.set(currentChatId, null)
        toast(current ? `Цель снята: ${current.objective}` : 'Активной цели нет', current ? 'info' : 'info')
        setChatGoal(null)
        const st = useChatStore.getState()
        if (st.liveByChat[currentChatId]?.isAgentRunning || st.liveByChat[currentChatId]?.isTyping || st.runStatusByChat[currentChatId]?.status === 'running') {
          await stopChatRun(currentChatId)
        }
      } catch (e) { toast('Ошибка цели: ' + String(e), 'error') }
      finally { goalActionRef.current = false }
      return
    }
    if (slash?.command.name === 'goal-pause') {
      if (!currentChatId) { toast('Активной цели нет', 'info'); return }
      goalActionRef.current = true
      try {
        const current = await window.syntee.goal.get(currentChatId)
        if (!current) { toast('Активной цели нет', 'info'); return }
        if (['completed', 'blocked', 'stopped'].includes(current.status)) {
          toast('Эту цель нельзя поставить на паузу', 'info'); return
        }
        applyGoal(await window.syntee.goal.set(currentChatId, { ...current, status: 'paused', updatedAt: Date.now() }))
        toast('Цель на паузе. Отправь сообщение или /goal-resume, чтобы продолжить.', 'info')
        const st = useChatStore.getState()
        if (st.liveByChat[currentChatId]?.isAgentRunning || st.liveByChat[currentChatId]?.isTyping || st.runStatusByChat[currentChatId]?.status === 'running') {
          await stopChatRun(currentChatId)
        }
      } catch (e) { toast('Ошибка цели: ' + String(e), 'error') }
      finally { goalActionRef.current = false }
      return
    }
    // /goal без аргументов — статус (как в Claude Code), а не продолжение.
    // Продолжение: /goal-resume либо любое обычное сообщение.
    if (slash?.command.name === 'goal' && !goalArg) {
      if (!currentChatId) { toast('Цели нет. Поставь новую: /goal <условие>', 'info'); return }
      const current = await window.syntee.goal.get(currentChatId)
      if (!current) { toast('Цели нет. Поставь новую: /goal <условие>', 'info'); return }
      const minutes = Math.max(0, Math.round((Date.now() - current.startedAt) / 60_000))
      toast([
        `Цель: ${current.objective}`,
        `Статус: ${current.status}${['running', 'paused'].includes(current.status) ? ` · идёт ${minutes} мин` : ''}`,
        `Ходов оценено: ${current.turnsEvaluated} · ~${current.tokensSpent} токенов`,
        current.lastReason ? `Последний вердикт: ${current.lastReason}` : 'Вердиктов ещё не было',
        current.blocker ? `Причина: ${current.blocker}` : '',
      ].filter(Boolean).join('\n'), 'info')
      return
    }

    if (slash?.command.plugin) {
      if (!currentChatId) { toast('Создай чат перед командой плагина', 'info'); return }
      try {
        const res = await window.syntee.plugins.executeCommand({
          chatId: currentChatId,
          pluginId: slash.command.plugin.pluginId,
          name: slash.command.plugin.name,
          args: slash.args,
          text: raw,
        }) as { ok: boolean; error?: string; userMsg?: Message; assistantMsg?: Message }
        if (res.error && !res.assistantMsg) { toast(res.error, 'error'); return }
        if (res.userMsg) addMessage(res.userMsg)
        if (res.assistantMsg) addMessage(res.assistantMsg)
      } catch (e) {
        toast('Ошибка команды плагина: ' + String((e as Error)?.message ?? e), 'error')
      }
      return
    }

    if (slash?.command.name === 'clear') {
      if (currentChatId) {
        // Как в [CC]: `/clear` начинает разговор заново и снимает активную цель.
        await window.syntee.goal.set(currentChatId, null)
        setChatGoal(null)
        setMessages([])
        toast('Чат очищен, цель снята', 'info')
      }
      return
    }
    if (slash?.command.name === 'sys') {
      if (!slash.args) { toast('Укажи промпт: /sys ты поэт', 'info'); return }
      await window.syntee.models.setParams({ systemPrompt: slash.args })
      toast('Системный промпт обновлен', 'success')
      return
    }
    if (slash?.command.name === 'image') {
      if (!slash.args) { toast('Укажи описание: /image красивый закат', 'info'); return }
    }
    // /ask — одноразовый read-only режим для текущего сообщения. Без args
    // не имеет смысла (нечего спросить). С args — включаем read-only тулы
    // + ask-инъекцию только для этого запроса, не меняя глобальный тоггл askMode.
    if (slash?.command.name === 'ask') {
      if (!slash.args) { toast('Укажи вопрос: /ask как работает этот модуль?', 'info'); return }
    }

    // ── /help — открыть модалку (без аргументов) ──
    if (slash?.command.name === 'help') {
      setShowHelp(true)
      return
    }

    // ── /fork — дублировать чат с этого места ──
    // Копирует сообщения + working memory + summary + project в новый чат.
    // Без currentChatId — нет смысла (нечего форкать).
    if (slash?.command.name === 'fork') {
      if (!currentChatId) { toast('Создай чат перед /fork', 'info'); return }
      try {
        const result = await window.syntee.chat.fork(currentChatId, slash.args || undefined) as {
          chatId?: string; messages?: Message[]; title?: string; error?: string
        }
        if (result.error) { toast(result.error, 'error'); return }
        if (result.chatId) {
          const all: Chat[] = await window.syntee.chat.getAll()
          setChats(all)
          setCurrentChat(result.chatId)
        if (result.messages) {
          setMessages(result.messages)
          // Скроллим к divider'у (он в середине ленты, не внизу), чтобы
          // пользователь увидел результат сжатия. useEffect ниже найдёт
          // индекс по id и вызовет virtualizer.scrollToIndex(center).
          if (result.stats?.dividerMessageId) {
            pendingScrollToDividerRef.current = result.stats.dividerMessageId
          }
        }
          toast(`Чат форкнут: ${result.title ?? 'новый чат'}`, 'success')
        }
      } catch (e) {
        toast('Ошибка форка: ' + String((e as Error)?.message ?? e), 'error')
      }
      return
    }

    // ── /snapshot <name> — именованный снапшот ──
    if (slash?.command.name === 'snapshot') {
      if (!currentChatId) { toast('Создай чат перед /snapshot', 'info'); return }
      if (!slash.args) { toast('Укажи имя: /snapshot my-feature', 'info'); return }
      try {
        const result = await window.syntee.chat.snapshotCreate(currentChatId, slash.args) as {
          snapshot?: CheckpointMeta; error?: string
        }
        if (result.error) { toast(result.error, 'error'); return }
        if (result.snapshot) {
          toast(`Снапшот сохранён: ${result.snapshot.name}`, 'success')
        }
      } catch (e) {
        toast('Ошибка снапшота: ' + String((e as Error)?.message ?? e), 'error')
      }
      return
    }

    // ── /restore [id|name] — восстановить снапшот ──
    // Без аргумента — открываем пикер именованных снапшотов.
    // С аргументом — пытаемся найти по name и восстановить.
    if (slash?.command.name === 'restore') {
      if (!currentChatId) { toast('Создай чат перед /restore', 'info'); return }
      // Если аргумент указан — ищем по имени и восстанавливаем сразу.
      if (slash.args) {
        try {
          const snapshots = await window.syntee.chat.snapshotList(currentChatId) as CheckpointMeta[]
          const found = snapshots.find(s => s.name === slash.args)
          if (!found) {
            toast(`Снапшот "${slash.args}" не найден. Доступные: ${snapshots.map(s => s.name).join(', ') || 'нет'}`, 'error')
            return
          }
          const result = await window.syntee.chat.rewindTo(currentChatId, found.userMessageId) as { messages?: Message[]; error?: string }
          if (result.error) { toast(result.error, 'error'); return }
          if (result.messages) {
            setMessages(result.messages)
            toast(`Восстановлен снапшот: ${found.name}`, 'success')
          }
        } catch (e) {
          toast('Ошибка восстановления: ' + String((e as Error)?.message ?? e), 'error')
        }
        return
      }
      // Без аргумента — открываем пикер.
      try {
        const snapshots = await window.syntee.chat.snapshotList(currentChatId) as CheckpointMeta[]
        if (snapshots.length === 0) {
          toast('Нет именованных снапшотов. Создайте через /snapshot <имя>', 'info')
          return
        }
        setSnapshotPicker(snapshots)
      } catch (e) {
        toast('Ошибка загрузки снапшотов: ' + String((e as Error)?.message ?? e), 'error')
      }
      return
    }

    // /compact — ручное сжатие контекста чата. Не создаёт user-сообщения
    // (по поведению ближе к rewind): main гоняет applyRollingWindowAsync с
    // forceCompress=true, вставляет в БД system-разделитель «Контекст сжат»
    // и эмитит chat:compacted. Возвращённый messages — обновлённая лента
    // с этим разделителем.
    //
    // Во время сжатия (AI-суммаризация занимает несколько секунд) показываем
    // compacting-индикатор внизу чата — без него пользователь видит тишину
    // и не понимает что команда вообще сработала. Инпут блокируется.
    if (slash?.command.name === 'compact') {
      if (!currentChatId) { toast('Создай чат перед /compact', 'info'); return }
      // Фиксируем chatId запуска: finally может сработать уже после
      // переключения на другой чат — чистим состояние именно этого чата.
      const compactChatId = currentChatId
      setCompactingChatId(compactChatId)
      pinAutoscroll()
      // Guard выставляем ДО invoke. Main эмитит CHAT_COMPACTED ещё во время
      // хендлера (event.sender.send до return), invoke резолвится после.
      // Guard НЕ гасим в finally — только в listener (по приходу CHAT_COMPACTED).
      // Если погасить в finally раньше CHAT_COMPACTED → setMessagesWindow(20)
      // перетрёт setMessages(allMessages) и divider (на границе middle|tail)
      // может потеряться. Timeout 10s — safety net.
      manualCompactJustDoneRef.current = true
      const compactGuardTimer = setTimeout(() => { manualCompactJustDoneRef.current = false }, 10000)
      try {
        const result = await window.syntee.chat.compact(currentChatId, slash.args || undefined) as {
          messages?: Message[]
          stats?: { removedCount: number; tokensBefore: number; tokensAfter: number; tokensSaved: number; dividerMessageId: string; mode?: 'full' | 'last'; focus?: string }
          error?: string
          cancelled?: boolean
        }
        // User-initiated cancel (Stop-кнопка) — чат остался без изменений,
        // summary/divider не применялись. Мягкий info-toast, не error.
        if (result.cancelled) {
          toast('Сжатие отменено — контекст не изменён', 'info')
          return
        }
        if (result.error) {
          toast(result.error, 'error')
          return
        }
        // Применяем ленту ТОЛЬКО если пользователь всё ещё в этом чате:
        // иначе сообщения сжимаемого чата затёрли бы ленту чужого открытого
        // чата (при возврате selectChat сам перечитает из БД с divider'ом).
        if (result.messages && useChatStore.getState().currentChatId === compactChatId) setMessages(result.messages)
        if (result.stats) {
          const tk = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
          const modeLabel = result.stats.mode ? ` (${result.stats.mode}${result.stats.focus ? ' + фокус' : ''})` : ''
          toast(`Контекст сжат${modeLabel}: удалено ${result.stats.removedCount} сообщ. · ${tk(result.stats.tokensBefore)}→${tk(result.stats.tokensAfter)} tok · сэкономлено ~${tk(result.stats.tokensSaved)}`, 'success')
        }
      } catch (e) {
        toast('Ошибка сжатия: ' + String((e as Error)?.message ?? e), 'error')
      } finally {
        clearTimeout(compactGuardTimer)
        setCompactingChatId(null)
        compactingSummariesRef.current.delete(compactChatId)
        setCompactingSummary('')
      }
      return
    }

    if (isGoalCommand) goalActionRef.current = true
    try {
    let chatId = currentChatId
    if (!chatId) {
      let pid = activeProjectId
      if (!pid && !isGoalCommand) {
        const picked = await window.syntee.projects.pickWorkdir()
        if (!picked) return
        const project: Project = await window.syntee.projects.create(picked)
        const allProjects: Project[] = await window.syntee.projects.getAll()
        setProjects(allProjects)
        setActiveProject(project.id)
        pid = project.id
      }
      const chat: Chat = await window.syntee.chat.create(isIncognito, activeMode, pid ?? undefined)
      chatId = chat.id
      setCurrentChat(chatId)
      setMessages([])
      const all: Chat[] = await window.syntee.chat.getAll()
      setChats(all)
    }

    let goalPrompt: string | undefined
    if (slash?.command.name === 'goal' || slash?.command.name === 'goal-resume') {
      const objective = slash.command.name === 'goal' ? slash.args.trim() : ''
      const current = await window.syntee.goal.get(chatId)
      if (!objective && (!current || ['completed', 'blocked'].includes(current.status))) {
        toast('Нет цели для продолжения. Поставь новую: /goal <условие>', 'info'); return
      }
      // Как в Claude Code: новая цель ЗАМЕНЯЕТ активную и сразу запускает ход.
      // Старый прогон прерываем, чтобы воркер не продолжал прежнюю цель.
      const st = useChatStore.getState()
      if (st.liveByChat[chatId]?.isAgentRunning || st.liveByChat[chatId]?.isTyping || st.runStatusByChat[chatId]?.status === 'running') {
        await stopChatRun(chatId)
      }
      const now = Date.now()
      // Условие — ОДНА строка (как в [CC]); критерии/ограничения старой версии
      // больше не выдумываются: вердикт выносит независимый оценщик.
      const goal: ChatGoal = objective ? {
        id: crypto.randomUUID(), chatId, objective: objective.slice(0, 4000),
        criteria: [], constraints: [],
        progress: [], evidence: [], steps: 0, maxSteps: 0,
        status: 'running', createdAt: now, startedAt: now, updatedAt: now,
        turnsEvaluated: 0, tokensSpent: 0, idleTurns: 0,
      } : { ...current!, status: 'running', blocker: undefined, startedAt: now, updatedAt: now }
      applyGoal(await window.syntee.goal.set(chatId, goal))
      goalPrompt = objective
        ? `[goal] ${goal.objective}\n\nWork until this condition actually holds. A separate evaluator reads the transcript after every turn, so your own claim of completion is not evidence: run the check and let its real output appear in the conversation. Do not bypass tool approvals, and do not repeat irreversible side effects without checking the current state first.`
        : `[goal] Continue toward: ${goal.objective}\nLast verdict: ${goal.lastReason ?? '—'}\nCheck the current state first (do not repeat irreversible side effects), then take the next useful step and make the check visible in the conversation.`
    }

    // displayContent — с inline-токенами вложений [[attach:id]] (рендер в
    // чате восстановит чипы на местах). aiContent — чистый текст для модели.
    const displayContent = raw
    let aiContent: string = goalPrompt ?? stripAttachTokens(raw)

    // ── One-shot параметры для команд ──
    // Поддерживаются и custom (.md) и builtin (skill).
    //   - skill: инструкции скилла инъектируются на этот прогон.
    //   - mode/allowedTools: только для custom .md-команд.
    let oneShotSkill: { name: string; instructions: string } | undefined
    let oneShotAllowedTools: string[] | undefined
    let oneShotMode: 'ask' | 'plan' | 'code' | undefined

    if (slash) {
      const sysPrompt = slash.command.systemPrompt(slash.args)
      if (sysPrompt) aiContent = sysPrompt

      // Custom-команды: mode + allowedTools (builtin управляют режимом сами).
      if (slash.command.custom) {
        if (slash.command.mode) oneShotMode = slash.command.mode
        if (slash.command.allowedTools && slash.command.allowedTools.length > 0) {
          oneShotAllowedTools = slash.command.allowedTools
        }
      }

      // Skill — резолвится для custom .md-команд с `skill:` в frontmatter
      // (ссылается на resources/skills/*.md или пользовательский скилл).
      if (slash.command.skill) {
        try {
          const skills = await window.syntee.skills.getAll({
            projectId: activeProjectId || undefined,
          }) as Array<{ name: string; instructions: string; source: string; state?: { enabled: boolean } }>
          // Ищем по имени — preferring builtin (они в дистрибутиве).
          const found = skills.find(s => s.name === slash.command.skill)
          if (found) {
            oneShotSkill = { name: found.name, instructions: found.instructions }
          } else {
            toast(`Скилл "${slash.command.skill}" не найден. Команда выполнится без скилла.`, 'info')
          }
        } catch (e) {
          console.error('[ChatPage] skills.getAll failed for oneShotSkill', e)
        }
      }
    }

    // ── Реплай-цитаты ──────────────────────────────────────────────────────
    // Метаданные уходят в main (params.replyTo): цитата для AI строится там
    // (runChatSend — текущий запрос, messageToContextMessages — история), а не
    // печатается в текст здесь — единый формат, нет дублей в истории.
    // Вложения исходных сообщений (файлы/картинки с path) сливаются в отправку
    // с source:'reply' — текст инлайнится в content, картинки идут в vision,
    // как у обычных вложений. Файлы уже в БД у исходного сообщения —
    // cleanupOrphanDraftFiles их не тронет.
    const replyMeta: ReplyTarget[] | undefined = replyTo.length > 0
      ? replyTo.map(r => ({
          id: r.id,
          // сужение role: у Message есть 'system', у реплай-цели — нет
          role: r.role === 'user' ? 'user' as const : 'assistant' as const,
          content: r.content,
          attachmentsCount: r.attachments?.filter(a => (a.kind === 'file' || a.kind === 'image' || a.kind === 'audio' || a.kind === 'video') && a.path).length || undefined,
        }))
      : undefined
    const replyAttachments: Attachment[] = []
    for (const r of replyTo) {
      for (const a of r.attachments ?? []) {
        if ((a.kind === 'file' || a.kind === 'image' || a.kind === 'audio' || a.kind === 'video') && a.path) {
          replyAttachments.push({ ...a, id: uuid(), source: 'reply' })
        }
      }
    }
    const mergedAttachments = [...draftAttachmentsRef.current, ...replyAttachments]

    const userMsg: Message = {
      id: uuid(), chatId,
      role: 'user',
      content: displayContent,
      createdAt: Date.now(),
      isPinned: 0,
      slashCommand: slash ? { name: slash.command.name, args: slash.args } : undefined,
      attachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
      replyTo: replyMeta,
    }

    // ── beforeSend-хук плагинов (permission 'chat') ──
    // Плагин может отклонить отправку (allowed:false) или изменить контент.
    // Только для обычных пользовательских сообщений (slash-команды плагинов
    // перехватываются выше и не должны гейтиться модерацией).
    let contentToSend = aiContent
    if (!slash) {
      try {
        const hook = await window.syntee.plugins.beforeSend({ chatId, content: contentToSend }) as { allowed?: boolean; content?: string; reason?: string }
        if (hook && hook.allowed === false) {
          // Восстанавливаем текст в инпуте (ChatInput очистил его при onSend).
          // Для one-turn оркестрации поле не чистилось — восстанавливать
          // нечего, и нельзя затирать свежие правки пользователя.
          if (orchestrationToSend) {
            setOrchestrationIssue({
              ru: hook.reason ? `Оркестрация отклонена плагином: ${hook.reason}` : 'Оркестрация отклонена плагином',
              en: hook.reason ? `Orchestration rejected by a plugin: ${hook.reason}` : 'Orchestration rejected by a plugin',
            })
          } else {
            handleDraftChange(raw)
          }
          toast(hook.reason ? `Отправка отклонена плагином: ${hook.reason}` : 'Отправка отклонена плагином', 'error')
          return
        }
        if (hook && typeof hook.content === 'string' && hook.content !== contentToSend) {
          contentToSend = hook.content
        }
      } catch {
        // Ошибка IPC-хука — отправляем как обычно, не блокируем пользователя.
      }
    }

    // Реплаи считаем «израсходованными» только здесь — после beforeSend-хука:
    // если плагин отклонил отправку (early return выше), чипы реплаев
    // остаются в инпуте и пользователь не теряет контекст.
    setReplyTo([])

    // Копия вложений для отправки — очистим draft до await, чтобы UI сразу
    // обновился (чипы пропадут из инпута). main-процесс получит их в params.
    // mergedAttachments = draft + вложения реплайнутых сообщений (source:'reply').
    const attachmentsToSend = mergedAttachments
    // One-turn оркестрация: чипы снимаем только после принятой отправки
    // (см. ниже) — при отказе пользователь не теряет вложения.
    if (!isIncognito && chatId && !orchestrationToSend) {
      setDraftAttachments([])
      draftAttachmentsRef.current = []
      window.syntee.draft.clearAttachments(chatId).catch(() => {})
      // ВНИМАНИЕ: cleanupOrphans здесь вызывать НЕЛЬЗЯ. IPC из renderer
      // обрабатываются в main строго по порядку (FIFO) — очистка выполнится
      // ДО того, как chat:send сохранит user-сообщение с путями вложений в
      // БД, и свежие файлы будут удалены как «сироты». Очистка выполняется
      // в main (runChatSend) сразу после saveMessage(userMsg).
    }

    // Отправляем запрос. Если в чате уже идёт генерация — main поставит
    // в очередь и вернёт { queued: true }. В этом случае НЕ добавляем
    // user-сообщение сразу и НЕ инициализируем live-буфер — иначе все
    // queued-сообщения появятся в чате подряд (user1 user2 user3), а
    // ответы придут позже (assistant1 assistant2 assistant3). Вместо этого
    // откладываем до статуса 'running' (когда запрос реально стартует) —
    // порядок будет нормальным: user1 → assistant1 → user2 → assistant2.
    // orchestration уже есть в типе chat.send (preload), поэтому каст не нужен:
    // опечатка в имени поля теперь ловится компилятором.
    const sendParams = {
      chatId,
      content: contentToSend,
      displayContent: displayContent !== aiContent ? displayContent : undefined,
      slashCommand: slash ? { name: slash.command.name, args: slash.args } : undefined,
      userMsgId: userMsg.id,
      planningMode,
      // askMode активируется тогглом ИЛИ одноразовой /ask <текст>. Для
      // /ask без тоггла — askMode true только для этого сообщения.
      askMode: askMode || slash?.command.name === 'ask',
      imageMode,
      // Тумблер «Управление браузером»: browser_* тулы (main также читает
      // chats.browser_mode — включение через request_access учитывается).
      browserMode: browserModeRef.current,
      mode: activeMode,
      // One-shot параметры кастомной команды (skill/mode/allowedTools).
      oneShotSkill,
      oneShotAllowedTools,
      oneShotMode,
      // Уровень мышления из UI на момент клика (source of truth). Гарантирует:
      // что видно в селекторе — то и уходит в запрос, независимо от гонок
      // restore-цепочки и записи chat:setReasoning в БД.
      reasoningValue: reasoningRef.current,
      // Прикреплённые файлы/изображения. main-процесс инлайнит текстовые
      // файлы в content, картинки передаёт как путь (vision — Phase 2).
      // Включая вложения реплайнутых сообщений (source:'reply').
      attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
      // Реплай-цитаты — main строит из них цитату для AI и персистит в БД.
      replyTo: replyMeta,
      // One-turn оркестрация: только на этот запрос. Основная модель чата НЕ
      // меняется — main снимает снапшот планировщика из текущей модели чата.
      orchestration: orchestrationToSend,
      // §resume — продолжение прерванного рана: план + сделанное. Без него
      // новый ран начинается с планирования и «исследует запрос» заново.
      orchestrationResume: override?.orchestrationResume ?? undefined,
    }

    let result: { queued?: boolean; assistantMsgId?: string }
    try {
      result = await window.syntee.chat.send(sendParams)
    } catch (e) {
      // Отказ старта: показываем причину в блоке оркестрации (черновик и
      // вложения не тронуты — ChatInput их в этом режиме не чистит).
      if (orchestrationToSend) {
        const msg = String((e as Error)?.message ?? e)
        setOrchestrationIssue({
          ru: `Оркестрация не запустилась: ${msg}`,
          en: `Orchestration could not start: ${msg}`,
        })
      }
      throw e
    }

    // Принятая отправка — снимаем АКТИВНЫЙ one-turn выбор и чистим поле/чипы.
    // Запомненный выбор чата (settings['orchestrationByChat']) НЕ удаляем: блок
    // просто закрывается, а следующий /orchestrate в этом чате поднимет тот же
    // выбор — включая модель и уровень мышления.
    if (orchestrationToSend) {
      // Сверяемся с ЖИВЫМ чатом: пока шёл IPC, пользователь мог переключиться
      // или создать другой чат. Тогда setOrchestration/очистка черновика
      // относятся уже к ДРУГОМУ чату — трогать их нельзя (иначе снесём новый
      // текст/вложения и закроем блок в новом чате).
      const stillHere = currentChatIdRef.current === chatId
      if (stillHere) {
        setOrchestration(null)
        setOrchestrationIssue(null)
        // Текст не тронут — снимаем его; начал печатать заново — оставляем.
        if (draftRef.current.trim() === raw) setDraftClearToken(t => t + 1)
        if (!isIncognito && chatId) {
          // Снимаем только отправленные чипы: добавленные после клика остаются.
          const sentIds = new Set(attachmentsToSend.map(a => a.id))
          const left = draftAttachmentsRef.current.filter(a => !sentIds.has(a.id))
          setDraftAttachments(left)
          draftAttachmentsRef.current = left
          if (left.length === 0) window.syntee.draft.clearAttachments(chatId).catch(() => {})
          else window.syntee.draft.setAttachments(chatId, left).catch(() => {})
        }
      }
    }

    if (result.queued && result.assistantMsgId) {
      // Запрос поставлен в очередь — откладываем user-сообщение до старта.
      enqueuePendingUserMsg(result.assistantMsgId, userMsg)
    } else {
      // Запрос стартовал сразу — показываем user-сообщение и live-пузырь.
      addMessage(userMsg)
      initChatSend(chatId)
      // Принудительно скроллим вниз — addMessage обновит DOM, и scrollHeight
      // станет актуальным. Двойной rAF: первый кадр — React коммитит DOM +
      // виртуализатор рендерит новый item с оценочным размером, второй кадр —
      // scrollHeight актуален, прыгаем к низу. Без двойного rAF виртуализатор
      // может ещё не отдать итоговую высоту → скролл к позиции «без сообщения».
      requestAnimationFrame(() => requestAnimationFrame(() => pinAutoscroll(true)))
    }

    // ── Обновляем историю навигации по стрелкам ──
    // displayContent — то, что ввёл пользователь (без quotes/sysPrompt).
    // Для обычных чатов — ре-фетч из БД (там уже сохранено). Для инкогнито —
    // поддерживаем in-memory Map на сессию. Дедупликация подряд-дубликатов.
    if (isIncognito && chatId) {
      const prev = incognitoHistoryRef.current.get(chatId) ?? []
      if (prev.length === 0 || prev[0] !== displayContent) {
        const next = [displayContent, ...prev]
        incognitoHistoryRef.current.set(chatId, next)
        if (chatId === currentChatId) setInputHistory(next)
      }
    } else if (chatId) {
      window.syntee.chat.getInputHistory(chatId).then((history: string[]) => {
        if (chatId !== currentChatId) return
        const raw = Array.isArray(history) ? history : []
        const dedup: string[] = []
        for (const s of raw) {
          if (dedup.length === 0 || dedup[dedup.length - 1] !== s) dedup.push(s)
        }
        dedup.reverse()
        setInputHistory(dedup)
      }).catch(() => {})
    }
    // Deps: refs и store-actions стабильны; меняются только редкие
    // data-значения (режимы, replyTo, customCommands) — во время стриминга
    // ссылка handleSend стабильна, memo ChatInput не пробивается.
    } catch (e) {
      if (isGoalCommand) toast('Не удалось запустить цель: ' + String(e), 'error')
      else throw e
    } finally { if (isGoalCommand) goalActionRef.current = false }
  }, [customCommands, currentChatId, activeProjectId, isIncognito, activeMode, planningMode, askMode, imageMode, replyTo, toast, setMessages, setChats, setCurrentChat, setProjects, setActiveProject, addMessage, pinAutoscroll, handleDraftChange, applyGoal, stopChatRun, orchestration, handleOrchestrationActivate])

  /**
   * «Продолжить» с карточки прерванного рана.
   *
   * Это НЕ возобновление убитого воркера (его нет), а новый ход с сохранённой
   * историей: исполнитель видит сделанное и доделывает остаток. Выбор моделей
   * берём в порядке надёжности — сохранённый за чат → модели из фаз карточки →
   * активный блок → дефолты настроек. Модель молча не подставляем: если ничего
   * нет, продолжаем обычным ходом.
   */
  const handleOrchestrationContinue = useCallback((message: Message) => {
    const store = useSettingsStore.getState()
    const fromCard = (() => {
      const phases = message.orchestration ?? []
      const executor = phases.find(p => p.phase === 'executing')?.model
      if (!isOrchestrationModel(executor)) return null
      const reviewer = phases.find(p => p.phase === 'reviewing')?.model
      return isOrchestrationModel(reviewer) ? { executor, reviewer } : { executor }
    })()
    const selection = readOrchestrationForChat(store.settings[ORCHESTRATION_BY_CHAT_KEY], currentChatId)
      ?? fromCard
      ?? (isOrchestrationModel(orchestration?.executor) ? orchestration : null)
      ?? (isOrchestrationModel(orchestrationDefaults.executor)
        ? {
            executor: orchestrationDefaults.executor,
            ...(isOrchestrationModel(orchestrationDefaults.reviewer)
              ? { reviewer: orchestrationDefaults.reviewer }
              : {}),
          }
        : null)
    const text = lang === 'en'
      ? 'Continue the task from where it stopped. Do not restart from scratch: check the actual state of the files and the unfinished plan items, finish the remainder, and run the checks.'
      : 'Продолжи выполнение задачи с того места, где остановился. Не начинай заново: проверь фактическое состояние файлов и незавершённые пункты плана, доделай остаток и доведи до проверки.'
    // §resume — главное: план уже утверждён, поэтому ран стартует СРАЗУ с
    // исполнения, без фазы Planning. План берём из последней planning/
    // replanning-фазы карточки, «сделано» — из фактических изменений файлов.
    const phases = message.orchestration ?? []
    const planPhase = phases
      .filter(p => (p.phase === 'planning' || p.phase === 'replanning') && p.plan)
      .sort((a, b) => a.startedAt - b.startedAt)
      .pop()
    const done = collectFileChanges(message.toolSteps).map(c =>
      `${c.path}${c.created ? ' (created)' : ` (+${c.adds} −${c.dels})`}`)
    const resume: OrchestrationResume | undefined = planPhase?.plan || done.length
      ? {
          ...(planPhase?.plan ? { plan: planPhase.plan } : {}),
          ...(done.length ? { done } : {}),
        }
      : undefined
    // Кнопка больше не нужна: повторный клик создал бы второй ход.
    setContinuedMsgIds(prev => new Set(prev).add(message.id))
    void handleSend(text, { orchestration: selection, orchestrationResume: resume })
  }, [currentChatId, orchestration, orchestrationDefaults, handleSend, lang])

  // ── plugins:chat-action — действия из плагинов в текущем чате ──
  //   send:   отправить сообщение от имени пользователя (silent — вставить в инпут;
  //           attachments — файлы плагина, добавляются к отправке)
  //   reply:  сохранить ответ плагина как assistant-сообщение (saveReply)
  //   open:   открыть чат пользователю (chats.open из плагина)
  useEffect(() => {
    const off = window.syntee.on('plugins:chat-action', (data: unknown) => {
      const d = data as {
        action: 'send' | 'reply' | 'open'
        text: string
        silent?: boolean
        chatId?: string
        attachments?: Array<{ path: string; name?: string; kind?: string }>
      }
      if (!d) return
      // open — переключить активный чат (chats.open из плагина).
      if (d.action === 'open') {
        if (d.chatId) setCurrentChat(d.chatId)
        return
      }
      if (typeof d.text !== 'string') return
      if (d.action === 'send') {
        // Вложения плагина → достраиваем Attachment и подмешиваем в draft
        // (handleSend возьмёт их из draftAttachmentsRef и передаст в chat.send).
        if (Array.isArray(d.attachments) && d.attachments.length > 0) {
          const extra: Attachment[] = d.attachments.slice(0, 10).map(a => ({
            id: uuid(),
            kind: a.kind === 'image' || a.kind === 'audio' || a.kind === 'video'
              ? a.kind
              : attachmentKindFromMime(mimeFromExt(a.path)),
            name: a.name || a.path.split(/[\\/]/).pop() || 'file',
            path: a.path,
            mime: mimeFromExt(a.path),
            source: 'dialog' as const,
            attachedAt: Date.now(),
          }))
          const merged = [...draftAttachmentsRef.current, ...extra]
          setDraftAttachments(merged)
          draftAttachmentsRef.current = merged
        }
        if (d.silent) {
          const prev = draftRef.current ?? ''
          const sep = prev === '' ? '' : (prev.endsWith(' ') || prev.endsWith('\n') ? '' : ' ')
          handleDraftChange(prev + sep + d.text)
        } else {
          void handleSend(d.text)
        }
        return
      }
      // reply → сохранить как сообщение ассистента в текущем чате.
      const chatId = useChatStore.getState().currentChatId
      if (!chatId) return
      void window.syntee.plugins.saveReply({ chatId, text: d.text })
        .then((res: { ok?: boolean; message?: Message }) => {
          if (res?.ok && res.message) addMessage(res.message)
        })
        .catch(() => {})
    })
    return () => { off?.() }
  }, [handleSend, handleDraftChange, addMessage, setCurrentChat])

  // ── plugins:reply-chunk — стриминг ответа плагина в текущий чат ──
  //   begin: сообщение уже создано в БД с пустым контентом → добавляем в store
  //   chunk/end: content ВСЕГДА полный текст сообщения → обновляем контент
  useEffect(() => {
    const off = window.syntee.on('plugins:reply-chunk', (data: unknown) => {
      const d = data as { action: 'begin' | 'chunk' | 'end'; chatId: string; messageId: string; content: string }
      if (!d || !d.messageId) return
      const st = useChatStore.getState()
      if (d.chatId !== st.currentChatId) return
      if (d.action === 'begin') {
        const createdAt = Date.now()
        st.addMessage({
          id: d.messageId,
          chatId: d.chatId,
          role: 'assistant',
          content: d.content ?? '',
          createdAt,
          isPinned: 0,
        } as Message)
        return
      }
      // chunk/end — дешёвый точечный апдейт контента (стриминг ~8 раз/сек).
      const list = useChatStore.getState().messages
      const idx = list.findIndex(m => m.id === d.messageId)
      if (idx === -1) return
      if (list[idx].content === d.content) return
      const next = list.slice()
      next[idx] = { ...next[idx], content: d.content }
      useChatStore.getState().setMessages(next)
    })
    return () => { off?.() }
  }, [])

  // ── plugins:tool-progress — live-карточки прогресса тулов плагинов ──
  // begin → добавить карточку, update → обновить label, finish → убрать.
  const [pluginProgress, setPluginProgress] = useState<Array<{ progressId: string; pluginId: string; label: string }>>([])

  useEffect(() => {
    const off = window.syntee.on('plugins:tool-progress', (data: unknown) => {
      const d = data as { pluginId: string; progressId: string; action: 'begin' | 'update' | 'finish'; label: string }
      if (!d || !d.progressId) return
      if (d.action === 'begin') {
        setPluginProgress(prev =>
          prev.some(p => p.progressId === d.progressId)
            ? prev
            : [...prev, { progressId: d.progressId, pluginId: d.pluginId, label: d.label ?? '' }],
        )
      } else if (d.action === 'update') {
        setPluginProgress(prev =>
          prev.map(p => (p.progressId === d.progressId ? { ...p, label: d.label ?? p.label } : p)),
        )
      } else if (d.action === 'finish') {
        setPluginProgress(prev => prev.filter(p => p.progressId !== d.progressId))
      }
    })
    return () => { off?.() }
  }, [])

  // ── §steer — внедрить реплику в контекст РАБОТАЮЩЕГО агента ────────────
  // Long-press кнопки отправки (0,5с). Сообщение НЕ встаёт в очередь: main
  // передаёт его воркеру, Agent вставит его в messages на границе следующего
  // раунда и продолжит тот же ран — стрим и тулы не обрываются, уже сделанное
  // не теряется. Откат на обычную отправку нужен на гонку «нажал, а ран как
  // раз закончился», иначе текст просто пропал бы.
  // Вложения — как в обычной отправке: летят в chat:steer целиком, main
  // инлайнит файлы в контекст (processAttachmentsAndStream). Чипы снимаем
  // только после acceptance: при откате handleSend должен отправить их
  // обычным путём.
  const steerToContext = useCallback(async (text: string, attachments: Attachment[] = []) => {
    const clean = text.trim()
    if (!clean || !currentChatId) return
    pinAutoscroll(true)
    const steerId = `steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Оптимистичная карточка «ждёт границы раунда»: реакция на жест мгновенная,
    // иначе кажется, что сообщение не отправилось (применение может ждать
    // столько, сколько идёт долгий тул). Мета вложений — для чипов карточки.
    const steerMeta = attachments.map(toSteerAttachmentMeta)
    appendPendingSteer(currentChatId, clean, steerId, steerMeta.length > 0 ? steerMeta : undefined)
    let accepted = false
    try {
      const res = await window.syntee.chat.steer(
        currentChatId, clean, steerId,
        attachments.length > 0 ? attachments : undefined,
      ) as { accepted?: boolean }
      accepted = !!res?.accepted
    } catch { accepted = false }
    if (accepted) {
      // Вложения ушли в контекст рана — чистим чипы, как при обычной отправке
      // (draft в БД + локальный ref; cleanup сирот в main уже учтён).
      if (!isIncognito && attachments.length > 0) {
        setDraftAttachments([])
        draftAttachmentsRef.current = []
        window.syntee.draft.clearAttachments(currentChatId).catch(() => {})
      }
      return
    }
    removePendingSteer(currentChatId, steerId)
    await handleSend(text)
  }, [currentChatId, handleSend, pinAutoscroll, isIncognito])

  const handlePin = useCallback(async (id: string) => {
    await window.syntee.chat.pin(id)
    pinMessage(id)
    toast('Сообщение закреплено', 'info')
  }, [pinMessage, toast])

  const handleCopy = useCallback(() => toast('Скопировано', 'success'), [toast])

  const handleReply = useCallback((msg: Message) => {
    setReplyTo(prev => prev.find(r => r.id === msg.id) ? prev : [...prev, msg])
  }, [])

  const handleCancelReply = useCallback((id: string) => {
    setReplyTo(prev => prev.filter(r => r.id !== id))
  }, [])

  const handleStop = useCallback(() => {
    if (!currentChatId) return
    if (compactingChatId) {
      // Отменяем ИМЕННО тот чат, в котором идёт сжатие, а не текущий:
      // раньше compactCancel(currentChatId) из чужого чата молча не
      // срабатывал (controller лежит в compactRuns под другим chatId).
      window.syntee.chat.compactCancel(compactingChatId)
      manualCompactJustDoneRef.current = false
    } else {
      // Оптимально сбрасываем live-state, чтобы UI мгновенно отразил стоп
      // (stop-кнопка → send, live-пузырь схлопывается, "формулирую" гаснет).
      // Бэкендовые CHAT_STREAM_DONE/CHAT_RUN_STATUS работают как страховка;
      // clearLiveState идемпотентна (no-op если уже очищено).
      void stopChatRun(currentChatId)
    }
  }, [currentChatId, compactingChatId, stopChatRun])

  const handleRewind = useCallback(async (userMessageId: string) => {
    if (!currentChatId) return
    const result = await window.syntee.chat.rewindTo(currentChatId, userMessageId) as { messages?: Message[]; error?: string }
    if (result.error) {
      toast(result.error, 'error')
      return
    }
    if (result.messages) {
      setMessages(result.messages)
      toast('Сессия откатана', 'success')
    }
  }, [currentChatId, setMessages, toast])

  // Собираем отображаемые сообщения (включая live-пузырь текущего чата)
  // live.thinking НЕ читаем — ThinkingBlock подписан на store сам (storeChatId).
  // isThinkingLive (boolean) вместо !!live.thinking (string) — стабилен
  // весь стрим, не вызывает ре-рендер ChatPage на каждом 50мс-флаше.
  const hasLiveContent = hasLiveText || liveIsThinkingLive || liveSteps.length > 0 ||
    liveIters.length > 0 || Object.keys(liveToolProgress).length > 0
  const showLiveBubble = (hasLiveContent || isTyping) && !!liveMsgId

  // ── Стабильный liveThinking для live-пузыря ──────────────────────────
  // БЕЗ text — ThinkingBlock читает thinking напрямую из store (useChatStore
  // селектор по storeChatId). Раньше { text: live.thinking, ... } — НОВЫЙ
  // объект каждые 50мс → VirtualMessageItem memo FAIL → MessageContent
  // ре-рендер 20×/сек → фриз.
  //
  // Условие: isThinkingLive || thinkingMs !== undefined.
  // Пока thinking не начался — undefined → WaitingIndicator показывается.
  // Thinking стримится — isThinkingLive=true → ThinkingBlock открыт.
  // Thinking завершён — thinkingMs задан → блок показывает финальный текст.
  //
  // useMemo: deps стабильны между 50мс-флашами (isThinkingLive=true весь
  // стрим, thinkingMs=undefined до done) → ТУ ЖЕ ссылку → memo проходит.
  const liveThinking = useMemo(() =>
    liveIsThinkingLive || liveThinkingMs !== undefined
      ? { isLive: liveIsThinkingLive, ms: liveThinkingMs, storeChatId: currentChatId ?? undefined }
      : undefined
  // eslint-disable-next-line react-hooks/exhaustive-deps
  , [liveIsThinkingLive, liveThinkingMs, currentChatId])

  const currentWorkdir = useMemo(() => {
    if (!currentChatId || isIncognito) return undefined
    return chats.find(c => c.id === currentChatId)?.workdir
  }, [chats, currentChatId, isIncognito])
  const currentProject = useMemo(() => currentWorkdir
    ? projects.find(p => p.workdir === currentWorkdir) : undefined, [projects, currentWorkdir])
  const handleOpenProjectSettings = useCallback(() => {
    if (currentProject) setSettingsModalProject(currentProject)
  }, [currentProject])

  useEffect(() => {
    let cancelled = false
    void window.syntee.gitSync.getState().then(state => { if (!cancelled) setGitSyncState(state) }).catch(() => {})
    const off = window.syntee.gitSync.onState(state => { if (!cancelled) setGitSyncState(state) })
    return () => { cancelled = true; off() }
  }, [])

  const gitSyncProjects = useMemo(() => {
    if (!currentWorkdir || !gitSyncState) return []
    return gitSyncState.projects.filter(project => project.workdir === currentWorkdir)
  }, [currentWorkdir, gitSyncState])
  const handleGitSyncApply = useCallback(async (projectId: string) => {
    const result = await window.syntee.gitSync.apply(projectId)
    if (!result.success && result.error) useToast.getState().add(result.error, 'error', 5000)
  }, [])
  const handleGitSyncLater = useCallback((projectId: string) => { void window.syntee.gitSync.later(projectId) }, [])
  const handleGitSyncOpenGit = useCallback((projectId: string) => {
    const project = gitSyncState?.projects.find(item => item.projectId === projectId)
    useNavStore.getState().toggleMainPage('chat')
    useRightPanelTabsStore.getState().openPanel('git')
    useUIStore.getState().setAgentPanelTab('git')
    useUIStore.getState().setAgentPanelOpen(true)
    void window.syntee.settings.set('agentPanelTab', 'git')
    void window.syntee.settings.set('agentPanelOpen', true)
    if (project?.workdir) useToast.getState().add(`Git-панель: ${project.projectName}`, 'info', 2500)
  }, [gitSyncState])

  // ── Загрузка кастомных slash-команд (из .md-файлов) ──
  // Грузим при mount и при смене workdir (проектные команды из .syntee/commands/).
  // builtin из SLASH_COMMANDS не входят в этот список — они в filterCommands.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        // hydrateCommands: IPC приносит команды без функции systemPrompt
        // (structured clone не переносит функции) — восстанавливаем из
        // promptTemplate. Без этого /name кастомной команды падало бы
        // на slash.command.systemPrompt(args) ниже в handleSend.
        const cmds = hydrateCommands(await window.syntee.commands.list({ projectWorkdir: currentWorkdir, chatId: currentChatId ?? undefined }) as SlashCommand[])
        if (!cancelled) setCustomCommands(cmds)
      } catch (e) {
        console.error('[ChatPage] commands.list failed', e)
      }
    }
    load()
    return () => { cancelled = true }
  }, [currentWorkdir, currentChatId])

  // Команды плагинов: перезагружаем список при изменении плагинов
  // (запуск/остановка/reload регистрирует/снимает команды).
  useEffect(() => {
    const off = window.syntee.on('plugins:changed', () => {
      window.syntee.commands.list({
        projectWorkdir: currentWorkdir,
        chatId: currentChatId ?? undefined,
      }).then((cmds: unknown) => setCustomCommands(hydrateCommands(cmds as SlashCommand[]))).catch(() => {})
    })
    return () => { off?.() }
  }, [currentWorkdir, currentChatId])

  // ── File indexer для @mention-пикера ──
  // Раньше запускали chokidar+scanDir(10k stat) в main-процессе на маунте —
  // это забивало libuv thread pool и вешало UI на пару секунд при открытии
  // большого проекта. Теперь индексация стартует ЛЕНИВО при первом вызове
  // mentions:search (когда юзер вводит @) — см. mentions.ipc.ts:95.

  const activeProject = useMemo(() => {
    if (!currentChatId) return undefined
    const chat = chats.find(c => c.id === currentChatId)
    if (!chat?.projectId) return undefined
    return projects.find(p => p.id === chat.projectId)
  }, [chats, currentChatId, projects])

  // ── Оверлей-план (LiveTodoBar): показываем последний актуальный todo.
  // Приоритет:
  //  1) live.todo — текущий стримящийся план (или только что завершённый,
  //     пока clearLiveState не сбросил состояние).
  //  2) Самый свежий todo из истории сообщений (message.todo), сканируем
  //     с конца. Берём ПЕРВЫЙ найденный todo — более свежий перекрывает
  //     старые (решение "Заменить на новый" при конфликте). Если этот
  //     todo незавершённый — показываем. Если завершён (все done/skipped)
  //     — оверлей скрываем, даже если более старые todo висят незавершёнными.
  //     Это исправляет баг: AI закрыл todo в новом сообщении, но оверлей
  //     продолжал показывать старый незавершённый.
  const overlayTodo = useMemo(() => {
    type TodoItem = { text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }
    if (liveTodo.length > 0) return liveTodo as TodoItem[]
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant' || !m.todo?.length) continue
      // Нашли самый свежий todo. Если незавершён — показываем.
      // Если завершён — оверлей не нужен (возвращаем пустой массив,
      // более старые todo перекрыты этим).
      const unfinished = m.todo.some(it => it.status === 'pending' || it.status === 'in_progress')
      return unfinished ? m.todo : []
    }
    return []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTodo, messages])

  const overlayActive = isTyping || overlayTodo.length > 0

  // План для панели «Обзор»: в отличие от оверлея над инпутом показываем и
  // завершённый план — в панели полезно видеть прогресс N/N и что было сделано.
  const planTodo = useMemo(() => {
    type TodoItem = { text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }
    if (liveTodo.length > 0) return liveTodo as TodoItem[]
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'assistant' && m.todo?.length) return m.todo as TodoItem[]
    }
    return [] as TodoItem[]
  }, [liveTodo, messages])

  // Статистика сжатий сессии — кол-во compact-разделителей и суммарно
  // сэкономлено токенов. Берётся из messages (compactStats сохраняется в БД
  // у каждого compact-разделителя). Показывается в ContextRing панели.
  const compactSessionStats = useMemo(() => {
    let count = 0
    let totalTokensSaved = 0
    for (const m of messages) {
      if (m.slashCommand?.name === 'compact' && m.compactStats) {
        count++
        totalTokensSaved += m.compactStats.tokensSaved
      }
    }
    return { count, totalTokensSaved }
  }, [messages])

  const displayMessages = useMemo(() => {
    let result = messages
    if (showLiveBubble) {
      result = [...result, {
        // Фиксированный id/key для live-пузыря на весь период стриминга.
        // Раньше id = live.msgId, который менялся 'streaming-pending' →
        // реальному uuid при приходе первого токена/step — это вызывало
        // размонтирование/монтирование элемента и скачок перемера высоты
        // → рывок скролла в начале ответа. Фиксированный id сохраняет
        // React-элемент между фазами, перемер проходит гладко.
        id: 'live-streaming-bubble',
        chatId: currentChatId || '',
        role: 'assistant' as const,
        // content пустой — live.text читается напрямую из store в MessageBubble
        // (подписка по message.chatId). displayMessages не зависит от text →
        // стабилен между 50мс-флашами → виртуализатор не инвалидирует кэш.
        content: '',
        createdAt: Date.now(),
        isPinned: 0,
        // Live-state (liveIters, liveTodo, agentStatus, toolProgress, spawnedAgents,
        // rateLimitSec, retry, lastError, toolSteps) читается напрямую из store в
        // MessageBubble через useChatStore селекторы — displayMessages не ре-вычисляется
        // на каждый tool step / progress event → виртуализатор стабилен, другие ряды
        // не затронуты. Только livePlanningMode остаётся здесь (ChatPage useState,
        // меняется редко) и liveTextAfter=undefined (MessageBubble читает live.text из store).
        livePlanningMode: planningMode,
      } as Message & Record<string, unknown>]
    }
    if (isCompactingHere) {
      // Compacting-индикатор — временный system-разделитель внизу чата со
      // спиннером. Показывает что /compact работает (AI-суммаризация занимает
      // несколько секунд). После завершения заменяется реальным compact-
      // разделителем из обновлённой ленты messages. Только в чате, где
      // идёт сжатие (compactingChatId === currentChatId) — не в чужом.
      // compactLiveSummary — стримящееся резюме (токены приходят через
      // chat:compact-stream), показывается как live-markdown под бейджем.
      result = [...result, {
        id: 'compacting-indicator',
        chatId: currentChatId || '',
        role: 'system' as const,
        content: 'Сжимаю контекст…',
        createdAt: Date.now(),
        isPinned: 0,
        slashCommand: { name: 'compact', args: 'pending' },
        compactLiveSummary: compactingSummary,
      } as Message & { compactLiveSummary?: string }]
    }
    return result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, showLiveBubble, liveMsgId, isCompactingHere, planningMode, compactingSummary])

  // getItemKey: привязываем кэш высот к message.id (не к индексу позиции) —
  // иначе при замене массива (compact вставляет divider, окно сдвигается на 1)
  // кэш по индексу протухает → разделитель налезает на соседа.
  //
  // КРИТИЧНО: ссылка useCallback ДОЛЖНА меняться при каждой смене маппинга
  // index→id, т.е. зависеть от displayMessages. В virtual-core getItemKey
  // входит в deps мемо getMeasurementOptions (сравнение по ссылке); смена
  // ссылки сбрасывает pendingMin → getMeasurements делает ПОЛНЫЙ пересчёт
  // start/size из itemSizeCache (высоты по id — корректные, сдвиг не страшен).
  // Со стабильной ссылкой (useCallback []) замена окна ТОЙ ЖЕ ДЛИНЫ со
  // сдвинутыми id (авто-компакция → chat:compacted → setMessagesWindow;
  // фоновая сверка хвоста в selectChat; boot-refresh) НЕ инвалидирует мемо:
  // ряды остаются на позициях ПРЕЖНИХ occupants → новые сообщения налезают
  // на старые. DOM-ноды при сдвиге переносятся (не remount) → RO/ref молчат
  // → баг жил до перемонта чата (перезаход «чинил»). Лишний полный пересчёт
  // на токен-флеш — O(count≈20-40), ничтожен (рендер на flush и так идёт).
  const getItemKey = useCallback(
    (index: number) => displayMessages[index]?.id ?? index,
    [displayMessages],
  )

  // ── Module-level кэш высот рядов (переживает remount виртуализатора) ──
  // estimateSize: () => 120 даёт 120px для всех рядов при первом рендере.
  // Большие сообщения реально 2000-8000px → RO перемеряет → прыжки → фриз.
  // Кэш: Map<msgId, height>. estimateSize читает из кэша → первый paint
  // без прыжков.
  //
  // Раньше кэш СБРАСЫВАЛСЯ на каждую смену чата. Это было лишним: ключ —
  // message.id, а id сообщений глобально уникальны, чужих id в кэше нового
  // чата быть не может. Сброс же стирал высоты ПРЕДЫДУЩЕГО чата, поэтому
  // возврат в недавний чат стоил полного перемера всех рядов (RO-шторм
  // ровно в кадр переключения) + прыжка скролла. Теперь кэш живёт сквозь
  // переключения; реальные измерения RO всё равно уточняют высоты на месте.
  const rowHeightsRef = useRef<Map<string, number>>(new Map())

  const estimateSize = useCallback(
    (index: number) => {
      const id = displayMessages[index]?.id
      if (id) {
        const cached = rowHeightsRef.current.get(id)
        if (cached) return cached
      }
      return 120
    },
    [displayMessages],
  )

  // (Смена чата кэш НЕ сбрасывает — см. комментарий у rowHeightsRef: ключ
  //  это message.id, id глобально уникальны, протухать нечему.)

  const virtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize,
    getItemKey,
    // overscan 5 (вместо 10): вдвое меньше ResizeObservers и активных
    // MessageBubble listeners → меньше CPU в idle. Плавность скролла
    // визуально не страдает (5 рядов сверху/снизу достаточно).
    overscan: 5,
    // useAnimationFrameWithResizeObserver (v3.17): батчит колбэки ResizeObserver
    // с requestAnimationFrame вместо синхронного срабатывания. Во время стрима
    // RO может стрелять на каждом flush'е токенов (50мс) → без батчинга
    // возникают reflow-бури и рассинхрон кэша высот с реальным DOM. С rAF-батчингом
    // замеры стабильнее → реже «прилипание» сообщений к соседу. Визуально ноль.
    useAnimationFrameWithResizeObserver: true,
  })

  // Обёртка над virtualizer.measureElement (после virtualizer, т.к. зависит от него):
  // после измерения ряда сохраняем его высоту в кэш. При следующем монтировании
  // того же msgId estimateSize вернёт сохранённую высоту — без перемера.
  const measureRef = useCallback((el: Element | null) => {
    if (el) {
      const id = el.getAttribute('data-msg-id')
      if (id) {
        const h = (el as HTMLElement).getBoundingClientRect().height
        if (h > 0) rowHeightsRef.current.set(id, h)
      }
    }
    // Кэш больше не сбрасывается на смену чата → растёт всё время жизни окна.
    // Записи крошечные (string→number), но без капа в многодневной сессии с
    // сотнями чатов это утечка. Порог 4000 рядов ≈ несколько МБ; сброс
    // безопасен — высоты пересчитаются RO при следующем монтировании рядов.
    if (rowHeightsRef.current.size > 4000) rowHeightsRef.current.clear()
    return virtualizer.measureElement(el)
  }, [virtualizer])

  // Принудительный перемер смонтированных рядов: дёргает virtualizer.resizeItem
  // с реальной высотой DOM для каждого видимого ряда. Лечит устаревший кэш высот
  // (когда RO не успел поймать финальную высоту — анимация height:0→'auto' у
  // SystemDivider, асинхронный Mermaid SVG, нагруженный main thread) — иначе
  // следующий ряд позиционируется по устаревшей (меньшей) высоте и налезает на
  // предыдущий. См. комментарии в remeasure.ts. Вызывается листьями
  // (MermaidBlock, SystemDivider) по факту дорисовки, НЕ на каждом токене.
  // rAF-дедуп: если перемер уже запланирован, новые вызовы no-op → батчит
  // всплеск remeasure-вызовов (раскрытие нескольких тул-блоков подряд) в один
  // замер на следующем кадре вместо N синхронных reflow-циклов.
  const remeasureRafRef = useRef<number | null>(null)
  const requestRemeasure = useCallback(() => {
    if (remeasureRafRef.current !== null) return
    remeasureRafRef.current = requestAnimationFrame(() => {
      remeasureRafRef.current = null
      const el = scrollContainerRef.current
      if (!el) return
      const rows = el.querySelectorAll('[data-index]')
      if (rows.length === 0) return
      rows.forEach((node) => {
        const idx = Number((node as HTMLElement).getAttribute('data-index'))
        if (!Number.isFinite(idx)) return
        virtualizer.resizeItem(idx, Math.ceil(node.getBoundingClientRect().height))
      })
    })
  }, [virtualizer])

  return (
    <div className={`chat-layout ${embedded ? 'chat-layout--embedded' : ''}`}>
      {!embedded && <AnimatedBackground />}
      {!embedded && <TitleBar onSettingsClick={() => {}} />}
      <div className="chat-body">
        <Sidebar
          chats={chats}
          projects={projects}
          activeProjectId={activeProjectId}
          currentChatId={currentChatId}
          onSelectChat={selectChat}
          onNewChat={createNewChat}
          onNewChatWithoutProject={createChatWithoutProject}
          onNewProject={createNewProject}
          onChatsUpdate={setChats}
          onProjectsUpdate={setProjects}
          onSelectProject={setActiveProject}
          onExtensionInstalled={handleExtensionInstalled}
        />
        <main className="chat-main">
          {chatGoal && chatGoal.chatId === currentChatId && !isIncognito && <div className="chat-goal-top">
            <GoalCard key={chatGoal.id} goal={chatGoal} running={liveIsAgentRunning || liveIsTyping || runStatus?.status === 'running'}
              onCommand={handleSend}
              onSave={async patch => {
                if (goalActionRef.current) throw new Error('Дождись текущего действия цели')
                goalActionRef.current = true
                try {
                  const current = await window.syntee.goal.get(chatGoal.chatId)
                  if (!current || current.id !== chatGoal.id) throw new Error('Цель уже изменилась')
                  // Смена УСЛОВИЯ — это новая цель: старые вердикты оценщика к
                  // ней не относятся (как в [CC]: новое условие заменяет цель).
                  const changed = patch.objective !== current.objective
                  const updated = await window.syntee.goal.set(chatGoal.chatId, { ...current, ...patch,
                    ...(changed ? { id: crypto.randomUUID(), progress: [], evidence: [], steps: 0,
                      turnsEvaluated: 0, tokensSpent: 0, idleTurns: 0, lastReason: undefined,
                      startedAt: Date.now(), status: 'paused' as const, blocker: undefined } : {}), updatedAt: Date.now() })
                  applyGoal(updated)
                } finally { goalActionRef.current = false }
              }} />
          </div>}
          {isIncognito || !currentChatId || liveTodo.length === 0 ? <LiveTodoBar items={overlayTodo} active={overlayActive} /> : null}

          {/* ── Кластер в правом верхнем углу: изменения/git + файлы + редактор ── */}
          <div className="chat-topright-actions">
            {!isIncognito && currentChatId && (
              <GitTools
                workdir={currentWorkdir}
                chatId={currentChatId}
                lang={lang}
                todo={planTodo}
                lastTurnChanges={lastTurnChanges}
              />
            )}
            <ChatFilesPopover messages={messages} workdir={currentWorkdir} />
            {!isIncognito && currentChatId && (
              <button
                type="button"
                className={`chat-editor-fab${editorMode ? ' chat-editor-fab--active' : ''}`}
                onClick={() => { if (!editorMode) useChatStore.getState().enterEditorMode(currentChatId) }}
                title={editorMode ? 'Редактор активен — изменения применяются на плашке сверху' : 'Редактор чата: правка текста, скрытие из контекста, удаление сообщений'}
                aria-label="Редактор чата"
                aria-pressed={editorMode}
              >
                <AppIcon name="edit" size="xs" tone={editorMode ? 'accent' : 'default'} />
              </button>
            )}
          </div>

          {/* Дополнительные действия уже объединены со сводкой выше. */}
          {/* ── Редактор чата: плашка режима inline-правки ──
              Появляется при editorMode: чипсы-счётчики изменений по типам
              (правки / скрыто / удалено) + применить/отменить.
              Ввод в ChatInput заблокирован (disabled={editorMode}). */}
          <AnimatePresence>
            {editorMode && (
              <motion.div
                key="chat-editor-bar"
                className="chat-editor-bar"
                initial={{ opacity: 0, y: -14, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -14, scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              >
                <span className="chat-editor-bar__icon">
                  <AppIcon name="edit" size="sm" />
                </span>
                <span className="chat-editor-bar__label">Редактирование</span>
                {editorDraftsCount > 0 ? (
                  <span className="chat-editor-bar__chips">
                    {editorEditsCount > 0 && (
                      <span className="chat-editor-bar__chip chat-editor-bar__chip--edit">
                        <AppIcon name="edit" size="xs" /> {editorEditsCount}
                      </span>
                    )}
                    {editorHiddenCount > 0 && (
                      <span className="chat-editor-bar__chip chat-editor-bar__chip--hidden">
                        <AppIcon name="eyeOff" size="xs" /> {editorHiddenCount}
                      </span>
                    )}
                    {editorDeletedCount > 0 && (
                      <span className="chat-editor-bar__chip chat-editor-bar__chip--deleted">
                        <AppIcon name="trash" size="xs" /> {editorDeletedCount}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="chat-editor-bar__hint">правьте текст, скрывайте из контекста или удаляйте сообщения</span>
                )}
                <div className="chat-editor-bar__actions">
                  <button
                    type="button"
                    className="chat-editor-bar__btn chat-editor-bar__btn--ghost"
                    onClick={discardEditorDrafts}
                    disabled={editorApplying}
                  >
                    <AppIcon name="x" size="xs" />
                    <span>Отменить всё</span>
                  </button>
                  <button
                    type="button"
                    className="chat-editor-bar__btn chat-editor-bar__btn--primary"
                    onClick={() => void handleApplyEditorDrafts()}
                    disabled={editorApplying || editorDraftsCount === 0}
                  >
                    <AppIcon name="check" size="xs" />
                    <span>{editorApplying ? 'Применение…' : editorDraftsCount === 0 ? 'Закрыть' : `Применить (${editorDraftsCount})`}</span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showSearch && (
              <motion.div key="search" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }}>
                <ChatSearch
                  messages={messages}
                  onMatchIds={(ids, q) => { setSearchMatchIds(ids); setSearchQuery(q) }}
                  onClose={() => { setShowSearch(false); setSearchQuery(''); setSearchMatchIds([]) }}
                />
              </motion.div>
            )}
          </AnimatePresence>
          {/* Скелетона больше нет: на cache-miss лента закрыта вуалью
              переключения (ниже), это стабильнее — .chat-messages не
              размонтируется, scroll-контейнер и позиция не теряются. */}
          {displayMessages.length === 0 && !isTyping ? (
            <div className="chat-empty-state">
              <div className="chat-empty-icon">
                <Logo size={52} />
              </div>
              <h2>Что сделаем?</h2>
              <p>Напишите задачу или прикрепите файлы.</p>
              {isIncognito && (
                <div className="incognito-hint">
                  <AppIcon name="lock" size="sm" tone="accent" />
                  <span>Режим инкогнито — чат не сохраняется</span>
                </div>
              )}
              {!isIncognito && activeProject && currentWorkdir && (
                <div className="chat-empty-workdir-hint">
                  <AppIcon name="folder" size="sm" tone="accent" />
                  <span>Проект: <strong>{activeProject.name}</strong> · {currentWorkdir}</span>
                </div>
              )}
              {!isIncognito && !activeProject && currentChatId && (
                <div className="chat-empty-workdir-hint chat-empty-workdir-hint--warn">
                  <AppIcon name="folder" size="sm" />
                  <span>Чат без проекта. Файловые операции работают относительно текущей директории процесса.</span>
                </div>
              )}
            </div>
          ) : (
            <div
              className="chat-messages"
              ref={scrollContainerRef}
              onScroll={handleScroll}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
            >
              {isLoadingOlder && isLargeChat && (
                <div
                  style={{
                    position: 'absolute', top: 0, left: 0, right: 0,
                    display: 'flex', justifyContent: 'center', alignItems: 'center',
                    padding: '6px 0', zIndex: 2, pointerEvents: 'none',
                  }}
                >
                  <div
                    style={{
                      width: 18, height: 18, borderRadius: '50%',
                      border: '2px solid rgba(127,127,127,0.25)',
                      borderTopColor: 'rgba(127,127,127,0.7)',
                      animation: 'chat-older-spin 0.7s linear infinite',
                    }}
                  />
                </div>
              )}
              <ChatRemeasureContext.Provider value={requestRemeasure}>
                <div
                  style={{
                    height: virtualizer.getTotalSize(),
                    width: '100%',
                    maxWidth: '900px',
                    margin: '0 auto',
                    position: 'relative',
                  }}
                >
                  {virtualizer.getVirtualItems().map(vItem => {
                  const msg = displayMessages[vItem.index]
                  const isLive = msg.id === 'live-streaming-bubble'
                  // liveThinking вычислен на уровне компонента (useMemo выше).
                  // Передаём только для live-пузыря, иначе undefined.
                  const msgLiveThinking = isLive ? liveThinking : undefined
                  // Анимируем только первое появление сообщения; при scroll-remount
                  // того же id виртуализатором — shouldAnimate=false (иначе «плывёт»).
                  const shouldAnimate = !animatedMsgIdsRef.current.has(msg.id)
                  if (shouldAnimate) animatedMsgIdsRef.current.add(msg.id)
                  return (
                    <VirtualMessageItem
                      key={msg.id}
                      msg={msg}
                      vItemStart={vItem.start}
                      vItemIndex={vItem.index}
                      measureRef={measureRef}
                      toolOutputMode={toolOutputMode}
                      onPin={handlePin}
                      onCopy={handleCopy}
                      onReply={handleReply}
                      onRewind={handleRewind}
                      searchQuery={searchMatchIds.includes(msg.id) ? searchQuery : undefined}
                      liveThinking={msgLiveThinking}
                      isStreaming={isLive && isTyping}
                      isWaiting={isLive && isTyping}
                      rateLimitSec={isLive ? liveRateLimitSec : undefined}
                      shouldAnimate={shouldAnimate}
                      workdir={currentWorkdir}
                      editorAvailable={!isIncognito}
                      onOrchestrationContinue={handleOrchestrationContinue}
                      orchestrationContinued={continuedMsgIds.has(msg.id)}
                    />
                  )
                })}
                </div>
              </ChatRemeasureContext.Provider>
            </div>
          )}

          {/* ── Индикатор переключения чата (только кружок, без затемнения) ──
              Монтируется в тот же тик, что и смена чата, но кадр под него
              браузер отрисовывает ДО тяжёлого рендера ленты (см. settleFrame
              в selectChat), поэтому вращение и fade-in продолжаются и во
              время фриза. Уход — плавное затухание 160ms (класс --out),
              элемент снимается только после его окончания.
              pointer-events: none — ввод в поле сообщения не блокируется. */}
          {veilPhase !== 'off' && (
            <div
              className={`chat-switch-veil${veilPhase === 'shown' ? ' chat-switch-veil--shown' : ' chat-switch-veil--out'}`}
            >
              <span className="chat-switch-veil-spinner" />
            </div>
          )}

          {/* Floating-кнопка «прокрутить вниз» — компактная, по центру,
              чуть выше инпут-бара. Появляется когда пользователь отошёл
              от низа (autoScroll=false). Клик — плавный скролл + закрепление. */}
          {/* Миникарта сообщений — точки навигации справа по центру. */}
          <ChatMinimap
            virtualizer={virtualizer}
            messages={displayMessages}
            scrollContainerRef={scrollContainerRef}
            onJump={unpinAutoscroll}
          />

          <AnimatePresence>
            {showScrollDownBtn && (
              <motion.button
                className="chat-scroll-down-btn"
                onClick={handleScrollDownClick}
                initial={{ opacity: 0, y: 8, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.8 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                whileTap={{ scale: 0.9 }}
                whileHover={{ scale: 1.08 }}
                title="Прокрутить вниз"
              >
                <AppIcon name="chevronDown" size="sm" />
              </motion.button>
            )}
          </AnimatePresence>

          {pluginProgress.length > 0 && (
            <div className="plugin-progress-stack">
              {pluginProgress.map(p => (
                <div key={p.progressId} className="plugin-progress-card">
                  <span className="plugin-progress-spinner" />
                  <span className="plugin-progress-label" title={p.label}>{p.label || p.pluginId}</span>
                </div>
              ))}
            </div>
          )}

          {/* Goal card is mounted at the top of the chat, outside the input stack. */}
          <div ref={chatInputWrapRef} style={{ display: 'contents' }}>
            <ChatInput
              chatId={currentChatId ?? undefined}
              onSend={handleSend}
              onSteer={steerToContext}
              goal={chatGoal}
              onGoalChange={handleGoalChange}
              disabled={isTyping || runStatusBusy || isCompactingHere || editorMode}
              isIncognito={isIncognito}
              replyTo={replyTo}
              onCancelReply={handleCancelReply}
              isGenerating={isTyping || isAgentRunning || runStatusBusy || isCompactingHere}
              onStop={handleStop}
              contextInfo={contextInfo}
              showContextRing={showContextRing}
              value={draft}
              onChangeValue={handleDraftChange}
              inputHistory={inputHistory}
              mainModelId={mainModelId}
              mainModelProviderId={mainModelProviderId}
              onMainModelChange={handleMainModelChange}
              reasoningValue={reasoningValue}
              onReasoningChange={handleReasoningChange}
              planningMode={planningMode}
              onPlanningModeChange={handlePlanningModeChange}
              imageMode={imageMode}
              onImageModeChange={handleImageModeChange}
              askMode={askMode}
              onAskModeChange={handleAskModeChange}
              browserMode={browserMode}
              onBrowserModeChange={handleBrowserModeChange}
              workdir={currentWorkdir}
              compactSessionStats={compactSessionStats}
              customCommands={customCommands}
              attachments={draftAttachments}
              onAttachmentsChange={handleAttachmentsChange}
              lastTurnChanges={badgeChanges}
              badgeLive={badgeLive}
              onOpenProjectSettings={currentWorkdir ? handleOpenProjectSettings : undefined}
              gitSyncProjects={gitSyncProjects}
              onGitSyncApply={handleGitSyncApply}
              onGitSyncLater={handleGitSyncLater}
              onGitSyncOpenGit={handleGitSyncOpenGit}
              projectId={currentProject?.id ?? null}
              projectName={currentProject?.name}
              orchestration={orchestration}
              onOrchestrationActivate={handleOrchestrationActivate}
              onOrchestrationChange={handleOrchestrationChange}
              orchestrationIssue={orchestrationIssue}
              clearDraftToken={draftClearToken}
            />
          </div>

          {selectionPopup && createPortal(
            <div
              className="selection-reply-popup"
              style={{ left: selectionPopup.x, top: selectionPopup.y }}
              onMouseDown={e => e.preventDefault()}
            >
              <motion.button
                className="selection-reply-btn"
                onClick={() => {
                  const syntheticMsg = { id: `sel-${Date.now()}`, role: 'user', content: selectionPopup.text, createdAt: Date.now() } as Message
                  setReplyTo(prev => [...prev, syntheticMsg])
                  setSelectionPopup(null)
                  window.getSelection()?.removeAllRanges()
                }}
                whileHover={whileHoverSm}
                whileTap={whileTapSm}
                transition={springHover}
              >
                <Reply size={13} /> Reply
              </motion.button>
              <motion.button
                className="selection-reply-copy"
                onClick={async () => {
                  await copyToClipboard(selectionPopup.text)
                  setSelectionPopup(null)
                }}
                whileHover={whileHoverSm}
                whileTap={whileTapSm}
                transition={springHover}
              >
                <Copy size={13} /> Copy
              </motion.button>
            </div>,
            document.body
          )}

          {/* /help модалка — список команд + горячих клавиш */}
          <HelpModal open={showHelp} onClose={() => setShowHelp(false)} customCommands={customCommands} />

          <ProjectSettingsModal
            open={!!settingsModalProject}
            project={settingsModalProject}
            onClose={() => setSettingsModalProject(null)}
            onSaved={(updated) => {
              setProjects(projects.map(p => p.id === updated.id ? { ...p, ...updated } : p))
            }}
            onInit={() => { void handleSend('/init') }}
          />

          {/* /restore пикер именованных снапшотов */}
          {snapshotPicker && createPortal(
            <div
              className="snapshot-picker-overlay"
              onClick={() => setSnapshotPicker(null)}
            >
              <div
                className="snapshot-picker"
                onClick={e => e.stopPropagation()}
              >
                <div className="snapshot-picker-header">
                  <h3>Восстановить снапшот</h3>
                  <motion.button
                    className="snapshot-picker-close"
                    onClick={() => setSnapshotPicker(null)}
                    title="Закрыть"
                    whileHover={whileHoverTiny}
                    whileTap={whileTapTiny}
                    transition={springHover}
                  >
                    <AppIcon name="x" size="sm" />
                  </motion.button>
                </div>
                <div className="snapshot-picker-list">
                  {snapshotPicker.map(snap => (
                    <motion.button
                      key={snap.id}
                      className="snapshot-picker-item"
                      onClick={async () => {
                        if (!currentChatId) return
                        try {
                          const result = await window.syntee.chat.rewindTo(currentChatId, snap.userMessageId) as { messages?: Message[]; error?: string }
                          if (result.error) {
                            toast(result.error, 'error')
                            return
                          }
                          if (result.messages) {
                            setMessages(result.messages)
                            toast(`Восстановлен снапшот: ${snap.name}`, 'success')
                          }
                        } catch (e) {
                          toast('Ошибка восстановления: ' + String((e as Error)?.message ?? e), 'error')
                        } finally {
                          setSnapshotPicker(null)
                        }
                      }}
                      whileHover={whileHoverListItem}
                      whileTap={whileTapListItem}
                      transition={springHover}
                    >
                      <span className="snapshot-picker-icon">
                        <AppIcon name="camera" size="sm" />
                      </span>
                      <span className="snapshot-picker-name">{snap.name}</span>
                      <span className="snapshot-picker-date">
                        {new Date(snap.createdAt).toLocaleString('ru')}
                      </span>
                      {snap.filesChanged > 0 && (
                        <span className="snapshot-picker-files" title="Файлов изменено в этом turn'е">
                          {snap.filesChanged} ф.
                        </span>
                      )}
                    </motion.button>
                  ))}
                </div>
              </div>
            </div>,
            document.body,
          )}
        </main>

        {/* Сплит-панель: второй чат в правой половине (50/50 с основным).
            showSplit — страховка от кадра-гонки: автозакрытие (удаление/архив/
            активация сплит-чата) идёт через подписки в tabs.store, между
            событием и ре-рендером splitChatId может указывать на мёртвый чат. */}
        {splitChatId && splitChatId !== currentChatId &&
          chats.some(c => c.id === splitChatId && !c.isArchived) && (
          <SplitChatPane
            chatId={splitChatId}
            onClose={() => setSplitChat(null)}
          />
        )}
      </div>
      {!embedded && (
        <ToastContainer />
      )}
    </div>
  )
}

// React.memo — ChatPage ре-рендерится только когда меняются его props
// (embedded всегда true, константа). Без этого любое изменение в App
// (например agentPanelOpen при открытии/закрытии правой панели) вызывало
// ре-рендер ChatPage с виртуализацией и MessageBubble → подвисание.
export default memo(ChatPage)
