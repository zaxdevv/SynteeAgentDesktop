// ── Глобальная подписка на все IPC-события чатов. Монтируется ОДИН раз
// в App.tsx. Пишет в Zustand store по chatId — параллельные чаты каждый
// имеют свой LiveState, не перетирая друг друга.
// Перенесено из ChatPage.tsx (строки 218-481) чтобы:
// 1. События чужого чата не дропались при переключении
// 2. При возврате в чат показать накопленный прогресс
// 3. Sidebar мог показывать статус чата (spinner/✓/✗)
//
// Логика разбита на отдельные хуки (см. useStreamHandler / useToolProgress /
// useRunStatus / useAgentEvents) — этот файл остаётся точкой композиции и
// ре-экспортом module-level хелперов буферов для ChatPage/SideChatPanel.
import { useStreamHandler } from './useStreamHandler'
import { useToolProgress } from './useToolProgress'
import { useRunStatus } from './useRunStatus'
import { useAgentEvents } from './useAgentEvents'

// ── Re-export module-level хелперы/состояние буферов ──────────────────
// Используются ChatPage (initChatSend, hydrateFromMain, enqueuePendingUserMsg,
// removePendingUserMsg) и SideChatPanel (initSideChatSend). Логика и состояние
// теперь живут в chatRunRuntime.ts — здесь только проброс для обратной
// совместимости импортов.
export {
  initChatSend,
  hydrateFromMain,
  initSideChatSend,
  enqueuePendingUserMsg,
  removePendingUserMsg,
} from './chatRunRuntime'

export function useChatRunSubscription() {
  // Каждый суб-хук монтирует свою группу IPC-листенеров в отдельном эффекте
  // и сам снимает их при размонтировании. Aux-окна гейтятся внутри каждого.
  useStreamHandler()
  useToolProgress()
  useRunStatus()
  useAgentEvents()
}
