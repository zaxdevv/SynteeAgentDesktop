/**
 * Auth & profile IPC handlers + deep-link registration.
 *
 * Flow:
 *  1. Renderer calls `auth:login` → we open the browser to the gateway
 *     consent screen with `redirect=synteehelper://auth/callback`.
 *  2. After consent the site redirects to `synteehelper://auth/callback?code=...`.
 *  3. Windows launches us with that URL → `second-instance` event fires
 *     (single-instance lock is acquired in main/index.ts). We parse the code,
 *     exchange it for JWTs via gatewayClient, store them, and push
 *     `auth:logged-in` to the renderer.
 *  4. Renderer calls `auth:me` to fetch the user profile.
 */
import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { resolve } from 'path'
import {
  exchangeDesktopCode,
  getMe,
  updateProfile,
  changePassword,
  listApiKeys,
  createApiKey,
  deleteApiKey,
  getGatewayWebUrl,
  checkUsername,
  type GatewayUser,
  type GatewayApiKey,
  type GatewayApiKeyCreated,
  GatewayAuthError,
} from '../services/gatewayClient'
import { hasTokens, clearTokens, startTokenSession, getTokenSessionGeneration } from '../services/tokenStore'
import { clearGatewayCatalog } from './gateway.ipc'

const PROTOCOL = 'synteehelper'
const CALLBACK_PATH = '/auth/callback'

/** Parse a synteehelper://auth/callback?code=... URL. Returns the code or null. */
function parseCallbackUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${PROTOCOL}:`) return null
    if (parsed.pathname !== CALLBACK_PATH && parsed.host !== 'auth') return null
    const code = parsed.searchParams.get('code')
    return code ?? null
  } catch {
    return null
  }
}

/** Handle a deep-link callback URL: exchange code → store tokens → notify renderer. */
async function handleCallback(url: string, mainWindow?: BrowserWindow | null): Promise<void> {
  const code = parseCallbackUrl(url)
  if (!code) {
    // Раньше тут был молчаливый return → вечный вис в UI.
    // Теперь сообщаем об ошибке, чтобы пользователь не ждал вечно.
    console.error('[auth] handleCallback: no authorization code')
    mainWindow?.webContents.send('auth:login-error', {
      message: 'Некорректный ответ от браузера (нет кода авторизации). Попробуйте снова.',
    })
    return
  }
  try {
    console.log('[auth] exchanging desktop code...')
    const tokens = await exchangeDesktopCode(code)
    startTokenSession(tokens.access_token, tokens.refresh_token)
    clearGatewayCatalog()
    console.log('[auth] tokens stored, notifying renderer')
    mainWindow?.webContents.send('auth:logged-in')
  } catch (err) {
    console.error('[auth] exchange failed:', err)
    mainWindow?.webContents.send('auth:login-error', {
      message: err instanceof Error ? err.message : 'Exchange failed',
    })
  }
}

/** Register the synteehelper:// protocol and wire second-instance + open-url. */
export function registerDeepLinks(getMainWindow: () => BrowserWindow | null): void {
  // Register protocol. In dev mode we MUST pass the entry script path —
  // otherwise Windows launches `electron.exe <deep-link-url>` and Electron
  // treats the URL as the app entry point → "Unable to find Electron app".
  //
  // В Windows dev всегда перерегистрируем, чтобы обновить путь к entry.
  // В Linux протокол регистрирует установленное приложение через .desktop.
  if (is.dev && process.platform === 'win32' && process.argv[1]) {
    app.removeAsDefaultProtocolClient(PROTOCOL)
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      resolve(process.argv[1]),
    ])
  } else if ((process.platform !== 'linux' || app.isPackaged) && !app.isDefaultProtocolClient(PROTOCOL)) {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }

  // Windows/Linux: when app is already running, a synteehelper:// launch
  // hits the second-instance event with the URL in argv.
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`))
    if (url) {
      console.log('[auth] second-instance deep-link received')
      handleCallback(url, getMainWindow())
    } else {
      // Regular second launch — focus the main window.
      const win = getMainWindow()
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    }
  })

  // macOS: deep links arrive via the open-url event.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleCallback(url, getMainWindow())
  })

  // Cold start with a deep link (Windows/Linux): the URL is in process.argv.
  for (const arg of process.argv) {
    if (arg.startsWith(`${PROTOCOL}://`)) {
      // Defer to when main window exists.
      const tryHandle = (): void => {
        const win = getMainWindow()
        if (win) {
          handleCallback(arg, win)
        } else {
          setTimeout(tryHandle, 200)
        }
      }
      setTimeout(tryHandle, 500)
      break
    }
  }
}

export function registerAuthIPC(getMainWindow: () => BrowserWindow | null): void {
  // ── Login flow ──

  ipcMain.handle('auth:login', async () => {
    const webUrl = getGatewayWebUrl()
    const redirect = `${PROTOCOL}://${CALLBACK_PATH.slice(1)}`
    const target = `${webUrl}/auth/desktop?redirect=${encodeURIComponent(redirect)}`
    await shell.openExternal(target)
    return { ok: true }
  })

  ipcMain.handle('auth:isLoggedIn', () => hasTokens())

  ipcMain.handle('auth:me', async (): Promise<{
    user: GatewayUser | null
    status: 'authenticated' | 'unauthenticated' | 'unavailable'
  }> => {
    if (!hasTokens()) return { user: null, status: 'unauthenticated' }
    const generation = getTokenSessionGeneration()
    try {
      const user = await getMe()
      if (generation !== getTokenSessionGeneration()) return { user: null, status: 'unavailable' }
      return { user, status: 'authenticated' }
    } catch (err) {
      // Только однозначный 401/403 refresh-токена означает logout.
      if (err instanceof GatewayAuthError) {
        if (generation !== getTokenSessionGeneration() && hasTokens()) {
          return { user: null, status: 'unavailable' }
        }
        clearTokens()
        clearGatewayCatalog()
        return { user: null, status: 'unauthenticated' }
      }
      // Сеть, timeout и 5xx — это временная недоступность. Токены оставляем
      // в хранилище, чтобы короткий обрыв интернета не превращался в logout.
      return { user: null, status: 'unavailable' }
    }
  })

  ipcMain.handle('auth:logout', async () => {
    clearTokens()
    clearGatewayCatalog()
    getMainWindow()?.webContents.send('auth:logged-out')
    return { ok: true }
  })

  // ── Profile ──

  ipcMain.handle(
    'profile:update',
    async (
      _e,
      payload: { display_name?: string | null; avatar_url?: string | null; username?: string },
    ) => {
      return updateProfile(payload)
    },
  )
  ipcMain.handle('profile:checkUsername', (_e, username: string) => checkUsername(username))

  ipcMain.handle(
    'profile:changePassword',
    async (_e, currentPassword: string, newPassword: string) => {
      await changePassword(currentPassword, newPassword)
      return { ok: true }
    },
  )

  // ── API keys ──

  ipcMain.handle('profile:listApiKeys', async (): Promise<GatewayApiKey[]> => {
    return listApiKeys()
  })

  ipcMain.handle('profile:createApiKey', async (_e, name: string): Promise<GatewayApiKeyCreated> => {
    return createApiKey(name)
  })

  ipcMain.handle('profile:deleteApiKey', async (_e, keyId: string) => {
    await deleteApiKey(keyId)
    return { ok: true }
  })
}
