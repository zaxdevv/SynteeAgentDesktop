import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'framer-motion'
import type { ContextInspection, ContextPreferences } from '../../../../../shared/types/contextControls'
import './ContextManager.css'

interface ContextManagerProps {
  chatId: string
  onClose: () => void
  returnFocus?: () => void
}

export default function ContextManager({ chatId, onClose, returnFocus }: ContextManagerProps) {
  const [inspection, setInspection] = useState<ContextInspection | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [messageLimit, setMessageLimit] = useState(100)
  const dialogRef = useRef<HTMLDivElement>(null)
  const live = useRef(false)
  const locked = useRef(false)
  const callbacks = useRef({ onClose, returnFocus })
  useEffect(() => { callbacks.current = { onClose, returnFocus } }, [onClose, returnFocus])
  const titleId = useId()
  const noteId = useId()
  const reduceMotion = useReducedMotion()
  const dialogMotion = reduceMotion ? { duration: 0 } : { type: 'spring' as const, stiffness: 360, damping: 32 }

  useEffect(() => {
    live.current = true
    let active = true
    void window.syntee.context.inspect(chatId).then(data => {
      if (active) setInspection(data)
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (active) setBusy(false) })
    return () => { active = false; live.current = false }
  }, [chatId])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex="0"]'
    ) ?? []).filter(element => element.getClientRects().length > 0)
    dialogRef.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        callbacks.current.onClose()
      } else if (event.key === 'Tab') {
        const elements = focusable()
        const first = elements[0]
        const last = elements[elements.length - 1]
        if (!first) { event.preventDefault(); dialogRef.current?.focus(); return }
        if (!dialogRef.current?.contains(document.activeElement) ||
          (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) ||
          (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current))) {
          event.preventDefault()
          ;(event.shiftKey ? last : first)?.focus()
        }
      }
    }
    const containFocus = (event: FocusEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) dialogRef.current?.focus()
    }
    document.addEventListener('keydown', handleKey, true)
    document.addEventListener('focusin', containFocus)
    return () => {
      document.removeEventListener('keydown', handleKey, true)
      document.removeEventListener('focusin', containFocus)
      if (!callbacks.current.returnFocus && previous?.isConnected) previous.focus()
    }
  }, [])

  const perform = async (mutation?: () => Promise<unknown>) => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      if (mutation) {
        const result = await mutation()
        if (result === false) throw new Error('Изменение не сохранено. Попробуйте ещё раз.')
      }
      const data = await window.syntee.context.inspect(chatId)
      if (live.current) setInspection(data)
    } catch (reason) {
      if (live.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      locked.current = false
      if (live.current) setBusy(false)
    }
  }
  const preferences = (patch: Partial<ContextPreferences>) =>
    perform(() => window.syntee.context.setPreferences(chatId, patch))
  const messages = inspection?.messages.filter(message =>
    `${message.role} ${message.preview}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  ) ?? []

  return createPortal(
    <motion.div key="context-manager-backdrop" className="context-manager-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }}>
      <motion.div ref={dialogRef} className="context-manager" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={noteId} tabIndex={-1}
        initial={reduceMotion ? false : { opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 14, scale: 0.98 }}
        transition={dialogMotion}>
        <header className="context-manager-header">
          <h2 id={titleId}>Управление контекстом</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть управление контекстом">✕</button>
        </header>
        <div className="context-manager-body">
          <p id={noteId} className="context-manager-note">Изменения применяются к следующему запросу и не меняют уже запущенный ответ. Состояния ниже получены из проверки контекста на сервере, а не из активного запроса.</p>
          <p className="context-manager-note">«Инструменты» управляют только историческими вызовами и результатами, а не доступностью инструментов. «Память» управляет автоматически добавленной памятью, но не явным вызовом инструмента recall_memory.</p>
          <div className="context-manager-status" role="status" aria-live="polite">{busy ? <><span>{inspection ? 'Сохранение / обновление…' : 'Загрузка контекста…'}</span><span className="context-manager-spinner" aria-label="Загрузка" /></> : 'Проверка контекста обновлена'}
            <button type="button" disabled={busy} onClick={() => void perform()}>Обновить</button>
          </div>
          {!inspection && busy && <div className="context-manager-skeleton" aria-hidden="true">{[0, 1, 2, 3].map(item => <div className="context-manager-skeleton-card" key={item}><i /><span /><span /></div>)}</div>}
          {error && <div className="context-manager-error" role="alert">{error}</div>}
          {inspection && <motion.div aria-busy={busy} initial={reduceMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : 0.22 }}>
            <fieldset disabled={busy} className="context-manager-section">
              <legend>Источники</legend>
              {inspection.sources.map(source => <label className="context-manager-source" key={source.key}>
                <input type="checkbox" checked={inspection.preferences.sources[source.key]}
                  onChange={event => void preferences({ sources: { ...inspection.preferences.sources, [source.key]: event.target.checked } })} />
                <span><strong>{source.label}</strong><small>{source.detail}</small></span>
                <span className="context-manager-state">{source.enabled ? 'Включён' : 'Выключен'}<small>{source.characters.toLocaleString()} симв.</small></span>
              </label>)}
            </fieldset>
            <fieldset disabled={busy} className="context-manager-section">
              <legend>Файлы проекта</legend>
              <p className="context-manager-hint">Флажок разрешает файл; итоговое включение зависит также от источников инструкций и файлов проекта.</p>
              {!inspection.files.length && <p className="context-manager-hint">Нет файлов для проверки.</p>}
              {inspection.files.map(file => <label className="context-manager-file" key={file.source}>
                <input type="checkbox" checked={!inspection.preferences.excludedFiles.includes(file.source)} onChange={event => {
                  const excludedFiles = inspection.preferences.excludedFiles.filter(path => path !== file.source)
                  if (!event.target.checked) excludedFiles.push(file.source)
                  void preferences({ excludedFiles })
                }} />
                <span className="context-manager-file-name">{file.source}<small>{file.characters.toLocaleString()} симв.</small></span>
                <span className="context-manager-state">{file.included ? 'Включён' : 'Не включён'}</span>
              </label>)}
            </fieldset>
            <section className="context-manager-section" aria-label="Сообщения">
              <h3>Сообщения</h3>
              <label className="context-manager-search">Поиск по роли и тексту
                <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Найти сообщение…" />
              </label>
              <p className="context-manager-hint">При выключенной истории закреплённые сообщения остаются в контексте, в том числе до последнего сжатия. Исключение имеет приоритет: скрытое сообщение не включается даже при закреплении. Ниже показан итог отбора истории.</p>
              {!messages.length && <p className="context-manager-hint">{search ? 'Ничего не найдено.' : 'Нет сообщений.'}</p>}
              {messages.length > messageLimit && <button type="button" onClick={() => setMessageLimit(limit => limit + 100)}>Показать более ранние сообщения ({messages.length - messageLimit})</button>}
              <div className="context-manager-messages">
                {messages.slice(-messageLimit).map(message => <div className="context-manager-message" key={message.id}>
                  <div className="context-manager-message-header"><strong>{message.role}</strong><span className="context-manager-state">{message.included ? 'Включено' : 'Не включено'}</span></div>
                  <p>{message.preview || 'Сообщение без текста / вызов инструмента'}</p>
                  <div className="context-manager-message-actions">
                    <label><input type="checkbox" disabled={busy} checked={!message.isHidden}
                      onChange={event => void perform(() => window.syntee.context.setMessageHidden(chatId, message.id, !event.target.checked))} />Разрешить в контексте</label>
                    <button type="button" disabled={busy} aria-pressed={message.isPinned}
                      onClick={() => void perform(() => window.syntee.context.setMessagePinned(chatId, message.id, !message.isPinned))}>
                      {message.isPinned ? 'Открепить' : 'Закрепить'}
                    </button>
                  </div>
                </div>)}
              </div>
            </section>
          </motion.div>}
        </div>
        <footer className="context-manager-footer"><span>Настройки сохраняются автоматически.</span><button type="button" onClick={onClose}>Готово</button>        </footer>
      </motion.div>
    </motion.div>, document.body
  )
}
