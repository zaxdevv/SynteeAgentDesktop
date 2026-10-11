import { getDB } from './handle'
import type { DelegatedRequestStatus } from '../../shared/delegatedChats'
import type { ChatMode } from '../../shared/types'

export interface DelegatedChatRow {
  id: string
  title: string
  projectId?: string
  mode: ChatMode
  isIncognito: number
}
export interface DelegatedRequest {
  requestId: string
  chatId: string
  sourceChatId: string
  userMessageId: string
  status: DelegatedRequestStatus
  error?: string
  task?: string
  sourceMessageId?: string
  readAt?: number
  createdAt: number
  updatedAt: number
}

export function getDelegationChat(chatId: string): DelegatedChatRow | undefined {
  return getDB().prepare(`SELECT id, title, project_id as projectId, mode, is_incognito as isIncognito
    FROM chats WHERE id = ?`).get(chatId) as DelegatedChatRow | undefined
}
export function linkDelegatedChat(chatId: string, parentChatId: string, sourceMessageId?: string): void {
  getDB().prepare('INSERT INTO delegated_chats (chat_id, parent_chat_id, created_at, source_message_id) VALUES (?, ?, ?, ?)')
    .run(chatId, parentChatId, Date.now(), sourceMessageId ?? '')
}
export function listDelegatedChatCreations(parentChatId: string): Array<{ chatId: string; sourceMessageId: string; createdAt: number; title: string }> {
  return getDB().prepare(`SELECT d.chat_id as chatId, d.source_message_id as sourceMessageId, d.created_at as createdAt, c.title
    FROM delegated_chats d JOIN chats c ON c.id=d.chat_id
    WHERE d.parent_chat_id=? AND c.is_incognito=0`).all(parentChatId) as Array<{ chatId: string; sourceMessageId: string; createdAt: number; title: string }>
}
export function getDelegationParent(chatId: string): string | undefined {
  return (getDB().prepare('SELECT parent_chat_id as id FROM delegated_chats WHERE chat_id = ?')
    .get(chatId) as { id: string } | undefined)?.id
}
export function ownsDelegatedChat(parentChatId: string, chatId: string): boolean {
  return getDelegationParent(chatId) === parentChatId
}
export function listDelegatedChats(parentChatId: string, limit: number): DelegatedChatRow[] {
  return getDB().prepare(`SELECT c.id, c.title, c.project_id as projectId, c.mode, c.is_incognito as isIncognito
    FROM delegated_chats d JOIN chats c ON c.id = d.chat_id
    WHERE d.parent_chat_id = ? ORDER BY d.created_at DESC LIMIT ?`).all(parentChatId, limit) as DelegatedChatRow[]
}
const REQUEST_COLS = `request_id as requestId, chat_id as chatId, source_chat_id as sourceChatId,
  user_message_id as userMessageId, status, error, task, source_message_id as sourceMessageId,
  read_at as readAt, created_at as createdAt, updated_at as updatedAt`
export function getDelegatedRequest(chatId: string, requestId?: string): DelegatedRequest | undefined {
  return getDB().prepare(`SELECT ${REQUEST_COLS} FROM delegated_chat_requests WHERE chat_id = ?
    ${requestId ? 'AND request_id = ?' : 'ORDER BY created_at DESC, rowid DESC LIMIT 1'}`)
    .get(...(requestId ? [chatId, requestId] : [chatId])) as DelegatedRequest | undefined
}
export function listDelegatedRequests(sourceChatId: string): DelegatedRequest[] {
  return getDB().prepare(`SELECT ${REQUEST_COLS} FROM delegated_chat_requests WHERE source_chat_id = ? ORDER BY created_at`).all(sourceChatId) as DelegatedRequest[]
}
export function markDelegatedRequestRead(chatId: string, requestId: string): void {
  getDB().prepare('UPDATE delegated_chat_requests SET read_at = ? WHERE chat_id = ? AND request_id = ?').run(Date.now(), chatId, requestId)
}
export function saveDelegatedRequest(request: DelegatedRequest): void {
  getDB().prepare(`INSERT INTO delegated_chat_requests
    (request_id, chat_id, source_chat_id, user_message_id, status, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(request.requestId, request.chatId, request.sourceChatId,
      request.userMessageId, request.status, request.error ?? null, request.createdAt, request.updatedAt)
  getDB().prepare('UPDATE delegated_chat_requests SET task = ?, source_message_id = ? WHERE request_id = ?')
    .run(request.task ?? '', request.sourceMessageId ?? '', request.requestId)
}
export function updateDelegatedRequest(requestId: string, status: DelegatedRequestStatus, error?: string): void {
  getDB().prepare('UPDATE delegated_chat_requests SET status = ?, error = ?, updated_at = ? WHERE request_id = ?')
    .run(status, error ?? null, Date.now(), requestId)
}
export function countPendingDelegations(sourceChatId?: string): number {
  const sql = `SELECT COUNT(*) as n FROM delegated_chat_requests WHERE status IN ('starting','queued','running')`
  const row = (sourceChatId
    ? getDB().prepare(`${sql} AND source_chat_id = ?`).get(sourceChatId)
    : getDB().prepare(sql).get()) as { n: number }
  return row.n
}
/** Called once per main-process startup; queues/workers do not survive a restart. */
export function recoverDelegatedRequests(): void {
  getDB().prepare(`UPDATE delegated_chat_requests SET status = 'interrupted',
    error = 'Application restarted before the request completed', updated_at = ?
    WHERE status IN ('starting','queued','running')`).run(Date.now())
}
