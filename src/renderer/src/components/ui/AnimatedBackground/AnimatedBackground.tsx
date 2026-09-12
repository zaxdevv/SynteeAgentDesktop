import { useEffect, useRef, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '../../../store/ui.store'
import { useExtensionsStore } from '../../../store/extensions.store'
import type { BgMessage, BgStyle } from './bg-types'
import { FALLBACK_RGB, normalizeBgStyle } from './bg-types'
import { collectPluginBackgrounds, parsePluginBgKey } from '../../../utils/pluginExtApi'
import PluginBackgroundLayer from './PluginBackgroundLayer'
import type { PluginBackgroundContribution } from '../../../../../shared/types/plugin'
import './AnimatedBackground.css'

export type { BgStyle }

function parseColorStr(raw: string): [number, number, number] {
  if (raw.startsWith('#') && raw.length >= 7) {
    const r = parseInt(raw.slice(1, 3), 16)
    const g = parseInt(raw.slice(3, 5), 16)
    const b = parseInt(raw.slice(5, 7), 16)
    return [r / 255, g / 255, b / 255]
  }
  const parts = raw.split(',').map(p => parseFloat(p.trim()) / 255)
  return parts.length >= 3 ? [parts[0], parts[1], parts[2]] : FALLBACK_RGB
}

function readAccColor(): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()
  const fallback = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  return parseColorStr(raw || fallback || '255, 255, 255')
}

export default function AnimatedBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const colorRef = useRef<[number, number, number]>(readAccColor())

  const { animatedBackground, bgStyle, theme, accentColor, activeCustomThemeId, animatedBgOpacity, animatedBgSpeed, bgStyleParams } = useUIStore(useShallow(s => ({
    animatedBackground: s.animatedBackground,
    bgStyle: s.bgStyle,
    theme: s.theme,
    accentColor: s.accentColor,
    activeCustomThemeId: s.activeCustomThemeId,
    animatedBgOpacity: s.animatedBgOpacity,
    animatedBgSpeed: s.animatedBgSpeed,
    bgStyleParams: s.bgStyleParams,
  })))
  const style: BgStyle = normalizeBgStyle(bgStyle as string)
  const send = (msg: BgMessage) => workerRef.current?.postMessage(msg)

  // Фон плагина (registerBackground): bgStyle = 'plugin:{pluginId}:{id}'.
  // Активен только когда плагин запущен — иначе деградируем на дефолтный
  // стиль (normalizeBgStyle вернёт aurora для неизвестных значений).
  const pluginList = useExtensionsStore(s => s.plugins)
  const pluginBg: PluginBackgroundContribution | null = useMemo(() => {
    if (typeof bgStyle !== 'string' || !bgStyle.startsWith('plugin:')) return null
    const parsed = parsePluginBgKey(bgStyle)
    if (!parsed) return null
    return collectPluginBackgrounds().find(b => b.pluginId === parsed.pluginId && b.id === parsed.id) ?? null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgStyle, pluginList])
  const hasPluginBg = !!pluginBg

  // Жизненный цикл worker'а и OffscreenCanvas:
  //  - worker + transferControlToOffscreen делаем ОДИН раз на mount.
  //  - canvas нельзя дважды перевести в offscreen, поэтому при выкл/вкл
  //    фона мы НЕ перемонтируем canvas (он рендерится всегда, см. return),
  //    а просто шлём 'disable'/'enable' в тот же worker.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || workerRef.current) return
    colorRef.current = readAccColor()
    workerRef.current = new Worker(new URL('./bg.worker.ts', import.meta.url), { type: 'module' })
    const offscreen = canvas.transferControlToOffscreen()
    // Размер буфера — в физических пикселях (CSS-px * dpr), иначе на
    // HiDPI-экранах эффект мыльный. dpr ограничен 2 — больше не даёт
    // видимой чёткости для мягких фоновых эффектов, но грузит GPU.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    workerRef.current.postMessage({
      type: 'init',
      canvas: offscreen,
      style,
      color: colorRef.current,
      w: Math.max(1, Math.round(canvas.offsetWidth * dpr)),
      h: Math.max(1, Math.round(canvas.offsetHeight * dpr)),
      opacity: (animatedBgOpacity ?? 60) / 100,
      speed: animatedBgSpeed ?? 1,
      params: bgStyleParams ?? {},
      seed: Math.random() * 100.0,
    } as BgMessage, [offscreen])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Вкл/выкл фона без перемонтирования canvas: worker живёт, просто
  // останавливаем/запускаем рендер. Смена стиля на 'none' = disable,
  // обратно на эффект = enable + setStyle.
  // Пауза при скрытом окне (document.hidden) — свёрнутое/перекрытое окно
  // не рендерит фон в стол.
  // ВАЖНО: на маунте шлём enable БЕЗ проверки document.hidden. Главное окно
  // создаётся с show:false и документ грузится СКРЫТЫМ (MainWindow.ts:78,
  // показ по ready-to-show). В Electron visibilitychange из такого
  // состояния может не прийти (visibilityState остаётся 'hidden') — тогда
  // disable на старте убивал фон навсегда. Худший случай теперь: пара
  // секунд рендера в скрытое окно — дёшево.
  const visible = animatedBackground && !hasPluginBg && style !== 'none'
  useEffect(() => {
    send({ type: visible ? 'enable' : 'disable' } as BgMessage)
    const onVis = () => {
      send({ type: visible && !document.hidden ? 'enable' : 'disable' } as BgMessage)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [visible])

  // Реактор-эффекты: при изменении любого значения отправляем в worker.
  // Цвет зависит от theme + accentColor + кастомной темы — раньше был
  // только theme, поэтому смена акцента не доходила до worker'а.
  useEffect(() => {
    colorRef.current = readAccColor()
    send({ type: 'setColor', color: colorRef.current })
  }, [theme, accentColor, activeCustomThemeId])
  useEffect(() => send({ type: 'setStyle', style }), [style])
  useEffect(() => send({ type: 'setOpacity', opacity: (animatedBgOpacity ?? 60) / 100 }), [animatedBgOpacity])
  useEffect(() => send({ type: 'setSpeed', speed: animatedBgSpeed ?? 1 }), [animatedBgSpeed])
  useEffect(() => send({ type: 'setParams', params: bgStyleParams ?? {} }), [bgStyleParams])

  useEffect(() => {
    const onResize = () => {
      const c = canvasRef.current
      if (!c) return
      rectCache = null // сброс кэша — пересчитаем на следующем mousemove
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      send({
        type: 'resize',
        w: Math.max(1, Math.round(c.offsetWidth * dpr)),
        h: Math.max(1, Math.round(c.offsetHeight * dpr)),
      })
    }
    // ResizeObserver ловит изменения контейнера (сайдбар, панели), а не
    // только окна — window.resize одного недостаточно.
    const ro = typeof ResizeObserver !== 'undefined' && canvasRef.current
      ? new ResizeObserver(onResize)
      : null
    if (ro && canvasRef.current) ro.observe(canvasRef.current)
    window.addEventListener('resize', onResize)

    // Смена devicePixelRatio (масштаб Windows 100→125→150%, перетаскивание
    // окна между мониторами с разным DPI) НЕ всегда меняет CSS-размер canvas
    // → resize не приходит, буфер остаётся со старым dpr и фон мылится.
    // Следим через matchMedia: при смене dpr перевыставляем буфер.
    let dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onDprChange = () => {
      const next = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprMql.removeEventListener('change', onDprChange)
      dprMql = next
      dprMql.addEventListener('change', onDprChange)
      onResize()
    }
    dprMql.addEventListener('change', onDprChange)

    // Мышь: canvas имеет pointer-events:none, события идут через window.
    // Переводим client-координаты в UV (0-1), Y флипаем для WebGL.
    //
    // Оптимизация CPU: мышь шлёт 125–1000 событий/сек. Раньше на КАЖДОЕ
    // событие звался getBoundingClientRect() (forced layout read — главный
    // пожиратель CPU при движении мыши) и rAF-троттлинг на 144Hz пропускал
    // до 144 postMessage/сек. Теперь:
    //  - rect кэшируется и обновляется не чаще раза в секунду (+ на resize);
    //  - игнорируем микродвижения (< ~0.15% экрана);
    //  - отправка не чаще ~60/сек И не чаще одной за кадр.
    let rectCache: DOMRect | null = null
    let rectTs = 0
    let lastSendTs = 0
    let mousePending = false
    let mx = -100, my = -100
    const refreshRect = () => {
      const c = canvasRef.current
      if (!c) return
      rectCache = c.getBoundingClientRect()
      rectTs = performance.now()
    }
    const onMouseMove = (e: MouseEvent) => {
      const now = performance.now()
      if (!rectCache || now - rectTs > 1000) refreshRect()
      const r = rectCache
      if (!r || r.width === 0 || r.height === 0) return
      const nx = (e.clientX - r.left) / r.width
      const ny = 1.0 - (e.clientY - r.top) / r.height
      if (Math.abs(nx - mx) < 0.0015 && Math.abs(ny - my) < 0.0015) return
      mx = nx
      my = ny
      if (!mousePending && now - lastSendTs >= 15) {
        mousePending = true
        requestAnimationFrame(() => {
          send({ type: 'setMouse', x: mx, y: my })
          mousePending = false
          lastSendTs = performance.now()
        })
      }
    }
    window.addEventListener('mousemove', onMouseMove, { passive: true })

    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('mousemove', onMouseMove)
      dprMql.removeEventListener('change', onDprChange)
    }
  }, [])

  useEffect(() => () => {
    workerRef.current?.postMessage({ type: 'destroy' } as BgMessage)
    workerRef.current?.terminate()
    workerRef.current = null
  }, [])

  // Opacity применяется ТОЛЬКО в шейдере (u_opacity). Раньше она же стояла
  // и в CSS canvas → двойное затемнение (0.6 * 0.6 = 0.36).
  //
  // ВАЖНО: canvas рендерится ВСЕГДА (даже когда фон выкл / стиль 'none').
  // Иначе при выкл→вкл React перемонтирует <canvas>, а старый canvas уже
  // переведён в OffscreenCanvas — transferControlToOffscreen() на новом
  // canvas с тем же worker'ом невозможен, и фон больше не появляется.
  // Выключение = worker остаётся, но running=false, canvas скрыт через
  // visibility (НЕ display — иначе offsetWidth=0 и resize сломается).
  return (
    <>
      {pluginBg && animatedBackground && <PluginBackgroundLayer bg={pluginBg} />}
      <canvas
        ref={canvasRef}
        className="animated-bg"
        style={{ visibility: visible ? 'visible' : 'hidden' }}
      />
    </>
  )
}

/** Совместимость с App.tsx — пустышка, кэш читается при init. Не удалять. */
export function invalidateAccentCache(): void {}
