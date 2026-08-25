import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '../../../store/ui.store'
import type { BgMessage, BgStyle } from './bg-types'
import { FALLBACK_RGB, normalizeBgStyle } from './bg-types'
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
  const visible = animatedBackground && style !== 'none'
  useEffect(() => {
    send({ type: visible ? 'enable' : 'disable' } as BgMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // Мышь: canvas имеет pointer-events:none, события идут через window.
    // Переводим client-координаты в UV (0-1), Y флипаем для WebGL.
    // Троттлинг через rAF — mousemove летит 60+ раз/сек, postMessage
    // каждый раз = флуд в worker. Ограничиваем одним сообщением за кадр.
    let mousePending = false
    let mx = -100, my = -100
    const onMouseMove = (e: MouseEvent) => {
      const c = canvasRef.current
      if (!c) return
      const rect = c.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      mx = (e.clientX - rect.left) / rect.width
      my = 1.0 - (e.clientY - rect.top) / rect.height
      if (!mousePending) {
        mousePending = true
        requestAnimationFrame(() => {
          send({ type: 'setMouse', x: mx, y: my })
          mousePending = false
        })
      }
    }
    window.addEventListener('mousemove', onMouseMove)

    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('mousemove', onMouseMove)
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
    <canvas
      ref={canvasRef}
      className="animated-bg"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
    />
  )
}

/** Совместимость с App.tsx — пустышка, кэш читается при init. Не удалять. */
export function invalidateAccentCache(): void {}
