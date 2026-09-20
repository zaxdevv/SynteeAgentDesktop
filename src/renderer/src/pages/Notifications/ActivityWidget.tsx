import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useActivityStore } from '../../store/activity.store'
import Logo from '../../components/ui/Logo/Logo'
import './ActivityWidget.css'

/**
 * ActivityWidget — мега-компактный информер активности ИИ в overlay-хабе.
 *
 * ОДНА строка-пилюля (28px): [логотип] [фаза/N чатов] [точки чатов] [счётчик] [тулы].
 * Поддерживает параллельные прогоны: store хранит per-chat состояние,
 * виджет агрегирует — «3 чата · read_file», точки = статус каждого чата.
 *
 * Анимации (всё плавно, без резких подмен):
 *  - label: смена текста = slide + blur переход (popLayout), «думает» — шиммер
 *  - чипы тулов: пружинно влетают справа / улетают, соседи сдвигаются плавно
 *  - счётчик: перекат (старое значение уезжает вверх, новое въезжает снизу)
 *  - точки чатов: стаггер-появление пружиной
 *  - логотип: мягкая пульсация пока агент работает
 *  - сама пилюля: layout-анимация — ширина меняется пружиной при любом контенте
 */

/** Русская плюрализация: 1 чат / 2 чата / 5 чатов */
function pluralChat(n: number): string {
  const d10 = n % 10, d100 = n % 100
  if (d10 === 1 && d100 !== 11) return 'чат'
  if (d10 >= 2 && d10 <= 4 && (d100 < 10 || d100 >= 20)) return 'чата'
  return 'чатов'
}

const STATUS_DOT: Record<string, string> = {
  running: '○',
  done: '✓',
  error: '✗',
}

export default function ActivityWidget() {
  const {
    chats, visible,
    setRunning, setDone, setError,
    setPhase, setCurrentTool, setToolProgress, addStep, updateStep,
    setVisible, showWidget,
  } = useActivityStore()

  // Ref для setTimeout в onToolProgress — очищается при unmount
  const progressTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // ── Подписка на события из main ──────────────────────────────────
  useEffect(() => {
    const offRun = (window.syntee as any).activity.onRunStatus((data: {
      chatId: string; status: string; msgId?: string; error?: string
    }) => {
      if (data.status === 'running') setRunning(data.chatId)
      else if (data.status === 'done') setDone(data.chatId)
      else if (data.status === 'error') setError(data.chatId)
      else if (data.status === 'cancelled') setDone(data.chatId)
    })

    const offStep = (window.syntee as any).activity.onStep((step: {
      type: string; toolName?: string; toolArgs?: Record<string, unknown>
      content?: string; success?: boolean; callId?: string
      pendingCallId?: string; chatId?: string
    }) => {
      const chatId = step.chatId
      if (!chatId) return
      if (step.type === 'tool_call' || step.type === 'tool_call_pending') {
        setPhase(chatId, 'tool')
        setCurrentTool(chatId, step.toolName || null)
        if (step.toolName) {
          const stepId = step.callId || step.pendingCallId || `${Date.now()}-${Math.random()}`
          addStep(chatId, {
            id: stepId,
            toolName: step.toolName,
            status: 'running',
            args: step.toolArgs,
            ts: Date.now(),
          })
        }
      } else if (step.type === 'tool_result') {
        if (step.callId) {
          updateStep(chatId, step.callId, {
            status: step.success === false ? 'error' : 'done',
            result: step.content,
          })
        }
        setPhase(chatId, 'thinking')
        setCurrentTool(chatId, null)
      } else if (step.type === 'thinking') {
        setPhase(chatId, 'thinking')
      }
    })

    const offProgress = (window.syntee as any).activity.onToolProgress((data: {
      chatId: string; toolName: string; stage: string; detail?: string
      filesProcessed?: number; filesTotal?: number
    }) => {
      if (!data.chatId) return
      setToolProgress(data.chatId, {
        toolName: data.toolName,
        stage: data.stage,
        detail: data.detail,
        filesProcessed: data.filesProcessed,
        filesTotal: data.filesTotal,
      })
      if (data.stage === 'done') {
        if (progressTimerRef.current) clearTimeout(progressTimerRef.current)
        progressTimerRef.current = setTimeout(() => setToolProgress(data.chatId, null), 1000)
      }
    })

    const offHide = (window.syntee as any).activity.onHide(() => {
      // Только setVisible(false) — НЕ чистим chats. Иначе showWidget() при
      // следующем сворачивании не увидит running-чаты и виджет не появится.
      setVisible(false)
    })

    const offShow = (window.syntee as any).activity.onShow(() => {
      showWidget()
    })

    return () => {
      offRun(); offStep(); offProgress(); offHide(); offShow()
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current)
    }
  }, [setRunning, setDone, setError, setPhase, setCurrentTool, setToolProgress, addStep, updateStep, setVisible, showWidget])

  // ── Агрегация параллельных прогонов ──────────────────────────────
  const list = Object.values(chats)
  const running = list.filter(c => c.status === 'running')
  const hasError = list.some(c => c.status === 'error')
  const isRunning = running.length > 0
  const shouldRender = visible && list.length > 0
  // Шиммер на лейбле — когда все running-чаты думают (ни один тул не активен)
  const isThinking = isRunning && !running.some(c => c.phase === 'tool')

  // Label: 1 чат → фаза; N чатов → «N чата · фаза/тул»
  let label: string
  if (!isRunning) {
    label = hasError ? 'Ошибка' : 'Готово'
  } else if (running.length === 1) {
    const c = running[0]
    label = c.phase === 'thinking' ? 'Думает...' : (c.currentTool || 'Тул...')
  } else {
    const toolChat = running.find(c => c.phase === 'tool' && c.currentTool)
    label = toolChat
      ? `${running.length} ${pluralChat(running.length)} · ${toolChat.currentTool}`
      : `${running.length} ${pluralChat(running.length)} · думают...`
  }

  // Счётчик: прогресс файлов активного тула (12/40) или число шагов
  const progress = running.find(c => c.toolProgress && c.toolProgress.stage !== 'done')?.toolProgress
  const totalSteps = running.reduce((n, c) => n + c.steps.length, 0)
  const counter = progress?.filesTotal
    ? `${progress.filesProcessed ?? 0}/${progress.filesTotal}`
    : (isRunning && totalSteps > 0 ? String(totalSteps) : null)

  // Последние тула по всем running-чатам (по времени)
  const recentTools = running
    .flatMap(c => c.steps)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 3)

  // Точки статусов чатов (max 5)
  const dots = running.slice(0, 5)

  return (
    <AnimatePresence>
      {shouldRender && (
        <motion.div
          className="activity-widget"
          data-interactive="true"
          layout
          transition={{ type: 'spring', stiffness: 320, damping: 32 }}
          initial={{ opacity: 0, scale: 0.4, y: -24 }}
          animate={{
            opacity: 1,
            scale: 1,
            y: 0,
            transition: {
              type: 'spring',
              stiffness: 260,
              damping: 20,
              mass: 0.7,
              opacity: { duration: 0.18, ease: 'easeOut' },
            },
          }}
          exit={{
            opacity: 0,
            scale: 0.4,
            y: -18,
            transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
          }}
          style={{ transformOrigin: '50% 0%' }}
        >
          {/* Логотип — мягкая пульсация пока агент работает */}
          <motion.div
            className="activity-widget__logo-wrap"
            animate={isRunning ? { scale: [1, 1.1, 1] } : { scale: 1 }}
            transition={
              isRunning
                ? { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
                : { duration: 0.25 }
            }
          >
            <Logo size={14} />
          </motion.div>

          {/* Терминальный статус ✓/✗ — пружинный pop-in */}
          <AnimatePresence mode="popLayout" initial={false}>
            {!isRunning && (
              <motion.span
                key="status"
                className={`activity-widget__status ${hasError ? 'activity-widget__status--error' : ''}`}
                initial={{ scale: 0, rotate: -40 }}
                animate={{ scale: 1, rotate: 0 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 500, damping: 22 }}
              >
                {hasError ? '✗' : '✓'}
              </motion.span>
            )}
          </AnimatePresence>

          {/* Label — смена текста со slide+blur, «думает» — шиммер */}
          <span className="activity-widget__label-wrap">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={label}
                className={`activity-widget__label ${isThinking ? 'activity-widget__label--shimmer' : ''}`}
                initial={{ opacity: 0, y: 8, filter: 'blur(3px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -8, filter: 'blur(3px)' }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                {label}
              </motion.span>
            </AnimatePresence>
          </span>

          {/* Точки статусов параллельных чатов — стаггер-появление */}
          <AnimatePresence initial={false}>
            {dots.length > 1 && (
              <motion.span
                className="activity-widget__dots"
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.5 }}
                transition={{ duration: 0.18 }}
              >
                {dots.map((c, i) => (
                  <motion.span
                    key={i}
                    className={`activity-widget__dot ${c.phase === 'tool' ? 'activity-widget__dot--tool' : 'activity-widget__dot--think'}`}
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: i * 0.05, type: 'spring', stiffness: 500, damping: 24 }}
                  />
                ))}
              </motion.span>
            )}
          </AnimatePresence>

          {/* Счётчик — перекат значения */}
          <AnimatePresence mode="popLayout" initial={false}>
            {counter != null && (
              <motion.span
                key={counter}
                className="activity-widget__counter"
                initial={{ opacity: 0, y: 9, scale: 0.6 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -9, scale: 0.6 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
              >
                {counter}
              </motion.span>
            )}
          </AnimatePresence>

          {/* Чипы тулов — пружинные, соседи сдвигаются плавно (popLayout) */}
          <div className="activity-widget__tools">
            <AnimatePresence mode="popLayout" initial={false}>
              {recentTools.map((step) => (
                <motion.span
                  key={step.id}
                  layout
                  className={`activity-widget__tool-chip activity-widget__tool-chip--${step.status}`}
                  initial={{ opacity: 0, scale: 0.5, x: 12 }}
                  animate={{ opacity: 1, scale: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.5, x: -8 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 26 }}
                >
                  <span className="activity-widget__tool-dot">
                    {step.status === 'running' ? (
                      <motion.span
                        className="activity-widget__tool-spinner"
                        animate={{ rotate: 360 }}
                        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                      />
                    ) : (
                      STATUS_DOT[step.status] || '○'
                    )}
                  </span>
                  <span className="activity-widget__tool-name">{step.toolName}</span>
                </motion.span>
              ))}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
