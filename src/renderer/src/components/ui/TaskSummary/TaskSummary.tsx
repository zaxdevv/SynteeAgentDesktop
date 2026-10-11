import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check, ChevronDown, CircleAlert, CircleCheck, CircleHelp, Copy, CornerUpLeft, ExternalLink, FileDiff, ListChecks, MessageSquare, MoreHorizontal, Pin, PinOff, Play, Plus, RefreshCw, X } from 'lucide-react'
import type { TaskSummary, TaskSummaryParticipant, TaskSummaryState, TaskSummaryTodoStatus } from '../../../../../shared/types/taskSummary'
import { openFilePath } from '../../../utils/openFilePath'
import { useRightPanelTabsStore } from '../../../store/rightPanelTabs.store'
import { useUIStore } from '../../../store/ui.store'
import { tabActions } from '../../../store/tabs.store'
import { useToast } from '../Toast/Toast'
import './TaskSummary.css'

type Todo = { text: string; status: TaskSummaryTodoStatus }
interface Props {
  chatId: string | null
  workdir?: string
  live?: boolean
  liveStatus?: string
  liveTodo?: Todo[]
  onNavigateMessage?: (messageId: string) => void
  onInsert: (text: string) => void
}

const statusLabel: Record<TaskSummary['status'], string> = { running: 'В работе', done: 'Готово', error: 'Ошибка', cancelled: 'Отменено', interrupted: 'Прервано' }
const todoIcon = (status: TaskSummaryTodoStatus) => status === 'done' ? <Check size={12} /> : status === 'in_progress' ? <span className="syntee-task-summary__spinner" /> : <span className="syntee-task-summary__todo-dot" />
const collapseTransition = { duration: 0.18, ease: 'easeOut' as const }

function AnimatedCollapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  const reducedMotion = useReducedMotion()
  return <AnimatePresence initial={false}>{open && <motion.div className="syntee-task-summary__collapse" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reducedMotion ? { duration: 0 } : collapseTransition}>{children}</motion.div>}</AnimatePresence>
}

const sectionClass: Record<string, string> = { 'Сейчас': 'now', 'План': 'plan', 'Команда': 'team', 'Результаты': 'results', 'Итог': 'summary', 'Проверки': 'checks', 'Осталось': 'remaining', 'Изменения': 'changes', 'Заметки': 'notes' }
function Section({ title, count, defaultOpen = false, children }: { title: string; count?: string | number; defaultOpen?: boolean; children: React.ReactNode }) {
  // Only a task switch resets these controls, never a hydrated live update.
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? defaultOpen
  return <div className={`syntee-task-summary__section syntee-task-summary__section--${sectionClass[title] ?? 'other'}`}><button type="button" className="syntee-task-summary__section-title" aria-expanded={open} onClick={() => setOverride(!open)}><ChevronDown size={14} className={!open ? 'is-collapsed' : ''} />{title}{count !== undefined && <span>{count}</span>}</button><AnimatedCollapse open={open}>{children}</AnimatedCollapse></div>
}

const participantLabels: Record<TaskSummaryParticipant['status'] | 'idle', string> = { starting: 'Запуск', queued: 'В очереди', running: 'В работе', done: 'Готово', error: 'Ошибка', cancelled: 'Отменено', interrupted: 'Прервано', idle: 'Создан, без поручения' }
const isActiveParticipant = (p: TaskSummaryParticipant) => ['starting', 'queued', 'running'].includes(p.status)
const participantStatus = (status: TaskSummaryParticipant['status'] | 'idle') => participantLabels[status]
function Participant({ participant: p, navigate }: { participant: TaskSummaryParticipant; navigate: (id: string) => void }) {
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? (p.status === 'error' || p.status === 'interrupted')
  const duration = p.finishedAt !== undefined ? Math.max(0, Math.round((p.finishedAt - p.createdAt) / 1000)) : null
  return <div className={`syntee-task-summary__participant is-${p.status}`}>
    <button type="button" className="syntee-task-summary__link" aria-expanded={open} onClick={() => setOverride(!open)}><ChevronDown size={12} /><span>{p.title}</span><small>{participantStatus(p.status as TaskSummaryParticipant['status'] | 'idle')}</small></button>
    {p.kind === 'chat' && p.status === 'done' && <span className="syntee-task-summary__badge">{p.readAt ? 'Результат прочитан' : 'Непрочитанный результат'}</span>}
    <AnimatedCollapse open={open}><div className="syntee-task-summary__participant-detail"><p>{p.task}</p><p className="syntee-task-summary__sub">{[p.role, p.model, duration !== null ? `${duration} с` : undefined, p.stepsCount !== undefined ? `${p.stepsCount} шагов` : undefined, p.toolCallsCount !== undefined ? `${p.toolCallsCount} вызовов инструментов` : undefined].filter(Boolean).join(' · ')}</p>{p.summary && <p>{p.summary}</p>}{p.error && <p className="syntee-task-summary__failure">{p.error}</p>}<div className="syntee-task-summary__participant-actions">{p.chatId && <button type="button" className="syntee-task-summary__insert" disabled={!tabActions.selectChat} onClick={() => tabActions.selectChat?.(p.chatId!)}><MessageSquare size={12} />Открыть чат</button>}{p.sourceMessageId && <button type="button" className="syntee-task-summary__insert" onClick={() => navigate(p.sourceMessageId)}><CornerUpLeft size={12} />Поручение в чате</button>}</div></div></AnimatedCollapse>
  </div>
}

function FirstFour({ children }: { children: React.ReactNode[] }) {
  const [all, setAll] = useState(false)
  return <>{all ? children : children.slice(0, 4)}{children.length > 4 && <button type="button" className="syntee-task-summary__change-toggle" onClick={() => setAll(!all)}>{all ? 'Свернуть' : `Показать все (${children.length})`}</button>}</>
}
function SummaryCheck({ check, navigate }: { check: TaskSummary['checks'][number]; navigate: (id: string) => void }) {
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? check.status === 'failed'
  return <div><div className="syntee-task-summary__result"><button type="button" className="syntee-task-summary__check" aria-expanded={open} onClick={() => setOverride(!open)}><span className={`is-${check.status}`}>{check.status === 'passed' ? <CircleCheck size={14} /> : check.status === 'failed' ? <CircleAlert size={14} /> : <CircleHelp size={14} />}</span><span><b>{check.title}</b><small>{check.status === 'passed' ? 'Пройдена' : check.status === 'failed' ? 'Проблема' : 'Исход не подтверждён'}</small></span></button><button type="button" className="syntee-task-summary__change-toggle" title="К сообщению проверки" aria-label="К сообщению проверки" onClick={() => navigate(check.messageId)}><CornerUpLeft size={12} /></button></div><AnimatedCollapse open={open}><pre className="syntee-task-summary__diff">{check.detail || 'Подробностей нет'}</pre></AnimatedCollapse></div>
}

function TaskSummary({ chatId, workdir, live, liveStatus, liveTodo = [], onNavigateMessage, onInsert }: Props) {
  const [state, setState] = useState<TaskSummaryState | null>(null)
  const [pinText, setPinText] = useState('')
  const [pinMode, setPinMode] = useState(false)
  const [expandedChanges, setExpandedChanges] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState(false)
  const currentChatRef = useRef(chatId)
  useLayoutEffect(() => { currentChatRef.current = chatId }, [chatId])
  const [menuOpen, setMenuOpen] = useState(false)
  const [taskPickerOpen, setTaskPickerOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef(0)
  const toast = useToast.getState().add
  const prefersReducedMotion = useReducedMotion()

  const load = useCallback(async () => {
    if (!chatId) return
    const request = ++requestRef.current
    const requestedChatId = chatId
    setState(null)
    setLoading(true); setError('')
    try {
      const next = await window.syntee.taskSummary.get(chatId)
      if (request === requestRef.current && requestedChatId === currentChatRef.current) { setState(next); setOpen(next.pinned) }
    } catch (e) {
      if (request === requestRef.current && requestedChatId === currentChatRef.current) {
        const message = String((e as Error)?.message ?? e)
        setError(message); toast(`Сводка: ${message}`, 'error')
      }
    }
    finally { if (request === requestRef.current && requestedChatId === currentChatRef.current) setLoading(false) }
  }, [chatId])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => { window.clearTimeout(timer); requestRef.current++ }
  }, [load])
  const expanded = open || !!state?.pinned
  useEffect(() => {
    if (!chatId) return
    const subscribedChatId = chatId
    const off = window.syntee.taskSummary.onChanged(event => {
      if (event.chatId !== subscribedChatId || subscribedChatId !== currentChatRef.current) return
      requestRef.current++
      setState(event.state)
      setLoading(false)
    })
    return () => { requestRef.current++; off() }
  }, [chatId])
  useEffect(() => {
    if (!expanded) return
    const onPointer = (event: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) { setOpen(false); setMenuOpen(false); setTaskPickerOpen(false) } }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); setMenuOpen(false); setTaskPickerOpen(false) } }
    document.addEventListener('pointerdown', onPointer); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [expanded])

  const mutate = useCallback(async (action: () => Promise<TaskSummaryState>, mutationChatId = chatId) => {
    const request = ++requestRef.current
    try {
      const next = await action()
      if (request === requestRef.current && mutationChatId === currentChatRef.current) { setState(next); setError('') }
    } catch (e) {
      if (request === requestRef.current && mutationChatId === currentChatRef.current) {
        const message = String((e as Error)?.message ?? e)
        setError(message); toast(`Сводка: ${message}`, 'error')
      }
    }
  }, [chatId])
  const patch = (value: Parameters<typeof window.syntee.taskSummary.update>[1]) => chatId && void mutate(() => window.syntee.taskSummary.update(chatId, value), chatId)
  const selected = state?.tasks.find(task => task.id === state.selectedTaskId) ?? state?.tasks[0]
  const isSelectedLiveTask = !selected || (selected.status === 'running' && selected.id === state?.tasks[0]?.id)
  const effectiveLive = live && isSelectedLiveTask
  const todo = selected?.todo?.length ? selected.todo : (isSelectedLiveTask ? liveTodo : [])
  const participants = selected?.participants ?? []
  const activeParticipants = participants.filter(isActiveParticipant).length
  const failedParticipants = participants.filter(p => p.status === 'error' || p.status === 'interrupted').length
  const failedChecks = selected?.checks.filter(check => check.status === 'failed').length ?? 0
  const done = todo.filter(item => item.status === 'done').length
  const hasContent = !!selected || todo.length > 0 || (state?.manualPins.length ?? 0) > 0
  const copy = async (text: string) => {
    if (!text) return
    try { await navigator.clipboard.writeText(text); setMenuOpen(false); toast('Скопировано', 'success') }
    catch { toast('Не удалось скопировать', 'error') }
  }
  const addManualPin = () => { setPinMode(true); setMenuOpen(false) }
  const submitPin = () => {
    const text = pinText.trim()
    if (chatId && text) void mutate(() => window.syntee.taskSummary.addPin(chatId, text), chatId)
    setPinText(''); setPinMode(false)
  }
  const navigate = (id: string) => { setOpen(true); onNavigateMessage?.(id) }
  const openUrlInBrowser = (target: string) => {
    if (!/^https?:\/\//i.test(target)) return
    const tabs = useRightPanelTabsStore.getState(); const ui = useUIStore.getState()
    tabs.openPanel('browser'); ui.setAgentPanelTab('browser'); ui.setAgentPanelOpen(true); void window.syntee.browser.newTab(target)
  }
  const openResult = (result: NonNullable<TaskSummary['results']>[number]) => {
    if (result.kind === 'file') void openFilePath(result.target, workdir)
    else if (result.kind === 'url') openUrlInBrowser(result.target)
    else if (result.kind === 'image') {
      if (/^https?:\/\//i.test(result.target)) openUrlInBrowser(result.target)
      else void openFilePath(result.target, workdir)
    }
  }
  const title = selected?.title ?? 'Сводка задачи'
  const compactStatus = effectiveLive ? (liveStatus || 'Идёт выполнение') : selected ? statusLabel[selected.status] : 'Нет активной задачи'
  const reducedTransition = prefersReducedMotion ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' as const }

  if (!chatId) return null
  return <div ref={rootRef} className={`syntee-task-summary${expanded ? ' syntee-task-summary--open' : ''}`}>
    <motion.button type="button" className="syntee-task-summary__trigger" onClick={() => state?.pinned ? setOpen(true) : setOpen(value => !value)} aria-expanded={expanded} aria-label={`${state?.pinned ? 'Закреплено, снимите закрепление кнопкой в панели' : 'Открыть сводку'}: ${title}; ${compactStatus}`} title={`${title} · ${compactStatus}${state?.pinned ? ' · закреплено, открепите в панели' : ''}`} whileHover={prefersReducedMotion ? undefined : { scale: 1.035 }} whileTap={prefersReducedMotion ? undefined : { scale: 0.97 }} transition={{ duration: 0.14 }}>
      <ListChecks size={12} /><span>Сводка</span>{todo.length > 0 ? <span className="syntee-task-summary__trigger-count">{done}/{todo.length}</span> : <span className={`syntee-task-summary__status-dot${effectiveLive ? ' syntee-task-summary__status-dot--live' : ''}`} />}
      {loading && <RefreshCw size={11} className="syntee-task-summary__spin" />}
    </motion.button>
    <AnimatePresence initial={false}>
      {expanded && <motion.section key="panel" className="syntee-task-summary__panel" aria-label="Сводка задачи" initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -5, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.99 }} transition={reducedTransition}>
        <header className="syntee-task-summary__header">
          <div className="syntee-task-summary__heading">
            {state && state.tasks.length > 1 ? <button type="button" className="syntee-task-summary__task-picker" aria-expanded={taskPickerOpen} aria-label="Выбрать задачу" title={title} onClick={() => { setTaskPickerOpen(value => !value); setMenuOpen(false) }}><span>{title}</span><ChevronDown size={12} /></button> : <strong title={title}>{title}</strong>}
            <span className="syntee-task-summary__sub">{compactStatus}{selected ? ` · ${new Date(selected.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
          </div>
          <div className="syntee-task-summary__actions">
          <button type="button" title={state?.pinned ? 'Открепить сводку' : 'Закрепить сводку'} aria-label={state?.pinned ? 'Открепить сводку' : 'Закрепить сводку'} onClick={() => patch({ pinned: !state?.pinned })}>{state?.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
          <button type="button" title="Ещё" onClick={() => { setMenuOpen(value => !value); setTaskPickerOpen(false) }}><MoreHorizontal size={15} /></button>
          <AnimatePresence initial={false}>{menuOpen && <motion.div className="syntee-task-summary__menu" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={reducedTransition}><button type="button" onClick={() => void copy(selected?.summary ?? '')}><Copy size={13} />Копировать итог</button><button type="button" onClick={() => void copy(todo.map(item => `${item.status === 'done' ? '✓' : '○'} ${item.text}`).join('\n'))}><Copy size={13} />Копировать план</button><button type="button" onClick={() => void copy(selected?.results.map(result => `${result.title}: ${result.target}`).join('\n') ?? '')}><Copy size={13} />Копировать результаты</button><button type="button" onClick={addManualPin}><Pin size={13} />Добавить закрепление</button><button type="button" onClick={() => patch({ newTaskRequested: true })}><Plus size={13} />Новая задача</button></motion.div>}</AnimatePresence>
          {!state?.pinned && <button type="button" title="Закрыть сводку" aria-label="Закрыть сводку" onClick={() => { setOpen(false); setMenuOpen(false) }}><X size={14} /></button>}
        </div></header>
        <AnimatePresence initial={false}>{taskPickerOpen && <motion.div className="syntee-task-summary__task-options" aria-label="История задач" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={reducedTransition}><div>{state?.tasks.map(task => <button type="button" key={task.id} className={task.id === selected?.id ? 'is-selected' : ''} aria-pressed={task.id === selected?.id} onClick={() => { patch({ selectedTaskId: task.id }); setTaskPickerOpen(false) }}><span>{task.title}</span><small>{statusLabel[task.status]}</small>{task.id === selected?.id && <Check size={12} />}</button>)}</div></motion.div>}</AnimatePresence>
        {error && <div className="syntee-task-summary__error"><CircleAlert size={14} />Не удалось обновить: {error}<button type="button" onClick={() => void load()}>Повторить</button></div>}
        <div className="syntee-task-summary__scroll">
          {pinMode && <form className="syntee-task-summary__pin-form" onSubmit={event => { event.preventDefault(); submitPin() }}><input autoFocus maxLength={500} value={pinText} onChange={event => setPinText(event.target.value)} placeholder="Текст закрепления" /><button type="submit" disabled={!pinText.trim()}><Check size={13} /></button><button type="button" onClick={() => { setPinMode(false); setPinText('') }}><X size={13} /></button></form>}
          {hasContent ? <>
            {selected && selected.id !== state?.tasks[0]?.id && <div className="syntee-task-summary__old">Выбрана прошлая задача<button type="button" onClick={() => patch({ selectedTaskId: state?.tasks[0]?.id })}>Вернуться к текущей</button></div>}
            <div key={selected?.id ?? 'current'}>
              {effectiveLive && <Section title="Сейчас" defaultOpen><p>{liveStatus || 'Идёт выполнение'}</p></Section>}
              {!!todo.length && <Section title="План" count={`${done}/${todo.length}`} defaultOpen={!!effectiveLive}><div className="syntee-task-summary__todo">{todo.map((item, index) => <div key={`${item.text}-${index}`} className={`syntee-task-summary__todo-item is-${item.status}`}>{todoIcon(item.status)}<span>{item.text}</span></div>)}</div></Section>}
              {!!participants.length && <Section title="Команда" count={`${activeParticipants} активных · ${participants.length} всего${failedParticipants ? ` · ${failedParticipants} проблем` : ''}`} defaultOpen={!!activeParticipants || !!failedParticipants}>{(['subagent', 'chat'] as const).map(kind => { const group = participants.filter(p => p.kind === kind); return !!group.length && <div key={kind}><div className="syntee-task-summary__group">{kind === 'subagent' ? 'Сабагенты' : 'Связанные чаты'} · {group.length}</div>{group.map(p => <Participant key={`${p.id}:${p.requestId ?? ''}`} participant={p} navigate={navigate} />)}</div> })}</Section>}
              {!!selected?.results.length && <Section title="Результаты" count={selected.results.length} defaultOpen={!effectiveLive}><FirstFour>{selected.results.map(result => <div className="syntee-task-summary__result" key={result.id}><button type="button" className="syntee-task-summary__link" onClick={() => openResult(result)}>{result.title}<ExternalLink size={12} /></button><button type="button" className="syntee-task-summary__change-toggle" title="К сообщению результата" aria-label="К сообщению результата" onClick={() => navigate(result.messageId)}><CornerUpLeft size={12} /></button><button type="button" title="Копировать результат" aria-label="Копировать результат" onClick={() => void copy(`${result.title}: ${result.target}`)}><Copy size={12} /></button></div>)}</FirstFour></Section>}
              {selected?.summary && <Section title="Итог" defaultOpen={!effectiveLive}><p>{selected.summary}</p><button type="button" className="syntee-task-summary__insert" onClick={() => onInsert(selected.summary ?? '')}><Play size={13} />Подставить в поле</button></Section>}
              {!!selected?.checks.length && <Section title="Проверки" count={failedChecks ? `${failedChecks} проблем · ${selected.checks.length}` : selected.checks.length} defaultOpen={failedChecks > 0}>{selected.checks.map(check => <SummaryCheck key={check.id} check={check} navigate={navigate} />)}</Section>}
              {selected?.remaining && <Section title="Осталось" defaultOpen={!effectiveLive}><p>{selected.remaining}</p><button type="button" className="syntee-task-summary__insert" onClick={() => onInsert(`Продолжай задачу «${selected.title}»: ${selected.remaining ?? ''}`)}><Play size={13} />Продолжить эту задачу</button></Section>}
              {!!selected?.changes.length && <Section title="Изменения" count={selected.changes.length}><FirstFour>{selected.changes.map(change => { const key = `${selected.id}-${change.path}-${change.messageId}`; const fileName = change.path.split(/[\\/]/).pop() || change.path; return <div className="syntee-task-summary__change" key={key}><div className="syntee-task-summary__result"><button type="button" className="syntee-task-summary__link" title={change.path} onClick={() => void openFilePath(change.path, workdir)}>{fileName}<FileDiff size={12} /></button><button type="button" className="syntee-task-summary__change-toggle" title="К сообщению изменения" aria-label="К сообщению изменения" onClick={() => navigate(change.messageId)}><CornerUpLeft size={12} /></button></div>{change.diff && <><button type="button" className="syntee-task-summary__change-toggle" onClick={() => setExpandedChanges(value => ({ ...value, [key]: !value[key] }))}>{expandedChanges[key] ? 'Скрыть patch' : 'Показать patch'}</button><AnimatedCollapse open={!!expandedChanges[key]}><pre className="syntee-task-summary__diff">{change.diff}</pre></AnimatedCollapse></>}</div> })}</FirstFour></Section>}
              {!!state?.manualPins.length && <Section title="Заметки" count={state.manualPins.length}>{state.manualPins.map(pin => <div className="syntee-task-summary__pin" key={pin.id}><button type="button" disabled={!pin.messageId} onClick={() => pin.messageId && navigate(pin.messageId)}>{pin.text}</button><button type="button" title="Удалить" onClick={() => chatId && void mutate(() => window.syntee.taskSummary.removePin(chatId, pin.id))}><X size={13} /></button></div>)}</Section>}
            </div>
          </> : <div className="syntee-task-summary__empty"><CircleHelp size={18} /><span>Сводка появится, когда начнётся задача.</span></div>}
        </div>
      </motion.section>}
    </AnimatePresence>
  </div>
}
export default TaskSummary
