import { create } from 'zustand'

// ── Вкладки открытых файлов в шапке (как в VSCode) ─────────────────────
// openFileTabs — массив открытых файлов. Каждый FileTab хранит контент,
// состояние dirty (несохранённые правки) и conflict (файл изменён внешне).
// Состав и порядок персистятся в electron-store ('openFileTabs').
// Активный таб — activeFileTabId (null = показывается чат, не файл).
//
// Live-обновление: при событии 'file:changed' (агент записал файл или
// пользователь сохранил через редактор) — если файл открыт в табе и
// нет локальных правок (dirty=false), контент обновляется автоматически.
// Если есть несохранённые правки (dirty=true) — ставится флаг conflict,
// UI показывает баннер «Файл изменён внешне, перезагрузить?».

const SETTINGS_KEY = 'openFileTabs'

function persistPaths(paths: string[]) {
  try {
    void window.syntee?.settings?.set(SETTINGS_KEY, paths)
  } catch { /* ок — вне electron (браузерный dev) */ }
}

export interface FileTab {
  /** Уникальный ID — relPath в рамках workdir */
  id: string
  /** Абсолютный путь к файлу */
  path: string
  /** Относительный путь (для отображения) */
  relPath: string
  /** Имя файла (basename) */
  name: string
  /** Контент файла (текущий — с правками пользователя) */
  content: string
  /** Последний сохранённый контент (для dirty-сравнения) */
  savedContent: string
  /** Файл обрезан (больше MAX_LINES) */
  truncated: boolean
  truncatedReason?: string
  /** Размер файла в байтах */
  size: number
  /** Бинарный файл — нельзя редактировать */
  isBinary?: boolean
  /** Загрузка с диска */
  loading: boolean
  /** Ошибка загрузки */
  error?: string
  /** Есть несохранённые правки (content !== savedContent) */
  dirty: boolean
  /** Файл изменён внешне (агентом) при наличии локальных правок */
  conflict: boolean
  /** mtime файла при последней загрузке/сохранении */
  lastMtime: number
  /** Diff-режим: показывать HEAD vs working copy (Open Changes) */
  diffMode: boolean
  /** Оригинальный контент (HEAD) для diff-режима */
  diffOriginal: string
}

interface FileTabsStore {
  openFileTabs: FileTab[]
  activeFileTabId: string | null
  /** Текущая рабочая директория (для резолва путей) */
  workdir: string | null

  /** Установить workdir (при смене чата/проекта) */
  setWorkdir: (wd: string | null) => void
  /** Открыть файл в табе (если уже открыт — активировать) */
  openFile: (relPath: string, workdir: string) => Promise<void>
  /** Закрыть таб. Возвращает id соседнего (для активации) или null */
  closeFileTab: (id: string) => string | null
  /** Активировать таб (показать в основной области) */
  setActiveFileTab: (id: string | null) => void
  /** Перестановка табов после drag&drop */
  reorderFileTabs: (ids: string[]) => void
  /** Обновить контент при вводе в Monaco */
  updateContent: (id: string, content: string) => void
  /** Сохранить файл на диск (Ctrl+S) */
  saveFile: (id: string) => Promise<boolean>
  /** Перечитать файл с диска (refresh) */
  refreshTab: (id: string) => Promise<void>
  /** Отметить файл изменённым внешне (от агента) */
  markExternalChange: (path: string) => void
  /** Закрыть все табы */
  closeAll: () => void
  /** Восстановление сессии при boot */
  restoreTabs: (paths: string[], workdir: string) => Promise<void>
  /** Переключить diff-режим таба (Open Changes) */
  toggleDiffMode: (id: string) => void
  /** Загрузить оригинальную (HEAD) версию файла для diff-режима */
  loadDiffOriginal: (id: string) => Promise<void>
  /** Открыть файл в табе СРАЗУ в diff-режиме (Open Changes) */
  openFileDiff: (relPath: string, workdir: string) => Promise<void>
}

export const useFileTabsStore = create<FileTabsStore>((set, get) => ({
  openFileTabs: [],
  activeFileTabId: null,
  workdir: null,

  setWorkdir: (wd) => {
    // При смене workdir закрываем все файловые табы — пути из другого проекта
    const prevWd = get().workdir
    if (prevWd !== wd) {
      set({ openFileTabs: [], activeFileTabId: null, workdir: wd })
      persistPaths([])
    }
  },

  openFile: async (relPath, workdir) => {
    const existing = get().openFileTabs.find(t => t.id === relPath)
    if (existing) {
      set({ activeFileTabId: relPath })
      return
    }

    const name = relPath.split('/').pop() || relPath
    const newTab: FileTab = {
      id: relPath,
      path: '',
      relPath,
      name,
      content: '',
      savedContent: '',
      truncated: false,
      size: 0,
      loading: true,
      dirty: false,
      conflict: false,
      lastMtime: 0,
      diffMode: false,
      diffOriginal: '',
    }

    set(state => ({
      openFileTabs: [...state.openFileTabs, newTab],
      activeFileTabId: relPath,
      workdir,
    }))
    persistPaths(get().openFileTabs.map(t => t.relPath))

    // Загружаем контент
    await get().refreshTab(relPath)
  },

  closeFileTab: (id) => {
    const { openFileTabs, activeFileTabId } = get()
    const idx = openFileTabs.findIndex(t => t.id === id)
    if (idx === -1) return null

    const next = openFileTabs.filter(t => t.id !== id)
    set({ openFileTabs: next })
    persistPaths(next.map(t => t.relPath))

    // Если закрыли активный — активируем соседний
    if (id === activeFileTabId) {
      const neighbor = next[idx] ?? next[idx - 1] ?? null
      set({ activeFileTabId: neighbor ? neighbor.id : null })
      return neighbor ? neighbor.id : null
    }
    return null
  },

  setActiveFileTab: (id) => set({ activeFileTabId: id }),

  reorderFileTabs: (ids) => {
    const { openFileTabs } = get()
    const map = new Map(openFileTabs.map(t => [t.id, t]))
    const reordered = ids.map(id => map.get(id)).filter(Boolean) as FileTab[]
    set({ openFileTabs: reordered })
    persistPaths(reordered.map(t => t.relPath))
  },

  updateContent: (id, content) => {
    set(state => ({
      openFileTabs: state.openFileTabs.map(t =>
        t.id === id
          ? { ...t, content, dirty: content !== t.savedContent }
          : t
      )
    }))
  },

  saveFile: async (id) => {
    const { openFileTabs, workdir } = get()
    const tab = openFileTabs.find(t => t.id === id)
    if (!tab || !workdir) return false

    try {
      const result = await window.syntee.fs.writeFile({
        root: workdir,
        relPath: tab.relPath,
        content: tab.content,
      }) as { success: boolean; size?: number; mtime?: number; error?: string }

      if (!result.success) {
        console.error('[fileTabs] saveFile error:', result.error)
        return false
      }

      set(state => ({
        openFileTabs: state.openFileTabs.map(t =>
          t.id === id
            ? {
                ...t,
                savedContent: t.content,
                dirty: false,
                conflict: false,
                size: result.size ?? t.size,
                lastMtime: result.mtime ?? t.lastMtime,
              }
            : t
        )
      }))
      return true
    } catch (e) {
      console.error('[fileTabs] saveFile exception:', e)
      return false
    }
  },

  refreshTab: async (id) => {
    const { openFileTabs, workdir } = get()
    const tab = openFileTabs.find(t => t.id === id)
    if (!tab || !workdir) return

    set(state => ({
      openFileTabs: state.openFileTabs.map(t =>
        t.id === id ? { ...t, loading: true, error: undefined } : t
      )
    }))

    try {
      const result = await window.syntee.fs.readFile({
        root: workdir,
        relPath: tab.relPath,
      }) as { success: boolean; content: string; truncated: boolean; truncatedReason?: string; size: number; mtime?: number; error?: string; isBinary?: boolean }

      if (!result.success) {
        set(state => ({
          openFileTabs: state.openFileTabs.map(t =>
            t.id === id
              ? { ...t, loading: false, error: result.error, isBinary: result.isBinary }
              : t
          )
        }))
        return
      }

      set(state => ({
        openFileTabs: state.openFileTabs.map(t =>
          t.id === id
            ? {
                ...t,
                content: result.content,
                savedContent: result.content,
                truncated: result.truncated,
                truncatedReason: result.truncatedReason,
                size: result.size,
                isBinary: result.isBinary,
                loading: false,
                dirty: false,
                conflict: false,
                lastMtime: result.mtime ?? t.lastMtime,
              }
            : t
        )
      }))
    } catch (e) {
      set(state => ({
        openFileTabs: state.openFileTabs.map(t =>
          t.id === id ? { ...t, loading: false, error: String((e as Error)?.message ?? e) } : t
        )
      }))
    }
  },

  markExternalChange: (path) => {
    const { openFileTabs } = get()
    // path может быть абсолютным или относительным
    const tab = openFileTabs.find(t => t.path === path || t.relPath === path)
    if (!tab) return

    if (!tab.dirty) {
      // Нет локальных правок — авто-обновление
      get().refreshTab(tab.id)
    } else {
      // Есть несохранённые правки — ставим флаг конфликта
      set(state => ({
        openFileTabs: state.openFileTabs.map(t =>
          t.id === tab.id ? { ...t, conflict: true } : t
        )
      }))
    }
  },

  closeAll: () => {
    set({ openFileTabs: [], activeFileTabId: null })
    persistPaths([])
  },

  toggleDiffMode: (id) => {
    const tab = get().openFileTabs.find(t => t.id === id)
    if (!tab) return
    const newMode = !tab.diffMode
    set(state => ({
      openFileTabs: state.openFileTabs.map(t =>
        t.id === id ? { ...t, diffMode: newMode } : t
      )
    }))
    if (newMode) {
      // Включаем diff — загружаем HEAD-версию
      void get().loadDiffOriginal(id)
    }
  },

  loadDiffOriginal: async (id) => {
    const { openFileTabs, workdir } = get()
    const tab = openFileTabs.find(t => t.id === id)
    if (!tab || !workdir) return
    try {
      const result = await window.syntee.git.fileVersions({ workdir, file: tab.relPath }) as
        { success: boolean; original: string; modified: string }
      if (result.success) {
        set(state => ({
          openFileTabs: state.openFileTabs.map(t =>
            t.id === id ? { ...t, diffOriginal: result.original } : t
          )
        }))
      }
    } catch { /* ok */ }
  },

  openFileDiff: async (relPath, workdir) => {
    // Открываем файл в табе (если уже открыт — активируем)
    await get().openFile(relPath, workdir)
    // Включаем diff-режим если ещё не включён
    const tab = get().openFileTabs.find(t => t.id === relPath)
    if (tab && !tab.diffMode) {
      get().toggleDiffMode(relPath)
    }
  },

  restoreTabs: async (paths, workdir) => {
    set({ workdir })
    for (const relPath of paths) {
      await get().openFile(relPath, workdir)
    }
  },
}))

// ── Подписка на событие 'file:changed' (agent записал файл) ────────────
// При получении события — markExternalChange, который либо авто-обновит
// контент (если нет правок), либо поставит флаг конфликта.
if (typeof window !== 'undefined' && window.syntee?.on) {
  window.syntee.on('file:changed', (...args: unknown[]) => {
    const data = args[0] as { path?: string; relPath?: string } | undefined
    if (data?.path) {
      useFileTabsStore.getState().markExternalChange(data.path)
    } else if (data?.relPath) {
      useFileTabsStore.getState().markExternalChange(data.relPath)
    }
  })
}
