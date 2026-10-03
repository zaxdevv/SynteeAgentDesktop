import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Identicon from '../Identicon/Identicon'
import AppIcon from '../AppIcon/AppIcon'
import { useMessengerStore, type MessageResponse, type GlobalMessageResponse, QUICK_EMOJIS, GLOBAL_CHANNEL } from '../../../store/messenger.store'
import { useAuthStore } from '../../../store/auth.store'
import { useChatStore } from '../../../store/chat.store'
import { useNavStore } from '../../../store/nav.store'
import { indexById } from '../../../utils/messageWindow'
import VirtualMessageList from '../VirtualMessageList/VirtualMessageList'

const EMPTY_MESSAGES: MessageResponse[] = []
import './MessengerConversation.css'

export default function MessengerConversation() {
  const activeId = useMessengerStore(s => s.activeConversationId)
  const conversations = useMessengerStore(s => s.conversations)

  if (activeId === GLOBAL_CHANNEL) {
    return <GlobalConversationBody />
  }

  const conv = conversations.find(c => c.id === activeId) ?? null

  if (!conv) {
    return (
      <div className="msgr-conv-empty">
        <AppIcon name="messageSquare" size="xl" tone="muted" />
        <p>Выберите диалог, чтобы начать общение</p>
      </div>
    )
  }
  return <ConversationBody convId={conv.id} otherUserId={conv.other_user.id} otherName={conv.other_user.username ? `@${conv.other_user.username}` : conv.other_user.display_name || conv.other_user.email} otherAvatar={conv.other_user.avatar_url} otherEmail={conv.other_user.email} />
}

interface BodyProps {
  convId: string
  otherUserId: string
  otherName: string
  otherEmail: string
  otherAvatar: string | null | undefined
}

function ConversationBody({ convId, otherUserId, otherName, otherAvatar, otherEmail }: BodyProps) {
  const page = useMessengerStore(s => s.pages[convId])
  const loadMore = useMessengerStore(s => s.loadMore)
  const sendMessage = useMessengerStore(s => s.sendMessage)
  const sendTyping = useMessengerStore(s => s.sendTyping)
  const toggleReaction = useMessengerStore(s => s.toggleReaction)
  const deleteMessage = useMessengerStore(s => s.deleteMessage)
  // Узкие селекторы: раньше подписка на весь presence/typing-словарь →
  // любой чужой typing/presence ре-рендерил весь диалог со списком. Теперь —
  // только примитивы для ЭТОГО собеседника/диалога.
  const online = useMessengerStore(s => s.presence[otherUserId] ?? false)
  const otherTyping = useMessengerStore(s => Boolean(s.typing[convId]?.[otherUserId]))
  const me = useAuthStore(s => s.user)

  const [text, setText] = useState('')
  const [codeMode, setCodeMode] = useState(false)
  const [replyTo, setReplyTo] = useState<MessageResponse | null>(null)
  const [pendingFile, setPendingFile] = useState<{ token: string; filename: string; mime: string; size: number; isImage: boolean } | null>(null)
  const [uploading, setUploading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const messages = page?.messages ?? EMPTY_MESSAGES

  // initial load — only if not already loaded (openConversation handles first open)
  useEffect(() => {
    const p = useMessengerStore.getState().pages[convId]
    if (!p || p.messages.length === 0) {
      void loadMore(convId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId])

  // stick to bottom on new messages
  useEffect(() => {
    if (stickToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 40 && page?.hasMore && !page.loading) {
      void loadMore(convId)
    }
  }

  const handleSend = async () => {
    const body = text.trim()
    if (!body && !pendingFile) return
    if (pendingFile) {
      await sendMessage(convId, {
        message_type: pendingFile.isImage ? 'image' : 'file',
        body: body || null,
        attachment_token: pendingFile.token,
        attachment_filename: pendingFile.filename,
        attachment_mime: pendingFile.mime,
        attachment_size: pendingFile.size,
        reply_to_id: replyTo?.id ?? null,
      })
    } else {
      await sendMessage(convId, {
        message_type: codeMode ? 'code' : 'text',
        body,
        reply_to_id: replyTo?.id ?? null,
      })
    }
    setText('')
    setCodeMode(false)
    setReplyTo(null)
    setPendingFile(null)
    stickToBottom.current = true
  }

  const handleFile = async (file: File) => {
    setUploading(true)
    try {
      const res = await window.syntee.messenger.attachments.upload(file)
      setPendingFile({ ...res, isImage: res.mime.startsWith('image/') })
    } catch (err) {
      import('../../../components/ui/Toast/Toast').then(({ useToast }) =>
        useToast.getState().add(err instanceof Error ? err.message : 'Ошибка загрузки', 'error'))
    } finally {
      setUploading(false)
    }
  }

  const onType = (v: string) => {
    setText(v)
    sendTyping(convId)
  }

  const display = useMemo(() => messages.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)), [messages])
  // id → сообщение: убирает O(n²) (display.find на каждый reply) на один O(n)-индекс.
  const byId = useMemo(() => indexById(display), [display])
  // Стабильные колбэки: MsgrRow мемоизирован → пере-рендер родителя
  // (смена presence/typing, отправка и т.п.) НЕ ре-рендерит неизменные строки.
  const handleReply = useCallback((m: MessageResponse) => setReplyTo(m), [])
  const handleReact = useCallback((cId: string, id: string, emoji: string) => { void toggleReaction(cId, id, emoji) }, [toggleReaction])
  const handleDelete = useCallback((cId: string, id: string) => { void deleteMessage(cId, id) }, [deleteMessage])
  const meId = me?.id

  return (
    <div className="msgr-conv">
      <div className="msgr-conv-header">
        <div className="msgr-conv-header-avatar">
          <Identicon seed={otherUserId || otherEmail} src={otherAvatar} size={32} alt={otherName} />
          <span className={`msgr-online-dot ${online ? 'msgr-online-dot--on' : ''}`} />
        </div>
        <div className="msgr-conv-header-info">
          <span className="msgr-conv-header-name">{otherName}</span>
          <span className="msgr-conv-header-status">
            {otherTyping ? 'печатает…' : online ? 'в сети' : 'не в сети'}
          </span>
        </div>
      </div>

      <div className="msgr-msg-list" ref={scrollRef} onScroll={handleScroll}>
        {page?.loading && <div className="msgr-msg-loading">Загрузка…</div>}
        {display.length === 0 && !page?.loading && (
          <div className="msgr-msg-empty">Нет сообщений. Напишите первым!</div>
        )}
        <VirtualMessageList items={display} scrollRef={scrollRef} pinnedRef={stickToBottom}
          scope={convId} gap={8} estimatedSize={80} renderItem={m => (
          <MsgrRow
            key={m.id}
            msg={m}
            mine={m.sender_id === meId}
            convId={convId}
            replyTarget={m.reply_to_id ? byId.get(m.reply_to_id) ?? null : null}
            onReply={handleReply}
            onReact={handleReact}
            onDelete={handleDelete}
          />
        )} />
      </div>

      {replyTo && (
        <div className="msgr-reply-bar">
          <AppIcon name="reply" size="sm" tone="muted" />
          <span className="msgr-reply-text">{replyTo.body || '📎 вложение'}</span>
          <button className="msgr-reply-close" onClick={() => setReplyTo(null)}>✕</button>
        </div>
      )}

      {pendingFile && (
        <div className="msgr-reply-bar">
          <AppIcon name="paperclip" size="sm" tone="muted" />
          <span className="msgr-reply-text">{pendingFile.filename}</span>
          <button className="msgr-reply-close" onClick={() => setPendingFile(null)}>✕</button>
        </div>
      )}

      <div className="msgr-input-bar">
        <label className="msgr-input-attach" title="Прикрепить файл">
          <AppIcon name="paperclip" size="sm" tone="muted" />
          <input
            type="file"
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.currentTarget.value = '' }}
          />
        </label>
        <button
          className={`msgr-input-code ${codeMode ? 'msgr-input-code--on' : ''}`}
          title="Режим кода"
          onClick={() => setCodeMode(v => !v)}
        >
          <AppIcon name="code" size="sm" />
        </button>
        {codeMode ? (
          <textarea
            className="msgr-input msgr-input--code"
            placeholder="Блок кода…"
            value={text}
            onChange={e => onType(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void handleSend() } }}
            rows={2}
          />
        ) : (
          <input
            className="msgr-input"
            type="text"
            placeholder="Сообщение…"
            value={text}
            onChange={e => onType(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend() } }}
          />
        )}
        <button className="msgr-send-btn" onClick={() => void handleSend()} disabled={(!text.trim() && !pendingFile) || uploading}>
          <AppIcon name="send" size="sm" />
        </button>
      </div>
    </div>
  )
}

// ── Global Lounge conversation ─────────────────────────────────────────────

function GlobalConversationBody() {
  const messages = useMessengerStore(s => s.globalMessages)
  const hasMore = useMessengerStore(s => s.globalHasMore)
  const loading = useMessengerStore(s => s.globalLoading)
  const loadMore = useMessengerStore(s => s.loadGlobalMore)
  const sendMessage = useMessengerStore(s => s.sendGlobalMessage)
  const sendTyping = useMessengerStore(s => s.sendGlobalTyping)
  const toggleReaction = useMessengerStore(s => s.toggleGlobalReaction)
  const deleteMessage = useMessengerStore(s => s.deleteGlobalMessage)
  const globalTyping = useMessengerStore(s => s.globalTyping)
  const me = useAuthStore(s => s.user)

  const [text, setText] = useState('')
  const [codeMode, setCodeMode] = useState(false)
  const [replyTo, setReplyTo] = useState<GlobalMessageResponse | null>(null)
  const [pendingFile, setPendingFile] = useState<{ token: string; filename: string; mime: string; size: number; isImage: boolean } | null>(null)
  const [uploading, setUploading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const typingUsers = Object.keys(globalTyping).filter(uid => uid !== me?.id)
  const typingLabel = typingUsers.length === 0
    ? ''
    : typingUsers.length === 1
      ? '1 человек печатает…'
      : `${typingUsers.length} человек печатают…`

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 40 && hasMore && !loading) {
      void loadMore()
    }
  }

  useEffect(() => {
    if (stickToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length])

  const handleSend = async () => {
    const body = text.trim()
    if (!body && !pendingFile) return
    if (pendingFile) {
      await sendMessage({
        message_type: pendingFile.isImage ? 'image' : 'file',
        body: body || null,
        attachment_token: pendingFile.token,
        attachment_filename: pendingFile.filename,
        attachment_mime: pendingFile.mime,
        attachment_size: pendingFile.size,
        reply_to_id: replyTo?.id ?? null,
      })
    } else {
      await sendMessage({
        message_type: codeMode ? 'code' : 'text',
        body,
        reply_to_id: replyTo?.id ?? null,
      })
    }
    setText('')
    setCodeMode(false)
    setReplyTo(null)
    setPendingFile(null)
    stickToBottom.current = true
  }

  const handleFile = async (file: File) => {
    setUploading(true)
    try {
      const res = await window.syntee.messenger.attachments.upload(file)
      setPendingFile({ ...res, isImage: res.mime.startsWith('image/') })
    } catch (err) {
      import('../../../components/ui/Toast/Toast').then(({ useToast }) =>
        useToast.getState().add(err instanceof Error ? err.message : 'Ошибка загрузки', 'error'))
    } finally {
      setUploading(false)
    }
  }

  const onType = (v: string) => {
    setText(v)
    sendTyping()
  }

  const display = useMemo(() => messages.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)), [messages])
  // id → сообщение: убирает O(n²) (display.find на каждый reply).
  const byId = useMemo(() => indexById(display), [display])
  const handleReply = useCallback((m: GlobalMessageResponse) => setReplyTo(m), [])
  const handleReact = useCallback((id: string, emoji: string) => { void toggleReaction(id, emoji) }, [toggleReaction])
  const handleDelete = useCallback((id: string) => { void deleteMessage(id) }, [deleteMessage])
  const meId = me?.id

  return (
    <div className="msgr-conv">
      <div className="msgr-conv-header">
        <div className="msgr-conv-header-avatar">
          <div className="msgr-lounge-icon">
            <AppIcon name="messageSquare" size="sm" tone="accent" />
          </div>
        </div>
        <div className="msgr-conv-header-info">
          <span className="msgr-conv-header-name">Общий чат</span>
          <span className="msgr-conv-header-status">
            {typingLabel || 'Lounge — для всех пользователей'}
          </span>
        </div>
      </div>

      <div className="msgr-msg-list" ref={scrollRef} onScroll={handleScroll}>
        {loading && <div className="msgr-msg-loading">Загрузка…</div>}
        {display.length === 0 && !loading && (
          <div className="msgr-msg-empty">Общий чат пуст. Будьте первым!</div>
        )}
        <VirtualMessageList items={display} scrollRef={scrollRef} pinnedRef={stickToBottom}
          scope={GLOBAL_CHANNEL} gap={8} estimatedSize={90} renderItem={m => (
          <GlobalRow
            key={m.id}
            msg={m}
            mine={m.sender_id === meId}
            replyTarget={m.reply_to_id ? byId.get(m.reply_to_id) ?? null : null}
            onReply={handleReply}
            onReact={handleReact}
            onDelete={handleDelete}
          />
        )} />
      </div>

      {replyTo && (
        <div className="msgr-reply-bar">
          <AppIcon name="reply" size="sm" tone="muted" />
          <span className="msgr-reply-text">{replyTo.body || '📎 вложение'}</span>
          <button className="msgr-reply-close" onClick={() => setReplyTo(null)}>✕</button>
        </div>
      )}

      {pendingFile && (
        <div className="msgr-reply-bar">
          <AppIcon name="paperclip" size="sm" tone="muted" />
          <span className="msgr-reply-text">{pendingFile.filename}</span>
          <button className="msgr-reply-close" onClick={() => setPendingFile(null)}>✕</button>
        </div>
      )}

      <div className="msgr-input-bar">
        <label className="msgr-input-attach" title="Прикрепить файл">
          <AppIcon name="paperclip" size="sm" tone="muted" />
          <input
            type="file"
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.currentTarget.value = '' }}
          />
        </label>
        <button
          className={`msgr-input-code ${codeMode ? 'msgr-input-code--on' : ''}`}
          title="Режим кода"
          onClick={() => setCodeMode(v => !v)}
        >
          <AppIcon name="code" size="sm" />
        </button>
        {codeMode ? (
          <textarea
            className="msgr-input msgr-input--code"
            placeholder="Блок кода…"
            value={text}
            onChange={e => onType(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void handleSend() } }}
            rows={2}
          />
        ) : (
          <input
            className="msgr-input"
            type="text"
            placeholder="Сообщение в общий чат…"
            value={text}
            onChange={e => onType(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend() } }}
          />
        )}
        <button className="msgr-send-btn" onClick={() => void handleSend()} disabled={(!text.trim() && !pendingFile) || uploading}>
          <AppIcon name="send" size="sm" />
        </button>
      </div>
    </div>
  )
}

// Мемоизированная строка общего чата — тот же приём, что и MsgrRow.
const GlobalRow = memo(function GlobalRow({
  msg, mine, replyTarget, onReply, onReact, onDelete,
}: {
  msg: GlobalMessageResponse
  mine: boolean
  replyTarget: GlobalMessageResponse | null
  onReply: (m: GlobalMessageResponse) => void
  onReact: (id: string, emoji: string) => void
  onDelete: (id: string) => void
}) {
  const handleReply = useCallback(() => onReply(msg), [onReply, msg])
  const handleReact = useCallback((emoji: string) => onReact(msg.id, emoji), [onReact, msg.id])
  const handleDelete = useCallback(() => onDelete(msg.id), [onDelete, msg.id])
  return (
    <GlobalMessageBubble
      msg={msg}
      mine={mine}
      onReply={handleReply}
      onReact={handleReact}
      onDelete={handleDelete}
      replyTarget={replyTarget}
    />
  )
})

const GlobalMessageBubble = memo(function GlobalMessageBubble({
  msg, mine, onReply, onReact, onDelete, replyTarget,
}: {
  msg: GlobalMessageResponse
  mine: boolean
  onReply: () => void
  onReact: (emoji: string) => void
  onDelete: () => void
  replyTarget: GlobalMessageResponse | null
}) {
  const [showPicker, setShowPicker] = useState(false)
  const senderName = msg.sender
    ? (msg.sender.username ? `@${msg.sender.username}` : msg.sender.display_name || msg.sender.email)
    : 'Пользователь'
  return (
    <div className={`msgr-msg ${mine ? 'msgr-msg--mine' : ''}`} data-id={msg.id}>
      {!mine && msg.sender && (
        <div className="msgr-msg-sender">
          <Identicon seed={msg.sender.id || msg.sender.email} src={msg.sender.avatar_url} size={20} alt={senderName} />
          <span className="msgr-msg-sender-name">{senderName}</span>
        </div>
      )}
      <div className="msgr-msg-content" onDoubleClick={onReply}>
        {replyTarget && (
          <div className="msgr-msg-reply">
            <AppIcon name="reply" size="xs" tone="muted" />
            <span>{replyTarget.body || '📎 вложение'}</span>
          </div>
        )}
        {msg.deleted ? (
          <span className="msgr-msg-deleted">сообщение удалено</span>
        ) : msg.message_type === 'chat_share' ? (
          <GlobalChatShareCard msg={msg} />
        ) : (
          <>
            {msg.body && msg.message_type === 'code' ? (
              <pre className="msgr-msg-code">{msg.body}</pre>
            ) : msg.body ? (
              <span className="msgr-msg-text">{msg.body}</span>
            ) : null}
            {msg.has_attachment && <GlobalAttachmentView msg={msg} />}
          </>
        )}
        <span className="msgr-msg-time">{formatTime(msg.created_at)}</span>
      </div>
      <div className="msgr-msg-actions">
        <button className="msgr-msg-action" title="Ответить" onClick={onReply}><AppIcon name="reply" size="xs" /></button>
        <button className="msgr-msg-action" title="Реакция" onClick={() => setShowPicker(v => !v)}><AppIcon name="smile" size="xs" /></button>
        {mine && <button className="msgr-msg-action msgr-msg-action--danger" title="Удалить" onClick={onDelete}><AppIcon name="trash" size="xs" /></button>}
      </div>
      {showPicker && (
        <div className="msgr-reaction-picker">
          {QUICK_EMOJIS.map(e => (
            <button key={e} className="msgr-reaction-emoji" onClick={() => { onReact(e); setShowPicker(false) }}>{e}</button>
          ))}
        </div>
      )}
      {msg.reactions.length > 0 && (
        <div className="msgr-reactions">
          {groupByEmoji(msg.reactions).map(({ emoji, count, mine: hasMine }) => (
            <button key={emoji} className={`msgr-reaction-chip ${hasMine ? 'msgr-reaction-chip--mine' : ''}`} onClick={() => onReact(emoji)}>
              {emoji} <span>{count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

function GlobalAttachmentView({ msg }: { msg: GlobalMessageResponse }) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let revoked = false
    let blobUrl: string | null = null
    setLoading(true)
    window.syntee.messenger.global.fetchAttachment(msg.id).then((buf: ArrayBuffer) => {
      if (revoked) return
      const blob = new Blob([buf], { type: msg.attachment_mime || 'application/octet-stream' })
      blobUrl = URL.createObjectURL(blob)
      setUrl(blobUrl)
    }).catch(() => { /* ignore */ }).finally(() => setLoading(false))
    return () => { revoked = true; if (blobUrl) URL.revokeObjectURL(blobUrl) }
  }, [msg.id, msg.attachment_mime])

  const isImage = msg.attachment_mime?.startsWith('image/')
  const name = msg.attachment_filename || 'Вложение'
  if (loading) return <div className="msgr-attachment msgr-attachment--loading">Загрузка…</div>
  if (isImage && url) {
    return <img className="msgr-attachment-img" src={url} alt={name} />
  }
  return (
    <a className="msgr-attachment" href={url ?? '#'} download={name}>
      <AppIcon name="paperclip" size="sm" />
      <span className="msgr-attachment-name">{name}</span>
      {msg.attachment_size != null && <span className="msgr-attachment-size">{formatSize(msg.attachment_size)}</span>}
    </a>
  )
}

function GlobalChatShareCard({ msg }: { msg: GlobalMessageResponse }) {
  const me = useAuthStore(s => s.user)
  const openChat = useChatStore(s => s.setCurrentChat)
  const [imported, setImported] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importedChatId, setImportedChatId] = useState<string | null>(null)
  const shareId = msg.attachment_token ?? null
  const title = msg.attachment_filename ?? 'Чат'
  const count = msg.attachment_size ?? 0
  const isMine = msg.sender_id === me?.id

  const handleImport = async () => {
    if (!shareId) return
    setImporting(true)
    try {
      const res = await window.syntee.messenger.shares.importShare(shareId)
      if ('error' in res) {
        import('../../../components/ui/Toast/Toast').then(({ useToast }) =>
          useToast.getState().add(res.error, 'error'))
      } else {
        setImported(true)
        setImportedChatId(res.chatId)
        import('../../../components/ui/Toast/Toast').then(({ useToast }) =>
          useToast.getState().add(`Чат «${res.title}» импортирован`, 'success'))
      }
    } finally {
      setImporting(false)
    }
  }

  const handleOpenImported = () => {
    if (importedChatId) {
      openChat(importedChatId)
      useNavStore.getState().setMainPage('chat')
    }
  }

  return (
    <div className="msgr-chat-share">
      <div className="msgr-chat-share-icon">
        <AppIcon name="messageSquare" size="md" tone="accent" />
      </div>
      <div className="msgr-chat-share-body">
        <span className="msgr-chat-share-title">{title}</span>
        <span className="msgr-chat-share-meta">{count} {pluralize(count, 'сообщение', 'сообщения', 'сообщений')}</span>
      </div>
      <div className="msgr-chat-share-actions">
        {isMine ? (
          <span className="msgr-chat-share-sent">Отправлен</span>
        ) : imported ? (
          <button className="msgr-chat-share-btn msgr-chat-share-btn--open" onClick={handleOpenImported}>
            Открыть
          </button>
        ) : (
          <button
            className="msgr-chat-share-btn msgr-chat-share-btn--import"
            disabled={importing}
            onClick={() => void handleImport()}
          >
            {importing ? 'Импорт…' : 'Импорт'}
          </button>
        )}
      </div>
    </div>
  )
}

// Мемоизированная строка диалога: стабильные колбэки (onReply/onReact/onDelete)
// + мемо по msg → при пере-рендере родителя перерисовываются только реально
// изменившиеся сообщения (например, пришла реакция/правка одного).
const MsgrRow = memo(function MsgrRow({
  msg, mine, convId, replyTarget, onReply, onReact, onDelete,
}: {
  msg: MessageResponse
  mine: boolean
  convId: string
  replyTarget: MessageResponse | null
  onReply: (m: MessageResponse) => void
  onReact: (convId: string, id: string, emoji: string) => void
  onDelete: (convId: string, id: string) => void
}) {
  const handleReply = useCallback(() => onReply(msg), [onReply, msg])
  const handleReact = useCallback((emoji: string) => onReact(convId, msg.id, emoji), [onReact, convId, msg.id])
  const handleDelete = useCallback(() => onDelete(convId, msg.id), [onDelete, convId, msg.id])
  return (
    <MessageBubble
      msg={msg}
      mine={mine}
      onReply={handleReply}
      onReact={handleReact}
      onDelete={handleDelete}
      replyTarget={replyTarget}
    />
  )
})

const MessageBubble = memo(function MessageBubble({
  msg, mine, onReply, onReact, onDelete, replyTarget,
}: {
  msg: MessageResponse
  mine: boolean
  onReply: () => void
  onReact: (emoji: string) => void
  onDelete: () => void
  replyTarget: MessageResponse | null
}) {
  const [showPicker, setShowPicker] = useState(false)
  return (
    <div className={`msgr-msg ${mine ? 'msgr-msg--mine' : ''}`} data-id={msg.id}>
      <div className="msgr-msg-content" onDoubleClick={onReply}>
        {replyTarget && (
          <div className="msgr-msg-reply">
            <AppIcon name="reply" size="xs" tone="muted" />
            <span>{replyTarget.body || '📎 вложение'}</span>
          </div>
        )}
        {msg.deleted ? (
          <span className="msgr-msg-deleted">сообщение удалено</span>
        ) : msg.message_type === 'chat_share' ? (
          <ChatShareCard msg={msg} />
        ) : (
          <>
            {msg.body && msg.message_type === 'code' ? (
              <pre className="msgr-msg-code">{msg.body}</pre>
            ) : msg.body ? (
              <span className="msgr-msg-text">{msg.body}</span>
            ) : null}
            {msg.has_attachment && <AttachmentView msg={msg} />}
          </>
        )}
        <span className="msgr-msg-time">{formatTime(msg.created_at)}</span>
      </div>
      <div className="msgr-msg-actions">
        <button className="msgr-msg-action" title="Ответить" onClick={onReply}><AppIcon name="reply" size="xs" /></button>
        <button className="msgr-msg-action" title="Реакция" onClick={() => setShowPicker(v => !v)}><AppIcon name="smile" size="xs" /></button>
        {mine && <button className="msgr-msg-action msgr-msg-action--danger" title="Удалить" onClick={onDelete}><AppIcon name="trash" size="xs" /></button>}
      </div>
      {showPicker && (
        <div className="msgr-reaction-picker">
          {QUICK_EMOJIS.map(e => (
            <button key={e} className="msgr-reaction-emoji" onClick={() => { onReact(e); setShowPicker(false) }}>{e}</button>
          ))}
        </div>
      )}
      {msg.reactions.length > 0 && (
        <div className="msgr-reactions">
          {groupByEmoji(msg.reactions).map(({ emoji, count, mine: hasMine }) => (
            <button key={emoji} className={`msgr-reaction-chip ${hasMine ? 'msgr-reaction-chip--mine' : ''}`} onClick={() => onReact(emoji)}>
              {emoji} <span>{count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

function AttachmentView({ msg }: { msg: MessageResponse }) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let revoked = false
    let blobUrl: string | null = null
    setLoading(true)
    window.syntee.messenger.attachments.fetch(msg.conversation_id, msg.id).then((buf: ArrayBuffer) => {
      if (revoked) return
      const blob = new Blob([buf], { type: msg.attachment_mime || 'application/octet-stream' })
      blobUrl = URL.createObjectURL(blob)
      setUrl(blobUrl)
    }).catch(() => { /* ignore */ }).finally(() => setLoading(false))
    return () => { revoked = true; if (blobUrl) URL.revokeObjectURL(blobUrl) }
  }, [msg.id, msg.conversation_id, msg.attachment_mime])

  const isImage = msg.attachment_mime?.startsWith('image/')
  const name = msg.attachment_filename || 'Вложение'
  if (loading) return <div className="msgr-attachment msgr-attachment--loading">Загрузка…</div>
  if (isImage && url) {
    return <img className="msgr-attachment-img" src={url} alt={name} />
  }
  return (
    <a className="msgr-attachment" href={url ?? '#'} download={name}>
      <AppIcon name="paperclip" size="sm" />
      <span className="msgr-attachment-name">{name}</span>
      {msg.attachment_size != null && <span className="msgr-attachment-size">{formatSize(msg.attachment_size)}</span>}
    </a>
   )
}

function ChatShareCard({ msg }: { msg: MessageResponse }) {
  const me = useAuthStore(s => s.user)
  const openChat = useChatStore(s => s.setCurrentChat)
  const [imported, setImported] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importedChatId, setImportedChatId] = useState<string | null>(null)
  const shareId = msg.attachment_token ?? null
  const title = msg.attachment_filename ?? 'Чат'
  const count = msg.attachment_size ?? 0
  const isMine = msg.sender_id === me?.id

  const handleImport = async () => {
    if (!shareId) return
    setImporting(true)
    try {
      const res = await window.syntee.messenger.shares.importShare(shareId)
      if ('error' in res) {
        import('../../../components/ui/Toast/Toast').then(({ useToast }) =>
          useToast.getState().add(res.error, 'error'))
      } else {
        setImported(true)
        setImportedChatId(res.chatId)
        import('../../../components/ui/Toast/Toast').then(({ useToast }) =>
          useToast.getState().add(`Чат «${res.title}» импортирован`, 'success'))
      }
    } finally {
      setImporting(false)
    }
  }

  const handleOpenImported = () => {
    if (importedChatId) {
      openChat(importedChatId)
      // Switch to chat page
      useNavStore.getState().setMainPage('chat')
    }
  }

  return (
    <div className="msgr-chat-share">
      <div className="msgr-chat-share-icon">
        <AppIcon name="messageSquare" size="md" tone="accent" />
      </div>
      <div className="msgr-chat-share-body">
        <span className="msgr-chat-share-title">{title}</span>
        <span className="msgr-chat-share-meta">{count} {pluralize(count, 'сообщение', 'сообщения', 'сообщений')}</span>
      </div>
      <div className="msgr-chat-share-actions">
        {isMine ? (
          <span className="msgr-chat-share-sent">Отправлен</span>
        ) : imported ? (
          <button className="msgr-chat-share-btn msgr-chat-share-btn--open" onClick={handleOpenImported}>
            Открыть
          </button>
        ) : (
          <button
            className="msgr-chat-share-btn msgr-chat-share-btn--import"
            disabled={importing}
            onClick={() => void handleImport()}
          >
            {importing ? 'Импорт…' : 'Импорт'}
          </button>
        )}
      </div>
    </div>
  )
}

function pluralize(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

function groupByEmoji(reactions: { user_id: string; emoji: string }[]) {
  const me = useAuthStore.getState().user?.id
  const map = new Map<string, { emoji: string; count: number; mine: boolean }>()
  for (const r of reactions) {
    const e = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false }
    e.count += 1
    if (r.user_id === me) e.mine = true
    map.set(r.emoji, e)
  }
  return [...map.values()]
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
