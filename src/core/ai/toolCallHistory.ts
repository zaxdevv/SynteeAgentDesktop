type ToolHistoryMessage = {
  role: string
  content: unknown
  tool_calls?: unknown[]
  tool_call_id?: string
}

/** Repair sliced/compacted history without mutating the source messages.
 * Only matched, single-use call/output pairs are kept as protocol messages.
 * Incomplete calls retain their assistant text but are not replayed as calls.
 */
export function repairToolCallHistory<T extends ToolHistoryMessage>(messages: T[]): T[] {
  const result: T[] = []
  let pending = new Set<string>()
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role === 'tool') {
      if (message.tool_call_id && pending.delete(message.tool_call_id)) result.push(message)
      // An orphan or duplicate output cannot be sent to strict providers.
      continue
    }
    pending = new Set<string>()
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const outputs = new Set<string>()
      for (let next = index + 1; next < messages.length && messages[next].role === 'tool'; next++) {
        const id = messages[next].tool_call_id
        if (id) outputs.add(id)
      }
      const calls = message.tool_calls.filter(raw => {
        const call = raw as { id?: string; function?: { name?: string } } | null
        if (!call?.id || !call.function?.name || !outputs.has(call.id) || pending.has(call.id)) return false
        pending.add(call.id)
        return true
      })
      const copy = { ...message }
      if (calls.length) copy.tool_calls = calls
      else delete copy.tool_calls
      result.push(copy)
    } else {
      result.push(message)
    }
  }
  return result
}
