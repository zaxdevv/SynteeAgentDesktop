export type BgStyle =
  | 'aurora'
  | 'silk'
  | 'warp'
  | 'nebula'
  | 'plasma'
  | 'caustics'
  | 'network'
  | 'vortex'
  | 'flow'
  | 'crystal'
  | 'magma'
  | 'interference'
  | 'hexgrid'
  | 'oil'
  | 'solar'
  | 'dream'
  | 'smoke'
  | 'tide'
  | 'none'

export type BgMessage =
  | {
      type: 'init'
      canvas: OffscreenCanvas
      style: BgStyle
      color: [number, number, number]
      w: number
      h: number
      opacity: number
      speed: number
      params: Record<string, number>
      seed: number
    }
  | { type: 'setStyle'; style: BgStyle }
  | { type: 'setColor'; color: [number, number, number] }
  | { type: 'setOpacity'; opacity: number }
  | { type: 'setSpeed'; speed: number }
  | { type: 'setParams'; params: Record<string, number> }
  | { type: 'resize'; w: number; h: number }
  | { type: 'setMouse'; x: number; y: number }
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'destroy' }

export const FALLBACK_RGB: [number, number, number] = [1, 1, 1]

/** Приглушённость по умолчанию — объём финального цвета умножается на это. */
export const BASE_INTENSITY = 0.55

/** Список валидных стилей (для нормализации legacy-значений из стора). */
export const BG_STYLES_LIST: BgStyle[] = ['aurora', 'silk', 'warp', 'nebula', 'plasma', 'caustics', 'network', 'vortex', 'flow', 'crystal', 'magma', 'interference', 'hexgrid', 'oil', 'solar', 'dream', 'smoke', 'tide']

/** Старые/неизвестные стили (частицы, матрица и т.д.) → aurora. */
export function normalizeBgStyle(raw: string | null | undefined): BgStyle {
  // 'none' — валидное значение («Выкл» в настройках), но его НЕТ в
  // BG_STYLES_LIST (список только рендерящихся стилей). Без этой проверки
  // 'none' нормализовался в 'aurora' → «Выкл» не отключал фон.
  if (raw === 'none') return 'none'
  return (BG_STYLES_LIST as string[]).includes(raw ?? '') ? (raw as BgStyle) : 'aurora'
}
