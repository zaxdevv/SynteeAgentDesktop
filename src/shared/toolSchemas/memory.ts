// ── Memory tool schemas ──────────────────────────────────────────────────

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
      description: 'Retrieve a specific prior fact or decision needed for the current task and missing from the conversation. Search saved memory, prior chat messages and summaries, agent logs, pinned messages and the project graph. Give a focused query with the feature, file or error in question. Use for requests such as "what did we decide about JWT expiry?". Answer standalone questions, model identity and small talk directly.',
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
] as const
