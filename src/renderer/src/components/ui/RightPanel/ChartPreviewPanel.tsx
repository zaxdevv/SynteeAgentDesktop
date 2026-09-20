import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChartPreviewStore } from '../../../store/chartPreview.store'
import { parseChart, AxisChart, PieChart } from '../MessageBubble/ChartBlock'
import { svgCache, getMermaid } from '../MessageBubble/MermaidBlock'
import { downloadSvgAsPng } from '../../../utils/downloadSvg'
import AppIcon from '../AppIcon/AppIcon'
import './ChartPreviewPanel.css'

// ── Панель просмотра графиков/диаграмм (таб 'chart' правой панели) ────────
// Объекты (```chart JSON-спеки и mermaid-диаграммы) открываются сюда кнопкой
// ⤢ на блоке в чате. 2D-навигация:
//   • колесо — zoom к позиции курсора (0.2×–6×);
//   • drag — панорамирование (grab/grabbing);
//   • двойной клик — сброс к 100% + центрирование;
//   • кнопки −/+/сброс в тулбаре.
//
// ── Почему зум меняет width, а НЕ transform:scale ──
// transform:scale (+ will-change) растеризует композитный слой ОДИН раз в
// исходном размере — GPU растягивает растр, SVG становится мыльным/пиксельным
// (лечилось только перемонтированием панели). Меняя реальную width контента,
// мы заставляем Chromium переложить и перерастеризовать SVG в новом размере —
// вектор остаётся чётким на любом зуме. Pan остаётся translate (дёшево).
//
// ── Почему wheel — нативный listener ──
// React onWheel пассивен: preventDefault не работает, и ctrl+wheel (пинч
// тачпада) зумил страницу браузера поверх приложения. Нативный non-passive
// listener гасит и скролл, и browser-zoom.
//
// Зум пропорционален deltaY (exp-шкала): тачпад (мелкие частые события)
// даёт плавное нарастание, колесо мыши — шаг ~15%. События коалесцируются
// в один rAF-кадр (тачпад шлёт 60+/сек — без этого 60 setState/сек).

const ZOOM_MIN = 0.2
const ZOOM_MAX = 6
/** Базовая ширина контента при zoom=1 (px). */
const BASE_W = 680
/** Чувствительность: pixel-delta (тачпад/колесо) и line-delta (Firefox). */
const WHEEL_SENS_PIXEL = 0.0016
const WHEEL_SENS_LINE = 0.12
/** Постоянная рамка контента (padding 16 + border 1 — см. .cpp-content в CSS).
 *  Не масштабируется с зумом — учитываем в zoom-to-cursor, иначе точка под
 *  курсором «уплывает» на PAD·(k−1) за шаг. */
const CONTENT_PAD = 17

let previewIdCounter = 0

export default function ChartPreviewPanel() {
  const preview = useChartPreviewStore(s => s.preview)

  // ── Единое состояние вида: zoom + pan ──
  // Один set() на жест. Раньше setPan вызывался ВНУТРИ апдейтера setZoom —
  // нечистый апдейтер (StrictMode двойной вызов → pan уезжал вдвое).
  const [view, setView] = useState({ z: 1, x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const panStart = useRef({ x: 0, y: 0 })
  const panOrigin = useRef({ x: 0, y: 0 })
  // Пользователь трогал вид (pan/zoom) — не рецентрируем при resize.
  const interacted = useRef(false)
  // rAF-коалесценция wheel: накопленный фактор + последняя позиция курсора.
  const pendingWheel = useRef<{ factor: number; mx: number; my: number } | null>(null)
  const wheelRaf = useRef(0)

  // ── Mermaid SVG (асинхронный рендер) / chart-спека ──
  const [mermaidSvg, setMermaidSvg] = useState('')
  const [mermaidError, setMermaidError] = useState<string | null>(null)

  // Парсинг спеки — useMemo: без него jsonrepair гонялся на КАЖДОМ рендере
  // панели (включая каждый кадр зума).
  const chartParsed = useMemo(
    () => (preview?.kind === 'chart' ? parseChart(preview.code) : undefined),
    [preview],
  )

  // Центрирование контента во вьюпорте при zoom=1.
  const centerView = useCallback(() => {
    const vp = viewportRef.current
    const c = contentRef.current
    if (!vp || !c) return
    setView({
      z: 1,
      x: (vp.clientWidth - c.offsetWidth) / 2,
      y: (vp.clientHeight - c.offsetHeight) / 2,
    })
  }, [])

  // Новый объект → сброс вида. Центрирование — двойным rAF (после того как
  // контент отрендерился и layout посчитался). Плюс ResizeObserver на
  // контенте: mermaid-SVG приходит асинхронно (высота меняется) — до
  // первого взаимодействия рецентрируем.
  useEffect(() => {
    interacted.current = false
    setView({ z: 1, x: 0, y: 0 })
    setMermaidSvg('')
    setMermaidError(null)
    const raf = requestAnimationFrame(() => requestAnimationFrame(centerView))
    return () => cancelAnimationFrame(raf)
  }, [preview, centerView])

  useEffect(() => {
    const c = contentRef.current
    if (!c) return
    const ro = new ResizeObserver(() => { if (!interacted.current) centerView() })
    ro.observe(c)
    return () => ro.disconnect()
  }, [preview, centerView])

  // Рецентрирование при resize вьюпорта (панель ресайзят/разворачивают),
  // пока пользователь не трогал вид. preview в deps — та же причина, что у
  // wheel-листенера: при монтировании в empty-state вьюпорта ещё нет.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const ro = new ResizeObserver(() => { if (!interacted.current) centerView() })
    ro.observe(vp)
    return () => ro.disconnect()
  }, [centerView, preview])

  // ── Zoom: применить фактор вокруг точки (mx, my) вьюпорта ──
  // Точка контента под курсором остаётся на месте: смещение внутри SVG
  // s = (m − x − PAD) масштабируется как s·k, рамка PAD — константа:
  //   x' = mx − PAD − (mx − x − PAD)·k,  где k = z'/z.
  const applyZoomAt = useCallback((factor: number, mx: number, my: number) => {
    setView(v => {
      const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.z * factor))
      if (z === v.z) return v
      const k = z / v.z
      return {
        z,
        x: mx - CONTENT_PAD - (mx - v.x - CONTENT_PAD) * k,
        y: my - CONTENT_PAD - (my - v.y - CONTENT_PAD) * k,
      }
    })
  }, [])

  // ── Нативный non-passive wheel: zoom к курсору, rAF-коалесценция ──
  // deps включает preview: панель может смонтироваться в empty-state
  // (таб открыт из меню «+» / восстановлен после перезапуска) — тогда
  // viewportRef.current = null и листенер не вешается. Когда preview
  // появляется, эффект перевешивается на реальный элемент. Без этого
  // колесо молча не работало до перемонтирования панели.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // Гасим скролл и browser page-zoom (ctrl+wheel = пинч тачпада).
      e.preventDefault()
      // Пропорциональный зум: мелкие тачпад-дельты дают мелкие шаги,
      // колесо (±100 px / ±3 line) — шаг ~15%. Раньше фикс. 0.9/1.1
      // на событие: тачпад зумил слишком резко и «улетал».
      const sens = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_SENS_LINE : WHEEL_SENS_PIXEL
      const factor = Math.exp(-e.deltaY * sens)
      const rect = el.getBoundingClientRect()
      const p = pendingWheel.current ?? { factor: 1, mx: 0, my: 0 }
      p.factor *= factor
      p.mx = e.clientX - rect.left
      p.my = e.clientY - rect.top
      pendingWheel.current = p
      if (wheelRaf.current) return
      wheelRaf.current = requestAnimationFrame(() => {
        wheelRaf.current = 0
        const w = pendingWheel.current
        pendingWheel.current = null
        if (!w) return
        interacted.current = true
        applyZoomAt(w.factor, w.mx, w.my)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (wheelRaf.current) { cancelAnimationFrame(wheelRaf.current); wheelRaf.current = 0 }
      pendingWheel.current = null
    }
  }, [applyZoomAt, preview])

  // ── Панорамирование drag'ом (ЛКМ) ──
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    setIsPanning(true)
    interacted.current = true
    panStart.current = { x: e.clientX, y: e.clientY }
    panOrigin.current = { x: view.x, y: view.y }
  }, [view.x, view.y])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return
    const dx = e.clientX - panStart.current.x
    const dy = e.clientY - panStart.current.y
    setView(v => ({ ...v, x: panOrigin.current.x + dx, y: panOrigin.current.y + dy }))
  }, [isPanning])

  const stopPanning = useCallback(() => setIsPanning(false), [])

  // ── Сброс: zoom=1 + центрирование (двойной rAF — контент сначала
  // переложится к BASE_W, потом меряем) ──
  const resetView = useCallback(() => {
    interacted.current = false
    setView({ z: 1, x: 0, y: 0 })
    requestAnimationFrame(() => requestAnimationFrame(centerView))
  }, [centerView])

  // Кнопки −/+: зум вокруг центра вьюпорта.
  const zoomBy = useCallback((factor: number) => {
    const vp = viewportRef.current
    if (!vp) return
    interacted.current = true
    applyZoomAt(factor, vp.clientWidth / 2, vp.clientHeight / 2)
  }, [applyZoomAt])

  // Скачать объект как PNG: SVG из контента панели. Зум не влияет на
  // результат — растеризуем в 2× от базового размера (retina-чёткость).
  const handleDownload = useCallback(() => {
    const svg = contentRef.current?.querySelector('svg')
    if (svg instanceof SVGSVGElement) {
      void downloadSvgAsPng(svg, preview.title).catch(() => {})
    }
  }, [preview])

  // ── Mermaid: сначала кэш (мгновенно), иначе рендер ──
  useEffect(() => {
    if (!preview || preview.kind !== 'mermaid') return
    const code = preview.code
    if (svgCache.has(code)) {
      setMermaidSvg(svgCache.get(code)!)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const m = await getMermaid()
        const result = await m.render(`chart-preview-${++previewIdCounter}`, code)
        if (cancelled) return
        setMermaidSvg(result.svg)
      } catch (e) {
        if (!cancelled) setMermaidError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [preview])

  // ── Empty state: таб открыт, но объект не выбран ──
  if (!preview) {
    return (
      <div className="cpp-empty">
        <AppIcon name="chart" size="lg" />
        <p className="cpp-empty-title">Просмотр графика</p>
        <p className="cpp-empty-hint">
          Нажмите <span className="cpp-empty-key">⤢</span> на графике или диаграмме
          в чате — он откроется здесь с возможностью приближать и перемещаться.
        </p>
      </div>
    )
  }

  const title = preview.kind === 'chart'
    ? (preview.title ?? 'График')
    : 'Диаграмма'

  return (
    <div className="cpp-root">
      {/* Тулбар: заголовок + zoom-контролы */}
      <div className="cpp-toolbar">
        <span className="cpp-title" title={title}>{title}</span>
        <div className="cpp-zoom-controls">
          <button className="cpp-zoom-btn" onClick={() => zoomBy(1 / 1.25)} title="Уменьшить">
            <AppIcon name="minus" size="xs" />
          </button>
          <button className="cpp-zoom-label" onClick={resetView} title="Сбросить (100%)">
            {Math.round(view.z * 100)}%
          </button>
          <button className="cpp-zoom-btn" onClick={() => zoomBy(1.25)} title="Увеличить">
            <AppIcon name="plus" size="xs" />
          </button>
          <button className="cpp-zoom-btn" onClick={resetView} title="Сбросить вид">
            <AppIcon name="refreshCw" size="xs" />
          </button>
          <button className="cpp-zoom-btn cpp-zoom-btn--download" onClick={handleDownload} title="Скачать PNG">
            <AppIcon name="download" size="xs" />
          </button>
        </div>
      </div>

      {/* Вьюпорт: 2D-навигация. Контент — абсолютный, зум меняет его width
          (перерастеризация SVG → чёткость), pan — translate. */}
      <div
        ref={viewportRef}
        className={`cpp-viewport ${isPanning ? 'cpp-viewport--panning' : ''}`}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={stopPanning}
        onMouseLeave={stopPanning}
        onDoubleClick={resetView}
      >
        <div
          ref={contentRef}
          className="cpp-content"
          style={{
            width: Math.round(BASE_W * view.z),
            transform: `translate(${view.x}px, ${view.y}px)`,
          }}
        >
          {preview.kind === 'chart' && chartParsed && chartParsed !== 'incomplete' && (
            chartParsed.type === 'pie' || chartParsed.type === 'donut'
              ? <PieChart spec={chartParsed} />
              : <AxisChart spec={chartParsed} />
          )}
          {preview.kind === 'chart' && (chartParsed === null || chartParsed === 'incomplete') && (
            <div className="cpp-error">Не удалось разобрать спеку графика</div>
          )}
          {preview.kind === 'mermaid' && mermaidError && (
            <div className="cpp-error">Ошибка диаграммы: {mermaidError}</div>
          )}
          {preview.kind === 'mermaid' && !mermaidSvg && !mermaidError && (
            <div className="cpp-loading">Рендер диаграммы…</div>
          )}
          {preview.kind === 'mermaid' && mermaidSvg && (
            <div className="cpp-mermaid" dangerouslySetInnerHTML={{ __html: mermaidSvg }} />
          )}
        </div>
      </div>

      {/* Подсказка по навигации */}
      <div className="cpp-hint">
        колесо — приближение · перетаскивание — движение · двойной клик — сброс
      </div>
    </div>
  )
}
