// ── DotChat: чат Dot'а — наследует рендер (MessageBubble) и инпут-бар ────
// (ChatInput). Живой стриминг работает бесплатно: глобальная подписка
// useChatRunSubscription (App.tsx) пишет liveByChat[chatId] для ВСЕХ чатов,
// MessageBubble читает live-текст по message.chatId.
//
// Wake-сообщения рендерятся ТАЙМЛАЙН-СЕПАРАТОРАМИ (как «новый день» в
// мессенджерах), а не пузырём пользователя: wake — системное событие,
// «Пробуждение по расписанию» пузырём юзера сбивает (будто ты это сказал).
//
// ВАЖНО (баг-фикс): ChatInput рендерит корень .chat-input-wrap с
// position:absolute; bottom:0 — враппер .dot-chat-input-wrap ОБЯЗАН иметь
// position:relative, иначе инпут вырывается из слота и перекрывает ленту
// сообщений (клики по зоне инпута уходили в скролл-контейнер).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { v4 as uuid } from 'uuid'
import MessageBubble from '../../components/ui/MessageBubble/MessageBubble'
import VirtualMessageList from '../../components/ui/VirtualMessageList/VirtualMessageList'
import ChatInput from '../../components/ui/ChatInput/ChatInput'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import { useChatStore } from '../../store/chat.store'
import { useDotsStore } from '../../store/dots.store'
import { initChatSend } from '../../hooks/useChatRunSubscription'
import { useContextCounter } from '../../hooks/useContextCounter'
import { IPC_EVENTS } from '../../../../shared/constants'
import type { Dot, DotRun, Message } from '../../../../shared/types'
import { mergeTail, prependOlder } from '../../utils/messageWindow'
import { DotBlob } from './DotBlob'

// Размер страницы истории Dot-чата (как в ChatPage/SplitChatPane).
const DOT_PAGE_SIZE = 50

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`
}

/** Wake-сообщения: user-пузырь с displayContent от DotManager.
 *  Сохранённый content = displayContent («Пробуждение по расписанию» и
 *  т.п.) — по нему и распознаём (см. chatSendHandler: content = displayContent ?? content). */
const WAKE_LABELS: Array<{ match: string; icon: string; label: string }> = [
  { match: 'Пробуждение по расписанию', icon: 'clock', label: 'Расписание' },
  { match: 'Пробуждение по интервалу', icon: 'clock', label: 'Интервал' },
  { match: 'Пробуждение по webhook', icon: 'link', label: 'Webhook' },
  { match: 'Пробуждение: изменились файлы', icon: 'folder', label: 'Изменились файлы' },
  { match: 'Ручное пробуждение', icon: 'zap', label: 'Ручное пробуждение' },
]

function wakeInfo(msg: Message): { icon: string; label: string } | null {
  if (msg.role !== 'user') return null
  const hit = WAKE_LABELS.find(w => msg.content === w.match || msg.content.startsWith(w.match))
  return hit ? { icon: hit.icon, label: hit.label } : null
}

/** Sparkline активности за 7 дней: столбик = число ранов в день. */
function ActivitySpark({ runs }: { runs: DotRun[] }) {
  const days = useMemo(() => {
    const out: Array<{ label: string; count: number }> = []
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    for (let i = 6; i >= 0; i--) {
      const start = now.getTime() - i * 86_400_000
      const count = runs.filter(r => r.startedAt >= start && r.startedAt < start + 86_400_000).length
      out.push({ label: String(new Date(start).getDate()), count })
    }
    return out
  }, [runs])
  const max = Math.max(1, ...days.map(d => d.count))
  return (
    <div className="dot-spark" title="Раны за последние 7 дней">
      {days.map((d, i) => (
        <div
          key={i}
          className={`dot-spark-bar${d.count > 0 ? ' dot-spark-bar--on' : ''}`}
          style={{ height: `${Math.max(8, Math.round((d.count / max) * 100))}%` }}
          title={`${d.count} ран(ов)`}
        />
      ))}
    </div>
  )
}

export function DotChat({
  dot,
  runs,
  onWake,
}: {
  dot: Dot
  runs: DotRun[]
  onWake: () => void
}) {
  const chatId = dot.chatId
  const [messages, setMessages] = useState<Message[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [draft, setDraft] = useState('')
  const [showRuns, setShowRuns] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  // Корень .dot-chat (для --dot-input-h) и слот инпута (для ResizeObserver).
  const rootRef = useRef<HTMLDivElement>(null)
  const inputHostRef = useRef<HTMLDivElement>(null)

  // ── Пагинация истории ──────────────────────────────────────────────
  // Раньше на каждый wake/silent-ран тянулась ВСЯ история (chat.getMessages) и
  // заменяла ленту целиком. Теперь грузим только последнюю страницу
  // (getMessagesPage) и подгружаем старые вверх по скроллу — доступ к прошлому
  // сохраняется, но мегабайты истории не гоняются по IPC на каждый ран.
  const loadingOlderRef = useRef(false)
  // Какой chatId сейчас реально загружен в окно (null — идёт загрузка/смена).
  // Защищает loadOlder от курсора по сообщениям ещё предыдущего Dot'а.
  const loadedChatRef = useRef<string | null>(null)
  // Монотонный счётчик «эпохи» загрузки: растёт при смене чата/первичной
  // загрузке. Ответы с устаревшей эпохой отбрасываются (защита от гонок при
  // быстром переключении Dot'ов — иначе лента одного Dot'а утекала бы в другой).
  const reqSeqRef = useRef(0)
  const tailSeqRef = useRef(0)
  const deletedIdsRef = useRef(new Set<string>())
  const prependingRef = useRef<{ oldScrollHeight: number; oldScrollTop: number } | null>(null)

  // Эффективная модель Dot'а: персональная → глобальная Dots → основная.
  const dotsSettings = useDotsStore(s => s.settings)
  const modelId = dot.modelId ?? dotsSettings?.modelId ?? ''
  const modelTitle = dot.modelId
    ? `Персональная модель Dot’а: ${dot.modelId}`
    : dotsSettings?.modelId
      ? `Модель из настроек Dots: ${dotsSettings.modelId}`
      : 'Основная модель чата (main)'

  // Live-статус чата Dot'а (глобальная подписка пишет для всех чатов).
  // Узкие селекторы: раньше `s => s.liveByChat[chatId]` возвращал НОВЫЙ объект
  // на каждом токен-флаше (каждые ~50мс) → весь DotChat (≈470 строк) ре-рендерился
  // 20×/сек. Теперь подписка только на примитивы (bool/string): во время стрима
  // DotChat не ре-рендерится вообще. Сам live-текст читает MessageBubble напрямую
  // из стора (по message.chatId) — см. MessageBubble.tsx.
  const isTyping = useChatStore(s => s.liveByChat[chatId]?.isTyping ?? false)
  const runStatusStatus = useChatStore(s => s.runStatusByChat[chatId]?.status)

  // Тихий refresh хвоста: тянем последнюю страницу и МЕРЖИМ в окно, не теряя
  // уже подгруженные старые сообщения. Вызывается на running / run finished.
  const refreshTail = useCallback(async () => {
    const seq = reqSeqRef.current
    const tailSeq = ++tailSeqRef.current
    try {
      const res = await window.syntee.chat.getMessagesPage(chatId, DOT_PAGE_SIZE) as { messages: Message[]; hasMore: boolean }
      if (seq !== reqSeqRef.current || tailSeq !== tailSeqRef.current) return
      setMessages(prev => mergeTail(prev, res.messages.filter(m => !deletedIdsRef.current.has(m.id)))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)))
    } catch { /* ignore */ }
  }, [chatId])

  // Первичная загрузка: ПОСЛЕДНЯЯ страница (не вся история). .then-паттерн
  // (setState — в колбэке промиса, не в теле эффекта).
  useEffect(() => {
    let cancelled = false
    reqSeqRef.current++
    tailSeqRef.current++
    deletedIdsRef.current.clear()
    pinnedRef.current = true
    prependingRef.current = null
    const seq = reqSeqRef.current
    loadedChatRef.current = null
    loadingOlderRef.current = false
    window.syntee.chat.getMessagesPage(chatId, DOT_PAGE_SIZE)
      .then((res: { messages: Message[]; hasMore: boolean }) => {
        if (cancelled || seq !== reqSeqRef.current) return
        loadedChatRef.current = chatId
        setMessages(res.messages)
        setHasOlder(res.hasMore)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [chatId])

  // Догрузка более старых сообщений вверх (reverse-infinite scroll).
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasOlder || loadedChatRef.current !== chatId) return
    const oldest = messages[0]
    if (!oldest) return
    const el = scrollRef.current
    if (el) prependingRef.current = { oldScrollHeight: el.scrollHeight, oldScrollTop: el.scrollTop }
    loadingOlderRef.current = true
    const seq = reqSeqRef.current
    try {
      const res = await window.syntee.chat.getMessagesPage(chatId, DOT_PAGE_SIZE, oldest.createdAt, oldest.id) as { messages: Message[]; hasMore: boolean }
      if (seq !== reqSeqRef.current) return
      setMessages(prev => prependOlder(prev, res.messages.filter(m => !deletedIdsRef.current.has(m.id))))
      setHasOlder(res.hasMore)
    } catch {
      if (seq === reqSeqRef.current) prependingRef.current = null
    } finally {
      if (seq === reqSeqRef.current) loadingOlderRef.current = false
    }
  }, [chatId, hasOlder, messages])

  // Webhook URL (для чипа в шапке)
  useEffect(() => {
    window.syntee.dots.getWebhookUrl(dot.id).then(setWebhookUrl).catch(() => setWebhookUrl(null))
  }, [dot.id, dot.webhookEnabled])

  // Динамический отступ под инпут — тот же паттерн, что в ChatPage:
  // .chat-input-wrap абсолютный (bottom:0) и плавает ПОВЕРХ ленты, поэтому
  // ленте нужен padding-bottom = высоте инпута (иначе контент уходит под
  // инпут и его не докрутить скроллом). Высота живая — ResizeObserver.
  useEffect(() => {
    const root = rootRef.current
    const holder = inputHostRef.current
    const wrap = holder?.firstElementChild as HTMLElement | undefined
    if (!root || !wrap) return
    const apply = () => { root.style.setProperty('--dot-input-h', `${wrap.offsetHeight}px`) }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // События: финал стрима → append; wake-старт/ран Dot'а → reload
  useEffect(() => {
    const offDone = window.syntee.on(IPC_EVENTS.CHAT_STREAM_DONE, (...args: unknown[]) => {
      const data = args[0] as { chatId: string; message: Message }
      if (data.chatId !== chatId || deletedIdsRef.current.has(data.message.id)) return
      setMessages(prev =>
        prev.some(m => m.id === data.message.id) ? prev : [...prev, data.message])
    })
    const offStatus = window.syntee.on(IPC_EVENTS.CHAT_RUN_STATUS, (...args: unknown[]) => {
      const data = args[0] as { chatId: string; status: string }
      if (data.chatId !== chatId) return
      // 'running' — проснулось что-то новое (wake или наш send): тихо
      // обновляем хвост ленты (wake-сообщение сохраняется в main до running).
      if (data.status === 'running') void refreshTail()
    })
    const offRun = window.syntee.on(IPC_EVENTS.DOTS_RUN_FINISHED, (...args: unknown[]) => {
      const p = (args[0] ?? {}) as { chatId?: string; deletedMessageIds?: string[] }
      if (p.chatId !== chatId) return
      // A paged merge cannot infer deletions from a missing tail ID.
      // Remove the exact silent-run pair before refreshing the new tail.
      if (p.deletedMessageIds?.length) {
        for (const id of p.deletedMessageIds) deletedIdsRef.current.add(id)
        setMessages(prev => prev.filter(m => !deletedIdsRef.current.has(m.id)))
      }
      void refreshTail()
    })
    return () => { offDone(); offStatus(); offRun() }
  }, [chatId, refreshTail])

  // Автоскролл при новых сообщениях (если закреплено).
  useEffect(() => {
    if (!pinnedRef.current) return
    const el = scrollRef.current
    if (!el) return
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  }, [messages.length])

  // Автоскролл на росте live-текста/шагов — через ПОДПИСКУ на стор, без
  // ре-рендера DotChat. Раньше это были deps [live?.text, live?.steps?.length],
  // из-за чего компонент ре-рендерился на каждом токене стрима.
  useEffect(() => {
    const unsub = useChatStore.subscribe((state, prev) => {
      const cur = state.liveByChat[chatId]
      const old = prev.liveByChat[chatId]
      if (!cur || cur === old) return
      const grew = cur.isTyping !== old?.isTyping
        || (cur.text?.length ?? 0) !== (old?.text?.length ?? 0)
        || (cur.steps?.length ?? 0) !== (old?.steps?.length ?? 0)
      if (!grew || !pinnedRef.current) return
      const el = scrollRef.current
      if (!el) return
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
    })
    return unsub
  }, [chatId])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    // Reverse-infinite scroll: у верхнего края и есть ещё старые → грузим.
    if (el.scrollTop < 40 && hasOlder && !loadingOlderRef.current) void loadOlder()
  }, [hasOlder, loadOlder])

  // Компенсация скролла после prepend старых сообщений: визуальная позиция
  // чтения сохраняется (иначе список «уезжает» вниз).
  useLayoutEffect(() => {
    const snap = prependingRef.current
    if (!snap) return
    prependingRef.current = null
    const el = scrollRef.current
    if (!el) return
    const delta = el.scrollHeight - snap.oldScrollHeight
    if (delta > 0) el.scrollTop = snap.oldScrollTop + delta
  }, [messages.length])

  // Отправка: тот же chat:send, что в ChatPage (упрощённо: без slash/вложений).
  const handleSend = useCallback(async (text: string) => {
    const raw = text.trim()
    if (!raw) return
    const userMsg: Message = {
      id: uuid(),
      chatId,
      role: 'user',
      content: raw,
      createdAt: Date.now(),
      isPinned: 0,
    }
    pinnedRef.current = true
    try {
      const result = await window.syntee.chat.send({
        chatId,
        content: raw,
        userMsgId: userMsg.id,
        mode: 'work',
      }) as { queued?: boolean }
      if (!result?.queued) {
        if (loadedChatRef.current !== chatId) return
        setMessages(prev => prev.some(m => m.id === userMsg.id) ? prev : [...prev, userMsg])
        if (useChatStore.getState().runStatusByChat[chatId]?.status === 'running') initChatSend(chatId)
      }
      // queued: main поставит в очередь; сообщение появится по 'running'.
    } catch (e) {
      console.error('[DotChat] send failed', e)
    }
  }, [chatId])

  const handleStop = useCallback(() => {
    window.syntee.chat.stop(chatId).catch(() => {})
  }, [chatId])

  // Лента: wake-сообщения → сепараторы, остальные → пузыри + live-пузырь.
  const displayMessages = useMemo(() => {
    if (!isTyping) return messages
    return [...messages, {
      id: 'live-streaming-bubble',
      chatId,
      role: 'assistant' as const,
      content: '',
      // eslint-disable-next-line react-hooks/purity -- синтетический live-пузырь: метка косметическая (тот же паттерн, что в ChatPage displayMessages)
      createdAt: Date.now(),
      isPinned: 0,
    } as Message]
  }, [messages, isTyping, chatId])

  const isGenerating = isTyping || runStatusStatus === 'queued' || runStatusStatus === 'running'

  // Контекст-счётчик для ContextRing — тот же хук, что в ChatPage:
  // кольцо в инпут-баре показывает реальный контекст чата Dot'а и кликается.
  const contextInfo = useContextCounter({
    chatId,
    currentInput: draft,
    modelId: modelId || '',
    enabled: true,
    messageCount: messages.length,
    isRunning: isGenerating,
  })

  // Сводка для панели истории.
  const s = dot.state
  const quietPct = s.runCount > 0 ? Math.round((s.silentCount / s.runCount) * 100) : null

  return (
    <div className="dot-chat" ref={rootRef}>
      {/* Цветная полоска Dot'а сверху — визуальная привязка чата к капле */}
      <div className="dot-chat-strip" style={{ background: dot.color }} />

      {/* Шапка чата Dot'а */}
      <div className="dot-chat-header">
        <DotBlob color={dot.color} icon={dot.icon} status={s.status} size={32} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="dot-chat-header-name">{dot.name}</div>
          <div
            className="dot-chat-header-purpose"
            title={`${dot.purpose}${modelTitle ? `\n${modelTitle}` : ''}`}
          >
            {modelId || 'осн. модель'}
          </div>
        </div>
        {webhookUrl && (
          <button
            type="button"
            className="dots-header-btn"
            title={`Скопировать webhook: ${webhookUrl}`}
            onClick={() => {
              navigator.clipboard?.writeText(webhookUrl).catch(() => {})
            }}
          >
            <AppIcon name="link" size="xs" />
          </button>
        )}
        <button
          type="button"
          className={`dots-header-btn${showRuns ? ' dots-header-btn--active' : ''}`}
          onClick={() => setShowRuns(v => !v)}
          title="История пробуждений"
        >
          <AppIcon name="history" size="xs" /> История
        </button>
        <button
          type="button"
          className="dots-header-btn dots-header-btn--primary"
          onClick={onWake}
          disabled={s.status === 'running' || !dot.enabled}
          title="Разбудить Dot’а сейчас"
        >
          <AppIcon name="zap" size="xs" /> Разбудить
        </button>
      </div>

      {/* Панель истории: slide-in справа — сводка + sparkline + раны.
          Exit — только числовые значения + tween (см. урок про exit). */}
      <AnimatePresence>
        {showRuns && (
          <motion.div
            className="dot-runs-panel"
            initial={{ opacity: 0, x: 26 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 26 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
          <div className="dot-runs-panel-head">
            <div className="dot-runs-title">История пробуждений</div>
            <button
              type="button"
              className="dot-card-action"
              title="Закрыть"
              onClick={() => setShowRuns(false)}
            >
              <AppIcon name="x" size="xs" />
            </button>
          </div>

          {/* Сводка: счётчики + активность за 7 дней */}
          <div className="dot-runs-stats">
            <div className="dot-runs-stat">
              <span className="dot-runs-stat-num">{s.runCount}</span>
              <span className="dot-runs-stat-label">всего</span>
            </div>
            <div className="dot-runs-stat">
              <span className="dot-runs-stat-num dot-runs-stat-num--report">{s.reportCount}</span>
              <span className="dot-runs-stat-label">отчётов</span>
            </div>
            <div className="dot-runs-stat">
              <span className="dot-runs-stat-num">{s.silentCount}</span>
              <span className="dot-runs-stat-label">тихих{quietPct !== null ? ` · ${quietPct}%` : ''}</span>
            </div>
            <div className="dot-runs-stat">
              <span className="dot-runs-stat-num dot-runs-stat-num--error">{s.errorCount}</span>
              <span className="dot-runs-stat-label">ошибок</span>
            </div>
          </div>
          <ActivitySpark runs={runs} />

          <div className="dot-runs-list">
            {runs.length === 0 && (
              <div className="dot-run-row">
                <span className="dot-run-summary">Ещё ни одного пробуждения</span>
              </div>
            )}
            {runs.map((r, idx) => (
              <motion.div
                key={r.id}
                className="dot-run-row"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.18, delay: Math.min(idx * 0.02, 0.2), ease: 'easeOut' }}
              >
                <span className={`dot-run-badge dot-run-badge--${r.status}`}>
                  {r.status === 'report' ? 'отчёт' : r.status === 'silent' ? 'тихо' : r.status === 'running' ? 'работа' : r.status === 'error' ? 'ошибка' : 'стоп'}
                </span>
                <div className="dot-run-info">
                  <div className="dot-run-summary" title={r.summary}>
                    {r.summary || (r.status === 'silent' ? 'изменений не найдено' : '—')}
                  </div>
                  <div className="dot-run-time">
                    {fmtTime(r.startedAt)} · {r.trigger}
                    {r.completionTokens ? ` · ${r.completionTokens} ток.` : ''}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Лента сообщений (наследованный рендер + wake-сепараторы) */}
      <div className="dot-chat-messages" ref={scrollRef} onScroll={handleScroll}>
        <div className="dot-chat-messages-inner">
          {displayMessages.length === 0 && !isTyping && (
            <div className="dot-chat-empty">
              <motion.div
                initial={{ opacity: 0, scale: 0.86 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                <DotBlob color={dot.color} icon={dot.icon} status="sleeping" size={64} />
              </motion.div>
              <div className="dot-chat-empty-title">{dot.name} ещё спит</div>
              <div className="dot-chat-empty-text">
                Нажми «Разбудить» — или напиши ему: он ответит и запомнит контекст задачи.
              </div>
            </div>
          )}
          <VirtualMessageList items={displayMessages} scrollRef={scrollRef} pinnedRef={pinnedRef}
            scope={chatId} gap={6} estimatedSize={160} renderItem={(msg, i, firstMount) => {
            const isLive = msg.id === 'live-streaming-bubble'
            const wake = wakeInfo(msg)
            if (wake && !isLive) {
              // Wake-сообщение → таймлайн-сепаратор (не пузырь пользователя).
              return (
                <motion.div
                  key={msg.id}
                  className="dot-wake-sep"
                  initial={firstMount ? { opacity: 0, y: -4 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                >
                  <span className="dot-wake-sep-line" />
                  <span className="dot-wake-sep-label">
                    <AppIcon name={wake.icon as 'clock'} size="xs" />
                    {wake.label} · {fmtTime(msg.createdAt)}
                  </span>
                  <span className="dot-wake-sep-line" />
                </motion.div>
              )
            }
            return (
              <MessageBubble
                key={msg.id}
                message={msg}
                isStreaming={isLive && isTyping}
                isWaiting={isLive && isTyping}
                shouldAnimate={firstMount && i >= displayMessages.length - 3}
                editorAvailable={!isLive}
              />
            )
          }} />
        </div>
      </div>

      {/* Индикатор работы над инпутом */}
      <AnimatePresence>
        {isGenerating && (
          <motion.div
            className="dot-chat-running"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <span className="dot-chat-running-dot" style={{ background: dot.color }} />
            Dot работает…
          </motion.div>
        )}
      </AnimatePresence>

      {/* Инпут-бар (наследованный ChatInput) — паттерн ChatPage: слот с
          display:contents, корень .chat-input-wrap абсолютный и пинится к
          .dot-chat (position:relative). Лента получает padding-bottom
          = --dot-input-h (ResizeObserver выше) — контент не уходит под инпут. */}
      <div ref={inputHostRef} style={{ display: 'contents' }}>
        <ChatInput
          chatId={chatId}
          onSend={handleSend}
          value={draft}
          onChangeValue={setDraft}
          disabled={false}
          isGenerating={isGenerating}
          onStop={handleStop}
          contextInfo={contextInfo}
          showContextRing
        />
      </div>
    </div>
  )
}
