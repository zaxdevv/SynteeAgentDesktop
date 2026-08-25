import { motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import './Stepper.css'

export interface StepperProps {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  /** Дискретный набор допустимых значений (если задан — min/max/step игнорируются) */
  values?: number[]
  /** Суффикс после числа, например «шагов» */
  suffix?: string
  /** Кастомное форматирование значения (n === 0 ? 'выкл' : `${n}`) */
  format?: (v: number) => string
  disabled?: boolean
}

/**
 * Stepper − value + для числовых настроек. Поддерживает произвольный
 * набор допустимых значений (values={[0, 3, 5, 8, 12]}) — тогда кнопки
 * шагают по этому списку. Значение анимируется «поп» при смене.
 */
export default function Stepper({
  value, onChange, min = 0, max = 99, step = 1, values, suffix, format, disabled,
}: StepperProps) {
  const list = values ?? Array.from(
    { length: Math.floor((max - min) / step) + 1 },
    (_, i) => min + i * step,
  )
  const idx = Math.max(0, list.indexOf(value))
  const cur = list[idx]

  const down = () => { if (idx > 0) onChange(list[idx - 1]) }
  const up = () => { if (idx < list.length - 1) onChange(list[idx + 1]) }

  return (
    <div className={`ui-stepper${disabled ? ' ui-stepper--disabled' : ''}`}>
      <motion.button
        type="button"
        className="ui-stepper__btn"
        onClick={down}
        disabled={disabled || idx === 0}
        whileTap={{ scale: 0.88 }}
        aria-label="Уменьшить"
      >
        <AppIcon name="minus" size="xs" />
      </motion.button>
      <motion.span
        key={cur}
        className="ui-stepper__value"
        initial={{ opacity: 0, scale: 0.75 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 500, damping: 26 }}
      >
        {format ? format(cur) : cur}{suffix ? `\u00A0${suffix}` : ''}
      </motion.span>
      <motion.button
        type="button"
        className="ui-stepper__btn"
        onClick={up}
        disabled={disabled || idx >= list.length - 1}
        whileTap={{ scale: 0.88 }}
        aria-label="Увеличить"
      >
        <AppIcon name="plus" size="xs" />
      </motion.button>
    </div>
  )
}
