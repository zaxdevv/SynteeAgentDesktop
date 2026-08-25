import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { whileHoverSm, whileTapSm, springHover } from '../../../utils/motionPresets'
import './ChatSearch.css'

interface ChatSearchProps {
  messages: { id: string; content: string; role: string }[]
  onMatchIds: (ids: string[], query: string) => void
  onClose: () => void
}

export default function ChatSearch({ messages, onMatchIds, onClose }: ChatSearchProps) {
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [currentIdx, setCurrentIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const matchIdsRef = useRef<string[]>([])

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    if (!query.trim()) {
      onMatchIds([], '')
      setMatchCount(0)
      setCurrentIdx(0)
      matchIdsRef.current = []
      return
    }
    // ── Debounce 200мс — раньше O(n) filter по всем сообщениям на каждое нажатие ──
    // Для чатов с тысячами сообщений — фриз на каждое нажатие клавиши.
    const q = query.toLowerCase()
    const timer = setTimeout(() => {
      const ids = messages
        .filter(m => m.content.toLowerCase().includes(q))
        .map(m => m.id)
      matchIdsRef.current = ids
      setMatchCount(ids.length)
      setCurrentIdx(ids.length > 0 ? 1 : 0)
      onMatchIds(ids, query)
      if (ids.length > 0) scrollToMatch(ids[0])
    }, 200)
    return () => clearTimeout(timer)
  }, [query, messages])

  const scrollToMatch = (id: string) => {
    const el = document.querySelector(`[data-msg-id="${id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const goPrev = () => {
    if (!matchIdsRef.current.length) return
    const next = currentIdx <= 1 ? matchIdsRef.current.length : currentIdx - 1
    setCurrentIdx(next)
    scrollToMatch(matchIdsRef.current[next - 1])
  }

  const goNext = () => {
    if (!matchIdsRef.current.length) return
    const next = currentIdx >= matchIdsRef.current.length ? 1 : currentIdx + 1
    setCurrentIdx(next)
    scrollToMatch(matchIdsRef.current[next - 1])
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); onMatchIds([]) }
    if (e.key === 'Enter') e.shiftKey ? goPrev() : goNext()
  }

  return (
    <div className="chat-search-bar">
      <input
        ref={inputRef}
        className="chat-search-input"
        placeholder="Поиск в чате..."
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKey}
      />
      <span className="chat-search-count">
        {matchCount > 0 ? `${currentIdx} / ${matchCount}` : query ? '0 совпадений' : ''}
      </span>
      <motion.button className="chat-search-nav" onClick={goPrev} disabled={!matchCount} title="Предыдущее (Shift+Enter)" whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
        ↑
      </motion.button>
      <motion.button className="chat-search-nav" onClick={goNext} disabled={!matchCount} title="Следующее (Enter)" whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
        ↓
      </motion.button>
      <motion.button className="chat-search-close" onClick={() => { onClose(); onMatchIds([], '') }} whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
        ✕
      </motion.button>
    </div>
  )
}
