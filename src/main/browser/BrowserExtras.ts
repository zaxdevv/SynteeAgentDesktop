import { isAbsolute, basename } from 'node:path'
import { stat, realpath, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { BrowserOpPayload, BrowserOpResult } from '../managers/BrowserManager'
import { captureAccessibility } from './accessibility'

/** Local debugger pipe only. Never installs session permission/download handlers. */
export interface BrowserExtrasContext {
  signal: AbortSignal
  confirm: (title: string, details?: Record<string, unknown>) => Promise<boolean>
}
type RecordValue = Record<string, any>
type Entry = Record<string, unknown>
interface State {
  wc: Electron.WebContents
  owned: boolean
  connected: boolean
  reveal: Partial<Record<'console' | 'errors' | 'network', string>>
  console: Entry[]
  errors: Entry[]
  network: Entry[]
  dialogs: Entry[]
  downloads: Entry[]
  currentDialog?: Entry
  contexts: Map<string, number>
  contextOrigins: Map<string, string>
  frameOrigins: Map<string, string>
  trace?: { started: number; events: Entry[]; dropped: number }
  message: (...args: any[]) => void
  destroyed: () => void
  disconnected: () => void
  download: (...args: any[]) => void
  cleanup: Set<() => void>
  ready: Promise<void>
}
const LIMIT = 300
const states = new WeakMap<Electron.WebContents, State>()
const actions = new Set(['console', 'network', 'errors', 'dialog', 'downloads', 'upload',
  'cookies', 'storage', 'set_user_agent', 'zoom', 'trace_start', 'trace_stop',
  'performance', 'permissions', 'clear_cache', 'accessibility'])
function push(list: Entry[], entry: Entry): void {
  list.push(entry)
  if (list.length > LIMIT) list.shift()
}
const sensitive = /password|passwd|secret|token|auth|cookie|session|credential|api[-_]?key|signature|code/i
function sanitize(value: unknown, cap = 2048): string {
  return String(value ?? '').slice(0, 16384)
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => safeURL(url, true))
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, '[redacted header]')
    .replace(/\b(?:Bearer|Basic)\s+[\w.+/=:-]+/gi, '[redacted credential]')
    .replace(/(["']?(?:password|passwd|secret|access_token|refresh_token|token|api[_-]?key|session|credential|authorization)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted JWT]')
    .slice(0, cap)
}
function stackSnippet(stack: RecordValue = {}, revealOrigin?: string): Entry[] {
  return (stack.callFrames || []).slice(0, 8).map((f: RecordValue) => {
    const frameOrigin = urlOrigin(f.url)
    const detailed = !!revealOrigin && frameOrigin === revealOrigin
    return { function: sanitize(f.functionName, 120), url: safeURL(f.url, detailed), line: f.lineNumber, column: f.columnNumber }
  })
}
function urlOrigin(value: unknown): string | undefined {
  try { const u = new URL(String(value)); return ['http:', 'https:'].includes(u.protocol) ? u.origin : undefined } catch { return undefined }
}
function sameOrigin(value: unknown, expected: string | undefined): boolean {
  return !!expected && urlOrigin(value) === expected
}
function safeURL(value: unknown, reveal = false): string {
  try {
    const u = new URL(String(value))
    // Even paths can contain credentials, account IDs or reset tokens.
    if (!['http:', 'https:'].includes(u.protocol)) return '[redacted URL]'
    if (!reveal) return u.origin
    u.username = ''; u.password = ''; u.hash = ''
    u.pathname = u.pathname.replace(/\/(token|secret|password|auth|session|reset|code)\/[^/]+/gi, '/$1/[redacted]')
      .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    for (const key of [...u.searchParams.keys()]) {
      if (sensitive.test(key)) u.searchParams.set(key, '[redacted]')
      else u.searchParams.set(key, (u.searchParams.get(key) || '').replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 120))
    }
    return u.toString().slice(0, 2048)
  } catch { return '[redacted URL]' }
}
function headers(value: RecordValue = {}): Entry {
  const result: Entry = {}
  // Only nonsensitive protocol metadata, never cookies/auth/custom headers.
  for (const key of Object.keys(value).slice(0, 100)) {
    if (['content-type', 'content-length', 'cache-control'].includes(key.toLowerCase())) {
      const text = String(value[key])
      if (/^[\w\s;,=./+*-]{0,160}$/.test(text)) result[key.toLowerCase()] = text
    }
  }
  return result
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}..${max}`)
  return n
}
function string(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${label}`)
  return value
}
interface ApprovedFile { path: string; size: number; mtimeMs: number; ino: number; hash: string }
async function fingerprint(path: string): Promise<ApprovedFile> {
  const resolved = await realpath(path)
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error('Upload path is not a regular file')
  if (info.size > 50 * 1024 * 1024) throw new Error('Upload file exceeds 50 MiB')
  const hash = createHash('sha256').update(await readFile(resolved)).digest('hex')
  return { path: resolved, size: info.size, mtimeMs: info.mtimeMs, ino: Number(info.ino), hash }
}
async function sameFile(file: ApprovedFile): Promise<boolean> {
  const next = await fingerprint(file.path)
  return next.path === file.path && next.size === file.size && next.mtimeMs === file.mtimeMs && next.ino === file.ino && next.hash === file.hash
}
function origin(wc: Electron.WebContents): string {
  const u = new URL(wc.getURL())
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Requires a current HTTP(S) origin')
  return u.origin
}
function check(context: BrowserExtrasContext, wc: Electron.WebContents, expected?: string): void {
  if (context.signal.aborted) throw new Error('Browser operation aborted')
  if (wc.isDestroyed()) throw new Error('Tab destroyed')
  if (expected && origin(wc) !== expected) throw new Error('Origin changed; retry on the current page')
}
async function approve(context: BrowserExtrasContext, wc: Electron.WebContents,
  expected: string, title: string, details: Entry = {}): Promise<void> {
  check(context, wc, expected)
  if (!await context.confirm(title, { origin: expected, ...details })) throw new Error('User declined')
  check(context, wc, expected)
}
async function command(state: State, method: string, params: Entry = {}): Promise<RecordValue> {
  if (!state.wc.debugger.isAttached()) throw new Error('Local debugger disconnected')
  return state.wc.debugger.sendCommand(method, params)
}
function recordEvent(state: State, method: string, p: RecordValue): void {
  const time = Date.now()
  const currentOrigin = urlOrigin(state.wc.getURL())
  for (const kind of ['console', 'errors', 'network'] as const) {
    if (state.reveal[kind] !== currentOrigin) delete state.reveal[kind]
  }
  if (state.trace && /^(Network|Runtime|Page)\./.test(method)) {
    if (state.trace.events.length === LIMIT) state.trace.dropped++
    push(state.trace.events, { time, method, ...(p.frameId ? { frameId: String(p.frameId).slice(0, 100) } : {}) })
  }
  // A new document needs fresh capture approval, even on the same origin.
  if ((method === 'Page.frameNavigated' && !p.frame?.parentId) || method === 'Runtime.executionContextsCleared') state.reveal = {}
  if (method === 'Page.frameNavigated' && p.frame?.id) {
    const frameOrigin = urlOrigin(p.frame.url)
    if (frameOrigin) state.frameOrigins.set(String(p.frame.id), frameOrigin)
    else state.frameOrigins.delete(String(p.frame.id))
    if (!p.frame.parentId) { state.contextOrigins.clear(); state.frameOrigins.clear(); if (frameOrigin) state.frameOrigins.set(String(p.frame.id), frameOrigin) }
  } else if (method === 'Runtime.executionContextCreated' && p.context?.auxData?.isDefault) {
    const frameId = String(p.context.auxData.frameId)
    state.contexts.set(frameId, p.context.id)
    const frameOrigin = urlOrigin(p.context.auxData.securityOrigin) || state.frameOrigins.get(frameId)
    if (frameOrigin) state.contextOrigins.set(String(p.context.id), frameOrigin)
    if (state.contexts.size > LIMIT) state.contexts.delete(state.contexts.keys().next().value!)
    if (state.contextOrigins.size > LIMIT) state.contextOrigins.delete(state.contextOrigins.keys().next().value!)
  } else if (method === 'Page.frameDetached') {
    const frameId = String(p.frameId)
    state.frameOrigins.delete(frameId)
    const contextId = state.contexts.get(frameId)
    state.contexts.delete(frameId)
    if (contextId !== undefined) state.contextOrigins.delete(String(contextId))
  } else if (method === 'Runtime.executionContextDestroyed') {
    state.contextOrigins.delete(String(p.executionContextId))
    for (const [frame, id] of state.contexts) if (id === p.executionContextId) state.contexts.delete(frame)
  } else if (method === 'Runtime.executionContextsCleared') {
    state.contexts.clear(); state.contextOrigins.clear(); state.frameOrigins.clear()
  } else if (method === 'Runtime.consoleAPICalled') {
    const approved = state.reveal.console
    const contextOrigin = state.contextOrigins.get(String(p.executionContextId))
    const detailed = !!approved && contextOrigin === approved
    push(state.console, { time, type: p.type, argumentTypes: (p.args || []).slice(0, 20).map((a: RecordValue) => a.type),
      ...(detailed ? { message: sanitize((p.args || []).slice(0, 20).map((a: RecordValue) =>
        a.type === 'object' ? a.description ?? '[object]' : a.value ?? a.description ?? a.type).join(' ')),
      stack: stackSnippet(p.stackTrace, approved) } : {}) })
  } else if (method === 'Runtime.exceptionThrown') {
    const approved = state.reveal.errors
    const contextOrigin = state.contextOrigins.get(String(p.exceptionDetails?.executionContextId))
    const detailed = !!approved && (contextOrigin === approved || sameOrigin(p.exceptionDetails?.url, approved))
    push(state.errors, { time, type: 'exception', line: p.exceptionDetails?.lineNumber,
      column: p.exceptionDetails?.columnNumber, url: safeURL(p.exceptionDetails?.url, detailed),
      ...(detailed ? { message: sanitize(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text),
        stack: stackSnippet(p.exceptionDetails?.stackTrace, approved) } : {}) })
  } else if (method === 'Network.requestWillBeSent') {
    const approved = state.reveal.network
    const detailed = sameOrigin(p.request?.url, approved)
    push(state.network, { time, event: 'request', id: String(p.requestId).slice(0, 100),
      method: p.request?.method, url: safeURL(p.request?.url, detailed), headers: headers(p.request?.headers) })
  } else if (method === 'Network.responseReceived') {
    const approved = state.reveal.network
    const detailed = sameOrigin(p.response?.url, approved)
    push(state.network, { time, event: 'response', id: String(p.requestId).slice(0, 100),
      status: p.response?.status, url: safeURL(p.response?.url, detailed), headers: headers(p.response?.headers) })
  } else if (method === 'Network.loadingFailed') {
    push(state.network, { time, event: 'failed', id: String(p.requestId).slice(0, 100), canceled: !!p.canceled })
  } else if (method === 'Page.javascriptDialogOpening') {
    // Messages/defaultPrompt can contain passwords or page data; never retain them.
    const dialog = { time, type: p.type, origin: safeURL(p.url), open: true }
    state.currentDialog = dialog
    push(state.dialogs, dialog)
  } else if (method === 'Page.javascriptDialogClosed') {
    if (state.currentDialog) Object.assign(state.currentDialog, { open: false, accepted: !!p.result })
    state.currentDialog = undefined
  }
}
function attach(wc: Electron.WebContents): void {
  if (wc.isDestroyed()) return
  const existing = states.get(wc)
  if (existing) {
    if (!existing.connected || !wc.debugger.isAttached()) {
      existing.contexts.clear(); existing.contextOrigins.clear(); existing.frameOrigins.clear(); existing.currentDialog = undefined; existing.trace = undefined; existing.reveal = {}
      if (!wc.debugger.isAttached()) { existing.owned = false; wc.debugger.attach('1.3'); existing.owned = true }
      existing.connected = true
      existing.ready = Promise.all(['Runtime.enable', 'Network.enable', 'Page.enable'].map(m => command(existing, m))).then(() => undefined)
      void existing.ready.catch(() => { existing.connected = false })
    }
    return
  }
  let owned = false
  if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); owned = true }
  const state: State = {
    wc, owned, connected: true, reveal: {}, console: [], errors: [], network: [], dialogs: [], downloads: [],
    contexts: new Map(), contextOrigins: new Map(), frameOrigins: new Map(), cleanup: new Set(), ready: Promise.resolve(),
    message: (_event, method, params) => recordEvent(state, method, params || {}),
    destroyed: () => detach(wc),
      disconnected: () => { state.owned = false; state.connected = false; state.reveal = {}; state.contexts.clear(); state.contextOrigins.clear(); state.frameOrigins.clear(); state.currentDialog = undefined; state.trace = undefined },
    download: (_event, item: Electron.DownloadItem, source: Electron.WebContents) => {
      if (source !== wc) return
      // Do not retain actual filenames/URLs: either can carry secrets. Keep extension only.
      const raw = basename(item.getFilename())
      const extension = /\.([a-zA-Z0-9]{1,10})$/.exec(raw)?.[1]?.toLowerCase()
      const entry: Entry = { id: `${Date.now()}-${state.downloads.length}`, time: Date.now(),
        filename: extension ? `download.${extension}` : 'download', receivedBytes: 0,
        totalBytes: item.getTotalBytes(), state: 'progressing' }
      push(state.downloads, entry)
      const updated = (_e: unknown, status: string): void => {
        Object.assign(entry, { state: status, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() })
      }
      const remove = (): void => { item.removeListener('updated', updated); item.removeListener('done', done); state.cleanup.delete(remove) }
      const done = (_e: unknown, status: string): void => { updated(_e, status); remove() }
      item.on('updated', updated)
      item.once('done', done)
      state.cleanup.add(remove)
      // Bound active download observers too, even if downloads never finish.
      if (state.cleanup.size > LIMIT) state.cleanup.values().next().value?.()
    }
  }
  states.set(wc, state)
  wc.debugger.on('message', state.message)
  wc.debugger.on('detach', state.disconnected)
  wc.once('destroyed', state.destroyed)
  wc.session.on('will-download', state.download)
  // Preserve externally owned domains on detach. Enabling these is idempotent.
  state.ready = Promise.all(['Runtime.enable', 'Network.enable', 'Page.enable'].map(m => command(state, m))).then(() => undefined)
  void state.ready.catch(() => { state.connected = false /* surfaced by execute; retry initialization next time */ })
}
function detach(wc: Electron.WebContents): void {
  const state = states.get(wc)
  if (!state) return
  states.delete(wc)
  wc.debugger.removeListener('message', state.message)
  wc.debugger.removeListener('detach', state.disconnected)
  wc.removeListener('destroyed', state.destroyed)
  wc.session.removeListener('will-download', state.download)
  state.contexts.clear(); state.contextOrigins.clear(); state.frameOrigins.clear(); state.reveal = {}
  for (const cleanup of state.cleanup) cleanup()
  if (state.owned && wc.debugger.isAttached()) wc.debugger.detach()
}
async function evaluate(state: State, expression: string, contextId?: number): Promise<any> {
  const result = await command(state, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true,
    ...(contextId === undefined ? {} : { contextId }) })
  if (result.exceptionDetails) throw new Error('Page evaluation failed (details withheld)')
  return result.result?.value
}
async function upload(state: State, a: RecordValue, context: BrowserExtrasContext): Promise<Entry> {
  const wc = state.wc
  const expected = origin(wc)
  const values = a.paths ?? a.files ?? (a.path ? [a.path] : undefined)
  if (!Array.isArray(values) || !values.length || values.length > 10) throw new Error('Upload requires 1..10 absolute file paths')
  const approved: ApprovedFile[] = []
  let total = 0
  for (const value of values) {
    const path = string(value, 'path')
    if (!isAbsolute(path)) throw new Error('Upload path must be absolute')
    const file = await fingerprint(path)
    total += file.size
    if (total > 50 * 1024 * 1024) throw new Error('Upload total size exceeds 50 MiB')
    approved.push(file)
  }
  const files = approved.map(file => file.path)
  const selector = a.selector === undefined ? undefined : string(a.selector, 'selector')
  const ref = a.ref === undefined ? undefined : string(a.ref, 'ref', 200)
  const by = a.by ?? a.locator?.type
  const locatorValue = a.locator?.value ?? a.value
  const locator = by === undefined ? undefined : { type: string(by, 'locator type', 40),
    value: string(locatorValue, 'locator value'), name: a.locator?.name ?? a.name, exact: a.locator?.exact ?? a.exact }
  if (locator && !['css', 'role', 'text', 'label', 'placeholder', 'testid'].includes(locator.type)) throw new Error('Invalid locator type')
  const snapshotId = a.snapshot_id ?? a.snapshotId
  if (snapshotId !== undefined) string(snapshotId, 'snapshot_id', 256)
  if (!selector && !ref && !locator) throw new Error('Upload requires selector, ref or locator')
  const frameId = a.frame_id ?? a.frameId
  let contextId: number | undefined
  if (frameId !== undefined) {
    if (typeof frameId === 'number') {
      const frame = wc.mainFrame.framesInSubtree.find(f => f.routingId === frameId)
      if (!frame) throw new Error('Frame default execution context is unavailable')
      // Bridge Electron routing IDs to CDP default worlds, including same-origin frames.
      const marker = `__synteeUpload_${Date.now()}_${Math.random().toString(36).slice(2)}`
      await frame.executeJavaScript(`window[${JSON.stringify(marker)}]=true`, false)
      try {
        for (const id of state.contexts.values()) {
          if (await evaluate(state, `window[${JSON.stringify(marker)}]===true`, id)) { contextId = id; break }
        }
      } finally { await frame.executeJavaScript(`delete window[${JSON.stringify(marker)}]`, false).catch(() => undefined) }
    } else contextId = state.contexts.get(string(frameId, 'frame_id', 200))
    if (contextId === undefined) throw new Error('Frame default execution context is unavailable')
  }
  await approve(context, wc, expected, 'Upload these exact local files?', { paths: files, totalBytes: total,
    selector, ref, locator, frameId })
  if (contextId !== undefined && ![...state.contexts.values()].includes(contextId)) throw new Error('Frame default execution context is unavailable')
  const expression = `(() => {
    const s=window.__synteeAutomation;const snapshot=${JSON.stringify(snapshotId ?? null)};
    if(snapshot!==null&&(!s||s.snapshot!==snapshot))throw Error('Stale snapshot');
    const selector=${JSON.stringify(selector ?? null)},ref=${JSON.stringify(ref ?? null)},locator=${JSON.stringify(locator ?? null)};
    // Keep naming/signatures aligned with pageAutomation's private PAGE resolver.
    // It exports no DOM resolver helper; importing inspect would lose hidden inputs.
    const norm=x=>String(x||'').replace(/\\s+/g,' ').trim();
    const name=e=>{
      const ids=e.getAttribute('aria-labelledby');
      if(ids){const root=e.getRootNode();const text=ids.split(/\\s+/).map(id=>root.getElementById?.(id)?.textContent||document.getElementById(id)?.textContent||'').join(' ');if(norm(text))return norm(text)}
      return norm(e.getAttribute('aria-label')||Array.from(e.labels||[]).map(l=>l.textContent).join(' ')||e.getAttribute('placeholder')||(e.tagName==='IMG'?e.getAttribute('alt'):'')||(e.tagName==='INPUT'&&['button','submit','reset'].includes(e.type)?e.value:'')||e.textContent)
    };
    const role=e=>e.getAttribute('role')||({BUTTON:'button',A:e.hasAttribute('href')?'link':'generic',INPUT:({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',range:'slider',number:'spinbutton'}[e.type]||'textbox'),TEXTAREA:'textbox',SELECT:e.multiple?'listbox':'combobox',OPTION:'option',IMG:'img',H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading',LI:'listitem',UL:'list',OL:'list',TABLE:'table',SUMMARY:'button'}[e.tagName]||(e.isContentEditable?'textbox':null));
    const signature=e=>e.tagName+'|'+(e.id||'')+'|'+name(e)+'|'+(e.getAttribute('href')||'');
    if(ref){const entry=s?.refs?.get(ref);const e=entry?.el;
      if(!e?.isConnected||signature(e)!==entry.signature)return null;return e}
    const elements=[];const traverse=root=>{for(const e of root.children||[]){if(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(e.tagName))continue;elements.push(e);traverse(e);if(e.shadowRoot)traverse(e.shadowRoot)}};
    traverse(document);
    const match=(a,b)=>locator.exact?norm(a)===norm(b):norm(a).toLowerCase().includes(norm(b).toLowerCase());
    let matches=elements.filter(e=>{
      if(selector)return e.matches(selector);
      if(locator.type==='css')return e.matches(locator.value);
      if(locator.type==='testid')return e.getAttribute('data-testid')===locator.value;
      if(locator.type==='label')return Array.from(e.labels||[]).some(l=>match(l.textContent,locator.value));
      if(locator.type==='placeholder')return e.hasAttribute('placeholder')&&match(e.getAttribute('placeholder'),locator.value);
      if(locator.type==='text')return match(e.textContent,locator.value);
      return role(e)===locator.value&&(!locator.name||match(name(e),locator.name))
    });
    if(locator?.type==='text')matches=matches.filter(e=>!matches.some(c=>c!==e&&e.contains(c)));
    return matches.length===1?matches[0]:null
  })()`
  const resolved = await command(state, 'Runtime.evaluate', { expression, returnByValue: false,
    ...(contextId === undefined ? {} : { contextId }) })
  const objectId = resolved.result?.objectId
  if (resolved.exceptionDetails || !objectId) throw new Error('File input target not found; take a fresh snapshot')
  try {
    const inspected = await command(state, 'Runtime.callFunctionOn', { objectId, returnByValue: true,
      functionDeclaration: 'function(){return {valid:this.isConnected&&this.tagName==="INPUT"&&this.type==="file",multiple:this.multiple}}' })
    if (!inspected.result?.value?.valid || (files.length > 1 && !inspected.result.value.multiple)) throw new Error('Target must be a connected file input supporting the requested file count')
    check(context, wc, expected)
    let verifiedBytes = 0
    for (const file of approved) {
      if (!await sameFile(file)) throw new Error('Upload file changed during confirmation; retry')
      verifiedBytes += file.size
    }
    if (verifiedBytes !== total || verifiedBytes > 50 * 1024 * 1024) throw new Error('Upload total size changed during confirmation; retry')
    check(context, wc, expected)
    if (contextId !== undefined && ![...state.contexts.values()].includes(contextId)) throw new Error('Frame default execution context is unavailable')
    const finalTarget = await command(state, 'Runtime.callFunctionOn', { objectId, returnByValue: true,
      arguments: [{ value: snapshotId ?? null }],
      functionDeclaration: `function(snapshot){return {valid:this.isConnected&&this.ownerDocument===document&&this.tagName==='INPUT'&&this.type==='file'&&(snapshot===null||window.__synteeAutomation?.snapshot===snapshot),multiple:this.multiple}}` })
    if (!finalTarget.result?.value?.valid || (files.length > 1 && !finalTarget.result.value.multiple)) throw new Error('Target must remain a connected file input in the requested snapshot')
    check(context, wc, expected)
    await command(state, 'DOM.setFileInputFiles', { files, objectId })
    return { uploaded: files.length, totalBytes: total }
  } finally { await command(state, 'Runtime.releaseObject', { objectId }).catch(() => undefined) }
}
async function cookies(state: State, a: RecordValue, context: BrowserExtrasContext): Promise<unknown> {
  const wc = state.wc
  const expected = origin(wc)
  const requested = a.operation ?? a.command ?? 'list'
  const op = requested === 'remove' ? 'delete' : requested
  if (!['list', 'get', 'set', 'delete', 'clear'].includes(op)) throw new Error('Unknown cookies operation')
  const reveal = a.reveal === true
  await approve(context, wc, expected, reveal ? 'Reveal current-origin cookie values?' : `Allow current-origin cookies ${op}?`, { operation: op, reveal })
  const url = `${expected}/`
  if (op === 'set') {
    const name = string(a.name, 'cookie name', 256)
    const value = string(a.value, 'cookie value', 4096)
    const path = a.path === undefined ? '/' : string(a.path, 'cookie path', 1024)
    if (!path.startsWith('/') || /[;\r\n]/.test(path)) throw new Error('Invalid cookie path')
    const sameSite = a.same_site ?? a.sameSite ?? 'lax'
    if (!['unspecified', 'no_restriction', 'lax', 'strict'].includes(sameSite)) throw new Error('Invalid same_site')
    // Host-only: user cannot supply a sibling/parent domain or alternate URL.
    check(context, wc, expected)
    await wc.session.cookies.set({ url, name, value, path, secure: expected.startsWith('https:'),
      httpOnly: a.http_only === true, sameSite,
      ...(a.expiration_date === undefined ? {} : { expirationDate: integer(a.expiration_date, 0, 1, 8_640_000_000_000) }) })
    return { set: true }
  }
  const host = new URL(expected).hostname
  const all = await wc.session.cookies.get({ domain: host })
  // Never reveal/delete parent-domain cookies shared with other origins.
  const matching = all.filter(c => c.hostOnly && c.domain === host && (!c.secure || expected.startsWith('https:')))
  check(context, wc, expected)
  const selected = a.name === undefined ? matching : matching.filter(c => c.name === string(a.name, 'cookie name', 256))
  if (op === 'delete' || op === 'clear') {
    if (op === 'delete' && a.name === undefined) throw new Error('Cookie delete requires name')
    const targets = op === 'clear' ? matching : selected
    for (const c of targets) {
      check(context, wc, expected)
      await wc.session.cookies.remove(`${expected}${c.path || '/'}`, c.name)
    }
    return { deleted: targets.length, scope: 'host-only cookies; parent-domain cookies preserved' }
  }
  return selected.slice(0, LIMIT).map(c => ({ name: c.name, value: reveal ? c.value : '[masked]', path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate }))
}
async function storage(state: State, a: RecordValue, context: BrowserExtrasContext): Promise<unknown> {
  const wc = state.wc
  const expected = origin(wc)
  const area = a.area ?? a.storage_type ?? 'local'
  if (!['local', 'session'].includes(area)) throw new Error('Storage area must be local or session')
  const op = a.operation ?? a.command ?? 'list'
  if (!['list', 'get', 'set', 'remove', 'clear'].includes(op)) throw new Error('Unknown storage operation')
  const reveal = a.reveal === true
  const key = ['get', 'set', 'remove'].includes(op) ? string(a.key, 'storage key') : undefined
  const value = op === 'set' ? string(a.value, 'storage value', 65536) : undefined
  await approve(context, wc, expected, `Allow ${area} storage ${op}${reveal ? ' with value reveal' : ''}?`,
    { operation: op, area, reveal, key: key ? '[specified key]' : undefined })
  // Origin guard is inside the same evaluation as the storage operation.
  check(context, wc, expected)
  return evaluate(state, `(() => {if(location.origin!==${JSON.stringify(expected)})throw Error('Origin changed');
    const s=${area === 'local' ? 'localStorage' : 'sessionStorage'}; const k=${JSON.stringify(key ?? '')};
    const op=${JSON.stringify(op)};const reveal=${reveal};
    if(op==='set'){s.setItem(k,${JSON.stringify(value ?? '')});return {set:true}}
    if(op==='remove'){s.removeItem(k);return {removed:true}}
    if(op==='clear'){s.clear();return {cleared:true}}
    if(op==='get'){const v=s.getItem(k);return {exists:v!==null,value:v===null?null:reveal?v.slice(0,65536):'[masked]'}}
    return {total:s.length,entries:Array.from({length:Math.min(s.length,300)},(_,i)=>{const key=s.key(i);return {key:reveal?key:'[masked key]',value:reveal?(s.getItem(key)||'').slice(0,2048):'[masked]'}})}
  })()`)
}
async function execute(wc: Electron.WebContents, p: BrowserOpPayload, context: BrowserExtrasContext): Promise<BrowserOpResult | undefined> {
  if (!actions.has(p.action)) return undefined
  try {
    check(context, wc)
    attach(wc)
    const state = states.get(wc)!
    await state.ready
    check(context, wc)
    // Parent-owned identity fields always win over args aliases; args cannot retarget a tab/frame/snapshot.
    const a: RecordValue = { ...p.args, ...p }
    const identity: Array<[string, string]> = [['tabId', 'tab_id'], ['frameId', 'frame_id'],
      ['snapshotId', 'snapshot_id'], ['ref', 'ref'], ['selector', 'selector']]
    for (const [canonical, snake] of identity) {
      const top = p[canonical] ?? p[snake]
      if (top !== undefined) { a[canonical] = top; if (snake !== canonical) a[snake] = top }
    }
    const op = a.operation ?? a.command ?? (p.action === 'dialog' ? p.args?.action : undefined) ?? 'list'
    if (!state.connected || !wc.debugger.isAttached()) throw new Error('Local debugger disconnected')
    let result: unknown
    if (['console', 'network', 'errors', 'downloads'].includes(p.action)) {
      const kind = p.action as 'console' | 'network' | 'errors' | 'downloads'
      const list = state[kind]
      if (kind !== 'downloads' && a.reveal === true) {
        const expected = origin(wc)
        await approve(context, wc, expected, `Enable sanitized detailed ${kind} capture for future events?`,
          { capacity: LIMIT, messageLimit: 2048, stackFrames: 8, scope: 'this tab and origin until disabled or debugger disconnect' })
        if (!state.connected || !wc.debugger.isAttached()) throw new Error('Local debugger disconnected')
        state.reveal[kind] = expected
      } else if (kind !== 'downloads' && a.reveal === false) delete state.reveal[kind]
      if (op === 'clear') { list.length = 0; result = { cleared: true } }
      else if (op === 'list') {
        result = { events: list.slice(-integer(a.limit, LIMIT, 1, LIMIT)), capacity: LIMIT,
          capture: kind !== 'downloads' && state.reveal[kind] ? 'sanitized details for future events' : 'metadata',
          cleared: a.clear === true }
        if (a.clear === true) list.length = 0
      } else throw new Error('Operation must be list or clear')
    } else if (p.action === 'dialog') {
      if (op === 'list') result = { dialogs: state.dialogs.slice(), current: state.currentDialog ?? null }
      else if (op === 'clear') { state.dialogs.length = 0; result = { cleared: true } }
      else if (op === 'accept' || op === 'dismiss') {
        if (!state.currentDialog) throw new Error('No current JavaScript dialog')
        const expected = origin(wc)
        const current = state.currentDialog
        await approve(context, wc, expected, `${op} the current JavaScript dialog?`, { type: current.type })
        if (state.currentDialog !== current) throw new Error('Dialog changed during confirmation')
        await command(state, 'Page.handleJavaScriptDialog', { accept: op === 'accept',
          ...(op === 'accept' && (a.prompt_text ?? a.text) !== undefined ? { promptText: string(a.prompt_text ?? a.text, 'prompt_text') } : {}) })
        result = { handled: true }
      } else throw new Error('Dialog operation must be list, clear, accept or dismiss')
    } else if (p.action === 'upload') result = await upload(state, a, context)
    else if (p.action === 'cookies') result = await cookies(state, a, context)
    else if (p.action === 'storage') result = await storage(state, a, context)
    else if (p.action === 'set_user_agent') {
      const ua = string(a.user_agent ?? a.value, 'user_agent', 1024)
      if (!ua || /[\r\n]/.test(ua)) throw new Error('Invalid user agent')
      check(context, wc)
      wc.setUserAgent(ua)
      result = { changed: true, reloadRequired: true }
    } else if (p.action === 'zoom') {
      if (a.factor !== undefined || a.value !== undefined) {
        const factor = Number(a.factor ?? a.value)
        if (!Number.isFinite(factor) || factor < 0.25 || factor > 5) throw new Error('Zoom factor must be 0.25..5')
        check(context, wc)
        wc.setZoomFactor(factor)
      }
      result = { factor: wc.getZoomFactor(), viewport: 'Electron browser panel controls actual size; zoom does not emulate a viewport' }
    } else if (p.action === 'trace_start') {
      if (state.trace) throw new Error('Trace already active')
      check(context, wc)
      state.trace = { started: Date.now(), events: [], dropped: 0 }
      result = { started: true, capacity: LIMIT, format: 'bounded CDP event metadata; not HAR or Playwright tracing' }
    } else if (p.action === 'trace_stop') {
      if (!state.trace) throw new Error('No active trace')
      const trace = state.trace
      state.trace = undefined
      const counts: Record<string, number> = {}
      for (const event of trace.events) counts[String(event.method)] = (counts[String(event.method)] || 0) + 1
      result = { durationMs: Date.now() - trace.started, retained: trace.events.length, dropped: trace.dropped, counts,
        format: 'CDP metadata summary (no bodies, values, URLs or HAR)' }
    } else if (p.action === 'accessibility') {
      const frameId = p.args?.cdp_frame_id === undefined ? undefined : string(p.args.cdp_frame_id, 'cdp_frame_id', 200)
      if (frameId === '') throw new Error('Invalid cdp_frame_id')
      const maxNodes = integer(p.args?.max_nodes, 1200, 0, 1200)
      check(context, wc)
      // attach/ready above own the lifecycle; the helper uses this existing local pipe.
      result = await captureAccessibility(wc, { frameId, maxNodes }, context.signal)
    } else if (p.action === 'performance') {
      check(context, wc)
      await command(state, 'Performance.enable')
      check(context, wc)
      const metrics = await command(state, 'Performance.getMetrics')
      result = { metrics: metrics.metrics, note: 'CDP runtime metrics, not a Lighthouse audit' }
    } else if (p.action === 'permissions') {
      const rawName = a.name ?? a.permission
      const supportedPermissions = ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read', 'clipboard-write']
      if (rawName === undefined) {
        if (op !== 'list') throw new Error('Permission name is required for query or request')
        result = { permissions: supportedPermissions, scope: 'current origin; existing Electron handlers own requests' }
      } else {
      const name = string(rawName, 'permission', 100)
      if (!supportedPermissions.includes(name)) throw new Error('Unsupported permission name')
      const permissionOp = op === 'list' ? 'query' : op
      if (!['query', 'request'].includes(permissionOp)) throw new Error('Operation must be query or request')
      if (permissionOp === 'request' && name.startsWith('clipboard-')) throw new Error('Unsupported permission request; clipboard requires interactive user gesture')
      const expected = origin(wc)
      await approve(context, wc, expected, `${permissionOp === 'request' ? 'Request' : 'Query'} current-origin permission?`, { permission: name })
      const request = name === 'notifications'
        ? 'return {state:await Notification.requestPermission()}'
        : name === 'geolocation'
          ? 'return new Promise(resolve=>navigator.geolocation.getCurrentPosition(()=>resolve({state:"granted"}),()=>resolve({state:"unavailable"}),{timeout:10000,maximumAge:0}))'
          : `const stream=await navigator.mediaDevices.getUserMedia(${JSON.stringify(name === 'camera' ? { video: true } : { audio: true })});stream.getTracks().forEach(t=>t.stop());return {state:'granted'}`
      result = await evaluate(state, `(async()=>{if(location.origin!==${JSON.stringify(expected)})throw Error('Origin changed');${permissionOp === 'request' ? request : `const p=await navigator.permissions.query({name:${JSON.stringify(name)}});return {name:${JSON.stringify(name)},state:p.state}`}})()`)
      // Existing Electron permission handlers remain authoritative; no session-wide grant.
      }
    } else if (p.action === 'clear_cache') {
      const expected = origin(wc)
      await approve(context, wc, expected, 'Clear Cache Storage for the current origin?', { scope: 'Cache Storage only; shared HTTP disk cache is preserved' })
      check(context, wc, expected)
      await command(state, 'Storage.clearDataForOrigin', { origin: expected, storageTypes: 'cache_storage' })
      result = { cleared: true, scope: 'current-origin Cache Storage only; not shared HTTP disk cache' }
    }
    check(context, wc)
    return { success: true, output: JSON.stringify(result) }
  } catch (error) {
    // Never echo raw CDP/OS errors, which can contain paths, cookie values or page text.
    const message = error instanceof Error ? error.message : ''
    const safe = /^(Browser operation aborted|Tab destroyed|Origin changed|User declined|Requires a current|Expected integer|Invalid |Unknown |Operation must|Upload requires|Upload path|Upload total|File input target|Frame default|Target must|Cookie delete|Storage area|Dialog operation|No current|Dialog changed|Zoom factor|Trace already|No active trace|Unsupported permission|Only permission|Local debugger|Page evaluation)/.test(message)
    return { success: false, error: safe ? message : 'Browser extras operation failed (sensitive details withheld)' }
  }
}

export const BrowserExtras = { attach, detach, execute }
