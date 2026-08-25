import { useState, useRef } from 'react'
import type { DragEvent, ClipboardEvent } from 'react'
import { mimeFromExt, isImageMime } from '../../../../../shared/mentions'
import type { Attachment } from '../../../../../shared/types'
import { fileToBase64 } from './ChatInputHelpers'
import { parseMarkdownLinks } from '../../../../../shared/attachmentMarkdown'
import type { EditorApi } from './ChatInputEditor'

interface UseChatInputAttachmentsOptions {
  chatId?: string
  attachments: Attachment[]
  onAttachmentsChange?: (attachments: Attachment[]) => void
  maxAttachments?: number
  /** API contentEditable-редактора — вставка чипов на позицию каретки. */
  editorApiRef?: React.MutableRefObject<EditorApi | null>
}

/**
 * Логика вложений инпут-бара: drag&drop, paste картинок, кнопка «Прикрепить
 * файл» (native dialog) и удаление чипов. Вынесено из ChatInput.tsx.
 *
 * Картинки сохраняются в userData (saveImageFromBase64), остальные файлы
 * копируются (saveFileFromPath). File.path удалён в Electron 32+
 * (contextIsolation) — для не-картинок используем webUtils.getPathForFile.
 *
 * Вложения живут ПРЯМО В ТЕКСТЕ редактора: после добавления в массив чип
 * вставляется на позицию каретки (insertAttachmentAtCaret), в value он
 * сериализуется в токен [[attach:id]].
 */
export function useChatInputAttachments({
  chatId,
  attachments,
  onAttachmentsChange,
  maxAttachments = 10,
  editorApiRef,
}: UseChatInputAttachmentsOptions) {
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  // ── Универсальный обработчик добавления File[] → Attachment[] ──
  const addFilesAsAttachments = async (files: File[]) => {
    if (!chatId) return
    const remaining = maxAttachments - attachments.length
    if (remaining <= 0) return
    const toAdd: Attachment[] = []
    for (const file of files.slice(0, remaining)) {
      try {
        if (file.type.startsWith('image/')) {
          const base64 = await fileToBase64(file)
          const res = await window.syntee.attachments.saveImageFromBase64({
            chatId,
            base64,
            mime: file.type,
            suggestedName: file.name.replace(/\.[^.]+$/, '') || `image-${Date.now()}`,
          })
          if (res.success) {
            toAdd.push({
              id: crypto.randomUUID(),
              kind: 'image',
              name: res.name,
              path: res.path,
              mime: res.mime,
              size: res.size,
              source: 'dragdrop',
              dataUrl: base64,
              attachedAt: Date.now(),
            })
          }
        } else {
          const filePath = window.syntee.attachments.getPathForFile(file)
          if (!filePath) continue
          const res = await window.syntee.attachments.saveFileFromPath({ chatId, sourcePath: filePath })
          if (res.success) {
            toAdd.push({
              id: crypto.randomUUID(),
              kind: 'file',
              name: res.name,
              path: res.path,
              mime: res.mime,
              size: res.size,
              source: 'dragdrop',
              attachedAt: Date.now(),
            })
          }
        }
      } catch { /* skip individual file errors */ }
    }
    if (toAdd.length > 0) {
      onAttachmentsChange?.([...attachments, ...toAdd])
      // Чипы — на позицию каретки в тексте (в value → токен [[attach:id]])
      for (const att of toAdd) {
        editorApiRef?.current?.insertAttachmentAtCaret(att)
      }
    }
  }

  // ── Drag&Drop файлов ──
  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!e.dataTransfer.types.includes('Files')) return
    dragCounterRef.current++
    setIsDragOver(true)
  }
  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragOver(false)
    }
  }
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
  }
  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    await addFilesAsAttachments(files)
  }

  // ── Paste изображения из буфера обмена (Ctrl+V) ──
  // Вызывается редактором ТОЛЬКО когда в буфере есть картинки.
  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageItems: DataTransferItem[] = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) imageItems.push(items[i])
    }
    if (imageItems.length === 0) return // обычный текст — редактор вставит сам
    e.preventDefault()
    const files: File[] = []
    for (const item of imageItems) {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
    if (files.length > 0) void addFilesAsAttachments(files)
  }

  // ── Кнопка «Прикрепить файл» (native dialog) ──
  const handleAttachClick = async () => {
    const filePaths = await window.syntee.attachments.pickFile()
    if (!filePaths || filePaths.length === 0) return
    const remaining = maxAttachments - attachments.length
    if (remaining <= 0) return
    const toAdd: Attachment[] = []
    for (const fp of filePaths.slice(0, remaining)) {
      const name = fp.split(/[\\/]/).pop() || fp
      const mime = mimeFromExt(name)
      const isImg = isImageMime(mime)
      const res = await window.syntee.attachments.saveFileFromPath({ chatId: chatId!, sourcePath: fp })
      if (res.success) {
        toAdd.push({
          id: crypto.randomUUID(),
          kind: isImg ? 'image' : 'file',
          name: res.name,
          path: res.path,
          mime: res.mime,
          size: res.size,
          source: 'dialog',
          attachedAt: Date.now(),
        })
      }
    }
    if (toAdd.length > 0) {
      onAttachmentsChange?.([...attachments, ...toAdd])
      // Чипы — на позицию каретки в тексте (в value → токен [[attach:id]])
      for (const att of toAdd) {
        editorApiRef?.current?.insertAttachmentAtCaret(att)
      }
    }
  }

  // ── Paste Markdown-ссылок (copy из сообщения чата) → вложения ──
  // Ссылки ![name](file://path) / [name](file://path) превращаются во
  // вложения-ссылки (файл НЕ копируем — path уже валиден, принадлежит
  // отправленному сообщению) + чипы на позицию каретки.
  const handlePasteLinks = (text: string) => {
    const links = parseMarkdownLinks(text).filter(l => l.url.startsWith('file://'))
    if (links.length === 0) return
    const remaining = maxAttachments - attachments.length
    if (remaining <= 0) return
    const toAdd: Attachment[] = []
    for (const link of links.slice(0, remaining)) {
      let path = link.url.replace(/^file:\/\//, '')
      try {
        path = decodeURIComponent(path)
      } catch {
        // путь с «сырым» % — оставляем как есть
      }
      const name = link.name || path.split(/[\\/]/).pop() || 'file'
      const mime = mimeFromExt(name)
      toAdd.push({
        id: crypto.randomUUID(),
        kind: isImageMime(mime) ? 'image' : 'file',
        name,
        path,
        mime,
        source: 'paste',
        attachedAt: Date.now(),
      })
    }
    if (toAdd.length > 0) {
      onAttachmentsChange?.([...attachments, ...toAdd])
      for (const att of toAdd) {
        editorApiRef?.current?.insertAttachmentAtCaret(att)
      }
    }
  }

  // ── Удаление вложения ──
  const handleRemoveAttachment = (id: string) => {
    const removed = attachments.find(a => a.id === id)
    // Диск чистим ТОЛЬКО для наших копий (dragdrop/paste-файлы и dialog
    // копируются в userData/draft-attachments). mention/paste-ссылки
    // ссылаются на чужие файлы (в т.ч. вложения отправленных сообщений) —
    // их удаление сломало бы старые сообщения.
    const ownsFile = !!removed?.path && (removed.source === 'dragdrop' || removed.source === 'dialog')
    if (ownsFile) {
      window.syntee.attachments.deleteFile({ path: removed!.path! }).catch(() => {})
    }
    // Чип из DOM уже удалён (крестик) — на случай внешнего вызова чистим сами
    editorApiRef?.current?.removeAttachmentChip(id)
    onAttachmentsChange?.(attachments.filter(a => a.id !== id))
  }

  return {
    isDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handlePaste,
    handlePasteLinks,
    handleAttachClick,
    handleRemoveAttachment,
  }
}
