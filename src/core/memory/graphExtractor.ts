/**
 * graphExtractor — извлечение сущностей и связей для knowledge graph.
 *
 * Два подхода:
 *
 * 1. HEURISTIC (быстро, без LLM):
 *    - extractFromDecisionHeuristic: regex для file paths, symbol refs из content
 *    - syncFromFastContext: files/symbols/imports/calls из fast_context_index
 *
 * 2. LLM (умно, дорого):
 *    - extractFromConversationLLM: концепции, отношения из chat_summary
 *    - Вызывается после compaction (отдельный LLM-вызов, не в compaction prompt)
 *
 * Возвращает GraphExtraction — массив узлов и рёбер для graphBuilder.upsertMany.
 */

import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import { extractJsonFromLlmResponse } from '../context/fastContext/annotator'
import { getFastContextEntries, type FastContextEntry } from '../db/fastContextStore'
import { getDB } from '../db/handle'
import type { FileSymbols } from '../context/fastContext/symbols'
import {
  upsertNode,
  upsertEdge,
  type NodeType,
  type EdgeType,
  type NodeSourceKind,
} from './graphStore'

// ─── Типы ────────────────────────────────────────────────────────────────────

export interface ExtractedNode {
  type: NodeType
  label: string
  sourceKind?: NodeSourceKind
  sourceId?: string
  metadata?: Record<string, unknown>
}

export interface ExtractedEdge {
  fromType: NodeType
  fromLabel: string
  toType: NodeType
  toLabel: string
  type: EdgeType
  metadata?: Record<string, unknown>
}

export interface GraphExtraction {
  nodes: ExtractedNode[]
  edges: ExtractedEdge[]
}

// ─── HEURISTIC: file path & symbol extraction ────────────────────────────────

/**
 * Regex для поиска путей к файлам в тексте.
 * Ловит: src/foo.ts, ./bar.js, ../baz/index.tsx, MemoryStore.ts, schemas.ts
 * Не ловит: обычные слова без расширения.
 */
const FILE_PATH_REGEX = /(?:\.\/|\.\.\/|\/)?(?:[\w-]+(?:\/[\w-]+)*\.[a-z]{1,5})\b/gi

/**
 * Regex для поиска упоминаний имён функций/классов (CamelCase или snake_case).
 * Минимум 4 символа, чтобы не ловить предлоги/местоимения.
 */
const SYMBOL_REGEX = /\b(?:[A-Z][a-zA-Z]{3,}|[a-z][a-zA-Z_]{4,})\b/g

/**
 * Извлечь сущности из decision (memory_item kind=project_decision) heuristically.
 * - Создаёт decision узел
 * - Ищет file paths в content → file узлы + AFFECTS edges
 * - Ищет symbol mentions → symbol узлы + MENTIONS edges (если symbol есть в fast_context)
 *
 * Синхронно: пишет в graphStore через upsertNode/upsertEdge.
 */
export function extractFromDecisionHeuristic(params: {
  projectId: string
  decisionLabel: string
  content: string
  memoryItemId: string
}): { nodes: number; edges: number } {
  const { projectId, decisionLabel, content, memoryItemId } = params
  let nodes = 0
  let edges = 0
  const db = getDB()

  // 1. Decision node
  const decisionLabelShort = decisionLabel.length > 100 ? decisionLabel.slice(0, 97) + '…' : decisionLabel
  const decisionId = upsertNode({
    projectId,
    type: 'decision',
    label: decisionLabelShort,
    sourceKind: 'memory_item',
    sourceId: memoryItemId,
    metadata: { content },
  })
  nodes++

  // 2. File paths в content → file nodes + AFFECTS edges
  const filePaths = new Set<string>()
  const matches = content.match(FILE_PATH_REGEX) ?? []
  for (const m of matches) {
    // Normalize: убираем ведущие ./ и ../
    const normalized = m.replace(/^(?:\.\/|\.\.\/|\/)+/, '')
    if (normalized.length > 3 && normalized.length < 200) {
      filePaths.add(normalized)
    }
  }

  // Также проверяем что эти файлы реально есть в fast_context_index проекта
  // (чтобы не создавать мусорные узлы для несуществующих файлов)
  const existingFiles = new Set<string>()
  try {
    const fcEntries = getFastContextEntries(projectId)
    for (const e of fcEntries) {
      existingFiles.add(e.filePath)
      // Также добавляем basename для matching
      const basename = e.filePath.split(/[/\\]/).pop()
      if (basename) existingFiles.add(basename)
    }
  } catch { /* skip if fast_context не доступен */ }

  for (const filePath of filePaths) {
    // Проверяем: либо полный путь есть в индексе, либо basename
    const basename = filePath.split(/[/\\]/).pop() ?? filePath
    const known = existingFiles.has(filePath) || existingFiles.has(basename)
    if (!known) continue // пропускаем незнакомые файлы

    upsertEdge({
      projectId,
      fromType: 'decision',
      fromLabel: decisionLabelShort,
      toType: 'file',
      toLabel: basename, // используем basename как label для краткости
      type: 'affects',
      toSourceKind: 'fast_context',
      toSourceId: basename,
      metadata: { evidence: 'mentioned_in_decision' },
    })
    edges++
  }

  // 3. Symbol mentions → symbol nodes + MENTIONS edges
  // Сначала собираем все symbol names из fast_context
  const symbolNames = new Set<string>()
  try {
    const fcEntries = getFastContextEntries(projectId)
    for (const e of fcEntries) {
      if (!e.symbolsJson) continue
      try {
        const symbols = JSON.parse(e.symbolsJson) as FileSymbols
        for (const def of symbols.definitions) {
          if (def.name && def.name.length >= 4) {
            symbolNames.add(def.name)
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  if (symbolNames.size > 0) {
    const symbolMatches = content.match(SYMBOL_REGEX) ?? []
    const uniqueMatches = new Set(symbolMatches)
    for (const sym of uniqueMatches) {
      if (symbolNames.has(sym)) {
        upsertEdge({
          projectId,
          fromType: 'decision',
          fromLabel: decisionLabelShort,
          toType: 'symbol',
          toLabel: sym,
          type: 'mentions',
          toSourceKind: 'fast_context',
          metadata: { evidence: 'mentioned_in_decision' },
        })
        edges++
      }
    }
  }

  // 4. Concept extraction (relaxed — no fast_context needed)
  const conceptResult = extractConceptsHeuristic(projectId, decisionLabelShort, content)
  nodes += conceptResult.nodes
  edges += conceptResult.edges

  // 5. Cross-link: find other decisions that mention the same concepts
  for (const concept of conceptResult.concepts) {
    // Find existing concept node
    const conceptNode = db.prepare(
      `SELECT id FROM memory_graph_nodes WHERE project_id = ? AND type = 'concept' AND label = ?`
    ).get(projectId, concept) as { id: string } | undefined

    if (conceptNode) {
      // Find other decisions linked to this concept
      const linkedDecisions = db.prepare(
        `SELECT DISTINCT n.id, n.label FROM memory_graph_nodes n
         JOIN memory_graph_edges e ON (e.from_node = n.id AND e.to_node = ?)
                                   OR (e.to_node = n.id AND e.from_node = ?)
         WHERE n.project_id = ? AND n.type = 'decision' AND n.id != ?
         LIMIT 3`
      ).all(conceptNode.id, conceptNode.id, projectId, decisionId) as Array<{ id: string; label: string }>

      for (const ld of linkedDecisions) {
        upsertEdge({
          projectId,
          fromType: 'decision',
          fromLabel: decisionLabelShort,
          toType: 'decision',
          toLabel: ld.label,
          type: 'depends_on',
          metadata: { evidence: 'shared_concept', concept },
        })
        edges++
      }
    }
  }

  return { nodes, edges }
}

// ─── HEURISTIC: concept extraction (relaxed, no fast_context needed) ──────────

/**
 * Known technology/concept terms for heuristic extraction.
 * If any of these appear in text, a concept node is created.
 */
const TECH_TERMS = new Set([
  'TypeScript', 'JavaScript', 'React', 'Vue', 'Angular', 'Electron', 'Node',
  'Postgres', 'MySQL', 'SQLite', 'MongoDB', 'Redis',
  'JWT', 'OAuth', 'SAML', 'WebSocket', 'REST', 'GraphQL', 'gRPC',
  'Docker', 'Kubernetes', 'Nginx', 'Apache',
  'Webpack', 'Vite', 'Rollup', 'Babel', 'ESLint', 'Prettier',
  'Jest', 'Vitest', 'Cypress', 'Playwright',
  'Zustand', 'Redux', 'MobX', 'Pinia',
  'TF-IDF', 'FTS5', 'BM25', 'embedding', 'cosine',
  'OpenAI', 'Anthropic', 'LLM', 'GPT', 'Claude',
  'WAL', 'FTS', 'CRUD', 'ORM', 'DAO',
  'CSS', 'HTML', 'SCSS', 'Tailwind',
  'Python', 'Rust', 'Go', 'Java', 'Kotlin', 'Swift',
])

/**
 * Extract concepts from text heuristically.
 * - Finds known tech terms (case-sensitive match from TECH_TERMS)
 * - Finds CamelCase words > 5 chars (potential concepts)
 * Creates concept nodes + mentions edges from the source decision.
 * Does NOT require fast_context — relaxed matching.
 */
function extractConceptsHeuristic(
  projectId: string,
  decisionLabel: string,
  content: string,
): { nodes: number; edges: number; concepts: string[] } {
  const nodes = 0
  let edges = 0
  const concepts = new Set<string>()

  // 1. Known tech terms (case-sensitive)
  for (const term of TECH_TERMS) {
    if (content.includes(term)) {
      concepts.add(term)
    }
  }

  // 2. CamelCase words > 5 chars (potential concept names)
  const camelMatches = content.match(/\b[A-Z][a-zA-Z]{4,}\b/g) ?? []
  for (const m of camelMatches) {
    // Skip common English words that aren't concepts
    if (m.length > 5 && !['The', 'This', 'That', 'These', 'Those', 'Which', 'There', 'Their', 'Where', 'When', 'What', 'Would', 'Could', 'Should', 'Always', 'Never'].includes(m)) {
      concepts.add(m)
    }
  }

  // Limit to avoid noise
  const conceptList = [...concepts].slice(0, 10)

  for (const concept of conceptList) {
    upsertEdge({
      projectId,
      fromType: 'decision',
      fromLabel: decisionLabel,
      toType: 'concept',
      toLabel: concept,
      type: 'mentions',
      toSourceKind: 'llm_extract',
      metadata: { evidence: 'heuristic_concept_match' },
    })
    edges++
  }

  return { nodes, edges, concepts: conceptList }
}

/**
 * Синхронизировать узлы/рёбра из fast_context_index в graph.
 * - files → file nodes
 * - symbols → symbol nodes + DEFINED_IN edges (file → symbol)
 * - imports → IMPORTS edges (file → file)
 * - references → CALLS edges (symbol → symbol) — best-effort резолвинг по name
 *
 * Используется при full rebuild и при incremental reindex.
 * Удаляет устаревшие file/symbol узлы (source_kind='fast_context'), которых
 * больше нет в fast_context_index.
 *
 * @param entries — опциональный подмножество записей для обработки (incremental).
 *   Если не передан — берутся ВСЕ записи проекта из fast_context_index.
 */
/** Build basename → filePath map для резолвинга imports.
 *  Строится ОДИН раз на весь проект, передаётся в syncSingleEntry.
 *  Раньше перестраивалось внутри syncSingleEntry для каждого entry → O(N²). */
export function buildBasenameToPath(allEntries: FastContextEntry[]): Map<string, string> {
  const basenameToPath = new Map<string, string>()
  for (const e of allEntries) {
    const base = e.filePath.split(/[/\\]/).pop() ?? e.filePath
    const baseNoExt = base.replace(/\.[^.]+$/, '')
    if (!basenameToPath.has(base)) basenameToPath.set(base, e.filePath)
    if (!basenameToPath.has(baseNoExt)) basenameToPath.set(baseNoExt, e.filePath)
  }
  return basenameToPath
}

export function syncFromFastContext(
  projectId: string,
  entries?: FastContextEntry[],
): { nodes: number; edges: number } {
  const allEntries = entries ?? getFastContextEntries(projectId)

  let nodes = 0
  let edges = 0

  const basenameToPath = buildBasenameToPath(allEntries)
  for (const entry of allEntries) {
    const result = syncSingleEntry(projectId, entry, allEntries, basenameToPath)
    nodes += result.nodes
    edges += result.edges
  }

  // Удаляем устаревшие file/symbol узлы (source_kind='fast_context'), которых
  // больше нет в currentFilePaths. Рёбра удалятся каскадно.
  // NOTE: это делает graphBuilder, не тут — чтобы избежать рекурсии.

  return { nodes, edges }
}

/**
 * Синхронизировать ОДНУ запись fast_context в graph (для incremental-обновлений).
 * - file → file node
 * - symbols → symbol nodes + DEFINED_IN edges (file → symbol)
 * - imports → IMPORTS edges (file → file, best-effort по basename)
 * - references → CALLS edges (file → symbol, best-effort по name)
 *
 * @param allEntries — полный список записей проекта. Нужен для резолвинга
 *   imports/references в полном контексте (при incremental-синке changed файлов).
 * @param basenameToPath — пред-построенный Map basename→filePath (O(1) lookup).
 *   Если не передан — строится на месте (медленно, O(N) на каждый entry).
 */
export function syncSingleEntry(
  projectId: string,
  entry: FastContextEntry,
  allEntries: FastContextEntry[],
  basenameToPath?: Map<string, string>,
): { nodes: number; edges: number } {
  let nodes = 0
  let edges = 0

  const basename = entry.filePath.split(/[/\\]/).pop() ?? entry.filePath

  // Build basename → filePath map для резолвинга imports (если не передан).
  const bmap = basenameToPath ?? buildBasenameToPath(allEntries)

  // File node
  upsertNode({
    projectId,
    type: 'file',
    label: basename,
    sourceKind: 'fast_context',
    sourceId: entry.filePath,
    metadata: {
      path: entry.filePath,
      lang: entry.lang,
      rankedScore: entry.rankedScore,
    },
    weightBoost: Math.max(0.5, entry.rankedScore / 10),
  })
  nodes++

  // Symbols
  if (entry.symbolsJson) {
    try {
      const symbols = JSON.parse(entry.symbolsJson) as FileSymbols
      for (const def of symbols.definitions) {
        if (!def.name || def.name.length < 2) continue
        upsertNode({
          projectId,
          type: 'symbol',
          label: def.name,
          sourceKind: 'fast_context',
          sourceId: `${entry.filePath}:${def.lineStart}`,
          metadata: {
            file: entry.filePath,
            kind: def.kind,
            lineStart: def.lineStart,
            lineEnd: def.lineEnd,
            parentName: def.parentName,
          },
        })
        nodes++

        // Edge: file DEFINED_IN symbol (точнее: symbol DEFINED_IN file)
        upsertEdge({
          projectId,
          fromType: 'symbol',
          fromLabel: def.name,
          toType: 'file',
          toLabel: basename,
          type: 'implemented_in',
          fromSourceKind: 'fast_context',
          toSourceKind: 'fast_context',
          fromSourceId: `${entry.filePath}:${def.lineStart}`,
          toSourceId: entry.filePath,
        })
        edges++
      }

      // Imports → IMPORTS edges (file → file, proper resolution)
      for (const imp of symbols.imports ?? []) {
        // Извлекаем путь из import строки: from '...', require('...')
        const pathMatch = imp.match(/['"]([^'"]+)['"]/)
        if (!pathMatch) continue
        const importPath = pathMatch[1]

        // Резолвинг: пробуем несколько стратегий
        // 1. Извлекаем basename из import path
        const rawBase = importPath.split('/').pop() ?? importPath
        // Убираем leading @ ~ . /
        const cleanBase = rawBase.replace(/^[@~.]/, '').replace(/^\//, '')
        // 2. Пробуем с расширением и без
        const candidates = [cleanBase, cleanBase.replace(/\.[^.]+$/, '')]
        let resolvedPath: string | null = null
        for (const c of candidates) {
          const found = bmap.get(c)
          if (found && found !== entry.filePath) {
            resolvedPath = found
            break
          }
        }
        // 3. Fallback: старый метод — filename with extension в import string
        if (!resolvedPath) {
          const importMatch = imp.match(/([\w-]+\.[a-z]{1,5})\b/i)
          if (importMatch) {
            const importedBasename = importMatch[1]
            if (importedBasename !== basename) {
              const found = bmap.get(importedBasename)
              if (found && found !== entry.filePath) resolvedPath = found
            }
          }
        }

        if (resolvedPath) {
          const targetBase = resolvedPath.split(/[/\\]/).pop() ?? resolvedPath
          upsertEdge({
            projectId,
            fromType: 'file',
            fromLabel: basename,
            toType: 'file',
            toLabel: targetBase,
            type: 'imports',
            fromSourceKind: 'fast_context',
            fromSourceId: entry.filePath,
            toSourceKind: 'fast_context',
            toSourceId: resolvedPath,
            metadata: { raw_import: imp },
          })
          edges++
        }
      }

      // References → CALLS edges (file → symbol, best-effort по name)
      for (const ref of symbols.references ?? []) {
        if (ref.length < 4) continue
        // Проверяем, есть ли такой symbol в индексе (best-effort)
        // Не создаём узел — upsertEdge создаст если нужно
        upsertEdge({
          projectId,
          fromType: 'file',
          fromLabel: basename,
          toType: 'symbol',
          toLabel: ref,
          type: 'calls',
          fromSourceKind: 'fast_context',
          fromSourceId: entry.filePath,
          metadata: { reference: ref },
        })
        edges++
      }
    } catch { /* skip corrupted symbolsJson */ }
  }

  return { nodes, edges }
}

// ─── LLM: extract concepts & relations from conversation ─────────────────────

const GRAPH_EXTRACT_SYSTEM_PROMPT = `You are an entity and relationship extractor for a project knowledge graph.

Extract from the dialogue summary:
- concept: abstract entities, technologies, approaches ("authorization", "Postgres", "TF-IDF", "early return")
- decision: architectural decisions ("decided to use X", "convention — Y")
- task: specific tasks ("add migration", "fix auth bug")
- file: mentioned files (if there are full paths or basenames with extensions)
- symbol: mentioned functions/classes (CamelCase, not trivial words)

And relationships between them:
- affects: decision → file (decision affects file)
- mentions: decision/concept → symbol (mentions symbol)
- implemented_in: concept/symbol → file (where it is implemented)
- depends_on: decision → decision/concept (depends on)
- supersedes: decision → decision (new replaces old)
- references: conversation → decision/concept/file (dialogue references)

Answer — JSON only, no markdown:
{"nodes":[{"type":"concept|decision|task|file|symbol","label":"short name","evidence":"quote from text"}],"edges":[{"from":"label_from","fromType":"concept","to":"label_to","toType":"file","type":"affects"}]}

Rules:
- label — short name (no more than 80 characters), unique within the type
- If there are no entities — return {"nodes":[],"edges":[]}
- Do not invent relationships — only if there is evidence in the text
- Maximum 15 nodes and 20 edges per dialogue`

/**
 * LLM-извлечение концепций и связей из резюме диалога.
 * Вызывается после compaction (отдельный LLM-вызов).
 */
export async function extractFromConversationLLM(
  store: Store,
  params: {
    projectId: string
    chatId: string
    summary: string
  },
): Promise<{ extraction: GraphExtraction; error?: string }> {
  if (params.summary.trim().length < 50) {
    return { extraction: { nodes: [], edges: [] } }
  }

  const aiClient = new AIClient(store)
  const prompt = `Extract entities and relationships for the knowledge graph from the dialogue summary:

${params.summary.slice(0, 4000)}

Return JSON with nodes and edges.`

  let raw = ''
  try {
    await aiClient.streamChat(
      [{ role: 'user', content: prompt }],
      {
        onToken: (t) => { raw += t },
        onDone: () => {},
        onError: () => {},
      },
      'fastContext',
      GRAPH_EXTRACT_SYSTEM_PROMPT,
      undefined,
      0.1,
    )
  } catch (e) {
    return { extraction: { nodes: [], edges: [] }, error: (e as Error).message }
  }

  const parsed = extractJsonFromLlmResponse(raw) as { nodes?: unknown[]; edges?: unknown[]; files?: unknown[]; summary?: string; facts?: unknown[] } | null
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    return { extraction: { nodes: [], edges: [] }, error: 'invalid JSON response' }
  }

  const extraction: GraphExtraction = { nodes: [], edges: [] }
  const validNodeTypes: NodeType[] = ['decision', 'concept', 'file', 'symbol', 'conversation', 'task']
  const validEdgeTypes: EdgeType[] = [
    'affects', 'mentions', 'implemented_in', 'depends_on', 'supersedes',
    'references', 'imports', 'calls', 'implements',
  ]

  for (const n of parsed.nodes) {
    if (typeof n !== 'object' || n === null) continue
    const obj = n as Record<string, unknown>
    const type = typeof obj.type === 'string' ? obj.type as NodeType : null
    const label = typeof obj.label === 'string' ? obj.label.trim() : ''
    if (!type || !label || !validNodeTypes.includes(type)) continue
    const evidence = typeof obj.evidence === 'string' ? obj.evidence : undefined
    extraction.nodes.push({
      type,
      label: label.slice(0, 80),
      sourceKind: 'llm_extract',
      sourceId: params.chatId,
      metadata: evidence ? { evidence } : undefined,
    })
  }

  for (const e of parsed.edges) {
    if (typeof e !== 'object' || e === null) continue
    const obj = e as Record<string, unknown>
    const fromType = typeof obj.fromType === 'string' ? obj.fromType as NodeType : null
    const fromLabel = typeof obj.from === 'string' ? obj.from.trim() : ''
    const toType = typeof obj.toType === 'string' ? obj.toType as NodeType : null
    const toLabel = typeof obj.to === 'string' ? obj.to.trim() : ''
    const type = typeof obj.type === 'string' ? obj.type as EdgeType : null
    if (!fromType || !fromLabel || !toType || !toLabel || !type) continue
    if (!validNodeTypes.includes(fromType) || !validNodeTypes.includes(toType)) continue
    if (!validEdgeTypes.includes(type)) continue
    extraction.edges.push({
      fromType,
      fromLabel: fromLabel.slice(0, 80),
      toType,
      toLabel: toLabel.slice(0, 80),
      type,
    })
  }

  return { extraction }
}

// ─── Сохранение extraction в graphStore ──────────────────────────────────────

/**
 * Сохранить GraphExtraction в graphStore через upsertNode/upsertEdge.
 * Создаёт conversation node (для отслеживания источника) и связывает с extraction nodes.
 */
export function saveExtractionToGraph(
  projectId: string,
  extraction: GraphExtraction,
  options?: { conversationLabel?: string; chatId?: string },
): { nodes: number; edges: number } {
  let nodeCount = 0
  let edgeCount = 0

  // Conversation node (опционально) — связываем с извлечёнными сущностями через REFERENCES
  let convLabel: string | null = null
  if (options?.conversationLabel && options?.chatId) {
    convLabel = options.conversationLabel.slice(0, 80)
    upsertNode({
      projectId,
      type: 'conversation',
      label: convLabel,
      sourceKind: 'chat_summary',
      sourceId: options.chatId,
    })
    nodeCount++
  }

  // Nodes
  for (const n of extraction.nodes) {
    upsertNode({
      projectId,
      type: n.type,
      label: n.label,
      sourceKind: n.sourceKind ?? 'llm_extract',
      sourceId: n.sourceId,
      metadata: n.metadata,
    })
    nodeCount++

    // Link conversation → node
    if (convLabel) {
      upsertEdge({
        projectId,
        fromType: 'conversation',
        fromLabel: convLabel,
        toType: n.type,
        toLabel: n.label,
        type: 'references',
      })
      edgeCount++
    }
  }

  // Edges
  for (const e of extraction.edges) {
    upsertEdge({
      projectId,
      fromType: e.fromType,
      fromLabel: e.fromLabel,
      toType: e.toType,
      toLabel: e.toLabel,
      type: e.type,
      metadata: e.metadata,
    })
    edgeCount++
  }

  return { nodes: nodeCount, edges: edgeCount }
}
