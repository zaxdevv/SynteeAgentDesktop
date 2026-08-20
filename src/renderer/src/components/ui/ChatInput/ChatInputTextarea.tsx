import { motion, AnimatePresence } from 'framer-motion'
import { renderMirrorContent } from './ChatInputHelpers'

interface ChatInputTextareaProps {
  value: string
  onChange: (text: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  planningMode?: boolean
  askMode?: boolean
  imageMode?: boolean
  isIncognito?: boolean
  disabled?: boolean
  isGenerating?: boolean
}

/**
 * Обёртка textarea + mirror-слой для подсветки @упоминаний и slash-команд.
 * Mirror точно совпадает по шрифту/отступам с textarea и рендерит value с
 * подсветкой; pointer-events:none — клики идут в textarea. Скролл синхронизируется.
 */
export function ChatInputTextarea({
  value,
  onChange,
  onKeyDown,
  onPaste,
  textareaRef,
  planningMode,
  askMode,
  imageMode,
  isIncognito,
  disabled,
  isGenerating,
}: ChatInputTextareaProps) {
  return (
    <div className="chat-input-textarea-wrap">
      {/* Mirror-слой для подсветки @упоминаний. Точно совпадает по
          шрифту/отступам с textarea, рендерит value с подсветкой @токенов.
          pointer-events:none — клики идут в textarea. */}
      <div className="chat-input-mirror" aria-hidden="true">
        {renderMirrorContent(value)}
      </div>
      <textarea
        ref={textareaRef}
        className={`chat-input-textarea selectable${planningMode ? ' chat-input-textarea--planning' : ''}${askMode && !planningMode ? ' chat-input-textarea--ask' : ''}`}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onScroll={(e) => {
          const wrap = e.currentTarget.parentElement
          const mirror = wrap?.querySelector('.chat-input-mirror') as HTMLDivElement
          if (mirror) mirror.scrollTop = e.currentTarget.scrollTop
        }}
        placeholder={
          planningMode ? 'Режим планирования — опишите задачу...'
          : askMode ? 'Ask-режим — только чтение, задайте вопрос...'
          : imageMode ? 'Режим генерации изображений — опишите картинку...'
          : isIncognito ? 'Режим инкогнито — чат не сохраняется...'
          : 'Сообщение Syntee... (/ для команд, @ для файлов)'
        }
        rows={1}
        disabled={disabled && !isGenerating}
      />
    </div>
  )
}
