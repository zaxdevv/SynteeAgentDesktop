import type { JSX } from 'react'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Читает File как base64 data URL (для paste/drag&drop картинок). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/**
 * Рендерит содержимое mirror-слоя для подсветки @упоминаний и slash-команд.
 *
 * 1. @упоминания — токены вида @имяФайла (соответствующие прикреплённым
 *    Attachment) обрамляются в <span class="mention-highlight">.
 * 2. slash-команды — если строка начинается с /command, имя команды
 *    подсвечивается <span class="slash-command-highlight">, а текст аргументов
 *    после первого пробела — <span class="slash-command-arg">. Внутри аргументов
 *    @упоминания тоже подсвечиваются.
 *
 * Остальной текст рендерится как есть (color: transparent — виден только фон
 * подсветки).
 */
export function renderMentions(text: string): JSX.Element {
  const parts: Array<{ text: string; isMention: boolean }> = []
  const re = /(?:^|\s)@[^\s@]+/g
  let lastIdx = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const matchStart = m.index + (m[0].startsWith('@') ? 0 : 1)
    if (matchStart > lastIdx) {
      parts.push({ text: text.slice(lastIdx, matchStart), isMention: false })
    }
    parts.push({ text: text.slice(matchStart, matchStart + m[0].length - (m[0].startsWith('@') ? 0 : 1)), isMention: true })
    lastIdx = matchStart + m[0].length - (m[0].startsWith('@') ? 0 : 1)
  }
  if (lastIdx < text.length) {
    parts.push({ text: text.slice(lastIdx), isMention: false })
  }
  if (parts.length === 0) return <>{text}</>
  return (
    <>
      {parts.map((p, i) => (
        p.isMention
          ? <span key={i} className="mention-highlight">{p.text}</span>
          : <span key={i}>{p.text}</span>
      ))}
    </>
  )
}

export function renderMirrorContent(text: string): JSX.Element {
  // Slash-команда в начале строки: /command args...
  if (text.startsWith('/')) {
    const m = text.match(/^(\S+)(\s*)([\s\S]*)$/)
    if (m) {
      const cmdPart = m[1]
      const sep = m[2]
      const rest = m[3]
      return (
        <>
          <span className="slash-command-highlight">{cmdPart}</span>
          <span>{sep}</span>
          <span className="slash-command-arg">{renderMentions(rest)}</span>
          {/* Трейлинг-пробел чтобы mirror не схлопывался */}
          {' '}
        </>
      )
    }
  }
  return (
    <>
      {renderMentions(text)}
      {/* Трейлинг-пробел чтобы mirror не схлопывался */}
      {' '}
    </>
  )
}

// Framer-motion variants для меню «+» (attach/mode/persona picker).
export const menuContainer = {
  hidden: { opacity: 0, scale: 0.5 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { staggerChildren: 0.04, delayChildren: 0.08, type: 'spring', stiffness: 350, damping: 26 }
  },
  exit: {
    opacity: 0,
    scale: 0.5,
    transition: { staggerChildren: 0.02, staggerDirection: -1, duration: 0.18 }
  }
}

export const menuItem = {
  hidden: { opacity: 0, x: -12, scale: 0.96 },
  visible: { opacity: 1, x: 0, scale: 1, transition: { type: 'spring', stiffness: 520, damping: 28 } },
  exit: { opacity: 0, x: -6, transition: { duration: 0.1 } }
}
