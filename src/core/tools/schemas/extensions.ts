// ── Extensions (MCP/skills) tool schemas ────────────────────────────────

export const EXTENSIONS_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'list_extensions',
      description: 'Show installed extensions: MCP servers (connection status, tool list) and all skills (name, description, active). Use when you need to know your capabilities.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_skill',
      description: 'Get the full instructions of a skill by its name (from the list_extensions list). Returns the instruction text that must be followed in the work. Use when you see a needed skill in the list and want to apply its instructions.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name (exact match with the name from list_extensions)',
          },
        },
        required: ['name'],
      },
    },
  },
] as const
