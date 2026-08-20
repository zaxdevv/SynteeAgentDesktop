import { readFile } from 'fs/promises'
import { sep } from 'path'
import { cosineSimilarity, bufferToEmbedding, type Embedding } from '../embeddings'
import { localGetEntries, type FastContextEntry, stem, splitNameParts, fuzzyMatch } from './state'
import type { SymbolDef } from './symbols'
import { getParsedSymbols } from './symbolsCache'
import { buildInvertedIndex, lookupFiles } from './invertedIndex'

// ─── Retrieval: build repo-map slice ────────────────────────────────────────

/**
 * Выбирает top-N файлов по запросу и строит compact repo-map slice.
 * Алгоритм:
 *   1. Lexical match: токены запроса vs symbol names + filename + path
 *   2. Boost от rankedScore (PageRank importance)
 *   3. Top-N по combo score → в slice
 *
 * Возвращает строку ~maxTokens токенов для подачи в LLM.
 */
export function buildRepoMapSlice(
  projectId: string,
  query: string,
  maxFiles = 25,
  maxTokens = 4000,
  queryEmbedding?: Embedding | null,
): { slice: string; topFiles: Array<{ path: string; score: number; definitions: SymbolDef[] }> } {
  const entries = localGetEntries(projectId)
  if (entries.length === 0) return { slice: '', topFiles: [] }

  // Токены запроса (lowercase, без стоп-слов) + stemming
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or', 'not', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'how', 'what', 'where', 'why', 'when', 'who', 'which', 'do', 'does', 'did', 'find', 'show', 'get', 'give', 'me', 'please', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these', 'those', 'my', 'your', 'его', 'её', 'их', 'где', 'что', 'как', 'какой', 'какая', 'найти', 'покажи', 'дай', 'сделай', 'сделать', 'для', 'из', 'на', 'в', 'не', 'и', 'или', 'но'])
  const queryTokens = query.toLowerCase()
    .split(/[^a-zа-я0-9_]+/i)
    .filter(t => t.length >= 2 && !stopWords.has(t))
  // Stemmed tokens для matching (user/users, auth/authentication, config/configuration)
  const queryStems = queryTokens.map(t => stem(t))
  const querySet = new Set(queryTokens)

  // ── Pre-filter: инвертированный индекс token → Set<filePath> ──────────
  // Вместо linear scan 5K+ entries по filename (O(N×tokens) string.includes),
  // делаем O(queryTokens) lookups в Map. Получаем Set<filePath> кандидатов.
  // Дополняем хабами (rankedScore > 0.5) — их важно сохранить даже без token match.
  // Если индекс пуст или кандидатов слишком мало — fallback на полный список.
  const invIndex = buildInvertedIndex(projectId)
  const matchedPaths = lookupFiles(invIndex, queryTokens, queryStems)
  const candidateEntries: FastContextEntry[] = []
  if (matchedPaths) {
    // Быстрый path: фильтруем entries по matchedPaths Set (O(1) per entry)
    for (const e of entries) {
      if (matchedPaths.has(e.filePath) || e.rankedScore > 0.5) {
        candidateEntries.push(e)
      }
    }
  } else {
    // Fallback: хабы + filename match (старый путь — для случая когда index пуст)
    for (const e of entries) {
      const baseName = e.filePath.split(sep).pop()!.toLowerCase()
      const pathLower = e.filePath.toLowerCase()
      let quickMatch = false
      for (const t of queryTokens) {
        if (baseName.includes(t) || pathLower.includes(t)) { quickMatch = true; break }
      }
      if (quickMatch || e.rankedScore > 0.5) {
        candidateEntries.push(e)
      }
    }
  }
  // Если кандидатов слишком мало — fallback на полный список
  const entriesToScore = candidateEntries.length >= 10 ? candidateEntries : entries

  // Скоринг каждого файла (парсим symbolsJson через symbolsCache — кэш по mtime)
  const scored: Array<{ entry: FastContextEntry; definitions: SymbolDef[]; imports: string[]; lexical: number; combo: number }> = []
  for (const e of entriesToScore) {
    let definitions: SymbolDef[] = []
    let imports: string[] = []
    const parsed = getParsedSymbols(e.filePath, e.symbolsJson, e.mtime)
    definitions = parsed.d
    imports = parsed.i

    const relPath = e.filePath
    const pathLower = relPath.toLowerCase()
    const baseName = relPath.split(sep).pop()!.toLowerCase()

    let lexical = 0
    // Match в имени файла (весомее)
    for (let ti = 0; ti < queryTokens.length; ti++) {
      const t = queryTokens[ti]
      const ts = queryStems[ti]
      if (baseName.includes(t) || (ts !== t && baseName.includes(ts))) lexical += 3
      else if (pathLower.includes(t) || (ts !== t && pathLower.includes(ts))) lexical += 1
    }
    // Match в import строках (+2 за совпадение)
    const importsLower = imports.map(imp => imp.toLowerCase())
    for (let ti = 0; ti < queryTokens.length; ti++) {
      const t = queryTokens[ti]
      const ts = queryStems[ti]
      for (const imp of importsLower) {
        if (imp.includes(t) || (ts !== t && imp.includes(ts))) { lexical += 2; break }
      }
    }
    // Bigram query tokens: "user auth" → ["user auth"] — для phrase matching.
    // Если 2+ consecutive query tokens встречаются в одном symbol name в том же
    // порядке — это сильный сигнал (phrase match точнее individual token matches).
    const queryBigrams = new Set<string>()
    for (let ti = 0; ti < queryTokens.length - 1; ti++) {
      queryBigrams.add(queryTokens[ti] + ' ' + queryTokens[ti + 1])
    }
    // Match в именах символов — умный: exact > component > substring > stem > fuzzy
    for (const d of definitions) {
      const nameLower = d.name.toLowerCase()
      const parts = splitNameParts(d.name)
      const nameStem = stem(nameLower)
      const partStems = parts.map(p => stem(p))
      let matchedTokens = 0
      for (let ti = 0; ti < queryTokens.length; ti++) {
        const t = queryTokens[ti]
        const ts = queryStems[ti]
        if (nameLower === t) { lexical += 5; matchedTokens++; continue }
        if (parts.includes(t)) { lexical += 3; matchedTokens++; continue }
        if (nameLower.includes(t)) { lexical += 2; matchedTokens++; continue }
        // Stem match: users → user, authentication → auth
        if (ts !== t && (nameStem === ts || partStems.includes(ts))) { lexical += 3; matchedTokens++; continue }
        // camelCase component fuzzy (опечатки в компонентах имени)
        if (parts.some(p => p.length >= 4 && fuzzyMatch(t, p))) { lexical += 1; matchedTokens++; continue }
        // Full name fuzzy (опечатки в полном имени)
        if (fuzzyMatch(t, nameLower)) { lexical += 1; matchedTokens++; continue }
      }
      // Multi-word phrase bonus: ≥2 токенов запроса совпали в одном символе
      if (matchedTokens >= 2) lexical += 2
      // Bigram phrase bonus: consecutive query tokens встречаются в parts в том же порядке
      if (queryBigrams.size > 0 && parts.length >= 2) {
        const partsJoined = parts.join(' ')
        for (const bg of queryBigrams) {
          if (partsJoined.includes(bg)) { lexical += 4; break }
        }
      }
    }
    // Soft match: query tokens anywhere in all symbol names
    if (lexical === 0 && definitions.length > 0) {
      const allNames = definitions.map(d => d.name).join(' ').toLowerCase()
      let softHits = 0
      for (const t of querySet) {
        if (allNames.includes(t)) softHits++
      }
      lexical = softHits * 0.5
    }

    // Combo: normalized lexical + rankedScore + relevance + semantic
    // Lexical нормализуем через sigmoid: lexical / (lexical + 10) → [0, 1)
    // Иначе файл с 30 символов набирает 60+ баллов и доминирует
    let semanticScore = 0
    if (queryEmbedding && e.embedding) {
      try {
        const fileEmb = bufferToEmbedding(e.embedding)
        semanticScore = cosineSimilarity(queryEmbedding, fileEmb)
      } catch { /* skip */ }
    }
    const lexicalNorm = lexical / (lexical + 10)
    const relevanceCapped = Math.min(e.relevanceBoost || 0, 5)
    const combo = lexicalNorm * 10 + e.rankedScore * 1.0 + relevanceCapped * 1.5 + semanticScore * 2.0
    if (combo <= 0) continue
    scored.push({ entry: e, definitions, imports, lexical, combo })
  }

  scored.sort((a, b) => b.combo - a.combo)
  const top = scored.slice(0, maxFiles)

  // ── Предвычисляем графы зависимостей для top файлов ──
  // importedBy: кто импортирует этот файл (dependency graph)
  // calledBy: кто вызывает символы из этого файла (call graph)
  const topPaths = new Set(top.map(s => s.entry.filePath))

  // basename → filePath для резолвинга imports
  const basenameToPath = new Map<string, string>()
  for (const e of entries) {
    const base = e.filePath.split(sep).pop()!.replace(/\.[^.]+$/, '')
    if (!basenameToPath.has(base)) basenameToPath.set(base, e.filePath)
  }

  // name → filePath для резолвинга references (call graph)
  const nameToPath = new Map<string, string>()
  for (const e of entries) {
    const parsed = getParsedSymbols(e.filePath, e.symbolsJson, e.mtime)
    const defs = parsed.d
    for (const d of defs) {
      if (!nameToPath.has(d.name.toLowerCase())) nameToPath.set(d.name.toLowerCase(), e.filePath)
    }
  }

  // Строим importedBy и calledBy для top файлов
  const importedBy = new Map<string, string[]>()
  const calledBy = new Map<string, string[]>()
  for (const s of top) { importedBy.set(s.entry.filePath, []); calledBy.set(s.entry.filePath, []) }

  for (const e of entries) {
    const parsed = getParsedSymbols(e.filePath, e.symbolsJson, e.mtime)
    const imps = parsed.i
    const refs = parsed.r

    // importedBy: если e импортирует файл из top
    for (const imp of imps) {
      const match = imp.match(/['"]([^'"]+)['"]/)
      if (!match) continue
      const base = match[1].split('/').pop()!.replace(/\.[^.]+$/, '')
      const target = basenameToPath.get(base)
      if (target && topPaths.has(target) && target !== e.filePath) {
        importedBy.get(target)!.push(e.filePath)
      }
    }

    // calledBy: если e ссылается на символ из top файла
    for (const ref of refs) {
      const target = nameToPath.get(ref.toLowerCase())
      if (target && topPaths.has(target) && target !== e.filePath) {
        calledBy.get(target)!.push(e.filePath)
      }
    }
  }

  // ── Детект архитектурных хабов ──
  const ENTRY_PATTERNS = /^(index|main|app|server|cli|entry|bootstrap)\.[a-z]+$/i
  const isEntryPoint = (path: string) => ENTRY_PATTERNS.test(path.split(sep).pop() || '')

  // ── Строим slice (compact outline): file → signatures + graph ──
  const lines: string[] = []
  let tokens = 0
  const topFiles: Array<{ path: string; score: number; definitions: SymbolDef[] }> = []

  for (const s of top) {
    const relPath = s.entry.filePath
    topFiles.push({ path: relPath, score: s.combo, definitions: s.definitions })

    // Заголовок файла + маркер хаба
    const hub = isEntryPoint(relPath) ? ' [entry]' : s.entry.rankedScore > 0.7 ? ' [hub]' : ''
    const header = `${relPath}:${hub}`
    lines.push(header)
    tokens += Math.ceil(header.length / 4)

    // Сигнатуры — с иерархией: methods под своим class (indent)
    const priority: Array<{ d: SymbolDef; w: number }> = s.definitions.map(d => ({
      d,
      w: d.kind === 'class' ? 5 : d.kind === 'interface' ? 4 : d.kind === 'function' ? 3 : d.kind === 'method' ? 2 : 1,
    }))
    priority.sort((a, b) => b.w - a.w)

    // Группируем: сначала контейнеры (class/interface), потом их методы, потом остальные
    const containerFirst = priority.filter(p => p.d.parentName === undefined && (p.d.kind === 'class' || p.d.kind === 'interface' || p.d.kind === 'struct' || p.d.kind === 'impl'))
    const standalone = priority.filter(p => p.d.parentName === undefined && !(p.d.kind === 'class' || p.d.kind === 'interface' || p.d.kind === 'struct' || p.d.kind === 'impl'))
    const methods = priority.filter(p => p.d.parentName !== undefined)

    const parentNameToMethods = new Map<string, SymbolDef[]>()
    for (const m of methods) {
      const arr = parentNameToMethods.get(m.d.parentName!) ?? []
      arr.push(m.d)
      parentNameToMethods.set(m.d.parentName!, arr)
    }

    let shownCount = 0
    const emitSymbol = (d: SymbolDef, indent: number) => {
      if (shownCount >= 12) return
      const pad = ' '.repeat(indent)
      const line = `${pad}L${d.lineStart} ${d.kind} ${d.signature}`
      lines.push(line)
      tokens += Math.ceil(line.length / 4)
      shownCount++
    }

    // Контейнеры с их методами (иерархия)
    for (const { d } of containerFirst) {
      if (shownCount >= 12) break
      emitSymbol(d, 2)
      const childMethods = parentNameToMethods.get(d.name) ?? []
      for (const m of childMethods) {
        if (shownCount >= 12) break
        emitSymbol(m, 4)
      }
    }
    // Standalone functions/variables
    for (const { d } of standalone) {
      if (shownCount >= 12) break
      emitSymbol(d, 2)
    }
    if (tokens > maxTokens) break

    // Imports — зависимости файла
    if (s.imports.length > 0) {
      const impLine = `  imports: ${s.imports.slice(0, 5).join(', ')}`
      lines.push(impLine)
      tokens += Math.ceil(impLine.length / 4)
    }

    // Imported by — кто зависит от этого файла
    const ib = importedBy.get(relPath) ?? []
    if (ib.length > 0) {
      const shortIb = ib.slice(0, 3).map(p => p.split(sep).pop()).join(', ')
      const ibLine = `  imported by: ${shortIb}${ib.length > 3 ? ` +${ib.length - 3}` : ''}`
      lines.push(ibLine)
      tokens += Math.ceil(ibLine.length / 4)
    }

    // Called by — кто вызывает символы из этого файла
    const cb = calledBy.get(relPath) ?? []
    if (cb.length > 0) {
      const shortCb = cb.slice(0, 3).map(p => p.split(sep).pop()).join(', ')
      const cbLine = `  called by: ${shortCb}${cb.length > 3 ? ` +${cb.length - 3}` : ''}`
      lines.push(cbLine)
      tokens += Math.ceil(cbLine.length / 4)
    }

    lines.push('')
    if (tokens > maxTokens) break
  }

  return { slice: lines.join('\n'), topFiles }
}

// ─── Content snippets (читаем куски кода top файлов для LLM) ─────────────────

/**
 * Multi-symbol snippets: для top-N файлов берёт до 3 query-relevant символов,
 * 30 строк вокруг каждого. Даёт LLM реальный код для более точного выбора.
 * Символы сортируются по query-relevance (lexical match), не по порядку в файле.
 */
export async function buildContentSnippets(
  topFiles: Array<{ path: string; definitions: SymbolDef[]; score?: number }>,
  maxFiles = 5,
  maxSymbolsPerFile = 3,
  linesPerSnippet = 30,
  queryTokens: string[] = [],
): Promise<string> {
  const snippets: string[] = []
  const filesToRead = topFiles.slice(0, maxFiles)
  const queryStemsLocal = queryTokens.map(t => stem(t))

  const results = await Promise.allSettled(
    filesToRead.map(async f => {
      let source: string
      try { source = await readFile(f.path, 'utf-8') } catch { return null }
      if (!source || source.length > 500_000) return null

      const lines = source.split('\n')
      // Sort definitions by query-relevance: exact > component > substring > stem
      const scoredDefs = f.definitions
        .filter(d => d.lineStart > 0 && d.lineStart <= lines.length)
        .map(d => {
          const nameLower = d.name.toLowerCase()
          const parts = splitNameParts(d.name)
          const nameStem = stem(nameLower)
          let ds = 0
          for (let ti = 0; ti < queryTokens.length; ti++) {
            const t = queryTokens[ti]
            const ts = queryStemsLocal[ti]
            if (nameLower === t) ds += 5
            else if (parts.includes(t)) ds += 3
            else if (nameLower.includes(t)) ds += 2
            else if (ts !== t && (nameStem === ts || parts.some(p => stem(p) === ts))) ds += 3
          }
          return { def: d, ds }
        })
        .sort((a, b) => b.ds - a.ds)
        .slice(0, maxSymbolsPerFile)

      if (scoredDefs.length === 0) return null

      const parts: string[] = []
      const usedRanges: Array<[number, number]> = []
      for (const { def } of scoredDefs) {
        const center = def.lineStart - 1
        const half = Math.floor(linesPerSnippet / 2)
        const start = Math.max(0, center - half)
        const end = Math.min(lines.length, center + half)
        // Dedup overlapping ranges
        if (usedRanges.some(([s, e]) => start < e && end > s)) continue
        usedRanges.push([start, end])
        const snippet = lines.slice(start, end)
          .map((line, i) => `${start + i + 1}: ${line}`)
          .join('\n')
        parts.push(`  L${def.lineStart} ${def.kind} ${def.name}:\n${snippet}`)
      }

      return parts.length > 0 ? `--- ${f.path} ---\n${parts.join('\n\n')}` : null
    }),
  )

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) snippets.push(r.value)
  }

  return snippets.length > 0 ? '\n\n--- Content snippets ---\n\n' + snippets.join('\n\n') : ''
}
