// themes — встроенные дизайн-темы презентаций (применяются через spec.template
// или параметр template тула ppt_create). Каждая тема — полноценная дизайн-система:
// палитра, шрифты, декор мастера, автоцвета текста.
//
// applyTheme(spec, theme) мутирует спеку:
//   - шрифты → spec.theme (если не заданы)
//   - мастер THEME с декором + slideNumber (если masters нет)
//   - фоны слайдов (если не заданы; первый слайд → titleBg)
//   - цвета текста по умолчанию (тёмная тема → светлый текст!)
//   - заголовки (bold / крупный кегль) без цвета → accent
//   - chartColors по умолчанию → [accent, accent2, textMuted]

/** Нормализация hex-цвета: '#ff0000' → 'FF0000'. */
function normHex(v) {
  const s = String(v || '').trim()
  return s.startsWith('#') ? s.slice(1).toUpperCase() : s.toUpperCase()
}

/** Относительная яркость цвета (0..1) — для dark/light определения. */
function luminance(hex) {
  const h = normHex(hex)
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  if ([r, g, b].some(Number.isNaN)) return 1
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// ── Декоративные элементы мастеров (адаптивны к высоте layout H) ──

function barTop(c, H) {
  void H
  return [{ rect: { x: 0, y: 0, w: 10, h: 0.09, fill: { color: c.accent } } }]
}
function barBottom(c, H) {
  return [{ rect: { x: 0, y: H - 0.09, w: 10, h: 0.09, fill: { color: c.accent } } }]
}
function barSide(c, H) {
  return [{ rect: { x: 0, y: 0, w: 0.14, h: H, fill: { color: c.accent } } }]
}
function lineBottom(c, H) {
  return [{ line: { x: 0.5, y: H - 0.35, w: 9, h: 0, line: { color: c.textMuted, width: 0.75 } } }]
}
function doubleTop(c, H) {
  void H
  return [
    { line: { x: 0.5, y: 0.42, w: 9, h: 0, line: { color: c.accent, width: 1.5 } } },
    { line: { x: 0.5, y: 0.48, w: 9, h: 0, line: { color: c.accent2, width: 0.75 } } },
  ]
}
function glowCorner(c, H) {
  return [
    { rect: { x: 0, y: H - 0.12, w: 10, h: 0.12, fill: { color: c.accent } } },
    { rect: { x: 0, y: H - 0.12, w: 4, h: 0.12, fill: { color: c.accent2 } } },
    { ellipse: { x: 8.55, y: -0.85, w: 2.2, h: 2.2, fill: { color: c.accent, transparency: 82 } } },
  ]
}
function dotCorner(c, H) {
  void H
  return [
    { ellipse: { x: 9.1, y: 0.25, w: 0.5, h: 0.5, fill: { color: c.accent2 } } },
    { ellipse: { x: 8.55, y: 0.55, w: 0.3, h: 0.3, fill: { color: c.accent, transparency: 45 } } },
  ]
}
function thickTop(c, H) {
  void H
  return [
    { rect: { x: 0, y: 0, w: 10, h: 0.22, fill: { color: c.accent2 } } },
    { rect: { x: 0, y: 0.22, w: 2.2, h: 0.1, fill: { color: c.accent } } },
  ]
}
function waveBottom(c, H) {
  return [
    { rect: { x: 0, y: H - 0.14, w: 10, h: 0.14, fill: { color: c.accent2 } } },
    { ellipse: { x: -1.2, y: H - 0.75, w: 2.4, h: 1.6, fill: { color: c.accent, transparency: 70 } } },
    { ellipse: { x: 8.9, y: H - 0.6, w: 1.8, h: 1.2, fill: { color: c.accent, transparency: 80 } } },
  ]
}
function diagCorner(c, H) {
  return [
    { rect: { x: 7.8, y: -1.2, w: 3.6, h: 3.6, rotate: 35, fill: { color: c.accent, transparency: 88 } } },
    { rect: { x: 8.6, y: -0.6, w: 2.6, h: 2.6, rotate: 35, fill: { color: c.accent2, transparency: 82 } } },
    { rect: { x: 0, y: H - 0.1, w: 10, h: 0.1, fill: { color: c.accent2 } } },
  ]
}
function earthFooter(c, H) {
  return [
    { rect: { x: 0, y: H - 0.16, w: 10, h: 0.16, fill: { color: c.accent2 } } },
    { rect: { x: 0, y: H - 0.16, w: 3, h: 0.16, fill: { color: c.accent } } },
  ]
}

/** Палитра-хелпер: собирает объект цветов темы. */
function pal(bg, bgAlt, accent, accent2, text, textMuted, onAccent) {
  return { bg: normHex(bg), bgAlt: normHex(bgAlt), accent: normHex(accent), accent2: normHex(accent2), text: normHex(text), textMuted: normHex(textMuted), onAccent: normHex(onAccent) }
}

// ── 10 встроенных тем ──

const THEMES = [
  {
    id: 'corporate-blue',
    name: 'Corporate Blue',
    description: 'Классический деловой: белый фон, глубокий синий и оранжевый акцент. Отчёты, питчи, корпоративные деки.',
    style: 'light',
    tags: ['business', 'report', 'corporate', 'питч', 'отчёт'],
    colors: pal('#FFFFFF', '#F4F7FB', '#1F4E79', '#ED7D31', '#1F2937', '#64748B', '#FFFFFF'),
    fonts: { head: 'Calibri', body: 'Calibri' },
    titleBg: '#FFFFFF',
    masterObjects: barTop,
  },
  {
    id: 'midnight',
    name: 'Midnight Neon',
    description: 'Тёмная tech-тема: глубокий сине-графитовый фон, неоновые циан и фиолетовый. IT, стартапы, демо продуктов.',
    style: 'dark',
    tags: ['tech', 'startup', 'dark', 'it', 'демо'],
    colors: pal('#0F172A', '#1E293B', '#22D3EE', '#818CF8', '#E2E8F0', '#94A3B8', '#0F172A'),
    fonts: { head: 'Segoe UI', body: 'Segoe UI' },
    titleBg: '#0F172A',
    masterObjects: glowCorner,
  },
  {
    id: 'minimal',
    name: 'Minimal Swiss',
    description: 'Швейцарский минимализм: белый фон, чёрный текст, один красный акцент. Чистые смыслы без украшательств.',
    style: 'light',
    tags: ['minimal', 'clean', 'design', 'минимализм'],
    colors: pal('#FFFFFF', '#F8FAFC', '#DC2626', '#171717', '#0F0F0F', '#737373', '#FFFFFF'),
    fonts: { head: 'Segoe UI', body: 'Segoe UI' },
    titleBg: '#FFFFFF',
    masterObjects: lineBottom,
  },
  {
    id: 'sunset',
    name: 'Sunset Gradient',
    description: 'Тёплая творческая: тёмно-фиолетовый фон, коралловый и янтарный акценты, диагональные формы. Креатив, маркетинг.',
    style: 'dark',
    tags: ['creative', 'marketing', 'warm', 'креатив', 'маркетинг'],
    colors: pal('#1E1B4B', '#312E81', '#FB7185', '#FBBF24', '#F1F5F9', '#A5B4FC', '#1E1B4B'),
    fonts: { head: 'Trebuchet MS', body: 'Trebuchet MS' },
    titleBg: '#1E1B4B',
    masterObjects: diagCorner,
  },
  {
    id: 'forest',
    name: 'Forest Green',
    description: 'Природная светлая: мятный фон, глубокий зелёный и лайм. Эко, здоровье, образование.',
    style: 'light',
    tags: ['nature', 'eco', 'health', 'эко', 'природа'],
    colors: pal('#F0FDF4', '#DCFCE7', '#166534', '#84CC16', '#14532D', '#6B7280', '#FFFFFF'),
    fonts: { head: 'Calibri', body: 'Calibri' },
    titleBg: '#F0FDF4',
    masterObjects: barSide,
  },
  {
    id: 'elegant',
    name: 'Elegant Serif',
    description: 'Премиальная: айвори-фон, шрифт с засечками Georgia, тёмное золото. Юбилеи, годовые отчёты, luxury.',
    style: 'light',
    tags: ['elegant', 'premium', 'luxury', 'премиум', 'торжественное'],
    colors: pal('#FAF7F2', '#F3EDE3', '#92400E', '#B45309', '#292524', '#78716C', '#FFFFFF'),
    fonts: { head: 'Georgia', body: 'Georgia' },
    titleBg: '#FAF7F2',
    masterObjects: doubleTop,
  },
  {
    id: 'startup',
    name: 'Startup Indigo',
    description: 'Современная SaaS: светло-серый фон, индиго и розовый. Питчи, продуктовые обзоры, лендинг-стайл.',
    style: 'light',
    tags: ['startup', 'saas', 'product', 'питч', 'продукт'],
    colors: pal('#FAFAFA', '#EEF2FF', '#4F46E5', '#EC4899', '#18181B', '#71717A', '#FFFFFF'),
    fonts: { head: 'Segoe UI', body: 'Segoe UI' },
    titleBg: '#FAFAFA',
    masterObjects: dotCorner,
  },
  {
    id: 'mono',
    name: 'Mono Brutalist',
    description: 'Брутализм: чёрное на белом, жёлтый акцент, толстые полосы, моноширинный заголовочный. Смелые деки.',
    style: 'light',
    tags: ['brutalism', 'bold', 'mono', 'смело', 'брутально'],
    colors: pal('#FFFFFF', '#F5F5F5', '#FACC15', '#000000', '#000000', '#525252', '#000000'),
    fonts: { head: 'Consolas', body: 'Segoe UI' },
    titleBg: '#FACC15',
    masterObjects: thickTop,
  },
  {
    id: 'ocean',
    name: 'Ocean Deep',
    description: 'Глубоководная: тёмно-синий фон, небесный и бирюзовый, волны внизу. Наука, аналитика, дашборды.',
    style: 'dark',
    tags: ['science', 'analytics', 'dark', 'blue', 'наука', 'аналитика'],
    colors: pal('#082F49', '#0C4A6E', '#38BDF8', '#2DD4BF', '#E0F2FE', '#94A3B8', '#082F49'),
    fonts: { head: 'Segoe UI', body: 'Segoe UI' },
    titleBg: '#082F49',
    masterObjects: waveBottom,
  },
  {
    id: 'warm-earth',
    name: 'Warm Earth',
    description: 'Тёплая земляная: кремовый фон, терракота и охра. Гастрономия, путешествия, крафт.',
    style: 'light',
    tags: ['warm', 'food', 'travel', 'craft', 'еда', 'путешествия'],
    colors: pal('#FFFBEB', '#FEF3C7', '#9A3412', '#EA580C', '#431407', '#78716C', '#FFFFFF'),
    fonts: { head: 'Trebuchet MS', body: 'Trebuchet MS' },
    titleBg: '#FFFBEB',
    masterObjects: earthFooter,
  },
]

/** Найти встроенную тему по id (без учёта регистра). */
function findTheme(id) {
  const key = String(id || '').toLowerCase().trim()
  return THEMES.find((t) => t.id === key) || null
}

/** Высота слайда (дюймы) по layout-спеке — для адаптивного декора. */
function layoutHeight(layout) {
  if (typeof layout === 'object' && layout && Number(layout.height) > 0) return Number(layout.height)
  const key = String(layout || '16x9').toLowerCase().replace(/[\s_-]/g, '')
  if (key === '4x3' || key === 'wide' || key === '16x10') return key === '16x10' ? 6.25 : 7.5
  return 5.625
}

/** Есть ли явный цвет в опциях/ранах текстового объекта? */
function hasExplicitColor(obj) {
  const opts = obj.options || {}
  if (opts.color) return true
  if (Array.isArray(obj.runs) && obj.runs.some((r) => r.options && r.options.color)) return true
  if (Array.isArray(obj.paragraphs) && obj.paragraphs.some((p) => p && p.options && p.options.color)) return true
  return false
}

/**
 * Применить тему к спеке презентации (мутирует spec).
 * @param {object} spec спека ppt_create
 * @param {object} theme тема (встроенная или из extractTheme/кастомная):
 *   { id?, name?, style: 'dark'|'light', colors: {bg,bgAlt,accent,accent2,text,textMuted,onAccent}, fonts }
 * @returns {object} spec (тот же, для чейнинга)
 */
function applyTheme(spec, theme) {
  if (!spec || typeof spec !== 'object') throw new Error('applyTheme: spec обязателен')
  if (!theme || !theme.colors) throw new Error('applyTheme: theme.colors обязателен')
  const c = theme.colors
  for (const k of ['bg', 'accent', 'text']) {
    if (!c[k]) throw new Error('applyTheme: theme.colors.' + k + ' обязателен')
  }
  const style = theme.style === 'dark' || luminance(c.bg) < 0.35 ? 'dark' : 'light'
  const H = layoutHeight(spec.layout)

  // 1. Шрифты
  if (theme.fonts && (theme.fonts.head || theme.fonts.body)) {
    spec.theme = {
      headFontFace: theme.fonts.head || theme.fonts.body,
      bodyFontFace: theme.fonts.body || theme.fonts.head,
      ...(spec.theme || {}),
    }
  }

  // 2. Мастер с декором (если своих мастеров нет)
  const masterId = 'THEME'
  let createdMaster = false
  if (!Array.isArray(spec.masters) || !spec.masters.length) {
    const objects = []
    if (typeof theme.masterObjects === 'function') {
      objects.push(...theme.masterObjects(c, H))
    }
    spec.masters = [
      {
        id: masterId,
        background: { color: c.bg },
        objects,
        slideNumber: { x: 9.35, y: H - 0.32, color: c.textMuted, fontSize: 10 },
      },
    ]
    createdMaster = true
    // слайды без мастера → на тематический мастер
    for (const s of spec.slides) {
      if (!s.master) s.master = masterId
    }
  }

  // 3. Фоны слайдов
  const titleBg = theme.titleBg ? normHex(theme.titleBg) : c.bg
  spec.slides.forEach((s, i) => {
    if (!s.background) {
      s.background = i === 0 ? { color: titleBg } : { color: c.bg }
    }
  })

  // 4. Автоцвета текста + заголовки
  for (const s of spec.slides) {
    const isTitleSlide = s === spec.slides[0]
    for (const obj of s.objects || []) {
      if (obj.type !== 'text' && !(obj.type === 'shape' && (obj.text || obj.runs))) continue
      if (hasExplicitColor(obj)) continue

      // Эвристика заголовка: крупный кегль / bold / первый крупный текст титула
      const opts = obj.options || {}
      const big = Number(opts.fontSize) >= 26
      const bold = opts.bold === true
      const isHeading = big || bold

      const color = isHeading ? c.accent : c.text
      if (obj.type === 'text') {
        obj.options = { color, ...opts }
        // runs/paragraphs без цвета → цвет абзаца
        for (const r of obj.runs || []) r.options = { color, ...(r.options || {}) }
        for (const p of obj.paragraphs || []) {
          if (p && typeof p === 'object') p.options = { color, ...(p.options || {}) }
        }
      } else {
        obj.textOptions = { color, ...(obj.textOptions || {}) }
      }
    }

    // Таблицы на тёмной теме без цвета → светлый текст (читаемость)
    if (style === 'dark') {
      for (const obj of s.objects || []) {
        if (obj.type !== 'table') continue
        const opts = obj.options || {}
        if (!opts.color) obj.options = { color: c.text, ...opts }
      }
    }

    // Диаграммы без chartColors → палитра темы
    for (const obj of s.objects || []) {
      if (obj.type !== 'chart') continue
      const opts = obj.options || {}
      if (!opts.chartColors) {
        opts.chartColors = [c.accent, c.accent2, c.textMuted, c.bgAlt, c.text]
        obj.options = opts
      }
    }
  }

  return { createdMaster, bg: c.bg, titleBg: theme.titleBg ? normHex(theme.titleBg) : c.bg }
}

/** Краткое описание темы для листинга тула ppt_templates. */
function themeSummary(t) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    style: t.style,
    tags: t.tags,
    palette: [t.colors.bg, t.colors.accent, t.colors.accent2, t.colors.text],
    fonts: t.fonts,
  }
}

module.exports = { THEMES, findTheme, applyTheme, themeSummary, luminance, normHex, layoutHeight }
