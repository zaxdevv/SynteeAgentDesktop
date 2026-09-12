/**
 * ChangesBadge — компактный бейдж над инпутом, показывает +N -M строк
 * изменённых в последнем запросе. Hover → popup со списком файлов и undo
 * (быстрый взгляд). Клик по бейджу / файлу / кнопке «Открыть в панели» →
 * правая панель «Сессия» с Monaco-диффом последнего запроса.
 *
 * Сбрасывается при новом send (CHAT_RUN_STATUS='running') или undo
 * (CHAT_FILES_RESTORED) — через store.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import FileIcon from '../FileIcon/FileIcon'
import { useUIStore } from '../../../store/ui.store'
import { useRightPanelTabsStore } from '../../../store/rightPanelTabs.store'
import type { LastTurnChanges } from '../../../../../shared/types'
import './ChangesBadge.css'

interface ChangesBadgeProps {
  chatId: string
  changes: LastTurnChanges
  /** Live-режим: shimmer/glow анимация, undo скрыт. */
  live?: boolean
}

const POPUP_W = 360
const HOVER_OPEN_DELAY = 120
const HOVER_CLOSE_DELAY = 220

/** Извлекает basename из пути (работает с / и \). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Внутренний счётчик: плавно увеличивается от from к to с ускорением
 *  (easeInCubic — медленный старт, быстрый финал). rAF для 60fps. */
function CounterAnim({ from, to, prefix }: { from: number; to: number; prefix: string }) {
  const [display, setDisplay] = useState(from)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (from === to) { setDisplay(to); return }
    const diff = Math.abs(to - from)
    const duration = Math.min(1500, Math.max(200, diff * 60))
    const start = performance.now()
    const ease = (t: number) => t * t * t

    const tick = (now: number) => {
      const elapsed = now - start
      const t = Math.min(1, elapsed / duration)
      setDisplay(Math.round(from + (to - from) * ease(t)))
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
      else { setDisplay(to); rafRef.current = null }
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [from, to])

  return <>{prefix}{display}</>
}

/** Slot-machine + counter: старая цифра уезжает вниз и исчезает,
 *  новая приезжает сверху — и внутри неё значение плавно растёт
 *  от старого к новому с ускорением. */
function RollingNumber({ value, prefix, className }: { value: number; prefix: string; className: string }) {
  const [round, setRound] = useState(0)
  const fromRef = useRef(value)

  useEffect(() => {
    if (fromRef.current !== value) {
      setRound(r => r + 1)
    }
  }, [value])

  return (
    <span className="changes-badge-roll">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={round}
          className={className}
          initial={{ y: -18, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 18, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 600, damping: 22 }}
          onAnimationComplete={() => { fromRef.current = value }}
        >
          <CounterAnim from={fromRef.current} to={value} prefix={prefix} />
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

export default function ChangesBadge({ chatId, changes, live = false }: ChangesBadgeProps) {
  const [open, setOpen] = useState(false)
  const [dropPos, setDropPos] = useState<{ bottom: number; left: number; width: number } | null>(null)
  const [undoing, setUndoing] = useState<string | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  const { files, totalAdded, totalDeleted } = changes

  const computeDropPos = useCallback(() => {
    if (!btnRef.current) return null
    const r = btnRef.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POPUP_W - 8))
    return { bottom: window.innerHeight - r.top + 6, left, width: POPUP_W }
  }, [])

  const clearTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
  }, [])

  const close = useCallback(() => {
    clearTimers()
    setOpen(false)
  }, [clearTimers])

  const handleMouseEnter = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    if (open) return
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(() => {
      const pos = computeDropPos()
      if (pos) { setDropPos(pos); setOpen(true) }
    }, HOVER_OPEN_DELAY)
  }, [open, computeDropPos])

  const handleMouseLeave = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null }
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => {
      setOpen(false)
    }, HOVER_CLOSE_DELAY)
  }, [])

  // ── Открытие правой панели «Сессия» ──
  // Клик по бейджу / строке файла / кнопке «Открыть в панели».
  // focusSessionChanges инкрементит nonce — SessionChangesPanel по нему
  // перезагружает последний чекпоинт с правками и выделяет файл (если передан).
  const openChangesPanel = useCallback((filePath?: string) => {
    close()
    useUIStore.getState().focusSessionChanges(filePath ?? null)
    useRightPanelTabsStore.getState().openPanel('session')
    useUIStore.getState().setAgentPanelTab('session')
    useUIStore.getState().setAgentPanelOpen(true)
  }, [close])

  const handleClick = useCallback(() => {
    openChangesPanel()
  }, [openChangesPanel])

  useEffect(() => {
    return () => {
      if (openTimer.current) clearTimeout(openTimer.current)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [])

  // ── Undo handlers ──
  const handleUndoFile = useCallback(async (filePath: string) => {
    if (undoing) return
    const name = basename(filePath)
    const confirmed = window.confirm(
      `Отменить изменения в файле «${name}»?\n\n` +
      `Файл будет восстановлен к состоянию до этого запроса.`
    )
    if (!confirmed) return
    setUndoing(filePath)
    try {
      const result = await window.syntee.chat.undoFile(chatId, filePath)
      if (result?.error) {
        window.alert(`Ошибка: ${result.error}`)
      }
      // CHAT_FILES_RESTORED сбросит бейдж через store
    } catch (e) {
      window.alert(`Ошибка: ${(e as Error).message}`)
    } finally {
      setUndoing(null)
    }
  }, [chatId, undoing])

  const handleUndoAll = useCallback(async () => {
    if (undoing) return
    const confirmed = window.confirm(
      `Отменить все изменения последнего запроса?\n\n` +
      `${files.length} файл(ов) будет восстановлено к состоянию до запроса.\n` +
      `Сообщения диалога останутся без изменений.`
    )
    if (!confirmed) return
    setUndoing('__all__')
    try {
      const result = await window.syntee.chat.undoLastTurnFiles(chatId)
      if (result?.error) {
        window.alert(`Ошибка: ${result.error}`)
      }
    } catch (e) {
      window.alert(`Ошибка: ${(e as Error).message}`)
    } finally {
      setUndoing(null)
    }
  }, [chatId, files.length, undoing])

  return (
    <motion.div
      className="changes-badge-wrap"
      initial={{ opacity: 0, scale: 0.5, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.5, y: 8 }}
      transition={{ type: 'spring', stiffness: 500, damping: 28 }}
    >
      <motion.button
        ref={btnRef}
        className={`changes-badge-pill${live ? ' changes-badge-pill--live' : ''}`}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        whileTap={{ scale: 0.96 }}
        whileHover={{ scale: 1.04 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        title={`Изменения: +${totalAdded} -${totalDeleted} строк в ${files.length} файл(ах)\nКлик — открыть в панели «Сессия»`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12"/>
          <path d="M8 9l4-4 4 4"/>
          <path d="M3 17l3 3 3-3"/>
          <path d="M3 20h6"/>
          <path d="M15 14l3-3 3 3"/>
          <path d="M15 17h6"/>
        </svg>
        <RollingNumber value={totalAdded} prefix="+" className="changes-badge-added" />
        <RollingNumber value={totalDeleted} prefix="-" className="changes-badge-deleted" />
        {files.length > 1 && (
          <span className="changes-badge-files">{files.length} файлах</span>
        )}
      </motion.button>

      {createPortal(
        <AnimatePresence>
          {open && dropPos && (
            <motion.div
              ref={dropRef}
              className="changes-popup"
              style={{ position: 'fixed', left: dropPos.left, bottom: dropPos.bottom, width: dropPos.width, zIndex: 9999 }}
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              <div className="changes-popup-header">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v12"/>
                  <path d="M8 9l4-4 4 4"/>
                  <path d="M3 17l3 3 3-3"/>
                  <path d="M3 20h6"/>
                  <path d="M15 14l3-3 3 3"/>
                  <path d="M15 17h6"/>
                </svg>
                <span className="changes-popup-title">Изменения в запросе</span>
                <span className="changes-popup-count">+{totalAdded} -{totalDeleted}</span>
              </div>
              <div className="changes-popup-body">
                <div className="changes-popup-group-label">Файлы ({files.length})</div>
                <div className="changes-popup-files">
                  {files.map(f => (
                  <div
                    key={f.path}
                    className="changes-popup-file changes-popup-file--link"
                    onClick={() => openChangesPanel(f.path)}
                    title={`Открыть дифф в панели: ${f.path}`}
                  >
                    <FileIcon name={basename(f.path)} size={15} />
                    <span className="changes-popup-file-name" title={f.path}>
                      {basename(f.path)}
                    </span>
                    <span className="changes-popup-file-stats">
                      <span className="changes-popup-stat-added">+{f.added}</span>
                      <span className="changes-popup-stat-deleted">-{f.deleted}</span>
                    </span>
                    {!live && (
                      <button
                        className="changes-popup-undo-btn"
                        onClick={(e) => { e.stopPropagation(); void handleUndoFile(f.path) }}
                        disabled={!!undoing}
                        title="Отменить изменения в этом файле"
                      >
                          {undoing === f.path ? (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
                              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                            </svg>
                          ) : (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 7v6h6"/>
                              <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
                            </svg>
                          )}
                        </button>
                      )}
                      <AppIcon name="chevronRight" size="xs" tone="muted" className="changes-popup-file-chevron" />
                    </div>
                  ))}
                </div>
              </div>
              {!live ? (
                <div className="changes-popup-footer">
                  <button
                    className="changes-popup-open-btn"
                    onClick={() => openChangesPanel()}
                    title="Открыть изменения в правой панели"
                  >
                    <AppIcon name="panelRight" size="xs" />
                    Открыть в панели
                  </button>
                  <button
                    className="changes-popup-undo-all"
                    onClick={handleUndoAll}
                    disabled={!!undoing}
                  >
                    {undoing === '__all__' ? (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
                          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                        </svg>
                        Отмена...
                      </>
                    ) : (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 7v6h6"/>
                          <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
                        </svg>
                        Отменить все
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div className="changes-popup-live-hint">
                  <span className="changes-popup-live-dot" />
                  <span className="changes-popup-live-text">Изменения применяются…</span>
                  <button
                    className="changes-popup-open-btn"
                    onClick={() => openChangesPanel()}
                    title="Открыть изменения в правой панели"
                  >
                    <AppIcon name="panelRight" size="xs" />
                    Открыть в панели
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </motion.div>
  )
}
