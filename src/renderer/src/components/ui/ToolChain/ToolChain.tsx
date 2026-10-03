import { useState, useEffect, useRef, memo, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import ToolResultRenderer from './ToolResultRenderer'
import type { ToolOutputMode } from '../../../../../shared/types'
import { getSubagentRole } from '../../../../../shared/subagent-roles'
import { useChatRemeasure } from '../MessageBubble/remeasure'

import { getToolMeta } from '../../../../../shared/toolMeta'
import './ToolChain.css'

export interface ToolStep {
  id: string
  type: 'tool_call' | 'tool_result'
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
}

// Группируем шаги: каждая итерация = один вызов тула + его результат
interface Iteration {
  id: string
  call: ToolStep
  result?: ToolStep
}

function buildIterations(steps: ToolStep[]): Iteration[] {
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

// ── Группировка последовательных итераций с одним toolName ──────────
// Схлопываем длинные цепочки однотипных тулов (6 read_file подряд) в
// одну раскрывающуюся группу. Только в финальном состоянии (!isRunning),
// чтобы во время live-прогона не дезориентировать внезапным коллапсом.
const NO_GROUP_TOOLS = new Set(['spawn_agent', 'ask_user', 'think', 'update_todo'])

type GroupedItem =
  | { type: 'single'; iter: Iteration }
  | { type: 'group'; meta: ReturnType<typeof getToolMeta>; iters: Iteration[] }

function groupConsecutiveIters(iters: Iteration[], isRunning: boolean): GroupedItem[] {
  if (isRunning) return iters.map(iter => ({ type: 'single' as const, iter }))
  const groups: GroupedItem[] = []
  let i = 0
  while (i < iters.length) {
    const name = iters[i].call.toolName
    const noGroup = !name || NO_GROUP_TOOLS.has(name)
    let j = i + 1
    while (j < iters.length && iters[j].call.toolName === name && !noGroup) j++
    if (j - i >= 3 && !noGroup) {
      groups.push({ type: 'group', meta: getToolMeta(iters[i].call.toolName, iters[i].call.serverName), iters: iters.slice(i, j) })
    } else {
      for (let k = i; k < j; k++) groups.push({ type: 'single', iter: iters[k] })
    }
    i = j
  }
  return groups
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}мс`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}с`
  return `${Math.floor(ms / 60000)}м ${Math.round((ms % 60000) / 1000)}с`
}

function truncate(s: string, n = 80) {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function formatArg(v: unknown): string {
  if (typeof v === 'string') return v
  return JSON.stringify(v, null, 2)
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
const LiveCommandOutput = memo(function LiveCommandOutput({ sessionId }: { sessionId: string }) {
  const [output, setOutput] = useState('')
  const bufRef = useRef('')
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef(false)
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
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

  if (!output) return null
  return (
    <div className="tc2-section tc2-live-terminal">
      <div className="tc2-section-title">Вывод</div>
      <pre ref={preRef} className="tc2-live-terminal-pre">{output}</pre>
    </div>
  )
}, (prev, next) => prev.sessionId === next.sessionId)

// Цветной diff блок. memo + чанкование: большие diff'ы (тысячи строк) раньше
// монтировали div на КАЖДУЮ строку при раскрытии итерации → фриз. Теперь
// первые DIFF_CHUNK строк + кнопка «Показать ещё».
const DIFF_CHUNK = 500
const DiffBlock = memo(function DiffBlock({ diff }: { diff: string }) {
  const [extra, setExtra] = useState(0)
  const visible = DIFF_CHUNK + extra
  const lines = diff.split('\n').filter((_, i, arr) => {
    // Убираем пустую последнюю строку
    return !(i === arr.length - 1 && arr[i] === '')
  })
  const shown = lines.slice(0, visible)
  return (
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
  )
}, (prev, next) => prev.diff === next.diff)

// Один блок итерации
const IterationBlock = memo(function IterationBlock({
  iter, index, isLast, isRunning, mode, defaultOpen, liveSessionId, animateEntrance,
}: {
  iter: Iteration
  index: number
  isLast: boolean
  isRunning: boolean
  mode: ToolOutputMode
  defaultOpen: boolean
  liveSessionId?: string
  // Entrance-анимация только для живых цепочек. Для сохранённых (история)
  // анимация бесполезна и вредна: при scroll-remount и при раскрытии
  // 100-итерационной цепочки stagger delay=index*0.04 давал последним
  // итерациям 4+ секунды задержки.
  animateEntrance: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
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

  const prevRunning = useRef(running)
  useEffect(() => {
    if ((running || pending || analyzing) && !prevRunning.current) setOpen(true)
    prevRunning.current = running || pending || analyzing
  }, [running, pending, analyzing])

  // НЕТ авто-раскрытия при сбое: в больших чатах failed-итерации при скролле
  // монтировали полные тела (подсветка/diff) → фризы. Ошибка видна по бейджу
  // «ошибка» в заголовке — раскрытие по клику. (Во время live-прогона тело
  // и так уже раскрыто эффектом выше, так что ошибку видно сразу.)

  const statusColor = (failed || vaFailed) ? '#f87171' : meta.color

  // Тяжёлое тело (длинный вывод/diff): maxHeight-анимация framer-motion
  // гоняет layout ВСЕГО поддерева (Prism-спаны, diff-строки) каждый кадр
  // 0.22с → фриз при раскрытии больших результатов. Для тяжёлых тел
  // анимируем только opacity (height сразу auto, один layout на монтирование),
  // сворачивание/раскрытие мгновенное и без джанка.
  const bodyLen = (iter.result?.content?.length ?? 0) + (iter.result?.diff?.length ?? 0)
  const heavy = bodyLen > 3000

  // Preview в свёрнутом заголовке: для run_command берём именно args.command
  // (первое значение args может быть другим ключом), title показывает полный
  // текст — раньше команду было не видно нигде: preview обрезан 80 символами,
  // а в раскрытом теле аргументы показывались только в detailed-режиме.
  const previewText = iter.call.toolName === 'run_command'
    ? String(iter.call.toolArgs?.command ?? Object.values(iter.call.toolArgs ?? {})[0] ?? '')
    : String(Object.values(iter.call.toolArgs ?? {})[0] ?? '')

  return (
    <div
      className={`tc2-iter${animateEntrance ? ' tc2-iter--enter' : ''}`}
      style={animateEntrance ? { animationDelay: `${Math.min(index, 10) * 0.04}s` } : undefined}
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
          onClick={() => setOpen(o => !o)}
        >
          <span className="tc2-iter-icon" style={{ color: meta.color }}>
            <AppIcon name={meta.icon as 'zap'} size="sm" />
          </span>
          <span className="tc2-iter-label">{meta.label}</span>
          {meta.isMcp && meta.server && (
            <span className="tc2-iter-server">{meta.server}</span>
          )}
          {iter.call.toolName && !meta.isMcp && (
            <code className="tc2-iter-name">{iter.call.toolName}</code>
          )}
          {iter.call.toolName === 'spawn_agent' && iter.call.toolArgs?.role && (
            <span
              className="tc2-iter-role-badge"
              style={{ color: getSubagentRole(iter.call.toolArgs.role as string).color }}
            >
              {getSubagentRole(iter.call.toolArgs.role as string).nameEn}
            </span>
          )}


          {iter.call.toolArgs && !open && (
            <span className="tc2-iter-preview" title={previewText}>
              {truncate(previewText)}
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

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              className="tc2-iter-details"
              initial={heavy ? { opacity: 0 } : { maxHeight: 0, opacity: 0 }}
              animate={heavy ? { opacity: 1 } : { maxHeight: 2000, opacity: 1 }}
              exit={heavy ? { opacity: 0 } : { maxHeight: 0, opacity: 0 }}
              transition={heavy
                ? { duration: 0.12 }
                : { duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
              style={{ overflow: 'hidden' }}
              onAnimationComplete={() => remeasure?.()}
            >


              {iter.result && mode !== 'compact' && (() => {
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
                // diff — DiffBlock
                if (iter.result.diff) {
                  const isFail = iter.result.success === false
                  return (
                    <div className="tc2-section">
                      <div className="tc2-section-title" style={{ color: isFail ? '#f87171' : '#4ade80' }}>
                        {isFail ? 'Ошибка' : 'Результат'}
                      </div>
                      <DiffBlock diff={iter.result.diff} />
                    </div>
                  )
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
                  {/* Live-вывод для run_command пока команда выполняется.
                      Подписывается на pty:data по sessionId из toolProgress. */}
                  {iter.call.toolName === 'run_command' && liveSessionId && (
                    <LiveCommandOutput sessionId={liveSessionId} />
                  )}
                  <div className="tc2-section tc2-section--running">
                    <span className="tc2-spinner" />
                    <span className="tc2-running-text">Выполняется…</span>
                  </div>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}, (prev, next) => prev.iter === next.iter && prev.isLast === next.isLast &&
  prev.isRunning === next.isRunning && prev.mode === next.mode && prev.defaultOpen === next.defaultOpen &&
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
      <span className="tc2-header-title">{currentTool}</span>
      {currentArg && <code className="tc2-header-current-arg">{currentArg}</code>}
      <span className="tc2-elapsed tc2-elapsed--live">{elapsedStr}</span>
    </>
  )
})

// ── Группа повторяющихся тулов ──────────────────────────────────────
// Схлопывает N одинаковых итераций в одну раскрывающуюся строку.
const GroupBlock = memo(function GroupBlock({
  group, index, mode, animateEntrance,
}: {
  group: { type: 'group'; meta: ReturnType<typeof getToolMeta>; iters: Iteration[] }
  index: number
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
      style={animateEntrance ? { animationDelay: `${Math.min(index, 10) * 0.04}s` } : undefined}
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
              initial={{ maxHeight: 0, opacity: 0 }}
              animate={{ maxHeight: 5000, opacity: 1 }}
              exit={{ maxHeight: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
              style={{ overflow: 'hidden' }}
              onAnimationComplete={() => remeasure?.()}
            >
              {iters.map((iter, i) => (
                <IterationBlock
                  key={iter.id}
                  iter={iter}
                  index={i}
                  isLast={i === iters.length - 1}
                  isRunning={false}
                  mode={mode}
                  defaultOpen={false}
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

const ToolChain = memo(function ToolChain({ steps, mode, isRunning, label, elapsed, summary, toolProgress }: {
  steps: ToolStep[]
  mode: ToolOutputMode
  isRunning: boolean
  label?: string
  elapsed?: number   // ms — время выполнения для финального блока
  summary?: boolean  // если true — компактный финальный блок
  toolProgress?: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
}) {
  const iters = useMemo(() => buildIterations(steps), [steps])
  // sessionId для live-вывода run_command (из tool_progress). Передаётся ТОЛЬКО
  // в IterationBlock — не в store, чтобы pty:data-стрим не триггерил ре-рендер.
  const runCmdSessionId = toolProgress?.['run_command']?.sessionId
  const runCmdActive = toolProgress?.['run_command']?.stage === 'start'
  const [collapsed, setCollapsed] = useState(true)  // свёрнут по дефолту
  // Окно видимых итераций: длинные цепочки (100+ тулов) при раскрытии раньше
  // монтировали ВСЕ IterationBlock разом (со stagger-анимациями и springs) →
  // фриз. Показываем последние ITERS_PAGE, кнопка «предыдущие» расширяет окно
  // к началу. Live-хвост (последние действия) виден всегда.
  const [itersExtra, setItersExtra] = useState(0)
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
    for (const s of steps) {
      if (s.timestamp) {
        if (!firstTs) firstTs = s.timestamp
        lastTs = s.timestamp
      }
    }
    const elapsed = (firstTs && lastTs && firstTs !== lastTs) ? lastTs - firstTs : undefined
    return { totalDone: done, hasFailed: hasFail, failedCount: failed, autoElapsed: elapsed }
  }, [iters, steps])

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

  // Время старта для тикающего таймера (стабильное — timestamp первого шага).
  const runStartTime = steps.length > 0 && steps[0]?.timestamp ? steps[0].timestamp : Date.now()

  // Видимое окно итераций (хвост + расширение к началу по клику).
  // useMemo: стабильная ссылка массива — иначе groupedVisible пересчитывался
  // на КАЖДЫЙ рендер (новый массив → новые group-объекты → ре-рендер групп),
  // а при сдвиге окна (>ITERS_PAGE итераций) позиционные ключи групп
  // ремонтировали GroupBlock и сбрасывали раскрытость.
  const visibleCount = Math.min(iters.length, ITERS_PAGE + itersExtra)
  const hiddenCount = iters.length - visibleCount
  const visibleIters = useMemo(() => iters.slice(hiddenCount), [iters, hiddenCount])

  // Группировка видимых итераций (только в финальном состоянии).
  const groupedVisible = useMemo(
    () => groupConsecutiveIters(visibleIters, !!isRunning),
    [visibleIters, isRunning],
  )

  // Map id→index для быстрого определения isLast/defaultOpen.
  const iterIndexMap = useMemo(() => {
    const m = new Map<string, number>()
    iters.forEach((iter, i) => m.set(iter.id, i))
    return m
  }, [iters])

  if (iters.length === 0 && !isRunning) return null

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
    </div>
  )
  }

  const statusClass = isRunning ? '' : hasFailed ? ' tc2--has-fail' : iters.length > 0 ? ' tc2--all-ok' : ''
  const okCount = totalDone - failedCount
  const toolsStr = chipGroups.map(g => `${g.meta.label}${g.count > 1 ? ` ×${g.count}` : ''}`).join(' · ')

  return (
    <div className={`tc2${summary ? ' tc2--summary' : ''}${isRunning ? ' tc2--running' : ''}${statusClass}`}>
      <div className="tc2-header" onClick={() => setCollapsed(c => !c)}>
        <span className="tc2-collapse-btn">
          <AppIcon name={collapsed ? 'chevronRight' : 'chevronDown'} size="xs" />
        </span>

        <div className="tc2-header-summary">
          {label
            ? <span className="tc2-header-title tc2-header-title--label">{label}</span>
            : isRunning
              ? currentRunningIter
                ? (() => {
                    const m = getToolMeta(currentRunningIter.call.toolName, currentRunningIter.call.serverName)
                    const arg = currentRunningIter.call.toolArgs
                      ? truncate(String(Object.values(currentRunningIter.call.toolArgs)[0] ?? ''), 40)
                      : ''
                    return <LiveHeader currentTool={m.label} currentArg={arg} startTime={runStartTime} />
                  })()
                : <><span className="tc2-spinner" /><span className="tc2-header-title">Агент работает</span></>
              : <span className="tc2-header-title">
                  {hasFailed
                    ? <span className="tc2-status-badges">
                        <span className="tc2-status-badge tc2-status-badge--ok">{okCount}</span>
                        <span className="tc2-status-badge tc2-status-badge--fail">{failedCount}</span>
                        <span className="tc2-status-label">{totalDone === 1 ? 'действие' : 'действий'}</span>
                      </span>
                    : <span className="tc2-status-badges">
                        <span className="tc2-status-badge tc2-status-badge--ok">{okCount}</span>
                        <span className="tc2-status-label">{totalDone === 1 ? 'действие' : totalDone < 5 ? 'действия' : 'действий'}</span>
                      </span>
                  }
                </span>
          }
          {elapsedStr && !isRunning && (
            <span className="tc2-elapsed-badge">
              <AppIcon name="clock" size="xs" />
              {elapsedStr}
            </span>
          )}
        </div>

        <ToolChips chipGroups={chipGroups} isRunning={isRunning} toolsStr={toolsStr} />
      </div>



      <div className={`tc2-iters-wrap${collapsed ? '' : ' tc2-iters-wrap--open'}`}>
        <div className="tc2-iters">
            {hiddenCount > 0 && (
              <button className="tc2-show-more" onClick={() => setItersExtra(e => e + ITERS_CHUNK)}>
                Показать ещё {Math.min(ITERS_CHUNK, hiddenCount)} из {hiddenCount} предыдущих действий
              </button>
            )}
            {groupedVisible.map((item, vIdx) => {
              if (item.type === 'group') {
                return (
                  <GroupBlock
                    // Стабильный ключ по id первой итерации группы: индексный
                    // ключ ремонтировал GroupBlock при сдвиге окна видимых
                    // итераций → раскрытая группа схлопывалась.
                    key={`group-${item.iters[0].id}`}
                    group={item}
                    index={vIdx}
                    mode={mode}
                    animateEntrance={false}
                  />
                )
              }
              const iter = item.iter
              const origIdx = iterIndexMap.get(iter.id) ?? 0
              const isLastVisible = vIdx === groupedVisible.length - 1
              return (
                <IterationBlock
                  key={iter.id}
                  iter={iter}
                  index={vIdx}
                  isLast={isLastVisible}
                  isRunning={!!isRunning}
                  mode={mode}
                  defaultOpen={!!isRunning && origIdx === iters.length - 1}
                  liveSessionId={runCmdActive && iter.call.toolName === 'run_command' && !iter.result ? runCmdSessionId : undefined}
                  animateEntrance={!!isRunning}
                />
              )
            })}

            {/* Пульс — ждём следующего тула */}
            {isRunning && iters.length > 0 && iters[iters.length - 1].result && (
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
            {isRunning && iters.length === 0 && (
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
        </div>
      </div>
    </div>
  )
}, (prev, next) => prev.steps === next.steps && prev.mode === next.mode &&
  prev.isRunning === next.isRunning && prev.label === next.label &&
  prev.elapsed === next.elapsed && prev.summary === next.summary &&
  prev.toolProgress === next.toolProgress)

export default ToolChain
