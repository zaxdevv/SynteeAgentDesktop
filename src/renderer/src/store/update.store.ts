/**
 * Update store — zustand mirror of the main-process UpdateChecker state.
 *
 * The renderer never polls directly: the main process pushes state changes
 * via window.syntee.updates.onStateChanged, and this store subscribes on
 * first access. Components read from the store; the store is the single
 * source of truth for "is there an update?" / "is it force?".
 *
 * The `force` flag on `available` is what the ForceUpdateModal uses to decide
 * whether to render itself as non-dismissable. A force update ignores the
 * dismissed list (handled in the main process: a force manifest always sets
 * status='available', never 'no-update').
 */
import { create } from 'zustand'
import type { QuitAndInstallResult, UpdateManifest, UpdateState } from '../../../shared/types'

interface UpdateStore extends UpdateState {
  /** Hydrate from main on first mount of any component that needs update state. */
  init: () => Promise<void>
  /** Manual re-check (settings "Check now" button). */
  check: () => Promise<void>
  /** Dismiss the current update (badge disappears). No-op for force updates. */
  dismiss: () => Promise<void>
  /**
   * Spawn updater.exe and quit the app so it can apply the update. Resolves
   * with { ok: false, error } when the updater couldn't be started — the app
   * keeps running in that case and the caller should show the error.
   */
  quitAndInstall: () => Promise<QuitAndInstallResult>
}

let initialized = false

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: 'idle',
  available: null,
  dismissed: [],
  lastCheckedAt: 0,
  error: null,

  init: async () => {
    if (initialized) return
    initialized = true
    // Subscribe to pushes from main.
    window.syntee.updates.onStateChanged((state) => set(state))
    // Fetch the initial snapshot.
    const state = await window.syntee.updates.getStatus()
    set(state)
  },

  check: async () => {
    const state = await window.syntee.updates.check()
    set(state)
  },

  dismiss: async () => {
    const { available } = get()
    if (!available) return
    const state = await window.syntee.updates.dismiss(available.version)
    set(state)
  },

  quitAndInstall: async () => {
    return window.syntee.updates.quitAndInstall()
  },
}))

/** Convenience selector: is there a non-dismissed update available? */
export const selectUpdateAvailable = (s: UpdateStore): boolean =>
  s.status === 'available' && s.available !== null

/** Convenience selector: is there a FORCE update (renders non-dismissable modal)? */
export const selectForceUpdate = (s: UpdateStore): UpdateManifest | null =>
  s.status === 'available' && s.available?.force ? s.available : null
