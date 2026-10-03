// ── DotBlob: живая анимированная капля-аватар Dot'а ──────────────────────
// Органичный морфинг формы (lava-lamp) + статусные состояния:
//   sleeping — медленное дыхание, приглушённые цвета
//   running  — активное шевеление + пульс-кольцо + лёгкий поплавок
//   error    — дрожь + десатурация
// Внутри — иконка AppIcon (не эмодзи).
import { motion } from 'framer-motion'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'

/** Ключевые кадры border-radius для органичного морфинга капли.
 *  ВАЖНО: последний кадр == первый — петля замкнута, иначе каждый цикл
 *  repeat: Infinity обрывается мгновенным прыжком формы (видимый «сброс»). */
const BLOB_RADIUS_KEYFRAMES = [
  '44% 56% 58% 42% / 52% 44% 56% 48%',
  '56% 44% 46% 54% / 44% 56% 44% 56%',
  '48% 52% 56% 44% / 56% 48% 52% 44%',
  '52% 48% 44% 56% / 48% 52% 56% 44%',
  '44% 56% 58% 42% / 52% 44% 56% 48%',
]

export function DotBlob({
  color,
  icon,
  status = 'sleeping',
  size = 38,
}: {
  color: string
  icon: string
  status?: 'sleeping' | 'running' | 'error' | 'disabled'
  size?: number
}) {
  const isRunning = status === 'running'
  const iconSize = Math.round(size * 0.42)

  return (
    <div
      className={`dot-blob dot-blob--${status}`}
      style={{ width: size, height: size, ['--dot-color' as string]: color }}
    >
      {/* Пульс-кольцо вокруг работающей капли */}
      {isRunning && (
        <motion.span
          className="dot-blob-ring"
          initial={{ opacity: 0.7, scale: 0.85 }}
          animate={{ opacity: [0.7, 0], scale: [0.85, 1.35] }}
          transition={{ repeat: Infinity, duration: 1.8, ease: 'easeOut' }}
        />
      )}

      {/* Тело капли: морфинг border-radius + дыхание/шевеление */}
      <motion.span
        className="dot-blob-shape"
        animate={{
          borderRadius: BLOB_RADIUS_KEYFRAMES,
          scale: isRunning ? [1, 1.05, 0.98, 1.04, 1] : [1, 1.03, 1],
          rotate: isRunning ? [0, -2, 2, -1, 0] : [0, 1, 0],
          y: isRunning ? [0, -1.5, 0.5, 0] : [0, 0.8, 0],
        }}
        transition={{
          borderRadius: {
            repeat: Infinity,
            duration: isRunning ? 4 : 9,
            ease: 'easeInOut',
          },
          scale: {
            repeat: Infinity,
            duration: isRunning ? 2.4 : 5,
            ease: 'easeInOut',
          },
          rotate: {
            repeat: Infinity,
            duration: isRunning ? 3.2 : 8,
            ease: 'easeInOut',
          },
          y: {
            repeat: Infinity,
            duration: isRunning ? 2 : 6,
            ease: 'easeInOut',
          },
        }}
      />

      {/* Иконка внутри капли */}
      <motion.span
        className="dot-blob-icon"
        animate={isRunning ? { scale: [1, 1.1, 1] } : { scale: 1 }}
        transition={isRunning ? { repeat: Infinity, duration: 1.6, ease: 'easeInOut' } : undefined}
      >
        <AppIcon name={(icon || 'bot') as IconName} size={iconSize <= 14 ? 'xs' : iconSize <= 20 ? 'sm' : 'md'} />
      </motion.span>
    </div>
  )
}
