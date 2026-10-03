// ── Memory/notes/graph tool schemas ──────────────────────────────────────

export const MEMORY_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save a fact to long-term memory (survives sessions). Use when you learned something important: user preferences, a project architectural decision, a learned lesson. Unlike update_working_memory (this chat only), save_memory is available across sessions. Scope auto: project if projectId exists, otherwise global. Dedup by key or semantic similarity.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short entry name (1-5 words, required). Will be shown as a heading. E.g. "Auth architecture", "Language preferences", "Outcome: FTS5 migration".' },
          content: { type: 'string', description: 'Detailed description. Can be long, with details, lists, files. Markdown is supported. E.g. "Decided to use JWT + refresh tokens.\\n- Access token: 15min\\n- Refresh token: 7days\\n- Stored in httpOnly cookies".' },
          kind: { type: 'string', enum: ['user_fact', 'project_decision', 'convention', 'conversation', 'agent_outcome'], description: 'user_fact — about the user (personal, preferences); project_decision — project architectural decision; convention — gotchas/traps/non-obvious project rules; conversation — dialog outcome; agent_outcome — lesson from an action outcome.' },
          key: { type: 'string', description: 'Dedup key (optional). If an entry with the same key exists — it will be updated. E.g. "name", "preferred_stack", "auth_approach".' },
          category: { type: 'string', description: '[user_fact] Subcategory: personal/work/preferences/projects/facts.' },
          scope: { type: 'string', enum: ['global', 'project'], description: 'global — memory across all projects; project — bound to the current project. Default: project if projectId exists, otherwise global.' },
          importance: { type: 'number', description: 'Importance 0..1 (default 0.5). Higher = ranks higher, lives longer. 1.0 for critical facts.' },
        },
        required: ['title', 'content', 'kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: 'Find relevant memories and past context. Hybrid search — semantic (multilingual E5 embeddings: matches by MEANING — synonyms, paraphrasing, RU/EN mix) + lexical (FTS5/TF-IDF: exact words) — across 5 sources IN PARALLEL: (1) long-term memory — facts/decisions/conventions/dialog outcomes, (2) messages of all chats in scope, (3) chat summaries — compact outcomes of long dialogs, (4) agent action logs — which tools were called, errors, (5) pinned messages. Results containing exact technical tokens from the query (file paths, function names, error codes, hashes) get a relevance boost. Additionally searches the knowledge graph DIRECTLY: matching files/decisions/concepts appear with their connections (e.g. "contextManager.ts →imports→ embeddings.ts, →calls→ cosineSimilarity") as [graph] entries — this gives you a map of project structure without calling any extra tool. MMR diversification removes duplicate topics. Scope: if in a project — searches this project chats; if not — chats without a project. Global memory is ALWAYS in the search. Returns top-20 results sorted by hybrid relevance score.\n\nWHEN TO USE: start of a new task (especially in a project), "do you remember?", "how we did", "what we decided on X", unfamiliar project/file, a past decision/error mentioned, before an architectural decision.\n\nHOW TO WRITE THE QUERY: a natural phrase or question works ("how did we speed up file indexing?", "проблемы с авторизацией"), keywords also fine ("JWT authorization", "ESLint timeout error"). Semantic search understands meaning, not just exact words. Only avoid vague mega-queries like "tell me everything you know about the project" — a specific topic ranks much better.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query — a natural phrase, question or keywords. E.g. "how we solved the FTS5 migration", "JWT authorization", "почему падает ESLint". Semantic channel understands meaning, not just exact words.' },
          kind: { type: 'string', enum: ['user_fact', 'project_decision', 'convention', 'conversation', 'agent_outcome'], description: 'Filter by memory type (optional). Without a filter — searches all types. Applies only to the "memory" source.' },
          scope: { type: 'string', enum: ['global', 'project', 'all'], description: 'Where to search in memory_items: global — only global; project — only current project; all — both (default). Does not affect chat sources.' },
          sources: { type: 'array', items: { type: 'string', enum: ['memory', 'messages', 'summaries', 'agent_logs', 'pinned'] }, description: 'Which sources to search (default: all 5). E.g. ["memory","messages"] — only memory and messages. Narrow if you know exactly what you need.' },
          limit: { type: 'number', description: 'How many entries to return (default 20, max 30). 5 per source if all 5 are enabled.' },
          crossProject: { type: 'boolean', description: 'If true, search across ALL projects (not just the current one). Default: false. Useful when the topic may span multiple projects.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_notes',
      description: 'Manage notes for the project or chat. Actions: create, update, delete, list. Project notes are visible in all chats of the project (shown in system prompt). Chat notes are specific to the current chat. Use for remembering important project facts, decisions, or context that should persist across sessions. Max 15 project notes — use sparingly, only for important information.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'delete', 'list'], description: 'What to do: create a new note, update an existing one, delete one, or list all notes.' },
          scope: { type: 'string', enum: ['project', 'chat'], description: 'project — note visible in all chats of this project; chat — note only for the current chat.' },
          title: { type: 'string', description: '[create/update] Note title (1-100 chars). Required for create, optional for update.' },
          content: { type: 'string', description: '[create/update] Note body text. Markdown supported. Optional for update (omit to keep existing).' },
          note_id: { type: 'string', description: '[update/delete] ID of the note to update or delete.' },
        },
        required: ['action', 'scope'],
      },
    },
  },
] as const
