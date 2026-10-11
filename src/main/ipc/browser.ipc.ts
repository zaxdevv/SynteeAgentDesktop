// ── Browser IPC: renderer ↔ BrowserManager ────────────────────────────────
//
// BrowserPanel (renderer) хостит <webview>-элементы; регистрирует их в
// BrowserManager (main) по webContentsId. Все операции навигации идут через
// main — тот же канал, что и AI-тулы (единая точка контроля).
// AI-тулы идут отдельным путём: worker → postMessage 'browser_op' →
// chat.ipc.ts / AgentManager.ts → browserManager.execute().

import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { BrowserImporter, discoverChromeProfiles, openChromeProfile } from '../browser/browserImport'
import type { BrowserImportOptions } from '../../shared/browserImport'
import type { IpcMainInvokeEvent } from 'electron'
import { browserManager, setBrowserExtras } from '../managers/BrowserManager'
import { BrowserExtras } from '../browser/BrowserExtras'
import { IPC_EVENTS } from '../../shared/constants'
import { getChatBrowserMode, setChatBrowserMode } from '../../core/db/chats'
import {
  listExtensions,
  installFromWebStore,
  installFromLocalPath,
  removeExtension,
  toggleExtension,
} from '../browser/extensions'
import type Store from 'electron-store'

export function registerBrowserIPC(store: Store, getWindow: () => BrowserWindow | null): void {
  setBrowserExtras(BrowserExtras)
  // Settings-store: гейт mouseNavEnabled для X1/X2-навигации в webview
  // (инжектится в страницы, см. BrowserManager.injectSideButtonNav).
  browserManager.setSettingsStore(store)
  browserManager.setProfileStore(store)

  const importer = new BrowserImporter(process.env.LOCALAPPDATA || '', app.getPath('userData'),
    () => browserManager.listProfiles(),
    profile => store.set('browser.profiles', [...browserManager.listProfiles(), profile]))
  const requireMainUI = (event: IpcMainInvokeEvent): void => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents ||
      event.sender.getType() !== 'window' || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('Browser import is only available to the main UI')
    }
  }
  ipcMain.handle('browser:importSources', async event => {
    requireMainUI(event)
    return importer.importSources()
  })
  ipcMain.handle('browser:importData', async (event, options: BrowserImportOptions) => {
    requireMainUI(event)
    return importer.importData(options)
  })
  ipcMain.handle('browser:importedData', async (event, profileId: string, kind: 'bookmarks' | 'history', query: string, offset: number) => {
    requireMainUI(event)
    return importer.importedData(profileId, kind, query, offset)
  })
  ipcMain.handle('browser:chromeProfiles', event => { requireMainUI(event); return discoverChromeProfiles() })
  ipcMain.handle('browser:chromeOpen', async (event, profileId: unknown, url?: unknown) => {
    requireMainUI(event)
    return openChromeProfile(profileId, url)
  })

  // Регистрация webview-таба (did-attach в renderer).
  ipcMain.handle('browser:registerTab', (_e, tabId: string, webContentsId: number) => {
    browserManager.registerTab(tabId, webContentsId)
    return true
  })

  // Видимый таб (панель открыта + таб «Браузер» + этот таб активен) —
  // main мьютит звук невидимых табов. null = браузер не виден.
  ipcMain.handle('browser:setVisibleTab', (_e, tabId: string | null) => {
    browserManager.setVisibleTab(tabId)
    return true
  })

  // Кэш сессии браузера: размер (байты) + очистка.
  ipcMain.handle('browser:getCacheSize', async () => {
    try { return await browserManager.getSession().getCacheSize() } catch { return 0 }
  })
  ipcMain.handle('browser:clearCache', async () => {
    try { await browserManager.getSession().clearCache(); return true } catch { return false }
  })

  // Снятие таба с регистрации (webview unmount).
  ipcMain.handle('browser:unregisterTab', (_e, tabId: string) => {
    browserManager.unregisterTab(tabId)
    return true
  })

  // UI-навигация из адресной строки / кнопок панели.
  ipcMain.handle('browser:navigate', (_e, tabId: string, url: string) => {
    browserManager.navigate(tabId, url)
    return true
  })
  ipcMain.handle('browser:back', (_e, tabId: string) => { browserManager.goBack(tabId); return true })
  ipcMain.handle('browser:forward', (_e, tabId: string) => { browserManager.goForward(tabId); return true })
  ipcMain.handle('browser:reload', (_e, tabId: string) => { browserManager.reload(tabId); return true })

  // Создание/закрытие/активация табов (UI + AI-тулы tab_new/tab_select/tab_close).
  ipcMain.handle('browser:newTab', (_e, url?: string) => browserManager.newTab(url))
  ipcMain.handle('browser:closeTab', (_e, tabId: string) => { browserManager.unregisterTab(tabId); return true })
  ipcMain.handle('browser:selectTab', (_e, tabId: string) => { browserManager.setActiveTab(tabId); return true })

  // Профили: каждая сессия имеет отдельные cookies, localStorage и логины.
  ipcMain.handle('browser:profiles:list', (event) => { requireMainUI(event); return { profiles: browserManager.listProfiles(), activeId: browserManager.getProfileId() } })
  ipcMain.handle('browser:profiles:create', (event, name: string) => { requireMainUI(event); return browserManager.createProfile(name) })
  ipcMain.handle('browser:profiles:switch', async (event, id: string) => { requireMainUI(event); return browserManager.switchProfile(id) })
  ipcMain.handle('browser:profiles:delete', async (event, id: string) => {
    requireMainUI(event)
    return browserManager.deleteProfile(id, app.getPath('userData'))
  })

  // Текущее состояние (initial load в BrowserPanel).
  ipcMain.handle('browser:getState', () => ({
    tabs: browserManager.getTabs(),
    activeTabId: browserManager.getActiveTabId(),
  }))

  // ── browserMode чата: тумблер плюс-меню ────────────────────────────────
  ipcMain.handle('browser:getMode', (_e, chatId: string) => getChatBrowserMode(chatId))
  ipcMain.handle('browser:setMode', (_e, chatId: string, val: boolean) => {
    setChatBrowserMode(chatId, val)
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_EVENTS.BROWSER_MODE_CHANGED, { chatId, enabled: val })
    }
    return true
  })

  // ── Расширения браузера ────────────────────────────────────────────────
  ipcMain.handle('browser:extensions:list', () => listExtensions(store))

  // Установка из Chrome Web Store (URL или ID расширения).
  ipcMain.handle('browser:extensions:installWebStore', async (_e, input: string) => {
    try {
      const info = await installFromWebStore(store, input)
      return { ok: true, info }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Локальная установка: пикер файла (.crx/.zip) или папки (unpacked).
  ipcMain.handle('browser:extensions:installLocal', async (_e: IpcMainInvokeEvent, mode: 'file' | 'folder') => {
    try {
      const win = getWindow()
      const opts = mode === 'folder'
        ? { title: 'Выберите папку расширения (Load unpacked)', properties: ['openDirectory' as const] }
        : { title: 'Выберите файл расширения (.crx или .zip)', filters: [{ name: 'Расширение', extensions: ['crx', 'zip'] }], properties: ['openFile' as const] }
      const result = win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts)
      if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
      const info = await installFromLocalPath(store, result.filePaths[0])
      return { ok: true, info }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('browser:extensions:remove', (_e, extId: string) => removeExtension(store, extId))
  ipcMain.handle('browser:extensions:toggle', (_e, extId: string, enabled: boolean) =>
    toggleExtension(store, extId, enabled))
}
