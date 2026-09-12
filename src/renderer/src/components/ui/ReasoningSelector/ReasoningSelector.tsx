import { useState, useRef, useEffect, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  configFromSpecs,
  configFromGatewayLevels,
  type ModelReasoningConfig,
} from '../../../../../shared/reasoningModels'
import type { ModelMeta } from '../../../../../shared/types'
import { useGatewayModelsStore } from '../../../store/gatewayModels.store'
import { whileTapSm, whileTapListItem, springHover } from '../../../utils/motionPresets'
import { chatColumnRight } from '../../../utils/popupAnchor'
import './ReasoningSelector.css'

interface ReasoningSelectorProps {
  modelId: string
  value: string
  onChange: (value: string) => void
}

const PANEL_WIDTH = 264

// ── Иконки режимов — единый набор для бейджа и панели ───────────────────────
// Каждому режиму — своя уникальная иконка (stroke, currentColor),
// размером управляет size — в бейдже и в списке они одинаковые.

const MODE_ICON_PATHS: Record<string, ReactNode> = {
  // off — перечёркнутый круг
  off: (<>
    <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.9" />
    <path d="M6.2 6.2l11.6 11.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </>),
  // minimal — маленькая искра (точка с лучами)
  minimal: (<>
    <path d="M12 4.5l1.1 4.4 4.4 1.1-4.4 1.1L12 15.5l-1.1-4.4-4.4-1.1 4.4-1.1L12 4.5z" fill="currentColor" />
    <circle cx="18" cy="18" r="1.6" fill="currentColor" opacity="0.7" />
  </>),
  // low — молния
  low: (<path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />),
  // medium — звезда
  medium: (<path d="M12 2.5l2.6 5.6 6.1.7-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.7L12 2.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />),
  // high — двойная искра
  high: (<>
    <path d="M10 2.5l1.3 3.9 3.9 1.3-3.9 1.3L10 12.9l-1.3-3.9-3.9-1.3 3.9-1.3L10 2.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    <path d="M17.5 11l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4z" fill="currentColor" />
  </>),
  // xhigh / max — кристалл
  max: (<>
    <path d="M7 3h10l4 6-9 12L3 9l4-6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M7 3l5 6 5-6M3 9h18M12 9v12" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </>),
  // toggle on — питание
  on: (<>
    <path d="M12 3v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M7 6.5a7.5 7.5 0 1 0 10 0" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </>),
  // budget — шкала со стрелкой
  budget: (<>
    <path d="M4 16a8.5 8.5 0 0 1 16 0" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    <path d="M12 16l4-5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    <circle cx="12" cy="16" r="1.7" fill="currentColor" />
  </>),
  // always-on — бесконечность
  always: (<path d="M8 9c-2.2 0-3.5 1.4-3.5 3s1.3 3 3.5 3c3.4 0 4.6-6 8-6 2.2 0 3.5 1.4 3.5 3s-1.3 3-3.5 3c-3.4 0-4.6-6-8-6z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />),
}

/** Уникальная иконка режима мышления. Одинаковая в бейдже и в панели. */
function ModeIcon({ value, size }: { value: string; size: number }) {
  const key =
    !value || value === 'off' ? 'off'
    : value === 'minimal' ? 'minimal'
    : value === 'low' ? 'low'
    : value === 'medium' ? 'medium'
    : value === 'high' ? 'high'
    : value === 'xhigh' || value === 'max' || value === 'ultra' ? 'max'
    : value === 'on' ? 'on'
    : /^\d+$/.test(value) ? 'budget'
    : 'high'
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {MODE_ICON_PATHS[key]}
    </svg>
  )
}

/** Человекочитаемое описание уровня под его названием. */
function optionDesc(config: ModelReasoningConfig, value: string): string {
  switch (config.paramType) {
    case 'thinking_budget':
      return value ? `${value} токенов на размышления` : 'Мышление выключено'
    case 'toggle':
      return value ? 'Мышление включено' : 'Мышление выключено'
    default: // reasoning_effort
      if (!value || value === 'off') return 'Мышление выключено'
      if (value === 'minimal') return 'Минимум размышлений'
      if (value === 'low') return 'Быстро — короткие размышления'
      if (value === 'medium') return 'Баланс скорости и глубины'
      if (value === 'high') return 'Максимальная глубина'
      if (value === 'xhigh' || value === 'max') return 'Предельная глубина'
      return `Уровень: ${value}`
  }
}

/** Интенсивность мышления для цветовой градации: off → нейтральный,
 *  low → голубой, medium → янтарный, high → фиолетово-розовый.
 *  Бюджетные параметры мапятся по величине токенов. */
function effortLevel(config: ModelReasoningConfig, value: string): 'off' | 'low' | 'medium' | 'high' {
  if (!value || value === 'off') return 'off'
  switch (config.paramType) {
    case 'thinking_budget': {
      const n = parseInt(value)
      if (Number.isNaN(n)) return 'medium'
      if (n <= 5000) return 'low'
      if (n <= 16000) return 'medium'
      return 'high'
    }
    case 'toggle':
      return 'medium'
    default:
      if (value === 'minimal' || value === 'low') return 'low'
      if (value === 'medium') return 'medium'
      return 'high'
  }
}

export default function ReasoningSelector({ modelId, value, onChange }: ReasoningSelectorProps) {
  const [open, setOpen] = useState(false)
  const [panelPos, setPanelPos] = useState({ bottom: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)

  // ── Конфиг мышления — каскад из 2 источников ─────────────────────────────
  // 1) Syntee-Gateway: модель известна gateway → он authoritative. Уровни из
  //    /v1/models (reasoning.supported, admin-конфиг группы). Если админ не
  //    настроил reasoning — селектор не показываем (gateway молча дропнет
  //    параметр, показывать чужие уровни было бы враньём).
  // 2) Каталог models.dev: reasoning_options — реальные контролы API каждой
  //    модели (effort-уровни / toggle / budget_tokens). Стейтшейл-кэш без
  //    спек, но с capability 'reasoning' → always_on-бейдж.
  // Ничего не подошло → null: селектор вообще не рендерится.
  const gwModel = useGatewayModelsStore(s => s.models.find(m => m.id === modelId))
  const needCatalog = !gwModel

  // Каталог моделей (для фоллбека) — ленивый IPC-запрос только когда
  // модель не принадлежит gateway.
  const [catalogMeta, setCatalogMeta] = useState<ModelMeta | null>(null)
  useEffect(() => {
    if (!needCatalog) return
    let cancelled = false
    // Сброс от предыдущей модели: пока летит новый запрос, не показываем
    // спеку старой (при сбое IPC она бы осталась навсегда).
    setCatalogMeta(null)
    ;(window.syntee.models.getAll() as Promise<ModelMeta[]>)
      .then(all => {
        if (cancelled) return
        setCatalogMeta(all.find(m => m.id === modelId) ?? null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [needCatalog, modelId])

  const config: ModelReasoningConfig | null = useMemo(() => {
    if (gwModel) {
      const gwReasoning = gwModel.reasoning
      return gwReasoning?.supported
        ? configFromGatewayLevels(gwReasoning.levels)
        : null
    }
    const specs = catalogMeta?.reasoningOptions
      ?? (catalogMeta?.capabilities?.includes('reasoning') ? [] : undefined)
    return configFromSpecs(specs)
  }, [gwModel, catalogMeta])

  // Валидация при смене модели: сохранённое значение может не существовать
  // в опциях новой модели (например 'high' у модели с уровнями low/medium) —
  // сбрасываем на дефолт, иначе UI показывает одно, а в API уходит другое
  // (раньше это приводило к 400 "Invalid reasoning_effort" на gateway).
  useEffect(() => {
    if (!config || config.paramType === 'always_on') return
    const eff = value || config.default
    if (!config.options.some(o => o.value === eff)) onChange(config.default || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      const panel = document.getElementById('rs-panel')
      if (!panel?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (!config) return null

  if (config.paramType === 'always_on') {
    return (
      <span className="rs-badge" title={config.hint}>
        <span className="rs-badge-ico">
          <ModeIcon value="always" size={11} />
        </span>
        thinking
      </span>
    )
  }

  const effectiveValue = value || config.default
  const current = config.options.find(o => o.value === effectiveValue) ?? config.options[0]
  // Цветовая градация иконки по интенсивности мышления
  const level = effortLevel(config, current.value)

  const openPanel = () => {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    const bottom = window.innerHeight - rect.top + 6
    let left = rect.left
    // не выезжаем за правый край колонки чата (а не окна — колонка
    // центрирована, справа от неё пустота)
    const colRight = chatColumnRight(btnRef.current)
    if (left + PANEL_WIDTH > colRight) {
      left = colRight - PANEL_WIDTH
    }
    if (left < 8) left = 8
    setPanelPos({ bottom, left })
    setOpen(v => !v)
  }

  return (
    <>
      <motion.button
        ref={btnRef}
        className={`rs-btn${open ? ' rs-btn--active' : ''}`}
        onClick={openPanel}
        title=""
        whileTap={whileTapSm}
        transition={springHover}
      >
        <span className={`rs-btn-ico rs-btn-ico--${level}`}>
          <ModeIcon value={current.value} size={12} />
        </span>
        <span className="rs-btn-val">{current.label}</span>
        <svg className="rs-btn-chevron" viewBox="0 0 10 6" fill="none">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </motion.button>

      {/* Дропдаун — AnimatePresence даёт анимацию и открытия, и закрытия
          (раньше был обычный conditional render без exit-transition). */}
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              id="rs-panel"
              className="rs-panel"
              style={{ bottom: panelPos.bottom, left: panelPos.left, width: PANEL_WIDTH }}
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            >
              <div className="rs-panel-head">
                <span className="rs-panel-title">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
                    <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"
                      stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
                  </svg>
                  Мышление
                </span>
              </div>
              {/* Вертикальный список режимов — как списки в ModelSelector. */}
              <div className="rs-list">
                {config.options.map(opt => {
                  const active = opt.value === current.value
                  return (
                    <motion.button
                      key={opt.value || 'off'}
                      className={`rs-row rs-row--${effortLevel(config, opt.value)}${active ? ' rs-row--active' : ''}`}
                      onClick={() => { onChange(opt.value); setOpen(false) }}
                      whileTap={whileTapListItem}
                      transition={springHover}
                    >
                      <span className="rs-row-ico"><ModeIcon value={opt.value} size={14} /></span>
                      <span className="rs-row-label">{opt.label}</span>
                      <span className="rs-row-desc">{optionDesc(config, opt.value)}</span>
                      {active && (
                        <svg className="rs-row-check" width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </motion.button>
                  )
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}
