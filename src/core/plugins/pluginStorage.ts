/**
 * pluginStorage — per-plugin KV-хранилище.
 *
 * Один JSON-файл на плагин: {userData}/plugins-data/{pluginId}.json.
 * Ключи плагина изолированы по файлу — плагин не может читать чужие данные.
 * Записи дебаунсятся (500 мс) чтобы частые set не долбили диск.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const WRITE_DEBOUNCE_MS = 500

export class PluginStorage {
  private dataDir: string
  /** pluginId → кэш данных. */
  private cache = new Map<string, Record<string, unknown>>()
  /** pluginId → таймер дебаунса записи. */
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(userDataDir: string) {
    this.dataDir = join(userDataDir, 'plugins-data')
    if (!existsSync(this.dataDir)) {
      try { mkdirSync(this.dataDir, { recursive: true }) } catch { /* ignore */ }
    }
  }

  private filePath(pluginId: string): string {
    // pluginId уже валидирован loader-ом ([a-zA-Z][a-zA-Z0-9_-]*).
    return join(this.dataDir, `${pluginId}.json`)
  }

  private load(pluginId: string): Record<string, unknown> {
    const cached = this.cache.get(pluginId)
    if (cached) return cached
    let data: Record<string, unknown> = {}
    try {
      const p = this.filePath(pluginId)
      if (existsSync(p)) {
        data = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
      }
    } catch {
      data = {}
    }
    this.cache.set(pluginId, data)
    return data
  }

  get(pluginId: string, key: string): unknown {
    return this.load(pluginId)[key]
  }

  set(pluginId: string, key: string, value: unknown): void {
    const data = this.load(pluginId)
    data[key] = value
    this.scheduleWrite(pluginId)
  }

  delete(pluginId: string, key: string): void {
    const data = this.load(pluginId)
    delete data[key]
    this.scheduleWrite(pluginId)
  }

  private scheduleWrite(pluginId: string): void {
    const existing = this.timers.get(pluginId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(pluginId)
      try {
        writeFileSync(this.filePath(pluginId), JSON.stringify(this.cache.get(pluginId) ?? {}))
      } catch (e) {
        console.warn(`[plugins] storage write failed for ${pluginId}:`, (e as Error).message)
      }
    }, WRITE_DEBOUNCE_MS)
    this.timers.set(pluginId, timer)
  }

  /** Немедленно сбросить все несохранённые данные (при выходе приложения). */
  flushAll(): void {
    for (const [pluginId] of this.timers) {
      const t = this.timers.get(pluginId)!
      clearTimeout(t)
      this.timers.delete(pluginId)
      try {
        writeFileSync(this.filePath(pluginId), JSON.stringify(this.cache.get(pluginId) ?? {}))
      } catch { /* ignore */ }
    }
  }
}
