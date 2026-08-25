import { api } from './client'
import type { ConfigEntry, NotificationConfig } from './types'

export async function getConfig(): Promise<ConfigEntry[]> {
  const { data } = await api.get<ConfigEntry[]>('/api/admin/config')
  return data
}

export async function setConfig(
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  await api.put(`/api/admin/config/${key}`, { value })
}

export async function getAuditStatus(): Promise<{ enabled: boolean }> {
  const { data } = await api.get<{ enabled: boolean }>('/api/admin/audit/status')
  return data
}

export async function toggleAudit(enabled: boolean): Promise<void> {
  await api.put('/api/admin/audit/toggle', null, { params: { enabled } })
}

export async function exportUsage(
  format: string,
  hours: number,
  limit: number,
): Promise<string | Record<string, unknown>> {
  const { data } = await api.get('/api/admin/export/usage', {
    params: { format, hours, limit },
    transformResponse: [(d) => d],
  })
  return data
}

export async function getNotificationConfig(): Promise<NotificationConfig> {
  const { data } = await api.get<NotificationConfig>('/api/admin/config/notifications')
  return data
}

export async function setNotificationConfig(cfg: Partial<NotificationConfig>): Promise<{ status: string; config: NotificationConfig }> {
  const { data } = await api.put('/api/admin/config/notifications', cfg)
  return data
}

export async function getGlobalChatFlag(): Promise<{ enabled: boolean }> {
  const { data } = await api.get<{ enabled: boolean }>('/api/admin/config/global-chat')
  return data
}

export async function setGlobalChatFlag(enabled: boolean): Promise<{ enabled: boolean }> {
  const { data } = await api.put<{ enabled: boolean }>('/api/admin/config/global-chat', { enabled })
  return data
}

export async function getLauncherFlag(): Promise<{ enabled: boolean }> {
  const { data } = await api.get<{ enabled: boolean }>('/api/admin/config/launcher')
  return data
}

export async function setLauncherFlag(enabled: boolean): Promise<{ enabled: boolean }> {
  const { data } = await api.put<{ enabled: boolean }>('/api/admin/config/launcher', { enabled })
  return data
}

export async function getResponseCacheFlag(): Promise<{ enabled: boolean }> {
  const { data } = await api.get<{ enabled: boolean }>('/api/admin/config/response-cache')
  return data
}

export async function setResponseCacheFlag(enabled: boolean): Promise<{ enabled: boolean }> {
  const { data } = await api.put<{ enabled: boolean }>('/api/admin/config/response-cache', { enabled })
  return data
}
