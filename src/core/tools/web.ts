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
      'Web search is not available. Add a Tavily API key in Settings → Integrations, or log in to a Syntee account (the gateway will provide keys automatically).',
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
        error: `All web search services are unavailable: ${body.detail ?? 'upstream exhausted'}`,
      }
    }
    if (res.status === 404) {
      // Endpoint not deployed on this gateway version — don't fall back silently,
      // the admin needs to update the backend. Local key fallback would hide this.
      return {
        success: false,
        output: '',
        error: 'Web search is not deployed on this gateway. Update the backend.',
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
      return { success: false, output: '', error: 'Web search exceeded the timeout (30s). Try again later.' }
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
    // Проверка res.ok ДО парсинга тела. Раньше 401 (невалидный ключ) или
    // 429 (rate limit) шли в res.json() → data.results = undefined →
    // data.results.map бросал TypeError «Cannot read properties of
    // undefined» — AI получал мусор вместо понятной ошибки про ключ.
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string; message?: string }
      const detail = body.detail ?? body.message ?? res.statusText
      const hint = res.status === 401
        ? ' Check the Tavily API key in Settings → Integrations.'
        : res.status === 429
          ? ' Tavily request limit exceeded — wait or use a gateway account.'
          : ''
      return {
        success: false,
        output: '',
        error: `Tavily error ${res.status}: ${detail}.${hint}`,
      }
    }
    const data = (await res.json()) as { results: Array<{ title: string; url: string; content: string }> }
    if (!data.results || !Array.isArray(data.results)) {
      return { success: false, output: '', error: 'Tavily returned an unexpected response format (no results array).' }
    }
    if (data.results.length === 0) {
      return { success: true, output: 'Web search found no results for the query. Refine the query or try fetch_page on a specific URL.' }
    }
    const formatted = data.results
      .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${(r.content ?? '').slice(0, 300)}...`)
      .join('\n\n')
    return { success: true, output: formatted }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, output: '', error: 'Web search exceeded the timeout (15s). Try again later or refine the query.' }
    }
    return { success: false, output: '', error: e.message }
  }
}
