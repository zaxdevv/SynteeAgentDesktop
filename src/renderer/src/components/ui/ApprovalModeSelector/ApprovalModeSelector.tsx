import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { ApprovalMode, AutoModeSettings, NetworkPolicy, PermissionScope, ProjectPermissionOverride } from '../../../../../shared/types'
import { DEFAULT_AUTO_MODE_SETTINGS } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import Toggle from '../Toggle/Toggle'
import { chatColumnRight } from '../../../utils/popupAnchor'
import './ApprovalModeSelector.css'

const MODES: { value: ApprovalMode; label: string; icon: string; desc: string }[] = [
  { value: 'ask',  label: 'Спрашивать',    icon: 'alertCircle', desc: 'Подтверждать каждое действие' },
  { value: 'auto', label: 'Авто',          icon: 'zap',         desc: 'Авто для безопасных, спрашивать по настройкам защиты' },
  { value: 'full', label: 'Полный доступ', icon: 'shield',      desc: 'Выполнять всё без подтверждений' },
]

/** Булевы тогглы авто-режима (порядок = порядок в панели). */
type BoolAutoKey = 'askOnDangerous' | 'askOnWarn' | 'askGitPush' | 'askOutsideWorkdir'
const AUTO_TOGGLES: Array<{ key: BoolAutoKey; label: string; desc: string }> = [
  { key: 'askOnDangerous',   label: 'Опасные',       desc: 'Удаление, реестр, force push' },
  { key: 'askOnWarn',        label: 'Потенциально опасные',   desc: 'chmod, eval' },
  { key: 'askGitPush',       label: 'Git push',               desc: 'push в удалённый репо' },
  { key: 'askOutsideWorkdir', label: 'Вне папки',     desc: 'Файлы и команды вне workdir' },
]

/** Политика сети: спрашивать всё / умно (реестры пропускаем) / не спрашивать. */
const NETWORK_POLICIES: Array<{ value: NetworkPolicy; label: string; title: string }> = [
  { value: 'ask-all', label: 'Всё',    title: 'Спрашивать любую сетевую команду' },
  { value: 'smart',   label: 'Умно',   title: 'Пакеты из официальных реестров (npm/pip/winget) — без вопроса; произвольные URL, ssh и публикация — спрашивать' },
  { value: 'off',     label: 'Нет',    title: 'Не спрашивать сетевые команды' },
]

/** Оценочная высота дропдауна для ПЕРВОГО кадра (до измерения).
 * Реальная высота (с развёрнутой панелью настроек ~450-550px) измеряется
 * в useLayoutEffect — константа нужна только для стартового решения. */
const DROPDOWN_H = 230

const MODE_LABELS: Record<ApprovalMode, string> = {
  ask: 'Спрашивать',
  auto: 'Авто',
  full: 'Полный доступ',
}

interface ApprovalModeSelectorProps {
  /** Эффективный режим: проектный override ?? глобальный. */
  value: ApprovalMode
  /**
   * Выбор режима. scope='project' → писать в override проекта,
   * 'global' → в глобальные agentSettings. mode=null (только в project-scope,
   * из селекта «Как глобально») → сбросить проектный override режима.
   */
  onChange: (mode: ApprovalMode | null, scope: PermissionScope) => void
  compact?: boolean
  /** id проекта чата — открывает scope-переключатель «Только этот проект». */
  projectId?: string | null
  projectName?: string
  /** Глобальный режим (для пометки «проектный override активен»). */
  globalMode?: ApprovalMode
  /** Глобальные настройки авто-режима (agentPermissions.autoMode). */
  globalAuto?: Partial<AutoModeSettings>
  /** Проектный override разрешений (null = нет). */
  projectOverride?: ProjectPermissionOverride | null
  /** Изменение гранулярных настроек авто-режима в выбранном scope. */
  onAutoChange?: (patch: Partial<AutoModeSettings>, scope: PermissionScope) => void
}

export default function ApprovalModeSelector({
  value, onChange, compact,
  projectId, projectName,
  globalMode, globalAuto, projectOverride,
  onAutoChange,
}: ApprovalModeSelectorProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null)
  const [maxH, setMaxH] = useState(480)
  const [scope, setScope] = useState<PermissionScope>('global')
  const [autoPanelOpen, setAutoPanelOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const current = MODES.find(m => m.value === value) || MODES[0]

  const hasProject = !!projectId
  const overrideActive = hasProject && !!projectOverride
    && (projectOverride.approvalMode !== undefined || !!projectOverride.auto)

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const openUp = spaceBelow < DROPDOWN_H + 12
    const dropW = 272
    const left = Math.max(8, Math.min(r.left, chatColumnRight(btnRef.current) - dropW))
    setPos({
      top: openUp ? r.top - 8 : r.bottom + 6,
      left,
      openUp,
    })
    setOpen(o => !o)
  }

  useEffect(() => {
    if (open) {
      setScope(overrideActive ? 'project' : 'global')
      setAutoPanelOpen(false)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // Реальная высота дропдауна меняется (развёртывание панели настроек,
  // scope-переключатель, смена активного режима) — пересчитываем направление
  // открытия и max-height по фактической высоте, а не по константе.
  // Повторный замер через 380мс ловит высоту ПОСЛЕ spring-анимации панели.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const measure = () => {
      const r = btnRef.current!.getBoundingClientRect()
      const vh = window.innerHeight
      const el = dropRef.current
      // scrollHeight — естественная высота контента даже при clamp через max-height
      const h = el ? Math.max(el.offsetHeight, el.scrollHeight) : DROPDOWN_H
      const spaceBelow = vh - r.bottom - 12
      const spaceAbove = r.top - 12
      const openUp = spaceBelow < Math.min(h, 240) && spaceAbove > spaceBelow
      setPos(prev => (prev && prev.openUp === openUp)
        ? prev
        : { top: openUp ? r.top - 8 : r.bottom + 6, left: prev?.left ?? Math.max(8, r.left), openUp })
      setMaxH(Math.max(180, openUp ? spaceAbove : spaceBelow))
    }
    measure()
    const t = setTimeout(measure, 380)
    return () => clearTimeout(t)
  }, [open, autoPanelOpen, scope, value])

  const effAuto: AutoModeSettings = scope === 'project' && hasProject
    ? { ...DEFAULT_AUTO_MODE_SETTINGS, ...globalAuto, ...projectOverride?.auto }
    : { ...DEFAULT_AUTO_MODE_SETTINGS, ...globalAuto }

  const handleModeSelect = (mode: ApprovalMode) => {
    onChange(mode, scope)
    setOpen(false)
  }

  const handleAutoToggle = (key: BoolAutoKey, v: boolean) => {
    onAutoChange?.({ [key]: v }, scope)
  }

  const handleNetworkPolicy = (v: NetworkPolicy) => {
    onAutoChange?.({ networkPolicy: v }, scope)
  }

  const projModeValue = projectOverride?.approvalMode ?? ''

  return (
    <div className={`approval-selector ${compact ? 'approval-selector--compact' : ''}`}>
      <motion.button
        ref={btnRef}
        className={`approval-btn approval-btn--${value}`}
        onClick={handleOpen}
        whileTap={{ scale: 0.95 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        title={current.desc}
      >
        <AppIcon name={current.icon as 'zap'} size="xs" />
        {!compact && <span className="approval-btn-label">{current.label}</span>}
        {overrideActive && <span className="approval-btn-project-dot" title="Для этого проекта заданы свои настройки" />}
        <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="xs" />
      </motion.button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={dropRef}
              className="approval-dropdown"
              style={{
                position: 'fixed',
                left: pos.left,
                ...(pos.openUp
                  ? { bottom: window.innerHeight - pos.top, top: 'auto' }
                  : { top: pos.top }),
                // Контент больше экрана → скролл внутри, а не вылет за край
                maxHeight: maxH,
                overflowY: 'auto',
                zIndex: 9999,
              }}
              initial={{ opacity: 0, y: pos.openUp ? 6 : -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: pos.openUp ? 6 : -6 }}
              transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              onMouseDown={e => e.stopPropagation()}
            >
              {MODES.map(mode => {
                const isAuto = mode.value === 'auto'
                const isActive = value === mode.value
                return (
                  <div key={mode.value} className="approval-mode-block">
                    <motion.div
                      className={`approval-option ${isActive ? 'approval-option--active' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleModeSelect(mode.value)}
                      whileHover={{ x: 3 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                    >
                      <div className={`approval-option-icon approval-option-icon--${mode.value}`}>
                        <AppIcon name={mode.icon as 'zap'} size="xs" />
                      </div>
                      <div className="approval-option-text">
                        <span className="approval-option-label">
                          {mode.label}
                          {overrideActive && projectOverride?.approvalMode === mode.value && (
                            <span className="approval-project-badge">проект</span>
                          )}
                        </span>
                        <span className="approval-option-desc">{mode.desc}</span>
                      </div>
                      {isActive && <AppIcon name="check" size="xs" tone="accent" />}
                      {/* §auto-gear — шестерёнка прямо в строке «Авто»: панель
                          настроек выдвигается вниз из этого же блока */}
                      {isAuto && isActive && (
                        <button
                          className={`approval-gear ${autoPanelOpen ? 'approval-gear--open' : ''}`}
                          onClick={(e) => { e.stopPropagation(); setAutoPanelOpen(o => !o) }}
                          title={autoPanelOpen ? 'Свернуть настройки' : 'Настройки авто-режима'}
                        >
                          <AppIcon name="settings" size="xs" />
                        </button>
                      )}
                    </motion.div>

                    {/* ── Панель настроек авто-режима: выдвигается вниз из блока «Авто» ── */}
                    {isAuto && isActive && (
                      <div className="approval-auto-panel">
                        {/* Развёрнутый вид */}
                        <AnimatePresence initial={false}>
                          {autoPanelOpen && (
                            <motion.div
                              className="approval-settings-panel"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                            >
                              {/* Scope: глобально / этот проект */}
                              {hasProject && (
                                <div className="approval-scope">
                                  <button
                                    className={`approval-scope-btn ${scope === 'global' ? 'approval-scope-btn--active' : ''}`}
                                    onClick={() => setScope('global')}
                                  >Все проекты</button>
                                  <button
                                    className={`approval-scope-btn ${scope === 'project' ? 'approval-scope-btn--active' : ''}`}
                                    onClick={() => setScope('project')}
                                    title={projectName}
                                  >Этот проект</button>
                                </div>
                              )}

                              {/* Проектный override режима подтверждения */}
                              {scope === 'project' && hasProject && (
                                <label className="approval-mode-override">
                                  <span>Режим проекта</span>
                                  <select
                                    value={projModeValue}
                                    onChange={e => {
                                      const v = e.target.value
                                      onChange(v ? (v as ApprovalMode) : null, 'project')
                                    }}
                                  >
                                    <option value="">Как глобально{globalMode ? ` (${MODE_LABELS[globalMode]})` : ''}</option>
                                    <option value="ask">Спрашивать</option>
                                    <option value="auto">Авто</option>
                                    <option value="full">Полный доступ</option>
                                  </select>
                                </label>
                              )}

                              {/* Гранулярные тогглы авто-режима */}
                              <div className="approval-auto-toggles">
                                <div className="approval-auto-subtitle">
                                  Спрашивать:
                                  {scope === 'project' && hasProject && (
                                    <span className="approval-auto-scope-hint">
                                      {projectOverride?.auto ? 'переопределено' : 'как глобально'}
                                    </span>
                                  )}
                                </div>
                                {AUTO_TOGGLES.map(t => (
                                  <div key={t.key} className="approval-setting-row" title={t.desc}>
                                    <div className="approval-setting-row-text">
                                      <span className="approval-setting-row-label">{t.label}</span>
                                      <span className="approval-setting-row-desc">{t.desc}</span>
                                    </div>
                                    <Toggle
                                      value={effAuto[t.key]}
                                      onChange={v => handleAutoToggle(t.key, v)}
                                      aria-label={t.label}
                                    />
                                  </div>
                                ))}

                                {/* Политика сети — трёхпозиционная (smart по умолчанию) */}
                                <div className="approval-setting-row" title={NETWORK_POLICIES.find(p => p.value === effAuto.networkPolicy)?.title}>
                                  <div className="approval-setting-row-text">
                                    <span className="approval-setting-row-label">Сеть</span>
                                    <span className="approval-setting-row-desc">
                                      {effAuto.networkPolicy === 'smart' && 'Реестры без вопроса, URL — спросить'}
                                      {effAuto.networkPolicy === 'ask-all' && 'Спрашивать любую сетевую команду'}
                                      {effAuto.networkPolicy === 'off' && 'Не спрашивать сеть'}
                                    </span>
                                  </div>
                                  <div className="approval-network-policy">
                                    {NETWORK_POLICIES.map(p => (
                                      <button
                                        key={p.value}
                                        className={`approval-network-btn ${effAuto.networkPolicy === p.value ? 'approval-network-btn--active' : ''}`}
                                        onClick={() => handleNetworkPolicy(p.value)}
                                        title={p.title}
                                      >
                                        {p.label}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              </div>

                              <div className="approval-settings-hint">
                                {scope === 'project' && hasProject
                                  ? 'Только для этого проекта'
                                  : 'Запрещённые папки — в Настройки → Безопасность'}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    )}
                  </div>
                )
              })}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}
