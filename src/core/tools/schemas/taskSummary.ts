export const TASK_SUMMARY_TOOL_SCHEMAS = [{
  type: 'function' as const,
  function: {
    name: 'publish_result',
    description: 'Publish a finished artifact into the per-chat task summary. Use only for a deliverable the user can open, not every changed source file.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short human-readable result name.' },
        kind: { type: 'string', enum: ['file', 'url', 'image'] },
        target: { type: 'string', description: 'Absolute existing local file path or http/https URL.' },
      },
      required: ['title', 'kind', 'target'],
    },
  },
}] as const
