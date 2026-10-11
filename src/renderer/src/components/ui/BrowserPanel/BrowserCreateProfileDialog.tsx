import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import './BrowserImportDialog.css'

export default function BrowserCreateProfileDialog({ onClose, onCreate }: {
  onClose: () => void
  onCreate: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('Новый профиль')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [busy, onClose])
  return createPortal(
    <div className="browser-import-backdrop" onClick={() => { if (!busy) onClose() }}>
      <form className="browser-import-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-create-title" onClick={e => e.stopPropagation()} onSubmit={async e => {
        e.preventDefault()
        if (busy || !name.trim()) return
        setBusy(true); setError('')
        try { await onCreate(name.trim()); onClose() }
        catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        finally { setBusy(false) }
      }}>
        <header><h3 id="browser-create-title">Создать пустой профиль</h3><button type="button" disabled={busy} onClick={onClose} aria-label="Закрыть">✕</button></header>
        <p>Отдельная сессия без авторизаций и данных других профилей.</p>
        <label>Название профиля<input autoFocus maxLength={40} value={name} disabled={busy} onChange={e => setName(e.target.value)} onFocus={e => e.target.select()} /></label>
        {error && <p className="browser-import-error" role="alert">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={onClose}>Отмена</button><button type="submit" disabled={busy || !name.trim()}>{busy ? 'Создание…' : 'Создать'}</button></footer>
      </form>
    </div>, document.body,
  )
}
