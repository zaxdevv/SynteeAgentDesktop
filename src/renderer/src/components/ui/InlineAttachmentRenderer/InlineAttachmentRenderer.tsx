// ── InlineAttachmentRenderer: рендерит токены [[attach:...]] inline ──────
//
// Используется в:
//   - ChatInputHelpers.tsx renderMirrorContent — для mirror-слоя инпут-бара
//   - MessageBubble.tsx — для user-сообщений с токенами (вместо plain <p>)
//
// Картинки → миниатюра <img> 40×40px (inline-block)
// Файлы → чип с иконкой и именем (inline-block)
// Текст до/между/после → обычный текст

import type { JSX } from 'react'
import type { Attachment, AttachmentKind } from '../../../../../shared/types'
import { ATTACH_TOKEN_RE } from '../../../../../shared/attachmentMarkdown'

function KindIcon({ kind }: { kind: AttachmentKind }): JSX.Element {
  if (kind === 'image') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    )
  }
  if (kind === 'audio' || kind === 'video') {
    return <span aria-label={kind === 'video' ? 'Видео' : 'Аудио'}>{kind === 'video' ? '▶' : '♫'}</span>
  }
  if (kind === 'skill') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l3 7 7 .5-5.5 4.5 1.5 7L12 17l-6 4 1.5-7L2 9.5 9 9z" />
      </svg>
    )
  }
  if (kind === 'command') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </svg>
    )
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

function ImageThumb({ attachment }: { attachment: Attachment }): JSX.Element | null {
  const src = attachment.dataUrl || (attachment.path ? `file://${attachment.path}` : null)
  if (!src) return null
  return <img src={src} alt={attachment.name} className="inline-attach-thumb" />
}

export interface InlineAttachmentRendererProps {
  /** Текст с токенами [[attach:...]] */
  text: string
  /** Массив вложений для матчинга по id из токенов */
  attachments: Attachment[]
  /** Клик по вложению (превью/открытие) */
  onPreview?: (attachment: Attachment) => void
  /** CSS-класс для контейнера */
  className?: string
  /** whiteSpace стиль (для user-сообщений — pre-wrap) */
  preWrap?: boolean
}

/**
 * Рендерит текст с inline-вложениями.
 * Парсит токены [[attach:UUID|kind|name]], заменяет на визуальные элементы.
 */
export function renderInlineAttachments(
  text: string,
  attachments: Attachment[],
  onPreview?: (attachment: Attachment) => void,
): JSX.Element {
  // Быстрый выход — нет токенов
  if (!text.includes('[[attach:')) return <>{text}</>

  const parts: Array<{ text: string; attachment?: Attachment }> = []
  const re = new RegExp(ATTACH_TOKEN_RE.source, 'g')
  let lastIdx = 0
  let m: RegExpExecArray | null
  let found = false

  while ((m = re.exec(text)) !== null) {
    found = true
    if (m.index > lastIdx) {
      parts.push({ text: text.slice(lastIdx, m.index) })
    }
    const id = m[1]
    const name = m[3]
    const att = attachments.find(a => a.id === id)
    if (att) {
      parts.push({ text: '', attachment: att })
    } else {
      // Attachment не найден — рендерим как текст (имя из токена)
      parts.push({ text: name })
    }
    lastIdx = m.index + m[0].length
  }

  // Запасной вариант: regex не сматчился, но токены есть.
  // Заменяем токены на имена (без raw токенов в UI).
  if (!found) {
    const fallback = text.replace(ATTACH_TOKEN_RE, (_, _id: string, _kind: string, name: string) => name)
    return <>{fallback}</>
  }

  if (lastIdx < text.length) {
    parts.push({ text: text.slice(lastIdx) })
  }

  return (
    <>
      {parts.map((p, i) =>
        p.attachment ? (
          <span
            key={i}
            className={`inline-attach inline-attach--${p.attachment.kind}`}
            onClick={onPreview ? (e) => { e.stopPropagation(); onPreview(p.attachment!) } : undefined}
            title={p.attachment.relPath || p.attachment.path || p.attachment.name}
          >
            {p.attachment.kind === 'image' && <ImageThumb attachment={p.attachment} />}
            {p.attachment.kind !== 'image' && (
              <span className="inline-attach-icon">
                <KindIcon kind={p.attachment.kind} />
              </span>
            )}
            <span className="inline-attach-name">{p.attachment.name}</span>
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}

export default renderInlineAttachments
