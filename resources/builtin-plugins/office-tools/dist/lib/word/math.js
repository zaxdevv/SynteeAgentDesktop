// math — LaTeX ⇄ OMML: формулы Word (Equation Editor).
//
// 1) latexToMathElement(latex) → docx Math-элемент для blocks.js / word_edit.
//    Поддержка: \frac, \sqrt[n], ^/_ (в т.ч. оба), \sum/\prod/\int/\iint/\oint/
//    \bigcup... с пределами, \lim_{}, \sin/\cos/... , \text{}, \mathbb{},
//    \left(...\right) (круглые/квадратные/фигурные/угловые), матрицы
//    \begin{matrix|pmatrix|bmatrix|cases|array}, акценты (\hat \bar \vec \dot
//    \tilde \overline \underline...), греческие буквы и ~120 символов.
// 2) ommlToLatex(xml) + extractMath(buffer) — roundtrip: word_read
//    восстанавливает формулы из word/document.xml (mammoth их выбрасывает!)
//    в latex-виде: m:oMath → плейсхолдер ⟦MATH:N⟧ → math-блок спеки.

const docx = require('docx')
const {
  Math: MathElement, MathRun, MathFraction, MathRadical, MathSum, MathIntegral,
  MathSuperScript, MathSubScript, MathSubSuperScript, MathFunction,
  MathRoundBrackets, MathSquareBrackets, MathCurlyBrackets, MathAngledBrackets,
  MathLimitLower, MathLimitUpper, XmlComponent,
  createMathNAryProperties, createMathBase, createMathSubScriptElement,
  createMathSuperScriptElement, createMathAccentCharacter,
} = docx

// ---------- таблицы символов (LaTeX → Unicode) ----------

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
  varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ',
  varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}

const SYMBOLS = {
  times: '×', div: '÷', cdot: '⋅', pm: '±', mp: '∓', ast: '∗', star: '⋆',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
  equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝',
  infty: '∞', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒',
  Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦',
  implies: '⇒', iff: '⇔',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆',
  supseteq: '⊇', nsubset: '⊄',
  cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬',
  land: '∧', lor: '∨',
  oplus: '⊕', ominus: '⊖', otimes: '⊗', perp: '⊥', parallel: '∥',
  angle: '∠', triangle: '△', square: '□',
  degree: '°', prime: '′', circ: '∘', bullet: '•',
  cdots: '⋯', ldots: '…', vdots: '⋮', ddots: '⋱', dots: '…',
  aleph: 'ℵ', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', partial: '∂', nabla: '∇',
  surd: '√', top: '⊤', bot: '⊥', because: '∵', therefore: '∴',
  checkmark: '✓', dag: '†', ddag: '‡', pounds: '£', euro: '€', copyright: '©',
  langle: '⟨', rangle: '⟩', Vert: '‖', vert: '|', lvert: '|', rvert: '|',
  uparrow: '↑', downarrow: '↓', updownarrow: '↕',
  lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
}

const BIGOPS = {
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂', bigvee: '⋁',
  bigwedge: '⋀', bigodot: '⨀', biguplus: '⨄',
}

// интегралоподобные — пределы сбоку (subSup), остальные — сверху/снизу (undOvr)
const INTEGRAL_LIKE = new Set(['iint', 'iiint', 'oint', 'biguplus'])

const FUNCS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'arccot', 'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'det',
  'dim', 'deg', 'gcd', 'max', 'min', 'sup', 'inf', 'arg', 'ker', 'Pr',
  'lim', 'liminf', 'limsup',
])

const ACCENTS = {
  hat: '\u0302', widehat: '\u0302', bar: '\u0304', overline: '\u0305',
  vec: '\u20D7', dot: '\u0307', ddot: '\u0308', tilde: '\u0303',
  widetilde: '\u0303', underline: '\u0332', check: '\u030C', breve: '\u0306',
  acute: '\u0301', grave: '\u0300', mathring: '\u030A',
}

const MATHBB = {
  R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', H: 'ℍ', P: 'ℙ',
  A: '𝔸', B: '𝔹', D: '𝔻', E: '𝔼', F: '𝔽', G: '𝔾', I: '𝕀', J: '𝕁',
  K: '𝕂', L: '𝕃', M: '𝕄', O: '𝕆', S: '𝕊', T: '𝕋', U: '𝕌', V: '𝕍',
  W: '𝕎', X: '𝕏', Y: '𝕐',
}

const SPACING = {
  ',': '\u2009', ':': '\u2005', ';': '\u2005', '!': '',
  ' ': ' ', quad: '\u2003', qquad: '\u2003\u2003',
}

// стоп-символы тела n-ary оператора (после них тело не продолжается)
const REL_STOP = new Set(['=', '+', '-', '<', '>', ',', ';'])
const REL_CMDS = new Set([
  'leq', 'le', 'geq', 'ge', 'neq', 'ne', 'approx', 'equiv', 'sim', 'simeq',
  'cong', 'propto', 'to', 'rightarrow', 'leftarrow', 'Rightarrow', 'Leftarrow',
  'leftrightarrow', 'Leftrightarrow', 'mapsto', 'in', 'notin', 'ni', 'subset',
  'supset', 'subseteq', 'supseteq', 'cup', 'cap', 'land', 'lor', 'oplus',
  'ominus', 'otimes', 'perp', 'parallel', 'implies', 'iff',
])

// символы, разбивающие MathRun (операторы — Word рендерит их с мат. отступами)
const OP_SPLIT = new Set(['=', '+', '-', '<', '>', '/', '|', '!', '(', ')', '[', ']', '{', '}', '±', '×', '÷', '⋅', '≤', '≥', '≠', '≈', '≡', '→', '∈', '∪', '∩', '∞', '⋅'])

// ---------- обратные карты (Unicode → LaTeX) ----------

const UNICODE_TO_CMD = {}
for (const [cmd, ch] of Object.entries(GREEK)) if (!UNICODE_TO_CMD[ch]) UNICODE_TO_CMD[ch] = cmd
for (const [cmd, ch] of Object.entries(SYMBOLS)) if (!UNICODE_TO_CMD[ch]) UNICODE_TO_CMD[ch] = cmd

const NARY_TO_LATEX = {
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint',
  '∭': '\\iiint', '∮': '\\oint', '⋃': '\\bigcup', '⋂': '\\bigcap',
  '⨁': '\\bigoplus', '⨂': '\\bigotimes', '⋁': '\\bigvee', '⋀': '\\bigwedge',
  '⨀': '\\bigodot', '⨄': '\\biguplus',
}

const ACCENT_TO_LATEX = {}
for (const [cmd, ch] of Object.entries(ACCENTS)) if (!ACCENT_TO_LATEX[ch]) ACCENT_TO_LATEX[ch] = cmd

// ---------- кастомные OMML-элементы (не покрыты публичным API docx) ----------

/** Голый XML-элемент с детьми (для m:acc, m:accPr, m:m, m:mr и т.п.). */
class XmlEl extends XmlComponent {
  constructor(name, children) {
    super(name)
    if (children) for (const c of children) if (c != null) this.root.push(c)
  }
}

/** n-ary оператор с произвольным знаком (∏, ⋃, ∮, ∬...). */
class MathNary extends XmlComponent {
  constructor({ accent, children, subScript, superScript, limitLocation }) {
    super('m:nary')
    this.root.push(createMathNAryProperties({
      accent,
      hasSuperScript: !!superScript,
      hasSubScript: !!subScript,
      limitLocationVal: limitLocation || 'undOvr',
    }))
    if (subScript) this.root.push(createMathSubScriptElement({ children: subScript }))
    if (superScript) this.root.push(createMathSuperScriptElement({ children: superScript }))
    this.root.push(createMathBase({ children: children || [] }))
  }
}

/** Акцент над/под выражением: m:acc (hat/bar/vec/overline...). */
function mathAccent(chr, children) {
  return new XmlEl('m:acc', [
    new XmlEl('m:accPr', [createMathAccentCharacter({ accent: chr })]),
    createMathBase({ children }),
  ])
}

/** Матрица: m:m > m:mr > m:e. rows = [[компоненты ячейки, ...], ...]. */
function mathMatrix(rows) {
  return new XmlEl('m:m', rows.map((row) => new XmlEl('m:mr',
    row.map((cells) => createMathBase({ children: cells || [] })),
  )))
}

// ---------- токенизатор ----------

function tokenize(src) {
  const s = String(src == null ? '' : src)
  const tokens = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\') {
      if (s[i + 1] === '\\') { tokens.push({ t: 'nl' }); i += 2; continue }
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i))
      if (m) { tokens.push({ t: 'cmd', v: m[1] }); i += m[0].length; continue }
      i++
      continue
    }
    if (ch === '{' || ch === '}' || ch === '^' || ch === '_' || ch === '&') {
      tokens.push({ t: ch })
      i++
      continue
    }
    if (/\s/.test(ch)) { tokens.push({ t: 'sp', v: ' ' }); i++; continue }
    tokens.push({ t: 'ch', v: ch })
    i++
  }
  return tokens
}

// ---------- парсер LaTeX → docx Math-компоненты ----------

class LatexParser {
  constructor(latex) {
    this.tokens = tokenize(latex)
    this.pos = 0
  }

  eof() { return this.pos >= this.tokens.length }
  peek() { return this.tokens[this.pos] }
  next() { return this.tokens[this.pos++] }
  skipSp() { while (!this.eof() && this.peek().t === 'sp') this.pos++ }

  /** Аргумент команды: {группа} или один элемент. → массив компонентов.
   *  noScripts=true — не захватывать последующие ^/_ (аргументы пределов
   *  n-ary/lim/func: \int_0^1 — иначе ^1 уезжает в подстрочник). */
  parseArg(noScripts) {
    this.skipSp()
    const tk = this.peek()
    if (!tk) return []
    if (tk.t === '{') {
      this.next()
      return this.parseList(true)
    }
    if (noScripts) {
      const t = this.next()
      if (t.t === 'ch') {
        let text = t.v
        while (!this.eof() && this.peek().t === 'ch') {
          const nxt = this.peek().v
          if (OP_SPLIT.has(nxt) || OP_SPLIT.has(text[text.length - 1])) break
          text += this.next().v
        }
        return [new MathRun(text)]
      }
      if (t.t === 'cmd') {
        const item = this.parseCommand(t.v)
        return item ? (Array.isArray(item) ? item : [item]) : []
      }
      if (t.t === 'sp') return [new MathRun(' ')]
      return []
    }
    const item = this.parseItem()
    return item ? (Array.isArray(item) ? item : [item]) : []
  }

  /** Последовательность элементов до } (inGroup) или конца. */
  parseList(inGroup) {
    const items = []
    while (true) {
      this.skipSp()
      if (this.eof()) break
      const tk = this.peek()
      if (tk.t === '}') {
        this.next()
        if (inGroup) break
        continue // непарная } на верхнем уровне — пропустить
      }
      const item = this.parseItem()
      if (item) {
        if (Array.isArray(item)) items.push(...item)
        else items.push(item)
      }
    }
    return items
  }

  parseItem() {
    this.skipSp()
    const tk = this.peek()
    if (!tk) return null
    if (tk.t === 'ch') {
      this.next()
      let text = tk.v
      // сливаем обычные символы, разбивая на операторах
      while (!this.eof() && this.peek().t === 'ch') {
        const nxt = this.peek().v
        if (OP_SPLIT.has(nxt) || OP_SPLIT.has(text[text.length - 1])) break
        text += this.next().v
      }
      this.skipSp()
      // скрипт применяется только к ПОСЛЕДНЕМУ символу (семантика LaTeX: mc^2 = m·c²)
      if (!this.eof() && (this.peek().t === '^' || this.peek().t === '_')) {
        if (text.length > 1) {
          const prefix = new MathRun(text.slice(0, -1))
          const scripted = this.parseScripts(new MathRun(text[text.length - 1]))
          return [prefix, scripted]
        }
        return this.parseScripts(new MathRun(text))
      }
      return new MathRun(text)
    }
    if (tk.t === '{') {
      const group = this.parseArg() // съест { ... }
      return this.parseScripts(group)
    }
    if (tk.t === '^' || tk.t === '_') {
      return this.parseScripts(new MathRun('')) // скрипт без базы
    }
    if (tk.t === 'cmd') {
      this.next()
      const item = this.parseCommand(tk.v)
      if (item && !item.__scriptsDone) return this.parseScripts(item)
      return item
    }
    if (tk.t === 'nl' || tk.t === '&' || tk.t === 'sp') { this.next(); return new MathRun(' ') }
    this.next()
    return null
  }

  /** База + последующие ^/_ (в любом порядке, оба). */
  parseScripts(base) {
    this.skipSp()
    if (this.eof()) return base
    const t = this.peek().t
    if (t !== '^' && t !== '_') return base
    const baseArr = Array.isArray(base) ? base : [base]
    let sub, sup, hasSub = false, hasSup = false
    while (!this.eof() && (this.peek().t === '^' || this.peek().t === '_')) {
      const which = this.next().t
      // noScripts: x_i^2 — ^2 принадлежит той же базе x, а не уезжает в индекс i
      const arg = this.parseArg(true)
      if (which === '_') { sub = arg; hasSub = true }
      else { sup = arg; hasSup = true }
    }
    if (hasSub && hasSup) return new MathSubSuperScript({ children: baseArr, subScript: sub, superScript: sup })
    if (hasSub) return new MathSubScript({ children: baseArr, subScript: sub })
    return new MathSuperScript({ children: baseArr, superScript: sup })
  }

  /** Тело n-ary: до конца группы/стоп-оператора верхнего уровня. */
  parseNaryBody() {
    const items = []
    while (true) {
      this.skipSp()
      if (this.eof()) break
      const tk = this.peek()
      if (tk.t === '}') break
      if (tk.t === 'ch' && REL_STOP.has(tk.v)) break
      if (tk.t === 'cmd' && REL_CMDS.has(tk.v)) break
      const item = this.parseItem()
      if (item) {
        if (Array.isArray(item)) items.push(...item)
        else items.push(item)
      }
    }
    return items
  }

  /** Чтение разделителя после \left / \right. */
  readDelimiter() {
    this.skipSp()
    const tk = this.next()
    if (!tk) return '.'
    if (tk.t === 'ch') return tk.v
    if (tk.t === 'cmd') return SYMBOLS[tk.v] || tk.v
    return '.'
  }

  /** Тело \left...\right (вложенные \left обрабатываются рекурсивно). */
  parseUntilRight() {
    const items = []
    while (!this.eof()) {
      const tk = this.peek()
      if (tk.t === 'cmd' && tk.v === 'right') {
        this.next()
        this._closeDelim = this.readDelimiter()
        return items
      }
      const item = this.parseItem()
      if (item) {
        if (Array.isArray(item)) items.push(...item)
        else items.push(item)
      }
    }
    this._closeDelim = ''
    return items
  }

  /** Сырой текст группы {…} для \text/\mathrm/\begin и т.п. */
  readRawGroup() {
    this.skipSp()
    const tk = this.peek()
    if (!tk) return ''
    if (tk.t !== '{') {
      this.next()
      return tk.v != null ? String(tk.v) : ''
    }
    this.next() // {
    let depth = 1
    let out = ''
    while (!this.eof()) {
      const t = this.next()
      if (t.t === '{') { depth++; out += '{' }
      else if (t.t === '}') { depth--; if (!depth) break; out += '}' }
      else if (t.t === 'sp') out += ' '
      else if (t.t === 'ch' || t.t === '&' || t.t === '^' || t.t === '_') out += t.v
      else if (t.t === 'cmd') out += SYMBOLS[t.v] || GREEK[t.v] || t.v
      else if (t.t === 'nl') out += ' '
    }
    return out
  }

  parseCommand(name) {
    // --- дроби ---
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      const num = this.parseArg()
      const den = this.parseArg()
      return new MathFraction({ numerator: num, denominator: den })
    }
    if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
      const a = this.parseArg()
      const b = this.parseArg()
      return new MathRoundBrackets({ children: [new MathFraction({ numerator: a, denominator: b })] })
    }

    // --- корни ---
    if (name === 'sqrt') {
      let degree = null
      this.skipSp()
      if (this.peek() && this.peek().t === 'ch' && this.peek().v === '[') {
        this.next() // [
        const deg = []
        while (!this.eof() && !(this.peek().t === 'ch' && this.peek().v === ']')) {
          const it = this.parseItem()
          if (it) deg.push(it)
        }
        if (!this.eof()) this.next() // ]
        degree = deg
      }
      const body = this.parseArg()
      return new MathRadical({ children: body, degree })
    }

    // --- большие операторы ---
    if (BIGOPS[name]) {
      let sub, sup
      this.skipSp()
      while (!this.eof() && (this.peek().t === '^' || this.peek().t === '_')) {
        const which = this.next().t
        const arg = this.parseArg(true) // noScripts: \int_0^1 — ^1 не уезжает в подстрочник
        if (which === '_') sub = arg
        else sup = arg
      }
      const body = this.parseNaryBody()
      if (name === 'sum') return this._done(new MathSum({ children: body, subScript: sub, superScript: sup }))
      if (name === 'int') return this._done(new MathIntegral({ children: body, subScript: sub, superScript: sup }))
      return this._done(new MathNary({
        accent: BIGOPS[name],
        children: body,
        subScript: sub,
        superScript: sup,
        limitLocation: INTEGRAL_LIKE.has(name) ? 'subSup' : 'undOvr',
      }))
    }

    // --- функции и \lim ---
    if (FUNCS.has(name)) {
      this.skipSp()
      const hasSub = this.peek() && this.peek().t === '_'
      const hasSup = this.peek() && this.peek().t === '^'
      if (name === 'lim' && hasSub) {
        this.next() // _
        const lim = this.parseArg(true)
        return this._done(new MathLimitLower({ children: [new MathRun('lim')], limit: lim }))
      }
      if (hasSub || hasSup) {
        // \sin^2 x, \max_a — скрипты на имени функции
        const base = [new MathRun(name)]
        let sub, sup
        while (!this.eof() && (this.peek().t === '^' || this.peek().t === '_')) {
          const which = this.next().t
          const arg = this.parseArg(true)
          if (which === '_') sub = arg
          else sup = arg
        }
        let el
        if (sub && sup) el = new MathSubSuperScript({ children: base, subScript: sub, superScript: sup })
        else if (sub) el = new MathSubScript({ children: base, subScript: sub })
        else el = new MathSuperScript({ children: base, superScript: sup })
        return this._done(el)
      }
      const arg = this.parseArg()
      if (arg.length) return new MathFunction({ name: [new MathRun(name)], children: arg })
      return new MathRun(name + ' ')
    }

    // --- \left ... \right ---
    if (name === 'left') {
      const open = this.readDelimiter()
      const body = this.parseUntilRight()
      const close = this._closeDelim != null ? this._closeDelim : ')'
      return this.wrapDelimiters(open, close, body)
    }
    if (name === 'right') {
      // одиночный \right без \left — пропускаем разделитель
      this.readDelimiter()
      return new MathRun('')
    }

    // --- матрицы и окружения ---
    if (name === 'begin') {
      const env = this.readRawGroup().trim()
      return this.parseMatrix(env)
    }

    // --- текстовые режимы ---
    if (name === 'text' || name === 'mathrm' || name === 'operatorname' || name === 'textrm' || name === 'mbox') {
      return new MathRun(this.readRawGroup())
    }
    if (name === 'mathbb') {
      const raw = this.readRawGroup()
      return new MathRun(raw.split('').map((c) => MATHBB[c] || c).join(''))
    }
    if (name === 'mathbf' || name === 'mathit' || name === 'mathsf' || name === 'mathtt' || name === 'mathcal') {
      return new MathRun(this.readRawGroup())
    }

    // --- пределы снизу/сверху ---
    if (name === 'underset') {
      const lim = this.parseArg()
      const base = this.parseArg()
      return new MathLimitLower({ children: base, limit: lim })
    }
    if (name === 'overset') {
      const lim = this.parseArg()
      const base = this.parseArg()
      return new MathLimitUpper({ children: base, limit: lim })
    }

    // --- акценты ---
    if (ACCENTS[name] != null) {
      const arg = this.parseArg()
      return mathAccent(ACCENTS[name], arg)
    }

    // --- символы ---
    if (GREEK[name] != null) return new MathRun(GREEK[name])
    if (SYMBOLS[name] != null) return new MathRun(SYMBOLS[name])
    if (SPACING[name] !== undefined) return new MathRun(SPACING[name])

    // --- экранированные литералы: \{ \$ \% \# \& \_ \^ \| \\ \< \> ---
    if (/^[{}$%#&_^|\\<>]$/.test(name)) return new MathRun(name)

    // --- неизвестная команда: рендерим имя как есть (graceful) ---
    return new MathRun(name)
  }

  _done(el) {
    el.__scriptsDone = true
    return el
  }

  /** Обёртка \left X body \right Y → соответствующий класс скобок. */
  wrapDelimiters(open, close, body) {
    const o = open === '.' ? '' : open
    const c = close === '.' ? '' : close
    if (o === '(' && c === ')') return new MathRoundBrackets({ children: body })
    if (o === '[' && c === ']') return new MathSquareBrackets({ children: body })
    if ((o === '{' || o === '\\{') && (c === '}' || c === '\\}')) return new MathCurlyBrackets({ children: body })
    if (o === '⟨' && c === '⟩') return new MathAngledBrackets({ children: body })
    if (o === '|' && c === '|') return [new MathRun('|'), ...body, new MathRun('|')]
    if (o === '‖' && c === '‖') return [new MathRun('‖'), ...body, new MathRun('‖')]
    if (!o && !c) return body
    // смешанные/нестандартные — как круглые
    return new MathRoundBrackets({ children: body })
  }

  /** Матрица/окружение: ячейки через &, строки через \\. */
  parseMatrix(env) {
    if (env === 'array') this.readRawGroup() // спецификация колонок {cc|c} — пропускаем
    const rows = [[]]
    while (!this.eof()) {
      const tk = this.peek()
      if (tk.t === 'cmd' && tk.v === 'end') {
        this.next()
        this.readRawGroup() // имя окружения
        break
      }
      if (tk.t === 'nl') { this.next(); rows.push([]); continue }
      if (tk.t === '&') { this.next(); continue }
      if (tk.t === '}') { this.next(); continue }
      const cell = []
      while (!this.eof()) {
        const t2 = this.peek()
        if (t2.t === '&' || t2.t === 'nl') break
        if (t2.t === 'cmd' && t2.v === 'end') break
        if (t2.t === '}') break
        const it = this.parseItem()
        if (it) {
          if (Array.isArray(it)) cell.push(...it)
          else cell.push(it)
        }
      }
      rows[rows.length - 1].push(cell)
      if (!this.eof() && this.peek().t === '&') this.next()
    }
    if (rows.length > 1 && !rows[rows.length - 1].length) rows.pop()
    const matrix = mathMatrix(rows)
    if (env === 'pmatrix') return new MathRoundBrackets({ children: [matrix] })
    if (env === 'bmatrix') return new MathSquareBrackets({ children: [matrix] })
    if (env === 'Bmatrix') return new MathCurlyBrackets({ children: [matrix] })
    if (env === 'vmatrix') return [new MathRun('|'), matrix, new MathRun('|')]
    if (env === 'Vmatrix') return [new MathRun('‖'), matrix, new MathRun('‖')]
    if (env === 'cases') return new MathCurlyBrackets({ children: [matrix] })
    return matrix // matrix, aligned, align, gather, array...
  }
}

/** LaTeX → docx Math-элемент (для Paragraph.children). */
function latexToMathElement(latex) {
  const parser = new LatexParser(latex)
  const items = parser.parseList(false)
  return new MathElement({ children: items.length ? items : [new MathRun('')] })
}

// ---------- OMML → LaTeX (roundtrip для word_read) ----------

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' }

function decodeXml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (XML_ENTITIES[name] !== undefined ? XML_ENTITIES[name] : m))
}

/** Мини-парсер XML → { tag, attrs, children } (текст — строки). */
function parseXml(xml) {
  const root = { tag: 'root', attrs: {}, children: [] }
  const stack = [root]
  const re = /<(\/?)([a-zA-Z][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let m, last = 0
  const pushText = (t) => { if (t) stack[stack.length - 1].children.push(decodeXml(t)) }
  while ((m = re.exec(xml))) {
    if (m.index > last) pushText(xml.slice(last, m.index))
    last = re.lastIndex
    const tag = m[2]
    const attrs = {}
    const attrRe = /([\w.:-]+)\s*=\s*"([^"]*)"/g
    let am
    while ((am = attrRe.exec(m[3] || ''))) attrs[am[1]] = decodeXml(am[2])
    const selfClosing = /\/\s*$/.test(m[3] || '')
    if (m[1] === '/') {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break }
      }
    } else {
      const node = { tag, attrs, children: [] }
      stack[stack.length - 1].children.push(node)
      if (!selfClosing) stack.push(node)
    }
  }
  if (last < xml.length) pushText(xml.slice(last))
  return root
}

function findFirst(node, tag) {
  for (const c of node.children || []) {
    if (typeof c !== 'object' || !c) continue
    if (c.tag === tag) return c
    const found = findFirst(c, tag)
    if (found) return found
  }
  return null
}

function childByTag(node, tag) {
  for (const c of (node && node.children) || []) if (c && typeof c === 'object' && c.tag === tag) return c
  return null
}

function childrenByTag(node, tag) {
  return ((node && node.children) || []).filter((c) => c && typeof c === 'object' && c.tag === tag)
}

function textOf(node) {
  let out = ''
  for (const c of (node && node.children) || []) if (typeof c === 'string') out += c
  return out
}

/** Текст m:t → LaTeX (символы → команды, экранирование). */
function textToLatex(t) {
  let out = ''
  for (const ch of String(t)) {
    const cmd = UNICODE_TO_CMD[ch]
    if (cmd) out += '\\' + cmd + ' '
    else if ('\\{}$%&#^~'.includes(ch)) out += '\\' + ch
    else out += ch
  }
  return out
}

function childrenToLatex(nodes) {
  let out = ''
  for (const n of nodes || []) out += nodeToLatex(n)
  return out
}

function nodeToLatex(n) {
  if (typeof n === 'string') return textToLatex(n)
  if (!n || !n.tag) return ''
  switch (n.tag) {
    case 'm:r': {
      const t = childrenByTag(n, 'm:t').map(textOf).join('')
      // кириллица в math-run — это \text{} (прямой шрифт), оборачиваем обратно
      if (/[а-яА-ЯёЁ]/.test(t)) {
        return '\\text{' + t.replace(/([&%$#_{}])/g, '\\$1') + '}'
      }
      return textToLatex(t)
    }
    case 'm:f': {
      const num = childByTag(n, 'm:num')
      const den = childByTag(n, 'm:den')
      return '\\frac{' + childrenToLatex(num && num.children) + '}{' + childrenToLatex(den && den.children) + '}'
    }
    case 'm:rad': {
      const deg = childByTag(n, 'm:deg')
      const e = childByTag(n, 'm:e')
      const d = childrenToLatex(deg && deg.children).trim()
      return '\\sqrt' + (d ? '[' + d + ']' : '') + '{' + childrenToLatex(e && e.children) + '}'
    }
    case 'm:sSub': {
      const e = childByTag(n, 'm:e')
      const sub = childByTag(n, 'm:sub')
      return '{' + childrenToLatex(e && e.children) + '}_{' + childrenToLatex(sub && sub.children) + '}'
    }
    case 'm:sSup': {
      const e = childByTag(n, 'm:e')
      const sup = childByTag(n, 'm:sup')
      return '{' + childrenToLatex(e && e.children) + '}^{' + childrenToLatex(sup && sup.children) + '}'
    }
    case 'm:sSubSup': {
      const e = childByTag(n, 'm:e')
      const sub = childByTag(n, 'm:sub')
      const sup = childByTag(n, 'm:sup')
      return '{' + childrenToLatex(e && e.children) + '}_{' + childrenToLatex(sub && sub.children) + '}^{' + childrenToLatex(sup && sup.children) + '}'
    }
    case 'm:nary': {
      const pr = childByTag(n, 'm:naryPr')
      const chrEl = pr && childByTag(pr, 'm:chr')
      const chr = chrEl ? (chrEl.attrs['m:val'] || '∫') : '∫'
      const op = NARY_TO_LATEX[chr] || textToLatex(chr)
      const sub = childByTag(n, 'm:sub')
      const sup = childByTag(n, 'm:sup')
      const e = childByTag(n, 'm:e')
      return op
        + (sub ? '_{' + childrenToLatex(sub.children) + '}' : '')
        + (sup ? '^{' + childrenToLatex(sup.children) + '}' : '')
        + ' ' + childrenToLatex(e && e.children)
    }
    case 'm:func': {
      const fn = childByTag(n, 'm:fName')
      const e = childByTag(n, 'm:e')
      const name = childrenToLatex(fn && fn.children).trim()
      const body = childrenToLatex(e && e.children)
      return FUNCS.has(name) ? '\\' + name + ' ' + body : '\\operatorname{' + name + '}' + body
    }
    case 'm:d': {
      const pr = childByTag(n, 'm:dPr')
      const beg = pr && childByTag(pr, 'm:begChr')
      const end = pr && childByTag(pr, 'm:endChr')
      const b = beg ? (beg.attrs['m:val'] || '') : '('
      const en = end ? (end.attrs['m:val'] || '') : ')'
      const body = childrenToLatex(childrenByTag(n, 'm:e').flatMap((x) => x.children))
      return '\\left' + delimToLatex(b) + body + '\\right' + delimToLatex(en)
    }
    case 'm:acc': {
      const pr = childByTag(n, 'm:accPr')
      const chrEl = pr && childByTag(pr, 'm:chr')
      const chr = chrEl ? (chrEl.attrs['m:val'] || '\u0302') : '\u0302'
      const cmd = ACCENT_TO_LATEX[chr] || 'hat'
      const e = childByTag(n, 'm:e')
      return '\\' + cmd + '{' + childrenToLatex(e && e.children) + '}'
    }
    case 'm:limLow': {
      const e = childByTag(n, 'm:e')
      const lim = childByTag(n, 'm:lim')
      const base = childrenToLatex(e && e.children).trim()
      const l = childrenToLatex(lim && lim.children)
      if (base === 'lim') return '\\lim_{' + l + '}'
      return '\\underset{' + l + '}{' + base + '}'
    }
    case 'm:limUpp': {
      const e = childByTag(n, 'm:e')
      const lim = childByTag(n, 'm:lim')
      return '\\overset{' + childrenToLatex(lim && lim.children) + '}{' + childrenToLatex(e && e.children) + '}'
    }
    case 'm:m': {
      const rows = childrenByTag(n, 'm:mr').map((mr) =>
        childrenByTag(mr, 'm:e').map((e) => childrenToLatex(e.children).trim()),
      )
      return '\\begin{matrix}' + rows.map((r) => r.join(' & ')).join(' \\\\ ') + '\\end{matrix}'
    }
    case 'm:bar': {
      const pr = childByTag(n, 'm:barPr')
      const pos = pr && childByTag(pr, 'm:pos')
      const top = pos ? pos.attrs['m:val'] !== 'bot' : true
      const e = childByTag(n, 'm:e')
      return (top ? '\\overline{' : '\\underline{') + childrenToLatex(e && e.children) + '}'
    }
    default:
      // m:oMath, m:oMathPara, m:e, m:num, m:den, m:deg, m:sub, m:sup,
      // m:fName, m:lim, m:mr, m:groupChr, m:sPre... — контейнеры
      return childrenToLatex(n.children)
  }
}

function delimToLatex(d) {
  if (d === '' || d === '.') return '.'
  if (d === '{') return '\\{'
  if (d === '}') return '\\}'
  if (d === '⟨') return '\\langle '
  if (d === '⟩') return '\\rangle '
  if (d === '‖') return '\\Vert '
  return d
}

/** OMML XML (m:oMath) → LaTeX-строка. */
function ommlToLatex(xml) {
  try {
    const root = parseXml(String(xml))
    const omath = findFirst(root, 'm:oMath') || root
    return childrenToLatex(omath.children).replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

// ---------- extractMath: плейсхолдеры для mammoth ----------

const MATH_PH = /\u27E6MATH:(\d+)\u27E7/

/**
 * Заменяет все m:oMathPara/m:oMath в word/document.xml на текстовые
 * плейсхолдеры ⟦MATH:N⟧ (mammoth формулы выбрасывает). Возвращает
 * { buffer: пересобранный docx, latex: [latex-строки по номерам] }.
 */
function extractMath(buffer) {
  try {
    const AdmZip = require('adm-zip')
    const zip = new AdmZip(buffer)
    const doc = zip.readAsText('word/document.xml')
    if (!doc || doc.indexOf('<m:oMath') < 0) return { buffer, latex: [] }
    const latex = []
    const ph = (i) => '<w:r><w:t xml:space="preserve">\u27E6MATH:' + i + '\u27E7</w:t></w:r>'
    let modified = doc.replace(/<m:oMathPara(?:\s[^>]*)?>[\s\S]*?<\/m:oMathPara>/g, (m) => {
      const om = /<m:oMath(?:\s[^>]*)?>[\s\S]*?<\/m:oMath>/.exec(m)
      latex.push(om ? ommlToLatex(om[0]) : '')
      return ph(latex.length - 1)
    })
    modified = modified.replace(/<m:oMath(?:\s[^>]*)?>[\s\S]*?<\/m:oMath>/g, (m) => {
      latex.push(ommlToLatex(m))
      return ph(latex.length - 1)
    })
    zip.updateFile('word/document.xml', Buffer.from(modified, 'utf-8'))
    return { buffer: zip.toBuffer(), latex }
  } catch {
    return { buffer, latex: [] }
  }
}

/**
 * Блоки после htmlToBlocks: параграф-плейсхолдер → math-блок (display),
 * плейсхолдер внутри runs → инлайн math-run { math: latex }.
 */
function applyMath(blocks, latex) {
  if (!Array.isArray(latex) || !latex.length) return blocks
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (!b || typeof b !== 'object') continue
    if (b.type === 'paragraph' || b.type === 'heading') {
      const text = b.text != null ? String(b.text) : (b.runs || []).map((r) => (r && r.text) || '').join('')
      const m = /^\s*\u27E6MATH:(\d+)\u27E7\s*$/.exec(text)
      if (m) {
        blocks[i] = { type: 'math', latex: latex[Number(m[1])] || '', display: true }
        continue
      }
      if (MATH_PH.test(text)) {
        const runs = b.runs || (b.text != null ? [{ text: String(b.text) }] : [])
        b.runs = splitMathRuns(runs, latex)
        delete b.text
      }
    }
  }
  return blocks
}

function splitMathRuns(runs, latex) {
  const out = []
  for (const r of runs || []) {
    const text = r && typeof r === 'object' ? r.text : null
    if (!text || !MATH_PH.test(text)) { out.push(r); continue }
    const parts = String(text).split(/(\u27E6MATH:\d+\u27E7)/)
    for (const p of parts) {
      if (!p) continue
      const m = /^\u27E6MATH:(\d+)\u27E7$/.exec(p)
      if (m) out.push({ math: latex[Number(m[1])] || '' })
      else out.push({ ...r, text: p })
    }
  }
  return out
}

/** Зачистка: оставшиеся плейсхолдеры (таблицы, заголовки, списки) → $latex$. */
function sweepMathText(blocks, latex) {
  if (!Array.isArray(latex) || !latex.length) return
  const fix = (s) => String(s).replace(/\u27E6MATH:(\d+)\u27E7/g, (_, i) => '$' + (latex[Number(i)] || '') + '$')
  const walk = (val) => {
    if (typeof val === 'string') return fix(val)
    if (!val || typeof val !== 'object') return val
    if (Array.isArray(val)) return val.map(walk)
    const out = {}
    for (const [k, v] of Object.entries(val)) {
      if (k === 'latex') { out[k] = v; continue }
      out[k] = walk(v)
    }
    return out
  }
  for (let i = 0; i < blocks.length; i++) blocks[i] = walk(blocks[i])
}

module.exports = {
  latexToMathElement,
  ommlToLatex,
  extractMath,
  applyMath,
  sweepMathText,
  tokenize,
}
