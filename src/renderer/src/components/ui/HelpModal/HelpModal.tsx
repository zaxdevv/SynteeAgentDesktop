/**
 * HelpModal — модалка /help. Показывает все slash-команды (builtin + custom)
 * и горячие клавиши. Открывается по центру экрана, закрывается по Esc/клику
 * вне контента/крестику.
 */
import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import { SLASH_COMMANDS } from '../../../../../shared/slashCommands'
import type { SlashCommand } from '../../../../../shared/slashCommands'
import { DEFAULT_HOTKEYS } from '../../../../../shared/constants'
import './HelpModal.css'

interface HelpModalProps {
  open: boolean
  onClose: () => void
  customCommands?: SlashCommand[]
}

const HOTKEY_LABELS: Record<keyof typeof DEFAULT_HOTKEYS, string> = {
  mainWindow: 'Открыть/закрыть главное окно',
  overlay: 'Overlay (захват экрана)',
  voice: 'Голосовой режим',
  spotlight: 'Spotlight (быстрый запрос)',
  quickQuestion: 'Быстрый вопрос',
  chatAskMode: 'Режим вопросов (Ctrl+1)',
  chatPlanningMode: 'Режим планирования (Ctrl+2)',
}

export default function HelpModal({ open, onClose, customCommands = [] }: HelpModalProps) {
  // Esc закрывает модалку
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Объединяем builtin + custom для отображения. builtin сначала.
  const allCommands = useMemo(() => {
    const seen = new Set<string>()
    const out: SlashCommand[] = []
    for (const cmd of SLASH_COMMANDS) {
      if (seen.has(cmd.name)) continue
      seen.add(cmd.name)
      out.push(cmd)
    }
    for (const cmd of customCommands) {
      if (seen.has(cmd.name)) continue
      seen.add(cmd.name)
      out.push(cmd)
    }
    return out
  }, [customCommands])

  if (!open) return null

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="help-modal-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onClose}
      >
        <motion.div
          className="help-modal"
          initial={{ opacity: 0, scale: 0.94, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.94, y: 12 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          onClick={e => e.stopPropagation()}
        >
          <div className="help-modal-header">
            <h2 className="help-modal-title">
              <AppIcon name="helpCircle" size="md" />
              <span>Команды и горячие клавиши</span>
            </h2>
            <button className="help-modal-close" onClick={onClose} title="Закрыть (Esc)">
              <AppIcon name="x" size="sm" />
            </button>
          </div>

          <div className="help-modal-body">
            <section className="help-modal-section">
              <h3 className="help-modal-section-title">Slash-команды</h3>
              <p className="help-modal-section-hint">
                Введите <code>/</code> в поле сообщения для автокомплита.
                Кастомные команды загружаются из <code>.syntee/commands/*.md</code>.
              </p>
              <div className="help-modal-commands">
                {allCommands.map(cmd => (
                  <div key={cmd.name} className="help-command-row">
                    <span className="help-command-icon">
                      <AppIcon name={cmd.icon as Parameters<typeof AppIcon>[0]['name']} size="sm" />
                    </span>
                    <span className="help-command-label">{cmd.label}</span>
                    <span className="help-command-desc">{cmd.description}</span>
                    {cmd.argumentHint && (
                      <span className="help-command-hint">&lt;{cmd.argumentHint}&gt;</span>
                    )}
                    {cmd.source && cmd.source !== 'builtin' && (
                      <span className={`help-command-source help-command-source--${cmd.source}`}>
                        {cmd.source === 'user' ? 'user' : cmd.source === 'project' ? 'project' : ''}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="help-modal-section">
              <h3 className="help-modal-section-title">Горячие клавиши</h3>
              <p className="help-modal-section-hint">
                Глобальные хоткеи настраиваются в <code>Настройки → Горячие клавиши</code>.
              </p>
              <div className="help-modal-hotkeys">
                {Object.entries(DEFAULT_HOTKEYS).map(([key, accel]) => (
                  <div key={key} className="help-hotkey-row">
                    <span className="help-hotkey-label">{HOTKEY_LABELS[key as keyof typeof DEFAULT_HOTKEYS] ?? key}</span>
                    <kbd className="help-hotkey-accel">{accel}</kbd>
                  </div>
                ))}
              </div>
            </section>

            <section className="help-modal-section help-modal-section--tips">
              <h3 className="help-modal-section-title">Подсказки</h3>
              <ul className="help-modal-tips">
                <li><code>/fork</code> — дублировать чат для &quot;what-if&quot; экспериментов без потери оригинала.</li>
                <li><code>/snapshot &lt;имя&gt;</code> + <code>/restore</code> — именованные точки отката (поверх авто-чекпоинтов на каждый turn).</li>
                <li><code>/review</code>, <code>/tests</code>, <code>/debug</code>, <code>/refactor</code>, <code>/git</code> — встроенные режимы с активацией скиллов.</li>
                <li>Создайте файл <code>.syntee/commands/my-cmd.md</code> в проекте для кастомной команды.</li>
                <li>Файл <code>AGENTS.md</code> или <code>.syntee/instructions.md</code> в корне проекта даёт агенту проектные инструкции.</li>
              </ul>
            </section>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
