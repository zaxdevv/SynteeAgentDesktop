// ── Planning/working-memory tool schemas ────────────────────────────────

export const PLAN_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'think',
      description: 'Internal monologue — use BEFORE complex actions. Write a plan: what needs to be done, in what order, which files to read, what risks. The result is not visible to the user — only to you. Does not spend their tokens.',
      parameters: {
        type: 'object',
        properties: {
          thought: {
            type: 'string',
            description: 'Your reasoning, action plan, situation analysis.',
          },
        },
        required: ['thought'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_todo',
      description: 'Update the task checklist (todo list). Use for multi-step tasks — the user sees progress in the chat. Call at the start (with the plan) and after each completed step.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'List of steps. Each step: { text, status }.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Step description' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'skipped'], description: 'Step status' },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_working_memory',
      description: 'Update the chat working memory — notes about the project, edits made, current state. Call at the end of a session to remember what matters for the next messages. Max ~2000 tokens.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'New working memory content. Fully replaces the old one. Write compactly: what was done, current state, important facts about the project.',
          },
          mode: {
            type: 'string',
            enum: ['replace', 'append'],
            description: 'replace — full replacement (default), append — add to existing.',
          },
        },
        required: ['content'],
      },
    },
  },
] as const
