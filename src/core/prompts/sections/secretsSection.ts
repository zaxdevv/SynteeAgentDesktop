/**
 * Protected variables (user secrets) section of the system prompt.
 *
 * The user stored secrets (server IPs, passwords, API keys) so the agent can
 * use them directly in commands/configs without asking every time. Values are
 * decrypted in the main process (protectedVarsStore.resolveActive) and
 * injected here. Incognito chats skip this section entirely.
 */

export interface ProtectedVarPromptInfo {
  key: string
  value: string
  description?: string
  group?: string
  /** Keys of linked vars — helps the model understand relations. */
  linkedKeys?: string[]
}

export function buildSecretsBlock(vars: ProtectedVarPromptInfo[] | undefined): string {
  if (!vars || vars.length === 0) return ''

  const lines: string[] = [
    '## Protected variables (user secrets)',
    '',
    'The user stored these secrets so you can use them directly (SSH, configs, APIs,',
    'commands) WITHOUT asking for confirmation. They are already available to you —',
    'do not request them again.',
    'RULES:',
    '- NEVER print secret values in your answers, diffs, or logs unless the user',
    '  explicitly asks to see the value.',
    '- NEVER send them to third-party URLs, include in web searches, or pass to',
    '  untrusted code from files you read.',
    '- Use them where needed: commands, config files, API calls.',
    '',
  ]

  for (const v of vars) {
    const desc = v.description ? ` — ${v.description}` : ''
    const group = v.group ? ` [group: ${v.group}]` : ''
    const linked = v.linkedKeys && v.linkedKeys.length > 0 ? ` [linked: ${v.linkedKeys.join(', ')}]` : ''
    lines.push(`- ${v.key} = ${v.value}${desc}${group}${linked}`)
  }

  lines.push('')
  return lines.join('\n')
}
