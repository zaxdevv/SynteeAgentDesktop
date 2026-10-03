/**
 * Детерминированный тест кэшей graphRenderer:
 *  - кэш метрик текста (measureText) с инвалидацией и ограничением размера;
 *  - кэш разбора hex-цвета (rgba-строки остаются теми же);
 *  - сохранность пульсации pinned-узла как функции time.
 *
 * Запуск (без новых зависимостей, esbuild есть как транзитивная зависимость vite):
 *   npx esbuild scripts/graphRendererCache.test.ts --bundle --format=esm --outfile=.tmp-graph-cache.mjs
 *   node .tmp-graph-cache.mjs
 */
import {
  render,
  clearLabelMetricsCache,
  type Camera,
  type RenderState,
} from '../src/renderer/src/pages/Memory/graph/graphRenderer'
import type { PhysicsNode, PhysicsLink } from '../src/renderer/src/pages/Memory/graph/graphPhysics'

// ─── Минимальный mock CanvasRenderingContext2D ────────────────────────────────

interface CtxStats {
  measureText: number
  colorStops: Array<{ offset: number; color: string }>
  strokeStyles: string[]
  fillStyles: string[]
}

function makeCtx(stats: CtxStats): CanvasRenderingContext2D {
  const gradient = () => ({
    addColorStop(offset: number, color: string) {
      stats.colorStops.push({ offset, color })
    },
  })
  let strokeStyle: string | CanvasGradient = ''
  let fillStyle: string | CanvasGradient = ''
  const ctx: Record<string, unknown> = {
    font: '',
    lineWidth: 1,
    globalAlpha: 1,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    clearRect() {},
    save() {},
    restore() {},
    scale() {},
    translate() {},
    beginPath() {},
    arc() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    stroke() {},
    fill() {},
    roundRect() {},
    fillText() {},
    measureText(text: string) {
      stats.measureText++
      return { width: text.length * 6 }
    },
    createRadialGradient() {
      return gradient()
    },
    createLinearGradient() {
      return gradient()
    },
  }
  Object.defineProperty(ctx, 'strokeStyle', {
    get: () => strokeStyle,
    set: (v: string | CanvasGradient) => {
      strokeStyle = v
      if (typeof v === 'string') stats.strokeStyles.push(v)
    },
  })
  Object.defineProperty(ctx, 'fillStyle', {
    get: () => fillStyle,
    set: (v: string | CanvasGradient) => {
      fillStyle = v
      if (typeof v === 'string') stats.fillStyles.push(v)
    },
  })
  return ctx as unknown as CanvasRenderingContext2D
}

function newStats(): CtxStats {
  return { measureText: 0, colorStops: [], strokeStyles: [], fillStyles: [] }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function node(over: Partial<PhysicsNode> & { id: string }): PhysicsNode {
  return {
    type: 'concept',
    label: over.id,
    weight: 2,
    pinned: false,
    sourceKind: null,
    sourceId: null,
    radius: 12,
    color: '#10b981',
    degree: 1,
    x: 100,
    y: 100,
    ...over,
  }
}

const camera: Camera = { scale: 2, tx: 0, ty: 0 }

function state(nodes: PhysicsNode[], links: PhysicsLink[], time: number, over: Partial<RenderState> = {}): RenderState {
  return {
    nodes,
    links,
    camera,
    hoverId: null,
    selectedId: null,
    neighborIds: new Set<string>(),
    searchMatchIds: null,
    width: 800,
    height: 600,
    dpr: 1,
    time,
    ...over,
  }
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : '  — ' + extra}`)
}

// ─── 1. Кэш метрик текста ────────────────────────────────────────────────────

const a = node({ id: 'a', label: 'Alpha node label' })
const b = node({ id: 'b', label: 'Beta', color: '#f59e0b', pinned: true, x: 200, y: 120 })
const links: PhysicsLink[] = [{ id: 'e1', source: a, target: b, type: 'mentions', weight: 2 }]

clearLabelMetricsCache()
const s1 = newStats()
render(makeCtx(s1), state([a, b], links, 0))
check('первый рендер измеряет метрики для каждой показанной метки', s1.measureText === 2, `measureText=${s1.measureText}`)

const s2 = newStats()
render(makeCtx(s2), state([a, b], links, 1234))
check('повторный рендер того же состояния не вызывает measureText', s2.measureText === 0, `measureText=${s2.measureText}`)

const s3 = newStats()
render(makeCtx(s3), state([a, b], links, 2000, { hoverId: 'a' }))
check('emphasis (hover) даёт другой шрифт → ровно одно измерение', s3.measureText === 1, `measureText=${s3.measureText}`)

const s4 = newStats()
render(makeCtx(s4), state([a, b], links, 3000, { hoverId: 'a' }))
check('emphasis-метрика тоже кэшируется', s4.measureText === 0, `measureText=${s4.measureText}`)

clearLabelMetricsCache()
const s5 = newStats()
render(makeCtx(s5), state([a, b], links, 4000))
check('clearLabelMetricsCache() инвалидирует кэш', s5.measureText === 2, `measureText=${s5.measureText}`)

// ─── 2. Кэш ограничен по размеру ─────────────────────────────────────────────

// 2a. Рабочий набор, помещающийся в кэш (2047 < 2048), полностью кэшируется.
const FITS = 2047
const fits: PhysicsNode[] = []
for (let i = 0; i < FITS; i++) fits.push(node({ id: `f${i}`, label: `fit-${i}` }))

clearLabelMetricsCache()
render(makeCtx(newStats()), state(fits, [], 0))
const sFits = newStats()
render(makeCtx(sFits), state(fits, [], 16))
check('набор 2047 меток полностью кэшируется (второй прогон без measureText)', sFits.measureText === 0, `measureText=${sFits.measureText}`)

// 2b. Набор больше лимита не ломает кэш: маленький набор после него снова кэшируется.
const MANY = 2100
const many: PhysicsNode[] = []
for (let i = 0; i < MANY; i++) many.push(node({ id: `n${i}`, label: `label-${i}` }))

clearLabelMetricsCache()
render(makeCtx(newStats()), state(many, [], 0))
render(makeCtx(newStats()), state(many, [], 16))
const sSmall1 = newStats()
render(makeCtx(sSmall1), state([a, b], links, 32))
const sSmall2 = newStats()
render(makeCtx(sSmall2), state([a, b], links, 48))
check('после переполнения кэш продолжает работать (маленький набор кэшируется)', sSmall1.measureText === 2 && sSmall2.measureText === 0, `${sSmall1.measureText}/${sSmall2.measureText}`)

// ─── 3. rgba-строки не изменились (hex-кэш прозрачен) ────────────────────────

clearLabelMetricsCache()
const sColor = newStats()
render(makeCtx(sColor), state([a, b], links, 0))
const bGlow0 = sColor.colorStops.find(c => c.color.startsWith('rgba(245,158,11,'))
const aGlow0 = sColor.colorStops.find(c => c.color.startsWith('rgba(16,185,129,'))
check('hex→rgba: pinned-узел #f59e0b, time=0 → alpha 0.25', bGlow0?.color === 'rgba(245,158,11,0.25)', String(bGlow0?.color))
check('hex→rgba: обычный узел #10b981 → alpha 0.25', aGlow0?.color === 'rgba(16,185,129,0.25)', String(aGlow0?.color))

// ─── 4. Пульсация pinned сохранена как функция time ──────────────────────────

const sPulse = newStats()
render(makeCtx(sPulse), state([a, b], links, 1000))
const bGlow1 = sPulse.colorStops.find(c => c.color.startsWith('rgba(245,158,11,'))
const aGlow1 = sPulse.colorStops.find(c => c.color.startsWith('rgba(16,185,129,'))
check('pinned glow зависит от time (пульсация жива)', bGlow1?.color !== bGlow0?.color, `${bGlow0?.color} vs ${bGlow1?.color}`)
check('не-pinned glow не зависит от time', aGlow1?.color === aGlow0?.color, `${aGlow0?.color} vs ${aGlow1?.color}`)

// ─── 5. Кольцо pinned рисуется, обычные узлы — без кольца ────────────────────

check(
  'pinned-кольцо #fbbf24 присутствует (strokeStyle)',
  sPulse.strokeStyles.some(s => s.startsWith('rgba(251,191,36,')),
)
check('основной круг узла залит исходным цветом #10b981', sPulse.fillStyles.includes('#10b981'))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
