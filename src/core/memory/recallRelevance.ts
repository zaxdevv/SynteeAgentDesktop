// Automatic hints have to show a link to the request. Explicit searches can
// still return semantic matches for the agent to inspect and compare.
const GENERIC_TERMS = new Set([
  'about', 'again', 'agent', 'answer', 'application', 'assistant', 'briefly', 'chat',
  'could', 'error', 'explain', 'failed', 'find', 'fix', 'hello', 'help', 'model',
  'need', 'please', 'project', 'remember', 'repeat', 'result', 'show', 'short', 'system', 'task', 'tell', 'thanks',
  'that', 'their', 'there', 'these', 'this', 'those', 'tool', 'with', 'what',
  'when', 'where', 'which', 'would', 'your',
  'агент', 'ассистент', 'вопрос', 'зачем', 'задача', 'какая', 'какие', 'какой',
  'кратко', 'модель', 'можешь', 'нужно', 'ответ', 'ошибка', 'пожалуйста', 'подскажи',
  'помнишь', 'почему', 'привет', 'проблема', 'проект', 'скажи', 'сделай', 'спасибо', 'тебя', 'теперь', 'через', 'чтобы',
])

function normalizeWord(word: string): string {
  const lower = word.toLowerCase().replace(/ё/g, 'е')
  // Keep full identifiers intact. For longer words, accept common inflections
  // without matching an arbitrary substring of another term.
  if (/^[а-я]{6,}$/.test(lower)) return lower.replace(/(?:иями|ями|ами|иях|ом|ой|ою|ая|ую|ые|ых|ии|ия|ию|ие|ей|ов|ем|ям|ах|ях|а|я|у|ю|ы|и|е|о)$/, '')
  if (/^[a-z]{5,}s$/.test(lower) && !lower.endsWith('ss')) return lower.slice(0, -1)
  return lower
}

function termsOf(text: string) {
  const words = new Set<string>()
  const identifiers = new Set<string>()
  for (const match of text.replace(/\\/g, '/').matchAll(/[\p{L}\p{N}]+(?:[._/-][\p{L}\p{N}]+)*/gu)) {
    const raw = match[0]
    const normalized = raw.toLowerCase()
    if (!/\p{L}/u.test(raw)) continue
    if (/[._/-]/.test(raw) || /[a-z][A-Z]/.test(raw) || /^(?:[A-Z]+\d{2,}|E[A-Z]{3,})$/.test(raw)) {
      identifiers.add(normalized)
      continue
    }
    if (raw.length < 4 && !/^[A-Z][A-Z0-9]{2,}$/.test(raw)) continue
    if (!GENERIC_TERMS.has(normalized)) words.add(normalizeWord(raw))
  }
  return { words, identifiers }
}

export function buildRecallEvidence(query: string): { words: Set<string>; identifiers: Set<string> } {
  return termsOf(query.slice(0, 1200))
}

export function hasRecallAnchor(evidence: ReturnType<typeof buildRecallEvidence>): boolean {
  return evidence.identifiers.size > 0 || evidence.words.size >= 2
}

export function hasRecallEvidence(evidence: ReturnType<typeof buildRecallEvidence>, candidate: string): boolean {
  if (!hasRecallAnchor(evidence)) return false
  const { words, identifiers } = termsOf(candidate)
  for (const key of evidence.identifiers) {
    if (identifiers.has(key) || words.has(key)) return true
    if (!key.includes('/') && [...identifiers].some(id => id.endsWith('/' + key))) return true
  }
  let shared = 0
  for (const word of evidence.words) {
    if (words.has(word) && ++shared >= 2) return true
  }
  return false
}
