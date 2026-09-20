import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useChatRemeasure } from './remeasure'
import { useChartPreviewStore } from '../../../store/chartPreview.store'
import { downloadSvgAsPng } from '../../../utils/downloadSvg'
import AppIcon from '../AppIcon/AppIcon'

// ── Dynamic import mermaid — грузится только когда первое сообщение
// реально содержит ```mermaid блок. Экономит ~50-80MB RAM.
type MermaidModule = typeof import('mermaid')
let _mermaid: MermaidModule['default'] | null = null
let _mermaidPromise: Promise<MermaidModule['default']> | null = null

export async function getMermaid(): Promise<MermaidModule['default']> {
  if (_mermaid) return _mermaid
  if (_mermaidPromise) return _mermaidPromise
  _mermaidPromise = import('mermaid').then((mod) => {
    _mermaid = mod.default
    _mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose',
      themeVariables: {
        primaryColor: '#a855f7',
        primaryTextColor: '#e2e8f0',
        primaryBorderColor: '#3f3f46',
        lineColor: '#71717a',
        sectionBkgColor: '#18181b',
        background: '#09090b',
        mainBkg: '#18181b',
        nodeBorder: '#3f3f46',
        clusterBkg: '#18181b',
        titleColor: '#e2e8f0',
        edgeLabelBackground: '#18181b',
        fontFamily: 'inherit',
      },
      flowchart: { curve: 'basis', useMaxWidth: true },
    })
    return _mermaid
  })
  return _mermaidPromise
}

let idCounter = 0

// Module-level кэш SVG по коду диаграммы. Виртуализатор монтирует/демонтирует
// MessageBubble при скролле; без кэша MermaidBlock терял SVG при демонтировании
// и ре-рендерил mermaid (после 500мс debounce) при каждом возврате в зону видимости
// → мигания «···» и расход CPU. С кэшем — мгновенно готовый SVG.
// Экспортирован (вместе с getMermaid) для ChartPreviewPanel — правая панель
// просмотра берёт готовый SVG отсюда, не рендеря диаграмму заново.
export const svgCache = new Map<string, string>()

// LRU-кап: раньше кэш рос безгранично (длинные сессии со множеством
// диаграмм). При переполнении удаляем старейшие 25 (Map упорядочен по
// вставке). Рендер удалённой диаграммы просто перевыполнится при показе.
function svgCacheSet(code: string, svg: string) {
  if (svgCache.size > 100) {
    let toDelete = 25
    for (const key of svgCache.keys()) {
      if (toDelete-- <= 0) break
      svgCache.delete(key)
    }
  }
  svgCache.set(code, svg)
}

// Код считается "завершённым" если последняя непустая строка — не стрелка/разделитель
function isLikelyComplete(code: string): boolean {
  const trimmed = code.trim()
  if (!trimmed) return false
  // Минимум 2 строки
  const lines = trimmed.split('\n').filter(l => l.trim())
  if (lines.length < 2) return false
  const last = lines[lines.length - 1].trim()
  // Незавершённые признаки: строка заканчивается на --> или -- или |
  if (/-->$|--$|\|$|:$/.test(last)) return false
  return true
}

const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  // Стартовое состояние — из кэша, если диаграмма уже рендерилась (скролл-remount).
  const [svg, setSvg] = useState<string>(() => svgCache.get(code) ?? '')
  const [error, setError] = useState<string | null>(null)
  // Перемер ряда после асинхронной дорисовки SVG (RO может не успеть поймать
  // финальную высоту под нагрузкой). Вне провайдера — null, noop.
  const remeasure = useChatRemeasure()
  // Кнопки на блоке: ⤢ открыть в панели просмотра, ⬇ скачать PNG.
  const openPreview = useChartPreviewStore(s => s.open)
  const blockRef = useRef<HTMLDivElement>(null)
  const handleDownload = useCallback(() => {
    const svg = blockRef.current?.querySelector('svg')
    if (svg instanceof SVGSVGElement) {
      void downloadSvgAsPng(svg, undefined, 2).catch(() => {})
    }
  }, [])
  const idRef = useRef(`mermaid-${++idCounter}`)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRef = useRef(0)  // версия — отменяем устаревшие рендеры

  useEffect(() => {
    // Уже в кэше — сразу показываем, mermaid не дёргаем.
    if (svgCache.has(code)) {
      setSvg(svgCache.get(code)!)
      return
    }
    // Не рендерим незавершённый код во время стриминга
    if (!isLikelyComplete(code)) return

    // Debounce 500мс — ждём паузы в стриминге
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      const version = ++activeRef.current
      try {
        // Уникальный id для каждого рендера чтобы избежать конфликтов
        const renderId = `${idRef.current}-${version}`
        const m = await getMermaid()
        const result = await m.render(renderId, code)
        // Если за время рендера пришёл новый вызов — игнорируем
        if (version !== activeRef.current) return
        setError(null)
        svgCacheSet(code, result.svg)
        setSvg(result.svg)
        // rAF, чтобы SVG успел влиться в layout до замера высоты ряда.
        requestAnimationFrame(() => remeasure?.())
      } catch (e: unknown) {
        if (version !== activeRef.current) return
        const msg = e instanceof Error ? e.message : String(e)
        // Не показываем ошибки парсинга незавершённого кода
        if (msg.includes('Parse error') || msg.includes('Lexical error')) return
        setError(msg)
      }
    }, 500)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [code, remeasure])

  if (error) {
    return (
      <div className="mermaid-error">
        <span>⚠ Ошибка диаграммы</span>
        <pre>{error}</pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="mermaid-block mermaid-block--loading">
        <span className="mermaid-dots">···</span>
      </div>
    )
  }

  return (
    <div className="mermaid-block" ref={blockRef}>
      <div className="chart-actions">
        <button
          className="chart-action-btn"
          title="Скачать PNG"
          onClick={handleDownload}
        >
          <AppIcon name="download" size="xs" />
        </button>
        <button
          className="chart-action-btn"
          title="Открыть в панели просмотра"
          onClick={() => openPreview({ kind: 'mermaid', code })}
        >
          <AppIcon name="maximize" size="xs" />
        </button>
      </div>
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  )
})

export default MermaidBlock
