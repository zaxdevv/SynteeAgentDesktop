import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import Database from 'better-sqlite3'
import type { BrowserDataPage, BrowserImportOptions, BrowserImportResult, BrowserImportSource } from '../../shared/browserImport'

type Item = BrowserDataPage['items'][number]
type Source = BrowserImportSource & { directory: string }
const BOOKMARK_BYTES = 16 * 1024 * 1024
const DATA_BYTES = 128 * 1024 * 1024
const HISTORY_LIMIT = 50_000
const BOOKMARK_LIMIT = 50_000
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const message = (e: unknown): string => e instanceof Error ? e.message : String(e)
const CHROME_PROFILE = /^(Default|Profile [0-9]+)$/
const LOCAL_STATE_BYTES = 2 * 1024 * 1024
export type ChromeProfile = { id: string; name: string }
export type ChromeDiscovery = { available: boolean; profiles: ChromeProfile[] }

function chromeCandidates(): string[] {
  const env = process.env
  return [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter((v): v is string => !!v)
}
async function findChromeExe(): Promise<string | null> {
  for (const candidate of chromeCandidates()) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate } catch { /* absent */ }
  }
  return null
}
async function discoverChromeUserData(): Promise<{ root: string; exe: string } | null> {
  const exe = await findChromeExe()
  const local = process.env.LOCALAPPDATA
  if (!exe || !local) return null
  const root = path.join(local, 'Google', 'Chrome', 'User Data')
  try { if (!(await fs.stat(root)).isDirectory()) return null } catch { return null }
  return { root, exe }
}
export async function discoverChromeProfiles(): Promise<ChromeDiscovery> {
  const found = await discoverChromeUserData()
  if (!found) return { available: false, profiles: [] }
  let entries: string[]
  try { entries = await fs.readdir(found.root) } catch { return { available: true, profiles: [] } }
  const names: Record<string, string> = {}
  try {
    const state = await readJSON(path.join(found.root, 'Local State'), LOCAL_STATE_BYTES)
    const cache = isObject(state) && isObject(state.profile?.info_cache) ? state.profile.info_cache : {}
    for (const [id, value] of Object.entries(cache)) {
      if (isObject(value) && typeof value.name === 'string' && CHROME_PROFILE.test(id)) names[id] = value.name.slice(0, 200)
    }
  } catch { /* Local State is optional and contains no secrets read here */ }
  const profiles: ChromeProfile[] = []
  for (const id of entries.filter(entry => CHROME_PROFILE.test(entry)).sort((a, b) => a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b, undefined, { numeric: true }))) {
    try { if ((await fs.stat(path.join(found.root, id))).isDirectory()) profiles.push({ id, name: names[id] || (id === 'Default' ? 'По умолчанию' : id) }) } catch { /* changed during discovery */ }
  }
  return { available: true, profiles }
}
export async function openChromeProfile(profileId: unknown, url?: unknown, launch: (exe: string, args: string[]) => ChildProcess = (exe, args) => spawn(exe, args, { shell: false, detached: true, stdio: 'ignore' })): Promise<{ ok: true } | { ok: false; error: string }> {
  const found = await discoverChromeUserData()
  if (!found) return { ok: false, error: 'Оригинальный Chrome не найден' }
  const listing = await discoverChromeProfiles()
  if (typeof profileId !== 'string' || !listing.profiles.some(p => p.id === profileId)) return { ok: false, error: 'Профиль Chrome не найден' }
  if (url !== undefined && !safeURL(url)) return { ok: false, error: 'Разрешены только http(s)-URL' }
  const args = [`--profile-directory=${profileId}`, '--new-window']
  if (url !== undefined) args.push(url as string)
  try {
    const child = launch(found.exe, args)
    const result = await new Promise<{ ok: true } | { ok: false; error: string }>(resolve => {
      let settled = false
      const done = (value: { ok: true } | { ok: false; error: string }) => { if (!settled) { settled = true; resolve(value) } }
      child.once('error', error => done({ ok: false, error: message(error) }))
      child.once('spawn', () => done({ ok: true }))
      // Success is reported only when Node confirms the child process spawned.
    })
    if (result.ok) child.unref()
    return result
  } catch (e) { return { ok: false, error: message(e) } }
}

// Bound the read itself, not just a prior stat (the browser may replace/grow files).
async function readJSON(file: string, maximum: number): Promise<unknown> {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maximum) throw new Error('Файл слишком большой или не является обычным файлом')
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maximum + 1))
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used > stat.size || used > maximum) throw new Error('Файл изменился во время чтения; повторите импорт')
    return JSON.parse(buffer.subarray(0, used).toString('utf8'))
  } finally { await handle.close() }
}

function safeURL(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16_384) return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

// Reject links/junctions escaping the discovered profile, including History WAL.
async function containedFile(directory: string, name: string): Promise<string> {
  const file = path.join(directory, name)
  const real = await fs.realpath(file)
  if (path.dirname(real).toLowerCase() !== directory.toLowerCase()) throw new Error('Ссылка за пределы профиля запрещена')
  return real
}

export class BrowserImporter {
  constructor(
    private readonly localAppData: string,
    private readonly userData: string,
    private readonly profiles: () => Array<{ id: string; name: string }>,
    private readonly register: (profile: { id: string; name: string }) => void,
  ) {}

  private async discover(): Promise<Source[]> {
    const result: Source[] = []
    if (!this.localAppData) return result
    for (const browser of ['chrome', 'edge'] as const) {
      const root = path.join(this.localAppData, browser === 'chrome' ? 'Google/Chrome/User Data' : 'Microsoft/Edge/User Data')
      let realRoot: string
      let entries: string[]
      try { realRoot = await fs.realpath(root); entries = await fs.readdir(root) } catch { continue }
      for (const entry of entries) {
        if (typeof entry !== 'string' || !/^(Default|Profile [0-9]+)$/.test(entry)) continue
        let directory: string
        try {
          directory = await fs.realpath(path.join(root, entry))
          if (path.dirname(directory).toLowerCase() !== realRoot.toLowerCase() || !(await fs.stat(directory)).isDirectory()) continue
        } catch { continue }
        const exists = async (name: string): Promise<boolean> => {
          try { return (await fs.stat(await containedFile(directory, name))).isFile() } catch { return false }
        }
        const bookmarks = await exists('Bookmarks'); const history = await exists('History')
        if (bookmarks || history) result.push({ id: `${browser}:${entry}`, browser, name: `${browser === 'chrome' ? 'Chrome' : 'Edge'} — ${entry}`, bookmarks, history, directory })
      }
    }
    return result
  }

  async importSources(): Promise<BrowserImportSource[]> {
    return (await this.discover()).map(({ directory: _directory, ...source }) => source)
  }

  private async bookmarks(source: Source, warnings: string[]): Promise<Item[]> {
    const data = await readJSON(await containedFile(source.directory, 'Bookmarks'), BOOKMARK_BYTES)
    if (!isObject(data) || !isObject(data.roots)) throw new Error('Некорректный формат Bookmarks')
    const items: Item[] = []; let skipped = 0; let nodes = 0
    const stack = Object.values(data.roots).map(node => ({ node, folder: '', depth: 0 }))
    while (stack.length) {
      const { node, folder, depth } = stack.pop()!
      if (++nodes > 100_000 || depth > 100) throw new Error('Слишком большая/глубокая структура Bookmarks')
      if (!isObject(node)) { skipped++; continue }
      const title = typeof node.name === 'string' ? node.name.slice(0, 4096) : ''
      if (node.type === 'url') {
        if (safeURL(node.url)) items.push({ title: title || node.url, url: node.url, folder })
        else skipped++
        if (items.length === BOOKMARK_LIMIT) { warnings.push('Закладки ограничены первыми 50000 записями'); break }
      } else if (node.type === 'folder' && Array.isArray(node.children)) {
        const next = (folder ? `${folder} / ${title}` : title).slice(0, 8192)
        for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], folder: next, depth: depth + 1 })
      } else skipped++
    }
    if (skipped) warnings.push(`Пропущены некорректные или не HTTP(S) закладки: ${skipped}`)
    return items
  }

  private async history(source: Source, warnings: string[]): Promise<Item[]> {
    const file = await containedFile(source.directory, 'History')
    for (const suffix of ['-wal', '-shm']) {
      try { await fs.lstat(file + suffix) } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw e
      }
      await containedFile(source.directory, 'History' + suffix)
    }
    let db: Database.Database | undefined
    try {
      // Direct read-only connection sees a consistent SQLite snapshot including WAL.
      // Never copy a live History/WAL pair, never open Cookies or Login Data.
      db = new Database(file, { readonly: true, fileMustExist: true, timeout: 1500 })
      db.pragma('query_only = ON')
      const rows = db.prepare('SELECT url, title, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT ?').all(HISTORY_LIMIT) as Array<{ url: unknown; title: unknown; last_visit_time: unknown }>
      const items: Item[] = []; let skipped = 0
      for (const row of rows) {
        if (!safeURL(row.url)) { skipped++; continue }
        const time = Number(row.last_visit_time) / 1000 - 11_644_473_600_000
        items.push({ url: row.url, title: typeof row.title === 'string' ? row.title.slice(0, 4096) : row.url, ...(Number.isFinite(time) && time > 0 ? { lastVisited: Math.floor(time) } : {}) })
      }
      if (rows.length === HISTORY_LIMIT) warnings.push('История ограничена последними 50000 URL')
      if (skipped) warnings.push(`Пропущены не HTTP(S) URL истории: ${skipped}`)
      return items
    } catch (e) {
      const code = (e as { code?: string }).code || ''
      if (/BUSY|LOCKED|CANTOPEN|READONLY/.test(code) || /locked|busy/i.test(message(e))) throw new Error('Не удалось прочитать историю: закройте Chrome/Edge и повторите импорт')
      throw e
    } finally { db?.close() }
  }

  async importData(input: BrowserImportOptions): Promise<BrowserImportResult> {
    const result: BrowserImportResult = { ok: false, bookmarks: 0, history: 0, warnings: [] }
    let target: string | undefined
    let temp: string | undefined
    try {
      if (!isObject(input) || typeof input.sourceId !== 'string' || input.sourceId.length > 100 || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40 || typeof input.bookmarks !== 'boolean' || typeof input.history !== 'boolean' || (!input.bookmarks && !input.history)) throw new Error('Некорректные параметры импорта (имя 1–40 символов, выберите данные)')
      // Renderer IDs are opaque; rediscover every import. Never accept a renderer path.
      const source = (await this.discover()).find(s => s.id === input.sourceId)
      if (!source) throw new Error('Источник импорта не найден; обновите список')
      const data: { bookmarks: Item[]; history: Item[] } = { bookmarks: [], history: [] }
      for (const kind of ['bookmarks', 'history'] as const) {
        if (!input[kind]) continue
        try {
          data[kind] = kind === 'bookmarks' ? await this.bookmarks(source, result.warnings) : await this.history(source, result.warnings)
          if (!data[kind].length) result.warnings.push(`${kind}: нет подходящих данных`)
        } catch (e) { result.warnings.push(`${kind}: ${message(e)}`) }
      }
      if (!data.bookmarks.length && !data.history.length) throw new Error('Нет данных для импорта; профиль не создан')
      const profile = { id: `profile-${randomUUID()}`, name: input.name.trim() }
      const directory = path.join(this.userData, 'browser-imports')
      await fs.mkdir(directory, { recursive: true })
      target = path.join(directory, `${profile.id}.json`); temp = target + '.tmp'
      const json = JSON.stringify(data)
      if (Buffer.byteLength(json) > DATA_BYTES) throw new Error('Импортированные данные слишком большие')
      await fs.writeFile(temp, json, { flag: 'wx' })
      await fs.rename(temp, target)
      // Publish profile only AFTER persistence succeeded; no switchProfile call.
      this.register(profile)
      result.ok = true; result.profile = profile
      result.bookmarks = data.bookmarks.length; result.history = data.history.length
    } catch (e) {
      result.error = message(e)
      if (target) await fs.unlink(target).catch(() => {})
      if (temp) await fs.unlink(temp).catch(() => {})
    }
    return result
  }

  async importedData(profileId: string, kind: 'bookmarks' | 'history', query: string, offset: number): Promise<BrowserDataPage> {
    if (typeof profileId !== 'string' || !/^(default|profile-[a-zA-Z0-9-]+)$/.test(profileId) || !this.profiles().some(p => p.id === profileId) || !['bookmarks', 'history'].includes(kind) || typeof query !== 'string' || query.length > 500 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Некорректные параметры просмотра')
    let data: unknown
    try { data = await readJSON(path.join(this.userData, 'browser-imports', `${profileId}.json`), DATA_BYTES) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], total: 0 }
      throw e
    }
    if (!isObject(data) || !Array.isArray(data[kind])) throw new Error('Повреждены импортированные данные')
    const needle = query.trim().toLowerCase()
    const items = (data[kind] as Item[]).filter(item => !needle || `${item.title}\n${item.url}\n${item.folder || ''}`.toLowerCase().includes(needle))
    return { items: items.slice(offset, offset + 100), total: items.length }
  }
}
