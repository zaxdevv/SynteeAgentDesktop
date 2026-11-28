/**
 * HTTP client for Syntee-Gateway user-facing API.
 *
 * Wraps fetch with JWT bearer auth and transparent refresh-on-401. Used only
 * from the main process — the renderer talks to the gateway via IPC, so CSP
 * stays locked down and tokens never cross the preload boundary.
 *
 * Base URL comes from the SYNTEE_API_URL env var (set by run-debug.bat /
 * run-prod.bat) and falls back to the hosted Syntee Gateway.
 */
import Store from 'electron-store'
import { getAccessToken, getRefreshToken, setTokens, clearTokens } from './tokenStore'
import { CLIENT_IDENTITY_HEADERS } from '../../shared/constants'
import type { ModelParams } from '../../shared/types'

const DEFAULT_GATEWAY_URL = 'https://syntee.fun'
const GATEWAY_API_URL = (process.env.SYNTEE_API_URL || DEFAULT_GATEWAY_URL).replace(/\/$/, '')

const store = new Store()

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

type RefreshResult =
  | { kind: 'success'; token: string }
  | { kind: 'invalid'; statusCode: number }
  | { kind: 'unavailable'; error: unknown }

let refreshPromise: Promise<RefreshResult> | null = null

/**
 * Обновляет access-токен, не смешивая окончательную потерю сессии
 * с временной недоступностью gateway.
 *
 * Важно: сеть/timeout/5xx НЕ очищают refresh-токен. Иначе краткий обрыв
 * интернета при запуске превращался в принудительный logout.
 */
async function refreshAccessToken(): Promise<RefreshResult> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    const refresh = getRefreshToken()
    if (!refresh) return { kind: 'invalid', statusCode: 401 } as const
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      let res: Response
      try {
        // Refresh-токен передаётся в JSON body, а НЕ в query-параметре.
        res = await fetch(`${GATEWAY_API_URL}/api/user/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh }),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (res.status === 401 || res.status === 403) {
        return { kind: 'invalid', statusCode: res.status } as const
      }
      if (!res.ok) {
        return { kind: 'unavailable', error: new Error(`Refresh HTTP ${res.status}`) } as const
      }
      const data = (await res.json()) as TokenResponse
      if (!data.access_token || !data.refresh_token) {
        return { kind: 'unavailable', error: new Error('Invalid refresh response') } as const
      }
      setTokens(data.access_token, data.refresh_token)
      return { kind: 'success', token: data.access_token } as const
    } catch (error) {
      return { kind: 'unavailable', error } as const
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
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    ...CLIENT_IDENTITY_HEADERS,
    ...headers
  }

  const params = store.get('modelParams') as ModelParams | undefined
  if (params?.anonymousUserAgent) {
    delete h['User-Agent']
    delete h['X-Client-Name']
    delete h['X-Client-Version']
  }

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

  // Auto-refresh on 401 (only for authenticated requests).
  // Только однозначный 401/403 refresh-токена означает logout; сеть и 5xx
  // должны оставить сохранённую сессию нетронутой.
  if (res.status === 401 && !noAuth) {
    const refreshResult = await refreshAccessToken()
    if (refreshResult.kind === 'success') {
      const controller2 = new AbortController()
      const timer2 = setTimeout(() => controller2.abort(), timeoutMs)
      try {
        init.headers = makeHeaders(refreshResult.token)
        res = await fetch(`${GATEWAY_API_URL}${path}`, { ...init, signal: controller2.signal })
      } finally {
        clearTimeout(timer2)
      }
    } else if (refreshResult.kind === 'invalid') {
      clearTokens()
      throw new GatewayAuthError('Session expired', refreshResult.statusCode)
    } else {
      // Временная ошибка gateway: токены сохраняем, вызывающий код сможет
      // открыть приложение в offline/degraded режиме и повторить запрос.
      throw refreshResult.error instanceof Error
        ? refreshResult.error
        : new Error('Gateway temporarily unavailable')
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
  return (process.env.SYNTEE_WEB_URL || DEFAULT_GATEWAY_URL).replace(/\/$/, '')
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
 * При временной недоступности возвращаем null, но токены не удаляем.
 */
export async function forceRefreshGatewayToken(): Promise<string | null> {
  const result = await refreshAccessToken()
  if (result.kind === 'success') return result.token
  if (result.kind === 'invalid') clearTokens()
  return null
}

/**
 * Returns the JWT to attach to /v1/* gateway requests (chat completions etc).
 * Auto-refreshes if the access token is missing or expired.
 */
export async function getGatewayAuthToken(): Promise<string | null> {
  let token = getAccessToken()
  if (!token || isAccessTokenExpired(token)) {
    const result = await refreshAccessToken()
    if (result.kind === 'success') token = result.token
    else if (result.kind === 'invalid') {
      clearTokens()
      token = null
    } else {
      // Access-токен ещё можно попробовать использовать: возможно, gateway
      // временно недоступен именно на refresh-запросе.
      token = getAccessToken()
    }
  }
  return token
}
