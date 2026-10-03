import type Store from 'electron-store'
import { AIClient } from '../../ai/AIClient'

// ─── LLM Summarization ──────────────────────────────────────────────────────

export interface FastContextFile {
  path: string
  lineRanges: string  // "10-45, 100-130"
  why: string  // 1-строка — почему этот файл релевантен
}

export interface FastContextResult {
  files: FastContextFile[]
  summary: string
  ms: number
  indexedFilesCount: number
  /** Compact source evidence to reduce follow-up file reads. */
  snippets?: Array<{ path: string; lineRanges: string; code: string }>
}

const SUMMARY_SYSTEM_PROMPT = `You are an expert codebase analyzer. Your task is to select relevant files and specify exact line ranges based on a repo-map (file structure with signatures, dependencies, and call graph) and the user query.

Repo-map contains:
- Symbol signatures with line numbers (L<number>)
- Hierarchy: methods indented under classes
- imports / imported by / called by — relationships between files
- [entry] / [hub] — entry points and architecturally important files
- Content snippets — actual code of top files

Answer — JSON only, no markdown:
{"files":[{"path":"exact path from repo-map","lineRanges":"10-45","why":"which symbols are relevant"}],"summary":"2-3 sentences: what was found and how it relates to the query"}

Rules:
- Select 5-30 files from the repo-map (more if relevant)
- path — EXACTLY from the repo-map, do not invent paths
- lineRanges — line ranges from L-numbers: "10-45" or "10-45, 100-130"
- why — 1 line: which symbols/dependencies make the file relevant
- Select files by RELEVANCE TO THE QUERY, not by structural importance
- [entry]/[hub] and imported by — reference info, NOT priority
- summary: architecture of the solution, which files are responsible for what`

/**
 * Надёжное извлечение JSON из ответа LLM. Сначала убирает markdown-fences,
 * затем ищет сбалансированный {...} блок (не жадный regex, который ломается
 * на prose с фигурными скобками).
 */
export function extractJsonFromLlmResponse(raw: string): { files?: unknown[]; summary?: string; facts?: unknown[] } | null {
  let text = raw.trim()

  // 1. Убираем markdown code fences (```json ... ``` или ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  // 2. Ищем сбалансированный {...} блок
  const startIdx = text.indexOf('{')
  if (startIdx === -1) return null

  let depth = 0
  let endIdx = -1
  let inString = false
  let escape = false
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { endIdx = i; break }
    }
  }

  if (endIdx === -1) return null
  const jsonStr = text.slice(startIdx, endIdx + 1)

  try {
    return JSON.parse(jsonStr) as { files?: unknown[]; summary?: string }
  } catch {
    // Fallback: пробуем старый жадный regex (на случай если balanced parse ошибся)
    const greedyMatch = raw.match(/\{[\s\S]*\}/)
    if (greedyMatch) {
      try {
        return JSON.parse(greedyMatch[0]) as { files?: unknown[]; summary?: string }
      } catch { /* skip */ }
    }
    return null
  }
}

export async function summarizeWithLLM(
  store: Store,
  query: string,
  repoMapSlice: string,
  signal?: AbortSignal,
): Promise<{ files: FastContextFile[]; summary: string } | null> {
  const aiClient = new AIClient(store)
  let raw = ''
  await aiClient.streamChat(
    [{
      role: 'user',
      content: `Query: ${query}\n\nRepo-map (top files with symbols):\n\n${repoMapSlice}`,
    }],
    {
      onToken: (t) => { raw += t },
      onDone: () => {},
      onError: () => {},
    },
    'fastContext',
    SUMMARY_SYSTEM_PROMPT,
    signal,
    0.1, // low temperature for deterministic file selection
  )

  const parsed = extractJsonFromLlmResponse(raw)
  if (!parsed) {
    return { files: [], summary: raw.slice(0, 300) || 'Failed to get summary.' }
  }

  const files: FastContextFile[] = []
  if (Array.isArray(parsed.files)) {
    for (const f of parsed.files.slice(0, 50)) {
      if (typeof f !== 'object' || f === null) continue
      const obj = f as Record<string, unknown>
      const path = typeof obj.path === 'string' ? obj.path : ''
      const lineRanges = typeof obj.lineRanges === 'string' ? obj.lineRanges : ''
      const why = typeof obj.why === 'string' ? obj.why : ''
      if (path) files.push({ path, lineRanges, why })
    }
  }

  return {
    files,
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 500) : '',
  }
}
