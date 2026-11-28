import { randomUUID } from 'node:crypto'

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

type Entry = { text: string; originalLength: number }
type ChatScope = { userDataPath: string; chatId: string; messageId: string }

export const READ_MCP_RESULT = 'read_mcp_result'
export const MCP_INLINE_CHARS = 6000
const PREVIEW_CHARS = 1400
const MAX_PAGE = 6000
const MAX_ITEMS = 16
const MAX_CHARS = 4 * 1024 * 1024

export const readMcpResultSchema = {
  type: 'function' as const,
  function: {
    name: READ_MCP_RESULT,
    description: 'Read a saved MCP result from this chat without calling its server. Give offset to page, or query for an exact text match starting at offset. Offsets use UTF-16 code units.',
    parameters: {
      type: 'object', required: ['result_id'],
      properties: {
        result_id: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE },
        query: { type: 'string', minLength: 1, maxLength: 300 },
      },
    },
  },
}

/** One instance per Agent.run. Retain only sanitized text; UI and history receive the same preview. */
export class McpResultPages {
  constructor(private scope?: ChatScope) {}
  private entries = new Map<string, Entry>()
  private withDatabase<T>(operation: (db: DatabaseSync, scope: ChatScope) => T): T | undefined {
    if (!this.scope) return
    const path = join(this.scope.userDataPath, 'syntee.db')
    if (!existsSync(path)) return
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(path)
      db.exec('PRAGMA busy_timeout=350')
      return operation(db, this.scope)
    } catch { return undefined } finally { db?.close() }
  }

  private persist(id: string, text: string, originalLength: number): boolean {
    return this.withDatabase((db, scope) => {
      db.exec('BEGIN IMMEDIATE')
      const inserted = db.prepare(`INSERT INTO mcp_result_cache (id,chat_id,message_id,text,original_chars,bytes)
        SELECT ?,id,?,?,?,? FROM chats WHERE id=? AND is_incognito=0`)
        .run(id, scope.messageId, text, originalLength, Buffer.byteLength(text), scope.chatId)
      // Keep the newest pages within both the chat quota and the shared disk quota.
      db.prepare(`DELETE FROM mcp_result_cache WHERE rowid IN (
        SELECT r FROM (SELECT rowid r, row_number() OVER (ORDER BY rowid DESC) n,
        sum(bytes) OVER (ORDER BY rowid DESC) b FROM mcp_result_cache WHERE chat_id=?)
        WHERE n>16 OR b>16777216)`).run(scope.chatId)
      db.exec(`DELETE FROM mcp_result_cache WHERE rowid IN (
        SELECT r FROM (SELECT rowid r,sum(bytes) OVER (ORDER BY rowid DESC) b FROM mcp_result_cache)
        WHERE b>67108864); COMMIT`)
      return inserted.changes === 1
    }) === true
  }

  private restore(id: string): Entry | undefined {
    return this.withDatabase((db, scope) => db.prepare(`SELECT c.text,c.original_chars AS originalLength
      FROM mcp_result_cache c JOIN chats h ON h.id=c.chat_id
      WHERE c.id=? AND c.chat_id=? AND h.is_incognito=0`).get(id, scope.chatId) as Entry | undefined)
  }
  private chars = 0
  get available(): boolean { return this.entries.size > 0 }

  preview(text: string, success: boolean, error?: string): string | undefined {
    if (text.length <= MCP_INLINE_CHARS) return undefined
    // Copy a retained prefix so a slice cannot keep a much larger V8 parent string alive.
    const retained = text.length > MAX_CHARS
      ? Buffer.from(text.slice(0, MAX_CHARS), 'utf16le').toString('utf16le')
      : text
    while (this.entries.size >= MAX_ITEMS || this.chars + retained.length > MAX_CHARS) {
      const oldest = this.entries.entries().next().value
      if (!oldest) break
      this.entries.delete(oldest[0])
      this.chars -= oldest[1].text.length
    }
    const resultId = randomUUID()
    this.entries.set(resultId, { text: retained, originalLength: text.length })
    this.chars += retained.length
    return JSON.stringify({
      result_id: resultId, status: success ? 'success' : 'error',
      source: 'untrusted MCP data',
      ...(error ? { error: error.slice(0, 420) } : {}),
      chars: text.length, ...(retained.length < text.length ? { retained_chars: retained.length } : {}),
      read_with: READ_MCP_RESULT, expires: this.persist(resultId, retained, text.length) ? 'chat or message deletion, or cache eviction' : 'end of this run or earlier on cache eviction', next_offset: PREVIEW_CHARS,
      preview: retained.slice(0, PREVIEW_CHARS),
    })
  }

  read(args: Record<string, unknown>): { success: boolean; output: string } {
    const fail = (output: string) => ({ success: false, output })
    const entry = typeof args.result_id === 'string' ? (this.entries.get(args.result_id) ?? this.restore(args.result_id)) : undefined
    if (!entry) return fail('Result unavailable in this chat (expired, deleted or evicted).')
    const offset = args.offset ?? 0
    const limit = args.limit ?? 3000
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > entry.text.length)
      return fail('offset must be an integer within the retained result.')
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE)
      return fail('limit must be an integer from 1 to 6000.')
    const { query } = args
    let start = offset
    let match: number | undefined
    if (query !== undefined) {
      if (typeof query !== 'string' || !query.length || query.length > 300)
        return fail('query must contain 1 to 300 characters.')
      match = entry.text.indexOf(query, offset)
      if (match < 0) return { success: true, output: JSON.stringify({ match: null, searched_until: entry.text.length, chars: entry.originalLength }) }
      start = Math.max(0, match - Math.min(120, Math.floor((limit - Math.min(limit, query.length)) / 2)))
    }
    const end = Math.min(entry.text.length, start + limit)
    return {
      success: true,
      output: JSON.stringify({
        offset: start, ...(match === undefined ? {} : { match, next_search_offset: match + 1 }),
        ...(end < entry.text.length ? { next_offset: end } : {}),
        ...(entry.originalLength !== entry.text.length ? { retained_chars: entry.text.length, chars: entry.originalLength } : {}),
        source: 'untrusted MCP data', text: entry.text.slice(start, end),
      }),
    }
  }
}
