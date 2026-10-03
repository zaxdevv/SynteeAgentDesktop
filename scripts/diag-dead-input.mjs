// ── CDP-диагностика бага «мёртвый инпут после Dots» ──────────────────────
// Подключается к рендереру через Chrome DevTools Protocol, кликает кнопку
// Dots в TitleBar (открыть → закрыть), затем проверяет:
//   1. остался ли .page-motion-host в DOM (застрявший exit AnimatePresence)
//   2. что реально находится под точкой центра инпута (elementFromPoint)
//   3. кликабельность инпута (hit-тест по цепочке родителей)
const DEBUG_PORT = 9222

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
  return res.json()
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res2, rej2) => {
          const msgId = ++id
          pending.set(msgId, { res2, rej2 })
          ws.send(JSON.stringify({ id: msgId, method, params }))
        })
      },
      close: () => ws.close(),
    })
    ws.onerror = reject
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej2(new Error(msg.error.message))
        else res2(msg.result)
      }
    }
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  // Ждём, пока поднимется CDP
  let targets = null
  for (let i = 0; i < 30; i++) {
    try { targets = await getTargets(); break } catch { await sleep(1000) }
  }
  if (!targets) { console.log('FAIL: CDP not available'); process.exit(1) }

  // Главное окно — page-таргет с index.html (не tray-menu/overlay/voice)
  const main = targets.find(t => t.type === 'page' && /index\.html/i.test(t.url) && !/tray-menu|overlay|voice|spotlight|notifications/i.test(t.url))
  if (!main) { console.log('FAIL: main window target not found', targets.map(t => `${t.type}:${t.url}`)); process.exit(1) }
  console.log('TARGET:', main.title, '|', main.url)

  const cdp = await connect(main.webSocketDebuggerUrl)

  const evalJs = async (expression, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') }
    return r.result?.value
  }

  // Ждём загрузку приложения (BootScreen → чат); dump состояния при таймауте
  let booted = false
  for (let i = 0; i < 50; i++) {
    const ready = await evalJs(`!!document.querySelector('.chat-input-wrap .chat-input-main') && !!document.querySelector('.titlebar-right')`)
    if (ready === true) { booted = true; break }
    if (i % 10 === 9) {
      const st = await evalJs(`(() => {
        const root = document.getElementById('root')
        const kids = root ? [...root.children].slice(0, 5).map(c => c.tagName + '.' + (typeof c.className === 'string' ? c.className.split(' ')[0] : '')) : []
        return { body: document.body.className.slice(0, 80), rootKids: kids, boot: !!document.querySelector('.boot-screen'), login: !!document.querySelector('[class*=login]'), titlebar: !!document.querySelector('.titlebar-right') }
      })()`)
      console.log(`  boot-wait ${i + 1}s:`, JSON.stringify(st))
    }
    await sleep(1000)
  }
  if (!booted) console.log('WARN: app not fully booted, continuing anyway')
  console.log('--- app booted ---')
  await sleep(1500)

  // ── Шаг 0: состояние ДО ──
  const before = await evalJs(`(() => {
    const ed = document.querySelector('.chat-input-wrap .chat-input-editor') || document.querySelector('.chat-input-wrap [contenteditable]')
    if (!ed) return { err: 'no editor' }
    const r = ed.getBoundingClientRect()
    const cx = r.x + r.width / 2, cy = r.y + Math.min(r.height / 2, 30)
    const hit = document.elementFromPoint(cx, cy)
    const chain = []
    let el = hit
    while (el && chain.length < 12) { chain.push(el.tagName + '.' + (el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : '')); el = el.parentElement }
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, hit: hit ? hit.tagName + '.' + (typeof hit.className === 'string' ? hit.className : '') : null, chain }
  })()`)
  console.log('BEFORE:', JSON.stringify(before, null, 1))

  // ── Шаг 1: клик по кнопке Dots (открыть страницу) ──
  const clicked = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('.titlebar-right button, .titlebar-right [role=button]')]
    const dots = btns.find(b => (b.title || b.getAttribute('aria-label') || '').toLowerCase().includes('dots'))
    if (!dots) return { err: 'dots button not found', btns: btns.map(b => b.title || b.getAttribute('aria-label')) }
    dots.click()
    return { ok: true }
  })()`)
  console.log('CLICK DOTS:', JSON.stringify(clicked))
  await sleep(2500) // страница открылась, анимации пошли

  const during = await evalJs(`(() => {
    const hosts = document.querySelectorAll('.page-motion-host')
    return { pageHosts: hosts.length, dotsPage: !!document.querySelector('.dots-page'), blobs: document.querySelectorAll('.dot-blob').length }
  })()`)
  console.log('DURING (dots open):', JSON.stringify(during))

  // ── Шаг 1.5: открыть чат Dot'а (репорт «инпут основного чата мёртв именно
  // при открытом DotChat»). Кликаем первую карточку Dot'а — монтируется DotChat
  // со своим ChatInput (порталы ChatInputPlusMenu/ContextRing/StatusRow).
  const dotOpen = await evalJs(`(() => {
    const card = document.querySelector('.dot-card')
    if (!card) return { ok: false, reason: 'no dot cards (создай Dot для проверки)' }
    card.click()
    return { ok: true, cards: document.querySelectorAll('.dot-card').length }
  })()`)
  console.log('CLICK DOT CARD:', JSON.stringify(dotOpen))
  await sleep(1500)
  const dotChat = await evalJs(`(() => ({
    dotChat: !!document.querySelector('.dot-chat'),
    dotInput: !!document.querySelector('.dot-chat .chat-input-wrap'),
    motionHosts: document.querySelectorAll('.page-motion-host').length,
  }))()`)
  console.log('DOT CHAT OPEN:', JSON.stringify(dotChat))

  // ── Шаг 2: клик по кнопке Dots снова (закрыть страницу) ──
  const clicked2 = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('.titlebar-right button, .titlebar-right [role=button]')]
    const dots = btns.find(b => (b.title || b.getAttribute('aria-label') || '').toLowerCase().includes('dots'))
    if (!dots) return { err: 'dots button not found' }
    dots.click()
    return { ok: true }
  })()`)
  console.log('CLICK DOTS (close):', JSON.stringify(clicked2))

  // ── Шаг 3: проверки сразу и после задержек (exit должен завершиться) ──
  for (const waitMs of [300, 1200, 3000]) {
    await sleep(waitMs)
    const state = await evalJs(`(() => {
      const hosts = [...document.querySelectorAll('.page-motion-host')]
      const ed = document.querySelector('.chat-input-wrap .chat-input-editor') || document.querySelector('.chat-input-wrap [contenteditable]')
      const out = {
        pageHosts: hosts.length,
        pageHostsInfo: hosts.map(h => {
          const cs = getComputedStyle(h)
          return { display: cs.display, opacity: cs.opacity, pe: cs.pointerEvents, visibility: cs.visibility, child: h.firstElementChild ? h.firstElementChild.className : null }
        }),
        dotsPage: !!document.querySelector('.dots-page'),
        chatInput: !!document.querySelector('.chat-input-wrap .chat-input-main'),
      }
      if (ed) {
        const r = ed.getBoundingClientRect()
        const cx = r.x + r.width / 2, cy = r.y + Math.min(r.height / 2, 30)
        const hit = document.elementFromPoint(cx, cy)
        out.editorRect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        out.hitAtEditor = hit ? (hit.tagName + '.' + (typeof hit.className === 'string' ? hit.className : '')) : null
        out.hitIsEditor = !!(hit && (hit === ed || ed.contains(hit)))
        const wrap = document.querySelector('.chat-input-wrap')
        if (wrap) { const wr = wrap.getBoundingClientRect(); out.wrapRect = { x: Math.round(wr.x), y: Math.round(wr.y), w: Math.round(wr.width), h: Math.round(wr.height) } }
      } else { out.err = 'no editor' }
      return out
    })()`)
    console.log(`AFTER +${waitMs}ms:`, JSON.stringify(state, null, 1))
  }

  // ── Шаг 4: hit-тест всей зоны инпута (сетка точек) ──
  const grid = await evalJs(`(() => {
    const wrap = document.querySelector('.chat-input-wrap')
    if (!wrap) return { err: 'no wrap' }
    const r = wrap.getBoundingClientRect()
    const bad = []
    for (let fx = 0.1; fx <= 0.9; fx += 0.2) {
      for (let fy = 0.2; fy <= 0.8; fy += 0.3) {
        const x = r.x + r.width * fx, y = r.y + r.height * fy
        const hit = document.elementFromPoint(x, y)
        const inWrap = !!(hit && (wrap === hit || wrap.contains(hit)))
        if (!inWrap) bad.push({ x: Math.round(x), y: Math.round(y), got: hit ? hit.tagName + '.' + (typeof hit.className === 'string' ? hit.className.split(' ').slice(0,2).join('.') : '') : 'null' })
      }
    }
    return { wrapRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, blockedPoints: bad }
  })()`)
  console.log('GRID HIT-TEST:', JSON.stringify(grid, null, 1))

  // ── Шаг 5: все элементы с pointer-events!=none, пересекающие зону инпута ──
  const overlays = await evalJs(`(() => {
    const wrap = document.querySelector('.chat-input-wrap')
    if (!wrap) return { err: 'no wrap' }
    const r = wrap.getBoundingClientRect()
    const out = []
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      if (cs.pointerEvents === 'none' || cs.visibility === 'hidden' || cs.display === 'none') continue
      const er = el.getBoundingClientRect()
      if (er.width < 2 || er.height < 2) continue
      const overlaps = !(er.right < r.x || er.left > r.right || er.bottom < r.y || er.top > r.bottom)
      if (!overlaps) continue
      // пропускаем сам инпут и его детей
      if (wrap === el || wrap.contains(el)) continue
      const z = cs.zIndex
      out.push({ tag: el.tagName, cls: (typeof el.className === 'string' ? el.className.split(' ').slice(0, 2).join('.') : '').slice(0, 60), z: z === 'auto' ? 'auto' : z, pe: cs.pointerEvents, opacity: cs.opacity, rect: { x: Math.round(er.x), y: Math.round(er.y), w: Math.round(er.width), h: Math.round(er.height) } })
    }
    return out.slice(0, 25)
  })()`)
  console.log('ELEMENTS OVERLAPPING INPUT ZONE:', JSON.stringify(overlays, null, 1))

  cdp.close()
  console.log('--- done ---')
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
