import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsonrepair } from 'jsonrepair'
import { useChatRemeasure } from './remeasure'
import { useChartPreviewStore } from '../../../store/chartPreview.store'
import { downloadSvgAsPng } from '../../../utils/downloadSvg'
import AppIcon from '../AppIcon/AppIcon'
import './ChartBlock.css'

// ── Chart-блок ```chart — JSON-спецификация, рендерим собственным SVG ──────
// Формат (контракт описан в базовом system prompt — см. buildSystemPrompt.ts):
//   { "type": "bar|line|pie|donut", "title": "...", "labels": [...],
//     "series": [{ "name": "...", "data": [числа] }] }
//
// Без внешних библиотек (echarts ~1MB+ в бандле): оси, сетка, бары, линии,
// сектора — ~300 строк SVG. Тултипы — нативные <title>. Парсинг — jsonrepair
// (модель иногда пишет JSON с хвостами-запятыми). Во время стриминга
// незавершённый JSON показывает placeholder «···» (как MermaidBlock).

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie' | 'donut'
  title?: string
  labels: string[]
  series: Array<{ name?: string; data: number[] }>
}

const CHART_TYPES = ['bar', 'line', 'pie', 'donut'] as const

/** Палитра серий — читается и на тёмной, и на светлой теме. */
const PALETTE = ['#7c8cff', '#f59e0b', '#34d399', '#f87171', '#22d3ee', '#a78bfa', '#fbbf24', '#fb7185']

/**
 * Парсинг спеки. Возвращает:
 *  - ChartSpec — валидная спека;
 *  - 'incomplete' — JSON ещё не дописан (стриминг) → placeholder;
 *  - null — структура есть, но данные некорректны → блок ошибки.
 * Экспортирован для ChartPreviewPanel (правая панель просмотра).
 */
export function parseChart(code: string): ChartSpec | 'incomplete' | null {
  const trimmed = code.trim()
  if (!trimmed) return 'incomplete'
  let obj: unknown
  try {
    obj = JSON.parse(jsonrepair(trimmed))
  } catch {
    return 'incomplete'
  }
  if (typeof obj !== 'object' || obj === null) return 'incomplete'
  const o = obj as Record<string, unknown>
  // Структуры ещё нет — считаем незавершённым (стриминг), не ошибкой.
  if (!o.labels || !o.series) return 'incomplete'
  if (!Array.isArray(o.labels) || !Array.isArray(o.series)) return null
  const type = String(o.type ?? 'bar')
  if (!(CHART_TYPES as readonly string[]).includes(type)) return null
  const labels = o.labels.map(l => String(l))
  const series: Array<{ name?: string; data: number[] }> = []
  for (const s of o.series) {
    if (typeof s !== 'object' || s === null || !Array.isArray((s as Record<string, unknown>).data)) return null
    const data = ((s as Record<string, unknown>).data as unknown[]).map(Number)
    if (data.some(n => !Number.isFinite(n))) return null
    series.push({ name: (s as Record<string, unknown>).name !== undefined ? String((s as Record<string, unknown>).name) : undefined, data })
  }
  if (series.length === 0) return null
  // Длины должны совпадать с labels (кроме pie с одной серией — там labels = сектора).
  for (const s of series) {
    if (s.data.length !== labels.length) return null
  }
  return { type: type as ChartSpec['type'], title: o.title !== undefined ? String(o.title) : undefined, labels, series }
}

/** Компактный формат числа для осей: 1200 → «1.2k». */
function fmt(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return (Math.round(n / 100_000) / 10) + 'M'
  if (abs >= 1_000) return (Math.round(n / 100) / 10) + 'k'
  return String(Math.round(n * 100) / 100)
}

/** «Красивый» максимум оси: round up до удобного числа, ≥4 делений. */
function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const base = Math.pow(10, exp)
  const frac = v / base
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10
  return nice * base
}

// ── Геометрия общего каркаса (bar/line) ────────────────────────────────────
const W = 640
const PAD_L = 46   // подписи Y
const PAD_R = 14
const PAD_T = 16
const TITLE_H = 26
const PLOT_H = 220
const X_LABELS_H = 34
const LEGEND_H = 26

function seriesName(s: { name?: string; data: number[] }, i: number): string {
  return s.name ?? `Серия ${i + 1}`
}

// ── Bar / Line ─────────────────────────────────────────────────────────────
// Экспортированы для ChartPreviewPanel (правая панель) — там те же
// компоненты рендерятся крупно внутри zoom/pan-контейнера.
export function AxisChart({ spec }: { spec: ChartSpec }) {
  const isLine = spec.type === 'line'
  const hasLegend = spec.series.length > 1
  const H = TITLE_H + PAD_T + PLOT_H + X_LABELS_H + (hasLegend ? LEGEND_H : 6)
  const plotX = PAD_L
  const plotW = W - PAD_L - PAD_R
  const plotY = TITLE_H + PAD_T
  const maxV = niceMax(Math.max(0, ...spec.series.flatMap(s => s.data)))
  const ticks = 4
  const y = (v: number) => plotY + PLOT_H - (v / maxV) * PLOT_H
  const slot = plotW / spec.labels.length
  const cx = (i: number) => plotX + slot * (i + 0.5)

  const gridlines = Array.from({ length: ticks + 1 }, (_, t) => (maxV / ticks) * t)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={spec.title ?? 'Диаграмма'}>
      {/* Горизонтальная сетка + подписи Y */}
      {gridlines.map((v, t) => (
        <g key={t}>
          <line x1={plotX} x2={plotX + plotW} y1={y(v)} y2={y(v)} className="chart-grid" />
          <text x={plotX - 8} y={y(v) + 4} className="chart-axis-label" textAnchor="end">{fmt(v)}</text>
        </g>
      ))}
      {/* Ось X */}
      <line x1={plotX} x2={plotX + plotW} y1={plotY + PLOT_H} y2={plotY + PLOT_H} className="chart-axis" />
      {/* Подписи X — наклон при длинных/многочисленных метках */}
      {spec.labels.map((l, i) => {
        const crowded = spec.labels.length > 7 || spec.labels.some(x => x.length > 8)
        return (
          <text
            key={i}
            x={cx(i)}
            y={plotY + PLOT_H + 16}
            className="chart-axis-label"
            textAnchor="middle"
            transform={crowded ? `rotate(-25 ${cx(i)} ${plotY + PLOT_H + 16})` : undefined}
          >
            {l.length > 14 ? l.slice(0, 13) + '…' : l}
          </text>
        )
      })}
      {/* Данные */}
      {isLine
        ? spec.series.map((s, si) => (
            <g key={si}>
              <polyline
                points={s.data.map((v, i) => `${cx(i)},${y(v)}`).join(' ')}
                fill="none"
                stroke={PALETTE[si % PALETTE.length]}
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {s.data.map((v, i) => (
                <circle key={i} cx={cx(i)} cy={y(v)} r="3.5" fill={PALETTE[si % PALETTE.length]} className="chart-dot">
                  <title>{`${spec.labels[i]} — ${seriesName(s, si)}: ${fmt(v)}`}</title>
                </circle>
              ))}
            </g>
          ))
        : spec.series.map((s, si) => {
            const groupW = slot * 0.72
            const barW = groupW / spec.series.length
            return (
              <g key={si}>
                {s.data.map((v, i) => {
                  const bx = plotX + slot * i + (slot - groupW) / 2 + barW * si
                  const bh = Math.max(0, plotY + PLOT_H - y(v))
                  return (
                    <rect
                      key={i}
                      x={bx}
                      y={y(v)}
                      width={Math.max(2, barW - 2)}
                      height={bh}
                      rx="3"
                      fill={PALETTE[si % PALETTE.length]}
                      className="chart-bar"
                    >
                      <title>{`${spec.labels[i]} — ${seriesName(s, si)}: ${fmt(v)}`}</title>
                    </rect>
                  )
                })}
              </g>
            )
          })}
      {/* Легенда (несколько серий) */}
      {hasLegend && (
        <g transform={`translate(${plotX}, ${H - LEGEND_H + 4})`}>
          {spec.series.map((s, si) => (
            <g key={si} transform={`translate(${(plotW / spec.series.length) * si}, 0)`}>
              <rect width="10" height="10" rx="2.5" y="-8" fill={PALETTE[si % PALETTE.length]} />
              <text x="16" y="1" className="chart-legend-label">{seriesName(s, si)}</text>
            </g>
          ))}
        </g>
      )}
    </svg>
  )
}

// ── Pie / Donut ────────────────────────────────────────────────────────────
export function PieChart({ spec }: { spec: ChartSpec }) {
  // Pie: одна серия (labels = сектора). Если серий несколько — берём первую.
  const data = spec.series[0].data
  const total = data.reduce((a, b) => a + b, 0)
  const donut = spec.type === 'donut'
  const size = 240
  const cx = size / 2 + 10
  const cy = size / 2 + 10
  const r = size / 2 - 10
  const innerR = donut ? r * 0.58 : 0
  const legendX = size + 24
  const W2 = legendX + 190
  const H2 = size + 20

  if (total <= 0) {
    return (
      <div className="chart-error">
        <span>⚠ Сумма значений должна быть &gt; 0</span>
      </div>
    )
  }

  let angle = -Math.PI / 2 // старт с 12 часов
  const sectors = data.map((v, i) => {
    const frac = v / total
    const a0 = angle
    const a1 = angle + frac * Math.PI * 2
    angle = a1
    const large = a1 - a0 > Math.PI ? 1 : 0
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0)
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1)
    const xi1 = cx + innerR * Math.cos(a1), yi1 = cy + innerR * Math.sin(a1)
    const xi0 = cx + innerR * Math.cos(a0), yi0 = cy + innerR * Math.sin(a0)
    // Подпись процента — на середине сектора, радиус между inner и outer
    const mid = (a0 + a1) / 2
    const lr = (r + innerR) / 2
    return { i, v, frac, x0, y0, x1, y1, xi0, yi0, xi1, yi1, large, lx: cx + lr * Math.cos(mid), ly: cy + lr * Math.sin(mid) }
  })

  return (
    <svg viewBox={`0 0 ${W2} ${H2}`} className="chart-svg" role="img" aria-label={spec.title ?? 'Круговая диаграмма'}>
      {sectors.map(s => (
        <path
          key={s.i}
          d={
            donut
              ? `M ${s.x0} ${s.y0} A ${r} ${r} 0 ${s.large} 1 ${s.x1} ${s.y1} L ${s.xi1} ${s.yi1} A ${innerR} ${innerR} 0 ${s.large} 0 ${s.xi0} ${s.yi0} Z`
              : `M ${cx} ${cy} L ${s.x0} ${s.y0} A ${r} ${r} 0 ${s.large} 1 ${s.x1} ${s.y1} Z`
          }
          fill={PALETTE[s.i % PALETTE.length]}
          className="chart-sector"
        >
          <title>{`${spec.labels[s.i]}: ${fmt(s.v)} (${(s.frac * 100).toFixed(1)}%)`}</title>
        </path>
      ))}
      {/* Проценты на секторах ≥ 4% */}
      {sectors.filter(s => s.frac >= 0.04).map(s => (
        <text
          key={s.i}
          x={s.lx}
          y={s.ly + 4}
          className="chart-pie-pct"
          textAnchor="middle"
        >
          {Math.round(s.frac * 100)}%
        </text>
      ))}
      {/* Легенда справа: цвет + метка + значение */}
      {sectors.map((s, i) => (
        <g key={i} transform={`translate(${legendX}, ${cy - (sectors.length * 22) / 2 + i * 22 + 4})`}>
          <rect width="10" height="10" rx="2.5" y="-8" fill={PALETTE[s.i % PALETTE.length]} />
          <text x="16" y="1" className="chart-legend-label">
            {spec.labels[s.i].length > 18 ? spec.labels[s.i].slice(0, 17) + '…' : spec.labels[s.i]}
          </text>
          <text x="16" y="14" className="chart-legend-value">{fmt(s.v)} · {(s.frac * 100).toFixed(1)}%</text>
        </g>
      ))}
    </svg>
  )
}

// ── Компонент блока ────────────────────────────────────────────────────────
const ChartBlock = memo(function ChartBlock({ code }: { code: string }) {
  // 'incomplete' при стриминге → placeholder; null → ошибка; спека → график.
  // useMemo: парсинг на каждый code-апдейт (каждый токен внутри блока) —
  // jsonrepair быстрый (~мкс на <2кб), но не гоняем его на каждый рендер.
  const parsed = useMemo(() => parseChart(code), [code])
  const [remeasuredFor, setRemeasuredFor] = useState<string | null>(null)
  // Перемер ряда виртуализатора после появления графика (высота блока
  // меняется с placeholder на SVG — RO может не успеть). Как у MermaidBlock.
  const remeasure = useChatRemeasure()
  // Кнопки на блоке: ⤢ открыть в панели просмотра, ⬇ скачать PNG.
  const openPreview = useChartPreviewStore(s => s.open)
  const blockRef = useRef<HTMLDivElement>(null)

  // Скачать график как PNG (SVG из DOM → canvas → файл).
  const handleDownload = useCallback(() => {
    const svg = blockRef.current?.querySelector('svg')
    if (svg instanceof SVGSVGElement) {
      void downloadSvgAsPng(svg, parsed && parsed !== 'incomplete' ? parsed.title : undefined).catch(() => {})
    }
  }, [parsed])

  useEffect(() => {
    if (parsed && parsed !== 'incomplete' && remeasuredFor !== code) {
      setRemeasuredFor(code)
      requestAnimationFrame(() => remeasure?.())
    }
  }, [parsed, code, remeasuredFor, remeasure])

  if (parsed === null) {
    return (
      <div className="chart-error">
        <span>⚠ Некорректная спека графика</span>
        <pre>{code.slice(0, 400)}</pre>
      </div>
    )
  }
  if (parsed === 'incomplete') {
    return (
      <div className="chart-block chart-block--loading">
        <span className="chart-dots">···</span>
      </div>
    )
  }

  return (
    <div className="chart-block" ref={blockRef}>
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
          onClick={() => openPreview({ kind: 'chart', title: parsed.title, code })}
        >
          <AppIcon name="maximize" size="xs" />
        </button>
      </div>
      {parsed.title && <div className="chart-title">{parsed.title}</div>}
      {parsed.type === 'pie' || parsed.type === 'donut'
        ? <PieChart spec={parsed} />
        : <AxisChart spec={parsed} />}
    </div>
  )
})

export default ChartBlock
