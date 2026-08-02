import { create } from 'zustand'
import { useChatStore } from './chat.store'

// ── Вкладки открытых чатов в шапке (как в браузере) ────────────────────
// openTabIds — порядок вкладок слева направо. Вкладка ≠ чат: закрытие
// вкладки НЕ удаляет чат (он остаётся в сайдбаре). Состав и порядок
// персистятся в electron-store ('openChatTabs') и восстанавливаются при
// запуске (preload в App.tsx). Активная вкладка персистится ChatPage
// в 'activeChatTab' при каждой смене currentChatId.

const SETTINGS_KEY = 'openChatTabs'

function persist(ids: string[]) {
  try {
    void window.syntee?.settings?.set(SETTINGS_KEY, ids)
  } catch { /* ок — вне electron (браузерный dev) */ }
}

interface TabsStore {
  openTabIds: string[]
  /** Полная установка (восстановление сессии при boot). */
  setTabs: (ids: string[]) => void
  /** Открыть вкладку (добавить в конец, если ещё нет). */
  openTab: (id: string) => void
  /** Закрыть вкладку. Возвращает id соседней (правая, иначе левая — как в
   *  Chrome), на которую надо переключиться если закрытая была активной. */
  closeTab: (id: string) => string | null
  /** Новый порядок после drag&drop (Reorder.Group onReorder). */
  reorderTabs: (ids: string[]) => void
}

export const useTabsStore = create<TabsStore>((set, get) => ({
  openTabIds: [],

  setTabs: (ids) => {
    set({ openTabIds: ids })
    persist(ids)
  },

  openTab: (id) => {
    const { openTabIds } = get()
    if (openTabIds.includes(id)) return
    const next = [...openTabIds, id]
    set({ openTabIds: next })
    persist(next)
  },

  closeTab: (id) => {
    const { openTabIds } = get()
    const idx = openTabIds.indexOf(id)
    if (idx === -1) return null
    const next = openTabIds.filter(t => t !== id)
    set({ openTabIds: next })
    persist(next)
    return next[idx] ?? next[idx - 1] ?? null
  },

  reorderTabs: (ids) => {
    set({ openTabIds: ids })
    persist(ids)
  },
}))

// Авточистка: чат удалили (сайдбар/контекстное меню) → его вкладка тоже
// закрывается. Покрывает все пути удаления, т.к. любой из них идёт через
// setChats. При boot гонки нет: восстановление вкладок в App.tsx идёт
// ПОСЛЕ setChats, поэтому к моменту появления tabIds chats уже живые.
// Гейт по ссылке на chats: subscribe стреляет на ЛЮБОЕ изменение chat.store
// (стриминг ~20×/сек), а фильтровать нужно только при смене списка чатов.
let lastChats: unknown = null
useChatStore.subscribe((s) => {
  if (s.chats === lastChats) return
  lastChats = s.chats
  const { openTabIds, setTabs } = useTabsStore.getState()
  if (openTabIds.length === 0) return
  const alive = new Set(s.chats.map(c => c.id))
  const pruned = openTabIds.filter(id => alive.has(id))
  if (pruned.length !== openTabIds.length) setTabs(pruned)
})

// Мост между TitleBar (рендерится в App) и ChatPage (владелец логики
// выбора/создания чатов). ChatPage регистрирует свои колбэки при
// монтировании; ChatPage keep-alive → регистрация живёт всю сессию.
// Не в Zustand — функции не данные, подписки на них не нужны.
export const tabActions: {
  selectChat: ((id: string) => void) | null
  /** Создать чат в контексте текущего: чат проекта → новый чат в том же
   *  проекте; чат без проекта → новый чат без проекта. */
  createInContext: (() => void) | null
} = {
  selectChat: null,
  createInContext: null,
}
