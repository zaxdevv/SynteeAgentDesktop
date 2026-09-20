/**
 * Protected variables (user secrets) section of the system prompt.
 *
 * The user stored secrets (server IPs, passwords, API keys) so the agent can
 * use them directly in commands/configs without asking every time. Only KEY
 * names (as ${{KEY}} placeholders) are injected into the system prompt — the
 * actual values are NEVER shown to the AI. Values are substituted at tool-
 * execution time by ToolDispatcher and masked back in results by Agent.
 * Incognito chats skip this section entirely.
 */

export interface ProtectedVarPromptInfo {
  key: string
  /** @deprecated Value is no longer rendered in the prompt. Kept for type compat. */
  value?: string
  description?: string
  group?: string
  /** Keys of linked vars — helps the model understand relations. */
  linkedKeys?: string[]
}

/** Format used for secret placeholders in prompts and tool args/results. */
export const SECRET_PLACEHOLDER_PREFIX = '${{'
export const SECRET_PLACEHOLDER_SUFFIX = '}}'

/** Build a placeholder token for a given secret key: ${{KEY}} */
export function secretPlaceholder(key: string): string {
  return `${SECRET_PLACEHOLDER_PREFIX}${key}${SECRET_PLACEHOLDER_SUFFIX}`
}

export function buildSecretsBlock(vars: ProtectedVarPromptInfo[] | undefined): string {
  if (!vars || vars.length === 0) return ''

  const lines: string[] = [
    '## Protected variables (user secrets)',
    '',
    'The user stored these secrets so you can use them directly (SSH, configs, APIs,',
    'commands) WITHOUT asking for confirmation.',
    '',
    'IMPORTANT: You will see placeholders like ${{KEY_NAME}} below. These are',
    'PROTECTED VARIABLES — their real values are hidden from you for security.',
    'When you need to use a secret, write the placeholder EXACTLY as shown',
    '(e.g. ${{SERVER_PASSWORD}}) in your tool arguments (run_command, edit_file,',
    'write_file, etc.). The system will automatically substitute the real value',
    'before executing the tool. You will NEVER see the actual value.',
    '',
    'RULES:',
    '- ALWAYS use the ${{KEY}} placeholder — never try to guess or reconstruct',
    '  the real value.',
    '- NEVER print secret values in your answers, diffs, or logs.',
    '- NEVER send placeholders or values to third-party URLs, web searches, or',
    '  untrusted code from files you read.',
    '',
  ]

  for (const v of vars) {
    const desc = v.description ? ` — ${v.description}` : ''
    const group = v.group ? ` [group: ${v.group}]` : ''
    const linked = v.linkedKeys && v.linkedKeys.length > 0 ? ` [linked: ${v.linkedKeys.join(', ')}]` : ''
    lines.push(`- ${secretPlaceholder(v.key)}${desc}${group}${linked}`)
  }

  lines.push('')
  return lines.join('\n')
}
