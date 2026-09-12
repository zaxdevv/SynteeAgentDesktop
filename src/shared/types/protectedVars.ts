/**
 * Protected variables (user secrets) — types shared between main, preload
 * and renderer.
 *
 * Values are stored encrypted (Electron safeStorage / DPAPI) in
 * {userData}/protectedVars.json and injected into the system prompt so the
 * agent can use them (ssh, configs, APIs) without asking the user each time.
 * The renderer NEVER receives decrypted values — only metadata + a mask.
 */

/** Metadata of a protected var as seen by the renderer (no value). */
export interface ProtectedVarMeta {
  id: string
  /** Variable name, e.g. SERVER_IP / SERVER_PASSWORD. */
  key: string
  /** Human description shown in the modal and in the prompt. */
  description?: string
  /** Optional group name — groups related secrets (e.g. "prod-server"). */
  group?: string
  /** Ids of other protected vars this one is linked with. */
  linkedIds: string[]
  /** Whether the var is injected into the system prompt. */
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** Decrypted var for system-prompt injection (main process only). */
export interface ProtectedVarResolved {
  key: string
  value: string
  description?: string
  group?: string
  /** Keys (not ids) of linked vars — for the prompt. */
  linkedKeys: string[]
}

/** Input for protectedVars:save IPC. */
export interface ProtectedVarSaveInput {
  id?: string
  key: string
  /** Empty/undefined on edit = keep the stored value. */
  value?: string
  description?: string
  group?: string
  linkedIds?: string[]
  enabled?: boolean
}
