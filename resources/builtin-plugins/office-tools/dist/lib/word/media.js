// media — картинки (ImageRun из base64/пути, px-размеры, sniffing натуральных
// размеров PNG/JPEG), колонтитулы header/footer (default/first/even) с номерами
// страниц и водяной знак (watermark, VML-шейп в колонтитуле).

const docx = require('docx')
const { alignType } = require('./styles')

const { Paragraph, TextRun, ImageRun, Header, Footer, PageNumber, AlignmentType,
  ImportedXmlComponent } = docx

const IMG_TYPES = { png: 'png', jpg: 'jpg', jpeg: 'jpg', jpe: 'jpg', gif: 'gif', bmp: 'bmp', svg: 'svg' }

/** Натуральные размеры PNG (IHDR) — [w, h] или null. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
}

/** Натуральные размеры JPEG (SOF-маркеры) — [w, h] или null. */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]
    }
    const len = buf.readUInt16BE(i + 2)
    if (len <= 0) return null
    i += 2 + len
  }
  return null
}

/** image-блок → Paragraph с ImageRun. data (base64) либо path через ctx.readImage. */
async function buildImageParagraph(block, ctx, stats) {
  let base64 = block.data
  let ext = (block.ext || '').toLowerCase()
  if (!base64) {
    if (!block.path) throw new Error('image-блок: нужен path или data')
    if (!ctx || typeof ctx.readImage !== 'function') {
      throw new Error('ctx.readImage недоступен (нет доступа к файловой системе)')
    }
    const r = await ctx.readImage(block.path)
    base64 = r.base64
    ext = (r.ext || ext || 'png').toLowerCase()
  }
  if (!ext) ext = 'png'
  const type = IMG_TYPES[ext] || 'png'
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64')
  if (!buf.length) throw new Error('Пустые данные картинки: ' + (block.path || '<data>'))

  let w = Number(block.width) || 0
  let h = Number(block.height) || 0
  if ((!w || !h) && type === 'png') {
    const nat = pngSize(buf)
    if (nat) { if (!w) w = nat[0]; if (!h) h = nat[1] }
  }
  if ((!w || !h) && (type === 'jpg' || type === 'jpeg')) {
    const nat = jpegSize(buf)
    if (nat) { if (!w) w = nat[0]; if (!h) h = nat[1] }
  }
  if (!w || !h) { w = w || 400; h = h || 300 }

  if (stats) stats.images = (stats.images || 0) + 1
  return new Paragraph({
    alignment: block.alignment ? alignType(block.alignment) : AlignmentType.CENTER,
    spacing: { before: 120, after: 120 },
    children: [new ImageRun({ data: buf, type, transformation: { width: Math.round(w), height: Math.round(h) } })],
  })
}

/** footer.pageNumber → Paragraph с полем номера страницы. */
function pageNumberParagraph(pageNumber) {
  const pn = pageNumber === true ? {} : pageNumber || {}
  const align = pn.alignment ? alignType(pn.alignment) : AlignmentType.CENTER
  const runs = []
  if (pn.before) runs.push(new TextRun({ text: String(pn.before) }))
  runs.push(new TextRun({ children: [PageNumber.CURRENT] }))
  if (pn.after) runs.push(new TextRun({ text: String(pn.after) }))
  if (pn.total) {
    runs.push(new TextRun({ text: ' / ' }))
    runs.push(new TextRun({ children: [PageNumber.TOTAL_PAGES] }))
  }
  return new Paragraph({ alignment: align, children: runs })
}

// --- Водяной знак (watermark) ---
// VML-шейп WordArt в колонтитуле — как делает сам Word (PowerPlusWaterMarkObject).
const WM_NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
}

/** watermark-спека { text, color?, opacity?, diagonal?, size? } → VML XML параграфа. */
function watermarkXml(text, opts = {}) {
  const color = opts.color || 'silver' // named или hex без #
  const fill = /^[0-9a-fA-F]{6}$/.test(color) ? '#' + color : color
  const opacity = opts.opacity != null ? opts.opacity : 0.5
  const diagonal = opts.diagonal !== false // true → 315°, false → горизонтальный
  const sizePt = opts.size || 1 // auto-scale через textpath (1pt + fitshape)
  const rot = diagonal ? 315 : 0
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  return `<w:p xmlns:w="${WM_NS.w}" xmlns:v="${WM_NS.v}" xmlns:o="${WM_NS.o}">`
    + `<w:r><w:pict>`
    + `<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@11,21600e">`
    + `<v:formulas><v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/><v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/><v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/><v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @9"/><v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/></v:formulas>`
    + `<v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/>`
    + `<v:textpath on="t" fitshape="t"/>`
    + `<v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles>`
    + `<o:lock v:ext="edit" text="t" shapetype="t"/>`
    + `</v:shapetype>`
    + `<v:shape id="PowerPlusWaterMarkObject" o:spid="_x0000_s2049" type="#_x0000_t136"`
    + ` style="position:absolute;margin-left:0;margin-top:0;width:527.85pt;height:131.95pt;rotation:${rot};z-index:-251656192;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin"`
    + ` o:allowincell="f" fillcolor="${fill}" stroked="f">`
    + `<v:fill opacity="${opacity}"/>`
    + `<v:textpath style="font-family:&quot;Calibri&quot;;font-size:${sizePt}pt" string="${esc(text)}"/>`
    + `</v:shape>`
    + `</w:pict></w:r></w:p>`
}

/**
 * watermark-спека → docx-компонент (параграф с VML-шейпом) для children Header.
 * Обходной путь бага docx 9.7.1: fromXmlString оборачивает XML в элемент
 * с rootKey undefined — берём первый реальный элемент из wrapper.root.
 */
function watermarkParagraph(wm) {
  if (!wm || !wm.text) throw new Error('watermark: text обязателен')
  const wrapper = ImportedXmlComponent.fromXmlString(watermarkXml(String(wm.text), wm))
  return wrapper.root[0]
}

/**
 * header/footer-секция спеки ({ blocks, pageNumber? }) → docx Header/Footer.
 * Блоки строятся через BlockBuilder (ленивый require — против циклической
 * зависимости blocks.js ↔ media.js). opts.watermark → VML-параграф первым
 * элементом (только для header).
 */
async function buildHeaderFooter(spec, kind, ctx, numberingSpec, opts) {
  const { BlockBuilder } = require('./blocks')
  const b = new BlockBuilder({ ctx, numberingSpec })
  await b.addMany((spec && spec.blocks) || [])
  const children = []
  if (kind === 'header' && opts && opts.watermark) {
    children.push(watermarkParagraph(opts.watermark))
  }
  children.push(...b.children)
  if (kind === 'footer' && spec && spec.pageNumber) children.push(pageNumberParagraph(spec.pageNumber))
  return kind === 'header' ? new Header({ children }) : new Footer({ children })
}

module.exports = {
  buildImageParagraph, buildHeaderFooter, pageNumberParagraph,
  watermarkParagraph, watermarkXml, pngSize, jpegSize,
}
