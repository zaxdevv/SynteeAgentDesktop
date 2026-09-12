import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Search } from 'lucide-react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { Message } from '../../../../../shared/types'
import { useSettingsStore } from '../../../store/settings.store'
import { whileHoverTiny, whileTapTiny, springHover } from '../../../utils/motionPresets'
import { PSEUDO_IDS, snippet, roleLabel, formatTime } from './minimapShared'
import { ChatMinimapPanel } from './ChatMinimapPanel'
import './ChatMinimap.css'
// ── ChatMinimap — миникарта сообщений (точки справа по центру) ─────────────
// Вертикальная полоса точек: одна точка = одно сообщение. Клик — прыжок к
// сообщению (virtualizer.scrollToIndex, center). Ховер — превью «окно»:
// выбранное сообщение + соседи ±1 (кликабельные). Ховер точки 350 мс или
// кнопка-лупа над полосой — панель «все сообщения» (поиск + сортировка).
// Активная точка — сообщение в центре вьюпорта (кольцо акцента).
// Показывается только когда есть скролл и сообщений >= MIN_MESSAGES.
// Включается/выключается в настройках ('chatMinimap', по умолчанию вкл).

const MIN_MESSAGES = 3
/** Максимальная высота полосы — доля от высоты контейнера. */
const STRIP_MAX_RATIO = 0.45
const DOT_GAP = 4
const DOT_MAX = 7
const DOT_MIN = 3

/** Ховер точки дольше этого → открывается панель «все сообщения». */
const PANEL_OPEN_DELAY = 700
/** Grace после ухода мыши — успеть довести курсор до панели/превью. */
const PANEL_CLOSE_GRACE = 250
/** Grace превью — успеть с точки дойти до строки соседа. */
const HOVER_GRACE = 150

interface ChatMinimapProps {
  /** Виртуализатор ленты — для scrollToIndex и активного индекса. */
  virtualizer: Virtualizer<HTMLDivElement, Element>
  /** displayMessages страницы (включая псевдо — они отфильтровываются). */
  messages: Message[]
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  /** Дёрнуть ПЕРЕД прыжком к сообщению — сбросить pinned автоскролла.
   *  Иначе rAF-loop мгновенно вернёт ленту к низу, и прыжок не виден. */
  onJump?: () => void
}

function ChatMinimap({ virtualizer, messages, scrollContainerRef, onJump }: ChatMinimapProps) {
  const enabled = useSettingsStore(s => (s.settings['chatMinimap'] as boolean | undefined) ?? true)
  // Точки по реальным сообщениям с их исходными индексами в displayMessages
  // (scrollToIndex работает по индексу ПОЛНОГО массива, включая псевдо).
  const dots = useMemo(() => {
    const result: Array<{ origIndex: number; role: Message['role']; id: string }> = []
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (PSEUDO_IDS.has(m.id)) continue
      result.push({ origIndex: i, role: m.role, id: m.id })
    }
    return result
  }, [messages])

  const [activeOrigIndex, setActiveOrigIndex] = useState(-1)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [hover, setHover] = useState<{ origIndex: number; clientY: number } | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelY, setPanelY] = useState(0)
  const [panelAutoFocus, setPanelAutoFocus] = useState(false)

  const stripRef = useRef<HTMLDivElement>(null)

  // Таймеры открытия/закрытия панели и превью (grace-логика).
  const tOpen = useRef(0)
  const tClose = useRef(0)
  const tHover = useRef(0)
  const clearTimers = useCallback(() => {
    clearTimeout(tOpen.current)
    clearTimeout(tClose.current)
    clearTimeout(tHover.current)
  }, [])
  useEffect(() => clearTimers(), [clearTimers])

  const schedulePanelClose = useCallback(() => {
    clearTimeout(tClose.current)
    tClose.current = window.setTimeout(() => setPanelOpen(false), PANEL_CLOSE_GRACE)
  }, [])
  const cancelPanelClose = useCallback(() => clearTimeout(tClose.current), [])

  // Свежая ссылка на onJump без пересоздания handleClick (как onScrollExtraRef
  // в useChatAutoscroll). React Compiler не любит самоссылку useCallback —
  // ref-обёртка снимает проблему.
  const onJumpRef = useRef(onJump)
  useEffect(() => { onJumpRef.current = onJump })

  // Активное сообщение — по центру вьюпорта. Обновляется на СКРОЛЛ (passive
  // listener + rAF-троттлинг — это главный триггер: точка должна следить за
  // тем, что пользователь видит), на resize контейнера (ResizeObserver) и на
  // изменении числа сообщений (deps эффекта). Виртуализатор уже трекает
  // scroll — читаем его getVirtualItems(), второй тяжёлый listener не нужен.
  useEffect(() => {
    let raf = 0
    let cancelled = false
    let ro: ResizeObserver | undefined
    let el: HTMLElement | null = null
    const update = () => {
      if (cancelled) return
      const e = scrollContainerRef.current
      if (!e) return
      setHasOverflow(e.scrollHeight - e.clientHeight > 24)
      const center = e.scrollTop + e.clientHeight / 2
      const items = virtualizer.getVirtualItems()
      let idx = items.length ? items[items.length - 1].index : -1
      for (const it of items) {
        if (it.end >= center) { idx = it.index; break }
        if (it.start >= center) { idx = it.index; break }
      }
      setActiveOrigIndex(idx)
    }
    const onScroll = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(update)
    }
    const attach = () => {
      if (cancelled) return
      el = scrollContainerRef.current
      if (!el) {
        raf = requestAnimationFrame(attach)
        return
      }
      update()
      // ResizeObserver для resize-обновления (контент растёт/меняется).
      ro = new ResizeObserver(update)
      ro.observe(el)
      // ГЛАВНОЕ: скролл ленты — активная точка следует за вьюпортом.
      el.addEventListener('scroll', onScroll, { passive: true })
    }
    attach()
    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      ro?.disconnect()
      el?.removeEventListener('scroll', onScroll)
    }
  }, [virtualizer, scrollContainerRef, messages.length])

  // Размер точки: при переполнении полосы точки ужимаются до DOT_MIN,
  // дальше полоса сама скроллится (overflow-y: auto).
  const [dotSize, setDotSize] = useState(DOT_MAX)
  useEffect(() => {
    let raf = 0
    let cancelled = false
    let ro: ResizeObserver | undefined
    const apply = () => {
      const el = scrollContainerRef.current
      if (!el) return
      // Минус высота кнопки-лупы и отступы обёртки.
      const maxH = el.clientHeight * STRIP_MAX_RATIO - 30
      const fit = Math.floor((maxH + DOT_GAP) / (dots.length + DOT_GAP / Math.max(DOT_MAX, 1)))
      setDotSize(Math.max(DOT_MIN, Math.min(DOT_MAX, fit)))
    }
    const attach = () => {
      if (cancelled) return
      const el = scrollContainerRef.current
      if (!el) { raf = requestAnimationFrame(attach); return }
      apply()
      ro = new ResizeObserver(apply)
      ro.observe(el)
    }
    attach()
    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [scrollContainerRef, dots.length])

  // Если полоса скроллится (точек больше, чем влезает) — держим активную
  // точку в поле зрения. Ручной расчёт (не scrollIntoView — тот может
  // дёрнуть и внешние скролл-контейнеры).
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    let idx = -1
    for (let i = 0; i < dots.length; i++) {
      if (dots[i].origIndex <= activeOrigIndex) idx = i
      else break
    }
    if (idx < 0) return
    const dot = el.children[idx] as HTMLElement | undefined
    if (!dot) return
    const target = dot.offsetTop + dot.offsetHeight / 2 - el.clientHeight / 2
    if (Math.abs(el.scrollTop - target) > 4) {
      el.scrollTo({ top: Math.max(target, 0), behavior: 'smooth' })
    }
  }, [activeOrigIndex, dots])

  const handleClick = useCallback((origIndex: number) => {
    // Сброс pinned ДО scrollToIndex — иначе rAF-loop автоскролла мгновенно
    // вернёт ленту к низу, и прыжок к выбранному сообщению не виден.
    onJumpRef.current?.()
    virtualizer.scrollToIndex(origIndex, { align: 'center', behavior: 'auto' })
  }, [virtualizer])

  // ── Хендлеры ховера точки / превью / панели ──────────────────────────────
  const handleDotEnter = (origIndex: number, clientY: number) => {
    clearTimers()
    setHover({ origIndex, clientY })
    // Держим курсор на точке дольше PANEL_OPEN_DELAY → панель «все сообщения».
    tOpen.current = window.setTimeout(() => {
      setPanelY(clientY)
      setPanelAutoFocus(false)
      setPanelOpen(true)
    }, PANEL_OPEN_DELAY)
  }
  const handleDotLeave = () => {
    clearTimeout(tOpen.current)
    // Grace: успеть дойти курсором до превью (соседние строки кликабельны).
    tHover.current = window.setTimeout(() => setHover(null), HOVER_GRACE)
    schedulePanelClose()
  }
  const handlePreviewEnter = () => {
    clearTimeout(tHover.current)
    cancelPanelClose()
  }
  const handlePreviewLeave = () => {
    setHover(null)
    schedulePanelClose()
  }
  const handleMenuClick = (e: React.MouseEvent) => {
    clearTimers()
    if (panelOpen) {
      setPanelOpen(false)
      return
    }
    setPanelY(e.clientY)
    setPanelAutoFocus(true)
    setPanelOpen(true)
  }

  if (!enabled || dots.length < MIN_MESSAGES || !hasOverflow) return null

  // Активная точка — ближайшая сверху к активному origIndex (активным может
  // оказаться псевдо-сообщение без точки — тогда подсвечиваем предыдущую).
  let activeDotIdx = -1
  for (let i = 0; i < dots.length; i++) {
    if (dots[i].origIndex <= activeOrigIndex) activeDotIdx = i
    else break
  }

  const hoverMsg = hover ? messages[hover.origIndex] : null

  // Соседи для превью «окно ±1»: ближайшее реальное сообщение в направлении
  // (между ними могут быть псевдо-сообщения — их пропускаем).
  const nearestReal = (from: number, dir: -1 | 1) => {
    let i = from + dir
    while (i >= 0 && i < messages.length) {
      if (!PSEUDO_IDS.has(messages[i].id)) return { origIndex: i, msg: messages[i] }
      i += dir
    }
    return null
  }
  const prevReal = hover ? nearestReal(hover.origIndex, -1) : null
  const nextReal = hover ? nearestReal(hover.origIndex, 1) : null

  return (
    <>
    <div className="chat-minimap" style={{ maxHeight: `${STRIP_MAX_RATIO * 100}%` }}>
      {/* Кнопка-лупа: клик — панель «все сообщения» (поиск + сортировка). */}
      <button
        type="button"
        className={[
          'chat-minimap-menu-btn',
          panelOpen ? 'chat-minimap-menu-btn--active' : ''
        ].filter(Boolean).join(' ')}
        onClick={handleMenuClick}
        aria-label="Все сообщения (поиск и сортировка)"
        title="Все сообщения — поиск и сортировка"
      >
        <Search size={11} strokeWidth={2.5} />
      </button>
      <div className="chat-minimap-strip" ref={stripRef}>
        {dots.map((d, i) => (
          <motion.button
            key={d.id}
            type="button"
            className={[
              'chat-minimap-dot',
              `chat-minimap-dot--${d.role}`,
              i === activeDotIdx ? 'chat-minimap-dot--active' : '',
            ].filter(Boolean).join(' ')}
            style={{ width: dotSize, height: dotSize, '--dot-size': `${dotSize}px` } as React.CSSProperties}
            onClick={() => handleClick(d.origIndex)}
            onMouseEnter={e => handleDotEnter(d.origIndex, e.clientY)}
            onMouseLeave={handleDotLeave}
            aria-label={`Сообщение ${i + 1} из ${dots.length}`}
            whileHover={whileHoverTiny}
            whileTap={whileTapTiny}
            transition={springHover}
          />
        ))}
      </div>
    </div>

    {/* Превью «окно ±1» при ховере на точку (панель открыта — превью скрыто).
        Рендерим ВНЕ .chat-minimap: у контейнера transform + flex — fixed-потомок
        клипился бы. position: fixed — не клипается overflow родителя. */}
    {hover && hoverMsg && !panelOpen && (
      <div
        key={hover.origIndex}
        className="chat-minimap-preview"
        style={{ top: Math.min(Math.max(hover.clientY - 60, 8), window.innerHeight - 240) }}
        onMouseEnter={handlePreviewEnter}
        onMouseLeave={handlePreviewLeave}
      >
        {prevReal && (
          <button
            type="button"
            className="chat-minimap-preview-sibling"
            onClick={() => handleClick(prevReal.origIndex)}
          >
            <span className={`chat-minimap-preview-role chat-minimap-preview-role--${prevReal.msg.role}`}>
              {roleLabel(prevReal.msg.role)}
            </span>
            <span className="chat-minimap-preview-sibling-text">
              {snippet(prevReal.msg.content) || '[вложение]'}
            </span>
          </button>
        )}
        <button
          type="button"
          className="chat-minimap-preview-main"
          onClick={() => handleClick(hover.origIndex)}
        >
          <span className="chat-minimap-preview-head">
            <span className={`chat-minimap-preview-role chat-minimap-preview-role--${hoverMsg.role}`}>
              {roleLabel(hoverMsg.role)}
            </span>
            <span className="chat-minimap-preview-time">{formatTime(hoverMsg.createdAt)}</span>
          </span>
          <span className="chat-minimap-preview-text">
            {snippet(hoverMsg.content) || '[вложение]'}
          </span>
        </button>
        {nextReal && (
          <button
            type="button"
            className="chat-minimap-preview-sibling"
            onClick={() => handleClick(nextReal.origIndex)}
          >
            <span className={`chat-minimap-preview-role chat-minimap-preview-role--${nextReal.msg.role}`}>
              {roleLabel(nextReal.msg.role)}
            </span>
            <span className="chat-minimap-preview-sibling-text">
              {snippet(nextReal.msg.content) || '[вложение]'}
            </span>
          </button>
        )}
      </div>
    )}

    {/* Панель «все сообщения»: поиск + сортировка + список. */}
    {panelOpen && (
      <ChatMinimapPanel
        messages={messages}
        activeOrigIndex={activeOrigIndex}
        anchorY={panelY}
        onJump={origIndex => {
          handleClick(origIndex)
          setPanelOpen(false)
        }}
        onClose={() => {
          clearTimers()
          setPanelOpen(false)
        }}
        onMouseEnter={cancelPanelClose}
        onMouseLeave={schedulePanelClose}
        autoFocus={panelAutoFocus}
      />
    )}
    </>
  )
}

export default memo(ChatMinimap)
