/**
 * Messenger WebSocket client — lives in the main process.
 *
 * The renderer is CSP-locked and JWTs never cross the preload boundary, so the
 * WS connection must be owned by main. Inbound envelopes are bridged to the
 * renderer via `messenger:event` IPC channel; outbound envelopes (dm.send,
 * dm.read, dm.typing, dm.reaction, dm.delete) are sent through the same socket.
 *
 * Reconnect: exponential backoff (1s → 30s) with jitter. On 4401 close code
 * (auth failure) we attempt a token refresh before reconnecting.
 */
import { BrowserWindow, Notification } from 'electron'
import WebSocket from 'ws'
import { getGatewayApiUrl } from './gatewayClient'
import { getAccessToken, getRefreshToken, setTokens } from './tokenStore'

type Envelope = { type: string; data: Record<string, unknown> }

let socket: WebSocket | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let attempt = 0
let intentionallyClosed = false
let getWindow: (() => BrowserWindow | null) | null = null
let activeConversationId: string | null = null

const HEARTBEAT_MS = 25_000

function wsUrl(): string {
  const base = getGatewayApiUrl()
  const wsBase = base.replace(/^http/, 'ws')
  return wsBase
}

function broadcast(envelope: Envelope): void {
  const win = getWindow?.() ?? null
  if (win && !win.isDestroyed()) {
    win.webContents.send('messenger:event', envelope)
  }
}

function shouldNotifyForMessage(envelope: Envelope): boolean {
  if (envelope.type === 'dm.message') {
    const convId = String(envelope.data.conversation_id ?? '')
    if (convId && convId === activeConversationId) return false
  }
  if (envelope.type === 'global.message') {
    if (activeConversationId === '__global__') return false
  }
  const win = getWindow?.() ?? null
  if (!win || win.isDestroyed()) return true
  return !win.isFocused() || !win.isVisible()
}

function maybeNotify(envelope: Envelope): void {
  if (envelope.type !== 'dm.message' && envelope.type !== 'global.message') return
  if (!shouldNotifyForMessage(envelope)) return
  const data = envelope.data
  const body = typeof data.body === 'string' ? data.body : (data.attachment_filename ? `📎 ${data.attachment_filename}` : 'Новое сообщение')
  const senderName = typeof data.sender?.display_name === 'string' && data.sender.display_name
    ? data.sender.display_name
    : typeof data.sender?.email === 'string'
      ? data.sender.email
      : 'Новое сообщение'
  const title = envelope.type === 'global.message' ? `Общий чат — ${senderName}` : senderName

  // ── Overlay-уведомление (iOS-style droplet) ──
  // Заменяет нативные Windows notifications для красивого UI.
  try {
    const { getNotificationManager } = require('../managers/NotificationManager')
    const nm = getNotificationManager()
    if (nm) {
      nm.push({
        type: 'messenger',
        title,
        body: body.length > 120 ? body.slice(0, 117) + '…' : body,
        priority: 'info',
        actions: [{ id: 'open', label: 'Открыть' }],
      })
      return
    }
  } catch { /* fallthrough to native */ }

  // Fallback: нативные Windows notifications (если overlay недоступен)
  const notif = new Notification({
    title,
    body: body.length > 120 ? body.slice(0, 117) + '…' : body,
    silent: false,
  })
  notif.on('click', () => {
    const win = getWindow?.() ?? null
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
  notif.show()
}

export function setActiveConversation(id: string | null): void {
  activeConversationId = id
}

function clearTimers(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
}

function scheduleReconnect(): void {
  if (intentionallyClosed) return
  if (reconnectTimer) return
  attempt += 1
  const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random() * 0.5)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connectMessenger()
  }, delay)
}

async function refreshFirst(): Promise<string | null> {
  const refresh = getRefreshToken()
  if (!refresh) return null
  try {
    const base = getGatewayApiUrl()
    const res = await fetch(
      `${base}/api/user/auth/refresh?refresh=${encodeURIComponent(refresh)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { access_token: string; refresh_token: string }
    setTokens(data.access_token, data.refresh_token)
    return data.access_token
  } catch {
    return null
  }
}

export function setMessengerWindowGetter(getter: () => BrowserWindow | null): void {
  getWindow = getter
}

export function connectMessenger(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return
  }
  intentionallyClosed = false
  const token = getAccessToken()
  if (!token) {
    // No token yet — try refresh; if that fails, give up (caller reconnects on login).
    void refreshFirst().then((t) => {
      if (t) connectMessenger()
    })
    return
  }

  const url = `${wsUrl()}/api/user/ws?token=${encodeURIComponent(token)}`
  try {
    socket = new WebSocket(url)
  } catch (err) {
    console.error('[messenger-ws] create failed', err)
    scheduleReconnect()
    return
  }

  socket.on('open', () => {
    attempt = 0
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping', data: {} }))
      }
    }, HEARTBEAT_MS)
    broadcast({ type: 'ws:open', data: {} })
  })

  socket.on('message', (raw: WebSocket.RawData) => {
    try {
      const envelope = JSON.parse(raw.toString()) as Envelope
      maybeNotify(envelope)
      broadcast(envelope)
    } catch { /* ignore malformed */ }
  })

  socket.on('close', (code: number) => {
    clearTimers()
    socket = null
    broadcast({ type: 'ws:close', data: { code } })
    if (intentionallyClosed) return
    if (code === 4401) {
      // Auth failure — try refresh then reconnect.
      void refreshFirst().then((t) => {
        if (t) setTimeout(() => void connectMessenger(), 500)
        else scheduleReconnect()
      })
    } else {
      scheduleReconnect()
    }
  })

  socket.on('error', (err: Error) => {
    console.warn('[messenger-ws] error', err.message)
    // 'close' will follow and schedule reconnect.
  })
}

export function disconnectMessenger(): void {
  intentionallyClosed = true
  clearTimers()
  if (socket) {
    try { socket.close(1000, 'client disconnect') } catch { /* ignore */ }
    socket = null
  }
}

export function sendMessengerEnvelope(envelope: Envelope): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(envelope))
  }
}
