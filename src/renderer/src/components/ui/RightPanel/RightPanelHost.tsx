import { useState, useEffect, useCallback } from 'react'
import RightPanel from '../RightPanel/RightPanel'
import { useUIStore } from '../../../store/ui.store'
import { useChatStore } from '../../../store/chat.store'
import { useNavStore } from '../../../store/nav.store'

/**
 * Изолирует состояние правой панели (agentPanelOpen, focusAgentId) от App.
 *
 * Скрывается (display:none) когда mainPage !== 'chat' — иначе панель
 * видна сзади настроек/памяти/мессенджера, т.к. она сиблинг chat-area,
 * а не ребёнок (page-motion-host покрывает только chat-area).
 */
export default function RightPanelHost() {
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null)
  const agentPanelOpen = useUIStore(s => s.agentPanelOpen)
  const setAgentPanelOpen = useUIStore(s => s.setAgentPanelOpen)
  const currentChatId = useChatStore(s => s.currentChatId)
  const mainPage = useNavStore(s => s.mainPage)
  // Скрываем только при уходе с chat-страницы (настройки/память/мессенджер).
  // НЕ скрываем при agentPanelOpen=false — иначе close-анимация не отыграет
  // (display:none убивает её мгновенно). Ширину регулирует сама панель
  // через widthMV → 0.
  const visible = mainPage === 'chat'

  useEffect(() => {
    const handler = (e: Event) => {
      const agentId = (e as CustomEvent<{ agentId: string }>).detail?.agentId ?? null
      setFocusAgentId(agentId)
      setAgentPanelOpen(true)
      window.syntee.settings.set('agentPanelOpen', true)
    }
    window.addEventListener('open-agent-panel', handler)
    return () => window.removeEventListener('open-agent-panel', handler)
  }, [setAgentPanelOpen])

  const handleClose = useCallback(() => {
    setAgentPanelOpen(false)
    setFocusAgentId(null)
    window.syntee.settings.set('agentPanelOpen', false)
  }, [setAgentPanelOpen])

  return (
    <div style={{ display: visible ? 'flex' : 'none', height: '100%', flexShrink: 0 }}>
      <RightPanel
        open={agentPanelOpen}
        onClose={handleClose}
        focusAgentId={focusAgentId}
        currentChatId={currentChatId}
      />
    </div>
  )
}