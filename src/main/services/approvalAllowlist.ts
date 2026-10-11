import { actionAllowlistKey, classifyTool, normalizeCommandKey } from '../../core/agent/commandSafety'
import type { ApprovalAllowlistEntry, ProjectPermissionOverride } from '../../shared/types'

export interface AllowlistStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

/** Validate and persist a user-confirmed grant in the trusted main process. */
export function persistApprovalGrant(
  store: AllowlistStore,
  input: { toolName: string; args: Record<string, unknown>; chatId: string; projectId?: string; workdir?: string; approved: boolean; always?: string; toolWide?: boolean; role?: string },
): ApprovalAllowlistEntry | undefined {
  const { toolName, args, chatId, projectId, approved, always } = input
  if (!approved || !chatId || !['session', 'project', 'global'].includes(String(always))) return
  if (input.role === 'subagent' && always === 'project') return
  if (always === 'project' && !projectId) return
  const agent = (store.get('agentPermissions') as Record<string, unknown> | undefined) ?? {}
  const projects = (store.get('projectPermissions') as Record<string, ProjectPermissionOverride> | undefined) ?? {}
  const forbiddenPaths = [...((agent.forbiddenPaths as string[] | undefined) ?? []), ...(projectId ? projects[projectId]?.forbiddenPaths ?? [] : [])]
  const safety = classifyTool(toolName, args, { forbiddenPaths, workdir: input.workdir })
  if (safety.level === 'dangerous' || safety.level === 'blocked') return
  const pattern = input.toolWide ? toolName : toolName === 'run_command' ? normalizeCommandKey(String(args.command ?? ''))
    : toolName === 'write_file' || toolName === 'edit_file' ? String(args.path ?? '').trim()
      : actionAllowlistKey(toolName, args)
  if (!pattern) return
  const entry: ApprovalAllowlistEntry = { tool: toolName, pattern, ...(input.toolWide ? { match: 'tool' as const } : {}), scope: always as 'session' | 'project' | 'global', createdAt: Date.now() }
  if (always === 'session') {
    const chats = (store.get('chatApprovalAllowlist') as Record<string, ApprovalAllowlistEntry[]> | undefined) ?? {}
    store.set('chatApprovalAllowlist', { ...chats, [chatId]: [...(chats[chatId] ?? []), entry].slice(-200) })
  } else if (always === 'project') {
    const projects = (store.get('projectPermissions') as Record<string, ProjectPermissionOverride> | undefined) ?? {}
    const current = projects[projectId!] ?? {}
    store.set('projectPermissions', { ...projects, [projectId!]: { ...current, approvalAllowlist: [...(current.approvalAllowlist ?? []), entry].slice(-200) } })
  } else {
    store.set('agentPermissions', { ...agent, approvalAllowlist: [...((agent.approvalAllowlist as ApprovalAllowlistEntry[] | undefined) ?? []), entry].slice(-200) })
  }
  return entry
}
