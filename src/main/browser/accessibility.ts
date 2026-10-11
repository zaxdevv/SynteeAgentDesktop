/** Native accessibility tree capture through Electron's local CDP pipe.
 *
 * This intentionally uses WebContents.debugger rather than a remote debugging
 * port. The caller owns the debugger lifecycle; an existing attachment is
 * never detached (it may belong to another automation feature).
 */

const MAX_NODES = 1200

type DebuggerLike = {
  attached?: boolean
  isAttached?: () => boolean
  attach: (version: string) => void
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

type RawAXValue = { type?: string; value?: unknown }
type RawAXProperty = { name?: string; value?: RawAXValue }
type RawAXNode = {
  ignored?: boolean
  role?: RawAXValue
  name?: RawAXValue
  value?: RawAXValue
  properties?: RawAXProperty[]
  backendDOMNodeId?: number
}

type NormalizedNode = {
  role?: string
  name?: string
  value?: string
  disabled?: boolean
  checked?: boolean
  expanded?: boolean
  selected?: boolean
  focused?: boolean
  ignored?: boolean
  backendDOMNodeId?: number
}

function aborted(): Error {
  return new Error('Accessibility capture aborted')
}

function unsupported(reason: string): Error {
  return new Error(`Native accessibility tree unsupported: ${reason}`)
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted()
}

function rawValue(value: RawAXValue | undefined): unknown {
  return value && 'value' in value ? value.value : undefined
}

function stringValue(value: RawAXValue | undefined): string | undefined {
  const raw = rawValue(value)
  return raw === undefined || raw === null ? undefined : String(raw)
}

function booleanValue(value: RawAXValue | undefined): boolean | undefined {
  const raw = rawValue(value)
  if (typeof raw === 'boolean') return raw
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

function isTrue(value: RawAXValue | undefined): boolean {
  return booleanValue(value) === true || stringValue(value)?.toLowerCase() === 'true'
}

function normalizeNode(node: RawAXNode): NormalizedNode {
  const role = stringValue(node.role)
  const properties = Array.isArray(node.properties) ? node.properties : []
  const property = (name: string): RawAXValue | undefined =>
    properties.find(item => item.name === name)?.value
  const sensitive = role?.toLowerCase() === 'password' ||
    isTrue(property('protected')) ||
    ['autocomplete', 'inputType', 'textInputType'].some(name =>
      stringValue(property(name))?.toLowerCase().includes('password') ?? false)

  const result: NormalizedNode = {}
  if (role) result.role = role
  const name = stringValue(node.name)
  if (name) result.name = name.slice(0, 512)
  // Bound individual fields as well as node count. AX names can contain entire
  // documents; protected fields must never expose their value.
  const value = stringValue(node.value)
  if (!sensitive && value !== undefined) result.value = value.slice(0, 512)

  for (const state of ['disabled', 'checked', 'expanded', 'selected', 'focused'] as const) {
    const stateValue = booleanValue(property(state))
    if (stateValue !== undefined) result[state] = stateValue
  }
  if (node.ignored !== undefined) result.ignored = !!node.ignored
  // Useful for diagnostics, but deliberately no synthetic refs/node IDs.
  if (typeof node.backendDOMNodeId === 'number') result.backendDOMNodeId = node.backendDOMNodeId
  return result
}

/** Capture Chrome's complete native accessibility tree for a WebContents. */
export async function captureAccessibility(
  wc: Electron.WebContents,
  options: { frameId?: string; maxNodes?: number },
  signal?: AbortSignal,
): Promise<{ nodes: unknown[]; truncated: boolean }> {
  checkAbort(signal)
  const candidate = (wc as Electron.WebContents & { debugger?: DebuggerLike }).debugger
  if (!candidate || typeof candidate.attach !== 'function' || typeof candidate.sendCommand !== 'function') {
    throw unsupported('webContents.debugger is unavailable')
  }

  const debuggerAttached = typeof candidate.isAttached === 'function'
    ? candidate.isAttached()
    : candidate.attached === true
  if (!debuggerAttached) {
    checkAbort(signal)
    try {
      candidate.attach('1.3')
    } catch (error) {
      throw unsupported(error instanceof Error ? error.message : 'CDP debugger could not attach')
    }
  }

  checkAbort(signal)
  const params: Record<string, unknown> = {}
  if (options.frameId !== undefined) params.frameId = options.frameId
  let response: unknown
  try {
    response = await candidate.sendCommand('Accessibility.getFullAXTree', params)
  } catch (error) {
    if (signal?.aborted) throw aborted()
    throw error
  }
  checkAbort(signal)

  const rawNodes = (response as { nodes?: unknown } | null)?.nodes
  if (!Array.isArray(rawNodes)) throw unsupported('Accessibility.getFullAXTree returned no nodes')
  const requestedLimit = options.maxNodes === undefined ? MAX_NODES : Math.floor(options.maxNodes)
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(0, Math.min(MAX_NODES, requestedLimit))
    : MAX_NODES
  const nodes = rawNodes.slice(0, limit).map(node => normalizeNode((node ?? {}) as RawAXNode))
  return { nodes, truncated: rawNodes.length > limit }
}
