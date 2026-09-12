/**
 * pluginPanel store — состояние iframe-панелей плагинов.
 *
 * Модели:
 *  - modal: одна открытая модальная панель (PluginModalHost). Состояние
 *    приходит из push-события 'plugins:modal-action' (main) — { action,
 *    entry, title, width, height } — или из кнопок сайдбара (slot 'modal').
 *  - page: активная полноэкранная страница плагина (slot 'page').
 *  - bottom: открытые табы нижнего дока (slot 'bottom') + активный.
 *  - right-табы: полноценные табы правой панели (plugin:{pluginId}:{panelId})
 *    с бейджами — открываются/закрываются из push-событий main
 *    (plugins:panel-action), сайдбар-кнопок и меню правой панели.
 *  - legacy open: модальная панель v1 (registerUi type='panel', слот sidebar).
 *  - statusbar: элементы status bar от плагинов (снапшот на плагин).
 */
import { create } from 'zustand'
import type { PluginStatusbarItem } from '@shared/types/plugin'
import { useRightPanelTabsStore } from './rightPanelTabs.store'
import { useUIStore, buildPluginTabId } from './ui.store'
import { useFileTabsStore } from './fileTabs.store'

/** Модальная iframe-панель (PLUGINS_MODAL_ACTION / slot 'modal'). */
export interface PluginModalState {
  pluginId: string
  title: string
  /** HTML-файл панели; если нет — берётся manifest.ui плагина. */
  entry?: string
  width?: number
  height?: number
}

/** Chat overlay — плавающий iframe-оверлей плагина поверх области чата
 *  (PLUGINS_CHAT_OVERLAY, ui.showChatOverlay). */
export interface PluginChatOverlayState {
  pluginId: string
  title?: string
  entry: string
  width?: number
  height?: number
  position?: 'left' | 'right' | 'center'
}

/** Полноэкранная страница плагина (slot 'page'). */
export interface PluginPageState {
  pluginId: string
  panelId: string
}

/** Таб нижнего дока плагина (slot 'bottom'). */
export interface PluginBottomTabRef {
  pluginId: string
  panelId: string
}

interface PluginPanelStore {
  /** Открытая modal-панель: pluginId + заголовок (legacy registerUi type='panel'). */
  open: { pluginId: string; title: string } | null
  /** Современная модальная панель (PluginModalHost) — одна одновременно. */
  modal: PluginModalState | null
  /** Chat overlay плагина (PluginChatOverlayHost) — один одновременно. */
  chatOverlay: PluginChatOverlayState | null
  /** Активная полноэкранная страница плагина (null = закрыта). */
  activePage: PluginPageState | null
  /** Открытые табы нижнего дока плагинов. */
  bottomTabs: PluginBottomTabRef[]
  /** Активный таб нижнего дока. */
  activeBottomTab: PluginBottomTabRef | null
  /** Элементы status bar по плагинам (снапшот; пустой массив = плагин их убрал). */
  statusbarByPlugin: Record<string, PluginStatusbarItem[]>
  /** Бейджи табов правой панели: ключ — полный id таба plugin:{pluginId}:{panelId}. */
  badges: Record<string, number | null>

  openPanel: (pluginId: string, title: string) => void
  closePanel: () => void
  openPluginModal: (m: PluginModalState) => void
  closePluginModal: () => void
  openChatOverlay: (o: PluginChatOverlayState) => void
  closeChatOverlay: () => void
  openPluginPage: (pluginId: string, panelId: string) => void
  closePluginPage: () => void
  openPluginBottomTab: (pluginId: string, panelId: string) => void
  closePluginBottomTab: (pluginId: string, panelId: string) => void
  setActivePluginBottomTab: (pluginId: string, panelId: string) => void
  setStatusbarItems: (pluginId: string, items: PluginStatusbarItem[]) => void
  setBadge: (tabId: string, badge: number | null) => void
  openPluginTab: (pluginId: string, panelId: string, _title?: string) => void
  closePluginTab: (pluginId: string, panelId: string) => void
}

const emptyStatusbar: PluginStatusbarItem[] = []

export const usePluginPanelStore = create<PluginPanelStore>((set) => ({
  open: null,
  modal: null,
  chatOverlay: null,
  activePage: null,
  bottomTabs: [],
  activeBottomTab: null,
  statusbarByPlugin: {},
  badges: {},

  openPanel: (pluginId, title) => set({ open: { pluginId, title } }),
  closePanel: () => set({ open: null }),

  openPluginModal: (m) => { set({ modal: m, open: null }); notifyPanelLifecycle(m.pluginId, 'modal', 'opened') },
  closePluginModal: () => {
    const prev = usePluginPanelStore.getState().modal
    set({ modal: null })
    if (prev) notifyPanelLifecycle(prev.pluginId, 'modal', 'closed')
  },

  openChatOverlay: (o) => set({ chatOverlay: o }),
  closeChatOverlay: () => set({ chatOverlay: null }),

  openPluginPage: (pluginId, panelId) => { set({ activePage: { pluginId, panelId } }); notifyPanelLifecycle(pluginId, panelId, 'opened') },
  closePluginPage: () => {
    const prev = usePluginPanelStore.getState().activePage
    set({ activePage: null })
    if (prev) notifyPanelLifecycle(prev.pluginId, prev.panelId, 'closed')
  },

  openPluginBottomTab: (pluginId, panelId) => set(s => {
    const key = (t: PluginBottomTabRef) => t.pluginId === pluginId && t.panelId === panelId
    if (s.bottomTabs.some(key)) {
      return { activeBottomTab: { pluginId, panelId } }
    }
    return {
      bottomTabs: [...s.bottomTabs, { pluginId, panelId }],
      activeBottomTab: { pluginId, panelId },
    }
  }),

  closePluginBottomTab: (pluginId, panelId) => set(s => {
    const remaining = s.bottomTabs.filter(t => !(t.pluginId === pluginId && t.panelId === panelId))
    let active = s.activeBottomTab
    if (active && active.pluginId === pluginId && active.panelId === panelId) {
      active = remaining.length > 0 ? remaining[remaining.length - 1] : null
    }
    return { bottomTabs: remaining, activeBottomTab: active }
  }),

  setActivePluginBottomTab: (pluginId, panelId) => set({ activeBottomTab: { pluginId, panelId } }),

  setStatusbarItems: (pluginId, items) => set(s => {
    const list = Array.isArray(items) ? items.filter(i => i && typeof i.id === 'string') : emptyStatusbar
    const next = { ...s.statusbarByPlugin }
    if (list.length === 0) delete next[pluginId]
    else next[pluginId] = list
    return { statusbarByPlugin: next }
  }),

  setBadge: (tabId, badge) => set(s => ({
    badges: badge == null
      ? (() => { const next = { ...s.badges }; delete next[tabId]; return next })()
      : { ...s.badges, [tabId]: badge },
  })),

  openPluginTab: (pluginId, panelId, _title) => {
    const tabId = buildPluginTabId(pluginId, panelId)
    useRightPanelTabsStore.getState().openPanel(tabId)
    useUIStore.getState().setAgentPanelTab(tabId)
    useUIStore.getState().setAgentPanelOpen(true)
    // Активный файловый таб перекрывает контент панелей — сбрасываем его.
    useFileTabsStore.getState().setActiveFileTab(null)
    notifyPanelLifecycle(pluginId, panelId, 'opened')
  },
  closePluginTab: (pluginId, panelId) => {
    const tabId = buildPluginTabId(pluginId, panelId)
    useRightPanelTabsStore.getState().closePanel(tabId)
    // Если закрыли активный таб — переключаемся на оставшийся (или sidechat).
    const ui = useUIStore.getState()
    if (ui.agentPanelTab === tabId) {
      const remaining = useRightPanelTabsStore.getState().openPanels
      if (remaining.length > 0) {
        ui.setAgentPanelTab(remaining[0])
      } else {
        useRightPanelTabsStore.getState().openPanel('sidechat')
        ui.setAgentPanelTab('sidechat')
      }
    }
    notifyPanelLifecycle(pluginId, panelId, 'closed')
  },
}))

/** Сообщает main (→ процесс плагина) об открытии/закрытии панели —
 *  событие 'panel:opened'/'panel:closed' в плагине, если он подписан. */
function notifyPanelLifecycle(pluginId: string, panelId: string, action: 'opened' | 'closed'): void {
  try {
    void window.syntee.plugins.panelLifecycle({ pluginId, panelId, action }).catch(() => {})
  } catch { /* preload ещё не готов — ок */ }
}

/** Уплощённый список элементов status bar (по одному на pluginId+id). */
export function selectStatusbarItems(s: PluginPanelStore): PluginStatusbarItem[] {
  const items: PluginStatusbarItem[] = []
  for (const [pluginId, list] of Object.entries(s.statusbarByPlugin)) {
    for (const it of list) {
      items.push(it.pluginId ? it : { ...it, pluginId })
    }
  }
  return items
}

/** Элементы статус-бара конкретного плагина. */
export function pluginStatusbarItems(s: PluginPanelStore, pluginId: string): PluginStatusbarItem[] {
  return s.statusbarByPlugin[pluginId] ?? emptyStatusbar
}

/** Найти элемент статус-бара по pluginId+id (для обновления после клика). */
export function findStatusbarItem(s: PluginPanelStore, pluginId: string, id: string): PluginStatusbarItem | undefined {
  return (s.statusbarByPlugin[pluginId] ?? emptyStatusbar).find(i => i.id === id)
}
