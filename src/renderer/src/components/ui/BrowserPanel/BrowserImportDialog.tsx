import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BrowserImportSource, BrowserImportResult, BrowserDataPage } from '../../../../../shared/browserImport'
import './BrowserImportDialog.css'

interface Props {
  mode: 'import' | 'bookmarks' | 'history'
  profileId: string
  onClose: () => void
  onImported: (profile: { id: string; name: string }) => Promise<void>
}

export default function BrowserImportDialog({ mode, profileId, onClose, onImported }: Props) {
  const [sources, setSources] = useState<BrowserImportSource[]>([])
  const [sourceId, setSourceId] = useState('')
  const [name, setName] = useState('')
  const [bookmarks, setBookmarks] = useState(true)
  const [history, setHistory] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<BrowserImportResult | null>(null)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<BrowserDataPage>({ items: [], total: 0 })
  const source = sources.find(s => s.id === sourceId)

  useEffect(() => {
    if (mode !== 'import') return
    let canceled = false
    window.syntee.browser.importSources().then(items => {
      if (canceled) return
      setSources(items)
      if (items[0]) { setSourceId(items[0].id); setName(`${items[0].browser === 'chrome' ? 'Chrome' : 'Edge'} — ${items[0].name}`) }
    }).catch(e => { if (!canceled) setError(String(e.message ?? e)) }).finally(() => { if (!canceled) setLoading(false) })
    return () => { canceled = true }
  }, [mode])

  useEffect(() => {
    if (mode === 'import') return
    let canceled = false
    const timer = setTimeout(() => {
      setLoading(true); setError('')
      window.syntee.browser.importedData(profileId, mode, query, offset).then(data => {
        if (!canceled) setPage(data)
      }).catch(e => { if (!canceled) setError(String(e.message ?? e)) }).finally(() => { if (!canceled) setLoading(false) })
    }, 200)
    return () => { canceled = true; clearTimeout(timer) }
  }, [mode, profileId, query, offset])

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [busy, onClose])

  const importData = async () => {
    if (busy || !source) return
    setBusy(true); setError('')
    try {
      const data = await window.syntee.browser.importData({ sourceId, name, bookmarks: bookmarks && source.bookmarks, history: history && source.history })
      setResult(data)
      if (!data.ok) setError(data.error ?? 'Не удалось импортировать данные')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const openProfile = async () => {
    if (!result?.profile || busy) return
    setBusy(true)
    try { await onImported(result.profile); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return createPortal(
    <div className="browser-import-backdrop" onClick={() => { if (!busy) onClose() }}>
      <section className="browser-import-dialog" role="dialog" aria-modal="true" aria-label={mode === 'import' ? 'Импорт из браузера' : 'Импортированные данные'} onClick={e => e.stopPropagation()}>
        <header><h3>{mode === 'import' ? 'Импорт из Chrome / Edge' : mode === 'bookmarks' ? 'Импортированные закладки' : 'Импортированная история'}</h3><button disabled={busy} onClick={onClose} aria-label="Закрыть">✕</button></header>
        {mode === 'import' ? <>
          <p>Данные переносятся в новый отдельный профиль Syntee. Исходный браузер остаётся без изменений.</p>
          {loading ? <p role="status">Поиск профилей…</p> : sources.length === 0 ? <p>Профили Chrome и Edge в стандартных папках Windows не найдены.</p> : <>
            <label>Исходный профиль<select disabled={busy || !!result?.ok} value={sourceId} onChange={e => {
              setSourceId(e.target.value)
              const item = sources.find(s => s.id === e.target.value)
              if (item) setName(`${item.browser === 'chrome' ? 'Chrome' : 'Edge'} — ${item.name}`)
            }}>{sources.map(s => <option key={s.id} value={s.id}>{s.browser === 'chrome' ? 'Chrome' : 'Edge'} — {s.name}</option>)}</select></label>
            <label>Название профиля Syntee<input maxLength={40} disabled={busy || !!result?.ok} value={name} onChange={e => setName(e.target.value)} /></label>
            <label className="browser-import-check"><input type="checkbox" checked={bookmarks && !!source?.bookmarks} disabled={busy || !!result?.ok || !source?.bookmarks} onChange={e => setBookmarks(e.target.checked)} />Закладки с папками{!source?.bookmarks && ' (нет файла)'}</label>
            <label className="browser-import-check"><input type="checkbox" checked={history && !!source?.history} disabled={busy || !!result?.ok || !source?.history} onChange={e => setHistory(e.target.checked)} />История{!source?.history && ' (нет файла)'}</label>
            <p className="browser-import-note">Переносятся до 50 000 последних адресов истории. Для надёжного чтения лучше закрыть Chrome / Edge. Cookies, пароли, расширения и входы в аккаунты не переносятся.</p>
          </>}
          {result?.ok && <div role="status">Создан профиль «{result.profile?.name}». Закладок: {result.bookmarks}; адресов истории: {result.history}.</div>}
          {result?.warnings.map((warning, i) => <p className="browser-import-note" key={i}>{warning}</p>)}
          {error && <p className="browser-import-error" role="alert">{error}</p>}
          <footer><button disabled={busy} onClick={onClose}>Закрыть</button>{result?.ok ? <button disabled={busy} onClick={openProfile}>Открыть профиль</button> : <button disabled={busy || loading || !source || !name.trim() || !(bookmarks && source.bookmarks || history && source.history)} onClick={importData}>{busy ? 'Импорт…' : 'Импортировать в новый профиль'}</button>}</footer>
        </> : <>
          <input aria-label="Поиск по названию или адресу" placeholder="Поиск по названию или адресу" value={query} onChange={e => { setQuery(e.target.value); setOffset(0); setLoading(true) }} />
          <p className="browser-import-note">Это сохранённый импорт, не текущая история посещений Syntee.</p>
          {error && <p className="browser-import-error" role="alert">{error}</p>}
          <div className="browser-import-list">{loading ? <p role="status">Загрузка…</p> : page.items.length === 0 ? <p>Нет данных. Импортируй их через меню профиля.</p> : page.items.map((item, i) => <button key={`${item.url}-${i}`} title={item.url} onClick={async () => {
            try { const id = await window.syntee.browser.newTab(item.url); await window.syntee.browser.selectTab(id); onClose() }
            catch (e) { setError(e instanceof Error ? e.message : String(e)) }
          }}><strong>{item.title || item.url}</strong><span>{item.url}</span>{item.folder && <small>{item.folder}</small>}{item.lastVisited && <small>{new Date(item.lastVisited).toLocaleString()}</small>}</button>)}</div>
          <footer><button disabled={loading || offset === 0} onClick={() => { setLoading(true); setOffset(n => Math.max(0, n - 100)) }}>Назад</button><span>{page.total ? `${offset + 1}–${Math.min(offset + 100, page.total)} из ${page.total}` : '0'}</span><button disabled={loading || offset + 100 >= page.total} onClick={() => { setLoading(true); setOffset(n => n + 100) }}>Далее</button></footer>
        </>}
      </section>
    </div>, document.body,
  )
}
