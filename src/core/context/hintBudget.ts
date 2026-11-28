import { estimateTokens } from '../tokens/usageTracker'
import { HINT_MARKER, type HintCandidate } from '../../shared/assistants'

export const MAX_PENDING_HINTS = 3

/** Count the actual injected message, including its marker and message overhead. */
function format(hint: HintCandidate, content = hint.content): { text: string; message: string } {
  const text = hint.title ? `[${hint.source}: ${hint.title}] ${content}` : `[${hint.source}] ${content}`
  return { text, message: `${HINT_MARKER}\n${JSON.stringify(text)}` }
}

export function consumeHintBudget(queue: HintCandidate[], tokenBudget: number): {
  selected: Array<{ hint: HintCandidate; text: string; message: string }>
  remaining: HintCandidate[]
} {
  const selected: Array<{ hint: HintCandidate; text: string; message: string }> = []
  const remaining: HintCandidate[] = []
  let available = Number.isFinite(tokenBudget) ? Math.max(0, Math.floor(tokenBudget)) : 0
  for (const hint of queue.slice(0, MAX_PENDING_HINTS)) {
    let formatted = format(hint)
    if (estimateTokens(formatted.message) + 4 > available) {
      // Defer whole hints to a later round rather than losing them when the
      // first hint consumed the budget. An individually oversized advisory
      // is clipped once so it cannot block the queue forever.
      if (selected.length || estimateTokens(format(hint, '').message) + 5 > available) {
        remaining.push(hint)
        continue
      }
      let low = 0, high = Math.min(hint.content.length, 8000)
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (estimateTokens(format(hint, hint.content.slice(0, mid) + '…').message) + 4 <= available) low = mid
        else high = mid - 1
      }
      const prefix = hint.content.slice(0, low).replace(/[\uD800-\uDBFF]$/, '')
      formatted = format(hint, prefix + '…')
    }
    const cost = estimateTokens(formatted.message) + 4
    if (cost > available) { remaining.push(hint); continue }
    selected.push({ hint, ...formatted })
    available -= cost
  }
  return { selected, remaining }
}
