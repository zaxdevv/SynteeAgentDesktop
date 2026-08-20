import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import type { UseVoiceInputResult } from '../../../hooks/useVoiceInput'

interface ChatInputActionButtonProps {
  value: string
  isGenerating?: boolean
  voice: UseVoiceInputResult
  micBusy: boolean
  sendBurst: boolean
  onStop?: () => void
  onSend: () => void
  onMicClick: () => void
}

/**
 * Главная кнопка действия инпута: Send / Stop / Mic (голосовой ввод).
 * Логика выбора режима: текст в поле → Send (даже при генерации — уйдёт в
 * очередь). Пустое поле + генерация → Stop. Пустое поле + idle → Mic.
 * Во время записи/распознавания голоса — показываем recording-состояние
 * кнопки (независимо от наличия текста) — юзер жмёт снова чтобы остановить.
 */
export function ChatInputActionButton({
  value,
  isGenerating,
  voice,
  micBusy,
  sendBurst,
  onStop,
  onSend,
  onMicClick,
}: ChatInputActionButtonProps) {
  const voiceActive = voice.state === 'recording' || voice.state === 'transcribing' || voice.state === 'requesting'
  const btnMode = voiceActive
    ? 'voice'
    : value.trim() ? 'send' : isGenerating ? 'stop' : 'mic'
  // Send во время генерации — подсветим кольцом, поменяем tooltip.
  const sendToQueue = btnMode === 'send' && !!isGenerating

  return (
    <motion.button
      className={`chat-input-action-btn chat-input-action-btn--${btnMode}${sendBurst ? ' chat-input-action-btn--burst' : ''}${sendToQueue ? ' chat-input-action-btn--queue' : ''}${voice.state === 'recording' ? ' chat-input-action-btn--recording' : ''}${voice.state === 'transcribing' || voice.state === 'requesting' ? ' chat-input-action-btn--busy' : ''}${micBusy ? ' chat-input-action-btn--busy' : ''}`}
      onClick={btnMode === 'stop' ? onStop : btnMode === 'send' ? onSend : btnMode === 'voice' ? onMicClick : onMicClick}
      whileTap={{ scale: 0.88 }}
      whileHover={{ scale: 1.08 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      title={btnMode === 'stop' ? 'Остановить генерацию' : btnMode === 'send' ? (sendToQueue ? 'Отправить в очередь (Enter)' : 'Отправить (Enter)') : voice.state === 'recording' ? `Запись... ${voice.recordingSec}с — нажмите чтобы остановить` : voice.state === 'transcribing' ? 'Распознавание речи...' : micBusy ? (voice.progress?.message || 'Загрузка модели Whisper...') : 'Голосовой ввод'}
    >
      <AnimatePresence mode="wait" initial={false}>
        {btnMode === 'stop' ? (
          <motion.span key="stop" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }} className="chat-input-stop-icon" />
        ) : btnMode === 'send' ? (
          <motion.span key="send" initial={{ rotate: -90, opacity: 0, scale: 0.5 }} animate={{ rotate: 0, opacity: 1, scale: 1 }} exit={{ rotate: 90, opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
            <AppIcon name="send" size="md" />
          </motion.span>
        ) : btnMode === 'voice' ? (
          voice.state === 'transcribing' || voice.state === 'requesting' ? (
            <motion.span key="voice-busy" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
              <AppIcon name="loader" size="md" animation="spin" />
            </motion.span>
          ) : (
            <motion.span key="voice-rec" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
              <AppIcon name="mic" size="md" />
            </motion.span>
          )
        ) : micBusy ? (
          <motion.span key="mic-loading" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
            <AppIcon name="loader" size="md" animation="spin" />
          </motion.span>
        ) : (
          <motion.span key="mic" initial={{ rotate: 90, opacity: 0, scale: 0.5 }} animate={{ rotate: 0, opacity: 1, scale: 1 }} exit={{ rotate: -90, opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
            <AppIcon name="mic" size="md" />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  )
}
