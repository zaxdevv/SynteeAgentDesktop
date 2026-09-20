// settings — настройки плагина (storage, редактируются из панели)
const state = require('../state')

const DEFAULTS = {
  saveDir: '',              // '' → Documents\Office Tools
  openAfterCreate: false,   // открывать в Word после word_create
  showPreview: true,        // показывать карточки-виджеты в чате
  previewRows: 10,          // строк в превью таблиц
  // --- вёрстка (layout-дефолты для word_create) ---
  pageMargins: 'gost',      // 'gost' | 'word' | 'custom'
  customMargins: null,      // { top, right, bottom, left } в см (при pageMargins='custom')
  firstLineIndent: 'auto',  // 'auto' (для русских текстов) | 'on' | 'off'
  compactLists: true,       // компактные отступы списков (360 вместо 720 twips)
  smartBreaks: true,        // не отрывать заголовки от текста, не разрывать строки таблиц
}

/** Пресеты полей страницы (см). word = null → не задаём, docx сам ставит 1 дюйм. */
const MARGIN_PRESETS = {
  gost: { top: 2, right: 1.5, bottom: 2, left: 3 },
  word: null,
}

async function get() {
  const s = (await state.api.storage.get('settings')) || {}
  return { ...DEFAULTS, ...s }
}

async function set(patch) {
  const cur = await get()
  const next = { ...cur, ...patch }
  await state.api.storage.set('settings', next)
  return next
}

/** customMargins валидны: все 4 стороны заданы числами 0..30 см. */
function validMargins(m) {
  return !!(m && typeof m === 'object'
    && ['top', 'right', 'bottom', 'left'].every((k) => {
      const n = Number(m[k])
      return isFinite(n) && n > 0 && n < 30
    }))
}

/**
 * Layout-дефолты для buildDocument (контракт dist/lib/word/spec.js):
 * { margins: {top,right,bottom,left}|null, firstLineIndent, compactLists, smartBreaks }.
 * margins=null → не задаём поля, docx сам поставит 1 дюйм (пресет 'word').
 */
async function layoutDefaults() {
  const s = await get()
  let margins = MARGIN_PRESETS.gost
  if (s.pageMargins === 'word') {
    margins = null
  } else if (s.pageMargins === 'custom' && validMargins(s.customMargins)) {
    margins = {
      top: Number(s.customMargins.top),
      right: Number(s.customMargins.right),
      bottom: Number(s.customMargins.bottom),
      left: Number(s.customMargins.left),
    }
  }
  const fli = ['auto', 'on', 'off'].includes(s.firstLineIndent) ? s.firstLineIndent : 'auto'
  return {
    margins,
    firstLineIndent: fli,
    compactLists: s.compactLists !== false,
    smartBreaks: s.smartBreaks !== false,
  }
}

module.exports = { get, set, DEFAULTS, layoutDefaults, MARGIN_PRESETS, validMargins }
