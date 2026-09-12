/**
 * Plugin extension APIs (renderer side).
 *
 * Новые host-API плагинов (поиск/автокомплит/контекстные меню/уведомления)
 * экспонируются в preload ПАРАЛЛЕЛЬНО с этим файлом — точное место может
 * быть `window.plugins.*` (новый top-level namespace) или расширение
 * существующего `window.syntee.plugins.*`. Чтобы рендерер не зависел от
 * того, где их положит main/preload — ищем функцию по обоим адресам и
 * мягко деградируем (нет API → UI не меняется).
 */
import { useExtensionsStore } from '../store/extensions.store'
import type { PluginRuntime } from '@shared/types/plugin'

// ── Типы ответов (зеркалят контракт preload, добавляемый ядром) ──────

export interface PluginSearchItem {
  id: string
  label: string
  sub?: string
  icon?: string
}

export interface PluginSearchProviderResult {
  pluginId: string
  providerId: string
  label: string
  items: PluginSearchItem[]
}

export interface PluginAutoSuggestion {
  label: string
  insertText?: string
  command?: string
}

export interface PluginAutoResult {
  trigger: string
  suggestions: PluginAutoSuggestion[]
}

/** Доступные методы расширенного API (все опциональные). */
interface PluginExtApi {
  search?: (params: { query: string }) => Promise<PluginSearchProviderResult[]>
  searchClick?: (params: { pluginId: string; providerId: string; item: PluginSearchItem }) => Promise<unknown>
  autocomplete?: (params: { text: string }) => Promise<PluginAutoResult | null>
  contextMenuClick?: (params: {
    pluginId: string
    itemId: string
    payload: { messageId: string; chatId: string; content: string; selection?: string }
  }) => Promise<unknown>
  notificationAction?: (params: { pluginId: string; command: string }) => Promise<unknown>
}

let cache: PluginExtApi | null = null
/** Возвращает объект расширенного API (пустой если недоступен). */
export function getPluginsExt(): PluginExtApi {
  if (cache) return cache
  const top = (window as unknown as { plugins?: PluginExtApi }).plugins
  const nested = (window as unknown as { syntee?: { plugins?: PluginExtApi } }).syntee?.plugins
  cache = (top && typeof top.search === 'function' ? top
    : nested && typeof nested.search === 'function' ? nested
    : {}) as PluginExtApi
  return cache
}

/** Запущенные и включённые плагины (реальный источник для всех вкладов). */
export function selectRunningPlugins(): PluginRuntime[] {
  const st = useExtensionsStore.getState().plugins
  return (st ?? []).filter(p => p && p.state?.enabled && p.status === 'running')
}

/** Собрать markdown-рендереры всех запущенных плагинов. */
export function collectMarkdownRenderers(): Array<{ pluginId: string; language: string; entry: string; height?: number }> {
  const out: Array<{ pluginId: string; language: string; entry: string; height?: number }> = []
  for (const p of selectRunningPlugins()) {
    for (const r of p.markdownRenderers ?? []) {
      out.push({ pluginId: p.id, language: r.language, entry: r.entry, height: r.height })
    }
  }
  return out
}

/** Кастомные теги сообщений плагинов (registerMessageTag). */
export function collectMessageTags(): Array<{ pluginId: string; tag: string; entry: string; height?: number; description?: string }> {
  const out: Array<{ pluginId: string; tag: string; entry: string; height?: number; description?: string }> = []
  for (const p of selectRunningPlugins()) {
    for (const t of p.messageTags ?? []) {
      out.push({ pluginId: p.id, tag: t.tag, entry: t.entry, height: t.height, description: t.description })
    }
  }
  return out
}

/** Контекстные пункты меню сообщений запущенных плагинов. */
export function collectMessageContextMenu(): Array<{ pluginId: string; id: string; label: string; icon?: string; scope: 'message' | 'selection'; button?: boolean }> {
  const out: Array<{ pluginId: string; id: string; label: string; icon?: string; scope: 'message' | 'selection'; button?: boolean }> = []
  for (const p of selectRunningPlugins()) {
    for (const it of p.contextMenu ?? []) {
      out.push({ pluginId: p.id, id: it.id, label: it.label, icon: it.icon, scope: it.scope, button: it.button })
    }
  }
  return out
}

/** Кнопки плагинов над полем ввода (registerInputAction). */
export function collectInputActions(): Array<{ pluginId: string; id: string; label: string; icon?: string; tooltip?: string; command?: string }> {
  const out: Array<{ pluginId: string; id: string; label: string; icon?: string; tooltip?: string; command?: string }> = []
  for (const p of selectRunningPlugins()) {
    for (const a of p.inputActions ?? []) {
      out.push({ pluginId: p.id, id: a.id, label: a.label, icon: a.icon, tooltip: a.tooltip, command: a.command })
    }
  }
  return out
}

/** Темы от запущенных плагинов. */
export function collectPluginThemes(): Array<{ pluginId: string; key: string; name: string; dark: boolean; colors: Record<string, string> }> {
  const out: Array<{ pluginId: string; key: string; name: string; dark: boolean; colors: Record<string, string> }> = []
  for (const p of selectRunningPlugins()) {
    for (const t of p.themes ?? []) {
      out.push({ pluginId: p.id, key: `plugin:${p.id}:${t.name}`, name: t.name, dark: t.dark, colors: t.colors })
    }
  }
  return out
}

/** Фоны от запущенных плагинов. */
export function collectPluginBackgrounds(): Array<{ pluginId: string; key: string; id: string; name: string; kind: 'shader' | 'video' | 'image'; src: string }> {
  const out: Array<{ pluginId: string; key: string; id: string; name: string; kind: 'shader' | 'video' | 'image'; src: string }> = []
  for (const p of selectRunningPlugins()) {
    for (const b of p.backgrounds ?? []) {
      out.push({ pluginId: p.id, key: `plugin:${p.id}:${b.id}`, id: b.id, name: b.name, kind: b.kind, src: b.src })
    }
  }
  return out
}

/** Разобрать bgStyle-ключ фона плагина `plugin:{pluginId}:{id}`. */
export function parsePluginBgKey(key: string): { pluginId: string; id: string } | null {
  if (!key.startsWith('plugin:')) return null
  const rest = key.slice('plugin:'.length)
  const idx = rest.indexOf(':')
  if (idx <= 0) return null
  return { pluginId: rest.slice(0, idx), id: rest.slice(idx + 1) }
}

/** Секции настроек плагинов (registerSettingsSection) — для SettingsPage. */
export function collectSettingsSections(): Array<{ pluginId: string; id: string; title: string; entry: string; icon?: string }> {
  const out: Array<{ pluginId: string; id: string; title: string; entry: string; icon?: string }> = []
  for (const p of selectRunningPlugins()) {
    for (const s of p.settingsSections ?? []) {
      out.push({ pluginId: p.id, id: s.id, title: s.title, entry: s.entry, icon: s.icon })
    }
  }
  return out
}

/** URL файла в папке плагина (для iframe / fetch / <img>/<video>). */
export function pluginFileUrl(pluginId: string, entry: string): string {
  const rel = (entry || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '')
  return `syntee-plugin://${pluginId}/${rel}`
}
