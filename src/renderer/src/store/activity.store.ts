import { create } from 'zustand'

export type ActivityStatus = 'idle' | 'running' | 'done' | 'error'
export type ActivityPhase = 'thinking' | 'tool' | 'idle'

export interface ActivityStep {
  id: string
  toolName: string
  status: 'running' | 'done' | 'error'
  args?: Record<string, unknown>
  result?: string
  ts: number
}

export interface ToolProgress {
  toolName: string
  stage: string
  detail?: string
  filesProcessed?: number
  filesTotal?: number
}

/** Состояние активности ОДНОГО чата. Store держит Map параллельных прогонов —
 *  виджет агрегирует их в компактный информер (N чатов). */
export interface ChatActivity {
  status: ActivityStatus
  phase: ActivityPhase
  currentTool: string | null
  toolProgress: ToolProgress | null
  steps: ActivityStep[]
  startedAt: number | null
}

const MAX_STEPS = 4

interface ActivityStore {
  chats: Record<string, ChatActivity>
  visible: boolean

  setRunning: (chatId: string) => void
  setDone: (chatId: string) => void
  setError: (chatId: string) => void
  setPhase: (chatId: string, phase: ActivityPhase) => void
  setCurrentTool: (chatId: string, tool: string | null) => void
  setToolProgress: (chatId: string, progress: ToolProgress | null) => void
  addStep: (chatId: string, step: ActivityStep) => void
  updateStep: (chatId: string, id: string, updates: Partial<ActivityStep>) => void
  setVisible: (visible: boolean) => void
  showWidget: () => void
}

/** Патч одного чата; если чата нет (событие до running) — игнорируем. */
const patch = (chatId: string, updates: Partial<ChatActivity>) =>
  (state: ActivityStore): Partial<ActivityStore> => ({
    chats: state.chats[chatId]
      ? { ...state.chats, [chatId]: { ...state.chats[chatId], ...updates } }
      : state.chats,
  })

export const useActivityStore = create<ActivityStore>((set) => ({
  chats: {},
  visible: false,

  // НЕ ставим visible: true здесь — visible ставится только через
  // activity:show (из minimize/blur listener или onRunStatus когда
  // shouldShow=true). Иначе виджет появляется даже когда окно активно.
  setRunning: (chatId) => set(state => ({
    chats: {
      ...state.chats,
      [chatId]: {
        status: 'running',
        phase: 'thinking',
        currentTool: null,
        toolProgress: null,
        steps: [],
        startedAt: Date.now(),
      },
    },
  })),

  setDone: (chatId) => set(patch(chatId, {
    status: 'done', phase: 'idle', currentTool: null, toolProgress: null,
  })),

  setError: (chatId) => set(patch(chatId, {
    status: 'error', phase: 'idle', currentTool: null, toolProgress: null,
  })),

  setPhase: (chatId, phase) => set(patch(chatId, { phase })),

  setCurrentTool: (chatId, tool) => set(patch(chatId, { currentTool: tool })),

  setToolProgress: (chatId, progress) => set(patch(chatId, { toolProgress: progress })),

  addStep: (chatId, step) => set(state => {
    const c = state.chats[chatId]
    if (!c) return {}
    return {
      chats: {
        ...state.chats,
        [chatId]: { ...c, steps: [...c.steps, step].slice(-MAX_STEPS) },
      },
    }
  }),

  updateStep: (chatId, id, updates) => set(state => {
    const c = state.chats[chatId]
    if (!c) return {}
    return {
      chats: {
        ...state.chats,
        [chatId]: { ...c, steps: c.steps.map(s => s.id === id ? { ...s, ...updates } : s) },
      },
    }
  }),

  setVisible: (visible) => set({ visible }),

  /** Показать виджет без сброса состояния (для minimize listener).
   *  visible=true только если хоть один чат реально работает. */
  showWidget: () => set(state => ({
    visible: Object.values(state.chats).some(c => c.status === 'running'),
  })),
}))
