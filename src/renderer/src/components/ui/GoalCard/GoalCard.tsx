import { useRef, useState, useId, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import type { ChatGoal, GoalStatus } from '../../../../../shared/types/goal'

type GoalEdit = Pick<ChatGoal, 'objective' | 'criteria' | 'constraints' | 'maxSteps'>
const statuses: Record<GoalStatus, string> = {
  running: 'В работе', paused: 'На паузе', blocked: 'Заблокирована', completed: 'Завершена',
  unverified: 'Не проверена', stopped: 'Остановлена', limit: 'Лимит шагов',
}
export default function GoalCard({ goal, running, onCommand, onSave }: {
  goal: ChatGoal; running: boolean
  onCommand: (command: string) => Promise<void>
  onSave: (patch: GoalEdit) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [objective, setObjective] = useState('')
  const [criteria, setCriteria] = useState('')
  const [constraints, setConstraints] = useState('')
  const [maxSteps, setMaxSteps] = useState(goal.maxSteps)
  const dialogRef = useRef<HTMLDivElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(busy)
  useEffect(() => { busyRef.current = busy }, [busy])
  const titleId = useId()
  const reduceMotion = useReducedMotion()
  useEffect(() => {
    if (!editing) return
    const dialog = dialogRef.current
    dialog?.querySelector<HTMLElement>('textarea')?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!busyRef.current) setEditing(false)
      } else if (event.key === 'Tab') {
        const elements = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') ?? [])
        const first = elements[0]
        const last = elements.at(-1)
        if (!first) { event.preventDefault(); dialog?.focus(); return }
        if (!dialog?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first)?.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKey, true)
    return () => document.removeEventListener('keydown', handleKey, true)
  }, [editing])
  const execute = async (command: string) => {
    setBusy(true); setError('')
    try { await onCommand(command) } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const canResume = !running && !['completed', 'stopped'].includes(goal.status) && goal.steps < goal.maxSteps
  return <section className={`chat-goal-banner${expanded ? ' is-expanded' : ''}`} aria-label="Цель чата">
    <div className="goal-heading">
      <AppIcon name="compass" size="xs" tone="accent" aria-hidden="true" />
      <strong title={goal.objective}>{goal.objective}</strong>
      <span role="status">{statuses[goal.status]} · {goal.steps}/{goal.maxSteps}</span>
      <AnimatePresence initial={false} mode="popLayout">
        {expanded && <motion.div className="goal-controls" initial={{ opacity: 0, scale: 0.94, x: 8 }} animate={{ opacity: 1, scale: 1, x: 0 }} exit={{ opacity: 0, scale: 0.94, x: 8 }} transition={{ type: 'spring', stiffness: 440, damping: 28 }}>
            {running
              ? <button disabled={busy} onClick={() => void execute('/goal-pause')}>Пауза</button>
              : <button disabled={busy || !canResume} onClick={() => void execute('/goal')}>Продолжить</button>}
            <button ref={editRef} disabled={busy || running} onClick={() => {
              setObjective(goal.objective); setCriteria(goal.criteria.join('\n')); setConstraints(goal.constraints.join('\n'))
              setMaxSteps(goal.maxSteps); setError(''); setEditing(true)
            }}>Изменить</button>
            <button disabled={busy || goal.status === 'stopped'} onClick={() => void execute('/goal-stop')}>Остановить</button>
          </motion.div>}
      </AnimatePresence>
      <motion.button type="button" className="goal-expand-toggle" aria-expanded={expanded} aria-controls="goal-details" aria-label={expanded ? 'Свернуть цель' : 'Развернуть цель'} onClick={() => setExpanded(value => !value)} whileHover={reduceMotion ? undefined : { scale: 1.1 }} whileTap={reduceMotion ? undefined : { scale: 0.9 }}>
        <motion.span className="goal-chevron" aria-hidden="true" animate={{ rotate: expanded ? 180 : 0 }} transition={{ type: 'spring', stiffness: 500, damping: 25 }}>
          <AppIcon name="chevronDown" size="md" tone="accent" strokeWidth={2.4} />
        </motion.span>
      </motion.button>
    </div>
    <AnimatePresence initial={false} mode="wait">
      {!expanded && goal.progress.length > 0 && <motion.p className="goal-compact-progress" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: reduceMotion ? 0 : 0.16 }}><b>Сейчас:</b> {goal.progress.at(-1)}</motion.p>}
      {expanded && <motion.div id="goal-details" className="goal-expanded-content" initial={reduceMotion ? false : { opacity: 0, height: 0, y: -6 }} animate={{ opacity: 1, height: 'auto', y: 0 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -6 }} transition={{ height: { type: 'spring', stiffness: 420, damping: 34 }, opacity: { duration: 0.16 }, y: { duration: 0.2 } }}>
      {goal.progress.length > 0 && <p><b>Прогресс:</b> {goal.progress.at(-1)}</p>}
      {goal.blocker && <p className="goal-blocker"><b>Блокер:</b> {goal.blocker}</p>}
      <details open><summary>Подробности цели · {goal.criteria.length} критериев · {goal.progress.length} шагов прогресса · {goal.evidence.length} проверок</summary>
        <motion.div initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: reduceMotion ? 0 : 0.08 }}>
          <b>Критерии завершения</b><ul>{goal.criteria.map((item, i) => <li key={i}>{item}</li>)}</ul>
          {goal.constraints.length > 0 && <><b>Ограничения</b><ul>{goal.constraints.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
          {goal.progress.length > 0 && <><b>Весь прогресс</b><ul>{goal.progress.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
          {goal.evidence.length > 0 && <><b>Свидетельства</b><ul>{goal.evidence.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
        </motion.div>
      </details>
      </motion.div>}
    </AnimatePresence>
    {error && !editing && <p role="alert">{error}</p>}
    {createPortal(<AnimatePresence onExitComplete={() => editRef.current?.focus()}>
      {editing && <motion.div className="goal-edit-backdrop" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.18 }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) setEditing(false) }}>
        <motion.div ref={dialogRef} className="goal-edit-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
          initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 12, scale: 0.98 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}>
      <form onSubmit={async event => {
        event.preventDefault()
        const lines = (value: string) => value.split('\n').map(s => s.trim()).filter(Boolean)
        if (!objective.trim() || !lines(criteria).length || lines(criteria).length > 20 || lines(constraints).length > 20 || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 12 || maxSteps < goal.steps) {
          setError('Укажи хотя бы один критерий и целый лимит не меньше 1 и уже выполненных шагов'); return
        }
        setBusy(true); setError('')
        try { await onSave({ objective: objective.trim(), criteria: lines(criteria), constraints: lines(constraints), maxSteps }); setEditing(false) }
        catch (e) { setError(String(e)) } finally { setBusy(false) }
      }}>
        <h3 id={titleId}>Настройки цели</h3>
        <label>Цель<textarea required maxLength={2000} rows={2} value={objective} disabled={busy} onChange={e => setObjective(e.target.value)} /></label>
        <p>Автопроверка: <code>diagnostics_passed</code>, <code>file_contains:путь::текст</code> или <code>file_not_contains:путь::текст</code>. Свободные критерии требуют проверки человеком. Один шаг — раунд модели; лимит инструментов и времени действует отдельно.</p>
        <label>Критерии завершения (по одному на строку)<textarea autoFocus required rows={4} value={criteria} disabled={busy} onChange={e => setCriteria(e.target.value)} /></label>
        <label>Ограничения (по одному на строку)<textarea rows={4} value={constraints} disabled={busy} onChange={e => setConstraints(e.target.value)} /></label>
        <label>Максимум шагов<input type="number" min={Math.max(1, goal.steps)} max={12} step={1} required value={maxSteps} disabled={busy} onChange={e => setMaxSteps(Number(e.target.value))} /></label>
        {error && <p role="alert">{error}</p>}
        <div className="goal-controls"><button type="button" disabled={busy} onClick={() => setEditing(false)}>Отмена</button><button type="submit" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button></div>
        </form>
        </motion.div>
      </motion.div>}
    </AnimatePresence>, document.body)}
  </section>
}
