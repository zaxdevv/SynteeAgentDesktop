import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { v4 as uuid } from 'uuid'
import ColorPickerPopover from '../../ui/ColorPicker/ColorPickerPopover'
import AppIcon from '../../ui/AppIcon/AppIcon'
import { copyToClipboard } from '@renderer/utils/clipboard'
import {
  normalizeHex, hexToRgb, rgbToHex, relLuminance, contrastText,
  tint, shade, withAlpha,
} from '../../../utils/colorUtils'
import { applyCustomThemeToDOM } from '../../../App'
import { useUIStore } from '../../../store/ui.store'
import { BUILTIN_THEMES } from '../../../utils/builtinThemes'
import type { CustomTheme } from '../../../../../shared/types'
import './CustomThemeEditor.css'

interface Props {
  open: boolean
  /** null → создание новой темы (показываем выбор шаблона), string → правка существующей. */
  editId: string | null
  themes: CustomTheme[]
  activeId: string | null
  onChange: (themes: CustomTheme[], activeId?: string | null) => void
  onApply: (id: string) => void
  onClose: () => void
}

type ColorKey = keyof CustomTheme['colors']

// ── Поля цветов с человеческими названиями ─────────────────────
interface FieldDef { key: ColorKey; label: string; hint: string; alpha?: boolean; optional?: boolean }

const FIELD_GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: 'Фон и панели',
    fields: [
      { key: 'bodyBg', label: 'Фон окна', hint: 'Самый нижний слой приложения' },
      { key: 'bgPrimary', label: 'Панели', hint: 'Шапка, карточки, попапы', alpha: true },
      { key: 'bgSecondary', label: 'Пузыри и поля', hint: 'Сообщения, инпуты, кнопки', alpha: true },
      { key: 'bgTertiary', label: 'Приподнятые элементы', hint: 'Ховер-панели, бейджи', alpha: true },
      { key: 'sidebarBg', label: 'Сайдбар', hint: 'Левая панель со списком чатов', alpha: true },
    ],
  },
  {
    title: 'Текст',
    fields: [
      { key: 'textPrimary', label: 'Основной текст', hint: 'Сообщения, заголовки' },
      { key: 'textSecondary', label: 'Вторичный текст', hint: 'Описания, подписи' },
      { key: 'textMuted', label: 'Приглушённый текст', hint: 'Время, плейсхолдеры' },
    ],
  },
  {
    title: 'Акцент',
    fields: [
      { key: 'accent', label: 'Акцент', hint: 'Кнопки, ссылки, выделение' },
      { key: 'accentGradient', label: 'Акцент 2', hint: 'Второй цвет градиента (необязательно)', optional: true },
    ],
  },
  {
    title: 'Детали',
    fields: [
      { key: 'border', label: 'Границы', hint: 'Тонкие рамки (пусто = авто из акцента)', optional: true },
      { key: 'borderStrong', label: 'Границы сильные', hint: 'Акцентные рамки (пусто = авто)', optional: true },
      { key: 'shadowColor', label: 'Цвет тени', hint: 'Тени панелей (пусто = авто)', optional: true },
    ],
  },
]

// Простой режим: 4 цвета, остальные 9 выводятся автоматически.
const SIMPLE_FIELDS: FieldDef[] = [
  { key: 'bodyBg', label: 'Фон', hint: 'Основной фон приложения' },
  { key: 'bgSecondary', label: 'Панели', hint: 'Пузыри, кнопки, поля ввода' },
  { key: 'textPrimary', label: 'Текст', hint: 'Основной цвет текста' },
  { key: 'accent', label: 'Акцент', hint: 'Кнопки и выделение' },
]

// ── Цветовые хелперы ───────────────────────────────────────────

/** Смешение двух hex: t=0 → a, t=1 → b. */
function mixHex(a: string, b: string, t: number): string {
  const ra = hexToRgb(a), rb = hexToRgb(b)
  if (!ra || !rb) return a
  return rgbToHex({
    r: ra.r + (rb.r - ra.r) * t,
    g: ra.g + (rb.g - ra.g) * t,
    b: ra.b + (rb.b - ra.b) * t,
  })
}

/** Парсит hex И rgba(...) → { hex, alpha }. alpha=null для чистого hex. */
function parseColorValue(v: string): { hex: string; alpha: number | null } {
  if (!v) return { hex: '', alpha: null }
  const m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/)
  if (m) {
    return {
      hex: rgbToHex({ r: +m[1], g: +m[2], b: +m[3] }),
      alpha: m[4] !== undefined ? Math.round(+m[4] * 100) / 100 : 1,
    }
  }
  const norm = normalizeHex(v)
  return { hex: norm || '', alpha: null }
}

/** Собирает hex + alpha обратно в строку (rgba при alpha < 1). */
function combineColor(hex: string, alpha: number | null): string {
  if (!hex) return ''
  if (alpha === null || alpha >= 1) return hex
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
}

/** Переводит rgba в непрозрачный hex поверх фона bg. */
function solidify(color: string, bg: string): string | null {
  const { hex, alpha } = parseColorValue(color)
  if (!hex) return null
  if (alpha === null || alpha >= 1) return hex
  return mixHex(hex, bg, 1 - alpha)
}

function contrastRatio(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const ra = hexToRgb(a), rb = hexToRgb(b)
  if (!ra || !rb) return null
  const la = relLuminance(ra), lb = relLuminance(rb)
  const hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** Автовывод всех цветов темы из 4 базовых (простой режим). */
function deriveColors(bg: string, surface: string, text: string, accent: string, base: 'light' | 'dark'): CustomTheme['colors'] {
  const dark = base === 'dark'
  return {
    bodyBg: bg,
    bgPrimary: withAlpha(mixHex(surface, bg, 0.25), 0.82),
    bgSecondary: withAlpha(surface, 0.85),
    bgTertiary: withAlpha(dark ? tint(surface, 0.1) : shade(surface, 0.07), 0.88),
    textPrimary: text,
    textSecondary: mixHex(text, surface, 0.38),
    textMuted: mixHex(text, surface, 0.68),
    accent,
    sidebarBg: withAlpha(mixHex(bg, surface, 0.35), 0.88),
    border: '', borderStrong: '', accentGradient: '', shadowColor: '',
  }
}

function makeDraft(name: string, base: 'light' | 'dark', colors: CustomTheme['colors']): CustomTheme {
  return {
    id: uuid(),
    name,
    base,
    colors: { ...colors },
    glass: { blur: 20, saturate: 180, opacity: 100 },
    effects: { overlayIntensity: 1 },
  }
}

const HISTORY_LIMIT = 50

// Какие цвета показывает каждый элемент мокапа (data-tk атрибут).
// Если элемент зависит от нескольких цветов — перечисляем все.
// На уровне модуля (не в компоненте) — стабильная ссылка для useCallback.
const ELEMENT_COLOR_KEYS: Record<string, string[]> = {
  bodyBg: ['bodyBg'],
  sidebarBg: ['sidebarBg'],
  bgPrimary: ['bgPrimary'],
  bgSecondary: ['bgSecondary'],
  bgTertiary: ['bgTertiary'],
  textPrimary: ['textPrimary'],
  textSecondary: ['textSecondary'],
  textMuted: ['textMuted'],
  accent: ['accent', 'accentGradient'],
  border: ['border'],
  borderStrong: ['borderStrong'],
  glass: ['glass'],
}

// В простом режиме один базовый цвет влияет на много производных —
// подсвечиваем все элементы, которые показывают производные от него.
const SIMPLE_AFFECTED: Record<string, string[]> = {
  bodyBg: ['bodyBg', 'sidebarBg', 'bgPrimary', 'bgSecondary', 'bgTertiary'],
  bgSecondary: ['bgPrimary', 'bgSecondary', 'bgTertiary', 'sidebarBg'],
  textPrimary: ['textPrimary', 'textSecondary', 'textMuted'],
  accent: ['accent', 'border', 'borderStrong', 'glass'],
}

// Обёртка: монтирует редактор только когда open=true, key по editId —
// при смене цели редактирования внутренний компонент перемонтируется,
// и весь стейт инициализируется заново через useState-инициализаторы
// (без setState-в-эффекте, на который ругается react-hooks).
export default function CustomThemeEditor(props: Props) {
  if (!props.open) return null
  return <EditorInner key={props.editId ?? 'new'} {...props} />
}

function EditorInner({ editId, themes, activeId, onChange, onApply, onClose }: Props) {
  const [draft, setDraft] = useState<CustomTheme | null>(() => {
    if (!editId) return null // создание новой → выбор шаблона
    const t = themes.find(x => x.id === editId)
    return t ? (JSON.parse(JSON.stringify(t)) as CustomTheme) : null
  })
  const [mode, setMode] = useState<'simple' | 'advanced'>(editId ? 'advanced' : 'simple')
  const [openPicker, setOpenPicker] = useState<ColorKey | null>(null)
  const [highlightKey, setHighlightKey] = useState<ColorKey | null>(null)
  const [past, setPast] = useState<CustomTheme[]>([])
  const [future, setFuture] = useState<CustomTheme[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')
  const [exportMsg, setExportMsg] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Подтверждение закрытия с несохранёнными изменениями (защита от мисклика).
  const [confirmClose, setConfirmClose] = useState(false)

  const activeSwatchRef = useRef<HTMLButtonElement>(null)
  const fieldRefs = useRef<Partial<Record<ColorKey, HTMLDivElement | null>>>({})
  const rafRef = useRef<number | null>(null)
  // Снапшот реальной темы на момент открытия — для восстановления при отмене.
  const snapshotRef = useRef<{ theme: string; customId: string | null } | null>(null)
  // Сохранённая тема — cleanup применяет её вместо отката к снапшоту.
  const savedDraftRef = useRef<CustomTheme | null>(null)
  // База для debounce-истории (драг пикера / тик слайдера = одна запись в undo).
  const historyBaseRef = useRef<CustomTheme | null>(null)
  const historyTimerRef = useRef<number | null>(null)

  // ── Снапшот темы при монтировании + восстановление при размонтировании ──
  useEffect(() => {
    const st = useUIStore.getState()
    snapshotRef.current = { theme: st.theme, customId: st.activeCustomThemeId }
    return () => {
      const saved = savedDraftRef.current
      if (saved) {
        // Сохранили — применяем сохранённую тему (store уже обновлён через onApply).
        document.documentElement.setAttribute('data-theme', 'custom')
        applyCustomThemeToDOM(saved)
        savedDraftRef.current = null
        return
      }
      const snap = snapshotRef.current
      const st2 = useUIStore.getState()
      if (!snap) return
      document.documentElement.setAttribute('data-theme', snap.theme)
      if (snap.theme === 'custom') {
        const ct = st2.customThemes.find(t => t.id === snap.customId)
        if (ct) applyCustomThemeToDOM(ct)
        else applyCustomThemeToDOM(null)
      } else {
        applyCustomThemeToDOM(null)
      }
      snapshotRef.current = null
    }
  }, [])

  // ── Живое превью draft на всём приложении (rAF-throttled) ──
  useEffect(() => {
    if (!draft) return
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      document.documentElement.setAttribute('data-theme', 'custom')
      applyCustomThemeToDOM(draft)
    })
    return () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null } }
  }, [draft])

  // ── История (undo/redo) ──
  const flushHistory = useCallback(() => {
    if (historyTimerRef.current) { clearTimeout(historyTimerRef.current); historyTimerRef.current = null }
    if (historyBaseRef.current) {
      const base = historyBaseRef.current
      historyBaseRef.current = null
      setPast(p => [...p.slice(-(HISTORY_LIMIT - 1)), base])
      setFuture([])
    }
  }, [])

  /** Изменение с немедленной записью в историю (клики, шаблоны, derive). */
  const commitDraft = useCallback((next: CustomTheme) => {
    setDraft(prev => {
      if (prev) {
        setPast(p => [...p.slice(-(HISTORY_LIMIT - 1)), prev])
        setFuture([])
      }
      return next
    })
  }, [])

  /** Изменение без немедленной истории — драг пикера/слайдера (debounce 400мс). */
  const updateDraftLive = useCallback((next: CustomTheme) => {
    setDraft(prev => {
      if (prev && !historyBaseRef.current) historyBaseRef.current = prev
      return next
    })
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current)
    historyTimerRef.current = window.setTimeout(() => flushHistory(), 400)
  }, [flushHistory])

  const undo = useCallback(() => {
    flushHistory()
    setPast(p => {
      if (p.length === 0) return p
      const prev = p[p.length - 1]
      setDraft(cur => {
        if (cur) setFuture(f => [cur, ...f].slice(0, HISTORY_LIMIT))
        return prev
      })
      return p.slice(0, -1)
    })
  }, [flushHistory])

  const redo = useCallback(() => {
    setFuture(f => {
      if (f.length === 0) return f
      const next = f[0]
      setDraft(cur => {
        if (cur) setPast(p => [...p.slice(-(HISTORY_LIMIT - 1)), cur])
        return next
      })
      return f.slice(1)
    })
  }, [])

  // ── Подсветка «что меняется» ─────────────────────────────────
  // При изменении цвета/стекла — на ~1.2с подсвечиваем затронутые элементы
  // мокапа (пульс-контур) и помечаем активное поле бейджем «меняется».
  // Чтобы не бегать глазами по мокапу в поисках изменения.
  // Объявлено ДО setColor/applySimpleColor, которые его используют.
  const [affected, setAffected] = useState<Set<string> | null>(null)
  const affectedTimer = useRef<number | null>(null)
  const flashAffected = useCallback((keys: string[]) => {
    if (affectedTimer.current) clearTimeout(affectedTimer.current)
    setAffected(new Set(keys))
    affectedTimer.current = window.setTimeout(() => setAffected(null), 1200)
  }, [])
  useEffect(() => () => { if (affectedTimer.current) clearTimeout(affectedTimer.current) }, [])

  // Какие элементы мокапа подсветить для изменённого поля.
  const elementsForField = useCallback((key: ColorKey): string[] => {
    if (mode === 'simple' && SIMPLE_AFFECTED[key]) return SIMPLE_AFFECTED[key]
    return Object.entries(ELEMENT_COLOR_KEYS)
      .filter(([, colorKeys]) => colorKeys.includes(key))
      .map(([el]) => el)
  }, [mode])

  // ── Защита от случайного закрытия ──
  // dirty = есть несохранённые изменения (тема выбрана/изменена).
  // При попытке закрыть — показываем подтверждение вместо мгновенного выхода.
  // Объявлено ДО keydown-эффекта, который его использует.
  const isDirty = !!draft
  const requestClose = useCallback(() => {
    if (isDirty) setConfirmClose(true)
    else onClose()
  }, [isDirty, onClose])

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y + Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (openPicker) { flushHistory(); setOpenPicker(null) }
        else requestClose()
        e.stopPropagation()
        return
      }
      if (!(e.ctrlKey || e.metaKey)) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [openPicker, undo, redo, flushHistory, requestClose])

  // ── Изменение цвета ──
  // live=true — драг пикера/слайдера (история debounce); live=false — коммит.
  const setColor = useCallback((key: ColorKey, value: string, live: boolean) => {
    if (!draft) return
    const next = { ...draft, colors: { ...draft.colors, [key]: value } }
    if (live) updateDraftLive(next)
    else commitDraft(next)
    flashAffected(elementsForField(key))
  }, [draft, updateDraftLive, commitDraft, flashAffected, elementsForField])

  // Простой режим: меняем один из 4 базовых → автовывод остальных.
  const applySimpleColor = useCallback((key: ColorKey, hex: string, live: boolean) => {
    if (!draft) return
    const cur = {
      bodyBg: parseColorValue(draft.colors.bodyBg).hex || '#0e0e12',
      bgSecondary: parseColorValue(draft.colors.bgSecondary).hex || '#1c1c24',
      textPrimary: parseColorValue(draft.colors.textPrimary).hex || '#e8e8ec',
      accent: parseColorValue(draft.colors.accent).hex || '#4d9fff',
      [key]: hex,
    }
    const derived = deriveColors(cur.bodyBg, cur.bgSecondary, cur.textPrimary, cur.accent, draft.base)
    const next = { ...draft, colors: derived }
    if (live) updateDraftLive(next)
    else commitDraft(next)
    flashAffected(elementsForField(key))
  }, [draft, updateDraftLive, commitDraft, flashAffected, elementsForField])

  // ── Пикер ──
  const openFieldPicker = useCallback((key: ColorKey) => {
    const isSimpleKey = SIMPLE_FIELDS.some(f => f.key === key)
    if (mode === 'simple' && !isSimpleKey) setMode('advanced')
    setOpenPicker(key)
    setHighlightKey(key)
    window.setTimeout(() => {
      fieldRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
    window.setTimeout(() => setHighlightKey(k => (k === key ? null : k)), 1600)
  }, [mode])

  const pickerFieldDef = useMemo(() => {
    if (!openPicker) return null
    for (const g of FIELD_GROUPS) {
      const f = g.fields.find(x => x.key === openPicker)
      if (f) return f
    }
    return SIMPLE_FIELDS.find(f => f.key === openPicker) || null
  }, [openPicker])

  const pickerValue = useMemo(() => {
    if (!draft || !openPicker) return '#ffffff'
    return parseColorValue(draft.colors[openPicker] || '').hex || '#ffffff'
  }, [draft, openPicker])

  // Во время драга пикера тему НЕ трогаем — только подсвечиваем swatch
  // активного поля (dragColor). Цвет применяется к теме строго на
  // отпускании (onCommit) — как попросил юзер: «отпустил на нужном →
  // применило». Заодно вся сессия драга = ровно одна запись в undo.
  const [dragColor, setDragColor] = useState<{ key: ColorKey; hex: string } | null>(null)

  // Сброс drag-подсветки при закрытии пикера (Escape/клик мимо без коммита).
  // НЕ через useEffect+setState (react-hooks/set-state-in-effect) и НЕ через
  // ref-в-рендере (react-hooks/react-compiler), а через prev-state в useState —
  // рекомендованный React-паттерн «adjusting state during render».
  const [prevOpenPicker, setPrevOpenPicker] = useState<ColorKey | null>(null)
  if (prevOpenPicker !== openPicker) {
    setPrevOpenPicker(openPicker)
    if (!openPicker && dragColor) setDragColor(null)
  }

  const handlePickerChange = useCallback((hex: string) => {
    if (openPicker) setDragColor({ key: openPicker, hex })
  }, [openPicker])

  const handlePickerCommit = useCallback((hex: string) => {
    if (!draft || !openPicker) return
    setDragColor(null)
    if (mode === 'simple' && SIMPLE_FIELDS.some(f => f.key === openPicker)) {
      applySimpleColor(openPicker, hex, false)
      return
    }
    const cur = parseColorValue(draft.colors[openPicker] || '')
    const value = pickerFieldDef?.alpha ? combineColor(hex, cur.alpha ?? 0.85) : hex
    setColor(openPicker, value, false)
    flashAffected(elementsForField(openPicker))
  }, [draft, openPicker, mode, pickerFieldDef, applySimpleColor, setColor, flashAffected, elementsForField])

  // ── Шаблоны ──
  const pickBuiltinTemplate = (id: string) => {
    const bt = BUILTIN_THEMES.find(t => t.id === id)
    if (!bt) return
    const d = makeDraft(`Моя тема ${themes.length + 1}`, bt.group, bt.template)
    setDraft(d)
    setPast([]); setFuture([])
  }

  const pickCustomTemplate = (t: CustomTheme) => {
    const d = { ...JSON.parse(JSON.stringify(t)) as CustomTheme, id: uuid(), name: `${t.name} копия` }
    setDraft(d)
    setPast([]); setFuture([])
  }

  // ── Импорт / экспорт ──
  const doImport = () => {
    try {
      const parsed = JSON.parse(importText) as CustomTheme
      if (!parsed.name || !parsed.colors || !parsed.glass) {
        setImportError('Неверный формат темы')
        return
      }
      setDraft({ ...parsed, id: uuid() })
      setPast([]); setFuture([])
      setImportOpen(false); setImportText(''); setImportError('')
    } catch {
      setImportError('Ошибка парсинга JSON')
    }
  }

  const doExport = async () => {
    if (!draft) return
    const ok = await copyToClipboard(JSON.stringify(draft, null, 2))
    if (ok) {
      setExportMsg('JSON скопирован')
      setTimeout(() => setExportMsg(''), 2000)
    }
  }

  // ── Сохранение / удаление / дублирование ──
  const handleSave = () => {
    if (!draft) return
    flushHistory()
    const final = { ...draft, name: draft.name.trim() || 'Без названия' }
    const exists = themes.some(t => t.id === final.id)
    const next = exists ? themes.map(t => (t.id === final.id ? final : t)) : [...themes, final]
    savedDraftRef.current = final
    onChange(next, final.id)
    onApply(final.id)
    onClose()
  }

  const handleDelete = () => {
    if (!editId) return
    onChange(themes.filter(t => t.id !== editId), editId === activeId ? null : undefined)
    onClose()
  }

  const handleDuplicate = () => {
    if (!draft) return
    const copy = { ...draft, id: uuid(), name: `${draft.name} копия` }
    onChange([...themes, copy])
    setDraft(copy)
    setPast([]); setFuture([])
  }

  // ── Контраст-чекер ──
  const contrastRows = useMemo(() => {
    if (!draft) return []
    const c = draft.colors
    const body = solidify(c.bodyBg, draft.base === 'dark' ? '#000000' : '#ffffff') || '#000000'
    const surface = solidify(c.bgSecondary, body) || body
    const accentSolid = solidify(c.accent, surface) || surface
    const onAccent = contrastText(accentSolid) === '#000' ? '#000000' : '#ffffff'
    return [
      { label: 'Текст', ratio: contrastRatio(solidify(c.textPrimary, surface), surface) },
      { label: 'Вторичный', ratio: contrastRatio(solidify(c.textSecondary, surface), surface) },
      { label: 'Акцент', ratio: contrastRatio(accentSolid, surface) },
      { label: 'На акценте', ratio: contrastRatio(onAccent, accentSolid) },
    ]
  }, [draft])

  // ── Рендер ──
  const c = draft?.colors
  const accentHex = c ? (parseColorValue(c.accent).hex || '#888888') : '#888888'
  const borderVal = c?.border || withAlpha(accentHex, 0.12)
  const borderStrongVal = c?.borderStrong || withAlpha(accentHex, 0.25)
  const accentBg = c?.accentGradient
    ? `linear-gradient(135deg, ${c.accent}, ${c.accentGradient})`
    : accentHex
  const onAccentColor = contrastText(accentHex) === '#000' ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)'

  // Тень мокапа из draft — те же формулы, что в applyCustomThemeToDOM:
  // shadowColor если задан, иначе bodyBg (light) / чёрный (dark).
  const mockShadow = useMemo(() => {
    if (!draft || !c) return undefined
    let rgb: { r: number; g: number; b: number } | null = null
    if (c.shadowColor) rgb = hexToRgb(parseColorValue(c.shadowColor).hex || '')
    if (!rgb) {
      rgb = draft.base === 'light'
        ? hexToRgb(parseColorValue(c.bodyBg).hex || '#000000')
        : { r: 0, g: 0, b: 0 }
    }
    if (!rgb) return undefined
    return `0 16px 48px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5)`
  }, [draft, c])

  // Glass-панель мокапа — формулы glassBg как в applyCustomThemeToDOM.
  const mockGlassBg = draft
    ? (draft.base === 'light'
        ? withAlpha('#ffffff', 0.7 * (draft.glass.opacity / 100))
        : withAlpha(accentHex, 0.05 * (draft.glass.opacity / 100)))
    : 'transparent'

  // Поля для легенды под мокапом: в простом режиме — 4 базовых, в продвинутом — все 13.
  const legendFields = useMemo(() => (
    mode === 'simple' ? SIMPLE_FIELDS : FIELD_GROUPS.flatMap(g => g.fields)
  ), [mode])

  // Скролл к секции glass-слайдеров (клик по glass-панели мокапа).
  const glassSectionRef = useRef<HTMLDivElement>(null)

  // Подсветка при изменении стекла/оверлея — элементы, зависящие от glass.
  const flashGlass = useCallback(() => flashAffected(['glass']), [flashAffected])

  // Обёртка для glass/overlay-слайдеров: обновляет draft + подсвечивает
  // glass-панель мокапа, чтобы было видно что меняется.
  const updateGlass = useCallback((patch: Partial<CustomTheme['glass']>) => {
    if (!draft) return
    updateDraftLive({ ...draft, glass: { ...draft.glass, ...patch } })
    flashGlass()
  }, [draft, updateDraftLive, flashGlass])

  const updateOverlay = useCallback((v: number) => {
    if (!draft) return
    updateDraftLive({ ...draft, effects: { overlayIntensity: v } })
    flashGlass()
  }, [draft, updateDraftLive, flashGlass])

  const renderColorField = (f: FieldDef) => {
    if (!draft || !c) return null
    const raw = c[f.key] || ''
    const parsed = parseColorValue(raw)
    const isOpen = openPicker === f.key
    const isAffected = affected ? [...affected].some(el => ELEMENT_COLOR_KEYS[el]?.includes(f.key)) : false
    return (
      <div
        key={f.key}
        ref={el => { fieldRefs.current[f.key] = el }}
        className={`cte-field${highlightKey === f.key ? ' cte-field--highlight' : ''}${isAffected ? ' cte-field--affected' : ''}`}
      >
        <button
          ref={isOpen ? activeSwatchRef : undefined}
          type="button"
          className="cte-field-swatch"
          style={{ background: (dragColor?.key === f.key ? dragColor.hex : raw) || 'transparent' }}
          onClick={() => setOpenPicker(isOpen ? null : f.key)}
          title="Открыть пипетку"
        >
          {!raw && <span className="cte-field-swatch-auto">A</span>}
        </button>
        <div className="cte-field-meta">
          <div className="cte-field-label">
            {f.label}
            {isAffected && <span className="cte-field-live">меняется</span>}
          </div>
          <div className="cte-field-hint">{f.hint}</div>
        </div>
        {f.alpha && (
          <input
            type="range"
            className="cte-field-alpha"
            min={20} max={100}
            value={Math.round((parsed.alpha ?? 1) * 100)}
            onChange={e => {
              const a = Number(e.target.value) / 100
              const hex = parsed.hex || '#1c1c24'
              setColor(f.key, combineColor(hex, a), true)
            }}
            title={`Прозрачность: ${Math.round((parsed.alpha ?? 1) * 100)}%`}
          />
        )}
        <input
          className="cte-field-input"
          value={raw}
          placeholder={f.optional ? 'авто' : '#000000'}
          spellCheck={false}
          onChange={e => setColor(f.key, e.target.value, true)}
          onBlur={() => flushHistory()}
        />
      </div>
    )
  }

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="cte-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={requestClose}
      >
        <motion.div
          className="cte-modal"
          initial={{ opacity: 0, scale: 0.96, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 16 }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          onClick={e => e.stopPropagation()}
        >
          {/* ── Header ── */}
          <div className="cte-header">
            <div className="cte-header-title">
              <AppIcon name="palette" size="sm" tone="accent" />
              <span>Редактор тем</span>
            </div>
            {draft && (
              <div className="cte-mode-toggle">
                <button
                  type="button"
                  className={`cte-mode-btn${mode === 'simple' ? ' cte-mode-btn--active' : ''}`}
                  onClick={() => setMode('simple')}
                >Простой</button>
                <button
                  type="button"
                  className={`cte-mode-btn${mode === 'advanced' ? ' cte-mode-btn--active' : ''}`}
                  onClick={() => setMode('advanced')}
                >Продвинутый</button>
              </div>
            )}
            <div className="cte-header-actions">
              {draft && (
                <>
                  <button type="button" className="cte-icon-btn" onClick={undo} disabled={past.length === 0} title="Отменить (Ctrl+Z)">
                    <AppIcon name="undo" size="sm" />
                  </button>
                  <button type="button" className="cte-icon-btn" onClick={redo} disabled={future.length === 0} title="Вернуть (Ctrl+Shift+Z)">
                    <AppIcon name="redo" size="sm" />
                  </button>
                </>
              )}
              <button type="button" className="cte-icon-btn" onClick={requestClose} title="Закрыть (Esc)">
                <AppIcon name="x" size="sm" />
              </button>
            </div>
          </div>

          {/* ── Body ── */}
          {!draft ? (
            /* Выбор шаблона */
            <div className="cte-templates">
              <div className="cte-templates-head">
                <div className="cte-templates-title">Создать тему из шаблона</div>
                <div className="cte-templates-sub">Выбери основу — потом докрути цвета под себя</div>
              </div>
              <div className="cte-templates-section">Встроенные</div>
              <div className="cte-templates-grid">
                {BUILTIN_THEMES.map(t => (
                  <motion.button
                    key={t.id}
                    type="button"
                    className="cte-template-card"
                    onClick={() => pickBuiltinTemplate(t.id)}
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.97 }}
                  >
                    <div className="cte-template-preview" style={{ background: t.card.bg }}>
                      <div className="cte-template-sidebar" style={{ background: t.card.surface }} />
                      <div className="cte-template-content">
                        <div className="cte-template-bubble" style={{ background: t.card.surface }} />
                        <div className="cte-template-bubble cte-template-bubble--accent" style={{ background: t.card.accent }} />
                      </div>
                    </div>
                    <div className="cte-template-label">{t.label}</div>
                  </motion.button>
                ))}
              </div>
              {themes.length > 0 && (
                <>
                  <div className="cte-templates-section">Мои темы</div>
                  <div className="cte-templates-grid">
                    {themes.map(t => (
                      <motion.button
                        key={t.id}
                        type="button"
                        className="cte-template-card"
                        onClick={() => pickCustomTemplate(t)}
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.97 }}
                      >
                        <div className="cte-template-preview" style={{ background: t.colors.bodyBg }}>
                          <div className="cte-template-sidebar" style={{ background: t.colors.bgSecondary }} />
                          <div className="cte-template-content">
                            <div className="cte-template-bubble" style={{ background: t.colors.bgSecondary }} />
                            <div className="cte-template-bubble cte-template-bubble--accent" style={{ background: t.colors.accent }} />
                          </div>
                        </div>
                        <div className="cte-template-label">{t.name}</div>
                      </motion.button>
                    ))}
                  </div>
                </>
              )}
              <div className="cte-templates-import">
                <button type="button" className="cte-btn" onClick={() => { setImportOpen(v => !v); setImportError('') }}>
                  Импорт JSON
                </button>
                {importOpen && (
                  <div className="cte-import">
                    <textarea
                      className="cte-import-text"
                      placeholder="Вставьте JSON темы..."
                      value={importText}
                      onChange={e => setImportText(e.target.value)}
                      rows={4}
                    />
                    {importError && <div className="cte-import-error">{importError}</div>}
                    <button type="button" className="cte-btn cte-btn--primary" onClick={doImport}>Применить</button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="cte-body">
              {/* ── Controls ── */}
              <div className="cte-controls">
                {mode === 'simple' ? (
                  <>
                    <div className="cte-group-title">Базовые цвета</div>
                    <div className="cte-group-sub">Остальные 9 цветов подберутся автоматически</div>
                    {SIMPLE_FIELDS.map(f => renderColorField(f))}
                    <div className="cte-group-title" style={{ marginTop: 16 }}>Стекло</div>
                    <div className="cte-slider-row">
                      <span>Blur: {draft.glass.blur}px</span>
                      <input type="range" min={0} max={40} value={draft.glass.blur}
                        onChange={e => updateGlass({ blur: Number(e.target.value) })}
                        className="settings-slider" />
                    </div>
                    <button type="button" className="cte-link" onClick={() => setMode('advanced')}>
                      Все 13 цветов и тонкие настройки →
                    </button>
                  </>
                ) : (
                  <>
                    {FIELD_GROUPS.map(g => (
                      <div key={g.title}>
                        <div className="cte-group-title">{g.title}</div>
                        {g.fields.map(f => renderColorField(f))}
                      </div>
                    ))}
                    <div className="cte-group-title" ref={glassSectionRef}>Стекло и эффекты</div>
                    <div className="cte-slider-row">
                      <span>Blur: {draft.glass.blur}px</span>
                      <input type="range" min={0} max={40} value={draft.glass.blur}
                        onChange={e => updateGlass({ blur: Number(e.target.value) })}
                        className="settings-slider" />
                    </div>
                    <div className="cte-slider-row">
                      <span>Saturate: {draft.glass.saturate}%</span>
                      <input type="range" min={100} max={300} value={draft.glass.saturate}
                        onChange={e => updateGlass({ saturate: Number(e.target.value) })}
                        className="settings-slider" />
                    </div>
                    <div className="cte-slider-row">
                      <span>Overlay: {Math.round((draft.effects?.overlayIntensity ?? 1) * 100)}%</span>
                      <input type="range" min={0.5} max={2} step={0.1} value={draft.effects?.overlayIntensity ?? 1}
                        onChange={e => updateOverlay(Number(e.target.value))}
                        className="settings-slider" />
                    </div>

                    <div className="cte-group-title">Читаемость</div>
                    <div className="cte-contrast">
                      {contrastRows.map(r => {
                        const ratio = r.ratio
                        const level = ratio === null ? 'na' : ratio >= 4.5 ? 'good' : ratio >= 3 ? 'warn' : 'bad'
                        return (
                          <div key={r.label} className="cte-contrast-row">
                            <span className={`cte-contrast-dot cte-contrast-dot--${level}`} />
                            <span className="cte-contrast-label">{r.label}</span>
                            <span className="cte-contrast-value">
                              {ratio === null ? '—' : ratio.toFixed(1)}
                              {level === 'good' && ' AA'}
                              {level === 'warn' && ' слабо'}
                              {level === 'bad' && ' плохо'}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>

              {/* ── Live mockup ── */}
                <div className="cte-preview" data-affected={affected ? [...affected].join(' ') : undefined}>
                <div className="cte-preview-hint">Клик по элементу мокапа или чипу ниже — открыть его цвет</div>
                <div className="cte-mock" data-tk="bodyBg" style={{ background: c!.bodyBg, borderColor: borderVal, boxShadow: mockShadow }} onClick={() => openFieldPicker('bodyBg')}>
                  {/* Сайдбар */}
                  <div className="cte-mock-sidebar" data-tk="sidebarBg" style={{ background: c!.sidebarBg, borderColor: borderVal }}
                    onClick={e => { e.stopPropagation(); openFieldPicker('sidebarBg') }}>
                    <div className="cte-mock-sidebar-title" style={{ color: c!.textMuted }}>Чаты</div>
                    <div className="cte-mock-chat-item" style={{ background: withAlpha(accentHex, 0.14) }}>
                      <div className="cte-mock-bar" style={{ background: c!.textPrimary, opacity: 0.85, width: '70%' }} />
                    </div>
                    <div className="cte-mock-chat-item">
                      <div className="cte-mock-bar" style={{ background: c!.textSecondary, opacity: 0.5, width: '55%' }} />
                    </div>
                    <div className="cte-mock-chat-item">
                      <div className="cte-mock-bar" style={{ background: c!.textSecondary, opacity: 0.5, width: '62%' }} />
                    </div>
                  </div>
                  {/* Основная область */}
                  <div className="cte-mock-main">
                    <div className="cte-mock-header" data-tk="bgPrimary" style={{ background: c!.bgPrimary, borderColor: borderVal }}
                      onClick={e => { e.stopPropagation(); openFieldPicker('bgPrimary') }}>
                      <div className="cte-mock-bar" style={{ background: c!.textPrimary, opacity: 0.9, width: 72 }} />
                      <div className="cte-mock-dot" style={{ background: accentHex }} />
                    </div>
                    <div className="cte-mock-chat">
                      <div className="cte-mock-msg cte-mock-msg--left" data-tk="bgSecondary" style={{ background: c!.bgSecondary, borderColor: borderVal }}
                        onClick={e => { e.stopPropagation(); openFieldPicker('bgSecondary') }}>
                        <div className="cte-mock-text" data-tk="textPrimary" style={{ color: c!.textPrimary }}
                          onClick={e => { e.stopPropagation(); openFieldPicker('textPrimary') }}>
                          Привет! Чем помочь?
                        </div>
                        <div className="cte-mock-text" data-tk="textSecondary" style={{ color: c!.textSecondary, fontSize: 10 }}
                          onClick={e => { e.stopPropagation(); openFieldPicker('textSecondary') }}>
                          Могу написать код или найти файл
                        </div>
                        <div className="cte-mock-code" style={{ background: draft.base === 'dark' ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.06)' }}>
                          <span style={{ color: accentHex }}>const</span>
                          <span style={{ color: c!.textPrimary }}> theme = </span>
                          <span style={{ color: c!.textSecondary }}>{'"yours"'}</span>
                        </div>
                        <div className="cte-mock-time" data-tk="textMuted" style={{ color: c!.textMuted }}
                          onClick={e => { e.stopPropagation(); openFieldPicker('textMuted') }}>
                          12:34
                        </div>
                      </div>
                      <div className="cte-mock-msg cte-mock-msg--right" data-tk="accent" style={{ background: accentBg }}
                        onClick={e => { e.stopPropagation(); openFieldPicker('accent') }}>
                        <div className="cte-mock-text" style={{ color: onAccentColor }}>Сделай свою тему</div>
                      </div>
                      {/* Карточка с границей — демо поля «Границы» */}
                      <div className="cte-mock-notice" data-tk="border" style={{ borderColor: borderVal, background: withAlpha(accentHex, 0.04) }}
                        onClick={e => { e.stopPropagation(); openFieldPicker('border') }}>
                        <div className="cte-mock-bar" style={{ background: c!.textSecondary, opacity: 0.6, width: '55%' }} />
                      </div>
                    </div>
                    {/* Glass-панель — демо blur/saturate/opacity поверх контента */}
                    <div
                      className="cte-mock-glass"
                      data-tk="glass"
                      style={{
                        background: mockGlassBg,
                        backdropFilter: `blur(${draft.glass.blur}px) saturate(${draft.glass.saturate}%)`,
                        WebkitBackdropFilter: `blur(${draft.glass.blur}px) saturate(${draft.glass.saturate}%)`,
                        borderColor: withAlpha(accentHex, 0.15),
                      }}
                      title="Glass-панель: клик — к слайдерам стекла"
                      onClick={e => { e.stopPropagation(); glassSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}
                    >
                      <div className="cte-mock-bar" style={{ background: c!.textPrimary, opacity: 0.8, width: '60%' }} />
                      <div className="cte-mock-bar" style={{ background: c!.textSecondary, opacity: 0.5, width: '85%' }} />
                    </div>
                    <div className="cte-mock-bottom">
                      <div className="cte-mock-input" data-tk="bgTertiary" style={{ background: c!.bgTertiary, borderColor: borderVal }}
                        onClick={e => { e.stopPropagation(); openFieldPicker('bgTertiary') }}>
                        <span style={{ color: c!.textMuted }}>Сообщение...</span>
                      </div>
                      <div className="cte-mock-send" style={{ background: accentBg }}
                        onClick={e => { e.stopPropagation(); openFieldPicker('accent') }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={onAccentColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" />
                        </svg>
                      </div>
                    </div>
                    <div className="cte-mock-controls">
                      <div className="cte-mock-btn" style={{ background: accentBg, color: onAccentColor }}
                        onClick={e => { e.stopPropagation(); openFieldPicker('accent') }}>Кнопка</div>
                      <div className="cte-mock-btn cte-mock-btn--ghost" data-tk="borderStrong" style={{ borderColor: borderStrongVal, color: c!.textSecondary }}
                        onClick={e => { e.stopPropagation(); openFieldPicker('borderStrong') }}>Отмена</div>
                      <div className="cte-mock-toggle" style={{ background: accentHex }}
                        onClick={e => { e.stopPropagation(); openFieldPicker('accent') }}>
                        <div className="cte-mock-toggle-knob" style={{ background: onAccentColor }} />
                      </div>
                    </div>
                  </div>
                </div>
                {/* Легенда: все цвета темы чипами — клик открывает пикер поля.
                    Видно всё, что настраиваешь, даже то что спрятано в мокапе. */}
                <div className="cte-legend">
                  {legendFields.map(f => {
                    const raw = c![f.key] || ''
                    return (
                      <button
                        key={f.key}
                        type="button"
                        className={`cte-legend-chip${openPicker === f.key ? ' cte-legend-chip--active' : ''}${affected && [...affected].some(el => ELEMENT_COLOR_KEYS[el]?.includes(f.key)) ? ' cte-legend-chip--affected' : ''}`}
                        onClick={() => openFieldPicker(f.key)}
                        title={f.hint}
                      >
                        <span className="cte-legend-dot" style={{ background: raw || 'transparent' }} />
                        <span>{f.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ── Footer ── */}
          {draft && (
            <div className="cte-footer">
              <div className="cte-footer-left">
                <input
                  className="cte-name-input"
                  value={draft.name}
                  onChange={e => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Название темы"
                  spellCheck={false}
                />
                <div className="cte-base-toggle">
                  <button
                    type="button"
                    className={`cte-mode-btn${draft.base === 'dark' ? ' cte-mode-btn--active' : ''}`}
                    onClick={() => commitDraft({ ...draft, base: 'dark' })}
                  >Тёмная</button>
                  <button
                    type="button"
                    className={`cte-mode-btn${draft.base === 'light' ? ' cte-mode-btn--active' : ''}`}
                    onClick={() => commitDraft({ ...draft, base: 'light' })}
                  >Светлая</button>
                </div>
                {editId && (
                  <>
                    <button type="button" className="cte-icon-btn" onClick={handleDuplicate} title="Дублировать тему">
                      <AppIcon name="copy" size="sm" />
                    </button>
                    <button
                      type="button"
                      className={`cte-icon-btn cte-icon-btn--danger${confirmDelete ? ' cte-icon-btn--confirm' : ''}`}
                      onClick={() => (confirmDelete ? handleDelete() : (setConfirmDelete(true), setTimeout(() => setConfirmDelete(false), 3000)))}
                      title={confirmDelete ? 'Нажми ещё раз для удаления' : 'Удалить тему'}
                    >
                      <AppIcon name="trash" size="sm" />
                    </button>
                  </>
                )}
                <button type="button" className="cte-icon-btn" onClick={doExport} title="Экспорт JSON в буфер">
                  <AppIcon name="download" size="sm" />
                </button>
                {exportMsg && <span className="cte-export-msg">{exportMsg}</span>}
              </div>
              <div className="cte-footer-right">
                <button type="button" className="cte-btn" onClick={requestClose}>Отмена</button>
                <motion.button
                  type="button"
                  className="cte-btn cte-btn--primary"
                  onClick={handleSave}
                  whileTap={{ scale: 0.97 }}
                >
                  Сохранить и применить
                </motion.button>
              </div>
            </div>
          )}

          {/* Пикер цвета — один на все поля, позиционируется у активного swatch */}
          {draft && (
            <ColorPickerPopover
              open={!!openPicker}
              onClose={() => { flushHistory(); setOpenPicker(null) }}
              anchorRef={activeSwatchRef}
              value={pickerValue}
              onChange={handlePickerChange}
              onCommit={handlePickerCommit}
            />
          )}

          {/* Подтверждение закрытия с несохранёнными изменениями */}
          <AnimatePresence>
            {confirmClose && (
              <motion.div
                className="cte-confirm-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setConfirmClose(false)}
              >
                <motion.div
                  className="cte-confirm"
                  initial={{ opacity: 0, scale: 0.92, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.92, y: 10 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 28 }}
                  onClick={e => e.stopPropagation()}
                >
                  <div className="cte-confirm-title">Закрыть без сохранения?</div>
                  <div className="cte-confirm-text">
                    Изменения темы «{draft?.name || 'Без названия'}» не сохранятся.
                  </div>
                  <div className="cte-confirm-actions">
                    <button type="button" className="cte-btn" onClick={() => setConfirmClose(false)}>
                      Продолжить редактирование
                    </button>
                    <button
                      type="button"
                      className="cte-btn cte-btn--danger"
                      onClick={() => { setConfirmClose(false); onClose() }}
                    >
                      Закрыть без сохранения
                    </button>
                    <motion.button
                      type="button"
                      className="cte-btn cte-btn--primary"
                      onClick={() => { setConfirmClose(false); handleSave() }}
                      whileTap={{ scale: 0.97 }}
                    >
                      Сохранить
                    </motion.button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  )
}
