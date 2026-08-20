import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import QueuePanel from '../QueuePanel/QueuePanel'
import ExtensionsBadge from '../ExtensionsBadge/ExtensionsBadge'
import ChangesBadge from '../ChangesBadge/ChangesBadge'
import ModelSelector from '../ModelSelector/ModelSelector'
import { getPersona, DEFAULT_PERSONA, type PersonaId } from '../../../../../shared/modes'
import type { LastTurnChanges } from '../../../../../shared/types'
import type { UseVoiceInputResult } from '../../../hooks/useVoiceInput'
import { whileHoverTiny, whileTapTiny, springHover } from '../../../utils/motionPresets'

interface ChatInputStatusRowProps {
  workdir?: string
  workdirBreadcrumb: string
  voice: UseVoiceInputResult
  isVoiceTyping: boolean
  micBusy: boolean
  chatId?: string
  isIncognito?: boolean
  lastTurnChanges?: LastTurnChanges | null
  badgeLive?: boolean
  planningMode?: boolean
  onPlanningModeChange?: (v: boolean) => void
  imageMode?: boolean
  onImageModeChange?: (v: boolean) => void
  askMode?: boolean
  onAskModeChange?: (v: boolean) => void
  persona?: PersonaId
  onPersonaChange?: (v: PersonaId) => void
  lang: 'ru' | 'en'
  mainModelId?: string
  onMainModelChange?: (modelId: string, providerId: string) => void
}

/**
 * Строка статуса над инпутом: workdir-бейдж + planning/image-бейджи + бейджи
 * голоса/очереди/расширений/изменений + селектор модели.
 */
export function ChatInputStatusRow({
  workdir,
  workdirBreadcrumb,
  voice,
  isVoiceTyping,
  micBusy,
  chatId,
  isIncognito,
  lastTurnChanges,
  badgeLive,
  planningMode,
  onPlanningModeChange,
  imageMode,
  onImageModeChange,
  askMode,
  onAskModeChange,
  persona = DEFAULT_PERSONA,
  onPersonaChange,
  lang,
  mainModelId,
  onMainModelChange,
}: ChatInputStatusRowProps) {
  return (
    <div className="chat-input-status-row">
      <AnimatePresence>
        {workdir && (
          <motion.div
            className="chat-input-workdir-badge"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            title={workdir}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span>{workdirBreadcrumb}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Бейдж голосового ввода — показывается во время записи/распознавания
          и во время анимированной печати распознанного текста. Пульсирует.
          Также показывается при фоновой загрузке модели (micBusy). */}
      <AnimatePresence>
        {(voice.state === 'recording' || voice.state === 'transcribing' || voice.state === 'requesting' || voice.state === 'error' || isVoiceTyping || micBusy) && (
          <motion.div
            className={`chat-input-voice-badge${voice.state === 'error' ? ' chat-input-voice-badge--error' : ''}`}
            initial={{ opacity: 0, y: 6, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            title={voice.error ? voice.error : undefined}
          >
            {voice.state === 'error' ? (
              <>
                <AppIcon name="alertCircle" size="xs" />
                <span>{voice.error || 'Ошибка голосового ввода'}</span>
              </>
            ) : voice.state === 'recording' ? (
              <>
                <span className="chat-input-voice-badge-dot" />
                <span>Запись {voice.recordingSec}с</span>
              </>
            ) : isVoiceTyping ? (
              <>
                <AppIcon name="mic" size="xs" />
                <span>Голосовой ввод...</span>
              </>
            ) : micBusy ? (
              <>
                <AppIcon name="loader" size="xs" animation="spin" />
                <span>{voice.progress?.message || 'Загрузка модели...'}{typeof voice.progress?.progress === 'number' && voice.progress.progress > 0 && voice.progress.progress < 100 ? ` ${voice.progress.progress}%` : ''}</span>
              </>
            ) : voice.progress?.message ? (
              <>
                <AppIcon name="loader" size="xs" animation="spin" />
                <span>{voice.progress.message}</span>
              </>
            ) : voice.state === 'transcribing' || voice.state === 'requesting' ? (
              <>
                <AppIcon name="loader" size="xs" animation="spin" />
                <span>{voice.state === 'requesting' ? 'Микрофон...' : 'Распознавание...'}</span>
              </>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Бейдж очереди запросов — раскрывается в панель управления при
          hover/клике. Показывается только когда есть active/queued запросы. */}
      {chatId && <QueuePanel chatId={chatId} />}

      {/* Бейдж активных расширений (MCP + Skills) — drill-down popup.
          Скрыт когда ничего не включено или инкогнито. */}
      {chatId && <ExtensionsBadge chatId={chatId} isIncognito={isIncognito} />}

      {/* Бейдж изменений последнего запроса — +N -M строк, popup с undo. */}
      <AnimatePresence>
        {chatId && lastTurnChanges && (
          <ChangesBadge chatId={chatId} changes={lastTurnChanges} live={badgeLive} />
        )}
      </AnimatePresence>

      {/* Бейдж режима планирования — над инпут полем */}
      <AnimatePresence>
        {planningMode && (
          <motion.div
            className="chat-input-planning-badge"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            onClick={() => onPlanningModeChange?.(false)}
            title="Выключить режим планирования"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
            <span>Режим плана</span>
            <motion.span className="chat-input-planning-badge-close" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>✕</motion.span>
          </motion.div>
        )}
        {imageMode && (
          <motion.div
            className="chat-input-planning-badge"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            onClick={() => onImageModeChange?.(false)}
            title="Выключить режим генерации изображений"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            <span>Генерация изображений</span>
            <motion.span className="chat-input-planning-badge-close" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>✕</motion.span>
          </motion.div>
        )}
        {askMode && !planningMode && (
          <motion.div
            className="chat-input-planning-badge chat-input-planning-badge--ask"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            onClick={() => onAskModeChange?.(false)}
            title="Выключить ask-режим (только чтение)"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Ask — только чтение</span>
            <motion.span className="chat-input-planning-badge-close" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>✕</motion.span>
          </motion.div>
        )}
        {persona !== 'classic' && (() => {
          const p = getPersona(persona)
          return (
            <motion.div
              key={`persona-${persona}`}
              className="chat-input-persona-badge"
              style={{ '--persona-color': p.color } as React.CSSProperties}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              onClick={() => onPersonaChange?.(DEFAULT_PERSONA)}
              title={lang === 'en' ? `Reset to Classic` : `Сбросить до Classic`}
            >
              {p.iconSvg && (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: p.iconSvg }} />
              )}
              <span>{lang === 'en' ? p.nameEn : p.nameRu}</span>
              <motion.span className="chat-input-planning-badge-close" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>✕</motion.span>
            </motion.div>
          )
        })()}
      </AnimatePresence>

      {/* Селектор модели — справа в status-row. Минималистичный бейдж
          с цветной точкой провайдера + именем модели; клик открывает
          dropdown с поиском. Меняет main-назначение глобально. */}
      {!isIncognito && mainModelId && onMainModelChange && (
        <ModelSelector modelId={mainModelId} onChange={onMainModelChange} />
      )}
    </div>
  )
}
