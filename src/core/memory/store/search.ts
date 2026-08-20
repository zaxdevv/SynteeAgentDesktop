/**
 * search.ts — поиск по памяти (multi-source).
 *
 * Содержит: searchMemory (гибридный скоринг), searchAllSources (multi-source
 * для recall_memory), buildCuratedSummary (сводка для системного промпта).
 */

import { getDB } from '../../db/handle'
import { cosineSimilarity, bufferToEmbedding } from '../../context/embeddings'
import {
  searchMessagesFTS,
  searchChatSummaries,
  searchAgentLogs,
  searchPinnedMessages,
  sanitizeFtsQuery,
  type SearchSourceName,
} from '../chatSearch'
import {
  embedText,
  rowToItem,
  type Embedding,
  type MemoryItem,
  type SearchMemoryParams,
  type SearchResult,
  type MultiSourceResult,
} from './_shared'

// ─── GRAPH DIRECT SEARCH (прямой поиск по графу по keywords) ─────────────────

/**
 * Прямой поиск по knowledge graph по ключевым словам запроса.
 * В отличие от expandFromGraph (который расширяет уже найденные memory items),
 * эта функция ищет узлы графа НАПРЯМУЮ по label — files, decisions, concepts,
 * symbols — и достаёт их 1-hop соседей с типами рёбер.
 *
 * Возвращает формат: "[graph:file] contextManager.ts →imports→ embeddings.ts, →calls→ cosineSimilarity"
 * — AI видит карту связей проекта без вызова тулов.
 *
 * Работает БЕЗ memory hits — графа ищется напрямую.
 * Score: на основе weight узла (0.3-0.55).
 */
export function searchGraphDirect(query: string, projectId: string): MultiSourceResult[] {
  const db = getDB()

  // Извлекаем keywords из запроса (убираем stopwords, берём значимые термины)
  const keywords = query
    .toLowerCase()
    .replace(/[^\w\u0400-\u04FF]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .slice(0, 8)
  if (keywords.length === 0) return []

  try {
    // Ищем узлы графа по label LIKE %keyword%
    const conditions = keywords.map(() => `LOWER(label) LIKE ?`).join(' OR ')
    const args = keywords.map(k => `%${k}%`)
    const nodes = db.prepare(
      `SELECT id, type, label, weight FROM memory_graph_nodes
       WHERE project_id = ? AND (${conditions})
       ORDER BY weight DESC LIMIT 10`
    ).all(projectId, ...args) as Array<{ id: string; type: string; label: string; weight: number }>

    if (nodes.length === 0) return []

    const results: MultiSourceResult[] = []
    const edgeLabels: Record<string, string> = {
      imports: '→imports→',
      calls: '→calls→',
      references: '→refs→',
      affects: '→affects→',
      mentions: '→mentions→',
      implemented_in: '→impl-in→',
      depends_on: '→depends→',
      supersedes: '→replaces→',
      implements: '→implements→',
    }

    for (const node of nodes.slice(0, 7)) {
      // Достаём 1-hop соседей с типами рёбер
      const neighbors = db.prepare(
        `SELECT
           n2.label as neighbor_label,
           e.type as edge_type,
           CASE WHEN e.from_node = ? THEN 'out' ELSE 'in' END as direction
         FROM memory_graph_edges e
         JOIN memory_graph_nodes n2 ON n2.id = CASE WHEN e.from_node = ? THEN e.to_node ELSE e.from_node END
         WHERE e.project_id = ? AND (e.from_node = ? OR e.to_node = ?)
         ORDER BY e.weight DESC LIMIT 5`
      ).all(node.id, node.id, projectId, node.id, node.id) as Array<{
        neighbor_label: string; edge_type: string; direction: string
      }>

      // Форматируем: "[graph:file] contextManager.ts →imports→ embeddings.ts, →calls→ cosineSimilarity"
      const connections = neighbors
        .map(n => `${edgeLabels[n.edge_type] ?? `→${n.edge_type}→`} ${n.neighbor_label}`)
        .join(', ')

      const content = connections
        ? `[graph:${node.type}] ${node.label} ${connections}`
        : `[graph:${node.type}] ${node.label}`

      results.push({
        source: 'graph' as const,
        content,
        score: Math.min(0.55, 0.3 + (node.weight ?? 1) * 0.05),
      })
    }

    return results
  } catch {
    return []
  }
}

// ─── GRAPH EXPANSION (1-hop соседи найденных memory items) ───────────────────

/**
 * Графовая экспансия: найденные memory items → их узлы в knowledge graph →
 * 1-hop соседи (связанные файлы/концепты/решения). Добавляет ассоциативный
 * контекст, который прямой поиск по ключевым словам не находит.
 *
 * Ограничения: max 3 соседа, score 0.4 (ниже прямых попаданий, но выше
 * LIKE-fallback). Работает только для project-scope (граф per-project).
 */
function expandFromGraph(
  memoryResults: MultiSourceResult[],
  projectId: string | undefined,
): MultiSourceResult[] {
  if (!projectId) return []
  const db = getDB()
  const itemIds = memoryResults
    .filter(r => r.source === 'memory' && r.item?.id)
    .map(r => r.item!.id)
    .slice(0, 5) // расширяем только от top-5 memory hits
  if (itemIds.length === 0) return []

  try {
    const ph = itemIds.map(() => '?').join(',')
    // Узлы графа, созданные из найденных memory items
    const seedNodes = db.prepare(
      `SELECT id FROM memory_graph_nodes
       WHERE project_id = ? AND source_kind = 'memory_item' AND source_id IN (${ph})`
    ).all(projectId, ...itemIds) as Array<{ id: string }>
    if (seedNodes.length === 0) return []
    const seedIds = seedNodes.map(n => n.id)

    // 1-hop соседи: рёбра из seed-узлов + входящие рёбра, JOIN на соседние узлы
    const sph = seedIds.map(() => '?').join(',')
    const neighborRows = db.prepare(
      `SELECT DISTINCT n.id, n.type, n.label, n.source_id, n.source_kind, n.weight
       FROM memory_graph_edges e
       JOIN memory_graph_nodes n ON (n.id = e.to_node OR n.id = e.from_node)
       WHERE e.project_id = ?
         AND (e.from_node IN (${sph}) OR e.to_node IN (${sph}))
         AND n.id NOT IN (${sph})
       ORDER BY n.weight DESC
       LIMIT 5`
    ).all(projectId, ...seedIds, ...seedIds) as Array<{
      id: string; type: string; label: string; source_id: string | null; source_kind: string | null; weight: number
    }>
    if (neighborRows.length === 0) return []

    return neighborRows.map(n => ({
      source: 'graph' as const,
      content: `[graph:${n.type}] ${n.label}${n.source_kind === 'memory_item' && n.source_id ? ' (related memory item)' : ''}`,
      // Score на основе weight узла: 0.3 + weight * 0.2 (weight обычно 1-5)
      score: Math.min(0.55, 0.3 + (n.weight ?? 1) * 0.05),
    }))
  } catch {
    // Граф недоступен — expansion просто не добавляет ничего
    return []
  }
}

// ─── SEARCH (гибридный скоринг) ──────────────────────────────────────────────

/**
 * Семантический поиск по памяти. Гибридный скоринг:
 *   combo = tfidfCosine * 12 + importance * 1.5 + recencyBoost * 1.5
 *         + pinned * 0.8 + likeBoost + ftsBoost
 *
 * Два канала кандидатов:
 *   1. TF-IDF cosine по top-500 importance (основной сигнал, мгновенно)
 *   2. FTS5 trigram (memory_fts) — морфология ('улучшени' → 'улучшение')
 *      и записи вне top-500; попадания получают ftsBoost
 *
 * Read-only: не инкрементит access_count — usage-обратная связь живёт в
 * bumpMemoryHit (вызывается recall-хендлером), чтобы не было двойного учёта.
 */
export async function searchMemory(params: SearchMemoryParams): Promise<SearchResult[]> {
  const db = getDB()
  const limit = params.limit ?? 8
  const minScore = params.minScore ?? 0.01

  // ── Scope filter ──
  let scopeWhere: string
  const scopeArgs: unknown[] = []
  if (params.scope === 'global') {
    scopeWhere = `scope = 'global'`
  } else if (params.scope === 'project' && params.projectId) {
    scopeWhere = `scope = 'project' AND project_id = ?`
    scopeArgs.push(params.projectId)
  } else if (params.scope === 'chat' && params.projectId) {
    // 'chat' трактуем как project+chat — но для простоты ищем в project scope
    scopeWhere = `scope = 'project' AND project_id = ?`
    scopeArgs.push(params.projectId)
  } else {
    // 'all' (default): global + текущий проект
    scopeWhere = `(scope = 'global' OR (scope = 'project' AND project_id = ?))`
    scopeArgs.push(params.projectId ?? '__none__')
  }

  // ── Kind filter ──
  let kindWhere = ''
  const kindArgs: unknown[] = []
  if (params.kind) {
    kindWhere = `AND kind = ?`
    kindArgs.push(params.kind)
  }

  // Берём top-500 по importance (чтобы не гонять cosine по всей базе).
  // LIKE pre-filter убран — он исключал семантически релевантные записи,
  // не содержащие точной подстроки запроса. TF-IDF cosine + LIKE boost
  // в скоринге ниже обеспечивают ранжирование без потери recall.
  const rows = db.prepare(
    `SELECT * FROM memory_items WHERE ${scopeWhere} ${kindWhere}
     ORDER BY importance DESC, updated_at DESC LIMIT 500`
  ).all(...scopeArgs, ...kindArgs) as Record<string, unknown>[]

  // ── FTS5 trigram канал ──
  // Второй источник кандидатов: морфология (критично для русского) и записи
  // вне top-500 importance. FTS-попадания получают boost в скоринге ниже.
  // FTS5 MATCH и bm25() требуют имя таблицы (не алиас): memory_fts, не mfts.
  // scope/kind фильтры квалифицируем mi. — FTS5 table не имеет этих колонок.
  const ftsIds = new Set<string>()
  const ftsQuery = sanitizeFtsQuery(params.query)
  if (ftsQuery) {
    try {
      // Перестроить scopeWhere/kindWhere с mi. префиксом для JOIN
      const miScopeWhere = scopeWhere
        .replace(/\bscope\b/g, 'mi.scope')
        .replace(/\bproject_id\b/g, 'mi.project_id')
      const miKindWhere = kindWhere.replace(/\bkind\b/g, 'mi.kind')
      const ftsRows = db.prepare(
        `SELECT mfts.item_id
         FROM memory_fts mfts
         JOIN memory_items mi ON mi.id = mfts.item_id
         WHERE memory_fts MATCH ? AND ${miScopeWhere} ${miKindWhere}
         ORDER BY bm25(memory_fts)
         LIMIT 100`
      ).all(ftsQuery, ...scopeArgs, ...kindArgs) as Array<{ item_id: string }>
      for (const r of ftsRows) ftsIds.add(r.item_id)
      // Догружаем full rows для FTS-кандидатов вне top-500
      const known = new Set(rows.map(r => r.id as string))
      const missing = [...ftsIds].filter(id => !known.has(id))
      if (missing.length > 0) {
        const mph = missing.map(() => '?').join(',')
        const extraRows = db.prepare(
          `SELECT * FROM memory_items WHERE id IN (${mph})`
        ).all(...missing) as Record<string, unknown>[]
        rows.push(...extraRows)
      }
    } catch { /* memory_fts недоступна — работает только TF-IDF канал */ }
  }

  if (rows.length === 0) return []

  // ── Embed query ──
  let queryEmb: Embedding | null = null
  try { queryEmb = await embedText(params.query) } catch { /* skip */ }

  // ── Score каждой записи ──
  const now = Date.now()
  const scored: Array<{ item: MemoryItem; score: number }> = []

  for (const row of rows) {
    let tfidfCos = 0

    if (queryEmb && row.embedding) {
      try {
        const itemEmb = bufferToEmbedding(row.embedding as Buffer)
        tfidfCos = cosineSimilarity(queryEmb, itemEmb)
      } catch { /* skip */ }
    }

    // Substring match check — используется для TF-IDF fallback и LIKE boost.
    // Проверяем и content, и title.
    const contentLower = (row.content as string).toLowerCase()
    const titleLower = ((row.title as string) ?? '').toLowerCase()
    const queryLower = params.query.toLowerCase()
    const hasSubstring = queryLower.length > 0 &&
      (contentLower.includes(queryLower) || titleLower.includes(queryLower))

    // LIKE-fallback если embedding отсутствует или cosine=0
    if (tfidfCos === 0 && hasSubstring) {
      tfidfCos = 0.3 // базовый score за substring match
    }

    const importance = (row.importance as number) ?? 0.5
    const lastAccessed = row.last_accessed_at as number | null
    // Recency boost: 1.0 если доступалась только что, 0.0 если >30 дней
    const recencyBoost = lastAccessed
      ? Math.max(0, 1 - (now - lastAccessed) / (30 * 24 * 60 * 60 * 1000))
      : 0
    const pinnedBoost = (row.pinned as number) ? 0.5 : 0

    // Tuned: TF-IDF is the primary signal (×12), importance reduced (×0.5)
    // so low-importance but relevant items surface over high-importance
    // but irrelevant ones. Recency ×0.8 — minor tiebreaker.
    // LIKE boost (+1.0) — точное совпадение подстроки чуть повышает ранг,
    // но не исключает семантически релевантные записи без подстроки.
    // FTS boost (+2.5) — trigram-совпадение по слову (морфология).
    const likeBoost = hasSubstring ? 1.0 : 0
    const ftsBoost = ftsIds.has(row.id as string) ? 2.5 : 0
    const combo = tfidfCos * 12 + importance * 0.5 + recencyBoost * 0.8 + pinnedBoost * 0.8 + likeBoost + ftsBoost
    if (combo < minScore) continue

    scored.push({ item: rowToItem(row), score: combo })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

// ─── MULTI-SOURCE SEARCH (recall_memory) ─────────────────────────────────────

/**
 * Multi-source поиск для recall_memory. Параллельно ищет по 5 источникам:
 *   1. memory_items (TF-IDF + importance + recency) — через searchMemory
 *   2. messages (FTS5 trigram + bm25)               — через searchMessagesFTS
 *   3. chat_summaries (LIKE + recency)              — через searchChatSummaries
 *   4. agent_logs (LIKE, recent 14d)                — через searchAgentLogs
 *   5. pinned_messages (FTS5 + boost)               — через searchPinnedMessages
 *
 * Каждый источник даёт top-3, merge по normalized score, общий top-15.
 * Scope-логика:
 *   - memory_items: global ВСЕГДА + project если есть projectId
 *   - chat-источники: project_id = projectId ИЛИ IS NULL если нет projectId
 *
 * Параметр sources позволяет сузить поиск (например только memory + messages).
 * Default: 'all' (все 5 источников).
 */
export async function searchAllSources(params: SearchMemoryParams): Promise<MultiSourceResult[]> {
  const sources = params.sources ?? 'all'
  const allSources: SearchSourceName[] = sources === 'all'
    ? ['memory', 'messages', 'summaries', 'agent_logs', 'pinned']
    : (sources as SearchSourceName[])

  const perSourceLimit = 5
  const totalLimit = params.limit ?? 20

  const crossProject = params.crossProject ?? false
  // When crossProject, chat sources search ALL projects (pass undefined projectId)
  const chatProjectId = crossProject ? undefined : params.projectId

  // Запускаем все источники параллельно. memory_items — async (TF-IDF embedding),
  // остальные — sync (FTS5/LIKE). Оборачиваем в Promise.all для единообразия.
  const tasks: Promise<MultiSourceResult[]>[] = []

  if (allSources.includes('memory')) {
    tasks.push(
      (async () => {
        const results = await searchMemory({
          query: params.query,
          kind: params.kind,
          scope: crossProject ? 'all' : params.scope,
          projectId: crossProject ? undefined : params.projectId,
          limit: perSourceLimit,
          minScore: params.minScore,
        })
        // Нормализуем score memory_items в 0..1.
        // combo = tfidfCos*12 + importance*0.5 + recency*0.8 + pinned*0.8
        //       + like + fts (макс ~17.6, типичный хороший матч 5-10).
        // Насыщающая экспонента с /8: combo 5 → 0.46, combo 8 → 0.63,
        // combo 12 → 0.78 — более дискриминативно, слабые матчи (combo 2-3)
        // получают 0.22-0.31 вместо 0.28-0.39 при /6 — лучше отделяет
        // релевантное от нерелевантного.
        return results.map(r => ({
          source: 'memory' as const,
          content: r.item.content,
          score: 1 - Math.exp(-r.score / 8),
          item: r.item,
        }))
      })()
    )
  }

  if (allSources.includes('messages')) {
    tasks.push(
      Promise.resolve(
        searchMessagesFTS(params.query, chatProjectId, perSourceLimit, crossProject)
          .map(r => ({ ...r, source: r.source as 'messages' }))
      )
    )
  }

  if (allSources.includes('summaries')) {
    tasks.push(
      Promise.resolve(
        searchChatSummaries(params.query, chatProjectId, perSourceLimit, crossProject)
          .map(r => ({ ...r, source: r.source as 'summaries' }))
      )
    )
  }

  if (allSources.includes('agent_logs')) {
    tasks.push(
      Promise.resolve(
        searchAgentLogs(params.query, chatProjectId, perSourceLimit, crossProject)
          .map(r => ({ ...r, source: r.source as 'agent_logs' }))
      )
    )
  }

  if (allSources.includes('pinned')) {
    tasks.push(
      Promise.resolve(
        searchPinnedMessages(params.query, chatProjectId, perSourceLimit, crossProject)
          .map(r => ({ ...r, source: r.source as 'pinned' }))
      )
    )
  }

  const perSourceResults = await Promise.all(tasks)

  // Merge all results. Дедуп: точный (первые 100 символов) + MMR-диверсификация.
  const seen = new Set<string>()
  const merged: MultiSourceResult[] = []
  for (const results of perSourceResults) {
    for (const r of results) {
      const dedupKey = r.content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100)
      if (dedupKey && seen.has(dedupKey)) continue
      if (dedupKey) seen.add(dedupKey)
      merged.push(r)
    }
  }

  // Прямой поиск по графу: ищет узлы (files, decisions, concepts) по keywords
  // запроса напрямую — БЕЗ зависимости от memory hits. Даёт AI карту связей.
  // Только при наличии projectId (граф per-project) и не в crossProject mode.
  if (!crossProject && params.projectId) {
    const graphDirectResults = searchGraphDirect(params.query, params.projectId)
    merged.push(...graphDirectResults)
  }

  // Графовая экспансия: 1-hop соседи top memory hits (только если memory
  // источник включён и есть projectId). Добавляется после дедупа.
  if (allSources.includes('memory') && !crossProject) {
    const graphResults = expandFromGraph(merged, params.projectId)
    merged.push(...graphResults)
  }

  // MMR (Maximal Marginal Relevance) диверсификация:
  // Сортируем по score, затем итеративно выбираем: берём топ-1, затем
  // для каждого следующего кандидата проверяем word-overlap (Jaccard)
  // с уже выбранными. Если similarity > 0.65 — пропускаем (дубликат темы).
  // Это убирает 5 одинаковых результатов об одном и том же, оставляя
  // разнообразные релевантные записи из разных источников.
  merged.sort((a, b) => b.score - a.score)

  const selected: MultiSourceResult[] = []
  const selectedWordSets: Set<string>[] = []
  const MMR_SIM_THRESHOLD = 0.65
  let graphCount = 0
  const MAX_GRAPH_ENTRIES = 5 // граф-результаты — ассоциативные, не больше 5 из 20

  for (const candidate of merged) {
    if (selected.length >= totalLimit) break

    // Graph entries — всегда пропускаем без MMR (они ассоциативные),
    // но ограничиваем количество чтобы не забить топ.
    if (candidate.source === 'graph') {
      if (graphCount >= MAX_GRAPH_ENTRIES) continue
      graphCount++
      selected.push(candidate)
      continue
    }

    // Вычисляем word set кандидата
    const candWords = new Set(
      candidate.content.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    )
    if (candWords.size === 0) {
      selected.push(candidate)
      selectedWordSets.push(candWords)
      continue
    }

    // Максимальная схожесть с уже выбранными
    let maxSim = 0
    for (const selWords of selectedWordSets) {
      if (selWords.size === 0) continue
      let intersection = 0
      for (const w of candWords) {
        if (selWords.has(w)) intersection++
      }
      const union = candWords.size + selWords.size - intersection
      const sim = union > 0 ? intersection / union : 0
      if (sim > maxSim) maxSim = sim
    }

    if (maxSim < MMR_SIM_THRESHOLD) {
      selected.push(candidate)
      selectedWordSets.push(candWords)
    }
  }

  return selected
}

/**
 * Компактная сводка памяти для системного промпта (~500 токенов).
 * Заменяет getAllMemoriesForContext() из MemoryEngine.ts.
 *
 *   - top-8 global user_fact (по importance × confidence × recency)
 *   - top-3 global convention / agent_outcome / project_decision
 *     (глобальные уроки и правила раньше были невидимы в промпте)
 *   - top-8 project_decision для текущего проекта (если есть)
 *   - top-5 project convention, top-3 conversation, top-3 agent_outcome
 *
 * Бюджет токенов вместо дампа всей базы — масштабируется.
 */
export function buildCuratedSummary(projectId?: string): string {
  const db = getDB()
  const lines: string[] = []

  // ── Global user_facts ──
  const globalFacts = db.prepare(
    `SELECT * FROM memory_items
     WHERE scope = 'global' AND kind = 'user_fact'
     ORDER BY importance DESC, confidence DESC, updated_at DESC LIMIT 8`
  ).all() as Record<string, unknown>[]

  if (globalFacts.length > 0) {
    lines.push('[Память о пользователе]')
    const labels: Record<string, string> = {
      personal: 'Личное',
      work: 'Работа',
      preferences: 'Предпочтения',
      projects: 'Проекты',
      facts: 'Факты',
    }
    const grouped: Record<string, string[]> = {}
    for (const f of globalFacts) {
      const cat = (f.category as string) || 'facts'
      if (!grouped[cat]) grouped[cat] = []
      const title = (f.title as string) || (f.content as string)
      grouped[cat].push(title)
    }
    for (const [cat, items] of Object.entries(grouped)) {
      const label = labels[cat] || cat
      lines.push(`${label}: ${items.join('; ')}`)
    }
  }

  // ── Global conventions (gotchas/traps — применяются во ВСЕХ проектах) ──
  const globalConventions = db.prepare(
    `SELECT title, content FROM memory_items
     WHERE scope = 'global' AND kind = 'convention'
     ORDER BY importance DESC, updated_at DESC LIMIT 3`
  ).all() as Array<{ title: string; content: string }>

  if (globalConventions.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('[Глобальные конвенции]')
    for (const c of globalConventions) {
      lines.push(`- ${(c.title || c.content).slice(0, 120)}`)
    }
  }

  // ── Global lessons (agent_outcome — уроки, применимые везде) ──
  const globalLessons = db.prepare(
    `SELECT title, content FROM memory_items
     WHERE scope = 'global' AND kind = 'agent_outcome'
     ORDER BY importance DESC, updated_at DESC LIMIT 3`
  ).all() as Array<{ title: string; content: string }>

  if (globalLessons.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('[Глобальные уроки]')
    for (const l of globalLessons) {
      lines.push(`- ${(l.title || l.content).slice(0, 120)}`)
    }
  }

  // ── Global decisions (архитектурные решения, применимые везде) ──
  const globalDecisions = db.prepare(
    `SELECT title, content FROM memory_items
     WHERE scope = 'global' AND kind = 'project_decision'
     ORDER BY importance DESC, updated_at DESC LIMIT 3`
  ).all() as Array<{ title: string; content: string }>

  if (globalDecisions.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('[Глобальные решения]')
    for (const d of globalDecisions) {
      lines.push(`- ${(d.title || d.content).slice(0, 120)}`)
    }
  }

  // ── Project decisions ──
  if (projectId) {
    const decisions = db.prepare(
      `SELECT * FROM memory_items
       WHERE scope = 'project' AND project_id = ? AND kind = 'project_decision'
       ORDER BY importance DESC, updated_at DESC LIMIT 8`
    ).all(projectId) as Record<string, unknown>[]

    if (decisions.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('[Решения проекта]')
      for (const d of decisions) {
        const title = (d.title as string) || (d.content as string)
        lines.push(`- ${title}`)
      }
    }
  }

  // ── Project conventions ──
  if (projectId) {
    const conventions = db.prepare(
      `SELECT title, content FROM memory_items
       WHERE scope = 'project' AND project_id = ? AND kind = 'convention'
       ORDER BY importance DESC, updated_at DESC LIMIT 5`
    ).all(projectId) as Array<{ title: string; content: string }>

    if (conventions.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('[Конвенции проекта]')
      for (const c of conventions) {
        lines.push(`- ${(c.title || c.content).slice(0, 120)}`)
      }
    }
  }

  // ── Recent conversations (task outcomes) ──
  if (projectId) {
    const conversations = db.prepare(
      `SELECT title, content FROM memory_items
       WHERE scope = 'project' AND project_id = ? AND kind = 'conversation'
       ORDER BY updated_at DESC LIMIT 3`
    ).all(projectId) as Array<{ title: string; content: string }>

    if (conversations.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('[Итоги диалогов]')
      for (const c of conversations) {
        lines.push(`- ${(c.title || c.content).slice(0, 120)}`)
      }
    }
  }

  // ── Agent outcomes (lessons) ──
  if (projectId) {
    const outcomes = db.prepare(
      `SELECT title, content FROM memory_items
       WHERE scope = 'project' AND project_id = ? AND kind = 'agent_outcome'
       ORDER BY importance DESC, updated_at DESC LIMIT 3`
    ).all(projectId) as Array<{ title: string; content: string }>

    if (outcomes.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('[Уроки]')
      for (const o of outcomes) {
        lines.push(`- ${(o.title || o.content).slice(0, 120)}`)
      }
    }
  }

  return lines.join('\n')
}
