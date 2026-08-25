import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { qk } from '@/api/queryKeys'
import {
  getConfig,
  setConfig,
  getAuditStatus,
  toggleAudit,
  exportUsage,
  getNotificationConfig,
  setNotificationConfig,
  getGlobalChatFlag,
  setGlobalChatFlag,
  getLauncherFlag,
  setLauncherFlag,
  getResponseCacheFlag,
  setResponseCacheFlag,
} from '@/api/config'
import type { NotificationConfig } from '@/api/types'

export function useConfigQuery() {
  return useQuery({
    queryKey: qk.config,
    queryFn: getConfig,
  })
}

export function useSetConfigMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: Record<string, unknown> }) =>
      setConfig(key, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.config }),
  })
}

export function useAuditStatusQuery() {
  return useQuery({
    queryKey: qk.audit,
    queryFn: getAuditStatus,
  })
}

export function useToggleAuditMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) => toggleAudit(enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.audit }),
  })
}

export function useExportUsageMutation() {
  return useMutation({
    mutationFn: ({ format, hours, limit }: { format: string; hours: number; limit: number }) =>
      exportUsage(format, hours, limit),
  })
}

export function useNotificationConfigQuery() {
  return useQuery({
    queryKey: qk.notificationConfig,
    queryFn: getNotificationConfig,
  })
}

export function useSetNotificationConfigMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cfg: Partial<NotificationConfig>) => setNotificationConfig(cfg),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.notificationConfig }),
  })
}

export function useGlobalChatFlagQuery() {
  return useQuery({
    queryKey: qk.globalChatFlag,
    queryFn: getGlobalChatFlag,
  })
}

export function useSetGlobalChatFlagMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) => setGlobalChatFlag(enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.globalChatFlag }),
  })
}

export function useLauncherFlagQuery() {
  return useQuery({
    queryKey: qk.launcherFlag,
    queryFn: getLauncherFlag,
  })
}

export function useSetLauncherFlagMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) => setLauncherFlag(enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.launcherFlag }),
  })
}

export function useResponseCacheFlagQuery() {
  return useQuery({
    queryKey: ['config', 'response-cache'],
    queryFn: getResponseCacheFlag,
  })
}

export function useSetResponseCacheFlagMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) => setResponseCacheFlag(enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config', 'response-cache'] }),
  })
}
