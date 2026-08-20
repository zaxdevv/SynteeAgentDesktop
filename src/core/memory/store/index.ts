/**
 * store/index.ts — barrel re-export для MemoryStore.
 *
 * Собирает все экспорты из доменных модулей: items, search, stats, utils,
 * categories, _shared (типы). MemoryStore.ts просто ре-экспортирует отсюда.
 */

export * from './_shared'
export * from './items'
export * from './search'
export * from './stats'
export * from './utils'
export * from './categories'
