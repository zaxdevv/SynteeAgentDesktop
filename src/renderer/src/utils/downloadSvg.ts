/**
 * Скачивание SVG-графиков/диаграмм как PNG.
 *
 * Используется кнопками на chart/mermaid-блоках в чате и в панели
 * просмотра (ChartPreviewPanel).
 *
 * ── Почему нельзя просто сериализовать SVG ──
 * Стили графиков живут в CSS-классах (ChartBlock.css) и CSS-переменных
 * (var(--text-muted) и т.д.) документа. В изолированном <img src="svg">
 * ни классы, ни переменные не разрешаются — текст/сетка стали бы чёрными
 * по умолчанию. Поэтому перед сериализацией запекаем вычисленные стили
 * (getComputedStyle уже разрешил переменные) в inline-стили клона.
 *
 * Растеризация: SVG → <img> → canvas (scale× для чёткости) → PNG blob →
 * <a download> (в Electron сохраняет в «Загрузки»).
 */

/** Свойства, значимые для SVG-рендера. getComputedStyle возвращает их уже
 *  с разрешёнными var(--…) — этого достаточно для standalone-изображения. */
const SVG_PROPS = [
  'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap',
  'stroke-linejoin', 'stroke-opacity', 'fill-opacity', 'opacity',
  'font-size', 'font-family', 'font-weight',
  'text-anchor', 'dominant-baseline', 'paint-order',
] as const

function inlineComputedStyles(src: Element, dst: Element): void {
  const cs = getComputedStyle(src)
  const ds = dst as HTMLElement
  for (const prop of SVG_PROPS) {
    try {
      const v = cs.getPropertyValue(prop)
      if (v) ds.style.setProperty(prop, v)
    } catch { /* свойство не поддерживается — пропускаем */ }
  }
  // paint-order работает только как атрибут в некоторых рендерах
  const po = cs.getPropertyValue('paint-order')
  if (po) ds.setAttribute('paint-order', po)
  const sc = Array.from(src.children)
  const dc = Array.from(dst.children)
  for (let i = 0; i < Math.min(sc.length, dc.length); i++) {
    inlineComputedStyles(sc[i], dc[i])
  }
}

/** Непрозрачный фон: цвет фона контейнера блока (разрешённый), иначе тёмный. */
function resolveBackground(el: SVGSVGElement): string {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const bg = getComputedStyle(node).backgroundColor
    // rgba(0,0,0,0) / transparent — идём выше
    if (bg && bg !== 'transparent' && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bg)) return bg
    node = node.parentElement
  }
  return '#17181d'
}

/** Санитайз имени файла из заголовка. */
export function sanitizeFilename(title: string | undefined, fallback: string): string {
  const base = (title ?? '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim()
  return (base.length > 0 ? base.slice(0, 60) : fallback)
}

/**
 * Скачать SVG-элемент как PNG.
 * @param svg    живой SVGSVGElement из DOM (для снятия computed styles)
 * @param title  заголовок → имя файла (sanitized); fallback если пусто
 * @param scale  множитель растеризации (2 = retina-чёткость)
 */
export async function downloadSvgAsPng(svg: SVGSVGElement, title: string | undefined, scale = 2): Promise<void> {
  // Размер: prefer реальные размеры элемента, fallback на viewBox
  const rect = svg.getBoundingClientRect()
  const vb = svg.viewBox?.baseVal
  const w = Math.round(rect.width || vb?.width || 640)
  const h = Math.round(rect.height || vb?.height || 360)
  if (w <= 0 || h <= 0) throw new Error('SVG has no size')

  // Клон с запечёнными стилями + явными width/height (без них <img> может
  // получить 0×0 в некоторых конфигурациях)
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))
  inlineComputedStyles(svg, clone)

  // Непрозрачный фон первым элементом (иначе PNG с прозрачностью —
  // графики на прозрачном фоне нечитаемы в проводнике/мессенджерах)
  const bg = resolveBackground(svg)
  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bgRect.setAttribute('x', '0')
  bgRect.setAttribute('y', '0')
  bgRect.setAttribute('width', String(w))
  bgRect.setAttribute('height', String(h))
  bgRect.setAttribute('fill', bg)
  clone.insertBefore(bgRect, clone.firstChild)

  const xml = new XMLSerializer().serializeToString(clone)
  const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)

  // SVG → bitmap через <img> (декодирование векторного растра браузером)
  const img = new Image()
  img.decoding = 'sync'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('SVG decode failed'))
    img.src = svgUrl
  })

  // canvas × scale — чёткость на retina/при просмотре увеличенным
  const canvas = document.createElement('canvas')
  canvas.width = w * scale
  canvas.height = h * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unavailable')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('PNG encode failed')

  // <a download> + blob URL: в Electron сохраняет файл в «Загрузки»
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${sanitizeFilename(title, 'chart')}.png`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Даём браузеру стартовать загрузку до revoke
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
