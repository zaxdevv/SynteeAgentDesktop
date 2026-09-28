import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import AppIcon, { type IconName } from '../AppIcon/AppIcon'
import ToolChain from '../ToolChain/ToolChain'
import { getSubagentRole } from '../../../../../shared/subagent-roles'
import { getToolMeta } from '../../../../../shared/toolMeta'
import { normalizeMathDelimiters } from '@shared/mathNormalize'
import { whileHoverSm, whileTapSm, springHover } from '../../../utils/motionPresets'
import '../MessageBubble/MessageBubble.css'
import './AgentPanel.css'

interface AgentStep {
  id: string
  type: 'tool_call' | 'tool_result' | 'thought'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  timestamp: number
  imageUrl?: string
}

interface AgentRecord {
  id: string
  parentId: string | null
  chatId: string
  task: string
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  model: string
  steps: AgentStep[]
  result: string
  summary: string
  createdAt: number
  finishedAt?: number
  error?: string
  role?: string
  thinking?: string
  thinkingMs?: number
  statusText?: string
}

interface AgentPanelProps {
  focusAgentId?: string | null
  currentChatId?: string | null
  /** Видим ли таб агентов — если false, приостанавливаем подписку IPC */
  isVisible?: boolean
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Ожидает', running: 'Работает', done: 'Готово',
  error: 'Ошибка', cancelled: 'Отменён',
}

const REMARK_PLUGINS = [remarkGfm, remarkMath] as const
const REHYPE_PLUGINS = [[rehypeKatex, { errorColor: 'var(--danger, #e5484d)' }]] as const

// Memoized ReactMarkdown — не перерендериваем если текст не изменился.
// Текст нормализуем (\(...\) / \[...\] → $ / $$) — remark-math понимает
// только долларовые разделители.
const MemoizedResult = memo(function MemoizedResult({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS as never}
      rehypePlugins={REHYPE_PLUGINS as never}
    >
      {normalizeMathDelimiters(text)}
    </ReactMarkdown>
  )
}, (prev, next) => prev.text === next.text)

function elapsed(a: AgentRecord) {
  const ms = (a.finishedAt ?? Date.now()) - a.createdAt
  return ms < 60000 ? (ms / 1000).toFixed(1) + 'с' : (ms / 60000).toFixed(1) + 'м'
}

function pluralSteps(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} шаг`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} шага`
  return `${n} шагов`
}

export default function AgentPanel({ focusAgentId, currentChatId, isVisible = true }: AgentPanelProps) {
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  // Загружаем список и подписываемся на обновления с debounce
  // Приостанавливаем подписку когда таб скрыт (isVisible=false)
  useEffect(() => {
    if (!isVisible) return // Не подписываемся когда таб не виден

    window.syntee.agent.list().then(setAgents)

    // Буфер для batch обновлений — не на каждый IPC вызываем setAgents
    const pendingUpdates = new Map<string, AgentRecord>()
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
      timer = null
      if (pendingUpdates.size === 0) return
      const updates = new Map(pendingUpdates)
      pendingUpdates.clear()
      setAgents(prev => {
        const next = [...prev]
        for (const [id, u] of updates) {
          const idx = next.findIndex(a => a.id === id)
          if (idx === -1) next.push(u)
          else next[idx] = u
        }
        return next
      })
    }

    const off = window.syntee.on('agent:update', (updated: unknown) => {
      const u = updated as AgentRecord
      pendingUpdates.set(u.id, u)
      if (!timer) timer = setTimeout(flush, 200)
    })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [isVisible])

  // focusAgentId → раскрываем карточку (без снятия фильтра по чату)
  useEffect(() => {
    if (focusAgentId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpanded(prev => {
        if (prev.has(focusAgentId)) return prev
        return new Set(prev).add(focusAgentId)
      })
    }
  }, [focusAgentId])

  // ВСЕГДА фильтруем по currentChatId — показываем только агентов активного чата
  const filteredAgents = useMemo(
    () => currentChatId ? agents.filter(a => a.chatId === currentChatId) : [],
    [agents, currentChatId]
  )

  // Сортировка: активные сверху, потом по времени
  const sorted = useMemo(() => {
    return [...filteredAgents].sort((a, b) => {
      const rank = (s: string) => s === 'running' ? 0 : s === 'pending' ? 1 : 2
      if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status)
      return b.createdAt - a.createdAt
    })
  }, [filteredAgents])

  // Дерево: корневые и дочерние
  const roots = useMemo(
    () => sorted.filter(a => a.parentId === null || !agents.find(p => p.id === a.parentId)),
    [sorted, agents]
  )
  const childrenOf = useCallback(
    (parentId: string) => sorted.filter(a => a.parentId === parentId),
    [sorted]
  )

  // Авто-раскрытие running/pending агентов
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded(prev => {
      let changed = false
      const next = new Set(prev)
      for (const a of sorted) {
        if ((a.status === 'running' || a.status === 'pending') && !next.has(a.id)) {
          next.add(a.id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [sorted])

  // Sticky-автоскролл: скроллим вниз ТОЛЬКО если пользователь уже был внизу.
  // Иначе стриминг токенов/thinking/steps будет дёргать скролл и мешать
  // просмотру вышестоящих карточек. Проверяем «у дна» по scroll-позиции
  // с допуском 40px (учитывает появление новых элементов без точной
  // синхронизации с rAF).
  const stickToBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distance < 40
  }, [])

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    })
  }, [])

  const hasRunning = sorted.some(a => a.status === 'running' || a.status === 'pending')
  useEffect(() => {
    if (hasRunning && stickToBottomRef.current) scrollToBottom()
  }, [sorted, hasRunning, scrollToBottom])

  const toggleExpand = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleCancel = useCallback(async (id: string) => {
    await window.syntee.agent.cancel(id)
  }, [])

  // Empty: чат не выбран
  if (!currentChatId) {
    return (
      <div className="agent-panel agent-panel--tab-content">
        <div className="agent-panel__empty">
          <AppIcon name="git-branch" size="lg" tone="muted" />
          <p>Откройте чат</p>
          <p className="agent-panel__empty-hint">Агенты привязаны к активному чату</p>
        </div>
      </div>
    )
  }

  // Empty: нет агентов в чате
  if (filteredAgents.length === 0) {
    return (
      <div className="agent-panel agent-panel--tab-content">
        <div className="agent-panel__empty">
          <AppIcon name="git-branch" size="lg" tone="muted" />
          <p>В этом чате нет агентов</p>
          <p className="agent-panel__empty-hint">Агенты запускаются через spawn_agent в основном чате</p>
        </div>
      </div>
    )
  }

  return (
    <div className="agent-panel agent-panel--tab-content">
      <div className="agent-panel__stream" ref={scrollRef} onScroll={handleScroll}>
        {roots.map(agent => (
          <div key={agent.id}>
            <AgentStreamCard
              agent={agent}
              expanded={expanded.has(agent.id)}
              onToggle={() => toggleExpand(agent.id)}
              onCancel={handleCancel}
            />
            {childrenOf(agent.id).map(child => (
              <div key={child.id} className="agent-panel__child">
                <div className="agent-panel__child-line" />
                <AgentStreamCard
                  agent={child}
                  expanded={expanded.has(child.id)}
                  onToggle={() => toggleExpand(child.id)}
                  onCancel={handleCancel}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Карточка агента в потоке ────────────────────────────────────────────
const AgentStreamCard = memo(function AgentStreamCard({ agent, expanded, onToggle, onCancel }: {
  agent: AgentRecord
  expanded: boolean
  onToggle: () => void
  onCancel: (id: string) => void
}) {
  const isLive = agent.status === 'running' || agent.status === 'pending'
  const currentTool = (agent.steps ?? []).filter(s => s.type === 'tool_call').slice(-1)[0]?.toolName
  const roleMeta = agent.role ? getSubagentRole(agent.role) : null
  const hasThinking = !!(agent.thinking && agent.thinking.trim())
  const toolSteps = (agent.steps ?? []).filter(s => s.type === 'tool_call' || s.type === 'tool_result')

  // Показывать live-статус ("Думаю...", "Rate limit...") в хедере когда агент работает
  const statusText = isLive ? agent.statusText : null

  return (
    <div className={`agent-stream-card agent-stream-card--${agent.status}${isLive ? ' agent-stream-card--live' : ''}`}>
      <div className={`agent-stream-card__stripe agent-stream-card__stripe--${agent.status}`} />
      <div className="agent-stream-card__main">
        {/* Заголовок — всегда виден */}
        <div className="agent-stream-card__header" onClick={onToggle}>
          <div className="agent-stream-card__status-icon">
            <AppIcon
              name={agent.status === 'running' ? 'loader' : agent.status === 'done' ? 'check' : agent.status === 'error' ? 'x' : agent.status === 'cancelled' ? 'archive' : 'clock'}
              size="xs"
              tone={agent.status === 'done' ? 'success' : agent.status === 'error' ? 'danger' : agent.status === 'running' ? 'accent' : 'muted'}
              animation={agent.status === 'running' ? 'spin' : 'none'}
            />
          </div>
          <span className="agent-stream-card__task" title={agent.task}>{agent.task}</span>
          {statusText ? (
            <span className="agent-stream-card__status-text">{statusText}</span>
          ) : currentTool && isLive ? (
            <span className="agent-stream-card__current-tool" title={currentTool}>
              <AppIcon name={getToolMeta(currentTool).icon as IconName} size="xs" style={{ color: getToolMeta(currentTool).color }} />
              {currentTool}
            </span>
          ) : null}
          {roleMeta && (
            <span className="agent-stream-card__role-badge" style={{ color: roleMeta.color }}>
              {roleMeta.nameEn}
            </span>
          )}
          <span className={`agent-stream-card__badge agent-stream-card__badge--${agent.status}`}>
            {STATUS_LABEL[agent.status]}
          </span>
          <AppIcon
            name="chevronDown"
            size="xs"
            tone="muted"
            className={expanded ? 'agent-stream-card__chevron' : 'agent-stream-card__chevron agent-stream-card__chevron--closed'}
          />
        </div>

        {/* Раскрытое тело */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              className="agent-stream-card__body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            >
              {/* Задача — что было запрошено у агента */}
              <div className="agent-stream-card__task-block">
                <div className="agent-stream-card__section-label">Задача</div>
                <div className="agent-stream-card__task-text">{agent.task}</div>
              </div>

              {/* Мета-строка */}
              <div className="agent-stream-card__meta">
                <span className="agent-stream-card__meta-model">{agent.model}</span>
                <span className="agent-stream-card__meta-dot">·</span>
                <span>{pluralSteps(toolSteps.length)}</span>
                <span className="agent-stream-card__meta-dot">·</span>
                <span>{elapsed(agent)}</span>
                {hasThinking && agent.thinkingMs ? (
                  <>
                    <span className="agent-stream-card__meta-dot">·</span>
                    <span className="agent-stream-card__meta-thinking">
                      <AppIcon name="brain" size="xs" tone="muted" />
                      {(agent.thinkingMs / 1000).toFixed(1)}с
                    </span>
                  </>
                ) : null}
              </div>

              {/* Thinking / Мышление — рассуждения агента */}
              {hasThinking && (
                <ThinkingBlock
                  text={agent.thinking!}
                  isLive={isLive}
                  thinkingMs={agent.thinkingMs}
                />
              )}

              {/* Live-индикатор "Думаю..." когда running и нет steps и нет thinking */}
              {isLive && toolSteps.length === 0 && !hasThinking && (
                <div className="agent-stream-card__waiting">
                  <div className="agent-stream-card__shimmer-line" />
                  <div className="agent-stream-card__shimmer-line agent-stream-card__shimmer-line--short" />
                </div>
              )}

              {/* ToolChain — тул-вызовы с diff, аргументами, результатами */}
              {toolSteps.length > 0 && (
                <div className="agent-stream-card__steps">
                  <ToolChain
                    steps={toolSteps as never}
                    mode="detailed"
                    isRunning={agent.status === 'running'}
                  />
                </div>
              )}

              {/* Итог — markdown-рендеринг (стримится live) */}
              {agent.result && (
                <div className="agent-stream-card__result">
                  <div className="agent-stream-card__result-label">
                    Итог
                    {isLive && <span className="agent-stream-card__result-streaming">пишет…</span>}
                  </div>
                  <div className="agent-stream-card__result-text selectable">
                    <MemoizedResult text={agent.result} />
                  </div>
                </div>
              )}

              {/* Ошибка */}
              {agent.error && (
                <div className="agent-stream-card__error">{agent.error}</div>
              )}

              {/* Отмена */}
              {agent.status === 'running' && (
                <motion.button
                  className="agent-stream-card__cancel"
                  onClick={(e) => { e.stopPropagation(); onCancel(agent.id) }}
                  whileHover={whileHoverSm}
                  whileTap={whileTapSm}
                  transition={springHover}
                >
                  <AppIcon name="x" size="xs" />
                  Остановить
                </motion.button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}, (prev, next) => {
  // Кастомный comparator: перерендериваем только если реально что-то изменилось
  return prev.agent.id === next.agent.id
    && prev.agent.status === next.agent.status
    && prev.agent.steps.length === next.agent.steps.length
    && prev.agent.result === next.agent.result
    && prev.agent.thinking === next.agent.thinking
    && prev.agent.statusText === next.agent.statusText
    && prev.agent.summary === next.agent.summary
    && prev.agent.error === next.agent.error
    && prev.agent.thinkingMs === next.agent.thinkingMs
    && prev.expanded === next.expanded
})

// ── Thinking-блок — рассуждения агента (раскрываемый) ────────────────────
const ThinkingBlock = memo(function ThinkingBlock({ text, isLive, thinkingMs }: {
  text: string
  isLive: boolean
  thinkingMs?: number
}) {
  const [showThinking, setShowThinking] = useState(true)

  // При live — всегда раскрыто. При завершении — авто-сворачивание через 2с
  const wasLiveRef = useRef(false)
  useEffect(() => {
    if (isLive) {
      wasLiveRef.current = true
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowThinking(true)
    } else if (wasLiveRef.current && !isLive) {
      const t = setTimeout(() => setShowThinking(false), 2000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [isLive])

  return (
    <div className="agent-stream-card__thinking">
      <button
        className="agent-stream-card__thinking-toggle"
        onClick={(e) => { e.stopPropagation(); setShowThinking(s => !s) }}
      >
        <AppIcon
          name="chevronDown"
          size="xs"
          tone="muted"
          className={showThinking ? 'agent-stream-card__thinking-chevron' : 'agent-stream-card__thinking-chevron agent-stream-card__thinking-chevron--closed'}
        />
        <AppIcon name="brain" size="xs" tone="muted" />
        <span>Мышление</span>
        {isLive && <span className="agent-stream-card__thinking-live">думаю…</span>}
        {!isLive && thinkingMs ? <span className="agent-stream-card__thinking-time">{(thinkingMs / 1000).toFixed(1)}с</span> : null}
      </button>
      <AnimatePresence initial={false}>
        {showThinking && (
          <motion.div
            className="agent-stream-card__thinking-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className={`agent-stream-card__thinking-text selectable${isLive ? ' agent-stream-card__thinking-text--live' : ''}`}>
              {text}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}, (prev, next) => prev.text === next.text && prev.isLive === next.isLive && prev.thinkingMs === next.thinkingMs)
