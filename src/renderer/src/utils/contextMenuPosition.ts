export interface MenuPos {
  x: number
  y: number
}

const MARGIN = 8
// Ширина .chat-ctx-menu известна из CSS — по ней клампим left точно.
const MENU_WIDTH = 220

export interface ClampedMenuPosition {
  left: number
  /** Меню открывается вниз от курсора (клик в верхней половине окна). */
  top?: number
  /** Меню открывается вверх от курсора (клик в нижней половине). */
  bottom?: number
  /** Страховка на экстремальные случаи (в CSS у меню overflow-y: auto). */
  maxHeight: number
  /** Направление открытия — для анимации (сдвиг y в initial). */
  openUp: boolean
}

/**
 * Позиция контекстного меню без вылезания за края окна.
 *
 * Корень бага с обрезкой: высота меню была захардкожена (menuH = 320), но
 * реальная высота зависит от опциональных пунктов («Поделиться», «Открыть
 * папку» — до ~340px). При клике у нижнего края низ меню уходил за окно.
 * Измерять высоту не нужно: в нижней половине окна меню открывается ВВЕРХ
 * от точки клика (как системные меню Windows) — низ за клик не уйдёт
 * никогда, независимо от высоты. maxHeight + overflow-y: auto страхуют
 * случай, когда меню выше половины окна.
 */
export function getContextMenuPosition(pos: MenuPos): ClampedMenuPosition {
  const left = Math.max(MARGIN, Math.min(pos.x, window.innerWidth - MENU_WIDTH - MARGIN))
  const openUp = pos.y > window.innerHeight / 2
  if (openUp) {
    return {
      left,
      bottom: window.innerHeight - pos.y,
      maxHeight: Math.max(120, pos.y - MARGIN),
      openUp
    }
  }
  return {
    left,
    top: pos.y,
    maxHeight: Math.max(120, window.innerHeight - pos.y - MARGIN),
    openUp
  }
}
