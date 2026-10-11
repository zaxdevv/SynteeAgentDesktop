import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { ContextInfo } from '../../../hooks/useContextCounter'
import AppIcon from '../AppIcon/AppIcon'
import ContextManager from '../ContextManager/ContextManager'
import { chatColumnRight } from '../../../utils/popupAnchor'
import './ContextRing.css'

interface ContextRingProps {
  info: ContextInfo | null
  compactSessionStats?: { count: number; totalTokensSaved: number }
  chatId?: string
  goal?: import('../../../../../shared/types/goal').ChatGoal | null
  onGoalChange?: (goal: import('../../../../../shared/types/goal').ChatGoal | null) => void
}



function formatNum(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function formatCost(cents: number): string {
  if (cents < 1) return '<$0.01'
  if (cents < 100) return `$${(cents / 100).toFixed(3)}`
  return `$${(cents / 100).toFixed(2)}`
}

const PANEL_WIDTH = 300

export default function ContextRing({ info, compactSessionStats, chatId, goal }: ContextRingProps) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [managerChatId, setManagerChatId] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const [panelPos, setPanelPos] = useState({ bottom: 0, left: 0 })
  const ringRef = useRef<HTMLButtonElement>(null)

  const SIZE = 28
  const STROKE = 3
  const R = (SIZE - STROKE) / 2
  const CIRC = 2 * Math.PI * R
  const percent = info?.percent ?? 0
  const offset = CIRC - (percent / 100) * CIRC

  const color = info?.critical
    ? 'var(--color-danger, #ef4444)'
    : info?.warning
      ? 'var(--color-warning, #f59e0b)'
      : 'var(--accent)'

  const openPanel = () => {
    if (!ringRef.current) return
    const rect = ringRef.current.getBoundingClientRect()
    const bottom = window.innerHeight - rect.top + 8
    let left = rect.left - 20
    // не выезжаем за правый край колонки чата (а не окна — колонка
    // центрирована, справа от неё пустота)
    const colRight = chatColumnRight(ringRef.current)
    if (left + PANEL_WIDTH > colRight) {
      left = colRight - PANEL_WIDTH
    }
    // не уходим за левый край
    if (left < 8) left = 8
    setPanelPos({ bottom, left })
    setPanelOpen(true)
  }

  const handleMouseEnter = () => {
    if (panelOpen || !ringRef.current) return
    const rect = ringRef.current.getBoundingClientRect()
    setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top })
  }

  const handleMouseLeave = () => setTooltipPos(null)

  useEffect(() => {
    if (!panelOpen) return
    const handler = (e: MouseEvent) => {
      if (ringRef.current?.contains(e.target as Node)) return
      const panel = document.getElementById('ctx-panel')
      if (!panel?.contains(e.target as Node)) setPanelOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [panelOpen])

  return (
    <>
      <button
        ref={ringRef}
        className={`ctx-ring-btn${info?.warning ? ' ctx-ring-warn' : ''}${info?.critical ? ' ctx-ring-crit' : ''}`}
        onClick={() => { setTooltipPos(null); if (!info && chatId) { setManagerChatId(chatId); return }; if (panelOpen) setPanelOpen(false); else openPanel() }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        title=""
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <circle cx={SIZE/2} cy={SIZE/2} r={R} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={STROKE} />
          <circle
            cx={SIZE/2} cy={SIZE/2} r={R} fill="none"
            stroke={color} strokeWidth={STROKE} strokeLinecap="round"
            strokeDasharray={CIRC} strokeDashoffset={offset}
            transform={`rotate(-90 ${SIZE/2} ${SIZE/2})`}
            style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.3s ease' }}
          />
          <text x={SIZE/2} y={SIZE/2+4} textAnchor="middle" fontSize="7" fill={color} fontFamily="inherit">
            {info ? `${Math.round(percent)}%` : '…'}
          </text>
        </svg>
      </button>

      {/* Тултип через портал — fixed, не перекрывается инпутом */}
      {tooltipPos && info && createPortal(
        <div
          className="ctx-tooltip"
          style={{ left: tooltipPos.x, top: tooltipPos.y - 40 }}
        >
          {info.source === 'real' ? '✓ ' : '≈ '}
          {formatNum(info.total)} / {formatNum(info.limit)} tok
          <span className="ctx-tooltip-pct"> {percent.toFixed(1)}%</span>
        </div>,
        document.body
      )}

      {/* Панель через портал — с проверкой правого и левого края */}
      {createPortal(
        <AnimatePresence>
          {panelOpen && info && (
            <motion.div
              id="ctx-panel"
              className="ctx-panel"
              style={{ bottom: panelPos.bottom, left: panelPos.left }}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            >
              <div className="ctx-panel-header">
                <span className="ctx-panel-title">Контекст запроса</span>
                <span className="ctx-panel-model">{info.modelId}</span>
                <button className="ctx-panel-close" onClick={() => setPanelOpen(false)}>✕</button>
              </div>

              <div className="ctx-bar-wrap">
                <div
                  className={`ctx-bar-fill${info.warning ? ' warn' : ''}${info.critical ? ' crit' : ''}`}
                  style={{ width: `${Math.min(100, percent)}%` }}
                />
              </div>
              <div className="ctx-bar-label">
                {formatNum(info.total)} / {formatNum(info.limit)} токенов ({percent.toFixed(1)}%)
              </div>

              <div className="ctx-rows">
                <div className="ctx-row">
                  <span className="ctx-row-label">System prompt</span>
                  <span className="ctx-row-val">{formatNum(info.systemPrompt)} tok</span>
                </div>
                <div className="ctx-row">
                  <span className="ctx-row-label">История чата</span>
                  <span className="ctx-row-val">
                    {formatNum(info.history)} tok
                    {info.historyMessages > 0 && <span className="ctx-row-sub"> ({info.historyMessages} сообщ.)</span>}
                  </span>
                </div>
                {info.toolCallsTokens > 0 && (
                  <div className="ctx-row ctx-row-indent">
                    <span className="ctx-row-label">↳ Tool calls</span>
                    <span className="ctx-row-val">
                      {formatNum(info.toolCallsTokens)} tok
                      <span className="ctx-row-sub"> ({info.toolCallsCount} вызовов)</span>
                    </span>
                  </div>
                )}
                <div className="ctx-row">
                  <span className="ctx-row-label">Текущий ввод</span>
                  <span className="ctx-row-val">{formatNum(info.currentInput)} tok</span>
                </div>
                {info.breakdown?.cacheReadTokens != null && info.breakdown.cacheReadTokens > 0 && (
                  <div className="ctx-row ctx-row-indent">
                    <span className="ctx-row-label">↳ Кэш (чтение)</span>
                    <span className="ctx-row-val">
                      {formatNum(info.breakdown.cacheReadTokens)} tok
                      <span className="ctx-row-sub"> -90%</span>
                    </span>
                  </div>
                )}
                {info.breakdown?.cacheWriteTokens != null && info.breakdown.cacheWriteTokens > 0 && (
                  <div className="ctx-row ctx-row-indent">
                    <span className="ctx-row-label">↳ Кэш (запись)</span>
                    <span className="ctx-row-val">
                      {formatNum(info.breakdown.cacheWriteTokens)} tok
                      <span className="ctx-row-sub"> +25%</span>
                    </span>
                  </div>
                )}
                <div className="ctx-row ctx-row-reserved">
                  <span className="ctx-row-label">Резерв ответа</span>
                  <span className="ctx-row-val">{formatNum(info.reserved)} tok</span>
                </div>
                <div className="ctx-row ctx-row-total">
                  <span className="ctx-row-label">Итого</span>
                  <span className="ctx-row-val">{formatNum(info.total)} / {formatNum(info.limit)}</span>
                </div>
              </div>

              {goal && (
                <section className="ctx-goal-card">
                  <strong>🎯 {goal.objective}</strong>
                  <small>Критерии: {goal.criteria.join('; ') || 'уточнить'} · Шаги: {goal.steps}/{goal.maxSteps}</small>
                  <small>Статус: {goal.status}{goal.blocker ? ` · ${goal.blocker}` : ''}</small>
                  <small>Управление целью — в карточке над полем ввода. Цель сохраняется независимо от сжатия истории.</small>
                </section>
              )}
              {chatId && <button type="button" className="context-manager-launch" onClick={() => {
                setPanelOpen(false)
                setManagerChatId(chatId)
              }}>Управлять контекстом</button>}

              <div className="ctx-pricing">
                {info.pricing ? (
                  <>
                    <div className="ctx-pricing-row">
                      <span className="ctx-pricing-label">Этот запрос:</span>
                      <span className="ctx-pricing-val">
                        {info.estimatedCostCents != null ? formatCost(info.estimatedCostCents) : '—'}
                      </span>
                    </div>
                    {info.sessionCostCents != null && info.sessionRequests > 0 && (
                      <div className="ctx-pricing-row">
                        <span className="ctx-pricing-label">Сессия ({info.sessionRequests} запр.):</span>
                        <span className="ctx-pricing-val">{formatCost(info.sessionCostCents)}</span>
                      </div>
                    )}
                    <div className="ctx-pricing-rates">
                      ${(info.pricing.inputPerM / 100).toFixed(2)}/M in · ${(info.pricing.outputPerM / 100).toFixed(2)}/M out
                    </div>
                  </>
                ) : (
                  <span className="ctx-pricing-nodata">Нет данных о ценах</span>
                )}
                {info.breakdown?.cacheReadTokens != null && info.breakdown.cacheReadTokens > 0 && (
                  <div className="ctx-cache-badge">
                    ⚡ Кэшировано {Math.round((info.breakdown.cacheReadTokens / Math.max(1, info.total)) * 100)}% контекста
                  </div>
                )}
              </div>

              {compactSessionStats && compactSessionStats.count > 0 && (
                <div className="ctx-compact-stats">
                  <AppIcon name="layers" size="xs" tone="accent" />
                  <span>Сжатий: <strong>{compactSessionStats.count}</strong></span>
                  <span className="ctx-compact-stats-sep">·</span>
                  <span>сэкономлено <strong>{formatNum(compactSessionStats.totalTokensSaved)}</strong> tok</span>
                </div>
              )}

              {info.warning && (
                <div className={`ctx-alert${info.critical ? ' ctx-alert-crit' : ''}`}>
                  {info.critical ? '⚠ Контекст почти заполнен!' : '⚠ Контекст заполнен более чем на 80%'}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
      <AnimatePresence onExitComplete={() => ringRef.current?.focus()}>
        {managerChatId && managerChatId === chatId && <ContextManager
          key={managerChatId}
          chatId={managerChatId}
          onClose={() => setManagerChatId(null)}
          returnFocus={() => ringRef.current?.focus()}
        />}
      </AnimatePresence>
    </>
  )
}
