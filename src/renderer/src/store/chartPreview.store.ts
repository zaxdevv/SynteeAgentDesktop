import { create } from 'zustand'
import { useUIStore } from './ui.store'
import { useRightPanelTabsStore } from './rightPanelTabs.store'

// ── Просмотр графиков/диаграмм в правой панели ──────────────────────────
// ChartBlock / MermaidBlock в чате имеют кнопку ⤢ («развернуть») — клик
// кладёт объект сюда и открывает таб 'chart' правой панели. Панель рендерит
// объект крупно с zoom/pan (2D-навигация: колесо — приближение к курсору,
// drag — панорамирование, двойной клик — сброс).

export interface ChartPreviewPayload {
  kind: 'chart' | 'mermaid'
  /** Заголовок (для chart — spec.title, для mermaid — генерируем «Диаграмма»). */
  title?: string
  /** Исходник: JSON-спека для chart, mermaid-код для mermaid. */
  code: string
}

interface ChartPreviewStore {
  preview: ChartPreviewPayload | null
  /** Открыть объект в правой панели (ставит payload + открывает таб 'chart'). */
  open: (payload: ChartPreviewPayload) => void
  /** Сбросить payload (таб остаётся открытым с empty-state). */
  clear: () => void
}

export const useChartPreviewStore = create<ChartPreviewStore>((set) => ({
  preview: null,
  open: (payload) => {
    set({ preview: payload })
    // Открываем правую панель + таб 'chart' (как handleAddPanel в RightPanel,
    // но программно). Персистим как при ручном клике по табу.
    const ui = useUIStore.getState()
    ui.setAgentPanelOpen(true)
    useRightPanelTabsStore.getState().openPanel('chart')
    ui.setAgentPanelTab('chart')
    try {
      void window.syntee?.settings?.set('agentPanelOpen', true)
      void window.syntee?.settings?.set('agentPanelTab', 'chart')
    } catch { /* вне electron — ок */ }
  },
  clear: () => set({ preview: null }),
}))
