/**
 * structuredMemory.ts — управление структурированной рабочей памятью агента.
 *
 * Формат хранения — markdown с чёткими секциями:
 *
 * ## Текущая задача
 * ## Изменённые файлы
 * ## Diff журнал
 * ## File Map
 * ## Архитектурные решения
 */

export interface DiffEntry {
  file: string
  summary: string  // краткое описание что изменилось
}

export interface FileMapEntry {
  reads: number
  writes: number
  note: string  // краткое описание файла
}

export interface StructuredMemoryUpdate {
  lastTask?: string
  checkpoint?: string
  modifiedFiles?: string[]
  diffEntries?: DiffEntry[]
  fileMap?: Map<string, FileMapEntry>
  architecturalNote?: string  // явно добавить архитектурное решение
}

const SECTION = {
  TASK: '## Текущая задача',
  CHECKPOINT: '## Последний результат',
  FILES: '## Изменённые файлы',
  DIFF: '## Diff журнал',
  MAP: '## File Map',
  ARCH: '## Архитектурные решения',
}

const MAX_DIFF_ENTRIES = 40
const MAX_FILE_MAP = 50
const MAX_ARCH_ENTRIES = 10
const MAX_MEMORY_CHARS = 6000  // было 3000 — больше места для деталей о файлах

// ─── Парсинг существующей памяти ──────────────────────────────────────────────

function parseSection(content: string, header: string): string {
  const lines = content.split('\n')
  const start = lines.findIndex(l => l.trim() === header)
  if (start === -1) return ''
  const headings = new Set<string>(Object.values(SECTION))
  const end = lines.findIndex((line, i) => i > start && headings.has(line.trim()))
  const slice = end === -1 ? lines.slice(start + 1) : lines.slice(start + 1, end)
  return slice.join('\n').trim()
}

function parseDiffEntries(section: string): DiffEntry[] {
  const entries: DiffEntry[] = []
  for (const line of section.split('\n')) {
    const m = line.match(/^- `([^`]+)`: (.+)$/)
    if (m) entries.push({ file: m[1], summary: m[2] })
  }
  return entries
}

function parseFileMap(section: string): Map<string, FileMapEntry> {
  const map = new Map<string, FileMapEntry>()
  for (const line of section.split('\n')) {
    const m = line.match(/^- `([^`]+)` \[r:(\d+) w:(\d+)\](?: — (.+))?$/)
    if (m) {
      map.set(m[1], { reads: Number(m[2]), writes: Number(m[3]), note: m[4] ?? '' })
    }
  }
  return map
}

// ─── Сборка секций ────────────────────────────────────────────────────────────

function renderDiffEntries(entries: DiffEntry[]): string {
  return entries.map(e => `- \`${e.file}\`: ${e.summary}`).join('\n')
}

function renderFileMap(map: Map<string, FileMapEntry>): string {
  return Array.from(map.entries())
    .map(([f, e]) => `- \`${f}\` [r:${e.reads} w:${e.writes}]${e.note ? ` — ${e.note}` : ''}`)
    .join('\n')
}

/** Bound generated notes at a visible word boundary. */
export function clipMemoryText(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  const prefix = trimmed.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')
  const boundary = prefix.search(/\s+\S*$/)
  return (boundary >= max * .8 ? prefix.slice(0, boundary) : prefix).trimEnd() + '…'
}

/** The internal file map tracks counts and cached snippets. Keep one list of paths in prompts. */
export function compactWorkingMemoryForPrompt(memory: string): string {
  const fileMap = parseSection(memory, SECTION.MAP)
  if (!fileMap) return memory
  const mapped = parseFileMap(fileMap)
  const rows = fileMap.split('\n').filter(line => line.trim())
  if (mapped.size !== rows.length) return memory // Custom or incomplete sections are kept verbatim.
  const edited = parseSection(memory, SECTION.FILES)
  const existingPaths = new Set(edited.split('\n').map(line => /^- `([^`]+)`$/.exec(line)?.[1]))
  const extraPaths = [...mapped.keys()].filter(path => !existingPaths.has(path))
  const replacement = extraPaths.length
    ? `## Другие просмотренные файлы\n${extraPaths.map(path => '- ' + path).join('\n')}`
    : ''
  return memory.replace(`${SECTION.MAP}\n${fileMap}`, () => replacement).trim()
}

// ─── Главная функция обновления ────────────────────────────────────────────────

export function updateStructuredMemory(existing: string, update: StructuredMemoryUpdate): string {
  console.log('[structuredMemory] updating — files:', update.modifiedFiles?.length ?? 0, 'diffs:', update.diffEntries?.length ?? 0)

  // Парсим существующие секции
  const existingDiff = parseDiffEntries(parseSection(existing, SECTION.DIFF))
  const existingMap = parseFileMap(parseSection(existing, SECTION.MAP))
  const existingArch = parseSection(existing, SECTION.ARCH)

  // ── Обновляем текущую задачу
  const task = update.lastTask
    ? clipMemoryText(update.lastTask, 1000).replace(/^## /gm, '### ')
    : parseSection(existing, SECTION.TASK)

  // ── Обновляем список изменённых файлов
  const existingFiles = parseSection(existing, SECTION.FILES)
    .split('\n').filter(l => l.startsWith('- `')).map(l => l.replace(/^- `|`.*$/g, ''))
  const allFiles = Array.from(new Set([...existingFiles, ...(update.modifiedFiles ?? [])]))
  const filesSection = allFiles.map(f => `- \`${f}\``).join('\n')

  // ── Обновляем diff журнал
  const newDiffs = update.diffEntries ?? []
  const mergedDiff = [...existingDiff, ...newDiffs].slice(-MAX_DIFF_ENTRIES)

  // ── Обновляем file map
  const mergedMap = new Map(existingMap)
  if (update.fileMap) {
    for (const [f, entry] of Array.from(update.fileMap.entries())) {
      const existing = mergedMap.get(f)
      if (existing) {
        mergedMap.set(f, {
          reads: existing.reads + entry.reads,
          writes: existing.writes + entry.writes,
          note: entry.note || existing.note,
        })
      } else {
        mergedMap.set(f, entry)
      }
    }
  }
  // Ограничиваем размер — оставляем самые активные файлы
  const sortedEntries = Array.from(mergedMap.entries())
    .sort((a, b) => (b[1].reads + b[1].writes * 2) - (a[1].reads + a[1].writes * 2))
    .slice(0, MAX_FILE_MAP)
  const sortedMap = new Map(sortedEntries)

  // ── Архитектурные решения — только append, не перезаписываем
  const archLines = existingArch.split('\n').filter(l => l.trim())
  if (update.architecturalNote) {
    const note = `- ${update.architecturalNote.slice(0, 150)}`
    if (!archLines.includes(note)) {
      archLines.push(note)
    }
  }
  const archSection = archLines.slice(-MAX_ARCH_ENTRIES).join('\n')

  // ── Собираем итоговую память
  const parts: string[] = []

  if (task) {
    parts.push(`${SECTION.TASK}\n${task}`)
  }
  const checkpoint = update.checkpoint ? clipMemoryText(update.checkpoint, 600).replace(/^## /gm, '### ') : parseSection(existing, SECTION.CHECKPOINT)
  if (checkpoint) parts.push(`${SECTION.CHECKPOINT}\n${checkpoint}`)
  if (allFiles.length > 0) {
    parts.push(`${SECTION.FILES}\n${filesSection}`)
  }
  if (mergedDiff.length > 0) {
    parts.push(`${SECTION.DIFF}\n${renderDiffEntries(mergedDiff)}`)
  }
  if (sortedMap.size > 0) {
    parts.push(`${SECTION.MAP}\n${renderFileMap(sortedMap)}`)
  }
  if (archSection) {
    parts.push(`${SECTION.ARCH}\n${archSection}`)
  }

  const result = parts.join('\n\n')

  // Фикс 8: если память превысила лимит — сжимаем diff журнал
  if (result.length > MAX_MEMORY_CHARS) {
    const trimmedDiff = mergedDiff.slice(-Math.floor(MAX_DIFF_ENTRIES / 3))
    const trimmedParts = parts.map(p =>
      p.startsWith(SECTION.DIFF) ? `${SECTION.DIFF}\n${renderDiffEntries(trimmedDiff)}` : p
    )
    const trimmed = trimmedParts.join('\n\n')
    console.log('[structuredMemory] trimmed:', result.length, '->', trimmed.length, 'chars')
    return clipMemoryText(trimmed, MAX_MEMORY_CHARS)
  }

  console.log('[structuredMemory] built:', result.length, 'chars,', result.split('\n').length, 'lines')
  return result
}

/**
 * Добавить архитектурное решение напрямую (без полного обновления)
 */
export function appendArchitecturalNote(existing: string, note: string): string {
  return updateStructuredMemory(existing, { architecturalNote: note })
}
