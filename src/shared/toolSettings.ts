// Shared, renderer-safe builtin tool preferences. External tools retain their own controls.
export interface ToolSettings {
  customToolsEnabled: boolean
  disabledTools: string[]
}
export const DEFAULT_TOOL_SETTINGS: ToolSettings = { customToolsEnabled: false, disabledTools: [] }
export const PROTECTED_CORE_TOOLS = [
  'read_file', 'read_files', 'find_files', 'search_code', 'list_directory',
  'edit_file', 'write_file', 'run_command', 'get_diagnostics',
  'update_todo', 'update_working_memory', 'ask_user', 'request_access',
] as const
const coreTools = new Set<string>(PROTECTED_CORE_TOOLS)
const tools = (entries: Array<[string, string]>) => entries.map(([name, label]) => ({ name, label }))
export const OPTIONAL_TOOL_GROUPS = [
  { label: 'Исследование проекта', tools: tools([
    ['get_fast_context', 'Быстрый контекст проекта'], ['analyze_project', 'Анализ проекта'],
  ]) },
  { label: 'Интернет', tools: tools([
    ['search_web', 'Поиск в интернете'], ['fetch_page', 'Чтение веб-страниц'], ['search_images', 'Поиск изображений'],
  ]) },
  { label: 'Память и заметки', tools: tools([
    ['save_memory', 'Сохранение долгосрочной памяти'], ['recall_memory', 'Поиск в памяти'], ['manage_notes', 'Заметки'],
  ]) },
  { label: 'Агенты и чаты', tools: tools([
    ['spawn_agent', 'Запуск суб-агента'], ['get_agent_status', 'Статус суб-агента'],
    ['manage_chats', 'Делегирование в чаты'], ['manage_dots', 'Фоновые агенты Dots'],
  ]) },
  { label: 'Расширения', tools: tools([
    ['list_extensions', 'Список расширений'], ['get_skill', 'Чтение инструкций навыка'],
  ]) },
  { label: 'Медиа', tools: tools([
    ['analyze_image', 'Анализ изображений'], ['generate_image', 'Генерация изображений'],
    ['analyze_video', 'Анализ видео'], ['analyze_audio', 'Анализ и расшифровка аудио'],
  ]) },
  { label: 'Браузер', tools: tools([
    ['browser_navigate', 'Открытие страницы'], ['browser_back', 'Назад'], ['browser_forward', 'Вперёд'],
    ['browser_reload', 'Обновление страницы'], ['browser_snapshot', 'Чтение страницы'],
    ['browser_click', 'Нажатие'], ['browser_type', 'Ввод текста'], ['browser_press_key', 'Клавиши'],
    ['browser_scroll', 'Прокрутка'], ['browser_screenshot', 'Снимок страницы'],
    ['browser_tabs_list', 'Список вкладок'], ['browser_tab_new', 'Новая вкладка'],
    ['browser_tab_select', 'Выбор вкладки'], ['browser_tab_close', 'Закрытие вкладки'], ['browser_wait', 'Ожидание'],
    ['browser_fill', 'Замена текста'], ['browser_double_click', 'Двойной клик'], ['browser_right_click', 'Правый клик'],
    ['browser_hover', 'Наведение'], ['browser_focus', 'Фокус'], ['browser_select_option', 'Выбор опции'],
    ['browser_check', 'Включение флажка'], ['browser_uncheck', 'Выключение флажка'], ['browser_drag', 'Перетаскивание'],
    ['browser_wait_for', 'Ожидание условия'], ['browser_frames', 'Фреймы'], ['browser_accessibility', 'Дерево доступности Chromium'],
    ['browser_evaluate', 'Выполнение JavaScript'], ['browser_add_script', 'Инжект скрипта'], ['browser_add_style', 'Инжект CSS'],
    ['browser_console', 'Консоль'], ['browser_errors', 'Ошибки страницы'], ['browser_network', 'Сетевые события'],
    ['browser_dialog', 'Диалоги'], ['browser_downloads', 'Скачивания'], ['browser_upload', 'Загрузка файлов'],
    ['browser_cookies', 'Cookies'], ['browser_storage', 'Хранилище страницы'],
    ['browser_set_user_agent', 'User agent'], ['browser_zoom', 'Масштаб'],
    ['browser_trace_start', 'Начало трассировки'], ['browser_trace_stop', 'Завершение трассировки'],
    ['browser_performance', 'Производительность'], ['browser_permissions', 'Разрешения сайта'], ['browser_clear_cache', 'Очистка кэша'],
  ]) },
]
export function normalizeDisabledTools(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((name): name is string =>
    typeof name === 'string' && name.length > 0 && !coreTools.has(name)
      && !name.startsWith('mcp__') && !name.startsWith('plugin__')))] : []
}
export function getToolSettings(store: { get(key: string, fallback?: unknown): unknown }): ToolSettings {
  return {
    customToolsEnabled: store.get('customToolsEnabled', false) === true,
    disabledTools: normalizeDisabledTools(store.get('disabledTools', [])),
  }
}
export function isToolDisabled(name: string, settings: ToolSettings): boolean {
  return settings.customToolsEnabled && !coreTools.has(name)
    && !name.startsWith('mcp__') && !name.startsWith('plugin__')
    && settings.disabledTools.includes(name)
}
export function filterToolSchemas<T extends { function: { name: string } }>(schemas: T[], settings: ToolSettings): T[] {
  return schemas.filter(schema => !isToolDisabled(schema.function.name, settings))
}
