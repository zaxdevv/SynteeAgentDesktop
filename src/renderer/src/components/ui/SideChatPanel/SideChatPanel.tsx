import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import MessageBubble from '../MessageBubble/MessageBubble'
import { useChatStore } from '../../../store/chat.store'
import { initSideChatSend } from '../../../hooks/useChatRunSubscription'
import type { Message } from '../../../../shared/types'
import { whileHoverTiny, whileTapTiny, springHover } from '../../../utils/motionPresets'
import '../MessageBubble/MessageBubble.css'
import './SideChatPanel.css'

interface SideChatPanelProps {
  currentChatId: string | null
}

const EMPTY_MESSAGES: Message[] = []

export default function SideChatPanel({ currentChatId }: SideChatPanelProps) {
  const sideChat = useChatStore(s => currentChatId ? s.sideChatByChat[currentChatId] : undefined)
  const addSideMessage = useChatStore(s => s.addSideMessage)
  const resetSideChat = useChatStore(s => s.resetSideChat)
  const setSideRunStatus = useChatStore(s => s.setSideRunStatus)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const messages = sideChat?.messages ?? EMPTY_MESSAGES
  const live = sideChat?.live
  const runStatus = sideChat?.runStatus
  const isRunning = runStatus === 'running' || runStatus === 'queued'
  const showLiveBubble = !!live?.isTyping || !!live?.isAgentRunning

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, showLiveBubble, live?.text, scrollToBottom])

  // Live-пузырь строим как synthetic Message — MessageBubble умеет рендерить
  // стриминг через liveIters/liveTextAfter/agentStatus (как ChatPage).
  const displayMessages = useMemo(() => {
    if (!showLiveBubble || !live) return messages
    return [...messages, {
      id: 'side-live-streaming-bubble',
      chatId: `sidechat:${currentChatId ?? ''}`,
      role: 'assistant' as const,
      content: '',
      createdAt: 0,
      isPinned: 0,
      toolSteps: live.steps.length > 0 ? live.steps as Message['toolSteps'] : undefined,
      liveIters: live.iters,
      liveTextAfter: live.text,
      liveTodo: live.todo,
      agentStatus: live.agentStatus,
      toolProgress: live.toolProgress,
      spawnedAgents: live.spawnedAgents,
      rateLimitSec: live.rateLimitSec > 0 ? live.rateLimitSec : undefined,
    } as Message & Record<string, unknown>]
  }, [messages, showLiveBubble, live, currentChatId])

  const handleSend = async () => {
    if (!currentChatId || !input.trim() || isRunning) return
    const content = input.trim()
    setInput('')

    const userMsg: Message = {
      id: `side-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      chatId: `sidechat:${currentChatId}`,
      role: 'user',
      content,
      createdAt: Date.now(),
      isPinned: 0,
    }
    addSideMessage(currentChatId, userMsg)
    setSideRunStatus(currentChatId, 'running')

    const allMessages = [...messages, userMsg]
    initSideChatSend(currentChatId)

    try {
      await window.syntee.chat.sideSend({
        parentChatId: currentChatId,
        content,
        sideMessages: allMessages,
      })
    } catch {
      setSideRunStatus(currentChatId, 'error')
    }
  }

  const handleStop = () => {
    if (!currentChatId) return
    window.syntee.chat.stop(`sidechat:${currentChatId}`)
  }

  const handleReset = () => {
    if (!currentChatId) return
    if (isRunning) handleStop()
    resetSideChat(currentChatId)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!currentChatId) {
    return (
      <div className="side-chat side-chat--empty">
        <AppIcon name="messageSquare" size="lg" tone="muted" />
        <p>Выберите чат</p>
        <p className="side-chat__hint">Параллельный чат доступен когда открыт основной чат</p>
      </div>
    )
  }

  return (
    <div className="side-chat">
      <div className="side-chat__header">
        <div className="side-chat__title">
          <AppIcon name="messageSquare" size="xs" />
          <span>Доп-чат</span>
          {isRunning && <AppIcon name="loader" size="xs" animation="spin" />}
        </div>
        {messages.length > 0 && (
          <motion.button
            className="side-chat__reset"
            onClick={handleReset}
            title="Сбросить доп-чат"
            whileHover={whileHoverTiny}
            whileTap={whileTapTiny}
            transition={springHover}
          >
            <AppIcon name="trash" size="xs" />
          </motion.button>
        )}
      </div>

      <div className="side-chat__messages" ref={scrollRef}>
        {messages.length === 0 && !showLiveBubble && (
          <div className="side-chat__empty">
            <AppIcon name="messageSquare" size="lg" className="side-chat__empty-icon" />
            <p>Параллельный чат</p>
            <span>Задайте вопрос здесь, не мешая основному чату.
              Агент видит сводку основного чата и может запросить
              его сообщения через тул.</span>
          </div>
        )}
        {displayMessages.map(msg => {
          const isLive = (msg as Message & { id: string }).id === 'side-live-streaming-bubble'
          return (
            <MessageBubble
              key={(msg as Message & { id: string }).id}
              message={msg as Message}
              isStreaming={isLive && isRunning}
              isWaiting={isLive && isRunning}
              liveThinking={isLive && live?.thinking ? { text: live.thinking, isLive: live.isThinkingLive, ms: live.thinkingMs } : undefined}
            />
          )
        })}
      </div>

      <div className="side-chat__input-area">
        <div className="side-chat__input-box">
          <textarea
            className="side-chat__input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? 'Агент отвечает…' : 'Сообщение доп-чату…'}
            disabled={isRunning}
            rows={1}
          />
          {isRunning ? (
            <motion.button className="side-chat__stop" onClick={handleStop} title="Остановить" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
              <AppIcon name="x" size="xs" />
            </motion.button>
          ) : (
            <motion.button
              className="side-chat__send"
              onClick={handleSend}
              disabled={!input.trim()}
              title="Отправить"
              whileHover={whileHoverTiny}
              whileTap={whileTapTiny}
              transition={springHover}
            >
              <AppIcon name="send" size="xs" />
            </motion.button>
          )}
        </div>
      </div>
    </div>
  )
}
