import { sep } from 'path'
import type Store from 'electron-store'
import { getEmbedder, setActiveProjectId, setUseNeuralEmbeddings, type Embedding } from '../embeddings'
import { buildOrUpdateIndex, getIndexSettings, type IndexProgress, type ProgressCallback } from './indexer'
import { localGetIndexCount } from './state'
import { buildRepoMapSlice, buildContentSnippets } from './retriever'
import { summarizeWithLLM, type FastContextFile, type FastContextResult } from './annotator'

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Главная точка входа — вызывается тулзой get_fast_context.
 * Шлёт progress callbacks для 3-stage UI (indexing → retrieving → summarizing).
 */
export async function runFastContext(
  projectId: string,
  workdir: string,
  query: string,
  store: Store,
  opts: { maxFiles?: number; maxTokens?: number; signal?: AbortSignal } = {},
  onProgress?: ProgressCallback,
): Promise<FastContextResult> {
  const startedAt = Date.now()
  const maxFiles = opts.maxFiles ?? 50
  const maxTokens = opts.maxTokens ?? 8000

  // Читаем настройки индексации из store и применяем neural-режим.
  // setUseNeuralEmbeddings переключает embedder: ONNX/MiniLM vs TF-IDF.
  const idxSettings = getIndexSettings(store)
  setUseNeuralEmbeddings(idxSettings.neuralEmbeddings)

  // Устанавливаем active project для TF-IDF (per-project IDF cache)
  setActiveProjectId(projectId)

  // Stage 1: indexing (incremental, обычно мгновенно если индекс уже тёплый)
  onProgress?.({ stage: 'indexing', detail: 'Сканирование файлов', filesProcessed: 0, filesTotal: 0 })
  await buildOrUpdateIndex(projectId, workdir, undefined, onProgress, { settings: idxSettings })
  // buildOrUpdateIndex возвращает число ИЗМЕНЁННЫХ файлов; общее число в
  // индексе для «Поиск по N файлам» берём дешёвым COUNT(*).
  const indexedCount = localGetIndexCount(projectId)

  // Stage 2: retrieving
  onProgress?.({ stage: 'retrieving', detail: `Поиск по ${indexedCount} файлам`, filesProcessed: 0, filesTotal: 0 })
  // Semantic: embed query для cosine similarity vs file embeddings
  let queryEmb: Embedding | null = null
  try {
    const embedder = await getEmbedder()
    queryEmb = await embedder.embed(query)
  } catch { /* embeddings опциональны — lexical-only fallback */ }
  const { slice, topFiles } = buildRepoMapSlice(projectId, query, maxFiles, maxTokens, queryEmb)

  if (topFiles.length === 0) {
    onProgress?.({ stage: 'done', detail: 'Ничего не найдено' })
    return {
      files: [],
      summary: 'Не найдено релевантных файлов по запросу. Возможно индекс пуст или запрос не matches ни одному символу.',
      ms: Date.now() - startedAt,
      indexedFilesCount: indexedCount,
    }
  }

  // Emit найденных файлов для live-UI (chips появляются по мере "нахождения")
  onProgress?.({
    stage: 'retrieving',
    detail: `Найдено ${topFiles.length} файлов`,
    filesFound: topFiles.map(f => ({
      path: f.path,
      score: f.score,
      why: `${f.definitions.length} symbols, score ${f.score.toFixed(2)}`,
    })),
  })

  // Content snippets: читаем top-5 файлов (50 строк вокруг релевантного символа).
  // Даёт LLM реальный код для более точного выбора файлов и line ranges.
  onProgress?.({ stage: 'retrieving', detail: 'Чтение content snippets', filesProcessed: 0, filesTotal: 0 })
  // Токенизируем query для query-relevant snippets (внешний scope, т.к. buildRepoMapSlice — отдельная функция)
  const stopWordsOuter = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or', 'not', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'how', 'what', 'where', 'why', 'when', 'who', 'which', 'do', 'does', 'did', 'find', 'show', 'get', 'give', 'me', 'please', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these', 'those', 'my', 'your', 'его', 'её', 'их', 'где', 'что', 'как', 'какой', 'какая', 'найти', 'покажи', 'дай', 'сделай', 'сделать', 'для', 'из', 'на', 'в', 'не', 'и', 'или', 'но'])
  const outerQueryTokens = query.toLowerCase()
    .split(/[^a-zа-я0-9_]+/i)
    .filter(t => t.length >= 2 && !stopWordsOuter.has(t))
  const snippets = await buildContentSnippets(topFiles, 5, 3, 30, outerQueryTokens)
  const fullSlice = snippets ? slice + snippets : slice

  // Stage 3: summarizing (LLM вызов)
  onProgress?.({ stage: 'summarizing', detail: `LLM анализ ${topFiles.length} файлов`, filesProcessed: 0, filesTotal: 0 })
  const llmResult = await summarizeWithLLM(store, query, fullSlice, opts.signal)

  onProgress?.({ stage: 'done', detail: `${llmResult?.files.length ?? 0} файлов найдено` })

  // Валидация путей LLM: оставляем только файлы из topFiles (drop hallucinations).
  // Если LLM вернул неточный путь — пытаемся сопоставить по basename.
  const validPaths = new Set(topFiles.map(f => f.path))
  const basenameMap = new Map<string, string>()
  for (const f of topFiles) {
    const base = f.path.split(sep).pop()!.toLowerCase()
    if (!basenameMap.has(base)) basenameMap.set(base, f.path)
  }

  const validatedFiles: FastContextFile[] = []
  if (llmResult?.files && llmResult.files.length > 0) {
    for (const f of llmResult.files) {
      if (validPaths.has(f.path)) {
        validatedFiles.push(f)
        continue
      }
      // Fuzzy: match by basename
      const base = f.path.split('/').pop()!.split('\\').pop()!.toLowerCase()
      const matched = basenameMap.get(base)
      if (matched) {
        validatedFiles.push({ ...f, path: matched })
      }
      // Полностью несопоставленные пути отбрасываем (hallucinations)
    }
  }

  // Если LLM не вернул валидных files — fallback: topFiles из retrieval
  const files = validatedFiles.length > 0
    ? validatedFiles
    : topFiles.slice(0, maxFiles).map(f => ({
        path: f.path,
        lineRanges: f.definitions.length > 0 ? `${f.definitions[0].lineStart}-${f.definitions[0].lineEnd}` : '',
        why: `Top match (score: ${f.score.toFixed(2)}, ${f.definitions.length} symbols)`,
      }))

  return {
    files,
    summary: llmResult?.summary || `Найдено ${files.length} релевантных файлов по запросу.`,
    ms: Date.now() - startedAt,
    indexedFilesCount: indexedCount,
  }
}
