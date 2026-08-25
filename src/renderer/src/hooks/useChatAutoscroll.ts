import { useCallback, useEffect, useRef, useState } from 'react'

// ── Умный плавный автоскролл чата ───────────────────────────────────────────
// Модель «прилип/отлип» (как в ChatGPT):
//   • pinnedRef=true («прилип» к низу) — rAF-loop догоняет низ шагом
//     clamp(diff × 0.22, 1.5, 90px): экспоненциальное сближение с капом
//     скорости, БЕЗ телепортов.
//   • Loop работает ТОЛЬКО когда isStreaming=true (идёт стрим ответа).
//     Не стримит → loop мёртв → 0% CPU. Стримит → плавный доскролл.
//   • Отлип: колесо вверх / touch-drag вверх — мгновенно; перетаскивание
//     скроллбара — по уменьшению scrollTop в handleScroll (наши записи его
//     только увеличивают, поэтому уменьшение = пользователь).
//   • Прилип обратно: только когда пользователь ДВИЖЕТСЯ ВНИЗ и доехал до
//     низа (dist < 8px).
//   • Плюс явный pin(): отправка запроса, кнопка «вниз», смена чата.
//     pin(instant=true) — мгновенный прыжок (смена чата, первая загрузка,
//     кнопка «вниз»), работает даже без стрима. После прыжка окно STICK_MS
//     действует «липкий низ»: виртуализатор перемеряет высоты рядов
//     (RO/KaTeX/Mermaid/картинки) уже ПОСЛЕ прыжка, низ «уезжает» вниз —
//     stick-loop каждый кадр дожимает scrollTop к низу, иначе после
//     однократного прыжка пользователь оказывается посреди чата.
//
// Защита от ложного отлипа при СЖАТИИ контента: если scrollHeight уменьшился
// (схлопнулся шаг/картинка), Chromium клампит scrollTop вниз и стреляет
// scroll-событие с уменьшением — такое событие игнорируем (sh < prevSh − 1).

const REPIN_DIST = 8    // px от низа — прилип при ручном доезде
const BTN_DIST = 24     // px от низа — порог показа floating-кнопки «вниз»
const MAX_STEP = 90     // px/кадр — кап скорости догона (без телепортов)
const SMOOTH_FACTOR = 0.22 // доля отставания за кадр (быстрый отклик)
const MIN_STEP = 1.5    // px/кадр — минимальный шаг, чтобы не залипать
const STICK_MS = 700    // мс «липкого низа» после мгновенного прыжка pin(true)

export interface UseChatAutoscrollOptions {
  /** Скролл-контейнер ленты (.chat-messages). */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  /** Доп. логика в rAF-throttled scroll-хендлере (догрузка старых у верха). */
  onScrollExtra?: () => void
  /** Идёт ли стриминг ответа. Loop работает ТОЛЬКО когда true → 0% CPU в idle. */
  isStreaming?: boolean
}

export interface ChatAutoscroll {
  /** true = «прилип» к низу. Менять снаружи только через pin()/handleWheel. */
  pinnedRef: React.MutableRefObject<boolean>
  showScrollDownBtn: boolean
  setShowScrollDownBtn: (v: boolean) => void
  /** Закрепить и доехать до низа. instant=true — мгновенный прыжок
   *  (отправка запроса, смена чата, первая загрузка, кнопка «вниз»)
   *  + окно «липкого низа» STICK_MS: дожимает низ, пока виртуализатор
   *  перемеряет высоты рядов после прыжка. */
  pin: (instant?: boolean) => void
  /** Отлепить от низа (pinned=false). Гасит rAF-loop догона — нужно при
   *  среднем клике колесика (браузерный autoscroll-жест) и при прыжке по
   *  минимапе, иначе loop мгновенно тащит обратно к низу. */
  unpin: () => void
  /** Мгновенный скролл к низу без смены pinned (для initial-scroll). */
  scrollToBottomInstant: () => void
  /** Перечитать scrollTop/scrollHeight в refs после ВНЕШНЕЙ записи scrollTop
   *  (prepend-компенсация старых сообщений) — иначе handleScroll воспримет
   *  её как пользовательский скролл. */
  syncScrollState: () => void
  handleScroll: () => void
  handleWheel: (e: React.WheelEvent<HTMLDivElement>) => void
  /** Средний клик колесика (button===1) → отлеп. Браузерный autoscroll-жест
   *  (кружок-курсор) сам по себе работает, но пока pinned=true rAF-loop
   *  каждый кадр тащит обратно к низу — жест «багается». preventDefault НЕ
   *  зовём: нам нужен сам жест, только гасим loop. */
  handleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
  handleTouchStart: (e: React.TouchEvent<HTMLDivElement>) => void
  handleTouchMove: (e: React.TouchEvent<HTMLDivElement>) => void
}

export function useChatAutoscroll({ scrollContainerRef, onScrollExtra, isStreaming = false }: UseChatAutoscrollOptions): ChatAutoscroll {
  const pinnedRef = useRef(true)
  const [showScrollDownBtn, setShowScrollDownBtn] = useState(false)

  const rafRef = useRef<number | null>(null)
  const scrollPendingRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const lastScrollHeightRef = useRef(0)
  const touchYRef = useRef<number | null>(null)
  const isStreamingRef = useRef(isStreaming)
  const stickRafRef = useRef<number | null>(null)
  const stickUntilRef = useRef(0)

  // Свежая ссылка на onScrollExtra без пересоздания handleScroll.
  const onScrollExtraRef = useRef(onScrollExtra)
  useEffect(() => { onScrollExtraRef.current = onScrollExtra })

  // rAF-loop догона: работает ТОЛЬКО когда isStreaming=true AND pinned.
  // Не стримит → loop мёртв → 0% CPU. Стримит → плавный доскролл.
  const tickRef = useRef<() => void>(() => {})
  useEffect(() => {
    tickRef.current = () => {
      rafRef.current = null
      if (!pinnedRef.current || !isStreamingRef.current) return
      const el = scrollContainerRef.current
      if (!el) return
      const target = el.scrollHeight - el.clientHeight
      const current = el.scrollTop
      const diff = target - current
      if (diff > 0.5) {
        const step = Math.min(Math.max(diff * SMOOTH_FACTOR, MIN_STEP), MAX_STEP, diff)
        el.scrollTop = current + step
        lastScrollTopRef.current = el.scrollTop
        lastScrollHeightRef.current = el.scrollHeight
        // Контент растёт — плавный доскролл на следующем кадре
        rafRef.current = requestAnimationFrame(() => tickRef.current())
      } else {
        // Контент стоит — проверяем реже (100мс вместо 16мс).
        // 2 forced layouts/100мс = 20/сек вместо 120/сек (6× меньше).
        rafRef.current = window.setTimeout(
          () => tickRef.current(), 100
        ) as unknown as number
      }
    }
  }, [scrollContainerRef])

  const ensureLoop = useCallback(() => {
    // Loop запускается только если стримит. Не стримит — мгновенный прыжок
    // в pin(instant=true) уже сделал свою работу, loop не нужен.
    if (rafRef.current === null && isStreamingRef.current) {
      rafRef.current = requestAnimationFrame(() => tickRef.current())
    }
  }, [])

  // ── «Липкий низ» после мгновенного прыжка ────────────────────────────────
  // pin(instant=true) прыгает в низ, но в момент прыжка scrollHeight посчитан
  // по estimateSize-оценкам виртуализатора (кэш высот сброшен при смене чата).
  // Реальные высоты рядов приходят позже (ResizeObserver/KaTeX/Mermaid/картинки)
  // → totalSize растёт → низ «уезжает» вниз, а scrollTop стоит — пользователь
  // оказывается ПОСЕРЕДИНЕ чата. Stick-loop держит низ окно STICK_MS после
  // прыжка, дожимая scrollTop каждый кадр. Отмена автоматическая: любое
  // отлипание (колесо вверх, минимапа, средний клик) ставит pinnedRef=false →
  // loop умирает на следующем кадре.
  const stickTickRef = useRef<() => void>(() => {})
  useEffect(() => {
    stickTickRef.current = () => {
      stickRafRef.current = null
      if (!pinnedRef.current) return
      if (performance.now() > stickUntilRef.current) return
      const el = scrollContainerRef.current
      if (!el) return
      const target = el.scrollHeight - el.clientHeight
      if (el.scrollTop < target - 1) {
        el.scrollTop = target
        // Наша запись scrollTop — синхронизируем refs, иначе handleScroll
        // воспримет её как пользовательский скролл.
        lastScrollTopRef.current = el.scrollTop
        lastScrollHeightRef.current = el.scrollHeight
      }
      stickRafRef.current = requestAnimationFrame(() => stickTickRef.current())
    }
  }, [scrollContainerRef])

  const ensureStickLoop = useCallback(() => {
    if (stickRafRef.current === null) {
      stickRafRef.current = requestAnimationFrame(() => stickTickRef.current())
    }
  }, [])

  // Старт/стоп loop при смене isStreaming.
  useEffect(() => {
    isStreamingRef.current = isStreaming
    if (isStreaming && pinnedRef.current) {
      ensureLoop()
    } else if (!isStreaming) {
      // Стрим закончился — убиваем loop. rafRef может содержать либо
      // requestAnimationFrame id, либо setTimeout id (idle-режим).
      // cancelAnimationFrame + clearTimeout — оба no-op для чужого типа.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        clearTimeout(rafRef.current)
        rafRef.current = null
      }
    }
  }, [isStreaming, ensureLoop])

  // Очистка при размонтировании.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        clearTimeout(rafRef.current)
        rafRef.current = null
      }
      if (stickRafRef.current !== null) {
        cancelAnimationFrame(stickRafRef.current)
        stickRafRef.current = null
      }
    }
  }, [])

  const scrollToBottomInstant = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight - el.clientHeight
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
  }, [scrollContainerRef])

  const syncScrollState = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
  }, [scrollContainerRef])

  const pin = useCallback((instant = false) => {
    pinnedRef.current = true
    setShowScrollDownBtn(false)
    // instant=true — мгновенный прыжок (смена чата, отправка, первая загрузка,
    // кнопка «вниз»). Не стримит — тоже мгновенный прыжок: rAF-loop догона
    // мёртв в idle (оптимизация 0% CPU), поэтому кнопка «вниз» без этого
    // не двигала скролл.
    if (instant || !isStreamingRef.current) {
      scrollToBottomInstant()
      // «Липкий низ»: виртуализатор перемеряет высоты рядов уже ПОСЛЕ
      // прыжка (RO/KaTeX/Mermaid), низ уедет вниз — stick-loop дожимает
      // его окно STICK_MS, иначе приземлимся посреди чата.
      stickUntilRef.current = performance.now() + STICK_MS
      ensureStickLoop()
    }
    ensureLoop()
  }, [ensureLoop, ensureStickLoop, scrollToBottomInstant])

  const unpin = useCallback(() => {
    pinnedRef.current = false
    // Гасим stick-loop немедленно (иначе один кадр ещё потянет к низу).
    if (stickRafRef.current !== null) {
      cancelAnimationFrame(stickRafRef.current)
      stickRafRef.current = null
    }
    setShowScrollDownBtn(true)
  }, [])

  // Средний клик колесика → отлеп (браузерный autoscroll-жест не должен
  // конкурировать с rAF-loop'ом догона). preventDefault НЕ зовём — жест нужен.
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button === 1) unpin()
  }, [unpin])

  const handleScroll = useCallback(() => {
    if (scrollPendingRef.current) return
    scrollPendingRef.current = true
    requestAnimationFrame(() => {
      scrollPendingRef.current = false
      onScrollExtraRef.current?.()
      const el = scrollContainerRef.current
      if (!el) return
      const st = el.scrollTop
      const sh = el.scrollHeight
      const prevSt = lastScrollTopRef.current
      const prevSh = lastScrollHeightRef.current
      lastScrollTopRef.current = st
      lastScrollHeightRef.current = sh

      const hasScroll = sh - el.clientHeight > BTN_DIST
      if (!hasScroll) {
        setShowScrollDownBtn(false)
        return
      }
      const dist = sh - st - el.clientHeight

      // Движение ВНИЗ + доехали до низа — прилип (только ручной доезд:
      // у низа больше нет перезакрепления «по любому событию»).
      if (st > prevSt + 0.5 && dist < REPIN_DIST) {
        pinnedRef.current = true
        setShowScrollDownBtn(false)
        ensureLoop()
        return
      }
      // Движение ВВЕРХ не из-за сжатия контента — отлип.
      if (st < prevSt - 2 && sh >= prevSh - 1) {
        pinnedRef.current = false
        setShowScrollDownBtn(true)
        return
      }
      // Кнопка «вниз»: видна когда отлипли и не у низа.
      if (!pinnedRef.current && dist > BTN_DIST) setShowScrollDownBtn(true)
      else if (dist < BTN_DIST && pinnedRef.current) setShowScrollDownBtn(false)
    })
  }, [ensureLoop, scrollContainerRef])

  // Колесо вверх → мгновенный отлип (не ждём scroll-событие).
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0 && pinnedRef.current) {
      pinnedRef.current = false
      setShowScrollDownBtn(true)
    }
  }, [])

  // Touch: палец тянет ВНИЗ (контент скроллится вверх) → отлип.
  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    touchYRef.current = e.touches[0]?.clientY ?? null
  }, [])
  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const startY = touchYRef.current
    if (startY === null) return
    const y = e.touches[0]?.clientY
    if (y !== undefined && y > startY + 6 && pinnedRef.current) {
      pinnedRef.current = false
      setShowScrollDownBtn(true)
    }
  }, [])

  return {
    pinnedRef,
    showScrollDownBtn,
    setShowScrollDownBtn,
    pin,
    unpin,
    scrollToBottomInstant,
    syncScrollState,
    handleScroll,
    handleWheel,
    handleMouseDown,
    handleTouchStart,
    handleTouchMove,
  }
}
