import { useState, useRef } from 'react'
import type { DragEvent, ClipboardEvent } from 'react'
import { mimeFromExt, isImageMime } from '../../../../../shared/mentions'
import type { Attachment } from '../../../../../shared/types'
import { fileToBase64 } from './ChatInputHelpers'

interface UseChatInputAttachmentsOptions {
  chatId?: string
  attachments: Attachment[]
  onAttachmentsChange?: (attachments: Attachment[]) => void
  maxAttachments?: number
}

/**
 * Логика вложений инпут-бара: drag&drop, paste картинок, кнопка «Прикрепить
 * файл» (native dialog) и удаление чипов. Вынесено из ChatInput.tsx.
 *
 * Картинки сохраняются в userData (saveImageFromBase64), остальные файлы
 * копируются (saveFileFromPath). File.path удалён в Electron 32+
 * (contextIsolation) — для не-картинок используем webUtils.getPathForFile.
 */
export function useChatInputAttachments({
  chatId,
  attachments,
  onAttachmentsChange,
  maxAttachments = 10,
}: UseChatInputAttachmentsOptions) {
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  // ── Универсальный обработчик добавления File[] → Attachment[] ──
  // Используется в drag&drop и в paste. Картинки сохраняем в userData
  // (saveImageFromBase64), остальные файлы — копируем (saveFileFromPath).
  const addFilesAsAttachments = async (files: File[]) => {
    if (!chatId) return
    const remaining = maxAttachments - attachments.length
    if (remaining <= 0) return
    const toAdd: Attachment[] = []
    for (const file of files.slice(0, remaining)) {
      try {
        if (file.type.startsWith('image/')) {
          // Картинка — читаем как base64, сохраняем в userData
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
          // Не-картинка — нужен путь. File.path удалён в Electron 32+
          // (contextIsolation), используем webUtils.getPathForFile через preload.
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
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageItems: DataTransferItem[] = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) imageItems.push(items[i])
    }
    if (imageItems.length === 0) return // обычный текст — пусть textarea обрабатывает
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
      // Для диалога — копируем файл в userData (как в drag&drop), чтобы
      // пережил рестарт даже если исходный файл удалят.
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
    if (toAdd.length > 0) onAttachmentsChange?.([...attachments, ...toAdd])
  }

  // ── Удаление вложения ──
  // Если это картинка из paste/dragdrop (source !== 'mention') — удаляем файл из userData.
  const handleRemoveAttachment = (id: string) => {
    const removed = attachments.find(a => a.id === id)
    if (removed && removed.path && removed.source !== 'mention' && removed.kind === 'image') {
      window.syntee.attachments.deleteFile({ path: removed.path }).catch(() => {})
    }
    onAttachmentsChange?.(attachments.filter(a => a.id !== id))
  }

  return {
    isDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handlePaste,
    handleAttachClick,
    handleRemoveAttachment,
  }
}
