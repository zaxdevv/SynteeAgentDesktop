/**
 * Якоря для попапов над инпут-баром чата.
 *
 * Колонка чата (.chat-input-main) центрирована с max-width: 900px —
 * слева и справа от неё пустота. Попапы, анкорящиеся к кнопкам в правой
 * части инпута, не должны выезжать в эту пустоту: их правый край
 * клампится по краю колонки, а не окна (как у пикера моделей).
 */

/**
 * Правый край центрированной колонки чата (.chat-input-main).
 * -8px — горизонтальный padding .chat-input-main, чтобы правый край
 * попапа совпал с видимым краем инпут-бокса (как у пикера моделей).
 * Fallback — правый край окна, если триггер вне колонки.
 */
export function chatColumnRight(from: HTMLElement | null): number {
  const col = from?.closest('.chat-input-main') as HTMLElement | null
  return col ? col.getBoundingClientRect().right - 8 : window.innerWidth - 12
}
