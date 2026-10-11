import { getDB } from './handle'
import { getMessageById, pinMessage, unpinMessage, setMessageHidden } from './messages'
import type { Message } from '../../shared/types'
import { CONTEXT_SOURCE_KEYS, DEFAULT_CONTEXT_PREFERENCES, type ContextPreferences } from '../../shared/types/contextControls'

function ensureTable(): void {
  getDB().exec(`CREATE TABLE IF NOT EXISTS chat_context_preferences (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    preferences TEXT NOT NULL
  )`)
}
export function getContextPreferences(chatId?: string): ContextPreferences {
  const defaults = { sources: { ...DEFAULT_CONTEXT_PREFERENCES.sources }, excludedFiles: [] }
  if (!chatId) return defaults
  ensureTable()
  const row = getDB().prepare('SELECT preferences FROM chat_context_preferences WHERE chat_id = ?').get(chatId) as { preferences: string } | undefined
  if (!row) return defaults
  try { return normalizePreferences(JSON.parse(row.preferences), defaults) } catch { return defaults }
}
function normalizePreferences(patch: Partial<ContextPreferences>, base: ContextPreferences): ContextPreferences {
  const sources = { ...base.sources }
  for (const key of CONTEXT_SOURCE_KEYS) {
    if (typeof patch.sources?.[key] === 'boolean') sources[key] = patch.sources[key]
  }
  const excludedFiles = Array.isArray(patch.excludedFiles)
    ? [...new Set(patch.excludedFiles.filter((v): v is string => typeof v === 'string').slice(0, 500))]
    : [...base.excludedFiles]
  return { sources, excludedFiles }
}
export function setContextPreferences(chatId: string, patch: Partial<ContextPreferences>): ContextPreferences {
  assertContextChat(chatId)
  if (!patch || typeof patch !== 'object') throw new Error('Invalid context preferences')
  const preferences = normalizePreferences(patch, getContextPreferences(chatId))
  getDB().prepare('INSERT INTO chat_context_preferences(chat_id, preferences) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET preferences = excluded.preferences')
    .run(chatId, JSON.stringify(preferences))
  return preferences
}
export function assertContextChat(chatId: string): void {
  if (typeof chatId !== 'string' || !getDB().prepare('SELECT id FROM chats WHERE id = ?').get(chatId)) throw new Error('Chat not found')
}
export function setContextMessageHidden(chatId: string, messageId: string, hidden: boolean): boolean {
  assertMessage(chatId, messageId)
  if (typeof hidden !== 'boolean') throw new Error('Invalid hidden flag')
  return setMessageHidden(messageId, hidden)
}
export function setContextMessagePinned(chatId: string, messageId: string, pinned: boolean): boolean {
  assertMessage(chatId, messageId)
  if (typeof pinned !== 'boolean') throw new Error('Invalid pinned flag')
  if (pinned) pinMessage(messageId); else unpinMessage(messageId)
  return true
}
function assertMessage(chatId: string, messageId: string): void {
  assertContextChat(chatId)
  if (!getDB().prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ?').get(messageId, chatId)) throw new Error('Message does not belong to chat')
}
/** Pins survive compact boundaries; hidden takes precedence. Never mutate cached rows. */
export function filterContextHistory(chatId: string, live: Message[], excludeId?: string): Message[] {
  const prefs = getContextPreferences(chatId)
  const rows = new Map<string, Message>()
  if (prefs.sources.history) for (const m of live) rows.set(m.id, m)
  const pins = getDB().prepare('SELECT id FROM messages WHERE chat_id = ? AND is_pinned = 1').all(chatId) as Array<{ id: string }>
  for (const pin of pins) {
    const m = getMessageById(pin.id)
    if (m) rows.set(m.id, m)
  }
  return [...rows.values()]
    .filter(m => m.id !== excludeId && !m.hiddenFromContext && !(m.role === 'system' && m.slashCommand?.name === 'compact'))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map(m => prefs.sources.tools ? m : { ...m, toolSteps: undefined, iterations: undefined, thinkingBlocks: undefined, thinking: undefined })
}
