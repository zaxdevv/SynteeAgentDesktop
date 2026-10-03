// ── Авто-открытие панели браузера при AI-активности ──────────────────────
//
// Юзер должен ВИДЕТЬ, что агент делает в браузере: при первом browser_*-туле
// рана правая панель сама открывается на табе «Браузер». Панель также
// открывается в момент подтверждения request_access (browser:mode-changed) —
// webview успевает смонтироваться и зарегистрироваться в main ДО того, как
// модель выпустит первый browser_navigate (иначе «No browser tab available»:
// webview-элементы живут только в смонтированной BrowserPanel, keep-alive).
//
// Guard «раз на ран» (Map chatId → msgId): если юзер закрыл панель или
// переключил таб — не дёргаем её повторно до конца текущего рана.
//
// Побочно: agentActiveTool в browser.store — бейдж «AI» в тулбаре браузера,
// пока идёт browser-тул (гасим по tool_result / answer + safety-timeout).

import { useEffect } from 'react'
import { useUIStore } from '../store/ui.store'
import { useRightPanelTabsStore } from '../store/rightPanelTabs.store'
import { useBrowserStore } from '../store/browser.store'
import { isAuxWindow } from './chatRunRuntime'

/** chatId → msgId рана, для которого панель уже авто-открывали. */
const autoOpenedRuns = new Map<string, string>()

/** Safety-timeout снятия agentActiveTool (ран умер без tool_result). */
const AGENT_TOOL_TIMEOUT_MS = 120_000
let agentToolTimer: ReturnType<typeof setTimeout> | null = null

function openBrowserPanel(): void {
  useRightPanelTabsStore.getState().openPanel('browser')
  const ui = useUIStore.getState()
  ui.setAgentPanelTab('browser')
  ui.setAgentPanelOpen(true)
  // Синк с settings — как handlePanelTabClick/handleAddPanel (иначе boot
  // восстановит старый таб из settings при открытом store-стейте).
  window.syntee.settings.set('agentPanelTab', 'browser')
  window.syntee.settings.set('agentPanelOpen', true)
}

function setAgentTool(tool: string | null): void {
  if (agentToolTimer) { clearTimeout(agentToolTimer); agentToolTimer = null }
  useBrowserStore.getState().setAgentActiveTool(tool)
  if (tool) {
    agentToolTimer = setTimeout(() => {
      agentToolTimer = null
      useBrowserStore.getState().setAgentActiveTool(null)
    }, AGENT_TOOL_TIMEOUT_MS)
    if (typeof agentToolTimer.unref === 'function') agentToolTimer.unref()
  }
}

export function useBrowserAutoOpen(): void {
  useEffect(() => {
    if (isAuxWindow()) return

    // Агент вызвал browser_* тул → открыть панель (раз на ран) + бейдж AI.
    // (...args: unknown[]) — сигнатура window.syntee.on; типизированный
    // колбэк дал бы TS2345 (strictFunctionTypes), как в useToolProgress.
    type BrowserStep = { type: string; toolName?: string; msgId?: string; chatId?: string }
    const offStep = window.syntee.on('agent:step', (...args: unknown[]) => {
      const step = args[0] as BrowserStep | undefined
      if (!step || typeof step !== 'object') return
      // answer — ран закончился: гарантированно гасим бейдж (даже если
      // tool_result потерялся). У answer нет toolName — до prefix-фильтра.
      if (step.type === 'answer') {
        setAgentTool(null)
        return
      }

      const name = step.toolName ?? ''
      if (!name.startsWith('browser_')) return

      if (step.type === 'tool_call_pending' || step.type === 'tool_call') {
        setAgentTool(name)
        // Авто-открытие — раз на ран (chatId + msgId).
        if (step.chatId && step.msgId && autoOpenedRuns.get(step.chatId) !== step.msgId) {
          if (autoOpenedRuns.size > 200) autoOpenedRuns.clear()
          autoOpenedRuns.set(step.chatId, step.msgId)
          openBrowserPanel()
        }
      } else if (step.type === 'tool_result') {
        setAgentTool(null)
      }
    })

    // request_access подтверждён / тумблер включён → панель заранее:
    // webview монтируется, пока модель генерирует первый browser_* вызов.
    const offMode = window.syntee.browser.onModeChanged(info => {
      if (info.enabled) openBrowserPanel()
    })

    return () => {
      offStep()
      offMode()
      if (agentToolTimer) { clearTimeout(agentToolTimer); agentToolTimer = null }
    }
  }, [])
}
