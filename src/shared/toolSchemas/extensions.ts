// ── Extensions (MCP/skills) tool schemas ────────────────────────────────

export const EXTENSIONS_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'list_extensions',
      description: 'List extensions. For a compact, paged skill search use scope="skills", query and offset. Use get_skill for full instructions.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['all', 'skills'] },
          query: { type: 'string', description: 'Skill keywords. Empty lists skills in order.' },
          offset: { type: 'integer', minimum: 0, description: 'Next offset from the previous page.' },
        },
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
