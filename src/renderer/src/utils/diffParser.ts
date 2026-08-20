// ── Unified diff parser → per-file { original, modified } ────────────────
// makeDiff (src/core/tools/_shared.ts) генерирует unified diff через
// Diff.createPatch (npm `diff` package) с 3 линиями контекста.
// Формат:
//   --- path
//   +++ path
//   @@ -oldStart,oldCount +newStart,newCount @@
//    context line
//   -removed line
//   +added line
//
// parsePatch из `diff` разбивает на hunks. Из hunks реконструируем
// original/modified: ' ' → оба, '-' → original, '+' → modified.
// Для нескольких hunks с gap'ами вставляем разделитель "// ...".

import { parsePatch } from 'diff'

export interface ParsedFileDiff {
  filePath: string
  original: string
  modified: string
  added: number
  deleted: number
}

/** Парсит unified diff строку (возможно несколько файлов) в массив per-file diff'ов.
 *  Если один и тот же файл редактировался несколько раз (несколько edit_file вызовов),
 *  diff'ы мерджатся в один — контент последнего патча перезаписывает предыдущий.
 *
 *  Также нормализует нестандартный формат writeFile (старые записи в БД):
 *  writeFile генерировал `+++ path\n+line1\n+line2` без `---` и `@@` hunk-хедеров.
 *  parsePatch такой формат не парсит. Добавляем `--- /dev/null` перед `+++`
 *  и оборачиваем линии в hunk @@ — тогда parsePatch справляется. */
export function parseUnifiedDiff(unifiedDiff: string): ParsedFileDiff[] {
  if (!unifiedDiff?.trim()) return []

  // ── Нормализация старого формата writeFile ──────────────────────────
  // Ищем блоки, начинающиеся с `+++ ` но без предшествующего `--- `:
  // `+++ path\n+line1\n+line2` → `--- /dev/null\n+++ path\n@@ -0,0 +1,N @@\n+line1\n+line2`
  const normalized = normalizeWriteFileDiff(unifiedDiff)

  const patches = parsePatch(normalized)
  const map = new Map<string, ParsedFileDiff>()

  for (const patch of patches) {
    const filePath = (patch.newFileName || patch.oldFileName || '')
      .replace(/^[ab]\//, '') // убираем a/ b/ префиксы (git convention)
      .trim()

    let original = ''
    let modified = ''
    let added = 0
    let deleted = 0

    for (let hi = 0; hi < patch.hunks.length; hi++) {
      const hunk = patch.hunks[hi]

      // Разделитель между непоследовательными hunks
      if (hi > 0) {
        original += '// ... \n'
        modified += '// ... \n'
      }

      for (const line of hunk.lines) {
        const content = line.length > 0 ? line.slice(1) : ''
        if (line.startsWith(' ')) {
          original += content + '\n'
          modified += content + '\n'
        } else if (line.startsWith('-')) {
          original += content + '\n'
          deleted++
        } else if (line.startsWith('+')) {
          modified += content + '\n'
          added++
        } else if (line.startsWith('\\')) {
          // "\\ No newline at end of file" — пропускаем
        }
      }
    }

    // Мердж: если файл уже есть — перезаписываем (последняя правка важнее),
    // счётчики суммируем
    const existing = map.get(filePath)
    if (existing) {
      existing.original = original
      existing.modified = modified
      existing.added += added
      existing.deleted += deleted
    } else {
      map.set(filePath, { filePath, original, modified, added, deleted })
    }
  }

  return Array.from(map.values())
}

/** Извлекает basename из пути (работает с / и \). */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Извлекает директорию из пути. */
export function dirname(p: string): string {
  return p.includes('\\') || p.includes('/')
    ? p.replace(/[\\/][^\\/]+$/, '')
    : ''
}

// ── Нормализация старого формата writeFile ───────────────────────────────
// Старый writeFile (до фикса) генерировал:
//   +++ path
//   +line1
//   +line2
// Без `---` заголовка и без `@@` hunk-хедера → parsePatch не может это распарсить.
// Превращаем в валидный unified diff:
//   --- /dev/null
//   +++ path
//   @@ -0,0 +1,N @@
//   +line1
//   +line2
//
// Также обрабатывает dryRun-формат writeFile:
//   +++ path
//   +line1
// (то же самое — нет --- и @@).
function normalizeWriteFileDiff(diff: string): string {
  // Разбиваем на блоки по `+++ ` строкам (каждый блок = один файл)
  // Если перед `+++ ` нет `--- ` — это старый writeFile формат
  const lines = diff.split('\n')
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Пропускаем пустые строки между блоками
    if (line === '' && i === 0) { i++; continue }

    if (line.startsWith('+++ ')) {
      // Проверяем: есть ли `--- ` перед этой строкой?
      const prevLine = result.length > 0 ? result[result.length - 1] : ''
      if (!prevLine.startsWith('--- ')) {
        // Старый формат: добавляем --- /dev/null
        result.push('--- /dev/null')
      }
      result.push(line) // +++ path

      // Собираем +строки и считаем их количество
      const addedLines: string[] = []
      i++
      while (i < lines.length && (lines[i].startsWith('+') || lines[i] === '')) {
        if (lines[i] === '' && i === lines.length - 1) break
        addedLines.push(lines[i])
        i++
      }
      // Вставляем hunk-хедер: @@ -0,0 +1,N @@
      result.push(`@@ -0,0 +1,${addedLines.length} @@`)
      result.push(...addedLines)
    } else if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('@@')) {
      // Стандартный формат — пропускаем как есть
      result.push(line)
      i++
    } else {
      result.push(line)
      i++
    }
  }

  return result.join('\n')
}
