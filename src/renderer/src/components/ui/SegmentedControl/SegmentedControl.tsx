import { useId } from 'react'
import { motion } from 'framer-motion'
import './SegmentedControl.css'

export interface SegmentedOption {
  value: string
  label: string
}

export interface SegmentedControlProps {
  value: string
  onChange: (v: string) => void
  options: SegmentedOption[]
  /** Уникальный ключ для shared-layout анимации пилюли (авто по useId) */
  layoutKey?: string
}

/**
 * Segmented control (iOS/macOS style): один трек, активный сегмент —
 * скользящая пилюля через framer-motion layoutId. Заменяет ряды чипов
 * («Компактно / Комфорт / Просторно») — выглядит цельнее и понятнее.
 */
export default function SegmentedControl({ value, onChange, options, layoutKey }: SegmentedControlProps) {
  const autoId = useId()
  const lid = layoutKey ?? autoId

  return (
    <div className="ui-segmented" role="radiogroup">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`ui-segmented__btn${value === o.value ? ' ui-segmented__btn--active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {value === o.value && (
            <motion.span
              layoutId={`ui-segmented-${lid}`}
              className="ui-segmented__pill"
              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            />
          )}
          <span className="ui-segmented__label">{o.label}</span>
        </button>
      ))}
    </div>
  )
}
