import type { ToolResult } from './_shared'

export interface WebSearchOptions {
  /** Tavily API key from local integrations (Settings → Интеграции). */
  tavilyKey?: string
  /** Gateway JWT — when set, search runs through gateway /api/user/playground/web-search
   *  with admin-provisioned Tavily/Exa keys (fallback chain). No local key needed. */
  gatewayToken?: string
  /** Gateway base URL (process.env.SYNTEE_API_URL). */
  gatewayApiUrl?: string
}

/**
 * Smart web search priority:
 *  1. Local Tavily key (Settings → Интеграции) — preferred when configured, even
 *     if the user is logged into a gateway account. The user's own key is
 *     billed to their own Tavily plan, not to the gateway admin.
 *  2. Gateway account (gatewayToken) — fallback when no local key is set.
 *     Admin-provisioned Tavily/Exa keys handle the upstream call with
 *     automatic fallback. No local integration key required.
 *  3. Nothing configured → prompt the user to add a key in Settings →
 *     Интеграции (or log in to the gateway account).
 */
export async function searchWeb(query: string, opts: WebSearchOptions = {}): Promise<ToolResult> {
  const { tavilyKey, gatewayToken, gatewayApiUrl } = opts

  // 1) Local Tavily key path — preferred when the user has configured one.
  if (tavilyKey) return searchViaTavily(query, tavilyKey)

  // 2) Gateway path — fallback when no local key is set but an account is logged in.
  if (gatewayToken && gatewayApiUrl) {
    const gwResult = await searchViaGateway(query, gatewayApiUrl, gatewayToken)
    if (gwResult !== 'FALLBACK') return gwResult
  }

  // 3) Nothing configured.
  return {
    success: false,
    output: '',
    error:
      'Веб-поиск недоступен. Добавьте Tavily API ключ в Настройки → Интеграции или войдите в аккаунт Syntee (gateway предоставит ключи автоматически).',
  }
}

async function searchViaGateway(
  query: string,
  apiUrl: string,
  token: string,
): Promise<ToolResult | 'FALLBACK'> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/user/playground/web-search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, max_results: 5 }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    // Auth/session issue → fall back to local key if user has one.
    if (res.status === 401 || res.status === 403) return 'FALLBACK'

    if (res.status === 502) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return {
        success: false,
        output: '',
        error: `Все сервисы веб-поиска недоступны: ${body.detail ?? 'upstream exhausted'}`,
      }
    }
    if (res.status === 404) {
      // Endpoint not deployed on this gateway version — don't fall back silently,
      // the admin needs to update the backend. Local key fallback would hide this.
      return {
        success: false,
        output: '',
        error: 'Веб-поиск не развернут на этом gateway. Обновите backend.',
      }
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return {
        success: false,
        output: '',
        error: `Gateway error ${res.status}: ${body.detail ?? res.statusText}`,
      }
    }

    const data = (await res.json()) as {
      results: Array<{ title: string; url: string; content?: string | null; published_date?: string | null }>
      answer?: string | null
      provider?: string
    }
    const parts: string[] = []
    if (data.answer) parts.push(data.answer)
    const formatted = data.results
      .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${(r.content ?? '').slice(0, 300)}...`)
      .join('\n\n')
    parts.push(formatted)
    return { success: true, output: parts.join('\n\n') }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, output: '', error: 'Веб-поиск превысил таймаут (30с). Попробуйте позже.' }
    }
    // Network error (gateway unreachable) — fall back to local key if available.
    return 'FALLBACK'
  }
}

async function searchViaTavily(query: string, apiKey: string): Promise<ToolResult> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: 'basic' }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    const data = (await res.json()) as { results: Array<{ title: string; url: string; content: string }> }
    const formatted = data.results
      .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content.slice(0, 300)}...`)
      .join('\n\n')
    return { success: true, output: formatted }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, output: '', error: 'Веб-поиск превысил таймаут (15с). Попробуйте позже или уточните запрос.' }
    }
    return { success: false, output: '', error: e.message }
  }
}

// ── http_request — прямой HTTP-клиент без shell ──────────────────────────
export async function httpRequest(params: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeout?: number
}): Promise<ToolResult> {
  const { url: urlStr, method = 'GET', headers = {}, body, timeout = 30 } = params

  if (!urlStr) return { success: false, output: '', error: 'url is required' }

  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    return { success: false, output: '', error: `Invalid URL: ${urlStr}` }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { success: false, output: '', error: `Only http/https supported, got: ${url.protocol}` }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout * 1000)

    const fetchOpts: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    }
    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = body
    }

    const res = await fetch(urlStr, fetchOpts)
    clearTimeout(timer)

    const status = res.status
    const resHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => { resHeaders[k] = v })

    let resBody: string
    const rawText = await res.text()

    // Обрезаем очень длинные ответы
    const maxChars = 8000
    if (rawText.length > maxChars) {
      resBody = rawText.slice(0, maxChars) + `\n\n...[обрезано ${rawText.length - maxChars} символов]`
    } else {
      resBody = rawText
    }

    const headerStr = Object.entries(resHeaders)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n')

    const output = [
      `[HTTP ${method} ${urlStr}]`,
      `Status: ${status} ${res.statusText}`,
      `Headers:`,
      headerStr,
      ``,
      `Body:`,
      resBody,
    ].join('\n')

    return { success: true, output }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, output: '', error: `Request timed out after ${timeout}s` }
    }
    return { success: false, output: '', error: e.message }
  }
}
