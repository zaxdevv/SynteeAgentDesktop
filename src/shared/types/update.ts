// ── Client auto-update (SynteeHelper desktop) ────────────────────────────
// Mirrors the manifest returned by GET /api/public/updates/check on the
// gateway. The launcher (syntee-launcher, Go) does the actual download+apply;
// this in-app checker only displays UI and triggers quitAndInstall().

export interface UpdateManifest {
  version: string
  channel: string
  zip_url: string
  zip_size: number
  sha256: string
  force: boolean
  min_version: string | null
  changelog: string | null
  released_at: string
}

export interface ChangelogEntry {
  version: string
  changelog: string | null
  released_at: string
  force: boolean
  is_current: boolean
}

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'no-update' | 'error'

export interface UpdateState {
  status: UpdateStatus
  available: UpdateManifest | null
  dismissed: string[]
  lastCheckedAt: number
  error: string | null
}

/**
 * Result of the quit-and-install flow (updates:quitAndInstall IPC). When
 * ok=false the app did NOT exit and the updater never started — the UI shows
 * `error` and lets the user retry instead of dying silently.
 */
export interface QuitAndInstallResult {
  ok: boolean
  error?: string
}
