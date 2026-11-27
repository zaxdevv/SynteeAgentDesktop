import * as fs from 'node:fs'
import * as path from 'node:path'

/** Single-writer, bounded rotating files. Never truncates an existing session. */
export class RotatingLogFile {
  private size = 0
  constructor(private file: string, private maxBytes = 2 * 1024 * 1024, private archives = 4, retentionMs = 14 * 24 * 3600_000) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const cutoff = Date.now() - retentionMs
    try {
      const stat = fs.statSync(file)
      if (stat.mtimeMs < cutoff) fs.unlinkSync(file)
      else this.size = stat.size
    } catch { /* first launch */ }
    for (let index = 1; index <= archives; index++) {
      const archive = `${file}.${index}`
      try { if (fs.statSync(archive).mtimeMs < cutoff) fs.unlinkSync(archive) } catch { /* absent */ }
    }
  }

  append(text: string): void {
    const bytes = Buffer.byteLength(text)
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate()
    const data = Buffer.from(text)
    const tail = data.length > this.maxBytes ? data.subarray(data.length - this.maxBytes) : data
    fs.appendFileSync(this.file, tail)
    this.size += tail.length
  }

  private rotate(): void {
    for (let index = this.archives; index >= 1; index--) {
      const destination = `${this.file}.${index}`
      const source = index === 1 ? this.file : `${this.file}.${index - 1}`
      try { fs.unlinkSync(destination) } catch { /* absent */ }
      try { fs.renameSync(source, destination) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    this.size = 0
  }
}

/** Last line of defence. Callers must still log metadata rather than content. */
export function redactLogText(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat|hf|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '[REDACTED]')
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s"']+/gi, '$1[REDACTED]')
}

export function safeLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactLogText(value.slice(0, 8192)).slice(0, 4096)
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  if (depth >= 4) return '[nested]'
  seen.add(value)
  if (value instanceof Error) return { name: value.name, message: redactLogText(value.message).slice(0, 1024) }
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeLogValue(item, depth + 1, seen))
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    result[key] = /(?:api.?key|token|authorization|password|secret|prompt|content|messages|transcript|arguments|base64|cookie)/i.test(key)
      && !/(?:tokens|count|chars|length|size)$/i.test(key) ? '[REDACTED]' : safeLogValue(item, depth + 1, seen)
  }
  return result
}
