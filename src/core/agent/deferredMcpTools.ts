/** A run-local view of schemas; the original permission registry is untouched. */
export interface DiscoverableToolSchema {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: { type?: string; required?: readonly string[]; properties?: Record<string, unknown> }
  }
}

export const DISCOVER_MCP_TOOLS = 'discover_mcp_tools'
export const DEFER_MCP_TOOL_COUNT = 24
const PAGE_SIZE = 12
const MAX_SELECTION = 8
interface McpDiscoverySchema {
  type: 'function'
  function: { name: string; description: string; parameters: { type: string; properties: Record<string, unknown> } }
}

export class DeferredMcpTools {
  private readonly selected = new Set<string>()
  private readonly discoverySchema: McpDiscoverySchema
  private readonly enabled: boolean

  constructor(schemas: DiscoverableToolSchema[], enabled = true) {
    const tools = schemas.filter(schema => schema.function.name.startsWith('mcp__'))
    // Keep small registries eager: discovery round trips would cost more.
    // A pre-existing name belongs to the original registry, never to this helper.
    this.enabled = enabled && tools.length >= DEFER_MCP_TOOL_COUNT
      && !schemas.some(schema => schema.function.name === DISCOVER_MCP_TOOLS)
    const servers = [...new Set(tools.map(schema => schema.function.name.split('__')[1]))]
    this.discoverySchema = {
      type: 'function',
      function: {
        name: DISCOVER_MCP_TOOLS,
        description: `Find connected MCP tools by query (name, server or task), or browse with offset. ${tools.length} tools; servers: ${servers.slice(0, 12).map(server => server.slice(0, 60)).join(', ')}${servers.length > 12 ? ', …' : ''}. Use exact tool_names to load up to ${MAX_SELECTION} native tool schemas for the NEXT response. Search returns names/descriptions, not callable schemas. Loading never executes a tool or grants permissions.`,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search task, tool or server name; empty browses all permitted tools.' },
            offset: { type: 'integer', minimum: 0, description: 'Continue a result page using next_offset.' },
            tool_names: { type: 'array', items: { type: 'string' }, maxItems: MAX_SELECTION, description: 'Exact names from search to expose as native tools next response.' },
          },
        },
      },
    }
  }

  /** Stable registry order for builtins, followed by selections in load order.
   * Nothing is evicted: unrelated searches cannot churn cached tool prefixes. */
  forRequest<T extends DiscoverableToolSchema>(permitted: T[]): Array<T | McpDiscoverySchema> {
    if (!this.enabled) return permitted
    const tools = new Map(permitted.filter(schema => schema.function.name.startsWith('mcp__')).map(schema => [schema.function.name, schema]))
    if (!tools.size) return permitted
    const result: Array<T | McpDiscoverySchema> = permitted.filter(schema => !schema.function.name.startsWith('mcp__'))
    result.push(this.discoverySchema)
    for (const name of this.selected) {
      const schema = tools.get(name)
      if (schema) result.push(schema)
    }
    return result
  }

  isDiscovery(name: string): boolean {
    return this.enabled && name === DISCOVER_MCP_TOOLS
  }

  /** Continue prior selections/uses across workers without trusting schema text. */
  restoreSelections(messages: Array<{ role: string; content: unknown; name?: string; tool_calls?: unknown[] }>, permitted: DiscoverableToolSchema[]): void {
    if (!this.enabled) return
    const allowed = new Set(permitted.filter(schema => schema.function.name.startsWith('mcp__')).map(schema => schema.function.name))
    const remember = (name: unknown): void => { if (typeof name === 'string' && allowed.has(name)) this.selected.add(name) }
    for (const message of messages) {
      if (message.role === 'assistant') {
        for (const raw of message.tool_calls ?? []) remember((raw as { function?: { name?: string } })?.function?.name)
      } else if (message.role === 'tool' && message.name === DISCOVER_MCP_TOOLS && typeof message.content === 'string') {
        try {
          const result = JSON.parse(message.content)
          if (Array.isArray(result?.loaded)) for (const name of result.loaded) remember(name)
        } catch { /* Compacted/interrupted results can be rediscovered. */ }
      }
    }
  }

  /** Resolve only exact registered names, atomically. Schema definitions never
   * come from model text, search results, or a schema supplied as an argument. */
  discover(args: Record<string, unknown>, permitted: DiscoverableToolSchema[]): { success: boolean; output: string; error?: string } {
    const fail = (error: string) => ({ success: false, output: '', error })
    if (!this.enabled) return fail('MCP discovery is unavailable in this run.')
    const tools = permitted.filter(schema => schema.function.name.startsWith('mcp__'))
    const byName = new Map(tools.map(schema => [schema.function.name, schema]))
    if (!tools.length) return fail('No MCP tools are permitted in this mode or phase.')
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 300)) return fail('query must be a string of at most 300 characters.')
    if (args.offset !== undefined && (typeof args.offset !== 'number' || !Number.isSafeInteger(args.offset) || args.offset < 0)) return fail('offset must be a nonnegative integer.')
    if (args.tool_names !== undefined && (!Array.isArray(args.tool_names) || args.tool_names.length > MAX_SELECTION
      || args.tool_names.some(name => typeof name !== 'string' || !byName.has(name)))) return fail(`tool_names must contain at most ${MAX_SELECTION} exact, currently permitted MCP names. Search first.`)
    const names = (args.tool_names ?? []) as string[]
    for (const name of names) this.selected.add(name)
    const terms = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const matches = tools.map(schema => {
      const name = schema.function.name.toLowerCase()
      const description = (schema.function.description ?? '').toLowerCase()
      const score = terms.reduce((sum, term) => sum + (name.includes(term) ? 3 : description.includes(term) ? 1 : 0), 0)
      return { schema, score }
    }).filter(item => !terms.length || item.score > 0).sort((a, b) => b.score - a.score)
    const offset = (args.offset ?? 0) as number
    // Selection-only responses stay small; query/browse results are paginated.
    const page = names.length && args.query === undefined ? [] : matches.slice(offset, offset + PAGE_SIZE)
    return {
      success: true,
      output: JSON.stringify({
        loaded: [...new Set(names)],
        ...(names.length ? { next_step: 'Native schemas are available next response. Call those tools using their declared parameters.' } : {}),
        total_matches: matches.length,
        tools: page.map(({ schema }) => ({ name: schema.function.name, description: (schema.function.description ?? '').slice(0, 180), loaded: this.selected.has(schema.function.name) })),
        ...((!names.length || args.query !== undefined) && offset + page.length < matches.length ? { next_offset: offset + page.length } : {}),
      }),
    }
  }
}

/** Same seeded view for main-process estimates and the worker's first request. */
export function initialMcpSchemas<T extends DiscoverableToolSchema>(schemas: T[], history: Parameters<DeferredMcpTools['restoreSelections']>[0], enabled = true): DiscoverableToolSchema[] {
  const catalogue = new DeferredMcpTools(schemas, enabled)
  catalogue.restoreSelections(history, schemas)
  return catalogue.forRequest(schemas)
}
