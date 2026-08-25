import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react'
import { useChatStore } from '../../../store/chat.store'
import './ThinkingBlock.css'

interface ThinkingBlockProps {
  text?: string
  liveText?: string
  thinkingMs?: number
  isLive?: boolean
  /** chatId для чтения thinking-текста напрямую из Zustand store.
   *  Когда задан (live-пузырь), ThinkingBlock подписывается на
   *  liveByChat[storeChatId].thinking — ре-рендерится САМ, а не
   *  через проп liveText, который менял бы ссылку liveThinking в
   *  ChatPage → MessageContent ре-рендерился 20×/сек. */
  storeChatId?: string
}

const THINKING_WORDS = [
  'Думаю', 'Анализирую', 'Размышляю', 'Планирую',
  'Обдумываю', 'Исследую', 'Взвешиваю', 'Формулирую',
]

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}мс`
  return `${(ms / 1000).toFixed(1)}с`
}

// ── Хедер (иконка + слово + время + chevron) ──────────────────────────
// Вынесен в отдельный memo-компонент: таймеры elapsed (100мс) и ротация
// слов (2с) живут здесь и ре-рендерят только крошечный хедер, а не всё
// тело с N строками reasoning. Визуально идентично — те же узлы, те же
// интервалы, та же анимация.
const ThinkingHeader = memo(function ThinkingHeader({
  isLive, thinkingMs, open, onToggle,
}: {
  isLive?: boolean
  thinkingMs?: number
  open: boolean
  onToggle: () => void
}) {
  const [elapsed, setElapsed] = useState(0)
  const [wordIdx, setWordIdx] = useState(0)
  const [wordVisible, setWordVisible] = useState(true)
  const startRef = useRef<number>(Date.now())
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const wordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (isLive) {
      startRef.current = Date.now()
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed(Date.now() - startRef.current), 100)
      wordTimerRef.current = setInterval(() => {
        setWordVisible(false)
        setTimeout(() => {
          setWordIdx(i => (i + 1) % THINKING_WORDS.length)
          setWordVisible(true)
        }, 250)
      }, 2000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
      if (wordTimerRef.current) clearInterval(wordTimerRef.current)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (wordTimerRef.current) clearInterval(wordTimerRef.current)
    }
  }, [isLive])

  const displayMs = thinkingMs ?? (isLive ? elapsed : undefined)
  const label = isLive ? THINKING_WORDS[wordIdx] : 'Размышление'
  const timeStr = displayMs !== undefined ? ` · ${formatMs(displayMs)}` : ''

  return (
    <button className="tb-header" onClick={onToggle}>

      {/* Иконка — три точки live / искра done */}
      <span className="tb-icon">
        {isLive ? (
          <span className="tb-dots"><span /><span /><span /></span>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"
              stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"/>
            <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"
              stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round"/>
          </svg>
        )}
      </span>

      {/* Текст — переливание слева направо в live режиме */}
      <span className={`tb-label ${isLive ? 'tb-label--live' : ''}`}>
        <span className={`tb-word ${wordVisible ? 'tb-word--in' : 'tb-word--out'}`}>
          {label}
        </span>
        <span className="tb-time">{timeStr}</span>
      </span>

      {/* Стрелка раскрытия */}
      <span className={`tb-chevron ${open ? 'tb-chevron--open' : ''}`}>
        <svg width="10" height="10" viewBox="0 0 10 6" fill="none">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>
    </button>
  )
})

// В live-режиме рендерим только хвост reasoning. Тело и так в скролл-
// контейнере 260px с автоскроллом к низу — пользователь видит только
// последние строки. Полный текст рендерится при isLive=false (когда блок
// авто-сворачивается). Стоимость React-консиляции, DOM, layout и paint-
// слоя шиммера перестаёт расти с длиной reasoning — становится константной.
// Визуально неотличимо: шиммер, курсор, автоскролл — всё на месте.
const LIVE_TAIL_CHARS = 5000 // ~50–75 строк
const PERSISTED_TAIL_CHARS = 24000 // ~240 строк (cap для длинных persisted)

const ThinkingBlock = memo(function ThinkingBlock({ text, liveText, thinkingMs, isLive, storeChatId }: ThinkingBlockProps) {
  // ── Прямая подписка на store для live-thinking текста ──────────────
  // Раньше ChatPage передавал liveThinking={ text: live.thinking, ... }
  // — НОВЫЙ объект каждые 50мс → VirtualMessageItem memo FAIL →
  // MessageContent ре-рендерился 20×/сек (тяжёлый компонент).
  // Теперь liveThinking стабилен (без text), а ThinkingBlock сам читает
  // thinking из store по storeChatId. Селектор возвращает строку →
  // Zustand сравнивает по Object.is → ре-рендерится ТОЛЬКО ThinkingBlock.
  const storeThinking = useChatStore(s =>
    storeChatId ? s.liveByChat[storeChatId]?.thinking : undefined
  )

  // Live-блок (стримится сейчас) — открыт сразу при монтировании.
  // Persisted-блок (из БД) — свёрнут по умолчанию, раскрывается по клику.
  const [open, setOpen] = useState(!!isLive)
  const bodyRef = useRef<HTMLDivElement>(null)
  const prevLiveRef = useRef<boolean>(!!isLive)
  // Запоминаем, что пользователь сам закрыл/открыл — не перебиваем его выбор
  const userToggledRef = useRef(false)

  // Авто-раскрытие при начале стриминга — блок открывается СРАЗУ когда
  // isLive переходит в true, не дожидаясь текста (раньше проверяли
  // liveText, но он убран — ThinkingBlock читает текст из store).
  // Юзер видит хедер «Думаю…» + курсор, текст появляется через ~50мс.
  useEffect(() => {
    if (isLive && !userToggledRef.current) {
      setOpen(true)
    }
  }, [isLive])

  // Авто-сворачивание при завершении стриминга (переход true → false)
  useEffect(() => {
    if (prevLiveRef.current && !isLive) {
      setOpen(false)
      userToggledRef.current = false
    }
    prevLiveRef.current = !!isLive
  }, [isLive])

  // displayText: приоритет store (live) > liveText (legacy) > text (persisted).
  // storeThinking читается из Zustand — обновляется каждые 50мс, но
  // ре-рендерит только ThinkingBlock, а не всю цепочку MessageContent.
  const displayText = (storeChatId && storeThinking != null)
    ? storeThinking
    : typeof liveText === 'string' ? liveText : typeof text === 'string' ? text : ''

  // Автоскролл текста при стриминге
  useEffect(() => {
    if (open && isLive && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [displayText, open, isLive])

  // Мемоизируем split — раньше .split('\n').map() на каждом рендере (а рендер
  // происходит на каждом токене стрима — 50мс). Теперь только при смене текста.
  // В live-режиме берём только хвост (~8000 символов) — стоимость перестаёт
  // расти с длиной reasoning. useMemo ДО early return (Rules of Hooks).
  const lines = useMemo(() => {
    const maxChars = isLive ? LIVE_TAIL_CHARS : PERSISTED_TAIL_CHARS
    if (displayText.length <= maxChars) {
      return displayText.split('\n')
    }
    const cut = displayText.lastIndexOf('\n', displayText.length - maxChars)
    return displayText.slice(cut + 1).split('\n')
  }, [displayText, isLive])

  // useCallback — стабильная ссылка для memo-сравнения ThinkingHeader.
  // Без этого хедер ре-рендерился бы на каждый 50мс-флаш токенов.
  // ДО early return (Rules of Hooks).
  const handleToggle = useCallback(() => {
    userToggledRef.current = true
    setOpen(v => !v)
  }, [])

  if (!displayText && !isLive) return null

  return (
    <div className={`tb ${isLive ? 'tb--live' : 'tb--done'} ${open ? 'tb--open' : ''}`}>

      {/* Заголовок — кликабельный (таймеры изолированы в ThinkingHeader) */}
      <ThinkingHeader isLive={isLive} thinkingMs={thinkingMs} open={open} onToggle={handleToggle} />

      {/* Раскрытый текст — только при open. Раньше framer-motion
          делал {open && <motion.div>}. CSS grid замена сломала это:
          body был ВСЕГДА в DOM (grid 0fr схлопывал высоту, но узлы
          создавались → 250+ невидимых узлов при скролле → лаги 144Hz).
          Теперь: условный рендер + CSS opacity animation на mount.
          Свёрнутый блок = 0 body-узлов (только хедер ~8 узлов). */}
      {open && (
        <div className={`tb-body ${isLive ? 'tb-body--live' : ''}`}>
          <div className="tb-body-inner" ref={bodyRef}>
            <div className="tb-text">
              {lines.map((line, i) => (
                <p key={i} className={line.trim() === '' ? 'tb-line--empty' : 'tb-line'}>
                  {line || '\u00A0'}
                </p>
              ))}
            </div>
            {isLive && <span className="tb-cursor" />}
          </div>
        </div>
      )}
    </div>
  )
})

export default ThinkingBlock