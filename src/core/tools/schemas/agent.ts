// ── Agent/ask_user tool schemas ──────────────────────────────────────────

export const AGENT_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'spawn_agent',
      description: 'Launch a sub-agent for a subtask with a clean context. Blocks the turn until completion, returns a full summary (what was done, changed files, diffs, executed commands — NOT truncated). The sub-agent ALREADY gets your context (chat summary + working memory + last 12 history messages) — do NOT duplicate it in the task. Use for: independent subtasks (parallel research A and B), long tasks polluting your context, delegating large Todo-plan items. Do NOT use for sequential steps or trivial 1-2 tool tasks (overhead). The task must be self-contained: what to do, file paths, constraints, what to return. Up to the configured maximum agents can run in parallel (see agent settings), then a queue. Do not call get_agent_status in a loop — spawn_agent returns the result itself. By default (isolation=auto) the sub-agent writes to the parent workdir if there are no parallel sub-agents on this project; if there are, it automatically creates a separate git worktree (isolated copy from HEAD) and the delta is merged back after completion.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'A detailed description of the task for the sub-agent' },
          role: {
            type: 'string',
            enum: ['researcher', 'deep-researcher', 'editor', 'implementer', 'reviewer'],
            description: 'Sub-agent role determines available tools and built-in system prompt. researcher — read-only code investigation (no edits, no commands); deep-researcher — read-only + web search/HTTP for external research; editor — read + edit files (no run_command, verify via get_diagnostics); implementer — full capabilities (read + edit + run_command, default); reviewer — read-only code review. Choose the most restrictive role that can accomplish the task.',
          },
          approval_mode: { type: 'string', enum: ['auto', 'ask', 'full'], description: 'Sub-agent approval mode (default: inherited from parent). full — no confirmations, ask — per tool, auto — smart detection' },
          isolation: { type: 'string', enum: ['auto', 'worktree', 'none'], description: 'Sub-agent file isolation. auto (default) — worktree only if there is a parallel sub-agent on this workdir, otherwise shared (sees parent WIP); worktree — always a separate git worktree from HEAD (for independent tasks: the sub-agent does not see the parent uncommitted edits, the delta is merged via git apply --3way); none — explicitly write to the parent workdir (only for dependent/read-only tasks). Non-git workdir always falls back to shared.' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_agent_status',
      description: 'Check the status of a sub-agent — whether it is active, what it is doing now, how many steps it has done. Use rarely — spawn_agent waits for completion itself. Useful only for UI or to check the progress of an already-finished agent.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Sub-agent ID from the [AGENT:id] marker' },
        },
        required: ['agent_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ask_user',
      description: 'Ask the user clarifying questions and get answers. Use when inputs are insufficient for a quality answer: unclear task scope, need constraints/priorities, choosing between alternatives. Supports different question types (text/choice/yesno), conditional logic (showIf), pre-fill. You can ask up to 5 questions — the user answers one by one (wizard). Do NOT overuse: if you can assume — do it, do not ask. After answers, continue work with the received info in mind.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'List of questions (1-5). The user answers one by one (wizard).',
            minItems: 1,
            maxItems: 5,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Question ID. Used for answer mapping and for showIf (conditions of other questions).' },
                question: { type: 'string', description: 'Question text for the user.' },
                header: { type: 'string', description: 'Short heading (optional).' },
                type: {
                  type: 'string',
                  enum: ['text', 'choice', 'yesno'],
                  description: 'Question type. text (default) — free answer. choice — choose from options (radio/checkbox). yesno — Yes/No buttons. If not specified, auto-detect: has options → choice, otherwise text.',
                },
                options: {
                  type: 'array',
                  description: 'Ready answer options (for type=choice).',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string', description: 'Option value (for mapping).' },
                      label: { type: 'string', description: 'Option display text.' },
                      description: { type: 'string', description: 'Option explanation (optional).' },
                    },
                    required: ['value', 'label'],
                  },
                },
                multiple: { type: 'boolean', description: 'Allow multi-select (only for type=choice).' },
                allowCustom: { type: 'boolean', description: 'Allow a custom answer (default true). Ignored for yesno.' },
                required: { type: 'boolean', description: 'Mandatory question (cannot skip).' },
                placeholder: { type: 'string', description: 'Custom placeholder for the text field (e.g. "port 3000").' },
                helpText: { type: 'string', description: 'Explanation under the question (collapsible block). For extra context.' },
                multiline: { type: 'boolean', description: 'Multi-line field 5+ lines (for descriptive answers).' },
                skipLabel: { type: 'string', description: 'Custom skip button text (default "Skip"). E.g. "I don\'t know", "You decide".' },
                showIf: {
                  type: 'object',
                  description: 'Show condition — the question is hidden until the answer to questionId equals equals. For branching: do not ask about CI if the answer to "need tests" = "no".',
                  properties: {
                    questionId: { type: 'string', description: 'ID of the question whose answer is checked.' },
                    equals: {
                      type: 'string',
                      description: 'Value at which this question is shown. For yesno — "true"/"false".',
                    },
                  },
                  required: ['questionId', 'equals'],
                },
              },
              required: ['question'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
] as const
