import { useState, useEffect, useRef, memo, useMemo, useCallback, useId, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import ToolResultRenderer, { CodeSurface } from './ToolResultRenderer'
import FileChip from './FileChip'
import { synthesizeDiffFromArgs, countDiffLines, asArgsObject } from '../../../utils/synthesizeDiff'
import { ParsedContent, createMdComponents } from '../MessageBubble/markdownRenderer'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { containsMathMarkers } from '@shared/mathNormalize'
import ThinkingBlock from '../ThinkingBlock/ThinkingBlock'
import type { ToolOutputMode, SteerAttachmentMeta, Attachment } from '../../../../../shared/types'
import { getSubagentRole } from '../../../../../shared/subagent-roles'
import { useChatRemeasure } from '../MessageBubble/remeasure'
import { removePendingSteer } from '../../../hooks/chatRunRuntime'
import { stripAttachTokens } from '../../../../../shared/attachmentMarkdown'
import { copyToClipboard } from '../../../utils/clipboard'
import renderInlineAttachments from '../InlineAttachmentRenderer/InlineAttachmentRenderer'

import { getToolMeta, TOOL_META } from '../../../../../shared/toolMeta'
import { BRIEFING_MARKER } from '../../../../../shared/assistants'
import { isFinalAnswerToolName } from '../../../../../shared/finalAnswer'
import './ToolChain.css'

export interface ToolStep {
  id: string
  /** 'steer' — реплика пользователя, внедрённая в контекст активного рана
   *  (long-press на кнопке отправки). Рендерится отдельной карточкой ленты. */
  type: 'tool_call' | 'tool_result' | 'steer' | 'hint' | 'janitor'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  timestamp: number
  imageUrl?: string
  diff?: string  // unified diff для edit_file
  callId?: string  // id tool_call из API — для матчинга call↔result при параллельных тулах
  /** Имя MCP-сервера для MCP-тулов (mcp__server__tool). */
  serverName?: string
  // true — модель только начала вызывать этот тул, аргументы ещё не собраны
  // (см. tool_call_pending в Agent.ts). Карточка показывает "готовится" без
  // аргументов, заменяется на обычный tool_call in-place когда придёт полный.
  pending?: boolean
  // Native analyze_image lifecycle (основная модель получает пиксели напрямую).
  // 'pending' — пиксели уже отданы модели, визуальный ответ ещё идёт; позже
  // приходит tool_result_update с 'responded' (+findings) или 'failed'.
  // Персистентный 'pending' (Стоп/ошибка) = незавершённый анализ.
  visualAnalysis?: {
    status: 'pending' | 'responded' | 'failed'
    findings?: string
  }
  codeMode?: {
    code: string
    trace?: Array<{ id?: string; name: string; args: unknown; result: string; status: 'success' | 'failure' | 'running'; diff?: string }>
  }
  /** §steer: id реплики (ключ оптимистичной карточки) и признак применения. */
  steerId?: string
  steerApplied?: boolean
  /** §steer — вложения реплики (чипы/миниатюры в карточке). */
  attachments?: SteerAttachmentMeta[]
  hintSource?: import('../../../../../shared/assistants').HintSource
  hintId?: string
  janitorKind?: string
  janitorTokensSaved?: number
  janitorArchiveId?: string
  janitorActions?: Array<{ kind: string; description: string; tokensSaved: number; archiveId?: string }>
}

// Группируем шаги: каждая итерация = один вызов тула + его результат
interface Iteration {
  id: string
  call: ToolStep
  result?: ToolStep
}

function buildIterations(steps: ToolStep[]): Iteration[] {
  // publish_result удалён из тулсета — старые сообщения ещё содержат эти шаги.
  // Скрываем их, чтобы в ленте не оставалось карточки несуществующего тула.
  steps = steps.filter(s => s.toolName !== 'publish_result')
  // §final-answer — в старых сообщениях остались «вызовы» тула final_answer
  // (модель спутала служебный тег с функцией). В ленте им делать нечего.
  steps = steps.filter(s => !isFinalAnswerToolName(s.toolName))
  const iters: Iteration[] = []
  const calls = steps.filter(s => s.type === 'tool_call')
  const results = steps.filter(s => s.type === 'tool_result')

  // Сначала матчим строго по callId — это единственный надёжный ключ при
  // параллельных тулах (Promise.all в Agent.ts создаёт несколько
  // tool_call одновременно с одним toolName). Раньше дальше шёл жадный
  // фолбэк «первый незаматченный result», который мог присвоить чужой
  // результат не тому вызову → реальный вызов оставался без result →
  // спиннер «Выполняется…» крутился бесконечно (running=true пока
  // !iter.result). Теперь фолбэк только по toolName среди resultless
  // вызовов, и orphan-результаты рендерятся как собственные итерации.
  const matchedResultIds = new Set<string>()
  for (const call of calls) {
    let result: ToolStep | undefined
    if (call.callId) {
      result = results.find(r => r.callId === call.callId)
    }
    if (!result) {
      // Fallback: первый незаматченный result с тем же toolName (без
      // чужого callId или с callId, которому уже нашли свою пару).
      result = results.find(r =>
        r.toolName === call.toolName &&
        !matchedResultIds.has(r.id) &&
        (!r.callId || r.callId === call.callId)
      )
    }
    if (result) {
      matchedResultIds.add(result.id)
    }
    iters.push({ id: call.id, call, result })
  }

  // Orphan-результаты (_error, _limit, _loop_guard, _verification) не имеют
  // парного tool_call — раньше дропались или примагничивались к чужой
  // итерации через жадный фолбэк. Теперь рендерим как собственные
  // синтетические итерации, чтобы пользователь видел причину остановки.
  for (const result of results) {
    if (matchedResultIds.has(result.id)) continue
    // Синтетический call с тем же toolName — итерация выглядит как обычный
    // тул, но без аргументов (call.content = toolName).
    const synthCall: ToolStep = {
      id: `${result.id}-synth`,
      type: 'tool_call',
      toolName: result.toolName,
      toolArgs: undefined,
      content: result.toolName ?? 'tool',
      success: undefined,
      timestamp: result.timestamp,
      callId: result.callId,
    }
    iters.push({ id: synthCall.id, call: synthCall, result })
  }

  return iters
}

/** true, если в steps есть tool_call без парного результата. Параллельные
 *  тулы (Promise.all в Agent.ts) завершаются по очереди: первый tool_result
 *  встаёт последним шагом, пока остальные вызовы ещё выполняются. Используется
 *  MessageBubble для isRunning тулчейна — «последний шаг = результат» больше
 *  не означает «раунд завершён». Матчинг как в buildIterations: callId,
 *  fallback toolName с потреблением результата (matched-Set). */
export function hasUnfinishedCalls(steps: ToolStep[]): boolean {
  const calls = steps.filter(s => s.type === 'tool_call')
  if (calls.length === 0) return false
  const results = steps.filter(s => s.type === 'tool_result')
  const matched = new Set<string>()
  for (const c of calls) {
    const r = results.find(x =>
      !matched.has(x.id) &&
      ((c.callId && x.callId === c.callId) ||
        (x.toolName === c.toolName && (!x.callId || x.callId === c.callId)))
    )
    if (!r || r.visualAnalysis?.status === 'pending') return true
    matched.add(r.id)
  }
  return false
}

// ── Единая лента хода работы ─────────────────────────────────────────
// В одном сообщении несколько итераций (текст → тулы → текст → тулы). Раньше
// на каждую итерацию рисовался свой ToolChain — в чате появлялась стопка
// «Выполнено за 356мс · 1 действие» / «… 21мс · 1 действие». Теперь сообщение
// отдаёт СЕКЦИИ (итерации) в один ToolChain: одна шапка «Выполнено за 22с ·
// 3 действия» и одна раскрывающаяся лента, где рассуждение и тулы идут
// подряд, как в референсе (Think → тулы → Think).
export interface ToolChainSection {
  thinking?: string
  thinkingMs?: number
  /** Текст, который модель написала перед этими тулами (обычный текст, не
   *  рассуждение). Живёт внутри ленты — сворачивается вместе с ходом работы. */
  text?: string
  steps: ToolStep[]
}

// Схлопываем длинные цепочки однотипных тулов (6 read_file подряд) в
// одну раскрывающуюся группу. Только в финальном состоянии (!isRunning),
// чтобы во время live-прогона не дезориентировать внезапным коллапсом.
// spawn_agent не группируем: у него внутри ленты живёт собственная карточка
// саб-агента — в группе она бы исчезла вместе с телом шага.
const NO_GROUP_TOOLS = new Set(['spawn_agent', 'ask_user', 'update_todo'])

type ChainEntry =
  | { kind: 'thinking'; key: string; text: string; ms?: number; si: number }
  | { kind: 'text'; key: string; text: string; si: number }
  | { kind: 'single'; key: string; iter: Iteration; si: number }
  | { kind: 'group'; key: string; meta: ReturnType<typeof getToolMeta>; iters: Iteration[]; si: number }
  | { kind: 'steer'; key: string; step: ToolStep; si: number }
  | { kind: 'assistant'; key: string; step: ToolStep; si: number }

/**
 * §steer — шаги итерации в ХРОНОЛОГИЧЕСКОМ порядке: обычные тулы группируются
 * в Iteration (call+result), а карточки внедрённых реплик остаются отдельными
 * записями. Без этого steer-шаг (у него нет пары call/result) просто выпадал
 * бы из ленты: buildIterations фильтрует только tool_call/tool_result.
 */
function buildSectionItems(
  steps: ToolStep[],
): Array<{ kind: 'iter'; iter: Iteration } | { kind: 'steer'; step: ToolStep } | { kind: 'assistant'; step: ToolStep }> {
  const out: Array<{ kind: 'iter'; iter: Iteration } | { kind: 'steer'; step: ToolStep } | { kind: 'assistant'; step: ToolStep }> = []
  let segment: ToolStep[] = []
  const flush = () => {
    if (segment.length === 0) return
    for (const iter of buildIterations(segment)) out.push({ kind: 'iter', iter })
    segment = []
  }
  for (const step of steps) {
    if (step.type === 'steer') {
      flush()
      out.push({ kind: 'steer', step })
    } else if (step.type === 'hint' || step.type === 'janitor') {
      flush()
      out.push({ kind: 'assistant', step })
    } else {
      segment.push(step)
    }
  }
  flush()
  return out
}

function buildChain(
  sectionIters: Iteration[][],
  sections: Array<{ thinking?: string; thinkingMs?: number; text?: string; steps?: ToolStep[] }>,
  isRunning: boolean,
): ChainEntry[] {
  const flat: ChainEntry[] = []
  sectionIters.forEach((iters, si) => {
    const sec = sections[si] ?? {}
    if (sec.thinking) flat.push({ kind: 'thinking', key: `th-${si}`, text: sec.thinking, ms: sec.thinkingMs, si })
    if (sec.text) flat.push({ kind: 'text', key: `tx-${si}`, text: sec.text, si })
    // §steer: идём по raw-steps секции, чтобы карточка реплики встала на своё
    // место в ленте. Для секций без steer результат идентичен iters.
    const items = sec.steps ? buildSectionItems(sec.steps) : iters.map(iter => ({ kind: 'iter' as const, iter }))
    for (const item of items) {
      if (item.kind === 'steer') flat.push({ kind: 'steer', key: `steer-${item.step.id}`, step: item.step, si })
      else if (item.kind === 'assistant') flat.push({ kind: 'assistant', key: `asst-${item.step.id}`, step: item.step, si })
      else flat.push({ kind: 'single', key: item.iter.id, iter: item.iter, si })
    }
  })
  if (isRunning) return flat

  const out: ChainEntry[] = []
  let i = 0
  while (i < flat.length) {
    const entry = flat[i]
    if (entry.kind !== 'single') { out.push(entry); i++; continue }
    const name = entry.iter.call.toolName
    const noGroup = !name || NO_GROUP_TOOLS.has(name)
    let j = i + 1
    if (!noGroup) {
      // Рассуждение/текст разрывает серию: внутри группы их не спрятать.
      while (j < flat.length && flat[j].kind === 'single' && (flat[j] as { iter: Iteration }).iter.call.toolName === name) j++
    }
    if (!noGroup && j - i >= 3) {
      const slice = flat.slice(i, j) as Array<{ kind: 'single'; iter: Iteration; si: number }>
      out.push({
        kind: 'group',
        key: `group-${entry.iter.id}`,
        meta: getToolMeta(name, entry.iter.call.serverName),
        iters: slice.map(s => s.iter),
        si: entry.si,
      })
    } else {
      for (let k = i; k < j; k++) out.push(flat[k])
    }
    i = j
  }
  return out
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}мс`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}с`
  return `${Math.floor(ms / 60000)}м ${Math.round((ms % 60000) / 1000)}с`
}

// Время для итоговой фразы «Выполнено за 22с»: длинные прогоны — целые
// секунды (десятая доля там не несёт смысла и удлиняет строку).
function formatDoneDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}мс`
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}с`
  if (ms < 60000) return `${Math.round(ms / 1000)}с`
  return `${Math.floor(ms / 60000)}м ${Math.round((ms % 60000) / 1000)}с`
}

function truncate(s: string, n = 80) {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * §steer — карточка реплики пользователя, внедрённой в контекст РАБОТАЮЩЕГО
 * агента (удержание кнопки отправки или Enter). Два состояния:
 *   • applied=false — «ждёт границы раунда»: агент ещё не дошёл до точки
 *     вставки (идёт долгий тул/стрим). Пульсируем + крестик «передумал»:
 *     пока реплика не вставлена в messages, её можно снять целиком.
 *   • applied=true — «внедрено в контекст», реплика стала частью messages;
 *     откат здесь невозможен (только откатом сообщения), крестика нет.
 * Карточка не является тулом и не попадает в счётчик «N действий».
 * Кнопка «копировать» доступна в обоих состояниях — в буфер уходит чистый
 * текст реплики ([[attach:id]]-токены вычищаются), как если бы пользователь
 * набрал его без чипов.
 */
const SteerCard = memo(function SteerCard({ step, chatId }: { step: ToolStep; chatId?: string }) {
  const applied = step.steerApplied !== false
  const steerId = step.steerId
  const canCancel = !applied && !!chatId && !!steerId
  const [copied, setCopied] = useState(false)
  const handleCancel = useCallback(() => {
    if (!chatId || !steerId) return
    // Сначала убираем карточку локально (мгновенный отклик), затем говорим
    // main снять реплику из очереди Agent'а — иначе она всё равно внедрится.
    removePendingSteer(chatId, steerId)
    void window.syntee.chat.steerCancel(chatId, steerId)
  }, [chatId, steerId])
  const handleCopy = useCallback(() => {
    const text = stripAttachTokens(step.content).trim() || step.content.trim()
    if (!text) return
    void copyToClipboard(text).then(ok => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }, [step.content])
  // Мета вложений — чипы/миниатюры на местах [[attach:id]]-токенов, как в
  // user-сообщении. renderInlineAttachments читает только id/kind/name/path,
  // поэтому SteerAttachmentMeta структурно достаточен.
  const steeredAtts = (step.attachments?.length ? step.attachments : undefined) as Attachment[] | undefined
  return (
    <motion.div
      className={`tc2-steer${applied ? ' tc2-steer--applied' : ' tc2-steer--pending'}`}
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 460, damping: 32 }}
    >
      <div className="tc2-rail">
        <div className={`tc2-dot ${applied ? 'tc2-dot--steer' : 'tc2-dot--steer-pending'}`}>
          <AppIcon name="zap" size="xs" />
        </div>
      </div>
      <div className="tc2-iter-body tc2-steer-body">
        <div className="tc2-steer-head">
          <span className="tc2-steer-label">Вы — во время работы</span>
          <span className={`tc2-steer-state${applied ? ' tc2-steer-state--applied' : ''}`}>
            {applied ? 'внедрено в контекст' : 'ждёт границы раунда'}
          </span>
          <button
            className={`tc2-steer-copy${canCancel ? '' : ' tc2-steer-copy--end'}`}
            onClick={handleCopy}
            title="Скопировать текст реплики"
            aria-label="Скопировать текст реплики"
          >
            <AppIcon name={copied ? 'check' : 'copy'} size="xs" />
          </button>
          {canCancel && (
            <button
              className="tc2-steer-cancel"
              onClick={handleCancel}
              title="Отменить: реплика не попадёт в контекст агента"
              aria-label="Отменить внедрение реплики"
            >
              <AppIcon name="x" size="xs" />
            </button>
          )}
        </div>
        <div className="tc2-steer-text">
          {steeredAtts
            ? renderInlineAttachments(step.content, steeredAtts)
            // Меты нет, а токены есть (старые данные / гонка restore) —
            // показываем чистый текст, без служебных [[attach:id]].
            : step.content.includes('[[attach:') ? stripAttachTokens(step.content) : step.content}
        </div>
      </div>
    </motion.div>
  )
}, (prev, next) => prev.step === next.step && prev.chatId === next.chatId)

const ASSISTANT_SOURCE_META: Record<string, { label: string; color: string; icon: string }> = {
  memory: { label: 'Watcher · память', color: '#818cf8', icon: 'sparkles' },
  skill: { label: 'Watcher · скилл', color: '#818cf8', icon: 'sparkles' },
  capability: { label: 'Watcher · возможность', color: '#818cf8', icon: 'sparkles' },
  constitution: { label: 'Конституция · ограничения', color: '#f472b6', icon: 'shield' },
  briefing: { label: 'Briefing · состояние проекта', color: '#38bdf8', icon: 'brain' },
  navigator: { label: 'Navigator · курс на цель', color: '#a78bfa', icon: 'compass' },
  archivist: { label: 'Archivist · память', color: '#34d399', icon: 'archive' },
}

const AssistantCard = memo(function AssistantCard({ step, isRunning, animateEntrance }: {
  step: ToolStep
  isRunning: boolean
  animateEntrance: boolean
}) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const [working, setWorking] = useState(false)
  const isHint = step.type === 'hint'
  const meta = ASSISTANT_SOURCE_META[step.hintSource ?? 'memory'] ?? ASSISTANT_SOURCE_META.memory
  const color = isHint ? meta.color : '#4ade80'
  const icon = isHint ? meta.icon : 'filter'

  useEffect(() => {
    if (!isRunning) return
    setWorking(true)
    const t = setTimeout(() => setWorking(false), 700)
    return () => clearTimeout(t)
  }, [isRunning, step.id])

  const title = isHint ? meta.label : 'Janitor · оптимизация контекста'
  const briefing = step.hintSource === 'briefing'
  const content = briefing && step.content.startsWith(BRIEFING_MARKER)
    ? step.content.slice(BRIEFING_MARKER.length).trim() : step.content
  const preview = isHint
    ? briefing ? (open ? 'Свернуть брифинг' : 'Открыть брифинг') : content.replace(/\s+/g, ' ').slice(0, 80)
    : `${step.janitorActions?.length ?? 1} действ.${step.janitorTokensSaved ? ` · −${step.janitorTokensSaved} tok` : ''}`

  return (
    <div className={`tc2-iter${animateEntrance ? ' tc2-iter--enter' : ''}`}>
      <div className="tc2-rail">
        <div
          className={`tc2-dot ${working ? 'tc2-dot--pulse' : 'tc2-dot--done'}`}
          style={{ '--dot-color': color } as React.CSSProperties}
        >
          {working ? <AppIcon name={icon as 'zap'} size="xs" /> : (
            <svg className="tc2-dot-check" viewBox="0 0 16 16" fill="none">
              <path d="M3.5 8.5l3 3L12.5 5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      </div>
      <div className="tc2-iter-body">
        <button type="button" aria-expanded={open} aria-controls={detailsId} className={`tc2-iter-header ${open ? 'tc2-iter-header--open' : ''}`} onClick={() => setOpen(v => !v)}>
          <span className="tc2-iter-icon" style={{ color }}><AppIcon name={icon as 'zap'} size="sm" /></span>
          <span className="tc2-iter-name" style={{ color }}>{title}</span>
          <span className="tc2-iter-preview">{working ? 'Анализирую…' : preview}</span>
          <AppIcon name={open ? "chevronUp" : "chevronDown"} size="xs" tone="muted" />
          {!isHint && step.janitorTokensSaved ? <span className="tc2-assistant-badge">−{step.janitorTokensSaved} tok</span> : null}
        </button>
        {open && (
          <div id={detailsId} className="tc2-assistant-body">
            {isHint ? (
              <div className="tc2-assistant-text">
                {briefing ? (
                  <div className="tc2-briefing-section">
                    <ReactMarkdown skipHtml disallowedElements={['a', 'img']} unwrapDisallowed>
                      {content}
                    </ReactMarkdown>
                  </div>
                ) : <p>{content}</p>}
              </div>
            ) : (
              <ul className="tc2-assistant-actions">
                {(step.janitorActions ?? [{ kind: step.janitorKind ?? '', description: step.content, tokensSaved: step.janitorTokensSaved ?? 0 }]).map((a, i) => (
                  <li key={i}>
                    <span className="tc2-assistant-action-desc">{a.description}</span>
                    {a.tokensSaved ? <span className="tc2-assistant-badge">−{a.tokensSaved}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

function codeTraceArgs(value: unknown): string {
  let parsed = value
  if (typeof parsed === 'string') {
    const rawText = parsed
    try { parsed = JSON.parse(rawText) } catch { return rawText.slice(0, 400) }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return Object.entries(parsed as Record<string, unknown>)
      .map(([key, val]) => {
        let text: string
        try { text = typeof val === 'string' ? val : JSON.stringify(val) ?? String(val) }
        catch { text = String(val) }
        return `${key}: ${text}`
      })
      .join(' · ')
      .slice(0, 500)
  }
  try { return JSON.stringify(parsed) ?? String(parsed) } catch { return String(parsed) }
}

function codeTraceSummary(trace: NonNullable<ToolStep['codeMode']>['trace']): string {
  if (!trace?.length) return 'Внутренние вызовы не записаны'
  const counts = new Map<string, number>()
  for (const entry of trace) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1)
  const tools = [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name)
  const failed = trace.filter(entry => entry.status === 'failure').length
  return `${trace.length} вызов${trace.length === 1 ? '' : trace.length < 5 ? 'а' : 'ов'}: ${tools.join(', ')}${failed ? ` · ошибок: ${failed}` : ''}`
}

// ── Внутренние вызовы execute_code ───────────────────────────────────────
// Раньше это был отдельный «журнал»: фиолетовая полоса слева, сырой mono-текст,
// собственные карточки — карточка скрипта выглядела чужеродно рядом с обычными
// тулами. Теперь внутренние вызовы — те же строки, что у тулов (иконка, название,
// превью аргумента/файла, ✓/✗), а их вывод рендерится тем же ToolResultRenderer.

interface TraceEntry {
  id?: string
  name: string
  args: unknown
  result: string
  /** 'running' — вызов ещё выполняется (живой трейс execute_code). */
  status: 'success' | 'failure' | 'running'
  /** unified diff правки — в ленте он и есть вывод edit_file/write_file. */
  diff?: string
}

/** Аргументы вложенного вызова как объект (в трейсе они приходят JSON-строкой). */
function traceArgsObject(args: unknown): Record<string, unknown> {
  return asArgsObject(args)
}

/** Путь файла из аргументов вложенного вызова — чтобы рисовать плашку файла. */
function traceFilePath(args: unknown): string {
  const a = traceArgsObject(args)
  const single = a.path ?? a.file_path ?? a.filePath
  if (typeof single === 'string' && single) return single
  const list = Array.isArray(a.paths) ? a.paths : []
  return (list.find(x => typeof x === 'string') as string | undefined) ?? ''
}

// Строка вложенного вызова — span'ы, чтобы её можно было положить внутрь
// кнопки-заголовка карточки (в button блочные div'ы невалидны).
const TraceRow = memo(function TraceRow({ entry }: { entry: TraceEntry }) {
  const meta = getToolMeta(entry.name)
  const path = traceFilePath(entry.args)
  const argsText = codeTraceArgs(entry.args) || 'без аргументов'
  // Счётчики правки — как в шапке обычной карточки edit_file. Если в трейсе
  // diff нет (старые записи), он собирается из аргументов вызова.
  const diff = entry.diff ?? synthesizeDiffFromArgs(entry.name, traceArgsObject(entry.args))
  const stat = diff ? countDiffLines(diff) : null
  // У этих тулов path — всегда каталог; для search_code решает сам путь
  // (папка без расширения / файл с расширением).
  const pathIsDir = entry.name === 'list_directory' || entry.name === 'find_files'
  const status = entry.status === 'success' ? '✓' : entry.status === 'running' ? '●' : '✗'
  return (
    <span className={`tc2-trace-row${entry.status === 'failure' ? ' tc2-trace-row--fail' : ''}${entry.status === 'running' ? ' tc2-trace-row--run' : ''}`}>
      <span className="tc2-trace-icon" style={{ color: meta.color }}>
        <AppIcon name={meta.icon as 'zap'} size="xs" />
      </span>
      <span className="tc2-trace-label">{meta.label}</span>
      <span className="tc2-trace-preview" title={argsText}>
        {path
          ? <FileChip path={path} showDir={false} isDir={pathIsDir || undefined} added={stat ? stat.adds : undefined} deleted={stat ? stat.dels : undefined} />
          : argsText}
      </span>
      <span className={`tc2-trace-status${entry.status === 'running' ? ' tc2-trace-status--run' : ''}`}>{status}</span>
    </span>
  )
}, (prev, next) => prev.entry === next.entry)

/** Вложенный вызов в раскрытом виде — обычная тул-карточка: заголовок
 *  раскрывает вывод, как у тулов ленты (закрыто по умолчанию). */
const TraceCard = memo(function TraceCard({ entry, mode }: {
  entry: TraceEntry
  mode: ToolOutputMode
}) {
  const [open, setOpen] = useState(false)
  // Настоящий diff из трейса, а для старых записей — собранный из аргументов.
  const diff = entry.diff ?? synthesizeDiffFromArgs(entry.name, traceArgsObject(entry.args))
  const hasBody = Boolean(diff || entry.result?.trim())
  return (
    <div className={`tc2-trace-card${entry.status === 'failure' ? ' tc2-trace-card--fail' : ''}${open ? ' tc2-trace-card--open' : ''}`}>
      <button
        type="button"
        className="tc2-trace-card-head"
        onClick={() => { if (hasBody) setOpen(value => !value) }}
        aria-expanded={open}
      >
        <TraceRow entry={entry} />
        {hasBody && <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="xs" />}
      </button>
      <AnimatePresence initial={false}>
        {open && hasBody && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: 0.16, ease: 'easeOut' },
            }}
            style={{ overflow: 'hidden' }}
          >
            <div className="tc2-trace-body">
              {diff ? (
                <DiffBlock
                  diff={diff}
                  path={traceFilePath(entry.args)}
                  isFail={entry.status === 'failure'}
                />
              ) : (
                <ToolResultRenderer
                  call={{ toolName: entry.name, toolArgs: traceArgsObject(entry.args) }}
                  result={{ content: entry.result, success: entry.status === 'success' }}
                  mode={mode}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}, (prev, next) => prev.entry === next.entry && prev.mode === next.mode)

function CodeModeSummary({ trace, onExpand }: {
  trace: NonNullable<ToolStep['codeMode']>['trace']
  onExpand?: () => void
}) {
  if (!trace?.length) return null
  // Пока скрипт выполняется — показываем ПОСЛЕДНИЕ вызовы (видно, что идёт
  // прямо сейчас); в завершённом виде — первые, как раньше.
  const running = trace.some(entry => entry.status === 'running')
  const shown = running ? trace.slice(-3) : trace.slice(0, 3)
  const rest = trace.length - shown.length
  return (
    <div className="tc2-trace-list">
      {shown.map((entry, index) => (
        <TraceRow key={`${entry.name}-${index}`} entry={entry} />
      ))}
      {rest > 0 && (
        <button type="button" className="tc2-trace-more" onClick={onExpand}>
          <span>ещё {rest} вызовов — раскрыть</span>
          <AppIcon name="chevronDown" size="xs" />
        </button>
      )}
    </div>
  )
}

function CodeModeDetails({ details, mode }: {
  details: NonNullable<ToolStep['codeMode']>
  mode: ToolOutputMode
}) {
  const trace = details.trace ?? []
  return (
    <div className="tc2-trace">
      {trace.length > 0 ? (
        <div className="tc2-trace-cards">
          {trace.map((entry, index) => (
            <TraceCard key={`${entry.name}-${index}`} entry={entry} mode={mode} />
          ))}
        </div>
      ) : (
        <div className="tc2-trace-empty">Внутренние вызовы не записаны</div>
      )}

      {/* Сам скрипт — та же «поверхность» кода, что у read_file/diff. */}
      <CodeSurface
        code={details.code}
        lang="typescript"
        title="Скрипт TypeScript"
        initialLines={mode === 'detailed' ? 500 : 60}
      />
    </div>
  )
}

// ANSI-стрипинг для renderer (нельзя импортировать из _shared.ts — там Node-зависимости).
// Та же логика что stripAnsi в core/tools/_shared.ts.
function stripAnsiRenderer(text: string): string {
  if (!text) return text
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/[\b]/g, '')
}

// ── Live-вывод команды пока она выполняется ──────────────────────────
// Подписывается на pty:data для sessionId, стримит plain-text (ANSI стрипнут,
// маркер __SYNTEE_DONE вырезан) в <pre> с авто-скроллом. rAF-throttle чтобы
// не ре-рендерить на каждый чанк. Buffer capped 50KB (хвост) — иначе длинный
// вывод (npm install) раздул бы DOM.
const LiveCommandOutput = memo(function LiveCommandOutput({ sessionId, command }: {
  sessionId?: string
  command: string
}) {
  const [output, setOutput] = useState('')
  const bufRef = useRef('')
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef(false)
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!sessionId) return
    bufRef.current = ''
    setOutput('')
    const off = window.syntee.on('pty:data', (sid: unknown, data: unknown) => {
      if (sid !== sessionId) return
      const chunk = typeof data === 'string' ? data : ''
      if (!chunk) return
      // ANSI + маркер-огрызки
      const clean = stripAnsiRenderer(chunk)
        .replace(/__SYNTEE_DONE_[a-f0-9]+:\d+\s*$/m, '')
      bufRef.current += clean
      // Cap 50KB — оставляем хвост (самое свежее)
      if (bufRef.current.length > 50000) {
        bufRef.current = bufRef.current.slice(-50000)
      }
      if (!pendingRef.current) {
        pendingRef.current = true
        rafRef.current = requestAnimationFrame(() => {
          pendingRef.current = false
          setOutput(bufRef.current)
        })
      }
    })
    return () => {
      off()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [sessionId])

  // Авто-скролл вниз при обновлении — только если пользователь и так у низа.
  // Раньше скроллили всегда: чтение середины вывода отрывалось потоком, а
  // каждый scrollTop=scrollHeight форсил синхронный layout 50KB-<pre> на
  // каждый rAF-апдейт → джанк во время долгих команд.
  useEffect(() => {
    const pre = preRef.current
    if (!pre) return
    const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48
    if (nearBottom) pre.scrollTop = pre.scrollHeight
  }, [output])

  // Одна и та же карточка, что и у завершённой команды: команда сверху,
  // потоковый вывод ниже — без отдельного блока «Вывод».
  return (
    <div className="trr-term">
      <div className="trr-term-cmd">
        <span className="trr-term-prompt">$</span>
        <code className="trr-term-cmd-text">{command || '(команда не записана)'}</code>
        {command && <CopyCommandButton value={command} />}
      </div>
      <pre ref={preRef} className="trr-term-out">{output || 'ожидание вывода…'}</pre>
    </div>
  )
}, (prev, next) => prev.sessionId === next.sessionId && prev.command === next.command)

/** Копирование команды прямо из живой карточки (без импорта рендера результата). */
const CopyCommandButton = memo(function CopyCommandButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="trr-copy-btn"
      title="Копировать команду"
      onClick={() => {
        void copyToClipboard(value).then(ok => {
          if (!ok) return
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? '✓' : 'Копировать'}
    </button>
  )
}, (prev, next) => prev.value === next.value)

// Цветной diff блок. memo + чанкование: большие diff'ы (тысячи строк) раньше
// монтировали div на КАЖДУЮ строку при раскрытии итерации → фриз. Теперь
// первые DIFF_CHUNK строк + кнопка «Показать ещё».
const DIFF_CHUNK = 500
const DiffBlock = memo(function DiffBlock({ diff, path, isFail }: {
  diff: string
  path?: string
  isFail?: boolean
}) {
  const [extra, setExtra] = useState(0)
  const visible = DIFF_CHUNK + extra
  const lines = diff.split('\n').filter((_, i, arr) => {
    // Убираем пустую последнюю строку
    return !(i === arr.length - 1 && arr[i] === '')
  })
  const shown = lines.slice(0, visible)
  // Счётчики как в шапке карточки правки: +добавлено / −удалено.
  // countDiffLines — ЕДИНЫЙ парсер (shared/fileChanges.ts): тот же, что у
  // бейджа над инпутом, «Сессии» и чипов сообщения — одна логика, не копия.
  const { adds: added, dels: removed } = countDiffLines(diff)
  return (
    <div className={`tc2-diff${isFail ? ' tc2-diff--fail' : ''}`}>
      <div className="tc2-diff-head">
        {/* Синтетический diff без пути (write_file целиком) — без лишней плашки файла. */}
        {path ? <FileChip path={path} added={added} deleted={removed} /> : <span className="tc2-diff-title">изменения</span>}
      </div>
      <div className="tc2-diff-pre">
        {shown.map((line, i) => {
          let cls = 'tc2-diff-line'
          if (line.startsWith('+++') || line.startsWith('---')) cls += ' tc2-diff-meta'
          else if (line.startsWith('+')) cls += ' tc2-diff-add'
          else if (line.startsWith('-')) cls += ' tc2-diff-del'
          else if (line.startsWith('@@')) cls += ' tc2-diff-hunk'
          else cls += ' tc2-diff-ctx'
          return <div key={i} className={cls}>{line || '\u00a0'}</div>
        })}
        {lines.length > visible && (
          <button className="tc2-show-more" onClick={() => setExtra(e => e + DIFF_CHUNK)}>
            Показать ещё {Math.min(DIFF_CHUNK, lines.length - visible)} из {lines.length} строк
          </button>
        )}
      </div>
    </div>
  )
}, (prev, next) => prev.diff === next.diff && prev.path === next.path && prev.isFail === next.isFail)

// Один блок итерации
const IterationBlock = memo(function IterationBlock({
  iter, isLast, isRunning, mode, liveSessionId, animateEntrance,
}: {
  iter: Iteration
  isLast: boolean
  isRunning: boolean
  mode: ToolOutputMode
  liveSessionId?: string
  // Entrance-анимация только у последнего (нового) шага живой ленты.
  // Раньше флаг стоял у всех и каскадная задержка index*0.04 давала до 4с
  // «пустоты» при раскрытии длинной цепочки, а смена флага перезапускала
  // анимацию у всех шагов разом.
  animateEntrance: boolean
  // Тулы закрыты по умолчанию; раскрытие — только по клику.
}) {
  const remeasure = useChatRemeasure()
  const meta = getToolMeta(iter.call.toolName, iter.call.serverName)
  const failed = iter.result?.success === false
  // pending — модель ещё генерирует аргументы этого вызова (см. Agent.ts
  // tool_call_pending). Отличаем от "running" (тул реально исполняется в
  // Node), чтобы показать корректный текст, но визуально это тот же
  // "идёт работа, не зависло" индикатор.
  const pending = !!iter.call.pending
  // Раньше проверяли isLast — но при параллельных тулах (Promise.all в Agent.ts)
  // одновременно создаётся несколько итераций без результата, и спиннер/бейдж
  // показывался только у последней. Теперь "выполняется" — у любого тула без
  // результата, пока идёт живой стрим, независимо от позиции.
  const running = isRunning && !iter.result && !pending

  // Native analyze_image lifecycle: результат тула (handoff пикселей) уже есть,
  // но визуальный ответ основной модели ещё идёт / пришёл / не удался.
  const vaStatus = iter.result?.visualAnalysis?.status
  const vaFindings = iter.result?.visualAnalysis?.findings
  const vaPending = vaStatus === 'pending'
  const vaFailed = vaStatus === 'failed'
  // «Модель анализирует» — только при живом стриме; зависит от isRunning, а НЕ
  // от isLast (параллельные тулы). Персистентный pending (Стоп/ошибка) = прерван.
  const analyzing = vaPending && isRunning
  const analysisInterrupted = vaPending && !isRunning
  // Незавершённый/неудачный визуальный анализ — вместо зелёной галочки.
  const vaUnresolved = vaPending || vaFailed

  // ── Раскрытие тела: закрыто по умолчанию ─────────────────────────────
  // Карточки остаются компактными; содержимое открывается только по клику.
  const [open, setOpen] = useState(false)
  const userToggledRef = useRef(false)
  const toggleOpen = useCallback(() => {
    userToggledRef.current = true
    setOpen(value => !value)
  }, [])

  // run_command: пока команда выполняется, её текст должен быть виден целиком,
  // а вывод — доезжать в той же карточке. Раскрываем сами; закрываем обратно,
  // только если пользователь карточку не трогал.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (iter.call.toolName !== 'run_command') return
    if (running && !userToggledRef.current) {
      autoOpenedRef.current = true
      setOpen(true)
    } else if (!running && autoOpenedRef.current && !userToggledRef.current) {
      autoOpenedRef.current = false
      setOpen(false)
    }
  }, [running, iter.call.toolName])

  // НЕТ авто-раскрытия при сбое: в больших чатах failed-итерации при скролле
  // монтировали полные тела (подсветка/diff) → фризы. Ошибка видна по бейджу
  // «ошибка» в заголовке — раскрытие по клику. (Во время live-прогона тело
  // и так уже раскрыто эффектом выше, так что ошибку видно сразу.)

  const statusColor = (failed || vaFailed) ? '#f87171' : meta.color

  // Высота анимируется до auto: фиксированный maxHeight обрезал длинные
  // результаты, а переключение режима heavy во время стрима могло оставить
  // тело с промежуточной высотой. Внутренний contain изолирует тяжёлый paint.

  // Preview в свёрнутом заголовке: для run_command берём именно args.command
  // (первое значение args может быть другим ключом), title показывает полный
  // текст — раньше команду было не видно нигде: preview обрезан 80 символами,
  // а в раскрытом теле аргументы показывались только в detailed-режиме.
  // Счётчики правки прямо в свёрнутой карточке: видно, что изменилось и
  // насколько, без раскрытия diff.
  const diffStats = useMemo(() => {
    const d = iter.result?.diff
    if (!d) return null
    // Единый парсер (shared/fileChanges.ts) — как у бейджа, «Сессии» и чипов.
    const { adds, dels } = countDiffLines(d)
    return { added: adds, removed: dels }
  }, [iter.result?.diff])

  // Файловые тулы показывают в свёрнутой шапке не сырой путь, а плашку файла
  // ([JS] inspect-chat.mjs) — как в примере; для правок с +N −M.
  const isFileTool = iter.call.toolName === 'read_file' || iter.call.toolName === 'read_files'
    || iter.call.toolName === 'edit_file' || iter.call.toolName === 'write_file'
  const filePathsArg = useMemo(() => {
    const a = iter.call.toolArgs ?? {}
    const single = a.path ?? a.file_path ?? a.filePath
    if (typeof single === 'string' && single) return [single]
    const list = Array.isArray(a.paths) ? a.paths : []
    return list.filter((x): x is string => typeof x === 'string' && !!x)
  }, [iter.call.toolArgs])
  const filePathArg = filePathsArg[0] ?? ''
  const extraFiles = Math.max(0, filePathsArg.length - 1)

  // Живой трейс execute_code лежит на шаге ВЫЗОВА (результата ещё нет),
  // финальный — на шаге результата. Берём то, что есть, иначе во время
  // выполнения скрипта карточка не показывала вложенные тулы вообще.
  const codeMode = iter.result?.codeMode ?? iter.call.codeMode

  const previewText = iter.call.toolName === 'execute_code'
    ? codeMode
      ? codeTraceSummary(codeMode.trace)
      : running ? 'Выполняется TypeScript-скрипт' : 'TypeScript-скрипт'
    : iter.call.toolName === 'run_command'
      ? String(iter.call.toolArgs?.command ?? Object.values(iter.call.toolArgs ?? {})[0] ?? '')
      : String(Object.values(iter.call.toolArgs ?? {})[0] ?? '')

  return (
    <div
      className={`tc2-iter${animateEntrance ? ' tc2-iter--enter' : ''}`}
    >
      <div className="tc2-rail">
        <div
          className={`tc2-dot ${(running || pending || analyzing) ? 'tc2-dot--pulse' : ''} ${iter.result ? ((failed || vaFailed) ? 'tc2-dot--fail' : vaUnresolved ? '' : 'tc2-dot--done') : ''}`}
          style={{ '--dot-color': statusColor } as React.CSSProperties}
        >
          {vaUnresolved ? (
            // Результат-хендофф уже есть, но визуальный анализ не завершён —
            // глаз вместо зелёной галочки (пульс — только при живом стриме).
            <AppIcon name="eye" size="xs" />
          ) : iter.result && !failed ? (
            <svg className="tc2-dot-check" viewBox="0 0 16 16" fill="none">
              <path d="M3.5 8.5l3 3L12.5 5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : iter.result && failed ? (
            <svg className="tc2-dot-cross" viewBox="0 0 16 16" fill="none">
              <path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          ) : (
            <AppIcon name={meta.icon as 'zap'} size="xs" />
          )}
        </div>
        {!isLast && (
          <div className={`tc2-rail-line ${(failed || vaFailed) ? 'tc2-rail-line--fail' : iter.result && !vaUnresolved ? 'tc2-rail-line--ok' : ''}`} />
        )}
      </div>

      <div className="tc2-iter-body">
        <button
          className={`tc2-iter-header ${open ? 'tc2-iter-header--open' : ''} ${failed ? 'tc2-iter-header--fail' : ''} ${(running || pending || analyzing) ? 'tc2-iter-header--running' : ''}`}
          onClick={toggleOpen}
        >
          <span className="tc2-iter-icon" style={{ color: meta.color }}>
            <AppIcon name={meta.icon as 'zap'} size="sm" />
          </span>
          <span className="tc2-iter-label">{meta.label}</span>
          {meta.isMcp && meta.server && (
            <span className="tc2-iter-server">{meta.server}</span>
          )}
          {iter.call.toolName && !meta.isMcp && !TOOL_META[iter.call.toolName] && (
            <code className="tc2-iter-name" title={iter.call.toolName}>{iter.call.toolName}</code>
          )}
          {iter.call.toolName === 'spawn_agent' && typeof iter.call.toolArgs?.role === 'string' && (
            <span
              className="tc2-iter-role-badge"
              style={{ color: getSubagentRole(iter.call.toolArgs.role as string).color }}
            >
              {getSubagentRole(iter.call.toolArgs.role as string).nameEn}
            </span>
          )}


          {!open && filePathArg && (isFileTool ? (
            <>
              <FileChip
                path={filePathArg}
                added={diffStats?.added}
                deleted={diffStats?.removed}
                showDir={false}
              />
              {extraFiles > 0 && <span className="tc2-iter-files-more">+{extraFiles}</span>}
            </>
          ) : (
            <span className="tc2-iter-preview" title={previewText}>
              {truncate(previewText)}
            </span>
          ))}

          {/* Счётчики живут ВНУТРИ плашки файла (FileChip) — раньше рядом
              рисовался ещё и отдельный diffstat, и цифры дублировались
              («+27 +27»). Отдельный блок нужен только когда плашки нет:
              у правки без пути в аргументах. */}
          {diffStats && (diffStats.added > 0 || diffStats.removed > 0) && !(isFileTool && filePathArg) && (
            <span className="tc2-iter-diffstat" title="Строк добавлено / удалено">
              {diffStats.added > 0 && <span className="tc2-diff-stat-add">+{diffStats.added}</span>}
              {diffStats.removed > 0 && <span className="tc2-diff-stat-del">−{diffStats.removed}</span>}
            </span>
          )}

          <span className="tc2-iter-spacer" />

          {iter.result && iter.call.timestamp && iter.result.timestamp && (
            <span className="tc2-iter-duration">{formatDuration(iter.result.timestamp - iter.call.timestamp)}</span>
          )}

          {meta.isMcp && <span className="tc2-badge tc2-badge--mcp">MCP</span>}
          {pending && <span className="tc2-badge tc2-badge--running">готовится</span>}
          {running && <span className="tc2-badge tc2-badge--running">выполняется</span>}
          {failed && <span className="tc2-badge tc2-badge--fail">ошибка</span>}
          {/* Native analyze_image: pending-результат не «успех» — показываем
              живой анализ / прерванный / не удался вместо зелёной галочки. */}
          {analyzing && <span className="tc2-badge tc2-badge--running">модель анализирует</span>}
          {analysisInterrupted && <span className="tc2-badge tc2-badge--fail">анализ прерван</span>}
          {vaFailed && <span className="tc2-badge tc2-badge--fail">анализ не удался</span>}
          {vaStatus === 'responded' && <span className="tc2-badge tc2-badge--ok">ответ получен</span>}
          {iter.result && !failed && !vaUnresolved && <span className="tc2-badge tc2-badge--ok">✓</span>}

          <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="xs" />
        </button>

        {iter.call.toolName === 'execute_code' && codeMode && !open && mode !== 'compact' && (
          <CodeModeSummary trace={codeMode.trace} onExpand={toggleOpen} />
        )}

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              className="tc2-iter-details"
              initial={{ height: 0, opacity: 0, y: -3 }}
              animate={{ height: 'auto', opacity: 1, y: 0 }}
              exit={{ height: 0, opacity: 0, y: -2 }}
              transition={{
                height: { duration: 0.26, ease: [0.22, 1, 0.36, 1] },
                opacity: { duration: 0.18, ease: 'easeOut' },
                y: { duration: 0.2, ease: 'easeOut' },
              }}
              style={{ overflow: 'hidden' }}
              onAnimationComplete={() => remeasure?.()}
            >


              {/* Пока скрипт выполняется, результата ещё нет — вложенные
                  вызовы показываем из живого трейса шага-вызова. */}
              {!iter.result && codeMode && mode !== 'compact' && (
                <CodeModeDetails details={codeMode} mode={mode} />
              )}

              {iter.result && mode !== 'compact' && (() => {
                if (iter.result.codeMode) {
                  return <CodeModeDetails details={iter.result.codeMode} mode={mode} />
                }
                // ask_user — рендер вопросов и ответов пользователя
                if (iter.call.toolName === 'ask_user' && iter.call.toolArgs?.questions) {
                  const questions = iter.call.toolArgs.questions as Array<{
                    id?: string
                    question: string
                    header?: string
                    type?: string
                    options?: Array<{ label: string; value: string }>
                  }>
                  // Парсим ответы из результата (JSON в конце content)
                  let answers: Array<{
                    id: string
                    values?: string[]
                    text?: string
                    value?: boolean
                  }> = []
                  if (iter.result.success && iter.result.content) {
                    const jsonMatch = iter.result.content.match(/JSON:\s*(\[[\s\S]*\])/)
                    if (jsonMatch) {
                      try { answers = JSON.parse(jsonMatch[1]) } catch { /* skip */ }
                    }
                  }
                  const total = questions.length
                  const resolveType = (q: { type?: string; options?: unknown[] }) =>
                    q.type || (q.options && q.options.length > 0 ? 'choice' : 'text')
                  return (
                    <div className="tc2-section">
                      <div className="tc2-section-title" style={{ color: 'var(--accent, #e8e8ec)' }}>
                        {total > 1 ? `${total} вопроса пользователю` : 'Вопрос пользователю'}
                      </div>
                      <div className="tc2-ask-user">
                        {questions.map((q, qi) => {
                          const ans = answers.find(a => a.id === q.id) || answers[qi]
                          const qType = resolveType(q)
                          return (
                            <div key={qi} className="tc2-ask-q">
                              <div className="tc2-ask-q-num">
                                <AppIcon
                                  name={qType === 'yesno' ? 'check' : 'helpCircle'}
                                  size="xs"
                                />
                              </div>
                              <div className="tc2-ask-q-content">
                                {q.header && <div className="tc2-ask-q-label">{q.header}</div>}
                                <div className="tc2-ask-q-text">{q.question}</div>
                                {q.options && q.options.length > 0 && (
                                  <div className="tc2-ask-q-opts">
                                    {q.options.map(o => {
                                      const isSel = ans?.values?.includes(o.value)
                                      return (
                                        <span
                                          key={o.value}
                                          className={`tc2-ask-q-opt${isSel ? ' tc2-ask-q-opt--selected' : ''}`}
                                        >
                                          {isSel && <span className="tc2-ask-q-opt-check">✓</span>}
                                          {o.label}
                                        </span>
                                      )
                                    })}
                                  </div>
                                )}
                                {/* Ответ пользователя — цветовое выделение, collapse если длинный */}
                                {qType === 'yesno' && ans?.value !== undefined && (
                                  <div className={`tc2-ask-q-answer tc2-ask-q-answer--${ans.value ? 'yes' : 'no'}`}>
                                    <AppIcon name={ans.value ? 'check' : 'x'} size="xs" />
                                    {ans.value ? 'Да' : 'Нет'}
                                  </div>
                                )}
                                {ans?.text && (
                                  <div className={`tc2-ask-q-custom${ans.text.length > 200 ? ' tc2-ask-q-custom--collapsible' : ''}`}>
                                    {ans.text}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                }
                // image — картинка
                if (iter.result.imageUrl) {
                  return (
                    <div className="tc2-section">
                      <div className="tc2-section-title" style={{ color: '#4ade80' }}>Результат</div>
                      <div className="tc2-image-wrap">
                        <img
                          src={`file://${iter.result.imageUrl}`}
                          alt="Результат"
                          className="tc2-image"
                          loading="lazy"
                          decoding="async"
                          onClick={() => window.open(`file://${iter.result!.imageUrl}`, '_blank')}
                        />
                      </div>
                    </div>
                  )
                }
                // diff — единая карточка правки: шапка с путём и +N/−M, тело diff
                if (iter.result.diff) {
                  const isFail = iter.result.success === false
                  const path = String(iter.call.toolArgs?.path ?? iter.call.toolArgs?.file_path ?? '')
                  return <DiffBlock diff={iter.result.diff} path={path} isFail={isFail} />
                }
                // умный рендер через ToolResultRenderer
                return (
                  <ToolResultRenderer
                    call={iter.call}
                    result={iter.result}
                    mode={mode}
                  />
                )
              })()}

              {/* Native analyze_image: визуальный анализ — отдельно от исходного
                  содержимого-хендоффа (его НЕ перезаписываем). */}
              {iter.result && mode !== 'compact' && analyzing && (
                <div className="tc2-section tc2-section--running">
                  <span className="tc2-spinner" />
                  <span className="tc2-running-text">Модель анализирует изображение…</span>
                </div>
              )}

              {iter.result && mode !== 'compact' && analysisInterrupted && (
                <div className="tc2-section">
                  <div className="tc2-section-title" style={{ color: '#fbbf24' }}>Анализ прерван</div>
                  <div className="tc2-running-text">
                    Визуальный анализ не завершён — прогон остановлен или прерван.
                  </div>
                </div>
              )}

              {iter.result && mode !== 'compact' && vaFailed && (
                <div className="tc2-section">
                  <div className="tc2-section-title" style={{ color: '#f87171' }}>Анализ не удался</div>
                  <div className="tc2-running-text">
                    {vaFindings || 'Визуальный анализ не дал результата. Изображение загружено, но ответ модели не получен.'}
                  </div>
                </div>
              )}

              {iter.result && mode !== 'compact' && vaStatus === 'responded' && vaFindings && (
                <div className="tc2-section">
                  <div className="tc2-section-title" style={{ color: '#60a5fa' }}>Ответ модели после получения изображения</div>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                    {vaFindings}
                  </div>
                </div>
              )}

              {pending && (
                <div className="tc2-section tc2-section--running">
                  <span className="tc2-spinner" />
                  <span className="tc2-running-text">Готовится вызов…</span>
                </div>
              )}

              {running && (
                <>
                  {/* run_command: команда + потоковый вывод в одной карточке —
                      ровно та же вёрстка, что придёт вместе с результатом. */}
                  {iter.call.toolName === 'run_command' ? (
                    <LiveCommandOutput
                      sessionId={liveSessionId}
                      command={String(iter.call.toolArgs?.command ?? '')}
                    />
                  ) : (
                    <div className="tc2-section tc2-section--running">
                      <span className="tc2-spinner" />
                      <span className="tc2-running-text">Выполняется…</span>
                    </div>
                  )}
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}, (prev, next) => prev.iter === next.iter && prev.isLast === next.isLast &&
  prev.isRunning === next.isRunning && prev.mode === next.mode &&
  prev.liveSessionId === next.liveSessionId && prev.animateEntrance === next.animateEntrance)

// Сколько итераций показываем при раскрытии цепочки и шаг догрузки.
const ITERS_PAGE = 15
const ITERS_CHUNK = 10

// ── Живая шапка с тикающим таймером ─────────────────────────────────
// Вынесена в отдельный memo-компонент: setInterval 1s ре-рендерит только
// шапку, а не всю цепочку (десятки IterationBlock).
const LiveHeader = memo(function LiveHeader({
  currentTool, currentArg, startTime,
}: {
  currentTool: string
  currentArg: string
  startTime: number
}) {
  const [liveElapsed, setLiveElapsed] = useState(0)
  useEffect(() => {
    setLiveElapsed(Date.now() - startTime)
    const id = setInterval(() => setLiveElapsed(Date.now() - startTime), 1000)
    return () => clearInterval(id)
  }, [startTime])

  const elapsedStr = liveElapsed >= 60000
    ? `${Math.floor(liveElapsed / 60000)}м ${Math.round((liveElapsed % 60000) / 1000)}с`
    : liveElapsed >= 1000
      ? `${(liveElapsed / 1000).toFixed(0)}с`
      : `${liveElapsed}мс`

  return (
    <>
      <span className="tc2-spinner" />
      {/* key по имени тула: при смене действия строка плавно проявляется
          (CSS-анимация fade+slide), а не мигает пустотой между шагами. */}
      <span key={currentTool} className="tc2-header-title tc2-live-title">{currentTool}</span>
      {currentArg && <code className="tc2-header-current-arg">{currentArg}</code>}
      <span className="tc2-elapsed tc2-elapsed--live">{elapsedStr}</span>
    </>
  )
})

// ── Группа повторяющихся тулов ──────────────────────────────────────
// Схлопывает N одинаковых итераций в одну раскрывающуюся строку.
const GroupBlock = memo(function GroupBlock({
  group, mode, animateEntrance,
}: {
  group: { type: 'group'; meta: ReturnType<typeof getToolMeta>; iters: Iteration[] }
  mode: ToolOutputMode
  animateEntrance: boolean
}) {
  const [open, setOpen] = useState(false)
  const remeasure = useChatRemeasure()
  const { meta, iters } = group
  const hasFailed = iters.some(i => i.result?.success === false)
  const totalDur = iters.reduce((sum, i) => {
    if (i.result && i.call.timestamp && i.result.timestamp)
      return sum + (i.result.timestamp - i.call.timestamp)
    return sum
  }, 0)

  return (
    <div
      className={`tc2-iter tc2-iter--group${animateEntrance ? ' tc2-iter--enter' : ''}`}
    >
      <div className="tc2-rail">
        <div
          className="tc2-dot tc2-dot--group"
          style={{ '--dot-color': meta.color } as React.CSSProperties}
        >
          <AppIcon name={meta.icon as 'zap'} size="xs" />
        </div>
      </div>
      <div className="tc2-iter-body">
        <button
          className={`tc2-iter-header tc2-group-header ${open ? 'tc2-iter-header--open' : ''} ${hasFailed ? 'tc2-iter-header--fail' : ''}`}
          onClick={() => setOpen(o => !o)}
        >
          <span className="tc2-iter-label">{meta.label}</span>
          <span className="tc2-group-count">×{iters.length}</span>
          <span className="tc2-iter-spacer" />
          {totalDur > 0 && <span className="tc2-iter-duration">{formatDuration(totalDur)}</span>}
          {hasFailed
            ? <span className="tc2-badge tc2-badge--fail">ошибка</span>
            : <span className="tc2-badge tc2-badge--ok">✓</span>
          }
          <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="xs" />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              className="tc2-group-iters"
              initial={{ height: 0, opacity: 0, y: -3 }}
              animate={{ height: 'auto', opacity: 1, y: 0 }}
              exit={{ height: 0, opacity: 0, y: -2 }}
              transition={{
                height: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
                opacity: { duration: 0.18, ease: 'easeOut' },
                y: { duration: 0.2, ease: 'easeOut' },
              }}
              style={{ overflow: 'hidden' }}
              onAnimationComplete={() => remeasure?.()}
            >
              {iters.map((iter, i) => (
                <IterationBlock
                  key={iter.id}
                  iter={iter}
                  isLast={i === iters.length - 1}
                  isRunning={false}
                  mode={mode}
                  animateEntrance={false}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
})

// ── Чипы тулов в шапке + portal-tooltip ─────────────────────────────
// CSS ::after tooltip обрезался всеми overflow:hidden родителями
// (.tc2, .chat-body, .chat-scroll и т.д.). Portal в document.body
// полностью обходит все overflow-клипперы.
const ToolChips = memo(function ToolChips({
  chipGroups, isRunning, toolsStr,
}: {
  chipGroups: { meta: ReturnType<typeof getToolMeta>; count: number; toolName?: string }[]
  isRunning: boolean
  toolsStr: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  const show = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(() => {
      if (!wrapRef.current) return
      const r = wrapRef.current.getBoundingClientRect()
      setPos({ top: r.bottom + 6, left: r.right })
      setHovered(true)
    }, 120)
  }, [])

  const hide = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null }
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setHovered(false), 200)
  }, [])

  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  return (
    <>
      <div
        ref={wrapRef}
        className="tc2-header-chips"
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        {chipGroups.map(({ meta, count, toolName }, i) => (
          <span
            key={toolName ?? i}
            className="tc2-mini-chip"
            style={{ background: meta.color + '22', color: meta.color }}
          >
            <AppIcon name={meta.icon as 'zap'} size="xs" />
            {count > 1 && <span className="tc2-mini-chip-count">{count}</span>}
          </span>
        ))}
        {isRunning && <span className="tc2-mini-chip tc2-mini-chip--pulse">···</span>}
      </div>
      {createPortal(
        <AnimatePresence>
          {hovered && pos && (
            <motion.div
              className="tc2-chips-tooltip"
              style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 99999 }}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              onMouseEnter={show}
              onMouseLeave={hide}
            >
              {toolsStr}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}, (prev, next) =>
  prev.chipGroups === next.chipGroups &&
  prev.isRunning === next.isRunning &&
  prev.toolsStr === next.toolsStr,
)

const ToolChain = memo(function ToolChain({ steps, sections, mode, isRunning, busy, label, elapsed, summary, toolProgress, thinkingText, thinkingMs, liveThinking, chatId, workdir, renderIterExtra }: {
  steps?: ToolStep[]
  /** Полная лента сообщения: итерации с их рассуждениями. Приоритетнее steps. */
  sections?: ToolChainSection[]
  mode: ToolOutputMode
  isRunning: boolean
  /** §steer — chatId сообщения: нужен для крестика отмены pending-реплики. */
  chatId?: string
  /** Рабочая директория чата — чтобы пути в тексте хода работы были
   *  кликабельными, как в обычном сообщении. */
  workdir?: string
  /** Прогон ещё идёт, но тулы сейчас не выполняются (агент пишет ответ).
   *  Пока busy — блок не сворачивается сам: пользователь видит ход работы
   *  до самого конца, а не «мигание» на финальном тексте. */
  busy?: boolean
  label?: string
  elapsed?: number   // ms — время выполнения для финального блока
  summary?: boolean  // если true — компактный финальный блок
  toolProgress?: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
  /** Рассуждение итерации (для одиночной цепочки без sections). */
  thinkingText?: string
  thinkingMs?: number
  /** Текущее стримящееся рассуждение — последней строкой ленты (isLive). */
  liveThinking?: { isLive: boolean; ms?: number; storeChatId?: string }
  /** Дополнительный контент под конкретной итерацией (внутри ленты):
   *  карточка саб-агента и т.п. Раньше такие блоки
   *  рендерились снаружи, рядом с плашкой, и разрывали «ход работы».
   *  iter — именно эта итерация (call+result): решение, рисовать ли блок,
   *  принимается по её шагу, иначе карточка дублировалась бы под каждым
   *  шагом секции. isLastSection — последняя ли секция сообщения
   *  (для live-прогресса долгих тулов). */
  renderIterExtra?: (iter: { call: ToolStep; result?: ToolStep }, isLastSection: boolean) => React.ReactNode
}) {
  // sections — единая лента сообщения (одна шапка на все итерации).
  // steps — legacy/одиночная цепочка (карточка агента, сообщение без iterations).
  const allSections = useMemo<ToolChainSection[]>(
    () => sections ?? [{ thinking: thinkingText, thinkingMs, steps: steps ?? [] }],
    [sections, thinkingText, thinkingMs, steps],
  )
  const sectionIters = useMemo(() => allSections.map(s => buildIterations(s.steps)), [allSections])
  const iters = useMemo(() => sectionIters.flat(), [sectionIters])
  const allSteps = useMemo(() => allSections.flatMap(s => s.steps), [allSections])
  // sessionId для live-вывода run_command (из tool_progress). Передаётся ТОЛЬКО
  // в IterationBlock — не в store, чтобы pty:data-стрим не триггерил ре-рендер.
  const runCmdSessionId = toolProgress?.['run_command']?.sessionId
  const runCmdActive = toolProgress?.['run_command']?.stage === 'start'
  const [collapsed, setCollapsed] = useState(!isRunning)  // история — свёрнут; идёт работа — открыт
  const setTimelineNode = useCallback((node: HTMLDivElement | null) => {
    if (node) node.inert = collapsed
  }, [collapsed])
  const remeasure = useChatRemeasure()
  const itersRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  // ── Текст модели в ленте рендерится тем же markdown-пайплайном, что ответ ──
  // Наборы плагинов совпадают с MessageBubble: маршрут по наличию математики
  // (KaTeX дорог — включаем только если реально есть формулы).
  const textHasMath = useMemo(
    () => sections?.some(s => (s.textBefore ?? '').length > 0 && containsMathMarkers(s.textBefore as string)) ?? false,
    [sections],
  )
  const textRemarkPlugins = useMemo(() => (textHasMath ? [remarkGfm, remarkMath] : [remarkGfm]), [textHasMath])
  const textRehypePlugins = useMemo(
    () => (textHasMath ? [[rehypeKatex, { errorColor: 'var(--danger, #e5484d)' }]] : []),
    [textHasMath],
  )
  const textMdComponents = useMemo(() => createMdComponents({ workdir }), [workdir])
  // Прилип ли автоскролл к хвосту ленты. true — новые действия подтягиваются
  // вниз; false — пользователь ушёл читать историю, его не трогаем.
  const pinnedRef = useRef(true)
  const [showJumpDown, setShowJumpDown] = useState(false)
  // Окно видимых итераций: длинные цепочки (100+ тулов) при раскрытии раньше
  // монтировали ВСЕ IterationBlock разом (со stagger-анимациями и springs) →
  // фриз. Показываем последние ITERS_PAGE, кнопка «предыдущие» расширяет окно
  // к началу. Live-хвост (последние действия) виден всегда.
  const [itersExtra, setItersExtra] = useState(0)

  // ── Авто-раскрытие цепочки при старте ──────────────────────────────
  // Не сворачиваем ленту по завершении: автоматическое закрытие через секунду
  // прерывало чтение результата и воспринималось как «тулы сами схлопнулись».
  // Закрыть блок можно вручную по шапке.
  const prevRunningRef = useRef(isRunning)
  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = isRunning
    if (isRunning && !wasRunning) {
      setCollapsed(false)
      setItersExtra(0)
      remeasure?.()
    }
  }, [isRunning, remeasure])

  // ── Мемоизированные агрегаты — раньше 4× filter/some на каждом рендере ──
  // ToolChain ре-рендерится при каждом токен-флеше (50мс) во время стриминга.
  // 4× filter/some по iters + 1× filter по steps = O(n) на каждый рендер.
  // Теперь один проход в useMemo — ре-вычисление только при смене iters/steps.
  const { totalDone, hasFailed, failedCount, autoElapsed } = useMemo(() => {
    let done = 0, failed = 0, hasFail = false
    for (const it of iters) {
      if (it.result && it.result.visualAnalysis?.status !== 'pending') done++
      if (it.result?.success === false || it.result?.visualAnalysis?.status === 'failed') { failed++; hasFail = true }
    }
    // elapsed из timestamps
    let firstTs = 0, lastTs = 0
    for (const s of allSteps) {
      if (s.timestamp) {
        if (!firstTs) firstTs = s.timestamp
        lastTs = s.timestamp
      }
    }
    const elapsed = (firstTs && lastTs && firstTs !== lastTs) ? lastTs - firstTs : undefined
    return { totalDone: done, hasFailed: hasFail, failedCount: failed, autoElapsed: elapsed }
  }, [iters, allSteps])

  // НЕТ авто-раскрытия цепочки при сбое: в больших чатах failed-цепочки
  // авто-раскрывались при скролле и монтировали все тела с подсветкой →
  // фризы. Заголовок показывает «⚠ M ошибок из N» — раскрытие по клику.

  // elapsed: переданный извне имеет приоритет, иначе — autoElapsed из useMemo
  const elapsedMs = elapsed ?? autoElapsed

  const elapsedStr = elapsedMs != null
    ? elapsedMs >= 60000
      ? `${Math.floor(elapsedMs / 60000)}м ${Math.round((elapsedMs % 60000) / 1000)}с`
      : elapsedMs >= 1000
        ? `${(elapsedMs / 1000).toFixed(1)}с`
        : `${elapsedMs}мс`
    : null

  // ── Все useMemo ДО early return (Rules of Hooks) ──
  // Раньше early return `if (iters.length === 0 && !isRunning) return null`
  // стоял ДО 4 useMemo → нарушение Rules of Hooks → React может бросить
  // исключение при смене iters.length с 0 на >0. Теперь все хуки до return.

  // Агрегация мини-чипов по типу тула — вместо N одинаковых чипов
  // показываем [icon ×count] на каждый тип.
  const chipGroups = useMemo(() => {
    const map = new Map<string, { meta: ReturnType<typeof getToolMeta>; count: number; toolName?: string }>()
    for (const { call } of iters) {
      const key = call.toolName ?? 'unknown'
      const entry = map.get(key) ?? { meta: getToolMeta(call.toolName, call.serverName), count: 0, toolName: call.toolName }
      entry.count++
      map.set(key, entry)
    }
    return [...map.values()]
  }, [iters])

  // Текущее действие для живой шапки — последний iter без результата.
  const currentRunningIter = useMemo(() => {
    if (!isRunning) return null
    for (let i = iters.length - 1; i >= 0; i--) {
      if (!iters[i].result) return iters[i]
    }
    return null
  }, [iters, isRunning])

  // ── «Сейчас делает» в шапке ──────────────────────────────────────────
  // Берём выполняющийся шаг, а если такого нет (тул завершился, следующий ещё
  // не начался / агент пишет ответ) — последний шаг ленты. Раньше в этот
  // момент шапка падала на «Агент работает» / пустоту, и казалось, что показ
  // действия «пропадает с задержкой». Смена названия анимируется
  // (key по имени тула → fade-in), таймер тикает только пока шаг реален.
  const headerIter = currentRunningIter ?? (iters.length > 0 ? iters[iters.length - 1] : null)
  const headerMeta = headerIter ? getToolMeta(headerIter.call.toolName, headerIter.call.serverName) : null
  const headerArg = headerIter?.call.toolArgs
    ? truncate(String(Object.values(headerIter.call.toolArgs)[0] ?? ''), 40)
    : ''

  // Время старта для тикающего таймера (стабильное — timestamp первого шага).
  const runStartTime = allSteps.length > 0 && allSteps[0]?.timestamp ? allSteps[0].timestamp : Date.now()

  // «Живой» режим: идут тулы ИЛИ прогон ещё стримит ответ (агент пишет текст).
  // До конца прогона окно живёт по правилам живого режима — см. prevActiveRef.
  // Объявлен ДО chain/эффектов: от него зависит структура ленты и автоскролл.
  const liveMode = isRunning || !!busy

  // ── Видимое окно ленты ──
  // ITERS_PAGE ограничивает количество монтируемых тул-блоков: длинные
  // цепочки (100+ тулов) при раскрытии монтировали всё разом → фриз.
  // Показываем хвост, кнопка «предыдущие» расширяет окно к началу.
  const visibleCount = Math.min(iters.length, ITERS_PAGE + itersExtra)
  const hiddenCount = iters.length - visibleCount

  // ── Единая лента сообщения: Think → текст → тулы → Think → … ──
  // Структура строится по liveMode (isRunning || busy), а НЕ по isRunning:
  // isRunning на время прогона мигает (между «тул завершился» и «следующий
  // начался» он false). Из-за этого группировка серий то появлялась, то
  // исчезала → ключи записей менялись → ВСЕ шаги ремонтировались и у всех
  // разом перезапускалась entrance-анимация. liveMode стабилен весь прогон.
  const chain = useMemo(
    () => buildChain(sectionIters, allSections, liveMode),
    [sectionIters, allSections, liveMode],
  )  // Обрезаем по окну — сколько тул-итераций уже «спрятано» в начале ленты.
  const visibleChain = useMemo(() => {
    if (hiddenCount <= 0) return chain
    let skip = hiddenCount
    let startIdx = 0
    for (let i = 0; i < chain.length; i++) {
      const e = chain[i]
      if (e.kind === 'single') {
        if (skip === 0) { startIdx = i; break }
        skip--
      } else if (e.kind === 'group') {
        if (e.iters.length >= skip) { startIdx = i; break }
        skip -= e.iters.length
      }
    }
    return startIdx > 0 ? chain.slice(startIdx) : chain
  }, [chain, hiddenCount])

  // Источник отклика — ResizeObserver на внутреннем контейнере ленты
  // (см. эффект ниже): отдельный счётчик длины текста больше не нужен,
  // рост <pre>-вывода и reasoning ловится самим RO.

  // ── Умный автоскролл живого окна ────────────────────────────────────
  // Подписываемся на РЕАЛЬНЫЙ рост содержимого (ResizeObserver), а не на
  // React-рендеры: вывод команды стримится внутри <pre>, reasoning растёт из
  // Zustand, diff/detals раскрываются по анимации — на всё это нужен отклик.
  //   • прилип (pinned) — пользователь у низа (зазор < 24px): тянем хвост;
  //   • отпустил — прокрутил вверх читать: НЕ трогаем скролл, показываем
  //      кнопку «к последним действиям»;
  //   • сам вернулся в низ → снова прилипает, кнопка гаснет.
  // Пороги: 24px на определение «у низа» — чтобы «у низа» ловилось и после
  // дробного scrollTop с HiDPI.
  useEffect(() => {
    const el = itersRef.current
    const inner = innerRef.current
    if (!el || !inner) return
    const BOTTOM_GAP = 24
    const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_GAP
    const stick = () => { el.scrollTop = el.scrollHeight }
    // Высота контента на прошлом scroll-событии. Нужна, чтобы отличить
    // РУЧНОЙ доезд до низа от КЛАМПА: когда выполнявшийся тул схлопывается в
    // итоговую карточку, scrollHeight падает, Chromium прижимает scrollTop к
    // новому низу → «atBottom» → ложный re-pin → следующее RO-событие
    // утаскивало читающего выше вниз.
    let prevSh = el.scrollHeight
    // Свежий жест пользователя внутри окна (колесо/кнопка мыши/клавиатура).
    // Только он даёт право «прилипнуть» — не программные сдвиги.
    let gestureAt = 0
    const markGesture = () => { gestureAt = performance.now() }

    const onScroll = () => {
      const sh = el.scrollHeight
      const shrank = sh < prevSh - 1
      prevSh = sh
      const bottom = atBottom()
      const fresh = performance.now() - gestureAt < 600
      if (shrank) {
        // Сжатие контента — не повод менять прилипание и не повод прыгать.
        setShowJumpDown(v => {
          const next = liveMode && !bottom
          return v === next ? v : next
        })
        return
      }
      if (bottom && !pinnedRef.current && fresh) pinnedRef.current = true
      if (liveMode && pinnedRef.current && !bottom) pinnedRef.current = false
      // Кнопку показываем только в живом окне: в истории пользователь сам
      // управляет скроллом, лишний оверлей там мешает.
      setShowJumpDown(v => {
        const next = liveMode && !bottom
        return v === next ? v : next
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', markGesture, { passive: true })
    el.addEventListener('pointerdown', markGesture, { passive: true })
    el.addEventListener('keydown', markGesture)

    // ── Якорь чтения внутри окна ────────────────────────────────────────
    // Карточка выполняющегося тула высокая, по завершении схлопывается в
    // строку — контент ВЫШЕ читаемого сжимается, и всё уезжает вверх
    // (а если упрётся в низ — Chromium клампнёт scrollTop). Держим шаг,
    // который сейчас у верхнего края окна, на том же месте.
    let anchor: { el: Element; top: number } | null = null
    const captureAnchor = (): void => {
      if (pinnedRef.current) { anchor = null; return }
      const boxTop = el.getBoundingClientRect().top
      const items = inner.children
      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect()
        if (r.bottom > boxTop + 1) {
          anchor = { el: items[i], top: r.top - boxTop }
          return
        }
      }
      anchor = null
    }
    const restoreAnchor = (): void => {
      if (!anchor || !anchor.el.isConnected || pinnedRef.current) return
      const delta = (anchor.el.getBoundingClientRect().top - el.getBoundingClientRect().top) - anchor.top
      if (Math.abs(delta) < 1) return
      el.scrollTop += delta
      prevSh = el.scrollHeight
    }
    // Переснимаем якорь на ручной прокрутке и запоминаем перед сжатием.
    const onGesture = (): void => { markGesture(); captureAnchor() }
    el.addEventListener('wheel', onGesture, { passive: true })
    el.addEventListener('pointerup', onGesture, { passive: true })

    let raf = 0
    let lastInnerH = inner.getBoundingClientRect().height
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const h = inner.getBoundingClientRect().height
        const shrank = h < lastInnerH - 1
        lastInnerH = h
        // Сжатие контента — возвращаем якорь (читаемое остаётся на месте).
        if (shrank) {
          restoreAnchor()
          prevSh = el.scrollHeight
          return
        }
        // Догоняем низ только если человек реально прилип. Признак «прилип»
        // ставит исключительно жест (onScroll с fresh) или кнопка «вниз».
        if (liveMode && pinnedRef.current && !collapsed) stick()
      })
    })
    ro.observe(inner)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', markGesture)
      el.removeEventListener('pointerdown', markGesture)
      el.removeEventListener('keydown', markGesture)
      el.removeEventListener('wheel', onGesture)
      el.removeEventListener('pointerup', onGesture)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [collapsed, liveMode])

  // Отпустил прокрутку ↑ и появились новые действия → кнопка возврата.
  const jumpToBottom = useCallback(() => {
    const el = itersRef.current
    if (!el) return
    pinnedRef.current = true
    setShowJumpDown(false)
    el.scrollTop = el.scrollHeight
  }, [])

  // Открыл окно заново — сразу прилипаем к хвосту. Раньше эффект висел на
  // [collapsed, isRunning]: isRunning дёргается на каждом туле, и КАЖДОЕ его
  // изменение сбрасывало pinned=true + scrollTop в низ — читающего внутри
  // тулчейна телепало вниз посреди работы агента. Теперь только на
  // РАСКРЫТИИ окна (collapsed false), а не на смене статуса прогона.
  const wasCollapsedRef = useRef(collapsed)
  useEffect(() => {
    const opened = wasCollapsedRef.current && !collapsed
    wasCollapsedRef.current = collapsed
    if (!opened) return
    pinnedRef.current = true
    const el = itersRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [collapsed])

  // Map id→index больше не нужен (defaultOpen убран) — isLast считается
  // по позиции в видимой ленте.

  // Лента нужна и без тулов: чистый reasoning/текст перед первым вызовом.
  const hasThinking = !!thinkingText || !!allSections.some(s => s.thinking) ||
    (!!liveThinking && (liveThinking.isLive || liveThinking.ms !== undefined))
  // §steer — карточка внедрённой реплики тоже повод показать окно: прогон без
  // единого тула (модель отвечала текстом) иначе схлопнулся бы в null и
  // сообщение пользователя «исчезло» бы из ленты.
  const hasSteers = allSections.some(s => s.steps.some(st => st.type === 'steer'))

  const assistantSteps = allSteps.filter(step => step.type === 'hint' || step.type === 'janitor')
  if (iters.length === 0 && !isRunning && !hasThinking && !hasSteers && assistantSteps.length === 0) return null

  if (mode === 'compact') {
    return (
      <div className="tc2 tc2--compact">
        <div className="tc2-compact-row">
          {isRunning && <span className="tc2-spinner" />}
          {iters.map(({ id, call }, i) => {
            const meta = getToolMeta(call.toolName, call.serverName)
            return (
              <span key={id} className="tc2-compact-chip" style={{ '--chip-color': meta.color } as React.CSSProperties}>
                <AppIcon name={meta.icon as 'zap'} size="xs" />
                {i < iters.length - 1 && <span className="tc2-compact-arrow">›</span>}
              </span>
            )
          })}
          {isRunning && <span className="tc2-compact-dots">···</span>}
        </div>
        {assistantSteps.length > 0 && (
          <details className="tc2-compact-assistants">
            <summary>Мини-агенты</summary>
            {assistantSteps.map(step => <AssistantCard key={step.id} step={step} isRunning={isRunning} animateEntrance={false} />)}
          </details>
        )}
      </div>
    )
  }

  // liveMode объявлен выше (до эффекта автоскролла) — здесь только строка
  // инструментов и разметка.
  const toolsStr = chipGroups.map(g => `${g.meta.label}${g.count > 1 ? ` ×${g.count}` : ''}`).join(' · ')

  return (
    <div className={`tc2${summary ? ' tc2--summary' : ''}${liveMode ? ' tc2--running' : ''}`}>
      {/* Conic-рамка: статичная маска на обёртке, градиент вращается через
          individual-свойство rotate (композитится на GPU) вместо анимации
          CSS-переменной внутри conic-gradient (repaint каждый кадр). */}
      <span className="tc2-border-arc" aria-hidden="true" />
      <div className="tc2-header" role="button" tabIndex={0} aria-expanded={!collapsed}
        onClick={() => setCollapsed(c => !c)}
        onKeyDown={e => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
          e.preventDefault()
          setCollapsed(c => !c)
        }}>
        {/* Дымка-блик шапки: градиент бежит через transform, а не через
            background-position — иначе repaint шапки каждый кадр. */}
        <span className="tc2-header-glow" aria-hidden="true" />
        <span className="tc2-collapse-btn">
          <AppIcon name={collapsed ? 'chevronRight' : 'chevronDown'} size="xs" />
        </span>

        <div className="tc2-header-summary">
          {label
            ? <span className="tc2-header-title tc2-header-title--label">{label}</span>
            : liveMode
              ? headerMeta
                ? currentRunningIter
                  // Шаг реально выполняется — тикающий таймер.
                  ? <LiveHeader currentTool={headerMeta.label} currentArg={headerArg} startTime={runStartTime} />
                  // Шаг завершён, следующий ещё не пришёл / агент пишет ответ:
                  // название последнего действия остаётся, спиннер показывает,
                  // что работа продолжается (без врущего таймера).
                  : <>
                      <span className="tc2-spinner" />
                      <span key={headerMeta.label} className="tc2-header-title tc2-live-title">{headerMeta.label}</span>
                      {headerArg && <code className="tc2-header-current-arg">{headerArg}</code>}
                    </>
                : <><span className="tc2-spinner" /><span className="tc2-header-title">Агент работает</span></>
              : (() => {
                  // «Выполнено за 22с · 3 действия» — одной фразой вместо
                  // бейджа-счётчика + отдельного бейджа с часами: строка короче
                  // и читается как итог работы, а не как набор индикаторов.
                  if (!totalDone && assistantSteps.length) {
                    return <span className="tc2-header-title">Мини-агенты</span>
                  }
                  const plural = totalDone === 1 ? 'действие' : totalDone < 5 ? 'действия' : 'действий'
                  return (
                    <span className="tc2-header-title tc2-header-title--done">
                      {elapsedMs != null ? `Выполнено за ${formatDoneDuration(elapsedMs)}` : 'Выполнено'}
                      <span className="tc2-header-dot"> · </span>
                      <span className={hasFailed ? 'tc2-header-count tc2-header-count--fail' : 'tc2-header-count'}>
                        {totalDone} {plural}
                      </span>
                      {hasFailed && (
                        <span className="tc2-status-badge tc2-status-badge--fail tc2-header-fail-badge">
                          {failedCount}
                        </span>
                      )}
                    </span>
                  )
                })()
          }
          {/* Часы-бейдж нужны только для блоков с внешним label (там нет
              фразы «Выполнено за …» в заголовке). */}
          {label && elapsedStr && !liveMode && (
            <span className="tc2-elapsed-badge">
              <AppIcon name="clock" size="xs" />
              {elapsedStr}
            </span>
          )}
        </div>

        <ToolChips chipGroups={chipGroups} isRunning={liveMode} toolsStr={toolsStr} />
      </div>



      <div ref={setTimelineNode} aria-hidden={collapsed} className={`tc2-iters-wrap${collapsed ? '' : ' tc2-iters-wrap--open'}`}>
        <div className="tc2-iters" ref={itersRef}>
          {/* Внутренний контейнер — цель ResizeObserver для умного автоскролла:
              расти может что угодно внутри (вывод команды, reasoning, diff),
              отклик нужен на РЕАЛЬНЫЙ рост содержимого, а не на re-render. */}
          <div className="tc2-iters-inner" ref={innerRef}>
            {hiddenCount > 0 && (
              <button className="tc2-show-more" onClick={() => setItersExtra(e => e + ITERS_CHUNK)}>
                Показать ещё {Math.min(ITERS_CHUNK, hiddenCount)} из {hiddenCount} предыдущих действий
              </button>
            )}
            {visibleChain.map((entry, vIdx) => {
              const isLastVisible = vIdx === visibleChain.length - 1
              // Рассуждение — строкой ленты (Think внутри окна хода работы).
              if (entry.kind === 'thinking') {
                return (
                  <div key={entry.key} className="tc2-thinking-embed">
                    <ThinkingBlock text={entry.text} thinkingMs={entry.ms} />
                  </div>
                )
              }
              // Обычный текст модели перед тулами — тоже внутри ленты, чтобы
              // при сворачивании хода работы он уходил вместе с ним, а не
              // оставался висеть в сообщении.
              //
              // Рендерим тем же markdown-пайплайном, что и обычный ответ
              // (ParsedContent из markdownRenderer): одинаковое форматирование,
              // шрифт и цвет. Раньше это был <div> с white-space: pre-wrap —
              // серый монолит, в котором пустые строки стрима давали провалы.
              if (entry.kind === 'text') {
                return (
                  <div key={entry.key} className="tc2-note">
                    <div className="tc2-note-text message-content selectable">
                      <ParsedContent
                        text={entry.text}
                        allowPlanCard={false}
                        remarkPlugins={textRemarkPlugins}
                        rehypePlugins={textRehypePlugins}
                        mdComponents={textMdComponents}
                        workdir={workdir}
                      />
                    </div>
                  </div>
                )
              }
              if (entry.kind === 'steer') {
                // §steer — реплика пользователя, внедрённая по ходу рана.
                return <SteerCard key={entry.key} step={entry.step} chatId={chatId} />
              }
              if (entry.kind === 'assistant') {
                return <AssistantCard key={entry.key} step={entry.step} isRunning={!!isRunning} animateEntrance={liveMode && isLastVisible} />
              }
              if (entry.kind === 'group') {
                return (
                  <GroupBlock
                    // Стабильный ключ по id первой итерации группы: индексный
                    // ключ ремонтировал GroupBlock при сдвиге окна видимых
                    // итераций → раскрытая группа схлопывалась.
                    key={entry.key}
                    group={{ type: 'group', meta: entry.meta, iters: entry.iters }}
                    mode={mode}
                    animateEntrance={false}
                  />
                )
              }
              const iter = entry.iter
              // Тул-карточки по умолчанию закрыты.
              // Дополнительный контент под шагом (карточка
              // саб-агента) — ВНУТРИ ленты, сразу под своей итерацией.
              // Передаём САМУ итерацию: иначе карточка рисовалась бы под
              // каждым шагом секции (шаги секции одинаковы для всех её итераций).
              const extra = renderIterExtra
                ? renderIterExtra(iter, entry.si === allSections.length - 1)
                : null
              return (
                <Fragment key={iter.id}>
                  <IterationBlock
                    iter={iter}
                    isLast={isLastVisible}
                    isRunning={!!isRunning}
                    mode={mode}
                    liveSessionId={runCmdActive && iter.call.toolName === 'run_command' && !iter.result ? runCmdSessionId : undefined}
                    // Анимация появления — ТОЛЬКО у последнего (только что
                    // добавленного) шага. Раньше флаг стоял у всех: при любом
                    // ре-рендере/смене флага класс пересоздавался и анимация
                    // перезапускалась у всей ленты разом.
                    animateEntrance={liveMode && isLastVisible}
                  />
                  {extra && <div className="tc2-iter-extra">{extra}</div>}
                </Fragment>
              )
            })}

            {/* Пульс — ждём следующего тула. При наличии live-thinking не нужен:
                строку «Думаю…» заменяет сам блок рассуждения ниже. */}
            {isRunning && iters.length > 0 && iters[iters.length - 1].result && !liveThinking && (
              <div className="tc2-iter">
                <div className="tc2-rail">
                  <div className="tc2-dot tc2-dot--thinking" />
                </div>
                <div className="tc2-iter-body">
                  <div className="tc2-thinking-row">
                    <span className="tc2-spinner" />
                    <span className="tc2-thinking-label">Думаю…</span>
                  </div>
                </div>
              </div>
            )}

            {/* Старт — нет тулов ещё */}
            {isRunning && iters.length === 0 && !liveThinking && (
              <div className="tc2-iter">
                <div className="tc2-rail">
                  <div className="tc2-dot tc2-dot--thinking" />
                </div>
                <div className="tc2-iter-body">
                  <div className="tc2-thinking-row">
                    <span className="tc2-spinner" />
                    <span className="tc2-thinking-label">Анализирую задачу…</span>
                  </div>
                </div>
              </div>
            )}

            {/* Текущее стримящееся рассуждение — последней строкой ленты, чтобы
                «ход работы» читался одной лентой (Think → тулы → Think).
                ThinkingBlock сам подписан на store по storeChatId — токены
                ре-рендерят только его, не всю цепочку. */}
            {liveThinking && (liveThinking.isLive || liveThinking.ms !== undefined) && (
              <div className="tc2-thinking-embed tc2-thinking-embed--live">
                <ThinkingBlock
                  thinkingMs={liveThinking.ms}
                  isLive={liveThinking.isLive}
                  storeChatId={liveThinking.storeChatId}
                />
              </div>
            )}
          </div>
        </div>
        {/* Пользователь прокрутил вверх читать — автоскролл отпущен.
            Кнопка возвращает к хвосту и снова прилипает. */}
        {showJumpDown && !collapsed && liveMode && (
          <button className="tc2-jump-down" onClick={jumpToBottom} title="К последним действиям">
            <AppIcon name="chevronDown" size="xs" />
            <span>к последним</span>
          </button>
        )}
      </div>
    </div>
  )
}, (prev, next) => prev.steps === next.steps && prev.sections === next.sections && prev.mode === next.mode &&
  prev.isRunning === next.isRunning && prev.busy === next.busy && prev.label === next.label &&
  prev.elapsed === next.elapsed && prev.summary === next.summary &&
  prev.toolProgress === next.toolProgress &&
  prev.thinkingText === next.thinkingText && prev.thinkingMs === next.thinkingMs &&
  prev.liveThinking === next.liveThinking && prev.chatId === next.chatId &&
  prev.renderIterExtra === next.renderIterExtra)

export default ToolChain
