import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { getGlobalMemoryEnabled } from './globalMemorySettings'

export interface MemoryEntry {
  id: string
  category: 'personal' | 'work' | 'preferences' | 'projects' | 'facts'
  key: string
  value: string
  confidence: number
  source: string
  createdAt: number
  updatedAt: number
}

let db: Database.Database | null = null

function getDB(): Database.Database {
  if (db) return db
  const dataPath = app.getPath('userData')
  const instance: Database.Database = new (require('better-sqlite3'))(join(dataPath, 'memory.db'))
  instance.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      source TEXT DEFAULT 'user',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_key ON memories(key);
  `)
  db = instance
  return instance
}

export function saveMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): MemoryEntry {
  // The legacy store is global by design. Never let automatic agent extraction
  // bypass the global-memory toggle; explicit UI management uses memory_items.
  if (!getGlobalMemoryEnabled() && entry.source !== 'user_manual') {
    throw new Error('Глобальная память выключена: сохранение агентом запрещено')
  }
  const d = getDB()
  const now = Date.now()
  // Проверяем существующую запись по ключу
  const existing = d.prepare('SELECT * FROM memories WHERE key = ?').get(entry.key) as MemoryEntry | undefined
  if (existing) {
    d.prepare('UPDATE memories SET value = ?, confidence = ?, updatedAt = ? WHERE key = ?')
      .run(entry.value, entry.confidence, now, entry.key)
    return { ...existing, value: entry.value, updatedAt: now }
  }
  const id = require('uuid').v4()
  const row = { ...entry, id, createdAt: now, updatedAt: now }
  d.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?)').run(
    row.id, row.category, row.key, row.value, row.confidence, row.source, row.createdAt, row.updatedAt
  )
  return row
}

export function getMemories(category?: string): MemoryEntry[] {
  if (!getGlobalMemoryEnabled()) return []
  const d = getDB()
  if (category) {
    return d.prepare('SELECT * FROM memories WHERE category = ? ORDER BY updatedAt DESC').all(category) as MemoryEntry[]
  }
  return d.prepare('SELECT * FROM memories ORDER BY updatedAt DESC').all() as MemoryEntry[]
}

export function deleteMemory(id: string): void {
  getDB().prepare('DELETE FROM memories WHERE id = ?').run(id)
}

export function searchMemories(query: string): MemoryEntry[] {
  if (!getGlobalMemoryEnabled()) return []
  const d = getDB()
  const q = `%${query}%`
  return d.prepare('SELECT * FROM memories WHERE key LIKE ? OR value LIKE ? ORDER BY updatedAt DESC LIMIT 20').all(q, q) as MemoryEntry[]
}

export function getAllMemoriesForContext(): string {
  const memories = getMemories()
  if (!memories.length) return ''
  const grouped: Record<string, string[]> = {}
  for (const m of memories) {
    if (!grouped[m.category]) grouped[m.category] = []
    grouped[m.category].push(`${m.key}: ${m.value}`)
  }
  const lines: string[] = ['[Память о пользователе]']
  const labels: Record<string, string> = {
    personal: 'Личное', work: 'Работа', preferences: 'Предпочтения',
    projects: 'Проекты', facts: 'Факты'
  }
  for (const [cat, items] of Object.entries(grouped)) {
    lines.push(`${labels[cat] || cat}: ${items.join('; ')}`)
  }
  return lines.join('\n')
}

// Парсим ответ AI на предмет новых фактов для запоминания
export function extractMemoriesFromConversation(
  userMessage: string,
  // Раньше использовался как fallback-источник имени пользователя (см.
  // комментарий ниже) — оставлен в сигнатуре для совместимости с вызывающим
  // кодом (chat.ipc.ts передаёт fullText), но больше не читается.
  _assistantResponse: string
): Array<Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>> {
  const memories: Array<Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>> = []

  // Ищем явные команды "запомни"
  const rememberMatch = userMessage.match(/запомни[,:]?\s+(.+)/i)
  if (rememberMatch) {
    memories.push({
      category: 'facts',
      key: rememberMatch[1].slice(0, 60),
      value: rememberMatch[1],
      confidence: 1.0,
      source: 'user_explicit',
    })
  }

  // Ищем имя пользователя — только явное "меня зовут X" в сообщении
  // пользователя. Раньше здесь был fallback на первое слово перед запятой/!
  // в ОТВЕТЕ АГЕНТА (assistantResponse.match(/(\w+)[,!]/i)) — это ловило
  // случайные слова типа "Хорошо," или "Отлично!" и сохраняло их как имя
  // пользователя с confidence 0.9, перезаписывая реальное имя и заставляя
  // агента обращаться к пользователю неправильно в следующих сообщениях.
  const nameMatch = userMessage.match(/меня зовут\s+(\w+)/i)
  if (nameMatch && nameMatch[1].length > 2) {
    memories.push({
      category: 'personal',
      key: 'имя',
      value: nameMatch[1],
      confidence: 0.9,
      source: 'inferred',
    })
  }

  return memories
}
