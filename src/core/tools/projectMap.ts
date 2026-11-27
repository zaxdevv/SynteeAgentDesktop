/**
 * project_map — навигация по графу кода проекта для агента.
 *
 * Даёт «кто вызывает X / от чего зависит Y / как связано A и B / что заденет
 * правка» без чтения файлов целиком — экономия контекста. Источник: code_map_*
 * (tree-sitter + резолвинг). Рёбра помечены точностью
 * (resolved/heuristic/ambiguous) — агент видит, где карта уверена, а где предполагает.
 *
 * action=semantic — поиск по СМЫСЛУ (локальная E5-модель в sidecar + lexical
 * fallback): вопрос естественным языком → релевантные символы/файлы с их
 * связями из графа. Работает даже когда ни одно имя не совпадает с запросом.
 *
 * Ответы ограничены бюджетом токенов (параметр budget, default 900) — чтобы
 * один вызов карты не съедал контекст непредсказуемо.
 */
import type { ToolResult } from './_shared'
import * as store from '../projectMap/mapStore'
import { searchSemantic } from '../projectMap/mapSemantic'
import {
  godNodes, computeCommunities, findPath, affectedNodes, getSnapshot,
} from '../projectMap/mapAnalytics'
import { log } from '../logger'
import type { CodeMapNode, CodeMapEdge, CodeMapSemanticHit, CodeEdgeType } from '../../shared/projectMap'

export interface ProjectMapArgs {
  action: 'search' | 'semantic' | 'callers' | 'callees' | 'file' | 'overview'
    | 'god' | 'communities' | 'path' | 'explain' | 'affected'
  query?: string
  /** Второй узел для action=path. */
  to?: string
  path?: string
  nodeId?: string
  limit?: number
  /** Глубина обхода для path/affected. */
  depth?: number
  /** Ограничить типы рёбер (calls|references|imports). */
  relations?: CodeEdgeType[]
  /** Approximate response budget in tokens. */
  budget?: number
}

const DEFAULT_BUDGET_TOKENS = 900
const MAX_BUDGET_TOKENS = 4000
const ANALYTICS_ACTIONS = new Set<ProjectMapArgs['action']>(['overview', 'god', 'communities', 'path', 'explain', 'affected'])
const CHARS_PER_TOKEN = 3

function fmtNode(n: CodeMapNode): string {
  const loc = n.kind === 'file' || n.kind === 'package' ? '' : `:${n.lineStart}`
  const parent = n.parentName ? ` (${n.parentName})` : ''
  return `${n.name} [${n.kind}]${parent} — ${n.filePath}${loc}`
}

function fmtEdge(e: CodeMapEdge, other: CodeMapNode | null, dir: 'from' | 'to'): string {
  const mark = e.precision === 'resolved' ? '' : e.precision === 'ambiguous' ? ' ?' : e.precision === 'external' ? ' (ext)' : ' ~'
  const line = e.line ? `:${e.line}` : ''
  if (!other) return `${e.type}${mark} → ${dir === 'to' ? e.toNode : e.fromNode}${line}`
  return `${e.type}${mark} ${fmtNode(other)}${line}`
}

/** Краткие связи хита: до N имён callers/callees — «как оно вписано в проект». */
function fmtRelations(projectId: string, node: CodeMapNode, max = 3): string[] {
  const lines: string[] = []
  if (node.kind === 'file' || node.kind === 'package') return lines
  const callers = store.getCallers(projectId, node.id).slice(0, max)
  const callees = store.getCallees(projectId, node.id).slice(0, max)
  if (callers.length) {
    const names = callers
      .map(e => store.getNode(projectId, e.fromNode)?.name ?? e.fromNode)
      .join(', ')
    lines.push(`  called by (${callers.length}${callers.length >= max ? '+' : ''}): ${names}`)
  }
  if (callees.length) {
    const names = callees
      .map(e => store.getNode(projectId, e.toNode)?.name ?? e.toNode)
      .join(', ')
    lines.push(`  calls (${callees.length}${callees.length >= max ? '+' : ''}): ${names}`)
  }
  return lines
}

/** Совместный вывод хитов семантики: ранг, локация, канал совпадения, связи. */
function fmtSemanticHits(projectId: string, hits: CodeMapSemanticHit[]): string[] {
  const lines: string[] = []
  hits.forEach((h, i) => {
    const by = h.matchedBy === 'both' ? ' (name+meaning)' : h.matchedBy === 'semantic' ? ' (meaning)' : ' (name)'
    lines.push(`${i + 1}. ${fmtNode(h.node)}${by}`)
    if (i < 3) lines.push(...fmtRelations(projectId, h.node))
  })
  return lines
}

// ─── Разрешение одной цели: без молчаливого выбора однофамильца ──────────────
//
// Раньше цель бралась как findNodes(...)[0]: при двух одноимённых символах
// агент молча получал случайный узел и строил на нём callers/affected.
// Теперь порядок строгий: точный nodeId → точный путь файла → уникальное
// точное имя → уникальный partial. Неоднозначность возвращается списком
// кандидатов (path:line + nodeId), выбор остаётся за агентом.

type TargetResolution =
  | { status: 'ok'; node: CodeMapNode }
  | { status: 'none' }
  | { status: 'ambiguous'; input: string; candidates: CodeMapNode[] }

const AMBIGUOUS_CANDIDATES_SHOWN = 12
/** Сколько совпадений тянуть из БД, чтобы увидеть дубли имён за пределами limit. */
const TARGET_MATCH_FETCH = 60

const FILE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|cs|cpp|cc|cxx|c|h|hpp|rb|php|swift|scala|sh|bash|ps1|sql|md|mdx|json|jsonc|ya?ml|toml|css|scss|sass|less|html|vue|svelte|astro|dart|lua|ex|exs|erl|clj|hs|zig|nim|proto|graphql)$/i

/** Пути в графе относительные с '/', а ввод агента может быть с '\' или './'. */
function normalizePathInput(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  return p.replace(/\/{2,}/g, '/')
}

/** Похоже на путь (а не на имя символа) — тогда файл важнее одноимённых символов. */
function looksLikeFilePath(input: string): boolean {
  return input.includes('/') || FILE_EXT_RE.test(input)
}

/** Файловые узлы, чей путь совпадает с вводом точно или по basename/суффиксу. */
function matchFileNodes(projectId: string, rawPath: string): CodeMapNode[] {
  const p = normalizePathInput(rawPath)
  if (!p) return []
  const suffix = `/${p}`
  const out: CodeMapNode[] = []
  for (const f of store.listFiles(projectId)) {
    if (f.path !== p && !f.path.endsWith(suffix) && f.path.split('/').pop() !== p) continue
    const node = store.getNode(projectId, f.path)
    if (node) out.push(node)
  }
  return out
}

function ambiguousTarget(input: string, candidates: CodeMapNode[]): TargetResolution {
  return { status: 'ambiguous', input, candidates }
}

/** Кандидат для выбора агентом: name/kind — path:line и точный nodeId. */
function fmtCandidate(n: CodeMapNode): string {
  return `${fmtNode(n)}  [nodeId: ${n.id}]`
}

function fmtSearchResult(n: CodeMapNode): string {
  // Canonical ids already include the entire relative path. Keep it once.
  if (n.id === n.filePath && n.kind === 'file') return `[file] [nodeId: ${n.id}]`
  if (n.filePath && n.id.startsWith(`${n.filePath}#`)) {
    return `${n.name} [${n.kind}] line ${n.lineStart} [nodeId: ${n.id}]`
  }
  return fmtCandidate(n)
}

function ambiguousResult(label: string, resolution: { input: string; candidates: CodeMapNode[] }): ToolResult {
  const total = resolution.candidates.length
  const shown = resolution.candidates.slice(0, AMBIGUOUS_CANDIDATES_SHOWN)
  const lines = [
    `Ambiguous ${label} "${resolution.input}" — ${total} node${total === 1 ? '' : 's'} match, refusing to pick one silently:`,
    ...shown.map(n => '  ' + fmtCandidate(n)),
  ]
  if (total > shown.length) {
    lines.push(`  … and ${total - shown.length} more — narrow the query (file path, parent name or exact nodeId).`)
  }
  lines.push(label === 'path start' || label === 'path end'
    ? `Re-run with the exact ID above in "${label === 'path start' ? 'query' : 'to'}".`
    : 'Re-run with "nodeId" (exact id above), or use a file-qualified query like "path/to/file.ts#name".')
  return { success: false, output: '', error: lines.join('\n') }
}

/** Цель по строке: точный id → точный путь → "файл#имя" → уникальное имя → уникальный partial. */
function resolveTarget(projectId: string, rawInput: string): TargetResolution {
  const input = rawInput.trim()
  if (!input) return { status: 'none' }

  // 1. Точный nodeId (у файлового узла id === путь — покрывает и точный путь).
  const byId = store.getNode(projectId, input)
  if (byId) return { status: 'ok', node: byId }

  // 2. Тот же путь, но с '\' или './': нормализуем, не превращая путь в имя.
  const asPath = normalizePathInput(input)
  if (asPath !== input) {
    const byPath = store.getNode(projectId, asPath)
    if (byPath) return { status: 'ok', node: byPath }
  }
  if (looksLikeFilePath(asPath)) {
    const files = matchFileNodes(projectId, asPath)
    if (files.length === 1) return { status: 'ok', node: files[0] }
    if (files.length > 1) return ambiguousTarget(input, files)
  }

  // 3. Уточнение "path/to/file.ts#name" — файл снимает неоднозначность имени.
  const hashIdx = input.lastIndexOf('#')
  if (hashIdx > 0 && hashIdx < input.length - 1) {
    const scoped = resolveFileScoped(projectId, input.slice(0, hashIdx), input.slice(hashIdx + 1))
    if (scoped) return scoped
  }

  // findNodes ищет LIKE по имени, поэтому в выдачу попадают и файловые узлы
  // ("auth" → "auth.ts"): для действий над символами они — второй сорт.
  const matches = store.findNodes(projectId, input, TARGET_MATCH_FETCH)
  const symbols = matches.filter(m => m.kind !== 'file')
  const fileHits = matches.filter(m => m.kind === 'file')

  // 4. Уникальное точное имя важнее любых частичных совпадений.
  const exactNames = symbols.filter(m => m.name === input)
  if (exactNames.length === 1) return { status: 'ok', node: exactNames[0] }
  if (exactNames.length > 1) return ambiguousTarget(input, exactNames)

  // 4b. Регистр не совпал, но точное имя единственное.
  const lower = input.toLowerCase()
  const ciExact = symbols.filter(m => m.name.toLowerCase() === lower)
  if (ciExact.length === 1) return { status: 'ok', node: ciExact[0] }
  if (ciExact.length > 1) return ambiguousTarget(input, ciExact)

  // 5. Частичное совпадение годится только если оно единственное.
  if (symbols.length === 1) return { status: 'ok', node: symbols[0] }
  if (symbols.length > 1) return ambiguousTarget(input, symbols)

  // 6. Символов нет — файл по имени (запрос вида "auth" без расширения).
  if (fileHits.length === 1) return { status: 'ok', node: fileHits[0] }
  if (fileHits.length > 1) return ambiguousTarget(input, fileHits)

  return { status: 'none' }
}

/** "path/to/file.ts#name" → узел с таким именем внутри этого файла. */
function resolveFileScoped(projectId: string, rawPath: string, rawName: string): TargetResolution | null {
  const name = rawName.trim()
  if (!name) return null
  const files = matchFileNodes(projectId, rawPath)
  if (files.length === 0) return null
  const filePaths = new Set(files.map(f => f.filePath))
  const inFiles = store.findNodes(projectId, name, TARGET_MATCH_FETCH)
    .filter(n => n.kind !== 'file' && filePaths.has(n.filePath))
  if (inFiles.length === 0) return null
  const exact = inFiles.filter(n => n.name === name)
  const pool = exact.length ? exact : inFiles
  if (pool.length === 1) return { status: 'ok', node: pool[0] }
  return ambiguousTarget(`${rawPath}#${name}`, pool)
}

/**
 * Цель из args. nodeId — строго exact: устаревший id не должен «попасть»
 * в однофамильца (иначе ошибка агенту, а не другой символ).
 */
function resolveArgsTarget(projectId: string, args: ProjectMapArgs): TargetResolution {
  if (args.nodeId) {
    const node = store.getNode(projectId, args.nodeId)
    return node ? { status: 'ok', node } : { status: 'none' }
  }
  if (args.query) return resolveTarget(projectId, args.query)
  return { status: 'none' }
}

function targetError(input: string, viaNodeId: boolean): ToolResult {
  return viaNodeId
    ? { success: false, output: '', error: `No map node with id "${input}" (stale id? re-run action=search to get fresh nodeIds).` }
    : { success: false, output: '', error: `No map node matches "${input}".` }
}

/** Единая цель для callers/callees/explain: узел либо готовый ответ с причиной. */
function pickSingleTarget(projectId: string, args: ProjectMapArgs): { node: CodeMapNode } | { result: ToolResult } {
  if (!args.nodeId && !args.query) {
    return { result: { success: false, output: '', error: 'Provide "nodeId" or "query" to identify the symbol.' } }
  }
  const resolution = resolveArgsTarget(projectId, args)
  if (resolution.status === 'ok') return { node: resolution.node }
  if (resolution.status === 'ambiguous') return { result: ambiguousResult('target', resolution) }
  return { result: targetError((args.nodeId ?? args.query)!, Boolean(args.nodeId)) }
}

/** Файловая цель для affected: точный путь → уникальный basename/суффикс. */
function resolveFileTarget(projectId: string, rawPath: string): TargetResolution {
  const p = normalizePathInput(rawPath)
  const exact = store.getNode(projectId, p)
  if (exact?.kind === 'file') return { status: 'ok', node: exact }
  const files = matchFileNodes(projectId, p)
  if (files.length === 1) return { status: 'ok', node: files[0] }
  if (files.length > 1) return ambiguousTarget(rawPath, files)
  return { status: 'none' }
}

/** Keep complete rows, including exact paths/ids, and reserve room for the truncation notice. */
export function trimToBudget(lines: string[], budgetTokens: number): string {
  const budget = Number.isFinite(budgetTokens) ? Math.max(80, Math.min(MAX_BUDGET_TOKENS, budgetTokens)) : DEFAULT_BUDGET_TOKENS
  const limitChars = Math.floor(budget * CHARS_PER_TOKEN)
  let used = 0
  let kept = 0
  while (kept < lines.length && used + lines[kept].length + (kept > 0 ? 1 : 0) <= limitChars) {
    used += lines[kept].length + (kept > 0 ? 1 : 0)
    kept++
  }
  if (kept === lines.length) return lines.join('\n')
  const notice = (count: number) => `… trimmed ${count} line${count === 1 ? '' : 's'} by budget (narrow the query or raise "budget")`
  while (kept && used + 1 + notice(lines.length - kept).length > limitChars) {
    kept--
    used -= lines[kept].length + (kept > 0 ? 1 : 0)
  }
  return [...lines.slice(0, kept), notice(lines.length - kept)].join('\n')
}

export async function projectMapQuery(args: ProjectMapArgs, projectId?: string): Promise<ToolResult> {
  if (!projectId) {
    return { success: false, output: '', error: 'No active project for project_map. Open a project first.' }
  }
  const status = store.getStatus(projectId)
  if (status.state === 'idle' && status.totalNodes === 0) {
    return { success: false, output: '', error: 'Project map is not built yet. It builds in the background — try again shortly, or use search_code/read_file meanwhile.' }
  }
  // partial — карта рабочая, но инвентарь файлов неполон: предупреждаем честно,
  // иначе агент примет «нет в графе» за «нет в проекте».
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(Math.floor(args.limit!), 100)) : 12
  const budget = args.budget ?? DEFAULT_BUDGET_TOKENS
  const started = Date.now()

  try {
    const result = await runAction(args, projectId, limit, status)
    const notices: string[] = []
    if (result.success && ANALYTICS_ACTIONS.has(args.action)) {
      const snap = getSnapshot(projectId)
      const capped = [
        snap.coverage.nodesTruncated ? `${snap.nodes.size.toLocaleString('en-US')} nodes` : '',
        snap.coverage.edgesTruncated ? `${snap.edges.toLocaleString('en-US')} edges` : '',
      ].filter(Boolean)
      if (capped.length) notices.push(`NOTE: analytics snapshot truncated (cap: ${capped.join(', ')}). Missing paths or dependencies are not proof of absence. Verify with search_code/read_file.`)
    }
    if (result.success && status.state === 'partial') notices.push('NOTE: file inventory is incomplete; some files may be missing.')
    if (result.success) result.output = trimToBudget([...notices, ...result.output.split('\n')], budget)
    else if (result.error) result.error = trimToBudget(result.error.split('\n'), budget)
    log('[project_map] action=%s project=%s → %d chars in %dms',
      args.action, projectId.slice(0, 8), result.output.length, Date.now() - started)
    return result
  } catch (e) {
    log('[project_map] action=%s FAILED in %dms: %s',
      args.action, Date.now() - started, e instanceof Error ? e.message : String(e))
    return { success: false, output: '', error: trimToBudget((e instanceof Error ? e.message : String(e)).split('\n'), budget) }
  }
}

async function runAction(
  args: ProjectMapArgs,
  projectId: string,
  limit: number,
  status: import('../../shared/projectMap').CodeMapStatus,
): Promise<ToolResult> {
  switch (args.action) {
      case 'overview': {
        const { edges } = store.getGraph(projectId, { edgeTypes: ['imports'], limit: 20000 })
        const degree = new Map<string, number>()
        for (const e of edges) {
          degree.set(e.toNode, (degree.get(e.toNode) ?? 0) + 1)
        }
        const hubs = [...degree.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([id, deg]) => {
            const n = store.getNode(projectId, id)
            if (!n) return null
            // package-узлы живут вне файлов: показываем имя пакета, не пустой path.
            const label = n.kind === 'package' ? `${n.name} (external package)` : n.filePath
            return `  ${label} — imported by ${deg}`
          })
          .filter(Boolean)
        // Ядро архитектуры — сразу в обзоре: чаще всего именно оно нужно вместо чтения файлов.
        const gods = godNodes(projectId, 5)
        const godLines = gods.length
          ? ['Architecture hubs (god nodes):', ...gods.map(g => `  ${g.node.name} [${g.node.kind}] — ${g.node.filePath}:${g.node.lineStart} (fan-in ${g.fanIn}, fan-out ${g.fanOut})`)]
          : []
        const out = [
          `Project map: ${status.state}, ${status.totalNodes} nodes, ${status.totalEdges} edges, ${status.indexedFiles} indexed files.`,
          hubs.length ? `Most imported:\n${hubs.join('\n')}` : '',
          godLines.join('\n'),
        ].filter(Boolean).join('\n')
        return { success: true, output: out }
      }

      case 'god': {
        const gods = godNodes(projectId, limit)
        if (gods.length === 0) return { success: true, output: 'No call/import edges in the map yet.' }
        const lines = [`Architecture hubs — top ${gods.length} by degree (fan-in + fan-out):`]
        gods.forEach((g, i) => {
          lines.push(`${i + 1}. ${fmtNode(g.node)} — degree ${g.degree} (in ${g.fanIn} / out ${g.fanOut})`)
        })
        return { success: true, output: lines.join('\n') }
      }

      case 'communities': {
        const { communities } = computeCommunities(projectId)
        if (communities.length === 0) return { success: true, output: 'No edges to cluster — map has calls/imports yet to resolve.' }
        // Одиночные узлы (переменные/поля без calls/imports) — не подсистемы:
        // без этого фильтра список начинается с «N clusters», где N ≈ число узлов.
        const linked = communities.filter(c => c.size >= 2)
        const isolated = communities.reduce((sum, c) => sum + (c.size === 1 ? 1 : 0), 0)
        if (linked.length === 0) {
          return { success: true, output: `No subsystems yet — ${isolated} symbols have no call/import edges.` }
        }
        const shown = linked.slice(0, limit)
        const lines = [
          `Subsystems (Louvain): ${linked.length} cluster${linked.length === 1 ? '' : 's'} with 2+ linked symbols` +
            (isolated > 0 ? ` | ${isolated} isolated symbols (no calls/imports)` : ''),
          `Showing ${shown.length} largest.`,
        ]
        for (const c of shown) {
          const dir = c.topDir ? ` — ${c.topDir}` : ''
          lines.push(`\n[${c.id}] ${c.label} (${c.size} nodes)${dir}`)
          for (const n of c.topNodes) lines.push(`   ${n.name} — ${n.filePath} (in ${n.fanIn})`)
        }
        return { success: true, output: lines.join('\n') }
      }

      case 'path': {
        if (!args.query || !args.to) {
          return { success: false, output: '', error: 'path requires "query" (from) and "to" — names, ids or file paths.', }
        }
        const from = resolveTarget(projectId, args.query)
        if (from.status === 'ambiguous') return ambiguousResult('path start', from)
        if (from.status === 'none') return { success: false, output: '', error: `No map node matches "${args.query}".` }
        const to = resolveTarget(projectId, args.to)
        if (to.status === 'ambiguous') return ambiguousResult('path end', to)
        if (to.status === 'none') return { success: false, output: '', error: `No map node matches "${args.to}".` }
        const res = findPath(projectId, from.node.id, to.node.id, { maxDepth: args.depth, relations: args.relations })
        if (!res.found) {
          return { success: true, output: `No path found from ${from.node.name} to ${to.node.name} within depth ${args.depth ?? 6} (calls/references/imports).` }
        }
        const lines = [
          `Path ${from.node.name} → ${to.node.name}: ${res.hops.length - 1} hop(s), confidence ${(res.confidence * 100).toFixed(0)}%${res.weakest ? ` (weakest edge: ${res.weakest})` : ''}`,
        ]
        res.hops.forEach((hop, i) => {
          if (i === 0) { lines.push(`  1. ${fmtNode(hop.node!)}`); return }
          lines.push(`  ${i + 1}. --${hop.type}${hop.precision === 'resolved' ? '' : hop.precision === 'ambiguous' ? ' ?' : ' ~'}--> ${fmtNode(hop.node!)}`)
        })
        return { success: true, output: lines.join('\n') }
      }

      case 'explain': {
        const picked = pickSingleTarget(projectId, args)
        if ('result' in picked) return picked.result
        const node = picked.node
        const { communities, assignment } = computeCommunities(projectId)
        const cid = assignment.get(node.id)
        const community = cid != null ? communities.find(c => c.id === cid) : undefined
        const callers = store.getCallers(projectId, node.id)
        const callees = store.getCallees(projectId, node.id)
        const lines = [`${fmtNode(node)}`]
        if (node.signature) lines.push(`  signature: ${node.signature}`)
        if (node.doc) lines.push(`  doc: ${node.doc.slice(0, 400).replace(/\s+/g, ' ')}`)
        lines.push(`  exported: ${node.exported ? 'yes' : 'no'}`)
        if (community) lines.push(`  subsystem: [${community.id}] ${community.label} (${community.size} nodes)`)
        if (callers.length) {
          lines.push(`\nCalled by (${callers.length}):`)
          for (const e of callers.slice(0, limit)) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.fromNode), 'from'))
        }
        if (callees.length) {
          lines.push(`\nCalls (${callees.length}):`)
          for (const e of callees.slice(0, limit)) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.toNode), 'to'))
        }
        const fileImports = store.getFileEdges(projectId, node.filePath, 'out').slice(0, 10)
        const fileDependents = store.getFileEdges(projectId, node.filePath, 'in').slice(0, 10)
        if (fileImports.length) {
          lines.push(`\nFile ${node.filePath} imports:`)
          for (const e of fileImports) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.toNode), 'to'))
        }
        if (fileDependents.length) {
          lines.push(`Imported by:`)
          for (const e of fileDependents) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.fromNode), 'from'))
        }
        return { success: true, output: lines.join('\n') }
      }

      case 'affected': {
        let target: CodeMapNode
        if (args.nodeId) {
          const byId = store.getNode(projectId, args.nodeId)
          if (!byId) {
            return { success: false, output: '', error: `No map node with id "${args.nodeId}" (stale id? re-run action=search to get fresh nodeIds).` }
          }
          target = byId
        } else if (args.path) {
          const file = resolveFileTarget(projectId, args.path)
          if (file.status === 'ambiguous') return ambiguousResult('file path', file)
          if (file.status === 'none') return { success: false, output: '', error: `No file in the map matches "${args.path}".` }
          target = file.node
        } else if (args.query) {
          const resolved = resolveTarget(projectId, args.query)
          if (resolved.status === 'ambiguous') return ambiguousResult('target', resolved)
          if (resolved.status === 'none') return { success: false, output: '', error: `No map node matches "${args.query}".` }
          target = resolved.node
        } else {
          return { success: false, output: '', error: 'affected requires "nodeId", "path" or "query".' }
        }
        const res = affectedNodes(projectId, target.id, { depth: args.depth ?? 3, relations: args.relations, limit: limit * 8 })
        if (res.results.length === 0) {
          return { success: true, output: `No dependents found for ${target.name} within the requested depth and relations.` }
        }
        const lines = [
          `Impact of changing ${fmtNode(target)}: ${res.results.length} dependent node(s) within depth ${args.depth ?? 3}`,
          'Files affected:',
          ...res.byFile.slice(0, limit).map(f => `  ${f.filePath} — ${f.count} node(s)`),
          '\nDependents:',
          ...res.results.slice(0, limit).map(r => `  ${'  '.repeat(Math.min(r.depth - 1, 3))}${fmtNode(r.node)} — via ${r.via} (depth ${r.depth})`),
        ]
        return { success: true, output: lines.join('\n') }
      }

      case 'search': {
        if (!args.query) return { success: false, output: '', error: 'search requires "query" (symbol name).' }
        // Тянем больше строк, чем покажем: иначе дубли имён за пределами limit
        // выглядят как «единственное совпадение» и выбираются молча.
        const fetchLimit = Math.max(limit, TARGET_MATCH_FETCH)
        const fetched = store.findNodes(projectId, args.query, fetchLimit)
        if (fetched.length === 0) return { success: true, output: `No symbols matching "${args.query}".` }
        const shown = fetched.slice(0, limit)
        // nodeId в каждой строке — иначе одноимённые символы не различить
        // в callers/callees/explain/affected (у них на входе exact nodeId).
        const lines = shown.map(fmtSearchResult)
        const exact = fetched.filter(n => n.name === args.query)
        const truncated = fetched.length >= fetchLimit
        const single = !truncated && exact.length === 1
          ? exact[0]
          : !truncated && exact.length === 0 && fetched.length === 1
            ? fetched[0]
            : null
        if (single) {
          // Связи показываем, только когда цель однозначна: у однофамильцев
          // это были бы связи случайного узла.
          const callers = store.getCallers(projectId, single.id).slice(0, 8)
          const callees = store.getCallees(projectId, single.id).slice(0, 8)
          if (callers.length) {
            lines.push(`\nCallers of ${single.name}:`)
            for (const e of callers) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.fromNode), 'from'))
          }
          if (callees.length) {
            lines.push(`\nCalls from ${single.name}:`)
            for (const e of callees) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.toNode), 'to'))
          }
        } else if (exact.length > 1) {
          lines.push(`\n${exact.length}${truncated ? '+' : ''} symbols named "${args.query}" — pass "nodeId" to pick one for callers/callees/explain/affected.`)
        } else {
          lines.push(`\n${truncated ? `${shown.length}+` : fetched.length} match(es) — pass "nodeId" to inspect one.`)
        }
        // Единственное точное имя не значит «единственное совпадение»: partial-хиты
        // перечислены выше, но агент должен понимать, чьи это связи.
        if (single && fetched.length > shown.length) {
          lines.push(`… ${fetched.length - shown.length} more match(es) not shown (raise "limit").`)
        } else if (single && fetched.length > 1) {
          lines.push(`(relations above are for the exact match ${single.id}; ${fetched.length - 1} partial match(es) listed above.)`)
        }
        return { success: true, output: lines.join('\n') }
      }

      case 'semantic': {
        if (!args.query) return { success: false, output: '', error: 'semantic requires "query" — a natural-language description of WHAT to find, e.g. "password validation logic" or "сжатие истории". For exact symbol names prefer action=search.' }
        const res = await searchSemantic(projectId, args.query, limit)
        const head = `Semantic search "${args.query}" — mode: ${res.mode}, ${res.indexedDocs}/${res.totalDocs} docs indexed:`
        if (res.hits.length === 0) {
          const note = res.mode === 'none'
            ? ' (project map has no indexed documents yet)'
            : res.mode === 'lexical'
              ? ' (semantic model warming up — lexical fallback used; try again soon for meaning-based ranking)'
              : ''
          return { success: true, output: `${head}\n  (no matches)${note}` }
        }
        const lines = [head, ...fmtSemanticHits(projectId, res.hits)]
        if (res.mode === 'lexical') {
          lines.push('(mode lexical: semantic model is not ready — ranking is word-based, not meaning-based)')
        }
        return { success: true, output: lines.join('\n') }
      }

      case 'callers':
      case 'callees': {
        const picked = pickSingleTarget(projectId, args)
        if ('result' in picked) return picked.result
        const node = picked.node
        const edges = args.action === 'callers'
          ? store.getCallers(projectId, node.id)
          : store.getCallees(projectId, node.id)
        const shown = edges.slice(0, limit)
        const header = `${args.action === 'callers' ? 'Callers of' : 'Calls from'} ${fmtNode(node)} (${edges.length} total):`
        if (shown.length === 0) return { success: true, output: header + '\n  (none)' }
        const lines = shown.map(e => '  ' + fmtEdge(e, store.getNode(projectId, args.action === 'callers' ? e.fromNode : e.toNode), args.action === 'callers' ? 'from' : 'to'))
        return { success: true, output: [header, ...lines].join('\n') }
      }

      case 'file': {
        if (!args.path) return { success: false, output: '', error: 'file requires "path" (relative file path).' }
        const graph = store.getFileGraph(projectId, args.path)
        if (graph.nodes.length === 0) return { success: true, output: `No map data for "${args.path}".` }
        const symbols = graph.nodes.filter(n => n.kind !== 'file' && n.kind !== 'package')
        const deps = store.getFileEdges(projectId, args.path, 'out')
        const dependents = store.getFileEdges(projectId, args.path, 'in')
        const lines = [`File: ${args.path} (${symbols.length} symbols)`]
        if (symbols.length) {
          lines.push('Symbols:')
          for (const n of symbols.slice(0, limit)) lines.push(`  ${n.name} [${n.kind}]${n.parentName ? ` (${n.parentName})` : ''} line ${n.lineStart}`)
        }
        if (deps.length) {
          lines.push('Imports:')
          for (const e of deps.slice(0, limit)) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.toNode), 'to'))
        }
        if (dependents.length) {
          lines.push('Imported by:')
          for (const e of dependents.slice(0, limit)) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.fromNode), 'from'))
        }
        return { success: true, output: lines.join('\n') }
      }

      default:
        return {
          success: false, output: '',
          error: `Unknown action "${args.action}". Use search|semantic|callers|callees|file|overview|god|communities|path|explain|affected.`,
        }
  }
}
