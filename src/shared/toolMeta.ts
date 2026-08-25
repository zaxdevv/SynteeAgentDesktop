/**
 * Единый источник истины для метаданных тулов (иконка, лейбл, цвет).
 *
 * Раньше было 4 отдельных маппинга в ToolChain, AgentPanel, AgentCard и
 * AgentConfirmDialog — они рассинхронизировались: один и тот же тул показывал
 * разные иконки в разных местах, многие тулы вообще не имели иконки (fallback
 * на серую zap). Теперь все компоненты импортируют отсюда getToolMeta().
 *
 * Иконки — строки-ключи из ICONS-мапы AppIcon.tsx.
 */

export interface ToolMeta {
  label: string
  icon: string
  color: string
}

export interface ResolvedToolMeta extends ToolMeta {
  isMcp?: boolean
  server?: string
}

/** Все встроенные тулы + синтетические (_limit, _loop_guard, _verification, _error). */
export const TOOL_META: Record<string, ToolMeta> = {
  // ── Файловые тулы ──
  edit_file:       { label: 'Редактировать',     icon: 'filePen',    color: '#fb923c' },
  write_file:     { label: 'Запись файла',       icon: 'fileText',   color: '#f87171' },
  read_file:      { label: 'Чтение файла',       icon: 'fileText',   color: '#60a5fa' },
  read_files:     { label: 'Чтение файлов',      icon: 'fileText',   color: '#60a5fa' },
  list_directory: { label: 'Папка',              icon: 'folder',      color: '#a78bfa' },
  find_files:     { label: 'Поиск файлов',       icon: 'search',      color: '#a78bfa' },

  // ── Команды и диагностика ──
  run_command:    { label: 'Команда',           icon: 'terminal',    color: '#f59e0b' },
  get_diagnostics:{ label: 'Диагностика',        icon: 'bug',         color: '#f59e0b' },

  // ── Поиск и контекст ──
  search_web:     { label: 'Поиск в сети',       icon: 'globe',      color: '#34d399' },
  fetch_page:    { label: 'Чтение страницы',    icon: 'downloadCloud', color: '#10b981' },
  search_images: { label: 'Поиск картинок',     icon: 'camera',       color: '#f472b6' },
  search_code:   { label: 'Поиск кода',          icon: 'code',       color: '#818cf8' },
  analyze_project:{ label: 'Анализ',             icon: 'folder',      color: '#c084fc' },
  get_fast_context:{ label: 'Быстрый контекст',  icon: 'compass',     color: '#06b6d4' },

  // ── Система и генерация ──
  get_system_info:{ label: 'Система',            icon: 'monitor',     color: '#38bdf8' },
  generate_image: { label: 'Генерация',          icon: 'image',       color: '#fb923c' },
  analyze_image:  { label: 'Распознавание',      icon: 'eye',         color: '#2dd4bf' },

  // ── Агенты ──
  spawn_agent:    { label: 'Суб-агент',          icon: 'gitBranch',   color: '#4ade80' },
  get_agent_status:{ label: 'Статус агента',     icon: 'gitBranch',   color: '#4ade80' },

  // ── Память и знания ──
  think:          { label: 'Размышление',        icon: 'brain',       color: '#94a3b8' },
  update_todo:    { label: 'План',              icon: 'listChecks',   color: '#60a5fa' },
  update_working_memory: { label: 'Память чата', icon: 'database',    color: '#34d399' },
  save_memory:    { label: 'Сохранить в память',  icon: 'database',    color: '#10b981' },
  recall_memory:  { label: 'Поиск в памяти',      icon: 'database',    color: '#059669' },
  manage_notes:   { label: 'Заметки',            icon: 'clipboard',   color: '#f59e0b' },

  // ── Расширения ──
  list_extensions:{ label: 'Расширения',        icon: 'puzzle',      color: '#a78bfa' },
  get_skill:      { label: 'Скилл',              icon: 'puzzle',      color: '#a78bfa' },

  // ── Взаимодействие ──
  ask_user:       { label: 'Вопрос',             icon: 'helpCircle',  color: '#c084fc' },

  // ── Side-chat-only ──
  get_main_chat_messages: { label: 'Чат',         icon: 'messageSquare', color: '#94a3b8' },

  // ── Синтетические тулы (генерируются в Agent.ts, не имеют schema) ──
  _limit:         { label: 'Лимит шагов',         icon: 'alertTriangle', color: '#f59e0b' },
  _loop_guard:    { label: 'Защита от цикла',     icon: 'ban',          color: '#f87171' },
  _verification:  { label: 'Проверка',            icon: 'shield',       color: '#38bdf8' },
  _error:         { label: 'Ошибка',              icon: 'alertCircle',  color: '#f87171' },
}

/** Парсит mcp__server__tool → { server, tool }. Server может содержать подчёркивания. */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null
  const rest = toolName.slice(5)
  const lastSep = rest.lastIndexOf('__')
  if (lastSep === -1) return null
  return { server: rest.slice(0, lastSep), tool: rest.slice(lastSep + 2) }
}

const FALLBACK_META: ToolMeta = { label: 'Инструмент', icon: 'zap', color: '#94a3b8' }

/**
 * Возвращает метаданные тула по имени.
 * Для MCP-тулов (mcp__server__tool) — иконка server, фиолетовый цвет,
 * isMcp=true, server — имя сервера.
 * Для неизвестных тулов — fallback (zap, серый).
 */
export function getToolMeta(name?: string, serverName?: string): ResolvedToolMeta {
  if (!name) return { ...FALLBACK_META }
  const mcpParsed = parseMcpToolName(name)
  if (mcpParsed) {
    return {
      label: mcpParsed.tool,
      icon: 'server',
      color: '#a78bfa',
      isMcp: true,
      server: serverName ?? mcpParsed.server,
    }
  }
  return TOOL_META[name] || { ...FALLBACK_META, label: name }
}
