import { useCallback, useEffect, useRef } from 'react'
import type { Attachment } from '../../../../../shared/types'
import { splitByAttachTokens } from '../../../../../shared/attachmentMarkdown'

// ── contentEditable-редактор с inline-вложениями ───────────────────────────
//
// Замена textarea: вложения живут ПРЯМО В ТЕКСТЕ на месте вставки (как в
// ChatGPT) — картинка/чип файла сидит в потоке текста, после него можно
// продолжать печатать. Удаляется Backspace'ом (нативно для
// contenteditable=false inline-элемента) или крестиком на чипе.
//
// Сериализация: DOM → строка, где чип = токен [[attach:<id>]]. Value хранит
// токены — позиция вложения переживает рестарт (черновик в БД) и попадает в
// message.content (рендер в чате восстанавливает чипы на местах).
//
// React НЕ управляет children этого div (suppressContentEditableWarning):
// DOM мутируется пользователем и императивно (вставка чипов), React-рендер
// не перезаписывает каретку. Синхронизация односторонняя: input → onChange;
// внешние изменения value (история, голос, смена чата) → rebuild DOM.

/** Публичный API редактора для хуков (вставка чипов, каретка, фокус). */
export interface EditorApi {
  focus: () => void
  /** Позиция каретки в сериализованном тексте (с токенами). */
  getCaretOffset: () => number
  setCaretOffset: (offset: number) => void
  /** Вставляет чип вложения на позицию каретки (пробел после + каретка за ним). */
  insertAttachmentAtCaret: (att: Attachment) => void
  /** Удаляет чип(ы) вложения из DOM (idempotent) + emit onChange. */
  removeAttachmentChip: (id: string) => void
  scrollToBottom: () => void
}

/** Сериализует DOM редактора в строку: текст + \n (BR) + токены [[attach:id]]. */
export function serializeEditor(el: HTMLElement): string {
  let out = ''
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const elm = node as HTMLElement
    if (elm.tagName === 'BR') { out += '\n'; return }
    if (elm.classList.contains('ce-attach')) {
      out += `[[attach:${elm.dataset.id ?? ''}]]`
      return
    }
    // Реплай-чипы НЕ сериализуются (визуальный слой в потоке текста):
    // метаданные реплаев живут в state родителя (replyTo), value остаётся
    // чистым — черновик в БД не содержит служебных токенов реплаев.
    if (elm.classList.contains('ce-reply')) return
    // div/p (могут появиться от неперехваченного drop) — текст + перенос
    elm.childNodes.forEach(walk)
    if (elm.tagName === 'DIV' || elm.tagName === 'P') out += '\n'
  }
  el.childNodes.forEach(walk)
  return out
}

/** Длина узла в сериализованном тексте. */
function nodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.length ?? 0
  if (node.nodeType !== Node.ELEMENT_NODE) return 0
  const elm = node as HTMLElement
  if (elm.tagName === 'BR') return 1
  if (elm.classList.contains('ce-attach')) return `[[attach:${elm.dataset.id ?? ''}]]`.length
  if (elm.classList.contains('ce-reply')) return 0
  let len = 0
  elm.childNodes.forEach(n => { len += nodeLength(n) })
  if (elm.tagName === 'DIV' || elm.tagName === 'P') len += 1
  return len
}

/** Каретка в конец редактора. */
function placeCaretEnd(el: HTMLElement): void {
  el.focus()
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

/** Позиция каретки в сериализованном тексте (для @mention/slash-детекта). */
function getCaretOffsetIn(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return serializeEditor(el).length
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return serializeEditor(el).length
  let offset = 0
  let found = false
  const walk = (node: Node): void => {
    if (found) return
    if (node === range.startContainer) {
      if (node === el) {
        // Каретка между детьми — суммируем длины первых startOffset детей
        for (let i = 0; i < range.startOffset && i < el.childNodes.length; i++) {
          offset += nodeLength(el.childNodes[i])
        }
      } else {
        offset += range.startOffset
      }
      found = true
      return
    }
    if (node.nodeType === Node.TEXT_NODE) { offset += node.nodeValue?.length ?? 0; return }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const elm = node as HTMLElement
    if (elm.tagName === 'BR') { offset += 1; return }
    if (elm.classList.contains('ce-attach')) { offset += `[[attach:${elm.dataset.id ?? ''}]]`.length; return }
    if (elm.classList.contains('ce-reply')) return
    elm.childNodes.forEach(walk)
    if (elm.tagName === 'DIV' || elm.tagName === 'P') offset += 1
  }
  walk(el)
  return found ? offset : serializeEditor(el).length
}

/** Устанавливает каретку на позицию в сериализованном тексте. */
function setCaretOffsetIn(el: HTMLElement, target: number): void {
  el.focus()
  const sel = window.getSelection()
  if (!sel) return
  let acc = 0
  let placed = false
  const walk = (node: Node): void => {
    if (placed) return
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.nodeValue?.length ?? 0
      if (acc + len >= target) {
        const range = document.createRange()
        range.setStart(node, Math.max(0, Math.min(target - acc, len)))
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
        placed = true
      }
      acc += len
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const elm = node as HTMLElement
    if (elm.tagName === 'BR') { acc += 1; return }
    if (elm.classList.contains('ce-attach')) { acc += `[[attach:${elm.dataset.id ?? ''}]]`.length; return }
    if (elm.classList.contains('ce-reply')) return
    elm.childNodes.forEach(walk)
    if (elm.tagName === 'DIV' || elm.tagName === 'P') acc += 1
  }
  walk(el)
  if (!placed) placeCaretEnd(el)
}

/** Создаёт DOM-элемент чипа вложения (contenteditable=false, с крестиком). */
function createChipEl(
  att: Attachment,
  onRemove: (id: string) => void,
  onPreview?: (a: Attachment) => void,
): HTMLElement {
  const span = document.createElement('span')
  span.className = `ce-attach ce-attach--${att.kind}`
  span.contentEditable = 'false'
  span.dataset.id = att.id
  span.title = att.relPath || att.path || att.name

  if (att.kind === 'image') {
    const img = document.createElement('img')
    img.className = 'ce-attach-thumb'
    img.src = att.dataUrl || (att.path ? `file://${att.path}` : '')
    img.alt = att.name
    img.draggable = false
    span.appendChild(img)
  } else {
    const icon = document.createElement('span')
    icon.className = 'ce-attach-icon'
    icon.innerHTML =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
    span.appendChild(icon)
  }

  const name = document.createElement('span')
  name.className = 'ce-attach-name'
  name.textContent = att.name
  span.appendChild(name)

  const rm = document.createElement('button')
  rm.className = 'ce-attach-remove'
  rm.type = 'button'
  rm.title = 'Убрать вложение'
  rm.innerHTML =
    '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  rm.addEventListener('click', (e) => {
    e.stopPropagation()
    e.preventDefault()
    span.remove()
    onRemove(att.id)
  })
  span.appendChild(rm)

  if (onPreview) {
    span.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.ce-attach-remove')) return
      e.stopPropagation()
      onPreview(att)
    })
  }
  return span
}

/** Данные реплай-чипа в редакторе (подмножество ReplyTarget). */
export interface EditorReplyChip {
  id: string
  role: string
  content: string
  attachmentsCount?: number
}

/**
 * Создаёт DOM-элемент реплай-чипа (contenteditable=false) — сидит В ПОТОКЕ
 * ТЕКСТА редактора в самом начале, как inline-чипы вложений. НЕ сериализуется
 * (serializeEditor пропускает .ce-reply) — value остаётся чистым текстом.
 * Наведение — нативный title с полным текстом исходного сообщения (как у
 * чипов вложений): читаемо всегда, не обрезается scroll-контейнером редактора.
 */
function createReplyChipEl(
  reply: EditorReplyChip,
  onRemove: (id: string) => void,
): HTMLElement {
  const span = document.createElement('span')
  span.className = 'ce-reply'
  span.contentEditable = 'false'
  span.dataset.id = reply.id

  const clean = (reply.content || '')
    .replace(/\[\[attach:[a-zA-Z0-9_-]+\]\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const full = (reply.content || '')
    .replace(/\[\[attach:[a-zA-Z0-9_-]+\]\]/g, ' ')
    .trim()
  span.title = `Ответ на ${reply.role === 'user' ? 'ваше сообщение' : 'сообщение Syntee'}:\n` +
    (full.slice(0, 500) || '— сообщение без текста —') +
    (full.length > 500 ? '…' : '') +
    (reply.attachmentsCount ? `\n\nВложений: ${reply.attachmentsCount}` : '')

  const icon = document.createElement('span')
  icon.className = 'ce-reply-icon'
  icon.innerHTML =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>'
  span.appendChild(icon)

  const role = document.createElement('span')
  role.className = 'ce-reply-role'
  role.textContent = reply.role === 'user' ? 'Вы' : 'Syntee'
  span.appendChild(role)

  if (clean || reply.attachmentsCount) {
    const name = document.createElement('span')
    name.className = 'ce-reply-name'
    name.textContent = (clean.slice(0, 60) || `вложение ×${reply.attachmentsCount}`) +
      (clean.length > 60 ? '…' : '')
    span.appendChild(name)
  }

  const rm = document.createElement('button')
  rm.className = 'ce-reply-remove'
  rm.type = 'button'
  rm.title = 'Убрать реплай'
  rm.innerHTML =
    '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  rm.addEventListener('click', (e) => {
    e.stopPropagation()
    e.preventDefault()
    span.remove()
    onRemove(reply.id)
  })
  span.appendChild(rm)

  return span
}

interface ChatInputEditorProps {
  value: string
  onChange: (text: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  /** Вызывается когда в буфере есть File-объекты (картинки ИЛИ файлы,
   *  скопированные в Проводнике) — хук добавит их как вложения. */
  onPasteImages: (e: React.ClipboardEvent<HTMLDivElement>) => void
  /** Paste текста с markdown-ссылками на файлы (copy из сообщения чата):
   *  хук создаёт вложения + чипы, редактор вырезает ссылки из текста. */
  onPasteLinks?: (text: string) => void
  /** Сериализованный текст ПОСЛЕ пользовательского ввода (не внешних правок
   *  value!) — ChatInput чистит осиротевшие вложения (Backspace по чипу). */
  onUserInput?: (text: string) => void
  attachments: Attachment[]
  onRemoveAttachment: (id: string) => void
  onPreviewAttachment?: (a: Attachment) => void
  /** Реплай-чипы — визуальный слой В ПОТОКЕ ТЕКСТА редактора (в начале).
   *  Не сериализуются: метаданные живут в state родителя (replyTo). */
  replies?: EditorReplyChip[]
  /** Удаление реплая (крестик на чипе ИЛИ Backspace по чипу). */
  onRemoveReply?: (id: string) => void
  editorApiRef: React.MutableRefObject<EditorApi | null>
  editorRef: React.RefObject<HTMLDivElement>
  placeholder: string
  planningMode?: boolean
  askMode?: boolean
  disabled?: boolean
}

export function ChatInputEditor({
  value,
  onChange,
  onKeyDown,
  onPasteImages,
  onPasteLinks,
  onUserInput,
  attachments,
  onRemoveAttachment,
  onPreviewAttachment,
  replies,
  onRemoveReply,
  editorApiRef,
  editorRef,
  placeholder,
  planningMode,
  askMode,
  disabled,
}: ChatInputEditorProps) {
  // Свежие колбэки для императивно созданных DOM-чипов.
  // Обновление в эффекте (не в рендере — react-hooks/refs): эффект объявлен
  // ДО rebuild-эффекта, поэтому rebuild видит актуальные колбэки.
  const cbsRef = useRef({ onRemoveAttachment, onPreviewAttachment, attachments, replies, onRemoveReply })
  useEffect(() => {
    cbsRef.current = { onRemoveAttachment, onPreviewAttachment, attachments, replies, onRemoveReply }
  })
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })
  const onUserInputRef = useRef(onUserInput)
  useEffect(() => {
    onUserInputRef.current = onUserInput
  })

  // Стабильные обёртки для DOM-чипов: читают cbsRef В МОМЕНТ события.
  // Чип живёт в DOM дольше рендера — прямая ссылка на колбэк захватила бы
  // устаревшее замыкание attachments (крестик на старом чипе затирал
  // вложения, добавленные после его создания).
  const stableRemove = useCallback((id: string) => {
    cbsRef.current.onRemoveAttachment(id)
  }, [])
  const stablePreview = useCallback((a: Attachment) => {
    cbsRef.current.onPreviewAttachment?.(a)
  }, [])
  const stableRemoveReply = useCallback((id: string) => {
    cbsRef.current.onRemoveReply?.(id)
  }, [])

  const emitChange = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    const serialized = serializeEditor(el)
    el.dataset.empty = serialized === '' ? '1' : ''
    onChangeRef.current(serialized)
    // Синхронизация вложений — ТОЛЬКО на пользовательский ввод (Backspace по
    // чипу). Внешние правки value (отправка: onChangeValue('')) сюда не
    // попадают — вложения не затираются до завершения chat.send.
    onUserInputRef.current?.(serialized)
    // Реплай-чипы: Backspace/Delete выкинул чип из DOM, но реплай ещё в
    // state родителя — синхронизируем (иначе чип вернётся при следующем
    // sync-эффекте). Крестик на чипе вызывает onRemoveReply сам.
    const presentReplies = new Set<string>()
    el.querySelectorAll('.ce-reply').forEach(n => {
      const id = (n as HTMLElement).dataset.id
      if (id) presentReplies.add(id)
    })
    for (const r of cbsRef.current.replies ?? []) {
      if (!presentReplies.has(r.id)) cbsRef.current.onRemoveReply?.(r.id)
    }
  }, [editorRef])

  // ── Rebuild DOM при внешнем изменении value ──
  // Пользовательский ввод не попадает сюда (serialize === value → skip),
  // поэтому каретка при печати не трогается. Внешние изменения (история,
  // голос, смена чата, mention-замена) → полная пересборка + каретка в конец.
  // attachments в deps + форс при заглушках: draft-вложения могут прийти из
  // БД ПОЗЖЕ текста черновика — тогда чипы-заглушки заменяются настоящими.
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    const hasMissing = el.querySelector('.ce-attach--missing') !== null
    if (!hasMissing && serializeEditor(el) === value) {
      el.dataset.empty = value === '' ? '1' : ''
      return
    }
    el.innerHTML = ''
    for (const seg of splitByAttachTokens(value)) {
      if (seg.type === 'text') {
        el.appendChild(document.createTextNode(seg.text))
      } else {
        const att = cbsRef.current.attachments.find(a => a.id === seg.id)
        if (att) {
          el.appendChild(createChipEl(att, stableRemove, stablePreview))
        } else {
          // Вложение не найдено в массиве — заглушка (сериализация не разъедется)
          const stub = document.createElement('span')
          stub.className = 'ce-attach ce-attach--missing'
          stub.contentEditable = 'false'
          stub.dataset.id = seg.id
          stub.textContent = 'вложение'
          el.appendChild(stub)
        }
      }
    }
    placeCaretEnd(el)
    el.dataset.empty = value === '' ? '1' : ''
  }, [value, attachments, editorRef, stableRemove, stablePreview])

  // ── Синхронизация реплай-чипов (ПОСЛЕ rebuild — он вытирает innerHTML) ──
  // Чипы живут в DOM редактора как визуальный слой: добавляются в НАЧАЛО
  // текста в порядке replies. value в deps: rebuild (внешняя правка черновика)
  // вытирает чипы — этот эффект восстанавливает их сразу после.
  // При любом расхождении множества — полная пересборка (чипов мало, дёшево):
  // гарантирует правильный порядок при инкрементальных добавлениях.
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    const list = replies ?? []
    const listIds = list.map(r => r.id).join('\u0000')
    const domIds: string[] = []
    el.querySelectorAll('.ce-reply').forEach(n => {
      const id = (n as HTMLElement).dataset.id
      if (id) domIds.push(id)
    })
    if (listIds === domIds.join('\u0000')) return
    el.querySelectorAll('.ce-reply').forEach(n => n.remove())
    for (let i = list.length - 1; i >= 0; i--) {
      el.insertBefore(createReplyChipEl(list[i], stableRemoveReply), el.firstChild)
    }
  }, [value, replies, editorRef, stableRemoveReply])

  // ── Вставка чипа вложения на каретку ──
  const insertAttachmentAtCaret = useCallback(
    (att: Attachment) => {
      const el = editorRef.current
      if (!el) return
      el.focus()
      const chip = createChipEl(att, stableRemove, stablePreview)
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0)
        range.deleteContents()
        range.insertNode(chip)
        // Пробел после чипа + каретка на него — текст не прилипает к чипу
        const tail = document.createTextNode(' ')
        chip.after(tail)
        const r = document.createRange()
        r.setStart(tail, 1)
        r.collapse(true)
        sel.removeAllRanges()
        sel.addRange(r)
      } else {
        el.appendChild(chip)
        el.appendChild(document.createTextNode(' '))
        placeCaretEnd(el)
      }
      emitChange()
    },
    [editorRef, emitChange, stableRemove, stablePreview],
  )

  const removeAttachmentChip = useCallback(
    (id: string) => {
      const el = editorRef.current
      if (!el) return
      el.querySelectorAll(`.ce-attach[data-id="${CSS.escape(id)}"]`).forEach(n => n.remove())
      emitChange()
    },
    [editorRef, emitChange],
  )

  // ── Публичный API ──
  useEffect(() => {
    editorApiRef.current = {
      focus: () => editorRef.current?.focus(),
      getCaretOffset: () => (editorRef.current ? getCaretOffsetIn(editorRef.current) : 0),
      setCaretOffset: (o: number) => {
        if (editorRef.current) setCaretOffsetIn(editorRef.current, o)
      },
      insertAttachmentAtCaret,
      removeAttachmentChip,
      scrollToBottom: () => {
        const el = editorRef.current
        if (el) el.scrollTop = el.scrollHeight
      },
    }
    return () => { editorApiRef.current = null }
  }, [editorApiRef, editorRef, insertAttachmentAtCaret, removeAttachmentChip])

  // ── Paste: картинки/файлы → наружу (добавит Attachment + чип); текст с
  //    markdown-ссылками на файлы (copy из сообщения) → onPasteLinks
  //    (восстановит вложения чипами); остальной текст → plain ──
  const handlePasteInner = (e: React.ClipboardEvent<HTMLDivElement>) => {
    // File-объекты в буфере: картинка из скриншота/браузера ИЛИ файл,
    // скопированный в Проводнике (Ctrl+C → Ctrl+V). Оба — во вложения.
    if ((e.clipboardData?.files?.length ?? 0) > 0) {
      onPasteImages(e)
      return
    }
    const items = e.clipboardData?.items
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          onPasteImages(e)
          return
        }
      }
    }
    // Текст — всегда plain (вырезаем форматирование из буфера)
    e.preventDefault()
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (!text) return
    // Copy из сообщения содержит ![name](file://...) / [name](file://...) —
    // восстанавливаем вложения чипами, сами ссылки из текста вырезаем.
    if (onPasteLinks && text.includes('](file://')) {
      const stripped = text
        .replace(/!?[ \t]*\[[^\]]*\]\(file:\/\/[^)]+\)[ \t]*/g, '')
        .replace(/[ \t]{2,}/g, ' ')
      if (stripped.trim()) {
        document.execCommand('insertText', false, stripped.trim() + ' ')
      }
      onPasteLinks(text)
      return
    }
    document.execCommand('insertText', false, text)
  }

  // ── Drop: файлы не вставляем сами (браузер вставил бы <img>/<a>) —
  //    preventDefault обязателен, внешний onDrop на .chat-input-box добавит
  //    вложение. Текст — plain-вставка. ──
  const handleDropInner = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (e.dataTransfer.types.includes('Files')) return
    const text = e.dataTransfer.getData('text/plain')
    if (text) document.execCommand('insertText', false, text)
  }

  return (
    <div
      ref={editorRef}
      className={`chat-input-editor selectable${planningMode ? ' chat-input-editor--planning' : ''}${askMode && !planningMode ? ' chat-input-editor--ask' : ''}`}
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      data-placeholder={placeholder}
      data-empty="1"
      spellCheck={false}
      onInput={emitChange}
      onKeyDown={onKeyDown}
      onPaste={handlePasteInner}
      onDrop={handleDropInner}
    />
  )
}
