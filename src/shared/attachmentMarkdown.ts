// ── Утилиты для Markdown-конверсии вложений ─────────────────────────────
//
// Используется для:
//   - copy из сообщения (attachmentsToMarkdown — добавляет Markdown-ссылки)
//   - paste в инпут (parseMarkdownLinks — находит ссылки в тексте)

import type { Attachment } from './types/attachment'

/** Regex для Markdown-ссылок на файлы: ![name](path) или [name](path) */
export const MD_LINK_RE = /!?\[([^\]]*)\]\((file:\/\/[^)]+|https?:\/\/[^)]+)\)/g

// ── Inline-токены вложений в тексте: [[attach:<id>]] ──────────────────────
//
// Инпут-бар — contentEditable-редактор: вложение вставляется чипом ПРЯМО В
// ТЕКСТ на позицию каретки. В value (черновик, message.content) чип
// сериализуется в токен [[attach:id]] — позиция сохраняется и в БД, и при
// рендере user-сообщения в чате чипы восстанавливаются на своих местах.

/** Regex inline-токенов вложений: [[attach:<id>]] (id — uuid или простой). */
export const ATTACH_TOKEN_RE = /\[\[attach:([a-zA-Z0-9_-]+)\]\]/g

/** Сегмент текста: либо обычный текст, либо id вложения (токен). */
export type AttachTokenSegment = { type: 'text'; text: string } | { type: 'attach'; id: string }

/** Разбивает текст на сегменты по токенам вложений. */
export function splitByAttachTokens(text: string): AttachTokenSegment[] {
  const segs: AttachTokenSegment[] = []
  const re = new RegExp(ATTACH_TOKEN_RE.source, 'g')
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ type: 'text', text: text.slice(last, m.index) })
    segs.push({ type: 'attach', id: m[1] })
    last = m.index + m[0].length
  }
  if (last < text.length) segs.push({ type: 'text', text: text.slice(last) })
  return segs
}

/** Есть ли в тексте токены вложений. */
export function hasAttachTokens(text: string): boolean {
  return new RegExp(ATTACH_TOKEN_RE.source).test(text)
}

/**
 * Вычищает токены вложений из текста (для отправки в AI — модель не должна
 * видеть служебные маркеры). Токен на отдельной строке удаляется вместе с
 * переносом, inline-токен заменяется на пробел.
 */
export function stripAttachTokens(text: string): string {
  return text
    .replace(/[ \t]*\[\[attach:[a-zA-Z0-9_-]+\]\][ \t]*(\n|$)/g, '$1')
    .replace(/[ \t]*\[\[attach:[a-zA-Z0-9_-]+\]\][ \t]*/g, ' ')
    .replace(/^[ \t]+/, '')
    .replace(/[ \t]+$/, '')
}

/**
 * Заменяет токены вложений на Markdown-ссылки на их местах (для копирования
 * сообщения в буфер). Вложение без path или неизвестный токен → ''.
 */
export function replaceAttachTokensWithLinks(text: string, attachments: Attachment[]): string {
  const map = new Map(attachments.map(a => [a.id, a]))
  return text.replace(new RegExp(ATTACH_TOKEN_RE.source, 'g'), (_full: string, id: string) => {
    const a = map.get(id)
    if (!a) return ''
    // Чаты/проекты/скиллы/команды не имеют file-пути — при копировании
    // оставляем читаемую @ссылку по имени (не молча теряем чип).
    if (!a.path) return `@${a.name}`
    const fileUrl = a.path.startsWith('file://') ? a.path : `file://${a.path}`
    return a.kind === 'image' ? `![${a.name}](${fileUrl})` : `[${a.name}](${fileUrl})`
  })
}

/**
 * Конвертирует массив вложений в Markdown-ссылки (для копирования).
 * Картинки → ![name](file://path), файлы → [name](file://path)
 * Возвращает строку с ссылками через \n, или пустую строку если нет вложений.
 */
export function attachmentsToMarkdown(attachments: Attachment[]): string {
  return attachments
    .filter(a => a.path)
    .map(a => {
      const fileUrl = a.path!.startsWith('file://') ? a.path! : `file://${a.path!}`
      return a.kind === 'image'
        ? `![${a.name}](${fileUrl})`
        : `[${a.name}](${fileUrl})`
    })
    .join('\n')
}

/**
 * Парсит Markdown-ссылки в тексте и возвращает массив найденных ссылок.
 */
export interface ParsedMdLink {
  raw: string
  name: string
  url: string
  isImage: boolean
  index: number
  length: number
}

export function parseMarkdownLinks(text: string): ParsedMdLink[] {
  const results: ParsedMdLink[] = []
  const re = new RegExp(MD_LINK_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const isImage = m[0].startsWith('!')
    results.push({
      raw: m[0],
      name: m[1],
      url: m[2],
      isImage,
      index: m.index,
      length: m[0].length,
    })
  }
  return results
}
