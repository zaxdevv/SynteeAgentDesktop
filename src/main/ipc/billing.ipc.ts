/**
 * Billing IPC handlers — balance, transactions, plan, usage.
 *
 * Все запросы идут через main-процесс с JWT-авторизацией (auto-refresh).
 * Renderer получает готовые данные через IPC.
 */
import { ipcMain, shell } from 'electron'
import {
  getGatewayAuthToken,
  forceRefreshGatewayToken,
  getGatewayApiUrl,
  getGatewayWebUrl,
  GatewayAuthError,
} from '../services/gatewayClient'
import { hasTokens } from '../services/tokenStore'

export interface Balance {
  balance: number
  held: number
}

export interface Transaction {
  id: string
  type: string
  amount: number
  balance_after: number
  description: string | null
  input_tokens: number | null
  output_tokens: number | null
  created_at: string
}

export interface UsageRow {
  id: string
  model_name: string
  input_tokens: number
  output_tokens: number
  cost_to_user: number
  cost_to_provider: number
  profit: number
  latency_ms: number
  status: number
  is_stream: boolean
  api_format: string
  created_at: string
}

export interface UsageSummary {
  total_requests: number
  total_input_tokens: number
  total_output_tokens: number
  total_cost: number
}

export interface UsageTimeseriesPoint {
  timestamp: string
  requests: number
  input_tokens: number
  output_tokens: number
  cost: number
}

export interface UsageBreakdownRow {
  key: string
  requests: number
  input_tokens: number
  output_tokens: number
  tokens: number
  cost: number
  avg_latency_ms: number
}

export interface PlanInfo {
  code: string
  name: string
  price_rub: number
  daily_token_limit: number
  weekly_token_limit: number
  is_recommended: boolean
  features: string[]
}

export interface PlanUsage {
  plan: PlanInfo
  usage: {
    today_tokens: number
    week_tokens: number
    today_total_tokens: number
    week_total_tokens: number
    today_reset_at: string
    week_reset_at: string
  }
  balance: Balance
}

async function gatewayFetch<T>(path: string): Promise<T> {
  if (!hasTokens()) {
    throw new GatewayAuthError('Not authenticated with Syntee-Gateway')
  }
  let token = await getGatewayAuthToken()
  if (!token) {
    throw new GatewayAuthError('No valid session')
  }
  // Один 401-ретрай с форс-рефрешем: access-токен мог протухнуть после
  // getGatewayAuthToken (гонка) или быть протухшим в хранилище.
  for (let retried401 = 0; retried401 <= 1; retried401++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    let res: Response
    try {
      res = await fetch(`${getGatewayApiUrl()}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (res.status === 401) {
      if (retried401 === 0) {
        const fresh = await forceRefreshGatewayToken()
        if (fresh) {
          token = fresh
          continue
        }
      }
      throw new GatewayAuthError('Session expired', 401)
    }
    if (!res.ok) {
      throw new Error(`Gateway ${path} → HTTP ${res.status}`)
    }
    return (await res.json()) as T
  }
  throw new GatewayAuthError('Session expired', 401)
}

export function registerBillingIPC(): void {
  ipcMain.handle('billing:balance', async (): Promise<Balance | null> => {
    try {
      return await gatewayFetch<Balance>('/api/user/billing/balance')
    } catch {
      return null
    }
  })

  ipcMain.handle('billing:transactions', async (
    _e,
    params: { limit?: number; offset?: number } = {},
  ): Promise<Transaction[]> => {
    try {
      const qs = new URLSearchParams()
      if (params.limit) qs.set('limit', String(params.limit))
      if (params.offset) qs.set('offset', String(params.offset))
      const q = qs.toString()
      return await gatewayFetch<Transaction[]>(`/api/user/billing/transactions${q ? '?' + q : ''}`)
    } catch {
      return []
    }
  })

  ipcMain.handle('billing:summary', async (
    _e,
    params: { hours?: number } = {},
  ): Promise<UsageSummary | null> => {
    try {
      const qs = new URLSearchParams()
      if (params.hours) qs.set('hours', String(params.hours))
      const q = qs.toString()
      return await gatewayFetch<UsageSummary>(`/api/user/billing/summary${q ? '?' + q : ''}`)
    } catch {
      return null
    }
  })

  ipcMain.handle('billing:timeseries', async (
    _e,
    params: { hours?: number } = {},
  ): Promise<UsageTimeseriesPoint[]> => {
    try {
      const hours = params.hours ?? 24
      return await gatewayFetch<UsageTimeseriesPoint[]>(`/api/user/billing/usage/timeseries?hours=${hours}`)
    } catch {
      return []
    }
  })

  ipcMain.handle('billing:breakdown', async (
    _e,
    params: { hours?: number; by?: 'model' | 'provider' | 'status' | 'format' } = {},
  ): Promise<UsageBreakdownRow[]> => {
    try {
      const hours = params.hours ?? 24
      const by = params.by ?? 'model'
      return await gatewayFetch<UsageBreakdownRow[]>(`/api/user/billing/usage/breakdown?hours=${hours}&by=${by}`)
    } catch {
      return []
    }
  })

  ipcMain.handle('billing:plan', async (): Promise<PlanUsage | null> => {
    try {
      return await gatewayFetch<PlanUsage>('/api/user/billing/plan')
    } catch {
      return null
    }
  })

  ipcMain.handle('billing:openTopup', async () => {
    await shell.openExternal(`${getGatewayWebUrl()}/billing`)
    return { ok: true }
  })
}
