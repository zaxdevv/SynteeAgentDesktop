// Barrel-модуль: реэкспортирует публичное API fast-context.
// Внешние импортёры (Agent.ts, ai-worker.ts, fastContextWatcher.ts, chat.ipc.ts)
// импортируют отсюда — путь `.../context/fastContext` разрешается в этот index.
//
// Структура:
//   state.ts       — worker-local SQLite + tree-sitter lazy init + local CRUD + lexical helpers
//   symbols.ts     — tree-sitter symbol extraction (definitions/imports/references)
//   indexer.ts     — walkProjectFiles + buildOrUpdateIndex + computeGraphRank + misc
//   retriever.ts   — buildRepoMapSlice + buildContentSnippets
//   annotator.ts   — summarizeWithLLM (LLM-аннотация repo-map slice)
//   orchestrator.ts — runFastContext (3-stage: indexing → retrieving → summarizing)
//
// Внутренние символы (getDb, localGetEntries, stem, getParser и т.д.) экспортируются
// из своих модулей для intra-package использования, но НЕ реэкспортируются здесь —
// это internal API.

// init / state
export { initFastContextDb, initFastContextWasmDir, bumpRelevanceBoost } from './state'
// symbols
export { extractSymbols, extractSymbolsFromSource, type SymbolDef, type FileSymbols } from './symbols'
// symbolsCache (in-memory кэш распарсенных символов — avoids 5K JSON.parse per query)
export { getParsedSymbols, invalidateFile, clearSymbolsCache, getSymbolsCacheStats, type ParsedSymbols } from './symbolsCache'
// invertedIndex (инвертированный индекс token→Set<filePath> для O(1) pre-filter)
export { buildInvertedIndex, lookupFiles, clearInvertedIndex, clearAllInvertedIndexes, getInvertedIndexStats } from './invertedIndex'
// fileHash (быстрый content hash для точного детекта изменений)
export { quickHash } from './fileHash'
// indexer
export {
  walkProjectFiles, buildOrUpdateIndex, computeGraphRank,
  resetFastContextIndex, getFastContextStats, getIndexSettings,
  type IndexProgress, type ProgressCallback,
} from './indexer'
// retriever
export { buildRepoMapSlice, buildContentSnippets } from './retriever'
// annotator
export { summarizeWithLLM, type FastContextFile, type FastContextResult } from './annotator'
// orchestrator
export { runFastContext } from './orchestrator'
// settings (re-export из fastContextSettings — pure types/constants, renderer-safe)
export {
  type IndexingSettings,
  DEFAULT_INDEXING_SETTINGS,
  DEFAULT_IGNORE_DIRS_LIST,
  getIndexSettingsFromRecord,
} from '../fastContextSettings'
