/**
 * HTTP client for Syntee-Gateway user-facing API.
 *
 * Wraps fetch with JWT bearer auth and transparent refresh-on-401. Used only
 * from the main process — the renderer talks to the gateway via IPC, so CSP
 * stays locked down and tokens never cross the preload boundary.
 *
 * Base URL comes from the SYNTEE_API_URL env var (set by run-debug.bat /
 * run-prod.bat) and falls back to the local dev backend.
 */
import { getAccessToken, getRefreshToken, setTokens, clearTokens } from './tokenStore'

const GATEWAY_API_URL = (process.env.SYNTEE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')

export interface GatewayUser {
  id: string
  email: string
  username?: string | null
  username_is_auto?: boolean
  role: string
  display_name?: string | null
  avatar_url?: string | null
}

export interface GatewayApiKey {
  id: string
  name: string
  key_prefix: string
  is_active: boolean
  rpm_limit: number | null
  tpm_limit: number | null
  last_used_at: string | null
  created_at: string
}

export interface GatewayApiKeyCreated extends GatewayApiKey {
  raw_key: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
}

export class GatewayAuthError extends Error {
  constructor(message: string, public statusCode: number = 401) {
    super(message)
    this.name = 'GatewayAuthError'
  }
}

/**
 * Проверяет, протух ли access JWT (с запасом 30 сек на clock skew).
 * Декодирует payload без верификации подписи — нам нужен только exp.
 * Не-JWT / битый токен / нет exp → считаем ВАЛИДНЫМ (false), чтобы не
 * ломать нестандартные токены; 401-ретрай в вызывающих путях всё равно
 * подстрахует, если токен на самом деле протух.
 */
export function isAccessTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as { exp?: number }
    if (typeof payload.exp !== 'number') return false
    return payload.exp * 1000 <= Date.now() + 30_000
  } catch {
    return false
  }
}

let refreshPromise: Promise<string | null> | null = null

async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    const refresh = getRefreshToken()
    if (!refresh) return null
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      let res: Response
      try {
        res = await fetch(`${GATEWAY_API_URL}/api/user/auth/refresh?refresh=${encodeURIComponent(refresh)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) return null
      const data = (await res.json()) as TokenResponse
      setTokens(data.access_token, data.refresh_token)
      return data.access_token
    } catch {
      return null
    } finally {
      refreshPromise = null
    }
  })()
  return refreshPromise
}

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  /** Skip auth header (for login/exchange endpoints). */
  noAuth?: boolean
  /** Response type — 'json' parses, 'bytes' returns ArrayBuffer. */
  responseType?: 'json' | 'bytes' | 'text'
  /** Timeout in ms (default 15000). */
  timeoutMs?: number
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {  const { method = 'GET', body, headers = {}, noAuth = false, responseType = 'json', timeoutMs = 15000 } = opts

  const makeHeaders = (token: string | null): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...headers }
    if (!noAuth && token) h.Authorization = `Bearer ${token}`
    return h
  }

  const token = noAuth ? null : getAccessToken()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const init: RequestInit = {
    method,
    headers: makeHeaders(token),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: controller.signal,
  }

  let res: Response
  try {
    res = await fetch(`${GATEWAY_API_URL}${path}`, init)
  } finally {
    clearTimeout(timer)
  }

  // Auto-refresh on 401 (only for authenticated requests)
  if (res.status === 401 && !noAuth) {
    const newToken = await refreshAccessToken()
    if (newToken) {
      const controller2 = new AbortController()
      const timer2 = setTimeout(() => controller2.abort(), timeoutMs)
      try {
        init.headers = makeHeaders(newToken)
        res = await fetch(`${GATEWAY_API_URL}${path}`, { ...init, signal: controller2.signal })
      } finally {
        clearTimeout(timer2)
      }
    } else {
      clearTokens()
      throw new GatewayAuthError('Session expired')
    }
  }

  if (res.status === 401) {
    throw new GatewayAuthError('Unauthorized', 401)
  }
  if (res.status === 403) {
    throw new GatewayAuthError('Forbidden', 403)
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const errBody = (await res.json()) as { detail?: string; error?: { message?: string } }
      detail = errBody.detail ?? errBody.error?.message ?? detail
    } catch {
      /* keep default */
    }
    throw new Error(detail)
  }

  if (responseType === 'bytes') return (await res.arrayBuffer()) as unknown as T
  if (responseType === 'text') return (await res.text()) as unknown as T
  return (await res.json()) as T
}

// ── Public API ──────────────────────────────────────────────────────────

export function getGatewayApiUrl(): string {
  return GATEWAY_API_URL
}

export function getGatewayWebUrl(): string {
  return (process.env.SYNTEE_WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

export async function exchangeDesktopCode(code: string): Promise<TokenResponse> {
  return request<TokenResponse>('/api/user/auth/desktop/exchange', {
    method: 'POST',
    body: { code },
    noAuth: true,
  })
}

export async function getMe(): Promise<GatewayUser> {
  return request<GatewayUser>('/api/user/auth/me')
}

export async function updateProfile(payload: {
  display_name?: string | null
  avatar_url?: string | null
  username?: string
}): Promise<GatewayUser> {
  return request<GatewayUser>('/api/user/auth/me', { method: 'PATCH', body: payload })
}

export interface CheckUsernameResponse {
  available: boolean
  reason: string | null
}

export async function checkUsername(username: string): Promise<CheckUsernameResponse> {
  return request<CheckUsernameResponse>(
    `/api/user/auth/check-username?username=${encodeURIComponent(username)}`,
  )
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request('/api/user/auth/change-password', {
    method: 'POST',
    body: { current_password: currentPassword, new_password: newPassword },
  })
}

export async function listApiKeys(): Promise<GatewayApiKey[]> {
  return request<GatewayApiKey[]>('/api/user/apikeys')
}

export async function createApiKey(name: string): Promise<GatewayApiKeyCreated> {
  return request<GatewayApiKeyCreated>('/api/user/apikeys', { method: 'POST', body: { name } })
}

export async function deleteApiKey(keyId: string): Promise<void> {
  await request(`/api/user/apikeys/${keyId}`, { method: 'DELETE' })
}

/**
 * Принудительный refresh access-токена (для 401-ретраев в LLM/fetch-путях).
 * Singleton refreshPromise внутри сливает параллельные вызовы в один запрос.
 */
export async function forceRefreshGatewayToken(): Promise<string | null> {
  return refreshAccessToken()
}

/**
 * Returns the JWT to attach to /v1/* gateway requests (chat completions etc).
 * Auto-refreshes if the access token is missing or expired.
 */
export async function getGatewayAuthToken(): Promise<string | null> {
  let token = getAccessToken()
  if (!token || isAccessTokenExpired(token)) {
    token = await refreshAccessToken()
  }
  return token
}
