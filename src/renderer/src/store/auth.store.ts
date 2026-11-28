import { create } from 'zustand'

export interface GatewayUser {
  id: string
  email: string
  username?: string | null
  username_is_auto?: boolean
  role: string
  display_name?: string | null
  avatar_url?: string | null
}

export type AuthAvailability = 'unknown' | 'authenticated' | 'unavailable' | 'unauthenticated'

interface AuthStore {
  user: GatewayUser | null
  loading: boolean
  error: string | null
  availability: AuthAvailability
  load: (force?: boolean) => Promise<void>
  clearSession: () => void
  markUnavailable: () => void
  logout: () => Promise<void>
  clearError: () => void
}

let pendingProfile: Promise<void> | undefined
let profileGeneration = 0

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  loading: false,
  error: null,
  availability: 'unknown',

  load: (force = false) => {
    if (pendingProfile && !force) return pendingProfile
    if (force) {
      profileGeneration++
      set({ user: null, availability: 'unknown' })
    }
    const generation = profileGeneration
    set({ loading: true, error: null })
    const pending = Promise.resolve().then(async () => {
      const result = await window.syntee.auth.me()
      if (profileGeneration !== generation) return
      // auth:me сохраняет токены при offline/5xx и сообщает, что сессия
      // временно недоступна. Не превращаем это в локальный logout.
      if (result && typeof result === 'object' && 'status' in result) {
        set(state => ({
          user: result.status === 'unavailable' ? state.user : result.user ?? null,
          loading: false,
          availability: result.status,
        }))
      } else {
        // Совместимость со старым preload/кэшем приложения.
        set({ user: result ?? null, loading: false, availability: result ? 'authenticated' : 'unauthenticated' })
      }
    }).catch(err => {
      if (profileGeneration !== generation) return
      set({
        loading: false,
        availability: 'unavailable',
        error: err instanceof Error ? err.message : 'Failed to load user',
      })
    }).finally(() => {
      if (pendingProfile === pending) pendingProfile = undefined
    })
    pendingProfile = pending
    return pending
  },

  clearSession: () => {
    profileGeneration++
    pendingProfile = undefined
    set({ user: null, loading: false, error: null, availability: 'unauthenticated' })
  },

  markUnavailable: () => set(state => (
    state.availability === 'unauthenticated'
      ? state
      : { availability: 'unavailable' }
  )),

  logout: async () => {
    await window.syntee.auth.logout()
    useAuthStore.getState().clearSession()
  },

  clearError: () => set({ error: null }),
}))
