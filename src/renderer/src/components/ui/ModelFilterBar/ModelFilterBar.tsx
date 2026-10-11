import { useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { ModelCapability, ModelMeta } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import { CAP_LABELS } from '../../../utils/modelFormat'
import {
  CAP_ICONS,
  PRICE_FILTERS,
  PRICE_FILTER_LABELS,
  type PriceFilter,
} from '../../../utils/modelFilters'
import './ModelFilterBar.css'

const ALL_CAPS: ModelCapability[] = ['vision', 'video', 'audio_input', 'audio_output', 'tools', 'reasoning', 'code', 'image_gen', 'embedding', 'tts', 'stt']

interface ModelFilterBarProps {
  /** Загруженные модели — из них выводятся доступные capability-фильтры. */
  models: ModelMeta[]
  activeCaps: ModelCapability[]
  onCapsChange: (caps: ModelCapability[]) => void
  priceFilter: PriceFilter
  onPriceChange: (f: PriceFilter) => void
  /** Панель раскрыта? Управляется кнопкой-воронкой в строке поиска родителя. */
  expanded: boolean
  /** Сколько моделей прошло фильтры (для счётчика «N из M»). */
  resultCount?: number
  totalCount?: number
}

/**
 * Сворачиваемая панель фильтров моделей: иконки-пилюли capabilities
 * (мультивыбор, AND) + пилюли цены (одиночный выбор). Общая для
 * ModelSelector (чат) и ModelPicker (настройки).
 */
export default function ModelFilterBar({
  models, activeCaps, onCapsChange, priceFilter, onPriceChange,
  expanded, resultCount, totalCount,
}: ModelFilterBarProps) {
  // Какие caps реально встречаются в текущих моделях — пустые кнопки не рисуем.
  const availableCaps = useMemo(
    () => ALL_CAPS.filter(c => models.some(m => m.capabilities.includes(c))),
    [models]
  )

  const hasActive = activeCaps.length > 0 || priceFilter !== 'any'

  const toggleCap = (cap: ModelCapability) => {
    onCapsChange(
      activeCaps.includes(cap)
        ? activeCaps.filter(c => c !== cap)
        : [...activeCaps, cap]
    )
  }

  const reset = () => {
    onCapsChange([])
    onPriceChange('any')
  }

  return (
    <AnimatePresence initial={false}>
      {expanded && (
        <motion.div
          className="model-filter-bar"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        >
          <div className="model-filter-bar-inner">
            {/* Capabilities — мультивыбор (AND) */}
            {availableCaps.length > 0 && (
              <div className="model-filter-row">
                {availableCaps.map(cap => {
                  const active = activeCaps.includes(cap)
                  return (
                    <motion.button
                      key={cap}
                      type="button"
                      className={`model-filter-pill model-filter-pill--icon ${active ? 'model-filter-pill--active' : ''}`}
                      onClick={() => toggleCap(cap)}
                      title={CAP_LABELS[cap]}
                      whileTap={{ scale: 0.88 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                    >
                      <AppIcon name={CAP_ICONS[cap]} size="xs" />
                    </motion.button>
                  )
                })}
              </div>
            )}

            {/* Цена — одиночный выбор */}
            <div className="model-filter-row">
              {PRICE_FILTERS.map(f => {
                const active = priceFilter === f
                return (
                  <motion.button
                    key={f}
                    type="button"
                    className={`model-filter-pill ${active ? 'model-filter-pill--active' : ''}`}
                    onClick={() => onPriceChange(active ? 'any' : f)}
                    whileTap={{ scale: 0.92 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  >
                    {PRICE_FILTER_LABELS[f]}
                  </motion.button>
                )
              })}
              {hasActive && (
                <motion.button
                  type="button"
                  className="model-filter-reset"
                  onClick={reset}
                  title="Сбросить фильтры"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  whileTap={{ scale: 0.88 }}
                >
                  <AppIcon name="x" size="xs" />
                </motion.button>
              )}
              {hasActive && resultCount !== undefined && totalCount !== undefined && (
                <span className="model-filter-count">{resultCount} из {totalCount}</span>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
