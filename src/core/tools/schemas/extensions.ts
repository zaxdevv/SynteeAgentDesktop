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
      description: 'Get the full instructions of a skill by name or exact id from list_extensions. Returns the source file and base directory for resolving relative links to package materials. Read linked files only when needed. Use exact id if names are duplicated.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name or exact id from list_extensions (id disambiguates duplicate names)',
          },
        },
        required: ['name'],
      },
    },
  },
] as const
