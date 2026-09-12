import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { ProtectedVarMeta } from '../../../../../shared/types/protectedVars'
import './ProtectedVarsModal.css'

interface ProtectedVarsModalProps {
  open: boolean
  onClose: () => void
  /** Дергается после любого изменения списка — ChatInput обновит счётчик. */
  onChanged?: () => void
}

/** Форма добавления/редактирования секрета. */
interface VarForm {
  id?: string
  key: string
  value: string
  description: string
  group: string
  linkedIds: string[]
  enabled: boolean
}

const EMPTY_FORM: VarForm = { key: '', value: '', description: '', group: '', linkedIds: [], enabled: true }

/**
 * Модалка управления защищёнными переменными (секретами юзера):
 * ключ-значение + описание + группа + связи с другими секретами.
 * Значения шифруются (safeStorage) и уходят в system prompt —
 * в UI они не возвращаются (только маска SE•••).
 */
export function ProtectedVarsModal({ open, onClose, onChanged }: ProtectedVarsModalProps) {
  const [vars, setVars] = useState<ProtectedVarMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState<VarForm | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const reload = useCallback(() => {
    setLoading(true)
    window.syntee.protectedVars.list()
      .then(list => setVars(list))
      .catch(() => setVars([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (open) {
      setError('')
      setForm(null)
      reload()
    }
  }, [open, reload])

  // Esc — закрыть
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !form) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, form, onClose])

  const keyById = new Map(vars.map(v => [v.id, v.key]))

  const handleSave = async () => {
    if (!form) return
    setError('')
    if (!form.key.trim()) { setError('Ключ обязателен'); return }
    if (!form.id && !form.value) { setError('Значение обязательно при создании'); return }
    setSaving(true)
    try {
      const res = await window.syntee.protectedVars.save({
        id: form.id,
        key: form.key.trim(),
        value: form.value || undefined,
        description: form.description || undefined,
        group: form.group || undefined,
        linkedIds: form.linkedIds,
        enabled: form.enabled,
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setForm(null)
      reload()
      onChanged?.()
    } catch (e) {
      setError((e as Error).message || 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await window.syntee.protectedVars.delete(id)
      reload()
      onChanged?.()
    } catch { /* ignore */ }
  }

  const handleToggleEnabled = async (v: ProtectedVarMeta) => {
    try {
      const res = await window.syntee.protectedVars.save({
        id: v.id, key: v.key, enabled: !v.enabled, linkedIds: v.linkedIds,
        description: v.description, group: v.group,
      })
      if (res.ok) { reload(); onChanged?.() }
    } catch { /* ignore */ }
  }

  const startEdit = (v: ProtectedVarMeta) => {
    setError('')
    setForm({
      id: v.id,
      key: v.key,
      value: '',
      description: v.description ?? '',
      group: v.group ?? '',
      linkedIds: [...v.linkedIds],
      enabled: v.enabled,
    })
  }

  const toggleLinked = (id: string) => {
    if (!form) return
    setForm({
      ...form,
      linkedIds: form.linkedIds.includes(id)
        ? form.linkedIds.filter(l => l !== id)
        : [...form.linkedIds, id],
    })
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="pv-modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={e => { if (e.target === e.currentTarget && !form) onClose() }}
        >
          <motion.div
            className="pv-modal"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
          >
            <div className="pv-modal-header">
              <div className="pv-modal-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                Защищённые переменные
                <span className="pv-modal-count">{vars.length}</span>
              </div>
              <button className="pv-modal-close" onClick={onClose} title="Закрыть">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <div className="pv-modal-hint">
              Секреты (IP, пароли, ключи) шифруются и попадают в системный промпт — AI использует
              их в командах без вопросов, но не показывает в ответах. Инкогнито-чаты их не видят.
            </div>

            <div className="pv-modal-body">
              {form ? (
                <div className="pv-form">
                  <div className="pv-form-row">
                    <label className="pv-label">
                      Ключ <span className="pv-req">*</span>
                      <input
                        className="pv-input"
                        value={form.key}
                        onChange={e => setForm({ ...form, key: e.target.value })}
                        placeholder="SERVER_IP"
                        autoFocus
                        spellCheck={false}
                      />
                    </label>
                    <label className="pv-label">
                      Значение <span className="pv-req">*</span>
                      <input
                        className="pv-input"
                        type="password"
                        value={form.value}
                        onChange={e => setForm({ ...form, value: e.target.value })}
                        placeholder={form.id ? 'оставь пустым — не менять' : '192.168.1.50'}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </label>
                  </div>
                  <div className="pv-form-row">
                    <label className="pv-label">
                      Описание
                      <input
                        className="pv-input"
                        value={form.description}
                        onChange={e => setForm({ ...form, description: e.target.value })}
                        placeholder="IP продакшн-сервера"
                      />
                    </label>
                    <label className="pv-label">
                      Группа
                      <input
                        className="pv-input"
                        value={form.group}
                        onChange={e => setForm({ ...form, group: e.target.value })}
                        placeholder="prod-server"
                        spellCheck={false}
                      />
                    </label>
                  </div>

                  {vars.filter(v => v.id !== form.id).length > 0 && (
                    <div className="pv-form-field">
                      <span className="pv-label-text">Связи — связанные секреты (AI поймёт, что они относятся к одному объекту)</span>
                      <div className="pv-links">
                        {vars.filter(v => v.id !== form.id).map(v => {
                          const selected = form.linkedIds.includes(v.id)
                          return (
                            <button
                              key={v.id}
                              type="button"
                              className={`pv-link-chip${selected ? ' pv-link-chip--on' : ''}`}
                              onClick={() => toggleLinked(v.id)}
                            >
                              {selected && (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12"/>
                                </svg>
                              )}
                              {v.key}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {error && <div className="pv-error">{error}</div>}

                  <div className="pv-form-actions">
                    <button className="pv-btn" onClick={() => { setForm(null); setError('') }}>Отмена</button>
                    <button className="pv-btn pv-btn--primary" onClick={handleSave} disabled={saving}>
                      {saving ? 'Сохранение…' : form.id ? 'Сохранить' : 'Добавить'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {loading && vars.length === 0 && <div className="pv-empty">Загрузка…</div>}
                  {!loading && vars.length === 0 && (
                    <div className="pv-empty">
                      Пока пусто. Добавь, например, IP и пароль сервера — и попроси AI
                      «подключись к серверу», он сам подставит значения.
                    </div>
                  )}
                  {vars.map(v => (
                    <div key={v.id} className={`pv-item${v.enabled ? '' : ' pv-item--disabled'}`}>
                      <div className="pv-item-main">
                        <div className="pv-item-key-row">
                          <span className="pv-item-key">{v.key}</span>
                          <span className="pv-item-mask">SE•••</span>
                          {v.group && <span className="pv-item-group">{v.group}</span>}
                          {v.linkedIds.length > 0 && (
                            <span className="pv-item-linked" title={v.linkedIds.map(id => keyById.get(id)).filter(Boolean).join(', ')}>
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                              </svg>
                              {v.linkedIds.length}
                            </span>
                          )}
                        </div>
                        {v.description && <div className="pv-item-desc">{v.description}</div>}
                      </div>
                      <div className="pv-item-actions">
                        <button
                          className={`pv-toggle${v.enabled ? ' pv-toggle--on' : ''}`}
                          onClick={() => handleToggleEnabled(v)}
                          title={v.enabled ? 'В промпте — нажми, чтобы отключить' : 'Отключён — нажми, чтобы добавить в промпт'}
                        >
                          <span className="pv-toggle-thumb" />
                        </button>
                        <button className="pv-icon-btn" onClick={() => startEdit(v)} title="Редактировать">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        </button>
                        <button className="pv-icon-btn pv-icon-btn--danger" onClick={() => handleDelete(v.id)} title="Удалить">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                  <button className="pv-add-btn" onClick={() => { setError(''); setForm({ ...EMPTY_FORM }) }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Добавить переменную
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
