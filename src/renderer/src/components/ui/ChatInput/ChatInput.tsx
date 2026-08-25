import { useState, useRef, useEffect, memo, useCallback, KeyboardEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ApprovalModeSelector from '../ApprovalModeSelector/ApprovalModeSelector'
import ContextRing from '../ContextRing/ContextRing'
import ReasoningSelector from '../ReasoningSelector/ReasoningSelector'
import AttachmentPreviewModal from '../AttachmentPreviewModal/AttachmentPreviewModal'
import { filterCommands } from '../../../../../shared/slashCommands'
import type { SlashCommand } from '../../../../../shared/slashCommands'
import { findMentionTokenAtCaret, mentionToAttachment } from '../../../../../shared/mentions'
import type { Attachment, MentionItem, ApprovalMode, LastTurnChanges } from '../../../../../shared/types'
import { DEFAULT_PERSONA, type PersonaId } from '../../../../../shared/modes'
import type { ContextInfo } from '../../../hooks/useContextCounter'
import { useUIStore } from '../../../store/ui.store'
import { useSettingsStore } from '../../../store/settings.store'
import { playSendSound } from '../../../utils/sounds'
import { springHover } from '../../../utils/motionPresets'
import { useChatInputVoice } from './useChatInputVoice'
import { useChatInputAttachments } from './useChatInputAttachments'
import { ChatInputStatusRow } from './ChatInputStatusRow'
import { ChatInputPlusMenu } from './ChatInputPlusMenu'
import { ChatInputActionButton } from './ChatInputActionButton'
import { ChatInputEditor, type EditorApi } from './ChatInputEditor'
import { ChatInputMenus } from './ChatInputMenus'
import { ATTACH_TOKEN_RE, stripAttachTokens } from '../../../../../shared/attachmentMarkdown'
import './ChatInput.css'

interface ChatInputProps {
  /** ID текущего чата — для панели очереди запросов. */
  chatId?: string
  onSend: (text: string) => void
  disabled?: boolean
  isIncognito?: boolean
  replyTo?: { id: string; role: string; content: string }[]
  onCancelReply?: (id: string) => void
  isGenerating?: boolean
  onStop?: () => void
  contextInfo?: ContextInfo | null
  showContextRing?: boolean
  /** Контролируемое значение поля ввода (черновик). Родитель хранит
   *  draft-стейт и персистит его в БД. Раньше value был внутренним
   *  useState и терялся при смене чата / перезапуске. */
  value: string
  onChangeValue: (text: string) => void
  /** История предыдущих запросов чата (DESC — самый свежий первым),
   *  уже дедуплицирована от подряд-дубликатов. Используется для навигации
   *  по стрелкам вверх/вниз когда слеш-меню закрыто. */
  inputHistory?: string[]
  mainModelId?: string
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
  /** Single-select persona run mode (classic/architect/debugger/...).
   *  Orthogonal to the three toggles above — a radio choice, not a boolean. */
  persona?: PersonaId
  onPersonaChange?: (v: PersonaId) => void
  rateLimitSec?: number
  /** Рабочая директория текущего чата (режим "Код"). Показывается как
    *  бейдж над инпутом — как cwd-indicator в Codex CLI. */
  workdir?: string
  /** Статистика сжатий сессии для ContextRing (кол-во + сэкономлено токенов). */
  compactSessionStats?: { count: number; totalTokensSaved: number }
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
}

// memo: ChatPage ре-рендерится ~20×/сек при стриминге и на scroll-range
// изменениях виртуализатора — без memo инпут-бар (1000+ строк JSX,
// mirror-рендер draft'а, ModelSelector) перерисовывался бы каждый раз.
// Пропсы стабилизированы в ChatPage (useCallback-хендлеры).
function ChatInput({
  chatId,
  onSend, disabled, isIncognito,
  replyTo, onCancelReply,
  isGenerating, onStop,
  contextInfo, showContextRing = true,
  value, onChangeValue,
  inputHistory = [],
  mainModelId = '',
  onMainModelChange,
  reasoningValue = '',
  onReasoningChange,
  planningMode = false,
  onPlanningModeChange,
  imageMode = false,
  onImageModeChange,
  askMode = false,
  onAskModeChange,
  persona = DEFAULT_PERSONA,
  onPersonaChange,
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
}: ChatInputProps) {
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('ask')
  const [slashCmds, setSlashCmds] = useState<SlashCommand[]>([])
  const [slashIdx, setSlashIdx] = useState(0)
  // Превью вложения из чипов инпут-бара (модалка-лайтбокс)
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null)
  // ── Пикер аргументов команды (многоуровневый enum-пикер) ──
  // argPickerCmd — команда, для которой показываем пикер (null = скрыт).
  // argPickerLevel — индекс текущего аргумента в cmd.arguments.
  // argPickerChoices — отфильтрованные по префиксу опции текущего аргумента.
  // argPickerIdx — выбранный индекс (как slashIdx).
  const [argPickerCmd, setArgPickerCmd] = useState<SlashCommand | null>(null)
  const [argPickerLevel, setArgPickerLevel] = useState(0)
  const [argPickerChoices, setArgPickerChoices] = useState<string[]>([])
  const [argPickerIdx, setArgPickerIdx] = useState(0)
  // ── @mention-меню ──
  // mentionItems — текущий список для дропдауна (fuzzy-отфильтрованный).
  // mentionIdx — выбранный индекс (как slashIdx).
  // mentionToken — {start,end,query} текущего @токена у каретки. null = меню скрыто.
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([])
  const [mentionIdx, setMentionIdx] = useState(0)
  const mentionTokenRef = useRef<{ start: number; end: number; query: string } | null>(null)
  const mentionFetchIdRef = useRef(0) // race-condition guard для асинхронных fetchей
  const [sendBurst, setSendBurst] = useState(false)
  const uiSounds = useUIStore(s => s.uiSounds)
  const sendEffect = useUIStore(s => s.sendEffect)

  const textareaRef = useRef<HTMLDivElement>(null)
  const editorApiRef = useRef<EditorApi | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // ── Голосовой ввод (STT) в инпут-баре — вынесен в хук useChatInputVoice ──
  // Провайдер и размер модели читаются из персистентных настроек (electron-store).
  // 'local' — локальный Whisper (оффлайн), 'groq' — Groq API fallback.
  const { voice, isVoiceTyping, handleMicClick } = useChatInputVoice({
    value,
    onChangeValue,
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

  useEffect(() => {
    window.syntee.agent.getSettings().then((s: { approvalMode: ApprovalMode }) => {
      setApprovalMode(s.approvalMode)
    }).catch(() => {})
  }, [])

  const handleApprovalChange = (mode: ApprovalMode) => {
    setApprovalMode(mode)
    window.syntee.agent.setSettings({ approvalMode: mode }).catch(() => {})
  }

  // Авто-ресайз contentEditable-редактора
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [value])

  // Сброс навигации по истории при смене чата — индекс относится к
  // inputHistory предыдущего чата и не валиден для нового.
  useEffect(() => {
    historyIdxRef.current = null
  }, [chatId])

  // Обновляем слеш-меню и @mention-меню при вводе
  const handleChange = (text: string) => {
    // Любой ручной ввод сбрасывает режим навигации по истории — иначе
    // следующий ArrowUp продолжил бы с устаревшего индекса.
    historyIdxRef.current = null
    onChangeValue(text)
    // Показываем меню только если строка начинается с / и нет пробелов после команды
    const firstWord = text.split(' ')[0]
    if (text.startsWith('/') && !text.includes(' ')) {
      const cmds = filterCommands(firstWord, customCommands)
      setSlashCmds(cmds)
      setSlashIdx(0)
    } else {
      setSlashCmds([])
    }

    // ── Пикер аргументов команды: синхронизация с ручным вводом ──
    // Если argPicker активен — фильтруем choices текущего уровня по
    // последнему вводимому токену-префиксу. Если юзер ушёл из формата
    // /cmd или превысил уровень — закрываем пикер.
    if (argPickerCmd) {
      const cmd = argPickerCmd
      // Slice-подход (а не regex m[2]) — \s* жадно съедает trailing-пробел,
      // из-за чего для `/cmd choice ` rest терял финальный пробел и уровень
      // считался на 1 меньше (picker показывал прошлый уровень, не следующий).
      const head = text.match(/^\/(\S+)/)
      if (!head || head[1].toLowerCase() !== cmd.name.toLowerCase()) {
        closeArgPicker()
      } else {
        const after = text.slice(head[0].length)
        const trimmed = after.trim()
        const endsWithSpace = after.length > 0 && /\s$/.test(after)
        const tokens = trimmed === '' ? [] : trimmed.split(/\s+/)
        const level = endsWithSpace ? tokens.length : tokens.length - 1
        const arg = cmd.arguments?.[level]
        if (!arg?.choices || arg.choices.length === 0 || level >= (cmd.arguments?.length ?? 0)) {
          closeArgPicker()
        } else {
          const prefix = endsWithSpace ? '' : (tokens.length > 0 ? tokens[tokens.length - 1] : '')
          const filtered = prefix
            ? arg.choices.filter(c => c.toLowerCase().startsWith(prefix.toLowerCase()))
            : arg.choices
          if (filtered.length === 0) {
            closeArgPicker()
          } else {
            setArgPickerLevel(level)
            setArgPickerChoices(filtered)
            setArgPickerIdx(0)
          }
        }
      }
    }

    // ── @mention-детект: парсим токен у каретки ──
    const caretPos = editorApiRef.current?.getCaretOffset() ?? text.length
    const token = findMentionTokenAtCaret(text, caretPos)
    mentionTokenRef.current = token
    if (token) {
      // Асинхронный fetch с race-guard — если юзер быстро печатает, оставляем только последний
      const fetchId = ++mentionFetchIdRef.current
      window.syntee.mentions.search({ workdir, query: token.query, limit: 30 })
        .then((items: MentionItem[]) => {
          if (fetchId !== mentionFetchIdRef.current) return // устарел
          setMentionItems(items)
          setMentionIdx(0)
        })
        .catch(() => {
          if (fetchId !== mentionFetchIdRef.current) return
          setMentionItems([])
        })
    } else {
      setMentionItems([])
    }
  }

  const selectCommand = (cmd: SlashCommand) => {
    // Заменяем ввод на "/command " и фокусируем
    const next = `/${cmd.name} `
    historyIdxRef.current = null
    onChangeValue(next)
    setSlashCmds([])
    // Если у команды есть первый аргумент с choices — открываем пикер.
    const firstArg = cmd.arguments?.[0]
    if (firstArg?.choices && firstArg.choices.length > 0) {
      setArgPickerCmd(cmd)
      setArgPickerLevel(0)
      setArgPickerChoices(firstArg.choices)
      setArgPickerIdx(0)
    } else {
      setArgPickerCmd(null)
      setArgPickerChoices([])
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
    const head = value.match(/^\/(\S+)/)
    if (!head || head[1].toLowerCase() !== cmd.name.toLowerCase()) {
      setArgPickerCmd(null); setArgPickerChoices([]); return
    }
    const after = value.slice(head[0].length) // всё после /cmdname
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
    onChangeValue(newText)
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
  }

  const handleSend = () => {
    // Пустой = нет текста (токены не считаем) И нет вложений
    const cleanText = stripAttachTokens(value).trim()
    if (!cleanText && attachments.length === 0) return
    if (disabled && !isGenerating) return
    // Отправляем value С токенами — ChatPage положит его в message.content
    // (рендер в чате восстановит чипы на местах), а в AI уйдёт чистый текст.
    onSend(value.trim())
    historyIdxRef.current = null
    onChangeValue('')
    setSlashCmds([])
    setMentionItems([])
    mentionTokenRef.current = null
    closeArgPicker()
    // Вложения очищаются в ChatPage после отправки (после chat:send)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    if (uiSounds) playSendSound()
    if (sendEffect) { setSendBurst(true); setTimeout(() => setSendBurst(false), 400) }
  }

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
    const canAdd =
      attachments.length < maxAttachments &&
      !attachments.some(a => a.path === newAtt.path && a.kind === newAtt.kind)
    const before = value.slice(0, token.start)
    const after = value.slice(token.end)
    const insertion = canAdd ? `[[attach:${newAtt.id}]]` : `@${item.label}`
    const newText = `${before}${insertion} ${after}`
    mentionTokenRef.current = null
    setMentionItems([])
    if (canAdd) onAttachmentsChange?.([...attachments, newAtt])
    onChangeValue(newText)
    // Фокус + каретка после вставки (rebuild DOM в useEffect, потом позиция)
    setTimeout(() => {
      editorApiRef.current?.focus()
      editorApiRef.current?.setCaretOffset(before.length + insertion.length + 1) // +пробел
    }, 0)
  }

  // Подставить запись из истории в поле (rebuild поставит каретку в конец).
  const applyHistoryEntry = (entry: string) => {
    onChangeValue(entry)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Навигация по пикеру аргументов команды — высший приоритет
    // (открыт после выбора команды, пока юзер выбирает enum-опцию).
    if (argPickerCmd && argPickerChoices.length > 0) {
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
        closeArgPicker()
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
        if (value === '') {
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
          onChangeValue('')
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
      handleSend()
    }
  }

  // Логика кнопки (Send/Stop/Mic) вынесена в ChatInputActionButton.
  // Здесь остаётся только micBusy (для бейджа статус-строки) и lang.
  const voiceActive = voice.state === 'recording' || voice.state === 'transcribing' || voice.state === 'requesting'
  // Пока модель качается в фоне (преварм при старте) — на кнопке mic крутится
  // спиннер, но запись можно начать (инференс подождёт готовности модели).
  const micBusy = voice.modelLoading && !voiceActive && !value.trim() && !isGenerating
  // language — 'ru' (default) | 'en'. Selects persona name/description variant.
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
          mentionItems={mentionItems}
          mentionIdx={mentionIdx}
          argPickerCmd={argPickerCmd}
          argPickerLevel={argPickerLevel}
          argPickerChoices={argPickerChoices}
          argPickerIdx={argPickerIdx}
          boxRef={boxRef}
          onSelectCommand={selectCommand}
          onCloseSlash={() => setSlashCmds([])}
          onSelectMention={selectMention}
          onCloseMention={() => { setMentionItems([]); mentionTokenRef.current = null }}
          onSelectArgChoice={selectArgChoice}
          onCloseArgPicker={closeArgPicker}
        />

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
        persona={persona}
        onPersonaChange={onPersonaChange}
        lang={lang}
        mainModelId={mainModelId}
        onMainModelChange={onMainModelChange}
        onOpenProjectSettings={onOpenProjectSettings}
      />

      {replyTo && replyTo.length > 0 && (
        <div className="chat-input-replies">
          {replyTo.map(r => (
            <div key={r.id} className="chat-input-reply">
              <div className="chat-input-reply-content">
                <span className="chat-input-reply-role">{r.role === 'user' ? 'Вы' : 'Syntee'}</span>
                <span className="chat-input-reply-text">{r.content.slice(0, 100)}{r.content.length > 100 ? '…' : ''}</span>
              </div>
              <motion.button
                className="chat-input-reply-cancel"
                onClick={() => onCancelReply?.(r.id)}
                whileHover={{ scale: 1.1, rotate: 90 }}
                whileTap={{ scale: 0.9 }}
                transition={springHover}
              >✕</motion.button>
            </div>
          ))}
        </div>
      )}
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
            Вложения живут ПРЯМО В ТЕКСТЕ редактора (inline-чипы) — ряда снизу нет. */}
        <div className="chat-input-row">
          {/* + кнопка с меню */}
          <ChatInputPlusMenu
            onAttachClick={handleAttachClick}
            planningMode={planningMode}
            onPlanningModeChange={onPlanningModeChange}
            imageMode={imageMode}
            onImageModeChange={onImageModeChange}
            askMode={askMode}
            onAskModeChange={onAskModeChange}
            persona={persona}
            onPersonaChange={onPersonaChange}
            lang={lang}
          />

          <ChatInputEditor
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPasteImages={handlePaste}
            onPasteLinks={handlePasteLinks}
            onUserInput={handleEditorUserInput}
            attachments={attachments}
            onRemoveAttachment={handleRemoveAttachment}
            onPreviewAttachment={setPreviewAttachment}
            editorApiRef={editorApiRef}
            editorRef={textareaRef}
            placeholder={
              planningMode ? 'Режим планирования — опишите задачу...'
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
            <ApprovalModeSelector value={approvalMode} onChange={handleApprovalChange} compact />
          )}

          {!isIncognito && mainModelId && onReasoningChange && (
            <ReasoningSelector modelId={mainModelId} value={reasoningValue} onChange={onReasoningChange} />
          )}

          {showContextRing && !isIncognito && (
            <ContextRing info={contextInfo ?? null} compactSessionStats={compactSessionStats} />
          )}

          <ChatInputActionButton
            value={value}
            isGenerating={isGenerating}
            voice={voice}
            micBusy={micBusy}
            sendBurst={sendBurst}
            onStop={onStop}
            onSend={handleSend}
            onMicClick={handleMicClick}
          />
        </div>
      </div>

      <p className="chat-input-hint">Enter — отправить · Shift+Enter — новая строка · / — команды · @ — файлы и сущности</p>
      </div>

      {/* Модалка превью вложения — лайтбокс для картинок, CodePreview для файлов */}
      <AttachmentPreviewModal
        key={previewAttachment?.id ?? 'none'}
        attachment={previewAttachment}
        onClose={() => setPreviewAttachment(null)}
      />
    </div>
  )
}

export default memo(ChatInput)
