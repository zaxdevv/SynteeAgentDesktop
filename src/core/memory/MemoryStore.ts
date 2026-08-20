/**
 * MemoryStore — унифицированное хранилище памяти агента.
 *
 * Этот файл теперь — barrel re-export из директории `store/`, где логика
 * разбита по доменам:
 *   - store/_shared.ts   — типы + внутренние хелперы
 *   - store/items.ts     — CRUD для memory_items
 *   - store/search.ts    — multi-source поиск
 *   - store/stats.ts     — статистика
 *   - store/utils.ts     — утилиты (decayPrune, bumpMemoryHit)
 *   - store/categories.ts — динамические категории
 *
 * Все прежние экспорты сохранены — существующие импорты работают без изменений.
 *
 * 4 типа памяти (kind):
 *   - user_fact         — факты о пользователе (личное, предпочтения, работа)
 *   - project_decision  — архитектурные решения/конвенции проекта
 *   - conversation      — эпизодическая: итоги прошлых диалогов
 *   - agent_outcome     — уроки из исходов действий агента
 *
 * 3 scope:
 *   - global  — сквозная память через все проекты/чаты
 *   - project — привязана к конкретному project_id
 *   - chat    — только в пределах одного чата (для agent_outcome)
 */
export * from './store'
