// ── Расширения встроенного браузера ────────────────────────────────────────
//
// Источники (по выбору Luneex: «Chrome Web Store + локальные»):
//  1. Chrome Web Store — по URL/ID: скачиваем CRX с update-сервера Google
//     (clients2.google.com/service/update2/crx), распаковываем, грузим в
//     сессию браузера. Electron умеет только unpacked-расширения — CRX это
//     zip с protobuf-заголовком (Cr24), стрипаем до PK-сигнатуры.
//  2. Локально: .crx / .zip / распакованная папка (Load unpacked).
//
// Хранение: {userData}/browser-extensions/{id}/ — распакованные расширения.
// Реестр: electron-store browser.extensions: [{id, name, version, source,
// enabled, dir}] — автозагрузка при старте приложения.
//
// Сессия: BROWSER_PARTITION (persist:syntee-browser) — webview-табы панели
// автоматически получают content scripts установленных расширений.
// Chrome-подобный UA на сессии — обязателен для скачивания CRX.
//
// Ограничения Electron: поддерживается подмножество chrome.* (tabs,
// storage, webRequest, action частично). Попапы/кнопки browserAction в
// тулбаре — фаза 5+ (electron-chrome-extensions интеграция).

import { app, session } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import AdmZip from 'adm-zip'
import type Store from 'electron-store'
import { BROWSER_PARTITION } from '../../shared/constants'
import { log } from '../../core/logger'

export interface BrowserExtensionInfo {
  id: string
  name: string
  version: string
  description?: string
  source: 'webstore' | 'local'
  enabled: boolean
  dir: string
}

interface PersistedExtension {
  id: string
  name: string
  version: string
  description?: string
  source: 'webstore' | 'local'
  enabled: boolean
  dir: string
}

const EXTENSIONS_ROOT_KEY = 'browser.extensions'

function extensionsRoot(): string {
  const root = join(app.getPath('userData'), 'browser-extensions')
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}

/** Совместимость API: session.extensions.loadExtension (новые Electron) /
 *  session.loadExtension (старые). */
function extApi(ses: Electron.Session): {
  loadExtension: (path: string, opts?: { allowFileAccess?: boolean }) => Promise<Electron.Extension>
  removeExtension: (id: string) => void
  getAllExtensions: () => Electron.Extension[]
} {
  const withExt = ses as unknown as {
    extensions?: {
      loadExtension: (path: string, opts?: { allowFileAccess?: boolean }) => Promise<Electron.Extension>
      removeExtension: (id: string) => void
      getAllExtensions: () => Electron.Extension[]
    }
    loadExtension?: (path: string, opts?: { allowFileAccess?: boolean }) => Promise<Electron.Extension>
    removeExtension?: (id: string) => void
    getAllExtensions?: () => Electron.Extension[]
  }
  if (withExt.extensions) return withExt.extensions
  return {
    loadExtension: (p, o) => (ses as unknown as { loadExtension(p: string, o?: { allowFileAccess?: boolean }): Promise<Electron.Extension> }).loadExtension(p, o),
    removeExtension: id => (ses as unknown as { removeExtension(id: string): void }).removeExtension(id),
    getAllExtensions: () => (ses as unknown as { getAllExtensions(): Electron.Extension[] }).getAllExtensions(),
  }
}

export function getBrowserSession(): Electron.Session {
  return session.fromPartition(BROWSER_PARTITION)
}

function readRegistry(store: Store): PersistedExtension[] {
  return (store.get(EXTENSIONS_ROOT_KEY) as PersistedExtension[] | undefined) ?? []
}

function writeRegistry(store: Store, list: PersistedExtension[]): void {
  store.set(EXTENSIONS_ROOT_KEY, list)
}

/** Автозагрузка при старте приложения (main/index.ts). */
export async function loadExtensionsOnBoot(store: Store): Promise<void> {
  const ses = getBrowserSession()
  const list = readRegistry(store)
  for (const ext of list) {
    if (!ext.enabled) continue
    if (!existsSync(ext.dir)) {
      log('[browser:ext] boot: dir not found, skip %s (%s)', ext.id, ext.dir)
      continue
    }
    try {
      await extApi(ses).loadExtension(ext.dir, { allowFileAccess: true })
      log('[browser:ext] boot: loaded %s (%s v%s)', ext.id, ext.name, ext.version)
    } catch (e) {
      log('[browser:ext] boot: failed %s: %s', ext.id, (e as Error).message)
    }
  }
}

/** Список установленных (из реестра + живое состояние сессии). */
export function listExtensions(store: Store): BrowserExtensionInfo[] {
  return readRegistry(store).map(e => ({ ...e }))
}

/** Распарсить ID расширения из URL Chrome Web Store или сырой строки. */
export function parseWebStoreId(input: string): string | null {
  const s = input.trim()
  // Прямой ID (32 hex-символа a-p).
  if (/^[a-p]{32}$/.test(s)) return s
  // URL вида https://chromewebstore.google.com/detail/{name}/{id}
  // или https://chrome.google.com/webstore/detail/{name}/{id}
  const m = s.match(/(?:chromewebstore\.google\.com|chrome\.google\.com)\/(?:webstore\/)?detail\/[^/]+\/([a-p]{32})/)
  if (m) return m[1]
  return null
}

/** Скачать CRX с update-сервера Google и распаковать в extensionsRoot. */
async function downloadAndUnpackCrx(extId: string): Promise<string> {
  // prodversion — версия Chromium; сервер отдаёт совместимый CRX.
  const url =
    `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3` +
    `&prodversion=142.0.0.0&x=id%3D${extId}%26installsource%3Dondemand%26uc`
  const res = await fetch(url, {
    headers: {
      // Chrome-подобный UA — иначе сервер может отдать редирект на страницу.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`CRX download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 16) throw new Error('CRX download failed: file too small')
  return unpackCrxBuffer(buf, extId)
}

/** Стрип CRX2/CRX3-заголовка (до PK\x03\x04) + unzip. */
function unpackCrxBuffer(buf: Buffer, key: string): string {
  // CRX3: 'Cr24' + version(4LE) + headerLen(4LE) + header + zip. Ищем первый
  // PK-сигнатуру zip-архива после минимального заголовка (12 байт).
  const zipStart = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 12)
  if (zipStart < 0) throw new Error('Invalid CRX: zip signature not found')
  const zip = new AdmZip(buf.subarray(zipStart))
  const dir = join(extensionsRoot(), key)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  zip.extractAllTo(dir, true)
  return dir
}

/** Найти manifest.json в распакованной папке (расширение может лежать
 *  в подпапке — CRX иногда содержит корневую папку). */
function findManifestDir(dir: string): string | null {
  if (existsSync(join(dir, 'manifest.json'))) return dir
  let entries: Array<{ isDirectory: () => boolean; name: string }> = []
  try {
    entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []
  } catch { return null }
  for (const e of entries) {
    if (e.isDirectory()) {
      const sub = join(dir, e.name)
      if (existsSync(join(sub, 'manifest.json'))) return sub
    }
  }
  return null
}

/** Установка из Chrome Web Store (URL или ID). */
export async function installFromWebStore(store: Store, input: string): Promise<BrowserExtensionInfo> {
  const extId = parseWebStoreId(input)
  if (!extId) throw new Error('Не похоже на ID или ссылку Chrome Web Store. Вставь URL расширения или его 32-символьный ID.')
  const dir = await downloadAndUnpackCrx(extId)
  const manifestDir = findManifestDir(dir)
  if (!manifestDir) throw new Error('CRX unpacked but manifest.json not found')
  return loadAndRegister(store, manifestDir, 'webstore', extId)
}

/** Установка из локального файла (.crx / .zip) или папки (unpacked). */
export async function installFromLocalPath(store: Store, filePath: string): Promise<BrowserExtensionInfo> {
  const lower = filePath.toLowerCase()
  let dir: string
  if (lower.endsWith('.crx') || lower.endsWith('.zip')) {
    const { readFile } = await import('fs/promises')
    const buf = await readFile(filePath)
    dir = unpackCrxBuffer(buf, `local-${Date.now()}`)
  } else {
    // Папка (Load unpacked) — грузим напрямую, без копирования.
    dir = filePath
  }
  const manifestDir = findManifestDir(dir)
  if (!manifestDir) throw new Error('manifest.json не найден (это не расширение?)')
  return loadAndRegister(store, manifestDir, 'local')
}

/** Загрузить в сессию + зарегистрировать в electron-store. */
async function loadAndRegister(
  store: Store,
  manifestDir: string,
  source: 'webstore' | 'local',
  expectedId?: string,
): Promise<BrowserExtensionInfo> {
  const ses = getBrowserSession()
  // Выгрузить старую версию, если стоит (loadExtension с тем же id кидает ошибку).
  const existing = extApi(ses).getAllExtensions().find(e => e.id === expectedId)
  if (existing) {
    try { extApi(ses).removeExtension(existing.id) } catch { /* ok */ }
  }

  const ext = await extApi(ses).loadExtension(manifestDir, { allowFileAccess: true })
  const info: BrowserExtensionInfo = {
    id: ext.id,
    name: ext.name,
    version: ext.version,
    description: (ext.manifest as { description?: string })?.description,
    source,
    enabled: true,
    dir: manifestDir,
  }

  const list = readRegistry(store).filter(e => e.id !== info.id)
  list.push(info)
  writeRegistry(store, list)
  log('[browser:ext] installed %s (%s v%s) from %s', info.id, info.name, info.version, source)
  return info
}

/** Удалить расширение (из сессии, реестра и диска). */
export function removeExtension(store: Store, extId: string): boolean {
  const ses = getBrowserSession()
  const list = readRegistry(store)
  const entry = list.find(e => e.id === extId)
  if (!entry) return false
  try { extApi(ses).removeExtension(extId) } catch { /* ок — мог быть не загружен */ }
  // Удаляем файлы, только если это наш extensionsRoot (локальные папки юзера не трогаем).
  if (entry.dir.startsWith(extensionsRoot())) {
    try { rmSync(entry.dir, { recursive: true, force: true }) } catch { /* ok */ }
  }
  writeRegistry(store, list.filter(e => e.id !== extId))
  log('[browser:ext] removed %s (%s)', extId, entry.name)
  return true
}

/** Вкл/выкл: Electron не умеет disable — выгружаем/загружаем. */
export async function toggleExtension(store: Store, extId: string, enabled: boolean): Promise<boolean> {
  const list = readRegistry(store)
  const entry = list.find(e => e.id === extId)
  if (!entry) return false
  const ses = getBrowserSession()
  if (enabled) {
    try {
      await extApi(ses).loadExtension(entry.dir, { allowFileAccess: true })
    } catch (e) {
      log('[browser:ext] enable failed %s: %s', extId, (e as Error).message)
      return false
    }
  } else {
    try { extApi(ses).removeExtension(extId) } catch { /* ок */ }
  }
  entry.enabled = enabled
  writeRegistry(store, list)
  return true
}

/** Сохранить буфер как файл (для будущих drag-n-drop установок). */
export function saveCrxBuffer(buf: Buffer, key: string): string {
  const p = join(extensionsRoot(), `${key}.crx`)
  writeFileSync(p, buf)
  return p
}
