// CDP-проба состояния рендерера для smoke-теста приложения.
// Подключается к первому page-target, проверяет: preload (window.electron),
// наличие BootScreen и заголовок страницы. Используется при тестировании
// защищённых сборок (SYNTEE_PROTECT) с изолированным userData.
const base = 'http://127.0.0.1:9222'

const list = await (await fetch(base + '/json/list')).json()
const page = list.find((t) => t.type === 'page' && !t.url.includes('devtools'))
if (!page) {
  console.log('NO PAGE TARGET. targets:', list.map((t) => t.type + ':' + t.title).join(', '))
  process.exit(1)
}
console.log('target:', page.title, '|', page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const events = []

function send(method, params) {
  return new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    events.push(`[console.${m.params.type}] ${String(text).slice(0, 250)}`)
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    events.push(`[exception] ${d.text} ${(d.exception && d.exception.description || '').slice(0, 400)}`)
  }
})

ws.addEventListener('open', async () => {
  await send('Runtime.enable', {})
  const checks = [
    ['window.electron', `typeof window.electron`],
    ['boot-screen в DOM', `!!document.querySelector('.boot-screen')`],
    ['title', `document.title`],
    ['app root', `!!document.querySelector('#root') && document.querySelector('#root').children.length > 0`],
  ]
  for (const [name, expr] of checks) {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
      console.log(`${name}:`, JSON.stringify(r && r.result && r.result.value))
    } catch (e) {
      console.log(`${name}: ERROR ${e.message}`)
    }
  }
  await new Promise((r) => setTimeout(r, 6000))
  console.log('--- события за 6с ---')
  events.forEach((e) => console.log(e))
  if (events.length === 0) console.log('(тихо — ни консоли, ни исключений)')
  ws.close()
  process.exit(0)
})
ws.addEventListener('error', (e) => {
  console.log('WS ERROR:', e.message || e)
  process.exit(1)
})
