import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import Logo from '../../components/ui/Logo/Logo'
import './VoicePage.css'

type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking' | 'error'

// Web Speech API types
declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition
    webkitSpeechRecognition: new () => SpeechRecognition
  }
  interface SpeechRecognition extends EventTarget {
    lang: string
    continuous: boolean
    interimResults: boolean
    maxAlternatives: number
    start(): void
    stop(): void
    abort(): void
    onstart: ((this: SpeechRecognition, ev: Event) => void) | null
    onend: ((this: SpeechRecognition, ev: Event) => void) | null
    onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null
    onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null
  }
  interface SpeechRecognitionErrorEvent extends Event { error: string }
  interface SpeechRecognitionEvent extends Event {
    results: SpeechRecognitionResultList
  }
  interface SpeechRecognitionResultList {
    length: number
    item(index: number): SpeechRecognitionResult
    [index: number]: SpeechRecognitionResult
  }
  interface SpeechRecognitionResult {
    isFinal: boolean
    [index: number]: SpeechRecognitionAlternative
  }
  interface SpeechRecognitionAlternative {
    transcript: string
    confidence: number
  }
}

export default function VoicePage() {
  const [state, setState] = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState('')
  const [interimText, setInterimText] = useState('')
  const [responseText, setResponseText] = useState('')
  const [streamText, setStreamText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const sendQuery = useCallback(async (text: string) => {
    setState('processing')
    await (window.syntee as any).voice?.sendQuery(text)
  }, [])

  const speakResponse = useCallback(async (text: string) => {
    setState('speaking')
    try {
      const base64 = await (window.syntee as any).voice?.tts(text)
      if (base64) {
        const audio = new Audio(`data:audio/mp3;base64,${base64}`)
        audioRef.current = audio
        audio.onended = () => setState('idle')
        audio.play()
      } else {
        setState('idle')
      }
    } catch {
      setState('idle')
    }
  }, [])

  const handleClose = useCallback(() => {
    recognitionRef.current?.abort()
    audioRef.current?.pause()
    window.syntee.window.hide()
  }, [])

  // Слушаем стриминг ответа из main
  useEffect(() => {
    const offToken = window.syntee.on('chat:stream:token', (data: { token: string; source: string }) => {
      if (data.source !== 'voice') return
      setStreamText(prev => prev + data.token)
    })
    const offDone = window.syntee.on('chat:stream:done', (data: { text: string; source: string }) => {
      if (data.source !== 'voice') return
      setResponseText(data.text)
      setStreamText('')
      speakResponse(data.text)
    })
    return () => { offToken(); offDone() }
  }, [speakResponse])

  // Закрыть по Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleClose])

  const startListening = useCallback(() => {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRec) {
      setErrorMsg('Распознавание речи не поддерживается')
      setState('error')
      return
    }

    const recognition = new SpeechRec()
    recognition.lang = 'ru-RU'
    recognition.continuous = false
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onstart = () => setState('listening')
    recognition.onend = () => {
      if (state === 'listening') setState('processing')
    }
    recognition.onerror = (e) => {
      setErrorMsg('Ошибка: ' + e.error)
      setState('error')
    }
    recognition.onresult = (e) => {
      let interim = ''
      let final = ''
      for (let i = e.results.length - 1; i >= 0; i--) {
        if (e.results[i].isFinal) {
          final = e.results[i][0].transcript
        } else {
          interim = e.results[i][0].transcript
        }
      }
      setInterimText(interim)
      if (final) {
        setTranscript(final)
        setInterimText('')
        recognition.stop()
        sendQuery(final)
      }
    }

    recognitionRef.current = recognition
    recognition.start()
    setState('listening')
    setTranscript('')
    setInterimText('')
    setResponseText('')
    setStreamText('')
  }, [state, sendQuery])

  const handleMicClick = () => {
    if (state === 'listening') {
      recognitionRef.current?.stop()
      setState('idle')
    } else if (state === 'idle' || state === 'error') {
      startListening()
    } else if (state === 'speaking') {
      audioRef.current?.pause()
      setState('idle')
    }
  }

  const displayText = interimText || transcript || (streamText || responseText)
  const isAnimating = state === 'listening' || state === 'speaking'

  return (
    <div className="voice-root" onClick={e => e.target === e.currentTarget && handleClose()}>
      <motion.div
        className="voice-container glass"
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 380, damping: 28 }}
      >
        {/* Логотип */}
        <div className="voice-logo">
          <Logo size={32} />
          <span>Syntee</span>
        </div>

        {/* Волна */}
        <div className="voice-wave-area">
          <AnimatePresence>
            {isAnimating && (
              <motion.div
                className={`voice-wave ${state === 'speaking' ? 'voice-wave--speaking' : 'voice-wave--listening'}`}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
              >
                {Array.from({ length: 7 }).map((_, i) => (
                  <motion.div
                    key={i}
                    className="voice-wave-bar"
                    animate={{
                      scaleY: [0.3, 1, 0.3],
                      opacity: [0.4, 1, 0.4],
                    }}
                    transition={{
                      duration: 0.8 + i * 0.1,
                      repeat: Infinity,
                      delay: i * 0.12,
                      ease: 'easeInOut',
                    }}
                  />
                ))}
              </motion.div>
            )}
            {!isAnimating && state !== 'processing' && (
              <motion.button
                className="voice-mic-btn"
                onClick={handleMicClick}
                whileHover={{ scale: 1.06 }}
                whileTap={{ scale: 0.93 }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                  <rect x="9" y="2" width="10" height="16" rx="5" stroke="currentColor" strokeWidth="1.8"/>
                  <path d="M4 14c0 5.52 4.48 10 10 10s10-4.48 10-10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  <line x1="14" y1="24" x2="14" y2="28" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
              </motion.button>
            )}
            {state === 'processing' && (
              <motion.div className="voice-processing" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <span className="voice-spinner" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Статус */}
        <div className="voice-status">
          {state === 'idle' && <span>Нажмите микрофон</span>}
          {state === 'listening' && <span className="voice-status--active">Слушаю...</span>}
          {state === 'processing' && <span>Думаю...</span>}
          {state === 'speaking' && <span className="voice-status--active">Отвечаю</span>}
          {state === 'error' && <span className="voice-status--error">{errorMsg}</span>}
        </div>

        {/* Текст */}
        <AnimatePresence>
          {displayText && (
            <motion.div
              className="voice-text"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              {interimText ? (
                <p className="voice-text--interim">{interimText}</p>
              ) : transcript && !responseText && !streamText ? (
                <p className="voice-text--query">&ldquo;{transcript}&rdquo;</p>
              ) : (
                <p className="voice-text--response">
                  {streamText || responseText}
                  {state === 'processing' && <span className="voice-cursor">▋</span>}
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Кнопка закрыть */}
        <motion.button
          className="voice-close-btn"
          onClick={handleClose}
          whileTap={{ scale: 0.88 }}
        >
          ESC — закрыть
        </motion.button>
      </motion.div>
    </div>
  )
}
