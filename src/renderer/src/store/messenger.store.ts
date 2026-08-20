import { create } from 'zustand'
import { useToast } from '../components/ui/Toast/Toast'
import { useAuthStore } from './auth.store'

// ── Types (mirror backend schemas) ───────────────────────────────────────
export interface UserBrief {
  id: string
  email: string
  username?: string | null
  display_name?: string | null
  avatar_url?: string | null
}

export interface ReactionOut {
  user_id: string
  emoji: string
}

export interface MessageResponse {
  id: string
  conversation_id: string
  sender_id: string
  message_type: 'text' | 'code' | 'image' | 'file' | 'chat_share'
  body?: string | null
  has_attachment: boolean
  attachment_token?: string | null
  attachment_filename?: string | null
  attachment_mime?: string | null
  attachment_size?: number | null
  reply_to_id?: string | null
  created_at: string
  deleted: boolean
  reactions: ReactionOut[]
}

export interface ConversationResponse {
  id: string
  other_user: UserBrief
  last_message: MessageResponse | null
  last_message_at: string | null
  unread_count: number
  other_online: boolean
  other_typing: boolean
}

export interface FriendRequestRow {
  id: string
  user: UserBrief
  status: string
  direction: 'incoming' | 'outgoing'
}

export interface GlobalMessageResponse {
  id: string
  sender_id: string
  sender: UserBrief | null
  message_type: 'text' | 'code' | 'image' | 'file' | 'chat_share'
  body?: string | null
  has_attachment: boolean
  attachment_token?: string | null
  attachment_filename?: string | null
  attachment_mime?: string | null
  attachment_size?: number | null
  reply_to_id?: string | null
  created_at: string
  deleted: boolean
  reactions: ReactionOut[]
}

export const GLOBAL_CHANNEL = '__global__'

type ConnStatus = 'disconnected' | 'connecting' | 'connected'

interface MsgPage {
  messages: MessageResponse[]
  nextCursor: string | null
  hasMore: boolean
  loading: boolean
}

interface MessengerStore {
  status: ConnStatus
  conversations: ConversationResponse[]
  activeConversationId: string | null
  pages: Record<string, MsgPage>
  friends: UserBrief[]
  friendRequests: FriendRequestRow[]
  presence: Record<string, boolean>
  typing: Record<string, Record<string, number>> // convId -> userId -> timestamp
  searchResults: MessageResponse[]
  searchQuery: string
  initialized: boolean

  // Global Lounge
  globalMessages: GlobalMessageResponse[]
  globalCursor: string | null
  globalHasMore: boolean
  globalLoading: boolean
  globalUnread: number
  globalTyping: Record<string, number> // userId -> timestamp

  init: () => Promise<void>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  refreshAll: () => Promise<void>
  loadConversations: () => Promise<void>
  loadFriends: () => Promise<void>
  openConversation: (id: string | null) => Promise<void>
  loadMore: (conversationId: string) => Promise<void>
  sendMessage: (conversationId: string, payload: {
    message_type?: 'text' | 'code' | 'image' | 'file'
    body?: string | null
    attachment_token?: string | null
    attachment_filename?: string | null
    attachment_mime?: string | null
    attachment_size?: number | null
    reply_to_id?: string | null
  }) => Promise<void>
  sendTyping: (conversationId: string) => void
  markRead: (conversationId: string, messageId: string) => Promise<void>
  toggleReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>
  deleteMessage: (conversationId: string, messageId: string) => Promise<void>
  searchMessages: (q: string, conversationId?: string) => Promise<void>
  handleEvent: (envelope: { type: string; data: Record<string, unknown> }) => void

  // friends mutations
  sendFriendRequest: (username: string) => Promise<void>
  acceptFriendRequest: (userId: string) => Promise<void>
  declineFriendRequest: (userId: string) => Promise<void>
  unfriend: (userId: string) => Promise<void>
  blockUser: (userId: string) => Promise<void>
  startConversationWith: (otherId: string) => Promise<string | null>

  // Global Lounge
  openGlobal: () => Promise<void>
  loadGlobalMore: () => Promise<void>
  sendGlobalMessage: (payload: {
    message_type?: 'text' | 'code' | 'image' | 'file'
    body?: string | null
    attachment_token?: string | null
    attachment_filename?: string | null
    attachment_mime?: string | null
    attachment_size?: number | null
    reply_to_id?: string | null
  }) => Promise<void>
  sendGlobalTyping: () => void
  markGlobalRead: (messageId: string) => Promise<void>
  toggleGlobalReaction: (messageId: string, emoji: string) => Promise<void>
  deleteGlobalMessage: (messageId: string) => Promise<void>
  refreshGlobalUnread: () => Promise<void>
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀']

function upsertMessage(list: MessageResponse[], msg: MessageResponse): MessageResponse[] {
  const idx = list.findIndex(m => m.id === msg.id)
  if (idx === -1) return [...list, msg]
  const next = list.slice()
  next[idx] = msg
  return next
}

const typingTimers: Record<string, NodeJS.Timeout> = {}

// Client-side typing throttle — don't send more than 1 typing WS per 2.5s
const _lastTypingSent: Record<string, number> = {}
const TYPING_THROTTLE_MS = 2500

function _shouldSendTyping(scope: string): boolean {
  const now = Date.now()
  const last = _lastTypingSent[scope] ?? 0
  if (now - last < TYPING_THROTTLE_MS) return false
  _lastTypingSent[scope] = now
  return true
}

export const useMessengerStore = create<MessengerStore>((set, get) => ({
  status: 'disconnected',
  conversations: [],
  activeConversationId: null,
  pages: {},
  friends: [],
  friendRequests: [],
  presence: {},
  typing: {},
  searchResults: [],
  searchQuery: '',
  initialized: false,

  globalMessages: [],
  globalCursor: null,
  globalHasMore: true,
  globalLoading: false,
  globalUnread: 0,
  globalTyping: {},

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })
    window.syntee.messenger.onEvent((env) => {
      void get().handleEvent(env)
    })
    await get().connect()
    await get().refreshAll()
    void get().refreshGlobalUnread()
  },

  connect: async () => {
    set({ status: 'connecting' })
    try {
      await window.syntee.messenger.connect()
    } catch { /* ignore — ws:close will follow */ }
  },

  disconnect: async () => {
    try { await window.syntee.messenger.disconnect() } catch { /* ignore */ }
    set({ status: 'disconnected' })
  },

  refreshAll: async () => {
    await Promise.all([get().loadConversations(), get().loadFriends()])
  },

  loadConversations: async () => {
    try {
      const convs = await window.syntee.messenger.conversations.list()
      const presence: Record<string, boolean> = { ...get().presence }
      for (const c of convs) presence[c.other_user.id] = c.other_online
      set({ conversations: convs, presence })
    } catch { /* ignore */ }
  },

  loadFriends: async () => {
    try {
      const all = await window.syntee.messenger.friends.list()
      const meId = useAuthStore.getState().user?.id
      set({ friends: meId ? all.filter((f) => f.id !== meId) : all })
    } catch {
      useToast.getState().add('Не удалось загрузить список друзей', 'error')
      set({ friends: [] })
    }
    try {
      const requests = await window.syntee.messenger.friends.requests()
      set({ friendRequests: requests as FriendRequestRow[] })
    } catch {
      /* запросы не критичны */
    }
  },

  openConversation: async (id) => {
    set({ activeConversationId: id })
    await window.syntee.messenger.setActive(id)
    if (id && !get().pages[id]) {
      await get().loadMore(id)
    }
    // clear unread badge on open — mark the latest visible message as read
    if (id) {
      const page = get().pages[id]
      const lastMsg = page?.messages[0]
      if (lastMsg) void get().markRead(id, lastMsg.id)
    }
  },

  loadMore: async (conversationId) => {
    const page = get().pages[conversationId]
    if (page?.loading) return
    if (page && page.messages.length > 0 && !page.hasMore) return
    const isFirstLoad = !page || page.messages.length === 0
    set({
      pages: { ...get().pages, [conversationId]: { messages: page?.messages ?? [], nextCursor: page?.nextCursor ?? null, hasMore: page?.hasMore ?? true, loading: true } },
    })
    try {
      const cursor = isFirstLoad ? undefined : page!.nextCursor ?? undefined
      const res = await window.syntee.messenger.messages.list(conversationId, cursor ?? null, 50)
      const existing = isFirstLoad ? [] : page!.messages
      // server returns newest-first; prepend older
      const merged = [...res.messages, ...existing]
      // dedupe by id (safety net)
      const seen = new Set<string>()
      const messages = merged.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true })
      set({
        pages: {
          ...get().pages,
          [conversationId]: { messages, nextCursor: res.next_cursor, hasMore: res.has_more, loading: false },
        },
      })
    } catch {
      set({
        pages: { ...get().pages, [conversationId]: { messages: page?.messages ?? [], nextCursor: page?.nextCursor ?? null, hasMore: false, loading: false } },
      })
    }
  },

  sendMessage: async (conversationId, payload) => {
    try {
      const msg = await window.syntee.messenger.messages.send(conversationId, payload)
      const page = get().pages[conversationId]
      if (page) {
        set({ pages: { ...get().pages, [conversationId]: { ...page, messages: upsertMessage(page.messages, msg) } } })
      }
      // bump conversation preview + last_message_at
      const convs = get().conversations.map(c => c.id === conversationId
        ? { ...c, last_message: msg, last_message_at: msg.created_at }
        : c)
      set({ conversations: convs })
      // optimistically mark read (we just sent)
      void get().markRead(conversationId, msg.id)
    } catch (err) {
      useToast.getState().add(err instanceof Error ? err.message : 'Не удалось отправить', 'error')
    }
  },

  sendTyping: (conversationId) => {
    if (!_shouldSendTyping(`dm:${conversationId}`)) return
    window.syntee.messenger.wsSend({ type: 'dm.typing', data: { conversation_id: conversationId } })
  },

  markRead: async (conversationId, messageId) => {
    try {
      await window.syntee.messenger.messages.read(conversationId, messageId)
    } catch { /* ignore */ }
    const convs = get().conversations.map(c => c.id === conversationId ? { ...c, unread_count: 0 } : c)
    set({ conversations: convs })
  },

  toggleReaction: async (conversationId, messageId, emoji) => {
    try {
      await window.syntee.messenger.messages.react(conversationId, messageId, emoji)
      // WS dm.reaction will apply the change; no local mutation needed.
    } catch { /* ignore */ }
  },

  deleteMessage: async (conversationId, messageId) => {
    try {
      await window.syntee.messenger.messages.delete(conversationId, messageId)
    } catch { /* ignore */ }
  },

  searchMessages: async (q, conversationId) => {
    set({ searchQuery: q })
    if (q.trim().length < 2) { set({ searchResults: [] }); return }
    try {
      const results = await window.syntee.messenger.messages.search(q, conversationId)
      set({ searchResults: results })
    } catch { /* ignore */ }
  },

  handleEvent: (envelope) => {
    const { type, data } = envelope
    if (type === 'ws:open') { set({ status: 'connected' }); return }
    if (type === 'ws:close') { set({ status: 'connecting' }); return }
    if (type === 'hello' || type === 'pong' || type === 'error') return

    if (type === 'presence.update') {
      const uid = String(data.user_id ?? '')
      const online = Boolean(data.online)
      if (uid) {
        set({ presence: { ...get().presence, [uid]: online } })
      }
      return
    }

    if (type === 'dm.message') {
      const msg = data as unknown as MessageResponse
      const page = get().pages[msg.conversation_id]
      if (page) {
        set({ pages: { ...get().pages, [msg.conversation_id]: { ...page, messages: upsertMessage(page.messages, msg) } } })
      }
      // bump conversation preview
      const convs = get().conversations.slice()
      const conv = convs.find(c => c.id === msg.conversation_id)
      const meId = useAuthStore.getState().user?.id
      const isOwnMessage = meId === msg.sender_id
      if (!conv) {
        // new conversation appeared — reload list
        void get().loadConversations()
      } else {
        const updated = { ...conv, last_message: msg, last_message_at: msg.created_at }
        if (get().activeConversationId !== msg.conversation_id && !isOwnMessage) {
          updated.unread_count = (conv.unread_count ?? 0) + 1
        }
        const idx = convs.indexOf(conv)
        convs[idx] = updated
        // move to top
        convs.splice(idx, 1)
        convs.unshift(updated)
        set({ conversations: convs })
      }
      // sound + toast when not the active conversation and not our own message
      if (get().activeConversationId !== msg.conversation_id && !isOwnMessage) {
        import('../utils/sounds').then(({ playActionSound }) => playActionSound('message' as never)).catch(() => {})
        const otherName = conv?.other_user.display_name || conv?.other_user.email || 'Собеседник'
        useToast.getState().add(`${otherName}: ${msg.body ?? '📎 вложение'}`, 'info', 4000)
      } else if (get().activeConversationId === msg.conversation_id) {
        // active conversation → mark read
        void get().markRead(msg.conversation_id, msg.id)
      }
      return
    }

    if (type === 'dm.read') {
      // counterpart read our messages — no state change needed for Phase 1
      return
    }

    if (type === 'dm.typing') {
      const convId = String(data.conversation_id ?? '')
      const userId = String(data.user_id ?? '')
      if (!convId || !userId) return
      const cur = get().typing[convId] ?? {}
      const nextTyping = { ...get().typing, [convId]: { ...cur, [userId]: Date.now() } }
      set({ typing: nextTyping })
      const key = `${convId}:${userId}`
      if (typingTimers[key]) clearTimeout(typingTimers[key])
      typingTimers[key] = setTimeout(() => {
        const t = { ...get().typing[convId] }
        delete t[userId]
        set({ typing: { ...get().typing, [convId]: t } })
      }, 5000)
      return
    }

    if (type === 'dm.reaction') {
      const messageId = String(data.message_id ?? '')
      const convId = String(data.conversation_id ?? '')
      const userId = String(data.user_id ?? '')
      const emoji = String(data.emoji ?? '')
      const action = String(data.action ?? 'added')
      const page = get().pages[convId]
      if (!page) return
      const messages = page.messages.map(m => {
        if (m.id !== messageId) return m
        let reactions = m.reactions.slice()
        if (action === 'removed') {
          reactions = reactions.filter(r => !(r.user_id === userId && r.emoji === emoji))
        } else {
          if (!reactions.some(r => r.user_id === userId && r.emoji === emoji)) {
            reactions.push({ user_id: userId, emoji })
          }
        }
        return { ...m, reactions }
      })
      set({ pages: { ...get().pages, [convId]: { ...page, messages } } })
      return
    }

    if (type === 'dm.delete') {
      const messageId = String(data.message_id ?? '')
      const convId = String(data.conversation_id ?? '')
      const page = get().pages[convId]
      if (!page) return
      const messages = page.messages.map(m => m.id === messageId ? { ...m, deleted: true, body: null, has_attachment: false } : m)
      set({ pages: { ...get().pages, [convId]: { ...page, messages } } })
      return
    }

    if (type === 'friend.request' || type === 'friend.update') {
      void get().loadFriends()
      return
    }

    // ── Global Lounge events ──
    if (type === 'global.message') {
      const msg = data as unknown as GlobalMessageResponse
      const existing = get().globalMessages
      const idx = existing.findIndex(m => m.id === msg.id)
      if (idx === -1) {
        set({ globalMessages: [...existing, msg] })
      } else {
        const next = existing.slice()
        next[idx] = msg
        set({ globalMessages: next })
      }
      if (get().activeConversationId === GLOBAL_CHANNEL) {
        void get().markGlobalRead(msg.id)
      } else {
        set({ globalUnread: get().globalUnread + 1 })
        import('../utils/sounds').then(({ playActionSound }) => playActionSound('message' as never)).catch(() => {})
        const senderName = msg.sender?.display_name || msg.sender?.email || 'Пользователь'
        useToast.getState().add(`${senderName}: ${msg.body ?? '📎 вложение'}`, 'info', 4000)
      }
      return
    }

    if (type === 'global.reaction') {
      const messageId = String(data.message_id ?? '')
      const userId = String(data.user_id ?? '')
      const emoji = String(data.emoji ?? '')
      const action = String(data.action ?? 'added')
      const messages = get().globalMessages.map(m => {
        if (m.id !== messageId) return m
        let reactions = m.reactions.slice()
        if (action === 'removed') {
          reactions = reactions.filter(r => !(r.user_id === userId && r.emoji === emoji))
        } else {
          if (!reactions.some(r => r.user_id === userId && r.emoji === emoji)) {
            reactions.push({ user_id: userId, emoji })
          }
        }
        return { ...m, reactions }
      })
      set({ globalMessages: messages })
      return
    }

    if (type === 'global.delete') {
      const messageId = String(data.message_id ?? '')
      const messages = get().globalMessages.map(m =>
        m.id === messageId ? { ...m, deleted: true, body: null, has_attachment: false } : m
      )
      set({ globalMessages: messages })
      return
    }

    if (type === 'global.typing') {
      const userId = String(data.user_id ?? '')
      if (!userId) return
      set({ globalTyping: { ...get().globalTyping, [userId]: Date.now() } })
      const key = `global:${userId}`
      if (typingTimers[key]) clearTimeout(typingTimers[key])
      typingTimers[key] = setTimeout(() => {
        const t = { ...get().globalTyping }
        delete t[userId]
        set({ globalTyping: t })
      }, 5000)
      return
    }
  },

  sendFriendRequest: async (username) => {
    try {
      await window.syntee.messenger.friends.request(username)
      useToast.getState().add('Заявка отправлена', 'success')
      await get().loadFriends()
    } catch (err) {
      useToast.getState().add(err instanceof Error ? err.message : 'Ошибка', 'error')
    }
  },

  acceptFriendRequest: async (userId) => {
    try {
      await window.syntee.messenger.friends.accept(userId)
      useToast.getState().add('Друг добавлен', 'success')
      await get().loadFriends()
      await get().loadConversations()
    } catch (err) {
      useToast.getState().add(err instanceof Error ? err.message : 'Ошибка', 'error')
    }
  },

  declineFriendRequest: async (userId) => {
    try {
      await window.syntee.messenger.friends.decline(userId)
      await get().loadFriends()
    } catch { /* ignore */ }
  },

  unfriend: async (userId) => {
    try {
      await window.syntee.messenger.friends.unfriend(userId)
      useToast.getState().add('Удалён из друзей', 'info')
      await get().loadFriends()
      await get().loadConversations()
    } catch { /* ignore */ }
  },

  blockUser: async (userId) => {
    try {
      await window.syntee.messenger.friends.block(userId)
      useToast.getState().add('Пользователь заблокирован', 'info')
      await get().loadFriends()
      await get().loadConversations()
    } catch { /* ignore */ }
  },

  startConversationWith: async (otherId) => {
    try {
      const conv = await window.syntee.messenger.conversations.create(otherId)
      // ensure it's in the list
      const exists = get().conversations.some(c => c.id === conv.id)
      if (!exists) set({ conversations: [conv, ...get().conversations] })
      await get().openConversation(conv.id)
      return conv.id
    } catch (err) {
      useToast.getState().add(err instanceof Error ? err.message : 'Ошибка', 'error')
      return null
    }
  },

  // ── Global Lounge ──
  openGlobal: async () => {
    set({ activeConversationId: GLOBAL_CHANNEL })
    await window.syntee.messenger.setActive(GLOBAL_CHANNEL)
    if (get().globalMessages.length === 0) {
      await get().loadGlobalMore()
    } else {
      // mark latest as read
      const latest = get().globalMessages[0]
      if (latest) void get().markGlobalRead(latest.id)
    }
  },

  loadGlobalMore: async () => {
    if (get().globalLoading) return
    if (!get().globalHasMore && get().globalMessages.length > 0) return
    set({ globalLoading: true })
    try {
      const cursor = get().globalMessages.length > 0 ? get().globalCursor : undefined
      const res = await window.syntee.messenger.global.list(cursor ?? null, 50)
      const existing = cursor ? get().globalMessages : []
      const merged = [...res.messages, ...existing]
      const seen = new Set<string>()
      const messages = merged.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true })
      set({
        globalMessages: messages,
        globalCursor: res.next_cursor,
        globalHasMore: res.has_more,
        globalLoading: false,
      })
    } catch {
      set({ globalLoading: false, globalHasMore: false })
    }
  },

  sendGlobalMessage: async (payload) => {
    try {
      const msg = await window.syntee.messenger.global.send(payload)
      const existing = get().globalMessages
      const idx = existing.findIndex(m => m.id === msg.id)
      if (idx === -1) {
        set({ globalMessages: [...existing, msg] })
      } else {
        const next = existing.slice()
        next[idx] = msg
        set({ globalMessages: next })
      }
      void get().markGlobalRead(msg.id)
    } catch (err) {
      useToast.getState().add(err instanceof Error ? err.message : 'Не удалось отправить', 'error')
    }
  },

  sendGlobalTyping: () => {
    if (!_shouldSendTyping('global')) return
    window.syntee.messenger.wsSend({ type: 'global.typing', data: {} })
  },

  markGlobalRead: async (messageId) => {
    try {
      await window.syntee.messenger.global.read(messageId)
      set({ globalUnread: 0 })
    } catch { /* ignore */ }
  },

  toggleGlobalReaction: async (messageId, emoji) => {
    try {
      await window.syntee.messenger.global.react(messageId, emoji)
    } catch { /* ignore */ }
  },

  deleteGlobalMessage: async (messageId) => {
    try {
      await window.syntee.messenger.global.delete(messageId)
    } catch { /* ignore */ }
  },

  refreshGlobalUnread: async () => {
    try {
      const count = await window.syntee.messenger.global.unread()
      set({ globalUnread: count })
    } catch { /* ignore */ }
  },
}))

export { QUICK_EMOJIS }
