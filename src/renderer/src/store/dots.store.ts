// ── Dots store: список Dot'ов + подписка на push-события main ────────────
// DotsPage монтируется один раз; события DOTS_CHANGED/STATE обновляют
// список без полного refetch (STATE шлёт только статусы — main пересобирает
// Dot[] с состоянием, поэтому проще перечитать dots:list — он лёгкий).
import { create } from 'zustand'
import { IPC_EVENTS } from '../../../shared/constants'
import type { Dot, DotRun, DotSettings } from '../../../shared/types'

interface DotsStore {
  dots: Dot[]
  loaded: boolean
  loading: boolean
  /** Выбранный Dot (id) — его чат открыт справа. */
  selectedDotId: string | null
  /** История ранов выбранного Dot'а. */
  runsByDot: Record<string, DotRun[]>
  settings: DotSettings | null
  /** Визард создания/редактирования. dotId = редактирование;
   *  template = предзаполнение из пустого состояния (шаблоны). */
  wizard: { open: boolean; dotId?: string; template?: DotTemplate }
  /** Unread: dotId → число отчётов после lastSeen (localStorage). */
  unreadByDot: Record<string, number>
  setWizard: (open: boolean, dotId?: string, template?: DotTemplate) => void
  selectDot: (dotId: string | null) => void
  /** Отметить «просмотрено» — гасит unread-бейдж Dot'а. */
  markSeen: (dotId: string) => void
  load: () => Promise<void>
  loadRuns: (dotId: string) => Promise<void>
  loadSettings: () => Promise<void>
  setSettings: (patch: Partial<DotSettings>) => Promise<void>
  initEvents: () => () => void
}

/** Шаблон для предзаполнения визарда из пустого состояния. */
export interface DotTemplate {
  /** Готовый текст задачи. */
  purpose: string
  /** Имя по умолчанию (пользователь может поменять). */
  name?: string
  icon?: string
  /** Триггер по умолчанию. */
  scheduleKind?: 'none' | 'cron' | 'interval'
  scheduleValue?: string
}

/** lastSeen по Dot'ам (когда пользователь последний раз смотрел его чат).
 *  localStorage — переживает рестарты, не гоняет БД. */
const LAST_SEEN_KEY = 'dots.lastSeen'
function readLastSeen(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(LAST_SEEN_KEY) ?? '{}') as Record<string, number> } catch { return {} }
}
function writeLastSeen(map: Record<string, number>): void {
  try { localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(map)) } catch { /* приватный режим */ }
}

/** Флаг «перечитать после текущей загрузки»: событие DOTS_CHANGED/STATE,
 *  прилетевшее во время load, не теряется (раньше guard `if (loading)
 *  return` его молча съедал — список оставался устаревшим). */
let reloadPending = false

/** Русское склонение: 1 Dot / 2 Dot’а / 5 Dot’ов. */
export function pluralDots(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return `${n} Dot`
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return `${n} Dot’а`
  return `${n} Dot’ов`
}

export const useDotsStore = create<DotsStore>((set, get) => ({
  dots: [],
  loaded: false,
  loading: false,
  selectedDotId: null,
  runsByDot: {},
  settings: null,
  wizard: { open: false },
  unreadByDot: {},

  setWizard: (open, dotId, template) => set({ wizard: { open, dotId, template } }),
  selectDot: (dotId) => {
    set({ selectedDotId: dotId })
    if (dotId) get().markSeen(dotId)
  },

  markSeen: (dotId) => {
    const seen = readLastSeen()
    seen[dotId] = Date.now()
    writeLastSeen(seen)
    // Гасим бейдж сразу (не ждём перечитки unreadCounts).
    if (get().unreadByDot[dotId]) {
      set(s => ({ unreadByDot: { ...s.unreadByDot, [dotId]: 0 } }))
    }
  },

  load: async () => {
    if (get().loading) { reloadPending = true; return }
    set({ loading: true })
    try {
      const dots = await window.syntee.dots.list()
      set({ dots, loaded: true })
      // Unread: пачкой спрашиваем main, сколько отчётов после lastSeen.
      // lastSeen нет у новых Dot'ов → 0 (всё прочитано).
      try {
        const seen = readLastSeen()
        const pairs = dots
          .filter(d => d.state.lastReport)
          .map(d => ({ dotId: d.id, since: seen[d.id] ?? 0 }))
        if (pairs.length > 0) {
          const counts = await window.syntee.dots.unreadCounts(pairs)
          set({ unreadByDot: counts })
        }
      } catch { /* unread — не критично */ }
    } catch {
      set({ loaded: true })
    } finally {
      set({ loading: false })
      if (reloadPending) {
        reloadPending = false
        void get().load()
      }
    }
  },

  loadRuns: async (dotId) => {
    try {
      const runs = await window.syntee.dots.getRuns(dotId, 30)
      set(s => ({ runsByDot: { ...s.runsByDot, [dotId]: runs } }))
    } catch { /* ignore */ }
  },

  loadSettings: async () => {
    try {
      const settings = await window.syntee.dots.getSettings()
      set({ settings })
    } catch { /* ignore */ }
  },

  setSettings: async (patch) => {
    try {
      const settings = await window.syntee.dots.setSettings(patch)
      set({ settings })
    } catch { /* ignore */ }
  },

  initEvents: () => {
    // DOTS_CHANGED — CRUD (создан/удалён/обновлён) → перечитываем список.
    const offChanged = window.syntee.on(IPC_EVENTS.DOTS_CHANGED, () => {
      void get().load()
    })
    // DOTS_STATE — статус ранов (running/sleeping/...) → перечитываем
    // (main пересобирает Dot[] с живым состоянием — список маленький).
    const offState = window.syntee.on(IPC_EVENTS.DOTS_STATE, () => {
      void get().load()
    })
    // DOTS_RUN_FINISHED — ран завершился: обновить список + историю.
    // Если чат этого Dot'а открыт — сразу гасим unread (пользователь
    // видит отчёт вживую, бейдж «есть новое» не нужен).
    const offRun = window.syntee.on(IPC_EVENTS.DOTS_RUN_FINISHED, (...args: unknown[]) => {
      const p = (args[0] ?? {}) as { dotId?: string }
      void get().load()
      if (p.dotId) {
        void get().loadRuns(p.dotId)
        if (get().selectedDotId === p.dotId) get().markSeen(p.dotId)
      }
    })
    return () => { offChanged(); offState(); offRun() }
  },
}))
