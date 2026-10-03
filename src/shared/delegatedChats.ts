/** One tool, multiple operations. Request IDs are assistant-message IDs. */
export interface ManageChatsParams {
  action: 'create' | 'send' | 'status' | 'read' | 'list' | 'stop'
  chat_id?: string
  request_id?: string
  title?: string
  message?: string
  view?: 'result' | 'history'
  limit?: number
  offset?: number
  max_chars?: number
}

export interface ManageChatsResult {
  success: boolean
  output: string
  error?: string
}

export type DelegatedRequestStatus = 'starting' | 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted'
