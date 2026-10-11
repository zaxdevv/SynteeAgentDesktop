import { useState, useRef, useEffect } from 'react'
import type { DragEvent, ClipboardEvent } from 'react'
import { mimeFromExt, attachmentKindFromMime } from '../../../../../shared/mentions'
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
  // Свежие значения для асинхронных обработчиков (drop fallback резолвит
  // пути после await — замыкание на старый attachments затёрло бы чипы).
  const attachmentsRef = useRef(attachments)
  useEffect(() => { attachmentsRef.current = attachments })
  const onAttachmentsChangeRef = useRef(onAttachmentsChange)
  useEffect(() => { onAttachmentsChangeRef.current = onAttachmentsChange })
  /** Имена файлов, добавленных основным путём (fallback их пропускает). */
  const toAddNamesRef = useRef<string[]>([])
  /** Папка-источник последнего drop (если распознали из webkitRelativePath
   *  или пути) — повышает точность fallback-резолва. */
  const dropSourceDirRef = useRef<string | null>(null)

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
          // Запоминаем папку-источник — поможет fallback-резолву для файлов
          // из той же папки, чей getPathForFile не сработал.
          const lastSep = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
          if (lastSep > 0) dropSourceDirRef.current = filePath.slice(0, lastSep)
          const res = await window.syntee.attachments.saveFileFromPath({ chatId, sourcePath: filePath })
          if (res.success) {
            toAdd.push({
              id: crypto.randomUUID(),
              kind: attachmentKindFromMime(res.mime || mimeFromExt(res.name)),
              name: res.name,
              path: res.path,
              mime: res.mime,
              size: res.size,
              source: 'dragdrop',
              attachedAt: Date.now(),
            })
          } else if ((res as { isDirectory?: boolean }).isDirectory) {
            // Папка — вложение-ссылка (без копирования): при отправке агент
            // получит листинг содержимого и сможет читать файлы по пути.
            toAdd.push({
              id: crypto.randomUUID(),
              kind: 'file',
              name: file.name,
              path: filePath,
              mime: '',
              source: 'dragdrop',
              attachedAt: Date.now(),
            })
          }
        }
      } catch { /* skip individual file errors */ }
    }
    toAddNamesRef.current = toAdd.map(a => a.name)
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
    // Fallback для файлов, которые не удалось прицепить через webUtils
    // (File.path удалён в Electron 32+, getPathForFile может отдать пусто
    // для некоторых источников). Просим main резолвить путь по имени.
    const addedNames = new Set(toAddNamesRef.current)
    toAddNamesRef.current = []
    for (const f of files) {
      if (f.type.startsWith('image/')) continue // картинки идут через base64 — без path
      if (addedNames.has(f.name)) continue
      try {
        const r = await window.syntee.attachments.resolveDropPath({
          name: f.name,
          dir: dropSourceDirRef.current ?? undefined,
        })
        if (r?.ok && r.foundName && r.path) {
          const saved = await window.syntee.attachments.saveFileFromPath({ chatId: chatId!, sourcePath: r.path })
          if (saved.success) {
            const att: Attachment = {
              id: crypto.randomUUID(),
              kind: attachmentKindFromMime(saved.mime || mimeFromExt(saved.name)),
              name: saved.name,
              path: saved.path,
              mime: saved.mime,
              size: saved.size,
              source: 'dragdrop',
              attachedAt: Date.now(),
            }
            onAttachmentsChange?.([...attachmentsRef.current, att])
            attachmentsRef.current = [...attachmentsRef.current, att]
            editorApiRef?.current?.insertAttachmentAtCaret(att)
          }
        }
      } catch { /* файл невиртуальный и не найден — молча пропускаем */ }
    }
  }

  // ── Paste изображений И ФАЙЛОВ из буфера обмена (Ctrl+V) ──
  // Картинка из скриншота/браузера → File с type image/*; файл, скопированный
  // в Проводнике (Ctrl+C) → File с пустым type. Оба случая — вложения.
  // Вызывается редактором ТОЛЬКО когда в буфере есть File-объекты.
  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length === 0) return // обычный текст — редактор вставит сам
    e.preventDefault()
    void addFilesAsAttachments(files)
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
      const res = await window.syntee.attachments.saveFileFromPath({ chatId: chatId!, sourcePath: fp })
      if (res.success) {
        toAdd.push({
          id: crypto.randomUUID(),
          kind: attachmentKindFromMime(mime),
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
        kind: attachmentKindFromMime(mime),
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
