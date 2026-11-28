/**
 * Encrypted token storage for Syntee-Gateway JWTs.
 *
 * Uses Electron's safeStorage (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux) to encrypt access/refresh tokens at rest. Falls back
 * to plaintext with a console warning on platforms where safeStorage is not
 * available (e.g. headless Linux without a keyring daemon).
 *
 * Tokens live in a separate electron-store file (`auth.json`) so they are
 * not interleaved with the main app config.
 */
import Store from 'electron-store'
import { safeStorage } from 'electron'

interface StoredAuth {
  /** encrypted base64 of the access JWT */
  encAccess: string | null
  /** encrypted base64 of the refresh JWT */
  encRefresh: string | null
  /** ISO timestamp of last login (for diagnostics only) */
  lastLoginAt: string | null
}

// Lazy singleton — Store создаётся при первом обращении, а не при импорте.
// Важно: app.setPath('userData', ...) в main/index.ts должен выполниться
// ДО создания Store, иначе electron-store запишет в неправильную папку.
let _store: Store<StoredAuth> | null = null
let sessionGeneration = 0
function store(): Store<StoredAuth> {
  if (!_store) {
    _store = new Store<StoredAuth>({
      name: 'auth',
      defaults: { encAccess: null, encRefresh: null, lastLoginAt: null },
    })
  }
  return _store
}

function canEncrypt(): boolean {
  return safeStorage.isEncryptionAvailable()
}

function encrypt(plain: string): string {
  if (!canEncrypt()) return `plain:${plain}`
  return safeStorage.encryptString(plain).toString('base64')
}

function decrypt(stored: string): string {
  if (stored.startsWith('plain:')) {
    return stored.slice('plain:'.length)
  }
  if (!canEncrypt()) {
    throw new Error('safeStorage unavailable but token is encrypted')
  }
  return safeStorage.decryptString(Buffer.from(stored, 'base64'))
}

export function getAccessToken(): string | null {
  const enc = store().get('encAccess')
  if (!enc) return null
  try {
    return decrypt(enc)
  } catch {
    return null
  }
}

export function getRefreshToken(): string | null {
  const enc = store().get('encRefresh')
  if (!enc) return null
  try {
    return decrypt(enc)
  } catch {
    return null
  }
}

export function setTokens(accessToken: string, refreshToken: string): void {
  store().set('encAccess', encrypt(accessToken))
  store().set('encRefresh', encrypt(refreshToken))
  store().set('lastLoginAt', new Date().toISOString())
}

export function startTokenSession(accessToken: string, refreshToken: string): void {
  setTokens(accessToken, refreshToken)
  sessionGeneration++
}

export function getTokenSessionGeneration(): number {
  return sessionGeneration
}

export function clearTokens(): void {
  sessionGeneration++
  store().set('encAccess', null)
  store().set('encRefresh', null)
  store().set('lastLoginAt', null)
}

export function hasTokens(): boolean {
  return store().get('encAccess') !== null
}
