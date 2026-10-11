import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import './BrowserImportDialog.css'

export default function BrowserDeleteProfileDialog({ profile, onClose, onDelete }: {
  profile: { id: string; name: string }
  onClose: () => void
  onDelete: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [busy, onClose])
  return createPortal(
    <div className="browser-import-backdrop" onClick={() => { if (!busy) onClose() }}>
      <section className="browser-import-dialog" role="dialog" aria-modal="true" aria-label="Удалить профиль" onClick={e => e.stopPropagation()}>
        <header><h3>Удалить профиль «{profile.name}»?</h3><button type="button" disabled={busy} onClick={onClose} aria-label="Закрыть">✕</button></header>
        <p>Будут удалены все аккаунты, cookies, хранилище, кэш и импортированные данные этого профиля. Исходные Chrome и Edge не затрагиваются.</p>
        {error && <p className="browser-import-error" role="alert">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={onClose}>Отмена</button><button type="button" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await onDelete(); onClose() } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false) } }}>{busy ? 'Удаление…' : 'Удалить профиль'}</button></footer>
      </section>
    </div>, document.body,
  )
}
