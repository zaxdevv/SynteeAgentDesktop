/**
 * pluginLoader — сканирование папок плагинов и загрузка манифестов.
 *
 * Папки:
 *   глобальные:  {userData}/plugins/{id}/
 *   проектные:   {workdir}/.syntee/plugins/{id}/
 *
 * Плагин валиден если:
 *   - plugin.json парсится и содержит id (= имя папки), name, main
 *   - entry-файл (main) существует
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { Plugin, PluginManifest, PluginPermission } from '../../shared/types'

// Должен покрывать ВСЕ значения PluginPermission (shared/types/plugin.ts).
// Если список и тип расходятся — лоадер молча вырезает права из манифеста,
// и плагин падает с "Permission denied" при вызове API (баг от 05.09.2026).
const VALID_PERMISSIONS: PluginPermission[] = [
  'net', 'fs:read', 'fs:write', 'fs:write:any', 'clipboard', 'notifications', 'ui',
  'chat', 'chats:read', 'chats:write', 'projects:read', 'projects:write', 'memory',
  'ai', 'scheduler', 'shortcuts', 'process:exec', 'overlay', 'tray',
  'context', 'secrets', 'git', 'mcp', 'webhook', 'agent', 'hooks',
]

/** Читает один плагин из папки. Возвращает null если папка — не плагин. */
export function loadPluginDir(dir: string, source: 'global' | 'project', projectId?: string): Plugin | null {
  const manifestPath = join(dir, 'plugin.json')
  if (!existsSync(manifestPath)) return null
  let manifest: PluginManifest
  try {
    // \uFEFF: UTF-8 BOM (его любит дописывать PowerShell Out-File) ломает JSON.parse.
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8').replace(/^\uFEFF/, '')) as PluginManifest
  } catch {
    console.warn(`[plugins] невалидный plugin.json: ${dir}`)
    return null
  }
  if (!manifest.id || typeof manifest.id !== 'string') {
    console.warn(`[plugins] plugin.json без id: ${dir}`)
    return null
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(manifest.id)) {
    console.warn(`[plugins] id плагина должен быть [a-zA-Z][a-zA-Z0-9_-]*: ${manifest.id}`)
    return null
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    console.warn(`[plugins] plugin.json без name: ${dir}`)
    return null
  }
  if (!manifest.main || typeof manifest.main !== 'string') {
    console.warn(`[plugins] plugin.json без main: ${dir}`)
    return null
  }
  // Entry должен существовать и лежать внутри папки плагина (path traversal).
  const entryPath = join(dir, manifest.main)
  if (!entryPath.startsWith(dir)) {
    console.warn(`[plugins] main вне папки плагина: ${dir}`)
    return null
  }
  if (!existsSync(entryPath)) {
    console.warn(`[plugins] entry не найден: ${entryPath}`)
    return null
  }
  // Фильтруем неизвестные права.
  if (manifest.permissions) {
    manifest.permissions = manifest.permissions.filter(p => VALID_PERMISSIONS.includes(p))
  }
  // Рантайм: неизвестное значение → node (обратная совместимость).
  if (manifest.runtime !== undefined && manifest.runtime !== 'node' && manifest.runtime !== 'python') {
    console.warn(`[plugins] неизвестный runtime "${manifest.runtime}" (ожидался node|python) → node: ${dir}`)
    manifest.runtime = 'node'
  }
  // Python-зависимости: только массив pip-спецификаций-строк.
  if (manifest.requirements !== undefined) {
    manifest.requirements = Array.isArray(manifest.requirements)
      ? manifest.requirements.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim())
      : []
  }

  const plugin: Plugin = {
    id: manifest.id,
    manifest,
    dir,
    source,
    projectId,
  }

  // readme (полное описание для карточки UI) — опционально.
  const readmeRel = manifest.readme ?? 'readme.md'
  const readmePath = join(dir, readmeRel)
  if (readmePath.startsWith(dir) && existsSync(readmePath)) {
    try {
      plugin.readmeContent = readFileSync(readmePath, 'utf-8')
    } catch { /* ignore */ }
  }
  return plugin
}

/** Сканирует папку с плагинами ({root}/{id}/plugin.json для каждого subdir). */
export function scanPluginsDir(root: string, source: 'global' | 'project', projectId?: string): Plugin[] {
  if (!existsSync(root)) return []
  const out: Plugin[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  for (const entry of entries) {
    const full = join(root, entry)
    try {
      if (!statSync(full).isDirectory()) continue
    } catch {
      continue
    }
    const plugin = loadPluginDir(full, source, projectId)
    if (plugin) out.push(plugin)
  }
  return out
}
