/**
 * Человекочитанные подписи и шкала серьёзности прав плагинов.
 *
 * Единый источник для карточек плагинов (PluginsTab) и consent-диалога:
 * PERMISSION_LABELS — что означает право «по-человечески»,
 * PERMISSION_SEVERITY — насколько оно опасное (цвет бейджа, сортировка),
 * pluginCapabilities — короткая витрина «что плагин реально делает»
 * по набору прав из манифеста (без чтения кода).
 */

/** Подписи всех прав из PluginPermission (см. shared/types/plugin.ts). */
export const PERMISSION_LABELS: Record<string, string> = {
  'net': 'сеть (HTTP-запросы, внешние ссылки)',
  'fs:read': 'чтение файлов',
  'fs:write': 'запись файлов (в папке плагина)',
  'fs:write:any': 'запись/удаление файлов в любых путях',
  'clipboard': 'буфер обмена',
  'notifications': 'уведомления',
  'ui': 'UI приложения (панели, виджеты, темы)',
  'chat': 'действия в чате (отправка/ответы)',
  'chats:read': 'чтение чатов и сообщений',
  'chats:write': 'создание/правка/удаление чатов и сообщений',
  'projects:read': 'чтение списка проектов',
  'projects:write': 'создание проектов',
  'memory': 'долговременная память приложения',
  'ai': 'доступ к LLM через хост',
  'scheduler': 'планировщик (таймеры, cron)',
  'shortcuts': 'глобальные горячие клавиши',
  'process:exec': 'запуск shell-команд',
  'overlay': 'overlay-окно поверх всего',
  'tray': 'пункты меню в трее',
  'context': 'контент в system prompt',
  'secrets': 'шифрованное хранилище секретов',
  'git': 'git-операции по workdir',
  'mcp': 'вызов тулов MCP-серверов',
  'webhook': 'локальный HTTP-сервер (приём запросов)',
  'agent': 'вызов host-тулов агента',
  'hooks': 'хуки: переписка, вызовы тулов, system prompt',
}

/** Серьёзность права: high — красный, medium — жёлтый, low — нейтральный. */
export type PermSeverity = 'high' | 'medium' | 'low'

export const PERMISSION_SEVERITY: Record<string, PermSeverity> = {
  'fs:write:any': 'high',
  'process:exec': 'high',
  'agent': 'high',
  'secrets': 'high',
  'webhook': 'high',
  'net': 'high',
  'mcp': 'high',
  'git': 'high',
  'fs:write': 'medium',
  'chat': 'medium',
  'chats:write': 'medium',
  'chats:read': 'medium',
  'hooks': 'medium',
  'context': 'medium',
  'memory': 'medium',
  'ai': 'medium',
  'projects:write': 'medium',
  'shortcuts': 'medium',
  'overlay': 'medium',
  'tray': 'medium',
  'scheduler': 'medium',
  'fs:read': 'low',
  'ui': 'low',
  'clipboard': 'low',
  'notifications': 'low',
  'projects:read': 'low',
}

/** Серьёзность права (unknown → 'low'). */
export function permSeverity(perm: string): PermSeverity {
  return PERMISSION_SEVERITY[perm] ?? 'low'
}

const SEVERITY_ORDER: Record<PermSeverity, number> = { high: 0, medium: 1, low: 2 }

/** Сортировка прав по серьёзности (high → medium → low, алфавит внутри). */
export function sortBySeverity(perms: string[]): string[] {
  return [...perms].sort((a, b) => {
    const d = SEVERITY_ORDER[permSeverity(a)] - SEVERITY_ORDER[permSeverity(b)]
    return d !== 0 ? d : a.localeCompare(b)
  })
}

/** Есть ли среди прав хотя бы одно high-серьёзности. */
export function hasHighRiskPermission(perms: string[]): boolean {
  return perms.some(p => permSeverity(p) === 'high')
}

/** Короткая витрина «что плагин делает» по набору прав.
 *  Порядок важен (самое заметное — первым), максимум 4 пункта. */
export function pluginCapabilities(perms: string[]): string[] {
  const has = (...list: string[]) => list.some(p => perms.includes(p))
  const out: string[] = []
  if (has('hooks', 'context')) out.push('меняет system prompt')
  if (has('hooks', 'chats:read')) out.push('читает переписку')
  if (has('chat', 'chats:write')) out.push('пишет в чат')
  if (has('process:exec', 'agent')) out.push('запускает команды')
  if (has('fs:write', 'fs:write:any')) out.push('работа с файлами')
  if (has('net', 'webhook')) out.push('доступ к сети')
  if (has('secrets')) out.push('доступ к секретам')
  if (has('ai')) out.push('запускает LLM')
  return out.slice(0, 4)
}
