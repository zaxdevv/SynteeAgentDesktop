/**
 * ExtensionsBadge — компактный бейдж над инпутом, показывает кол-во активных
 * скиллов и MCP-серверов для текущего чата. Скрыт когда ничего не включено.
 *
 * Drill-down popup (как QueuePanel, паттерн hover/pin/portal):
 *   Level 1 (список): две группы — Skills и MCP, с краткими именами.
 *   Level 2 (деталь): клик по элементу → описание, для MCP — список тулов.
 *   Кнопка «назад» возвращается к списку. Быстрый тумблер выкл прямо в детали.
 *
 * Скрывается в инкогнито (loadActiveForChat возвращает пустые списки).
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import { useExtensionsStore } from '../../../store/extensions.store'
import type { Skill, McpServerRuntime } from '../../../../../shared/types'
import { mcpStatusLabel, McpLogsList } from '../ExtensionsPopover/ExtensionsPopover'
import { whileHoverTiny, whileTapTiny, whileHoverSm, whileTapSm, springHover } from '../../../utils/motionPresets'
import '../ExtensionsPopover/ExtensionsPopover.css'

interface ExtensionsBadgeProps {
  chatId: string
  isIncognito?: boolean
}

const POPUP_W = 340
const HOVER_OPEN_DELAY = 120
const HOVER_CLOSE_DELAY = 220

type DetailView =
  | { kind: 'list' }
  | { kind: 'skill'; id: string }
  | { kind: 'mcp'; id: string }

export default function ExtensionsBadge({ chatId, isIncognito }: ExtensionsBadgeProps) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dropPos, setDropPos] = useState<{ bottom: number; left: number; width: number } | null>(null)
  const [view, setView] = useState<DetailView>({ kind: 'list' })
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  const activeSkillIds = useExtensionsStore(s => s.activeSkillIds)
  const activeMcpServerIds = useExtensionsStore(s => s.activeMcpServerIds)
  const skills = useExtensionsStore(s => s.skills)
  const mcpServers = useExtensionsStore(s => s.mcpServers)
  const loadActiveForChat = useExtensionsStore(s => s.loadActiveForChat)

  // Загружаем активные расширения при смене чата/инкогнито.
  // Также пересчитываем при изменении mcpServers — push-события mcp:status
  // обновляют статусы серверов (connecting→connected→error), и бейдж должен
  // реагировать сразу, а не ждать ручного открытия popover.
  useEffect(() => {
    loadActiveForChat(chatId, isIncognito)
  }, [chatId, isIncognito, loadActiveForChat, mcpServers])

  const total = activeSkillIds.length + activeMcpServerIds.length
  const hasItems = total > 0

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
    setPinned(false)
    setView({ kind: 'list' })
  }, [clearTimers])

  const handleMouseEnter = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    if (open || pinned) return
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(() => {
      const pos = computeDropPos()
      if (pos) { setDropPos(pos); setOpen(true) }
    }, HOVER_OPEN_DELAY)
  }, [open, pinned, computeDropPos])

  const handleMouseLeave = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null }
    if (pinned) return
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => {
      setOpen(false)
      setView({ kind: 'list' })
    }, HOVER_CLOSE_DELAY)
  }, [pinned])

  const handleClick = useCallback(() => {
    if (pinned) {
      close()
    } else {
      clearTimers()
      const pos = computeDropPos()
      if (pos) setDropPos(pos)
      setOpen(true)
      setPinned(true)
    }
  }, [pinned, close, clearTimers, computeDropPos])

  // Закрытие по клику снаружи и ESC (только в зафиксированном режиме)
  useEffect(() => {
    if (!open || !pinned) return
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      if (dropRef.current?.contains(e.target as Node)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, pinned, close])

  useEffect(() => {
    return () => {
      if (openTimer.current) clearTimeout(openTimer.current)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [])

  if (!hasItems) return null

  const activeSkills = skills.filter(s => activeSkillIds.includes(s.id))
  const activeMcp = mcpServers.filter(s => activeMcpServerIds.includes(s.id))

  return (
    <div className="ext-badge-wrap">
      <motion.button
        ref={btnRef}
        className="ext-badge-pill"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        whileTap={{ scale: 0.96 }}
        whileHover={{ scale: 1.04 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        title={`${activeSkills.length} скиллов · ${activeMcp.length} MCP`}
      >
        <AppIcon name="puzzle" size="xs" />
        {activeSkills.length > 0 && (
          <>
            <span className="ext-badge-count">{activeSkills.length}</span>
            <span style={{ opacity: 0.85 }}>скиллов</span>
          </>
        )}
        {activeSkills.length > 0 && activeMcp.length > 0 && <span className="ext-badge-sep">·</span>}
        {activeMcp.length > 0 && (
          <>
            <span className="ext-badge-count">{activeMcp.length}</span>
            <span style={{ opacity: 0.85 }}>MCP</span>
          </>
        )}
      </motion.button>

      {createPortal(
        <AnimatePresence>
          {open && dropPos && (
            <motion.div
              ref={dropRef}
              className="ext-popup"
              style={{ position: 'fixed', left: dropPos.left, bottom: dropPos.bottom, width: dropPos.width, zIndex: 9999 }}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{
                duration: 0.22,
                ease: [0.16, 1, 0.3, 1],
                exit: { duration: 0.14, ease: 'easeIn' },
              }}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              {view.kind === 'list' && (
                <ListLevel
                  skills={activeSkills}
                  mcp={activeMcp}
                  onOpenSkill={id => setView({ kind: 'skill', id })}
                  onOpenMcp={id => setView({ kind: 'mcp', id })}
                />
              )}
              {view.kind === 'skill' && (
                <SkillDetail
                  skill={activeSkills.find(s => s.id === view.id)}
                  onBack={() => setView({ kind: 'list' })}
                />
              )}
              {view.kind === 'mcp' && (
                <McpDetail
                  server={activeMcp.find(s => s.id === view.id)}
                  onBack={() => setView({ kind: 'list' })}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}

// ── Level 1: список ─────────────────────────────────────────────────────────

function ListLevel({
  skills,
  mcp,
  onOpenSkill,
  onOpenMcp,
}: {
  skills: Skill[]
  mcp: McpServerRuntime[]
  onOpenSkill: (id: string) => void
  onOpenMcp: (id: string) => void
}) {
  return (
    <>
      <div className="ext-popup-header">
        <AppIcon name="puzzle" size="xs" tone="accent" />
        <span className="ext-popup-title">Активные расширения</span>
        <span className="ext-popup-count">{skills.length + mcp.length}</span>
      </div>
      <div className="ext-popup-body">
        {skills.length > 0 && (
          <>
            <div className="ext-popup-group-label">Skills</div>
            {skills.map(s => (
              <div key={s.id} className="ext-popup-item" onClick={() => onOpenSkill(s.id)}>
                <span className="ext-popup-item-icon"><AppIcon name="puzzle" size="xs" /></span>
                <div className="ext-popup-item-main">
                  <div className="ext-popup-item-name">{s.name}</div>
                  {s.description && <div className="ext-popup-item-meta">{s.description}</div>}
                </div>
                <span className="ext-popup-item-chev"><AppIcon name="chevronRight" size="xs" /></span>
              </div>
            ))}
          </>
        )}
        {mcp.length > 0 && (
          <>
            <div className="ext-popup-group-label">MCP</div>
            {mcp.map(srv => (
              <div key={srv.id} className="ext-popup-item" onClick={() => onOpenMcp(srv.id)}>
                <span className="ext-popup-item-icon">
                  <AppIcon name="server" size="xs" />
                </span>
                <div className="ext-popup-item-main">
                  <div className="ext-popup-item-name">{srv.name}</div>
                  <div className="ext-popup-item-meta">
                    {srv.tools.length} тулов · {srv.transport}
                  </div>
                </div>
                <span className="ext-popup-item-chev"><AppIcon name="chevronRight" size="xs" /></span>
              </div>
            ))}
          </>
        )}
        {skills.length === 0 && mcp.length === 0 && (
          <div className="ext-empty">Нет активных расширений</div>
        )}
      </div>
    </>
  )
}

// ── Level 2: деталь скилла ──────────────────────────────────────────────────

function SkillDetail({ skill, onBack }: { skill: Skill | undefined; onBack: () => void }) {
  if (!skill) return <div className="ext-empty">Не найдено</div>
  return (
    <>
      <div className="ext-popup-header">
        <motion.button className="ext-popup-back" onClick={onBack} title="Назад" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
          <AppIcon name="chevronLeft" size="xs" />
        </motion.button>
        <span className="ext-popup-title">Скилл</span>
      </div>
      <div className="ext-popup-body">
        <div className="ext-detail">
          <div className="ext-detail-name">{skill.name}</div>
          {skill.description && <div className="ext-detail-desc">{skill.description}</div>}
          <div className="ext-detail-section">
            <div className="ext-detail-section-label">Инструкции</div>
            <div className="ext-detail-tool">
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5, fontSize: '11px' }}>
                {skill.instructions.slice(0, 800)}{skill.instructions.length > 800 ? '…' : ''}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Level 2: деталь MCP-сервера ─────────────────────────────────────────────

function McpDetail({ server, onBack }: { server: McpServerRuntime | undefined; onBack: () => void }) {
  const reloadMcp = useExtensionsStore(s => s.loadMcpServers)
  const [showLogs, setShowLogs] = useState(false)
  if (!server) return <div className="ext-empty">Не найдено</div>

  const quickDisable = async () => {
    await window.syntee.mcp.setServerState({ serverId: server.id, enabled: false })
    reloadMcp()
    onBack()
  }

  // Цвет текстовой подписи статуса.
  const statusColor =
    server.status === 'connected' ? '#4ade80'
      : server.status === 'connecting' ? '#fbbf24'
        : server.status === 'error' ? '#f87171'
          : 'var(--text-muted)'

  return (
    <>
      <div className="ext-popup-header">
        <motion.button className="ext-popup-back" onClick={onBack} title="Назад" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
          <AppIcon name="chevronLeft" size="xs" />
        </motion.button>
        <span className="ext-popup-title">{server.name}</span>
        <span className={`ext-card-status ext-card-status--${server.status}`} title={server.status} style={{ marginTop: 0 }} />
      </div>
      <div className="ext-popup-body">
        <div className="ext-detail">
          <div className="ext-detail-desc">
            {server.transport} · {server.source === 'global' ? 'глобальный' : 'проектный'}
          </div>
          {/* Явная строка статуса подключения с цветом — видна сразу без наведения. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: '12px', fontWeight: 600 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
            <span style={{ color: statusColor }}>{mcpStatusLabel(server.status)}</span>
          </div>
          {server.status === 'error' && server.error && (
            <span style={{ color: '#f87171', display: 'block', marginTop: 4, fontSize: '11px' }}>
              Ошибка: {server.error.slice(0, 120)}{server.error.length > 120 ? '…' : ''}
            </span>
          )}

          {/* Журнал подключения — компактно, последние записи. По умолчанию свёрнут,
              раскрывается кнопкой. При ошибке удобная быстрая диагностика. */}
          <div className="ext-detail-section" style={{ marginTop: 8 }}>
            <motion.button
              className="ext-action-btn ext-action-btn--xs"
              onClick={() => setShowLogs(v => !v)}
              style={{ width: '100%', justifyContent: 'space-between' }}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <AppIcon name="fileText" size="xs" />
                Журнал подключения
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                {server.logs?.length ?? 0} {showLogs ? '▲' : '▼'}
              </span>
            </motion.button>
            {showLogs && (
              <div className="ext-logs-box" style={{ marginTop: 4 }}>
                <McpLogsList logs={server.logs} limit={8} maxHeight={160} />
              </div>
            )}
          </div>

          <div className="ext-detail-section">
            <div className="ext-detail-section-label">Инструменты ({server.tools.length})</div>
            {server.tools.map(t => {
              const state = server.toolStates[t.name] ?? { enabled: true, requireApproval: true }
              return (
                <div key={t.name} className="ext-detail-tool" style={{ opacity: state.enabled ? 1 : 0.5 }}>
                  <div className="ext-detail-tool-name">
                    {t.shortName}
                    {state.requireApproval && (
                      <span style={{ fontSize: '9px', marginLeft: 6, color: 'var(--text-muted)' }}>✓ подтверждение</span>
                    )}
                  </div>
                  {t.description && <div className="ext-detail-tool-desc">{t.description}</div>}
                </div>
              )
            })}
            {server.tools.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Нет тулов</div>}
          </div>
          <div className="ext-detail-actions">
            <motion.button className="ext-action-btn" onClick={quickDisable} whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
              <AppIcon name="power" size="xs" />
              Выключить
            </motion.button>
          </div>
        </div>
      </div>
    </>
  )
}
