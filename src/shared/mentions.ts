/**
 * @mention-система — поиск и парсинг @упоминаний в тексте инпута.
 *
 * Триггер: символ @ в любом месте текста (не только в начале, как слеш-команды).
 * Дропдаун показывается когда каретка стоит сразу после @токена без пробелов.
 *
 * Источники (MentionItemType):
 *   - file   — файлы проекта из workdir (индексируется chokidar-watcher'ом)
 *   - image  — картинки с диска (png/jpg/gif/webp/bmp/svg)
 *   - skill  — скиллы из skillManager (.md с YAML frontmatter)
 *   - command — кастомные slash-команды (.md из .syntee/commands/)
 *   - chat   — чаты из БД (ссылка на другой чат: summary + последние сообщения
 *              инлайнятся в контекст; клик по чипу → переход в чат)
 *   - project — проекты из БД (имя+workdir+контекст инлайнятся; клик →
 *              переход в последний чат проекта)
 *
 * filterMentions возвращает плоский список, отсортированный по релевантности:
 *   1. Точные совпадения по basename (starts-with)
 *   2. Fuzzy-совпадения по пути (subsequence + boundaries)
 *   3. Недавние (useCount > 0) — буст в каждой категории
 *
 * Лимиты: 50 результатов (виртуализация в UI при необходимости).
 */
import type { MentionItem, Attachment, MentionItemType } from './types'

// ── Парсинг @токена у каретки ────────────────────────────────────────────────

/**
 * Находит @токен у позиции каретки в тексте.
 *
 * Возвращает { start, end, query } или null если каретка не в @токене.
 *  - start: индекс символа @
 *  - end: индекс каретки
 *  - query: текст между @ и кареткой (без @)
 *
 * Правила:
 *  - @ должен быть в начале текста ИЛИ сразу после пробела/переноса.
 *    Иначе «foo@bar» не триггерит (email-подобные последовательности).
 *  - Между @ и кареткой не должно быть пробелов (иначе это не mention-query).
 *  - query может быть пустым (= пользователь только что нажал @).
 */
export function findMentionTokenAtCaret(
  text: string,
  caretPos: number,
): { start: number; end: number; query: string } | null {
  if (caretPos <= 0) return null
  // Идём назад от каретки, ищем @. Останавливаемся на пробеле/переносе.
  let i = caretPos - 1
  while (i >= 0) {
    const ch = text[i]
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') return null
    if (ch === '@') {
      // @ должен быть в начале текста или после пробела/переноса.
      // Иначе «foo@bar» триггерит mention — это плохо (email, теги).
      if (i > 0) {
        const prev = text[i - 1]
        if (prev !== ' ' && prev !== '\n' && prev !== '\t' && prev !== '\r') return null
      }
      const query = text.slice(i + 1, caretPos)
      return { start: i, end: caretPos, query }
    }
    i--
  }
  return null
}

// ── Fuzzy-матчинг ────────────────────────────────────────────────────────────

/**
 * Subsequence-fuzzy: проверяет, что все символы query идут в target в том же
 * порядке (не обязательно подряд). Возвращает score (0 = нет матча) или null.
 *
 * Буст за:
 *  - последовательные символы (consecutive)
 *  - совпадение на границе слова (после / _ - . или в начале)
 *  - exact startsWith (query — префикс target)
 *
 * Алгоритм упрощённый (без полного fuzzy-matcher-а), но достаточный для
 * типичных имён файлов/скиллов. Главное — быстрый и предсказуемый.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 1 // пустой query — нейтральный матч (покажем всё)
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  // Exact startsWith — максимальный score
  if (t.startsWith(q)) {
    return 1000 + (q.length / Math.max(t.length, 1)) * 100
  }

  // Subsequence match
  let qi = 0
  let score = 0
  let consecutive = 0
  let lastMatchIdx = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Буст за consecutive
      if (ti === lastMatchIdx + 1) {
        consecutive++
        score += 10 + consecutive * 5
      } else {
        consecutive = 0
        // Буст за границу слова
        const prev = ti > 0 ? t[ti - 1] : ''
        if (ti === 0 || prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
          score += 8
        } else {
          score += 2
        }
      }
      lastMatchIdx = ti
      qi++
    }
  }
  if (qi < q.length) return null // не все символы query найдены
  // Штраф за длину target (короче = лучше при прочих равных)
  score -= t.length * 0.1
  return Math.max(score, 1)
}

/**
 * Фильтрует и сортирует mention-элементы по query.
 *
 * Сортировка:
 *  1. По убыванию fuzzy-score
 *  2. При равном score — недавние (useCount > 0) выше
 *  3. При равном — по алфавиту
 *
 * Лимит: 50 результатов (хватит для типичных проектов; для гигантских —
 * виртуализация в @tanstack/react-virtual уже подключена в проекте).
 */
export function filterMentions(query: string, items: MentionItem[], limit = 50): MentionItem[] {
  const scored: Array<{ item: MentionItem; score: number }> = []
  for (const item of items) {
    // Матчим по label (basename) и по relPath (для файлов — полный путь)
    const targets = [item.label]
    if (item.relPath) targets.push(item.relPath)
    if (item.description) targets.push(item.description)

    let bestScore: number | null = null
    for (const target of targets) {
      const s = fuzzyScore(query, target)
      if (s !== null && (bestScore === null || s > bestScore)) bestScore = s
    }
    if (bestScore !== null) {
      // Буст за недавнее использование
      const recencyBoost = (item.useCount ?? 0) * 50
      scored.push({ item, score: bestScore + recencyBoost })
    }
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Недавние выше при равном score
    const aRecent = (a.item.useCount ?? 0) > 0 ? 1 : 0
    const bRecent = (b.item.useCount ?? 0) > 0 ? 1 : 0
    if (bRecent !== aRecent) return bRecent - aRecent
    return a.item.label.localeCompare(b.item.label, undefined, { numeric: true, sensitivity: 'base' })
  })
  return scored.slice(0, limit).map(s => s.item)
}

// ── Конвертация MentionItem → Attachment ─────────────────────────────────────

/**
 * Конвертирует выбранный MentionItem в Attachment для чипа над инпутом.
 *
 * source='mention' всегда — этот путь только для @выбора. Для drag&drop/paste
 * Attachment создаётся напрямую в соответствующих обработчиках.
 */
export function mentionToAttachment(item: MentionItem, source: Attachment['source'] = 'mention'): Attachment {
  return {
    id: crypto.randomUUID(),
    kind: item.type as Attachment['kind'],
    name: item.label,
    path: item.path,
    relPath: item.relPath,
    mime: item.mime,
    size: item.size,
    source,
    skillId: item.skillId,
    commandName: item.commandName,
    chatId: item.chatId,
    projectId: item.projectId,
    snippet: item.description,
    attachedAt: Date.now(),
  }
}

// ── Извлечение @упоминаний из отправленного текста ───────────────────────────

/**
 * Извлекает все @упоминания из текста (для подсветки/валидации).
 * Возвращает массив { start, end, name } — индексы и имя без @.
 *
 * «@foo bar @baz.ts» → [{start:0,end:4,name:'foo'},{start:9,end:15,name:'baz.ts'}]
 *
 * Не валидирует существование — только синтаксический разбор.
 */
export function extractMentions(text: string): Array<{ start: number; end: number; name: string }> {
  const result: Array<{ start: number; end: number; name: string }> = []
  const re = /(?:^|\s)@([^\s@]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const atIdx = m[0] === '@' + m[1] ? m.index : m.index + 1
    result.push({ start: atIdx, end: atIdx + 1 + m[1].length, name: m[1] })
  }
  return result
}

// ── MIME-определение по расширению (без зависимости от node) ─────────────────

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.css': 'text/css',
  '.scss': 'text/css',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'text/xml',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.env': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/rust',
  '.java': 'text/x-java',
  '.kt': 'text/x-kotlin',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.php': 'text/x-php',
  '.swift': 'text/x-swift',
  '.sql': 'application/sql',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

/** Возвращает MIME-тип по расширению файла. Unknown → 'application/octet-stream'. */
export function mimeFromExt(filename: string): string {
  const lower = filename.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return MIME_BY_EXT[lower.slice(dot)] ?? 'application/octet-stream'
}

/** Является ли файл изображением по MIME/расширению. */
export function isImageMime(mime: string | undefined): boolean {
  return !!mime && mime.startsWith('image/')
}

/** Является ли файл текстовым (можно инлайнить в content). */
export function isTextMime(mime: string | undefined): boolean {
  return !!mime && (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime === 'application/sql')
}

/** Определяет MentionItemType по имени файла (для индексатора файлов). */
export function mentionTypeFromFilename(filename: string): MentionItemType {
  const mime = mimeFromExt(filename)
  return isImageMime(mime) ? 'image' : 'file'
}
