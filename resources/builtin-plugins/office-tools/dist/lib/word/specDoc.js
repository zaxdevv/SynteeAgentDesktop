// specDoc — полный справочник формата JSON-спеки word_create.
// Это КОНТРАКТ: dist/lib/word/spec.js обязан поддерживать всё описанное здесь,
// а dist/lib/templates/* генерирует спеки в этом же формате.

function specDoc() {
  return `# word_create spec reference

Document spec (argument "spec"):

{
  "page": {                       // optional page setup
    "size": "A4"|"Letter"|"Legal"|"A5"|"A3",   // default A4
    "orientation": "portrait"|"landscape",     // default portrait
    "margins": { "top": 2, "right": 1.5, "bottom": 2, "left": 3 },  // cm; omit → plugin default (GOST)
    "columns": 1,
    "watermark": { "text": "ЧЕРНОВИК", "color": "C0C0C0", "opacity": 0.5, "diagonal": true, "size": 1 },
    "differentFirstPage": true,   // separate first-page header/footer (titlePage)
    "evenAndOdd": true,           // different even/odd headers/footers
    "firstLineIndent": "auto"|"on"|"off",  // 1.25cm first-line indent for body paragraphs; auto = only for Cyrillic text
    "compactLists": true,         // list indent 360 twips/level instead of 720
    "smartBreaks": true           // keepNext on headings, cantSplit on table rows (table allowSplit: true opts out)
  },
  "styles": {                     // optional default styles
    "default": { "font": "Calibri", "size": 22, "color": "1F1F1F", "lineHeight": 1.15, "spacingAfter": 160 },
    "heading1": { "font": "Calibri", "size": 32, "bold": true, "color": "2E74B5", "spacingBefore": 240, "spacingAfter": 120 },
    "heading2": { ... }, ..., "heading6": { ... }
  },
  "numbering": {                  // optional custom list numbering, id → definition
    "mylist": { "type": "decimal", "levels": [ { "format": "decimal", "text": "%1.", "alignment": "start", "indent": 720 } ] }
  },
  "header": { "blocks": [ block, ... ] },   // running header (default variant)
  "footer": { "blocks": [ block, ... ], "pageNumber": { "alignment": "center", "start": 1 } },
  // Full format (each variant optional; pairs with differentFirstPage/evenAndOdd):
  // "header": { "default": { "blocks": [...] }, "first": { "blocks": [...] }, "even": { "blocks": [...] } }
  "content": [ block, ... ]       // REQUIRED: document body blocks
}

## Blocks (content / header / footer / append_blocks)

{ "type": "heading", "level": 1..6, "text": "…" }                       // styled via styles.headingN
{ "type": "paragraph", "text": "…",                                     // plain text OR runs (below)
  "alignment": "left"|"center"|"right"|"justify",
  "spacing": { "before": 120, "after": 120, "line": 276 },              // twips
  "indent": { "firstLine": 720, "left": 360, "hanging": 360 },
  "footnote": "сноска в конце абзаца",
  "style": { ...run props } }                                           // default run props for plain text
{ "type": "list", "ordered": true|false, "numberingId": "mylist",       // custom numbering (optional)
  "items": [ "text" | { "text": "…", "level": 0, "style": { … } } ] }
{ "type": "table",
  "rows": [ [ cell, cell, ... ], ... ],                                 // REQUIRED: rows of cells
  "header": true,                       // first row is header (bold, repeated on page break)
  "allowSplit": true,                   // allow rows to split across pages (default: cantSplit)
  "columnWidths": [ 4, 6, 3 ],          // cm; omit → autofit
  "width": 100,                         // % of page width
  "borders": { "style": "single"|"double"|"dashed"|"dotted"|"none", "size": 4, "color": "auto" },  // size in 1/8 pt
  "style": "table-grid"|"light-shading"|"medium-shading-1"|"no-border",
  "align": "center" }
  // cell: "text" | { "text": "…" | "runs": [ run ], "bold": true, "italic": false, "align": "center",
  //        "fill": "DEEBF7", "color": "333333", "colspan": 2, "rowspan": 2, "verticalAlign": "center",
  //        "borders": { … } }
{ "type": "image", "path": "C:/abs/pic.png", "width": 400, "height": 300,   // px; omit both → natural size
  "alignment": "left"|"center"|"right" }
  // image can also use "data" (base64) + "ext" instead of "path" — but avoid large base64
  // in YOUR specs. NOTE: word_read mode "full" returns images ONLY as "path" (extracted
  // to files, listed in res.images) — never as base64, to keep the AI context clean.
{ "type": "hyperlink", "text": "…", "url": "https://…" }
{ "type": "math", "latex": "\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}", "display": true }
  // MATH FORMULA (native Word equation, OMML). LaTeX syntax. display=true (default)
  // → own centered paragraph; display=false → left-aligned paragraph.
  // Supported LaTeX: \\frac{a}{b}, \\sqrt{x}, \\sqrt[n]{x}, x^2, x_i, x_i^2 (both),
  // \\sum_{i=1}^{n}, \\prod, \\int_0^1, \\iint, \\oint, \\bigcup, \\bigcap (limits above/below),
  // \\lim_{x \\to 0}, \\sin \\cos \\tan \\log \\ln \\exp \\max \\min (upright functions),
  // \\text{plain text}, \\mathbb{R} (double-struck), greek \\alpha…\\Omega,
  // symbols (\\times \\cdot \\pm \\leq \\geq \\neq \\approx \\infty \\to \\in \\subset \\cup \\cap
  // \\forall \\exists \\partial \\nabla \\hbar \\ell …),
  // \\left( \\right), \\left[ \\right], \\left\\{ \\right\\}, \\langle \\rangle, | |,
  // \\begin{matrix|pmatrix|bmatrix|cases} a & b \\\\ c & d \\end{...},
  // accents \\hat{x} \\bar{x} \\vec{v} \\dot{x} \\tilde{x} \\overline{x} \\underline{x},
  // \\binom{n}{k}, \\underset{a}{b}, \\overset{a}{b}, spacing \\, \\; \\quad.
  // Unknown commands render as plain text (graceful degradation).
{ "type": "cover", "title": "…", "subtitle": "…", "author": "…", "date": "…",   // title page + page break
  "meta": [ { "label": "…", "value": "…" } ],
  "image": { "path": "…", "width": 400, "height": 300 } }
{ "type": "bookmark", "id": "intro", "text": "…" }    // anchor; id: A-Za-z0-9_ (spaces → _, other chars stripped)
{ "type": "ref", "bookmark": "intro", "text": "см. введение" }          // internal link to bookmark
{ "type": "pageBreak" }
{ "type": "toc", "title": "Содержание", "levels": 3 }   // TOC (needs field update in Word: Ctrl+A F9)
{ "type": "hr" }                                        // horizontal rule

## Runs (inline styled text)

"runs": [ { "text": "…", "bold": true, "italic": true, "underline": {} | { "type": "single"|"double"|"wave" },
  "strike": true, "subscript": true, "superscript": true,
  "font": "Times New Roman", "size": 24,          // half-points: 24 → 12pt
  "color": "FF0000", "highlight": "yellow",       // highlight: named or hex
  "allCaps": true, "caps": true,
  "footnote": "текст сноски" },                   // footnote reference right after this run
  { "math": "E = mc^2" } ]                        // INLINE math formula (LaTeX, same syntax as math block)

## Colors
Hex without '#': "FF0000", "1F1F1F", "auto".

## Units
font size = half-points; spacing/indent = twips (20 twips = 1 pt, 567 = 1 cm);
borders.size = 1/8 pt; image width/height = px; margins/columnWidths = cm.

## Stats returned by word_create
{ paragraphs, words, tables, images, lists, approxPages } and outline: [{ level, text }] for headings.
approxPages is a content-based estimate (page geometry, fonts, indents) — real Word layout may differ by ±1 page.`
}

module.exports = { specDoc }
