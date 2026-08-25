import { useState, useRef, useEffect, useCallback } from 'react'
import { useSettingsStore } from '../../../store/settings.store'
import { useVoiceInput } from '../../../hooks/useVoiceInput'

interface UseChatInputVoiceOptions {
  value: string
  onChangeValue: (text: string) => void
  textareaRef: React.RefObject<HTMLDivElement>
}

/**
 * Голосовой ввод (STT) в инпут-баре + анимированная «печать» распознанного
 * текста по словам. Вынесено из ChatInput.tsx, чтобы не раздувать god-компонент.
 *
 * Провайдер и размер модели читаются из персистентных настроек (electron-store).
 * 'local' — локальный Whisper (оффлайн), 'groq' — Groq API fallback.
 * 'webspeech' обрабатывается отдельно (live, прямо в textarea) — пока не MVP.
 */
export function useChatInputVoice({ value, onChangeValue, textareaRef }: UseChatInputVoiceOptions) {
  const sttProvider = useSettingsStore(s => (s.settings['sttProvider'] as 'local' | 'groq') ?? 'local')
  const sttModelSize = useSettingsStore(s => (s.settings['sttModelSize'] as 'tiny' | 'base') ?? 'tiny')

  // Value до начала записи — для восстановления при cancel/error.
  const preVoiceValueRef = useRef('')

  const voice = useVoiceInput({
    provider: sttProvider,
    modelSize: sttModelSize,
  })

  // При начале записи — сохраняем текущий value как базу.
  useEffect(() => {
    if (voice.state === 'requesting') {
      preVoiceValueRef.current = value
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.state])

  // При cancel/error — восстанавливаем исходный value.
  useEffect(() => {
    if (voice.state === 'error') {
      onChangeValue(preVoiceValueRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.state])

  // Анимированная «печать» распознанного текста по словам. Таймер хранится в
  // ref чтобы survive re-render'ы; ref на callback для доступа к свежему value.
  const voiceTypingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const voiceWordsQueueRef = useRef<string[]>([])
  const valueRef = useRef(value)
  valueRef.current = value
  const [isVoiceTyping, setIsVoiceTyping] = useState(false)

  // Стоп анимации печати (и финальный flush текста).
  const stopVoiceTyping = useCallback(() => {
    if (voiceTypingRef.current) {
      clearInterval(voiceTypingRef.current)
      voiceTypingRef.current = null
    }
    voiceWordsQueueRef.current = []
    setIsVoiceTyping(false)
  }, [])

  // Запуск анимированной печати: дробим text на слова, печатаем по ~55ms/слово.
  const startVoiceTyping = useCallback((text: string) => {
    stopVoiceTyping()
    const words = text.split(/\s+/).filter(Boolean)
    if (words.length === 0) return
    voiceWordsQueueRef.current = words
    setIsVoiceTyping(true)
    // Если в поле уже есть текст — добавляем пробел перед голосовым фрагментом.
    const sep = valueRef.current && !valueRef.current.endsWith(' ') && !valueRef.current.endsWith('\n') ? ' ' : ''
    let acc = valueRef.current + sep
    voiceTypingRef.current = setInterval(() => {
      const w = voiceWordsQueueRef.current.shift()
      if (!w) { stopVoiceTyping(); return }
      acc = (acc && !acc.endsWith(' ') ? acc + ' ' : acc) + w
      onChangeValue(acc)
      // Прокрутка в конец после каждого слова.
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) { el.scrollTop = el.scrollHeight }
      })
    }, 55)
  }, [stopVoiceTyping, onChangeValue, textareaRef])

  // При ошибке/прерывании — останавливаем анимацию.
  useEffect(() => {
    if (voice.state === 'error' || voice.state === 'idle') {
      // если таймер ещё активен и очередь не пуста — продолжаем печатать (idle
      // после успешного stop() — анимация должна докрутиться). Прерываем только
      // при явной ошибке.
      if (voice.state === 'error') stopVoiceTyping()
    }
  }, [voice.state, stopVoiceTyping])

  // Cleanup при unmount.
  useEffect(() => {
    return () => stopVoiceTyping()
  }, [stopVoiceTyping])

  // ── Клик по кнопке mic: toggle запись ──
  // idle/error → start(); recording → stop() → восстановить базу + анимация
  //   печати финального текста по словам.
  const handleMicClick = useCallback(() => {
    if (voice.state === 'idle' || voice.state === 'error') {
      void voice.start()
    } else if (voice.state === 'recording') {
      void voice.stop().then(text => {
        if (!text) return
        // Восстанавливаем базу (pre-voice value) и анимированно печатаем финал.
        const base = preVoiceValueRef.current
        onChangeValue(base)
        valueRef.current = base
        startVoiceTyping(text)
      })
    }
    // transcribing — игнорируем (идёт распознавание, дождитесь)
  }, [voice, startVoiceTyping, onChangeValue])

  return { voice, isVoiceTyping, handleMicClick }
}
