import type { Worker } from 'worker_threads'

// Pure transport helpers: no Electron imports or permission decisions here.
export function browserOperationTimeout(payload: Record<string, unknown>): number {
  const args = payload.args as Record<string, unknown> | undefined
  const requested = payload.timeoutMs ?? args?.timeoutMs ?? args?.timeout_ms
  // Confirmation can take 90s BEFORE the operation starts. Schema defaults
  // (e.g. 10s) must not shorten that window. Be conservative for interactions
  // and wait_for (function conditions may execute arbitrary page code).
  const confirmationActions = new Set([
    'request_access', 'evaluate', 'add_script', 'add_style', 'click', 'type', 'fill', 'navigate', 'tab_new',
    'console', 'errors', 'network',
    'press_key', 'double_click', 'right_click', 'select_option', 'check', 'uncheck',
    'upload', 'file_upload', 'set_input_files', 'dialog', 'handle_dialog',
    'permissions', 'set_permissions', 'grant_permissions', 'clear_permissions',
    'clear_cache', 'cookies', 'storage', 'wait_for',
  ])
  // Explicit caller deadlines must be respected, including confirmation time.
  if (typeof requested === 'number' && Number.isFinite(requested)) {
    return Math.min(120_000, Math.max(100, requested))
  }
  return confirmationActions.has(String(payload.action)) ? 120_000 : 30_000
}

type BrowserResult = { success: boolean; error?: string; enabled?: boolean; output?: string; imageBase64?: string }

/** One-shot worker request, using the worker's existing shared reply-id map. */
export function requestBrowserOperation(
  payload: Record<string, unknown>,
  replyHandlers: Map<string, (reply: Record<string, unknown>) => void>,
  send: (message: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<BrowserResult> {
  return new Promise(resolve => {
    const replyId = `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let settled = false
    const finish = (result: BrowserResult, cancel = false) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      replyHandlers.delete(replyId)
      if (cancel) {
        try { send({ type: 'browser_op_cancel', replyId }) } catch { /* main already gone */ }
      }
      resolve(result)
    }
    const abort = () => finish({ success: false, error: 'Browser operation aborted.' }, true)
    const timeoutMs = browserOperationTimeout(payload)
    const timer = setTimeout(() => finish({ success: false, error: `Browser broker timed out after ${timeoutMs}ms.` }, true), timeoutMs + 5_000)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    replyHandlers.set(replyId, reply => finish((reply.result as BrowserResult | undefined)
      ?? { success: false, error: 'Browser backend returned no result.' }))
    try { send({ type: 'browser_op', replyId, payload: { ...payload, timeoutMs } }) }
    catch (e) { finish({ success: false, error: e instanceof Error ? e.message : String(e) }, true) }
  })
}

const brokers = new WeakMap<Worker, () => void>()

/** Stop synchronously, before terminate() can race a pending backend reply. */
export function disposeBrowserWorkerBroker(worker: Worker | undefined): void {
  if (worker) brokers.get(worker)?.()
}

/** One scoped listener/controller registry per worker, shared by chat and sub-agents. */
export function attachBrowserWorkerBroker(
  worker: Worker,
  execute: (payload: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
): () => void {
  disposeBrowserWorkerBroker(worker)
  const pending = new Map<string, AbortController>()
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    worker.off('message', onMessage)
    worker.off('error', dispose)
    worker.off('exit', dispose)
    brokers.delete(worker)
    for (const controller of pending.values()) controller.abort()
    pending.clear()
  }
  const onMessage = (message: Record<string, unknown>) => {
    if (disposed || typeof message.replyId !== 'string') return
    const replyId = message.replyId
    if (message.type === 'browser_op_cancel') {
      const controller = pending.get(replyId)
      pending.delete(replyId)
      controller?.abort()
      return
    }
    if (message.type !== 'browser_op' || pending.has(replyId)) return
    const controller = new AbortController()
    pending.set(replyId, controller)
    const raw = message.payload
    const payload = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const timeoutMs = browserOperationTimeout(payload)
    const abort = () => {
      clearTimeout(timer)
      if (pending.get(replyId) === controller) pending.delete(replyId)
    }
    // Main safety net also bounds requests if the worker becomes unresponsive.
    const timer = setTimeout(() => controller.abort(), timeoutMs + 5_000)
    controller.signal.addEventListener('abort', abort, { once: true })
    const reply = (result: unknown) => {
      if (disposed || controller.signal.aborted || pending.get(replyId) !== controller) return
      try { worker.postMessage({ type: 'browser_op_reply', replyId, result }) }
      catch { dispose() }
    }
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return undefined
      return execute({ ...payload, timeoutMs }, controller.signal)
    }).then(reply, error => reply({ success: false, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
        if (pending.get(replyId) === controller) pending.delete(replyId)
      })
  }
  brokers.set(worker, dispose)
  worker.on('message', onMessage)
  worker.once('error', dispose)
  worker.once('exit', dispose)
  return dispose
}
