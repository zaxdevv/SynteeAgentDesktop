// bridge — мост synteeBridge (RPC в процесс плагина) + шим темы + общие утилиты панели
'use strict'

const synteeBridge = (() => {
  let seq = 0
  const pending = new Map()
  const handlers = new Map()
  window.addEventListener('message', (e) => {
    const d = e.data
    if (!d || d.source !== 'syntee-plugin-host') return
    // RPC-ответ
    if (d.rpc && pending.has(d.id)) {
      const p = pending.get(d.id); pending.delete(d.id)
      d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || 'RPC error'))
      return
    }
    // Тема (при загрузке iframe и при смене)
    if (d.theme) return
    // Push от плагина: syntee.ui.emit(method, data)
    if (d.data && d.data.__rpc__) {
      ;(handlers.get(d.data.method) || []).forEach(cb => { try { cb(d.data.data) } catch (err) { console.error(err) } })
      return
    }
    // Legacy push (syntee.ui.postMessage)
    if (d.data !== undefined) {
      ;(handlers.get('*') || []).forEach(cb => { try { cb(d.data) } catch (err) { console.error(err) } })
    }
  })
  return {
    call(method, args) {
      const id = 'rpc-' + (++seq)
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        parent.postMessage({ source: 'syntee-plugin', rpc: true, id, method, args }, '*')
      })
    },
    on(method, cb) {
      if (!handlers.has(method)) handlers.set(method, [])
      handlers.get(method).push(cb)
    },
    _handlers: handlers,
  }
})()

// ── Шим темы: сообщение хоста → CSS-переменные документа ──
function otApplyTheme(t) {
  if (!t) return
  const s = document.documentElement.style
  s.setProperty('--accent', t.accentColor)
  s.setProperty('--text', t.dark ? '#e6e6ec' : '#1c1c22')
  s.setProperty('--text-2', t.dark ? '#9aa0ae' : '#5b616e')
  s.setProperty('--bg', t.dark ? '#141418' : '#f7f7f9')
  s.setProperty('--bg-2', t.dark ? '#1c1c22' : '#ffffff')
  s.setProperty('--border', t.dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.10)')
}
window.addEventListener('message', (e) => {
  const d = e.data
  if (d && d.source === 'syntee-plugin-host' && d.theme) otApplyTheme(d.theme)
})

// ── Утилиты, общие для модулей панели ──
window.OT = {
  bridge: synteeBridge,

  esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  },

  fmtSize(bytes) {
    const n = Number(bytes) || 0
    if (n < 1024) return n + ' Б'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' КБ'
    return (n / (1024 * 1024)).toFixed(1) + ' МБ'
  },

  fmtDate(iso) {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const now = new Date()
    const sameDay = (a, b) => a.toDateString() === b.toDateString()
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    if (sameDay(d, now)) return 'сегодня ' + hm
    const yest = new Date(now); yest.setDate(now.getDate() - 1)
    if (sameDay(d, yest)) return 'вчера ' + hm
    return d.toLocaleDateString('ru-RU') + ' ' + hm
  },

  opLabel(op) {
    const map = {
      create: 'создан',
      edit: 'изменён',
      read: 'прочитан',
      export: 'экспорт',
      open: 'открыт',
      pdf: 'PDF',
    }
    return map[op] || op || ''
  },

  // Цветной бейдж типа файла: W (Word) / X (Excel) / P (PPT) / PDF
  kindBadge(kind) {
    const k = String(kind || 'word').toLowerCase()
    const conf = {
      word: { letter: 'W', color: '#2b579a' },
      excel: { letter: 'X', color: '#217346' },
      ppt: { letter: 'P', color: '#d24726' },
      pdf: { letter: 'P', color: '#d13438' },
    }[k] || { letter: '?', color: '#8a8f98' }
    return '<span class="ot-badge" style="background:' + conf.color + '">' + conf.letter + '</span>'
  },

  // Строчные SVG-иконки (stroke 1.75, 16px)
  icon(name) {
    const paths = {
      open: '<path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
      pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
      doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
      table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
      ppt: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M12 18v3M8 21h8"/><path d="M10.5 8.5v5M10.5 8.5H13a1.75 1.75 0 0 1 0 3.5h-2.5"/>',
      trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
      bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
    }
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || '') + '</svg>'
  },
}
