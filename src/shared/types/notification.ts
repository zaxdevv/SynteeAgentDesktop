// ── Notification overlay ────────────────────────────────────────────────

export type NotificationType =
  | 'ai_response'
  | 'agent_done'
  | 'permission'
  | 'ask_user'
  | 'messenger'
  | 'updates'
  | 'system'

export type NotificationPriority = 'info' | 'success' | 'warning' | 'urgent'

export interface NotificationAction {
  id: string
  label: string
  icon?: string
}

/**
 * NotificationPayload — данные уведомления, отправляемые из main-процесса
 * в overlay-окно через IPC_EVENTS.NOTIFICATION_PUSH.
 */
export interface NotificationPayload {
  id: string
  type: NotificationType
  title: string
  body?: string
  icon?: string
  priority: NotificationPriority
  actions: NotificationAction[]
  chatId?: string
  /** Авто-закрытие через N мс (0 = без авто-закрытия). По умолчанию по priority. */
  duration?: number
  /** reqId для permission/ask_user — маппинг ответа обратно к agent flow */
  reqId?: string
}
