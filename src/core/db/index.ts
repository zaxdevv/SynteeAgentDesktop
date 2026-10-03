// Barrel-модуль: реэкспортирует все DB-функции и типы из доменных модулей.
// Внешние импортёры (chat.ipc, fs.ipc, fastContext.ipc, mcp.ipc, skills.ipc,
// fastContextWatcher) импортируют отсюда — public API сохранён.
//
// Структура:
//   handle.ts          — singleton DB-хендл + initDB()
//   migrations.ts      — идемпотентная схема-миграция
//   chats.ts           — CRUD чатов
//   projects.ts        — CRUD проектов
//   messages.ts        — сообщения (saveMessage/getMessages/...)
//   attachments.ts     — вложения черновика (draft attachments, переживают рестарт)
//   memory.ts          — clipboard/agent_logs/working_memory/summaries
//                         (memory CRUD перенесён в memory/MemoryStore.ts)
//   checkpoints.ts     — file_snapshots/context_snapshots/checkpoints/rewind_history
//   fastContextStore.ts — fast_context_index + history + relevance_boost

export * from './handle'
export * from './migrations'
export * from './chats'
export * from './projects'
export * from './messages'
export * from './streamingBuffers'
export * from './attachments'
export * from './memory'
export * from './checkpoints'
export * from './snapshotPaths'
export * from './fastContextStore'
export * from './subagents'
export * from './dots'
