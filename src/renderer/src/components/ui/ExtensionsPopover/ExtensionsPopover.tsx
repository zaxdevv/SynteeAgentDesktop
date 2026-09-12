/**
 * ExtensionsPopover — большое центрированное модальное окно управления
 * MCP-серверами и Skills.
 *
 * Открывается из широкой отдельной кнопки «Расширения» в шапке сайдбара.
 * Portal в document.body, оверлей на весь экран, окно по центру (как
 * AgentConfirmDialog, но крупнее — занимает больше места под контент).
 *
 * Две вкладки:
 *   - MCP    — CRUD серверов, per-tool вкл/выкл + подтверждение, reconnect
 *   - Skills — список скиллов, вкл/выкл, область применения (scope)
 *
 * Закрытие: клик по оверлею вне окна / ESC / крестик в шапке.
 *
 * Параметр projectId — текущий активный проект (для проектных скиллов/серверов
 * и выбора scope). Может быть undefined.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { v4 as uuid } from 'uuid'
import { copyToClipboard } from '@renderer/utils/clipboard'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import AppIcon from '../AppIcon/AppIcon'
import PluginsTab from './PluginsTab'
import ExtListToolbar from './ExtListToolbar'
import { useExtensionsStore } from '../../../store/extensions.store'
import { CURATED_MCP_SERVERS, getCuratedCommand, type CuratedMcpServer, type CuratedMcpCategory } from '../../../../../core/marketplace/curatedMcp'
import { CURATED_SKILL_REPOS, type CuratedSkillRepo } from '../../../../../core/marketplace/curatedSkills'
import type {
  Skill, SkillState, ExtensionScope, McpServerRuntime, McpLogEntry,
  MarketplaceMcpServer, MarketplaceSkill, McpPackageOption, McpRemoteOption,
  Project, Message,
} from '../../../../../shared/types'
import './ExtensionsPopover.css'

type Tab = 'mcp' | 'skills' | 'plugins'

/** Хук: живой таймер пока loading=true. Возвращает elapsedMs (обновляется каждую секунду). */
function useSearchTimer(loading: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number>(0)
  useEffect(() => {
    if (!loading) { setElapsed(0); return }
    startRef.current = Date.now()
    setElapsed(0)
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [loading])
  return elapsed
}

/** Компонент: спиннер + текст + таймер + кнопка отмены. */
function SearchProgress({
  label,
  elapsed,
  onCancel,
}: {
  label: string
  elapsed: number
  onCancel?: () => void
}): JSX.Element {
  return (
    <div className="ext-search-progress">
      <AppIcon name="loader" size="sm" tone="muted" animation="spin" />
      <span className="ext-search-progress-text">{label}… {elapsed}с</span>
      {onCancel && (
        <button className="ext-search-progress-cancel" onClick={onCancel}>Отмена</button>
      )}
    </div>
  )
}

/** Куда установить расширение: глобально / в существующий проект / в новый. */
export type InstallTarget =
  | { type: 'global' }
  | { type: 'project'; projectId: string; workdir: string }
  | { type: 'new-project' }

interface ExtensionsPopoverProps {
  open: boolean
  projectId?: string
  onClose: () => void
  /**
   * Вызывается после того, как install-чат создан и chat:send уже отправлен
   * (main начал обработку) — родитель переключается на чат и инициализирует
   * live-стрим (setCurrentChat + addMessage + initChatSend), как обычная
   * отправка сообщения из ChatPage.handleSend.
   */
  onInstalled?: (chatId: string, projectId: string | undefined, userMsg: Message) => void
}

/** Что именно устанавливаем — передаётся в ScopeDialog для генерации инструкции. */
export type PendingInstall =
  | { kind: 'mcp'; server: MarketplaceMcpServer; choice: { type: 'package'; package: McpPackageOption } | { type: 'remote'; remote: McpRemoteOption } }
  | { kind: 'skill'; skill: MarketplaceSkill }

export default function ExtensionsPopover({ open, projectId, onClose, onInstalled }: ExtensionsPopoverProps) {
  const [tab, setTab] = useState<Tab>('skills')
  const [pendingInstall, setPendingInstall] = useState<PendingInstall | null>(null)
  const [projects, setProjects] = useState<Project[]>([])

  const skills = useExtensionsStore(s => s.skills)
  const mcpServers = useExtensionsStore(s => s.mcpServers)
  const plugins = useExtensionsStore(s => s.plugins)
  const loadSkills = useExtensionsStore(s => s.loadSkills)
  const loadMcpServers = useExtensionsStore(s => s.loadMcpServers)
  const loadPlugins = useExtensionsStore(s => s.loadPlugins)

  // Загружаем данные при открытии
  useEffect(() => {
    if (!open) return
    loadSkills(projectId)
    loadMcpServers(projectId)
    loadPlugins(projectId)
    window.syntee.projects.getAll().then((all: Project[]) => setProjects(all ?? []))
  }, [open, loadSkills, loadMcpServers, loadPlugins, projectId])

  // Закрытие по ESC (но не когда открыт диалог выбора scope — тот сам обрабатывает Escape).
  // Ctrl/Cmd+F — фокус в поиск активной вкладки.
  useEffect(() => {
    if (!open || pendingInstall) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        const input = document.querySelector<HTMLInputElement>('.ext-modal .ext-installed-search-wrap input')
        if (input) {
          e.preventDefault()
          input.focus()
          input.select()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, pendingInstall, onClose])

  const enabledSkills = skills.filter(s => s.state.enabled).length
  const enabledMcp = mcpServers.filter(s => s.enabled).length
  const enabledPlugins = plugins.filter(p => p.state.enabled).length

  const handleInstalled = (chatId: string, installedProjectId: string | undefined, userMsg: Message) => {
    setPendingInstall(null)
    onClose()
    onInstalled?.(chatId, installedProjectId, userMsg)
  }

  const handleMcpInstalledDirect = (_serverName: string) => {
    setPendingInstall(null)
    // НЕ закрываем popover — пользователь видит новый сервер в списке
    // со статусом 'connecting' и живым таймером. Может закрыть сам.
  }

  return createPortal(
    <>
    <AnimatePresence>
      {open && (
        <motion.div
          className="ext-modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut', exit: { duration: 0.15, ease: 'easeIn' } }}
          onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
        >
          <motion.div
            className="ext-modal"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{
              duration: 0.26,
              ease: [0.16, 1, 0.3, 1],
              exit: { duration: 0.16, ease: 'easeIn' },
            }}
          >
            <div className="ext-modal-header">
              <div className="ext-modal-header-title">
                <AppIcon name="puzzle" size="md" tone="accent" />
                <div>
                  <div className="ext-modal-title">Расширения</div>
                  <div className="ext-modal-subtitle">MCP-серверы, Skills и плагины для агента</div>
                </div>
              </div>
              <button className="ext-modal-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
                <AppIcon name="x" size="sm" />
              </button>
            </div>

            <div className="ext-tabs">
              <button
                className={`ext-tab${tab === 'mcp' ? ' ext-tab--active' : ''}`}
                onClick={() => setTab('mcp')}
              >
                <AppIcon name="server" size="sm" />
                MCP-серверы
                <span className="ext-tab-count">{enabledMcp}</span>
              </button>
              <button
                className={`ext-tab${tab === 'skills' ? ' ext-tab--active' : ''}`}
                onClick={() => setTab('skills')}
              >
                <AppIcon name="puzzle" size="sm" />
                Skills
                <span className="ext-tab-count">{enabledSkills}</span>
              </button>
              <button
                className={`ext-tab${tab === 'plugins' ? ' ext-tab--active' : ''}`}
                onClick={() => setTab('plugins')}
              >
                <AppIcon name="layers" size="sm" />
                Плагины
                <span className="ext-tab-count">{enabledPlugins}</span>
              </button>
            </div>

            <div className="ext-body">
              {tab === 'skills' ? (
                <SkillsTab projectId={projectId} projects={projects} onInstallRequest={skill => setPendingInstall({ kind: 'skill', skill })} onInstalled={handleInstalled} />
              ) : tab === 'plugins' ? (
                <PluginsTab projectId={projectId} projects={projects} />
              ) : (
                <McpTab
                  projectId={projectId}
                  projects={projects}
                  servers={mcpServers}
                  onInstallRequest={(server, choice) => setPendingInstall({ kind: 'mcp', server, choice })}
                  onInstalled={handleInstalled}
                />
              )}
            </div>

            <div className="ext-footer">
              <span>
                {enabledSkills} скиллов активно · {enabledMcp} MCP-серверов активно · {enabledPlugins} плагинов активно
              </span>
              <div className="ext-footer-actions">
                <button
                  className="ext-action-btn ext-action-btn--xs"
                  onClick={async () => {
                    const paths = await window.syntee.shell.getExtensionsPaths() as { mcpConfigDir: string; skillsUserDir: string }
                    window.syntee.shell.openPath(paths.mcpConfigDir)
                  }}
                  title="Открыть папку ~/.syntee (MCP-конфиг)"
                >
                  <AppIcon name="folder" size="xs" />
                  Папка MCP
                </button>
                <button
                  className="ext-action-btn ext-action-btn--xs"
                  onClick={async () => {
                    const paths = await window.syntee.shell.getExtensionsPaths() as { mcpConfigDir: string; skillsUserDir: string }
                    window.syntee.shell.openPath(paths.skillsUserDir)
                  }}
                  title="Открыть папку пользовательских скиллов"
                >
                  <AppIcon name="folder" size="xs" />
                  Папка Skills
                </button>
                <button
                  className="ext-action-btn ext-action-btn--xs"
                  onClick={async () => {
                    const paths = await window.syntee.plugins.getPaths() as { globalPluginsDir: string }
                    window.syntee.shell.openPath(paths.globalPluginsDir)
                  }}
                  title="Открыть папку плагинов (userData/plugins)"
                >
                  <AppIcon name="folder" size="xs" />
                  Папка плагинов
                </button>
                <button
                  className="ext-action-btn ext-action-btn--xs"
                  onClick={() => {
                    useExtensionsStore.getState().reloadSkills()
                    loadMcpServers(projectId)
                    loadPlugins(projectId)
                  }}
                  title="Перечитать с диска"
                >
                  <AppIcon name="refreshCw" size="xs" />
                  Обновить
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    {pendingInstall && (
      <ScopeDialog
        pending={pendingInstall}
        currentProjectId={projectId}
        onCancel={() => setPendingInstall(null)}
        onInstalled={handleInstalled}
        onMcpInstalledDirect={handleMcpInstalledDirect}
      />
    )}
    </>,
    document.body,
  )
}

// ── Skills tab ──────────────────────────────────────────────────────────────

function SkillsTab({ projectId, projects, onInstallRequest, onInstalled }: { projectId?: string; projects: Project[]; onInstallRequest: (skill: MarketplaceSkill) => void; onInstalled?: (chatId: string, projectId: string | undefined, userMsg: Message) => void }) {
  void onInstalled
  const view = useExtensionsStore(s => s.skillsCatalogView)
  const setView = useExtensionsStore(s => s.setSkillsCatalogView)

  if (view === 'catalog') {
    return <SkillsCatalog onBack={() => setView('installed')} onInstallRequest={onInstallRequest} />
  }
  if (view === 'detail') {
    return <SkillsDetail onBack={() => setView('catalog')} onInstallRequest={onInstallRequest} />
  }
  return <SkillsInstalledList projectId={projectId} projects={projects} onBrowseCatalog={() => setView('catalog')} />
}

/** Фильтр списка скиллов: статус + источник. */
type SkillsFilter = 'all' | 'enabled' | 'disabled' | 'builtin' | 'user' | 'project'

function SkillsInstalledList({ projectId, projects, onBrowseCatalog }: { projectId?: string; projects: Project[]; onBrowseCatalog: () => void }) {
  const skills = useExtensionsStore(s => s.skills)
  const setSkillState = useExtensionsStore(s => s.setSkillState)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<SkillsFilter>('all')

  const toggleEnabled = (skill: Skill & { state: SkillState }) => {
    setSkillState(skill.id, { ...skill.state, enabled: !skill.state.enabled }, skill.source)
  }

  const setScope = (skill: Skill & { state: SkillState }, scope: ExtensionScope) => {
    setSkillState(skill.id, { ...skill.state, scope }, skill.source)
  }

  // Поиск + фильтр
  const q = search.trim().toLowerCase()
  const searched = q
    ? skills.filter(s =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q))
    : skills
  const filtered = searched.filter(s => {
    switch (filter) {
      case 'enabled': return s.state.enabled
      case 'disabled': return !s.state.enabled
      case 'builtin': case 'user': case 'project': return s.source === filter
      default: return true
    }
  })

  const hasEnabled = skills.some(s => s.state.enabled)

  return (
    <>
      <div className="ext-catalog-cta">
        <div className="ext-catalog-cta-actions">
          {hasEnabled && (
            <button
              className="ext-action-btn"
              onClick={() => skills.forEach(s => s.state.enabled && toggleEnabled(s))}
              title="Выключить все скиллы"
            >
              <AppIcon name="power" size="xs" />
              Выключить все
            </button>
          )}
        </div>
        <button className="ext-action-btn ext-action-btn--primary" onClick={onBrowseCatalog}>
          <AppIcon name="search" size="xs" />
          Добавить из каталога
        </button>
      </div>

      {skills.length === 0 && (
        <div className="ext-empty">
          <div className="ext-empty-icon"><AppIcon name="puzzle" size="xl" tone="muted" /></div>
          <div>
            Скиллы не найдены.<br />
            Создайте .md-файл в <code>.syntee/skills/</code> проекта<br />
            или в <code>userData/skills/</code>, либо установите из каталога.
          </div>
          <button className="ext-action-btn ext-action-btn--primary ext-empty-action" onClick={onBrowseCatalog}>
            <AppIcon name="search" size="xs" />
            Открыть каталог
          </button>
        </div>
      )}

      {skills.length > 0 && (
        <ExtListToolbar
          search={search}
          onSearch={setSearch}
          placeholder="Поиск по установленным…"
          filters={[
            { value: 'all', label: 'Все', count: skills.length },
            { value: 'enabled', label: 'Активные', count: skills.filter(s => s.state.enabled).length },
            { value: 'disabled', label: 'Отключённые', count: skills.filter(s => !s.state.enabled).length },
            { value: 'builtin', label: 'Встроенные', count: skills.filter(s => s.source === 'builtin').length },
            { value: 'user', label: 'Личные', count: skills.filter(s => s.source === 'user').length },
            { value: 'project', label: 'Проектные', count: skills.filter(s => s.source === 'project').length },
          ]}
          activeFilter={filter}
          onFilter={setFilter}
        />
      )}

      {skills.length > 0 && filtered.length === 0 && (
        <div className="ext-empty">Ничего не найдено по запросу «{search}»</div>
      )}

      {filtered.map(skill => {
        const isOpen = expanded === skill.id
        const enabled = skill.state.enabled
        return (
          <div key={skill.id} className={`ext-card${enabled ? ' ext-card--enabled' : ''}`}>
            <div className="ext-card-head">
              <span className="ext-card-icon">
                <AppIcon name="puzzle" size="sm" tone={enabled ? 'accent' : 'muted'} />
              </span>
              <div className="ext-card-main">
                <div className="ext-card-name">
                  {skill.name}
                  <span className={`ext-card-source ext-card-source--${skill.source}`}>
                    {skill.source === 'builtin' ? 'встроенный' : skill.source === 'user' ? 'личный' : 'проект'}
                  </span>
                  {skill.state.scope.type === 'projects' && (
                    <span className="ext-card-source ext-card-source--project" title="Область применения">
                      {scopeLabel(skill.state.scope)}
                    </span>
                  )}
                </div>
                {skill.description && <div className="ext-card-desc">{skill.description}</div>}
              </div>
              <button
                className={`ext-toggle${enabled ? ' ext-toggle--on' : ''}`}
                onClick={() => toggleEnabled(skill)}
                title={enabled ? 'Выключить' : 'Включить'}
                aria-label={enabled ? 'Выключить' : 'Включить'}
              />
            </div>

            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  className="ext-card-details"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  style={{ overflow: 'hidden' }}
                >
                  <ScopeSelector
                    scope={skill.state.scope}
                    projects={projects}
                    currentProjectId={projectId}
                    onChange={scope => setScope(skill, scope)}
                  />
                  <div className="ext-card-row ext-card-row--start">
                    <span className="ext-card-row-label">Инструкции</span>
                  </div>
                  <div className="ext-instructions-box">
                    {skill.instructions.slice(0, 600)}{skill.instructions.length > 600 ? '…' : ''}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="ext-actions">
              <button className="ext-action-btn" onClick={() => setExpanded(isOpen ? null : skill.id)}>
                <AppIcon name={isOpen ? 'chevronUp' : 'chevronDown'} size="xs" />
                {isOpen ? 'Свернуть' : 'Подробнее'}
              </button>
            </div>
          </div>
        )
      })}
    </>
  )
}

// ── MCP tab ─────────────────────────────────────────────────────────────────
// Полная реализация: CRUD серверов, per-tool вкл/выкл + подтверждение,
// reconnect, форма добавления (stdio/sse).

type McpInstallChoice = { type: 'package'; package: McpPackageOption } | { type: 'remote'; remote: McpRemoteOption }

function McpTab({
  projectId,
  projects,
  servers,
  onInstallRequest,
  onInstalled,
}: {
  projectId?: string
  projects: Project[]
  servers: McpServerRuntime[]
  onInstallRequest: (server: MarketplaceMcpServer, choice: McpInstallChoice) => void
  onInstalled?: (chatId: string, projectId: string | undefined, userMsg: Message) => void
}): JSX.Element {
  const view = useExtensionsStore(s => s.mcpCatalogView)
  const setView = useExtensionsStore(s => s.setMcpCatalogView)

  if (view === 'catalog') {
    return <McpCatalog onBack={() => setView('installed')} onInstallRequest={onInstallRequest} projectId={projectId} onInstalled={onInstalled} />
  }
  if (view === 'detail') {
    return <McpDetail onBack={() => setView('catalog')} onInstallRequest={onInstallRequest} />
  }
  return <McpInstalledList servers={servers} projects={projects} projectId={projectId} onBrowseCatalog={() => setView('catalog')} />
}

/** Фильтр списка MCP-серверов. */
type McpFilter = 'all' | 'enabled' | 'disabled' | 'error'

function McpInstalledList({ servers, projects, projectId, onBrowseCatalog }: { servers: McpServerRuntime[]; projects: Project[]; projectId?: string; onBrowseCatalog: () => void }) {
  const [showForm, setShowForm] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<McpFilter>('all')

  // Поиск: имя, команда, url, имена тулов
  const q = search.trim().toLowerCase()
  const searched = q
    ? servers.filter(s =>
        s.name.toLowerCase().includes(q) ||
        (s.command ?? '').toLowerCase().includes(q) ||
        (s.url ?? '').toLowerCase().includes(q) ||
        s.tools.some(t =>
          t.shortName.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q)))
    : servers
  const filteredServers = searched.filter(s =>
    filter === 'all' ? true
    : filter === 'enabled' ? s.enabled
    : filter === 'disabled' ? !s.enabled
    : s.status === 'error')

  // Группировка: глобальные / проектные. Проектные дополнительно
  // подгруппируем по projectId (если у сервера он есть) чтобы видеть
  // какие MCP в каком проекте — даже если popover открыт для другого.
  const globalServers = filteredServers.filter(s => s.source === 'global')
  const projectServers = filteredServers.filter(s => s.source === 'project')

  // Подгруппы проектных по projectId. Серверы без projectId (например,
  // активный workdir без записи в БД) попадают в "Текущий проект".
  const byProject = new Map<string, McpServerRuntime[]>()
  for (const s of projectServers) {
    const key = s.projectId ?? '_current'
    const arr = byProject.get(key) ?? []
    arr.push(s)
    byProject.set(key, arr)
  }
  // Имя проекта по id из списка projects (fallback на "Текущий проект").
  const projectName = (pid: string): string => {
    if (pid === '_current') return 'Текущий проект'
    return projects.find(p => p.id === pid)?.name ?? pid
  }

  const renderGroup = (title: string, group: McpServerRuntime[]): JSX.Element | null => {
    if (group.length === 0) return null
    return (
      <>
        <div className="ext-popup-group-label">{title} · {group.length}</div>
        {group.map(srv => (
          <McpServerCard key={srv.id} server={srv} projects={projects} projectId={projectId} />
        ))}
      </>
    )
  }

  return (
    <>
      <div className="ext-catalog-cta">
        <div className="ext-catalog-cta-actions" />
        <button className="ext-action-btn ext-action-btn--primary" onClick={onBrowseCatalog}>
          <AppIcon name="search" size="xs" />
          Добавить из каталога
        </button>
      </div>
      {servers.length === 0 && !showForm && (
        <div className="ext-empty">
          <div className="ext-empty-icon"><AppIcon name="server" size="xl" tone="muted" /></div>
          <div>
            MCP-серверы не настроены.<br />
            Добавьте сервер через .mcp.json в проекте,<br />
            вручную кнопкой ниже, либо найдите в каталоге.
          </div>
          <div className="ext-empty-action">
            <button className="ext-action-btn ext-action-btn--primary" onClick={onBrowseCatalog}>
              <AppIcon name="search" size="xs" />
              Открыть каталог
            </button>
          </div>
        </div>
      )}
      {servers.length > 0 && (
        <ExtListToolbar
          search={search}
          onSearch={setSearch}
          placeholder="Поиск по имени, команде или тулам…"
          filters={[
            { value: 'all', label: 'Все', count: servers.length },
            { value: 'enabled', label: 'Включённые', count: servers.filter(s => s.enabled).length },
            { value: 'disabled', label: 'Отключённые', count: servers.filter(s => !s.enabled).length },
            { value: 'error', label: 'С ошибкой', count: servers.filter(s => s.status === 'error').length },
          ]}
          activeFilter={filter}
          onFilter={setFilter}
        />
      )}
      {servers.length > 0 && filteredServers.length === 0 && (q !== '' || filter !== 'all') && (
        <div className="ext-empty">Ничего не найдено по запросу «{search}»</div>
      )}
      {renderGroup('Глобальные', globalServers)}
      {Array.from(byProject.entries()).map(([pid, group]) =>
        renderGroup(`Проект: ${projectName(pid)}`, group),
      )}
      {showForm ? (
        <McpServerForm onCancel={() => setShowForm(false)} onSaved={() => setShowForm(false)} />
      ) : (
        <div className="ext-actions ext-actions--center">
          <button className="ext-action-btn ext-action-btn--primary" onClick={() => setShowForm(true)}>
            <AppIcon name="plus" size="xs" />
            Добавить сервер вручную
          </button>
        </div>
      )}
    </>
  )
}

/**
 * Селектор области применения расширения (MCP-сервера или скилла).
 * Позволяет выбрать «Все чаты» (global) либо конкретные проекты (мульти-выбор).
 * Переиспользуется в карточках MCP и Skills.
 */
function ScopeSelector({
  scope,
  projects,
  currentProjectId,
  onChange,
  disabled,
}: {
  scope: ExtensionScope
  projects: Project[]
  currentProjectId?: string
  onChange: (scope: ExtensionScope) => void
  disabled?: boolean
}): JSX.Element {
  const selectedIds = scope.projectIds ?? []
  // Текущий проект может не быть в общем списке (например, удалён) — добавляем,
  // чтобы пользователь видел его в списке с пометкой, если он выбран.
  const allProjects = currentProjectId && !projects.some(p => p.id === currentProjectId)
    ? [{ id: currentProjectId, name: '(текущий проект)', workdir: '', createdAt: 0, lastUsed: 0 }, ...projects]
    : projects

  const toggleProject = (pid: string) => {
    const next = selectedIds.includes(pid)
      ? selectedIds.filter(id => id !== pid)
      : [...selectedIds, pid]
    // Если сняли все галочки — возвращаемся к global, иначе обновляем список.
    if (next.length === 0) onChange({ type: 'global' })
    else onChange({ type: 'projects', projectIds: next })
  }

  return (
    <div className="ext-scope-selector">
      <div className="ext-card-row">
        <span className="ext-card-row-label">Область применения</span>
        <div className="ext-scope-radios">
          <label className={`ext-scope-radio${scope.type === 'global' ? ' ext-scope-radio--active' : ''}${disabled ? ' ext-scope-radio--disabled' : ''}`}>
            <input
              type="radio"
              checked={scope.type === 'global'}
              onChange={() => onChange({ type: 'global' })}
              disabled={disabled}
            />
            Все чаты
          </label>
          <label className={`ext-scope-radio${scope.type === 'projects' ? ' ext-scope-radio--active' : ''}${disabled ? ' ext-scope-radio--disabled' : ''}`}>
            <input
              type="radio"
              checked={scope.type === 'projects'}
              onChange={() => {
                // При переключении на «проекты» если список пуст — добавляем
                // текущий проект, чтобы пользователь не получил пустой выбор.
                const ids = selectedIds.length > 0 ? selectedIds : (currentProjectId ? [currentProjectId] : [])
                onChange({ type: 'projects', projectIds: ids.length > 0 ? ids : undefined })
              }}
              disabled={disabled}
            />
            Выбранные проекты
          </label>
        </div>
      </div>
      {scope.type === 'projects' && (
        <div className="ext-scope-projects">
          {allProjects.length === 0 ? (
            <div className="ext-scope-projects-empty">Нет проектов. Создайте проект, чтобы выбрать его здесь.</div>
          ) : (
            allProjects.map(p => (
              <label key={p.id} className={`ext-scope-project${disabled ? ' ext-scope-project--disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(p.id)}
                  onChange={() => toggleProject(p.id)}
                  disabled={disabled}
                />
                <span className="ext-scope-project-name">{p.name}</span>
                {p.id === currentProjectId && <span className="ext-scope-project-current">текущий</span>}
              </label>
            ))
          )}
          {selectedIds.length > 0 && (
            <div className="ext-scope-projects-count">{selectedIds.length} выбрано</div>
          )}
        </div>
      )}
    </div>
  )
}

/** Текстовая подпись статуса подключения MCP для UI. */
export function mcpStatusLabel(status: McpServerRuntime['status']): string {
  switch (status) {
    case 'connected': return 'Подключено'
    case 'connecting': return 'Подключение…'
    case 'error': return 'Ошибка'
    case 'disconnected': return 'Отключено'
  }
}

/** Текстовая подпись области применения расширения. */
export function scopeLabel(scope: ExtensionScope): string {
  if (scope.type === 'global') return 'глобально'
  const n = scope.projectIds?.length ?? 0
  if (n === 0) return 'нет проектов'
  if (n === 1) return '1 проект'
  return `${n} проектов`
}

/** Форматирует timestamp лога в HH:MM:SS. */
function formatLogTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Журнал подключения MCP-сервера — переиспользуемый список записей.
 * Используется в карточке настроек (полная высота) и в попапе бейджа (compact).
 */
export function McpLogsList({
  logs,
  limit,
  maxHeight,
}: {
  logs: McpLogEntry[] | undefined
  /** Сколько последних записей показывать (undefined = все). */
  limit?: number
  maxHeight?: number
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const shown = limit ? (logs ?? []).slice(-limit) : (logs ?? [])

  // Авто-скролл вниз при появлении новых записей — пользователь видит свежие.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [shown.length, logs])

  if (!shown.length) {
    return <div className="ext-logs-empty">Журнал пуст</div>
  }

  return (
    <div className="ext-logs-box-list" ref={listRef} style={maxHeight ? { maxHeight } : undefined}>
      {shown.map((entry, i) => (
        <div key={`${entry.ts}-${i}`} className={`ext-log-entry ext-log-entry--${entry.level}`}>
          <span className="ext-log-entry-time">{formatLogTime(entry.ts)}</span>
          <span className="ext-log-entry-msg">{entry.message}</span>
        </div>
      ))}
    </div>
  )
}

/** Карточка MCP-сервера: статус, тумблер, reconnect, тулы с per-tool управлением. */
function McpServerCard({ server, projects, projectId }: { server: McpServerRuntime; projects: Project[]; projectId?: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [showError, setShowError] = useState(false)
  // null = авто (показывать журнал при ошибке), true = принудительно открыть,
  // false = принудительно закрыть. Избегает setState-в-effect: showLogs
  // выводится из текущего статуса, а не выставляется синхронно в effect.
  const [logsToggle, setLogsToggle] = useState<boolean | null>(null)
  const showLogs = logsToggle ?? (server.status === 'error')
  const [copied, setCopied] = useState(false)
  const [editingEnv, setEditingEnv] = useState(false)
  const [envText, setEnvText] = useState('')
  const [savingEnv, setSavingEnv] = useState(false)
  const reloadMcp = useExtensionsStore(s => s.loadMcpServers)
  const [, forceTick] = useState(0)

  // Живой таймер при подключении — обновляется каждую секунду, показывая
  // сколько секунд уже идёт попытка подключения. Помогает понять что процесс
  // не завис (npx скачивает пакет), а реально работает.
  useEffect(() => {
    if (server.status !== 'connecting' || !server.connectStartedAt) return
    const timer = setInterval(() => forceTick(n => n + 1), 1000)
    return () => clearInterval(timer)
  }, [server.status, server.connectStartedAt])

  const connectElapsed = server.connectStartedAt
    ? Math.floor((Date.now() - server.connectStartedAt) / 1000)
    : 0

  const toggleEnabled = async () => {
    await window.syntee.mcp.setServerState({ serverId: server.id, enabled: !server.enabled })
    reloadMcp()
  }

  const setScope = async (scope: ExtensionScope) => {
    await window.syntee.mcp.setServerState({ serverId: server.id, scope })
    reloadMcp()
  }

  const reconnect = async () => {
    setShowError(false)
    setLogsToggle(true) // показываем журнал новой попытки подключения
    await window.syntee.mcp.reconnect(server.id)
    reloadMcp()
  }

  const removeServer = async () => {
    if (server.source === 'project') return // проектные нельзя удалить тут
    if (!confirm(`Удалить сервер "${server.name}"?`)) return
    await window.syntee.mcp.delete(server.id)
    reloadMcp()
  }

  const toggleTool = async (toolFullName: string, currentEnabled: boolean) => {
    const currentState = server.toolStates[toolFullName] ?? { enabled: true, requireApproval: true }
    await window.syntee.mcp.setToolState({
      serverId: server.id,
      toolFullName,
      state: { ...currentState, enabled: !currentEnabled },
    })
    reloadMcp()
  }

  const toggleToolApproval = async (toolFullName: string, currentApproval: boolean) => {
    const currentState = server.toolStates[toolFullName] ?? { enabled: true, requireApproval: true }
    await window.syntee.mcp.setToolState({
      serverId: server.id,
      toolFullName,
      state: { ...currentState, requireApproval: !currentApproval },
    })
    reloadMcp()
  }

  const copyError = async () => {
    if (server.error) {
      const ok = await copyToClipboard(server.error)
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const startEditEnv = () => {
    // Сериализуем текущий env в текст KEY=value по строкам
    const env = server.env ?? {}
    setEnvText(Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'))
    setEditingEnv(true)
  }

  const saveEnv = async () => {
    setSavingEnv(true)
    try {
      const env = parseKeyValue(envText)
      await window.syntee.mcp.updateServer({
        serverId: server.id,
        env: Object.keys(env).length > 0 ? env : undefined,
      })
      await reloadMcp()
      setEditingEnv(false)
    } catch (e) {
      // молча — ошибка в логах
    } finally {
      setSavingEnv(false)
    }
  }

  return (
    <div className={`ext-card${server.enabled ? ' ext-card--enabled' : ''}`}>
      <div className="ext-card-head">
        <span className={`ext-card-status ext-card-status--${server.status}`} title={server.status} />
        <span className="ext-card-icon">
          <AppIcon name="server" size="sm" tone={server.enabled ? 'accent' : 'muted'} />
        </span>
        <div className="ext-card-main">
          <div className="ext-card-name">
            {server.name}
            <span
              className={`ext-card-source ext-card-source--${server.scope.type === 'global' ? 'global' : 'project'}`}
              title={`Источник: ${server.source === 'global' ? 'глобальный файл' : 'проектный .mcp.json'}`}
            >
              {scopeLabel(server.scope)}
            </span>
            <span className={`ext-card-status-label ext-card-status-label--${server.status}`}>
              {mcpStatusLabel(server.status)}
            </span>
          </div>
          <div className="ext-card-desc">
            {server.transport} · {server.tools.length} тулов
            {server.status === 'connecting' && server.connectStartedAt && (
              <span className="ext-connect-timer">
                Подключение… {connectElapsed}с
              </span>
            )}
            {server.status === 'error' && server.error && (
              <span className="ext-error-inline">
                Ошибка: {server.error.slice(0, 80)}{server.error.length > 80 ? '…' : ''}
              </span>
            )}
          </div>
        </div>
        <button
          className={`ext-toggle${server.enabled ? ' ext-toggle--on' : ''}`}
          onClick={toggleEnabled}
          title={server.enabled ? 'Выключить' : 'Включить'}
          aria-label={server.enabled ? 'Выключить' : 'Включить'}
        />
      </div>

      {/* Развёрнутая ошибка с кнопкой копирования — не исчезает, не моргает. */}
      {server.status === 'error' && server.error && (showError || expanded) && (
        <div className="ext-error-box">
          <div className="ext-error-box-header">
            <span className="ext-error-box-title">Детали ошибки</span>
            <div className="ext-error-box-actions">
              <button className="ext-action-btn ext-action-btn--xs" onClick={copyError} title="Копировать ошибку">
                {copied ? '✓ Скопировано' : 'Копировать'}
              </button>
              <button className="ext-action-btn ext-action-btn--xs" onClick={() => setShowError(false)} title="Скрыть">
                Скрыть
              </button>
            </div>
          </div>
          <pre className="ext-error-box-text">{server.error}</pre>
        </div>
      )}

      {/* Журнал подключения — раскрывается автоматически при ошибке. */}
      {showLogs && (
        <div className="ext-logs-box">
          <div className="ext-logs-box-header">
            <span className="ext-logs-box-title">
              Журнал подключения
              <span className="ext-logs-box-title-count">{server.logs?.length ?? 0}</span>
            </span>
            <div className="ext-logs-box-actions">
              <button className="ext-action-btn ext-action-btn--xs" onClick={() => setLogsToggle(false)} title="Скрыть">
                Скрыть
              </button>
            </div>
          </div>
          <McpLogsList logs={server.logs} />
        </div>
      )}

      <AnimatePresence initial={false}>
      {expanded && (
        <motion.div
          className="ext-card-details"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          style={{ overflow: 'hidden' }}
        >
          <ScopeSelector
            scope={server.scope}
            projects={projects}
            currentProjectId={projectId ?? server.projectId}
            onChange={setScope}
            disabled={server.source === 'project'}
          />
          {server.transport === 'stdio' && server.command && (
            <div className="ext-card-row">
              <span className="ext-card-row-label">Команда</span>
              <span className="ext-card-row-val" title={server.command}>
                {server.command} {(server.args ?? []).join(' ')}
              </span>
            </div>
          )}
          {server.transport === 'sse' && server.url && (
            <div className="ext-card-row">
              <span className="ext-card-row-label">URL</span>
              <span className="ext-card-row-val" title={server.url}>{server.url}</span>
            </div>
          )}

          {/* Переменные окружения (env) — просмотр и редактирование */}
          <div className="ext-card-row ext-card-row--start">
            <span className="ext-card-row-label">Переменные окружения</span>
            {editingEnv ? (
              <div className="ext-env-edit-area">
                <textarea
                  className="ext-form-textarea"
                  value={envText}
                  onChange={e => setEnvText(e.target.value)}
                  placeholder={'API_KEY=xxx\nNODE_ENV=production'}
                  rows={4}
                  style={{ width: '100%' }}
                />
                <div className="ext-env-edit-row">
                  <button className="ext-action-btn ext-action-btn--xs" onClick={saveEnv} disabled={savingEnv}>
                    {savingEnv ? 'Сохранение…' : 'Сохранить и переподключить'}
                  </button>
                  <button className="ext-action-btn ext-action-btn--xs" onClick={() => setEditingEnv(false)} disabled={savingEnv}>
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <div className="ext-env-view-row">
                {server.env && Object.keys(server.env).length > 0 ? (
                  Object.entries(server.env).map(([k, v]) => (
                    <span key={k} className="ext-env-chip" title={`${k}=${v}`}>
                      {k}={v.includes('*') || k.toLowerCase().includes('key') || k.toLowerCase().includes('token') ? '••••' : v.slice(0, 20)}
                    </span>
                  ))
                ) : (
                  <span className="ext-env-empty">(нет)</span>
                )}
                {server.source === 'global' && (
                  <button className="ext-action-btn ext-action-btn--xs" onClick={startEditEnv} title="Редактировать env">
                    <AppIcon name="edit" size="xs" />
                    Изменить
                  </button>
                )}
              </div>
            )}
          </div>

          {server.tools.length > 0 ? (
            <div className="ext-tools-list">
              {server.tools.map(t => {
                const state = server.toolStates[t.name] ?? { enabled: true, requireApproval: true }
                return (
                  <div key={t.name} className={`ext-tool-row${state.enabled ? '' : ' ext-tool-row--disabled'}`}>
                    <div className="ext-tool-main">
                      <div className="ext-tool-name">{t.shortName}</div>
                      {t.description && <div className="ext-tool-desc">{t.description}</div>}
                      <label className="ext-tool-approval">
                        <input
                          type="checkbox"
                          checked={state.requireApproval}
                          onChange={() => toggleToolApproval(t.name, state.requireApproval)}
                        />
                        Спрашивать подтверждение
                      </label>
                    </div>
                    <button
                      className={`ext-tool-mini-toggle${state.enabled ? ' ext-tool-mini-toggle--on' : ''}`}
                      onClick={() => toggleTool(t.name, state.enabled)}
                      title={state.enabled ? 'Выключить тул' : 'Включить тул'}
                      aria-label={state.enabled ? 'Выключить тул' : 'Включить тул'}
                    />
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="ext-no-tools">
              {server.status === 'connected' ? 'Нет тулов' : 'Подключите сервер чтобы увидеть тулы'}
            </div>
          )}
        </motion.div>
      )}
      </AnimatePresence>

      <div className="ext-actions ext-actions--split">
        <button className="ext-action-btn" onClick={() => setExpanded(!expanded)}>
          <AppIcon name={expanded ? 'chevronUp' : 'chevronDown'} size="xs" />
          {expanded ? 'Свернуть' : `Тулы (${server.tools.length})`}
        </button>
        {server.status === 'error' && server.error && !showError && !expanded && (
          <button className="ext-action-btn ext-action-btn--danger" onClick={() => setShowError(true)}>
            <AppIcon name="alertCircle" size="xs" />
            Показать ошибку
          </button>
        )}
        <button className="ext-action-btn" onClick={() => setLogsToggle(!showLogs)} title={showLogs ? 'Скрыть журнал' : 'Показать журнал'}>
          <AppIcon name="fileText" size="xs" />
          {showLogs ? 'Скрыть логи' : 'Логи'}
        </button>
        <button className="ext-action-btn" onClick={reconnect} title="Переподключить">
          <AppIcon name="refreshCw" size="xs" />
        </button>
        {server.source === 'global' && (
          <button className="ext-action-btn ext-action-btn--danger" onClick={removeServer} title="Удалить">
            <AppIcon name="trash" size="xs" />
          </button>
        )}
      </div>
    </div>
  )
}

/** Форма добавления глобального MCP-сервера (stdio или sse). */
function McpServerForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }): JSX.Element {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'sse' | 'streamable-http'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const reloadMcp = useExtensionsStore(s => s.loadMcpServers)

  const save = async () => {
    setError('')
    if (!name.trim()) { setError('Укажите имя сервера'); return }
    if (transport === 'stdio' && !command.trim()) { setError('Укажите команду'); return }
    if ((transport === 'sse' || transport === 'streamable-http') && !url.trim()) { setError('Укажите URL'); return }

    setSaving(true)
    try {
      const isRemote = transport === 'sse' || transport === 'streamable-http'
      const config = {
        id: 'mcp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: name.trim(),
        transport,
        command: transport === 'stdio' ? command.trim() : undefined,
        args: transport === 'stdio' && args.trim() ? args.split(/\s+/).filter(Boolean) : undefined,
        env: transport === 'stdio' && env.trim() ? parseKeyValue(env) : undefined,
        url: isRemote ? url.trim() : undefined,
        headers: isRemote && headers.trim() ? parseKeyValue(headers) : undefined,
        enabled: true,
        scope: { type: 'global' as const },
        source: 'global' as const,
      }
      await window.syntee.mcp.save(config)
      await reloadMcp()
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="ext-card ext-card--enabled">
      <div className="ext-form">
        <div className="ext-form-row">
          <span className="ext-form-label">Имя</span>
          <input className="ext-form-input" value={name} onChange={e => setName(e.target.value)} placeholder="my-server" />
        </div>
        <div className="ext-form-row">
          <span className="ext-form-label">Транспорт</span>
          <div className="ext-transport-toggle">
            <button
              className={`ext-transport-btn${transport === 'stdio' ? ' ext-transport-btn--active' : ''}`}
              onClick={() => setTransport('stdio')}
            >stdio</button>
            <button
              className={`ext-transport-btn${transport === 'sse' ? ' ext-transport-btn--active' : ''}`}
              onClick={() => setTransport('sse')}
            >sse</button>
            <button
              className={`ext-transport-btn${transport === 'streamable-http' ? ' ext-transport-btn--active' : ''}`}
              onClick={() => setTransport('streamable-http')}
            >http</button>
          </div>
        </div>
        {transport === 'stdio' ? (
          <>
            <div className="ext-form-row">
              <span className="ext-form-label">Команда</span>
              <input className="ext-form-input" value={command} onChange={e => setCommand(e.target.value)} placeholder="npx" />
            </div>
            <div className="ext-form-row">
              <span className="ext-form-label">Аргументы (через пробел)</span>
              <input className="ext-form-input" value={args} onChange={e => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /path" />
            </div>
            <div className="ext-form-row">
              <span className="ext-form-label">Окружение (KEY=value по строкам)</span>
              <textarea className="ext-form-textarea" value={env} onChange={e => setEnv(e.target.value)} placeholder={'API_KEY=xxx\nNODE_ENV=production'} />
            </div>
          </>
        ) : (
          <>
            <div className="ext-form-row">
              <span className="ext-form-label">URL</span>
              <input className="ext-form-input" value={url} onChange={e => setUrl(e.target.value)} placeholder={transport === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp'} />
            </div>
            <div className="ext-form-row">
              <span className="ext-form-label">Заголовки (KEY:value по строкам)</span>
              <textarea className="ext-form-textarea" value={headers} onChange={e => setHeaders(e.target.value)} placeholder={'Authorization:Bearer xxx'} />
            </div>
          </>
        )}
        {error && <div className="ext-form-error">{error}</div>}
        <div className="ext-form-actions">
          <button className="ext-action-btn" onClick={onCancel} disabled={saving}>Отмена</button>
          <button className="ext-action-btn ext-action-btn--primary" onClick={save} disabled={saving}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Парсит "KEY=value\nKEY2=value2" в объект. */
function parseKeyValue(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^:=]+)[:=](.*)$/)
    if (m) out[m[1].trim()] = m[2].trim()
  }
  return out
}

// ── MCP каталог (маркетплейс) ────────────────────────────────────────────────

/** Конвертирует кураторный MCP-сервер в формат для прямой установки. */
function curatedToInstallParams(server: CuratedMcpServer): {
  name: string
  transport: 'stdio'
  command: string
  args: string[]
  envVars: { name: string; description: string; isRequired: boolean; isSecret: boolean }[]
} {
  const isWin = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
  const cmd = getCuratedCommand(server, isWin)
  if (!cmd) throw new Error('Сервер не поддерживает stdio на этой платформе')
  return {
    name: server.name,
    transport: 'stdio' as const,
    command: cmd.command,
    args: cmd.args,
    envVars: server.envVars,
  }
}

function CuratedMcpGrid({ onInstall }: { onInstall: (server: CuratedMcpServer) => void }): JSX.Element {
  const installedServers = useExtensionsStore(s => s.mcpServers)
  const [filter, setFilter] = useState<CuratedMcpCategory | 'all'>('all')

  const categories: Array<{ key: CuratedMcpCategory | 'all'; label: string }> = [
    { key: 'all', label: 'Все' },
    { key: 'docs', label: 'Документация' },
    { key: 'code', label: 'Код' },
    { key: 'files', label: 'Файлы' },
    { key: 'search', label: 'Поиск' },
    { key: 'browser', label: 'Браузер' },
    { key: 'data', label: 'Данные' },
    { key: 'productivity', label: 'Продуктивность' },
    { key: 'ai', label: 'AI' },
    { key: 'comms', label: 'Коммуникации' },
    { key: 'devops', label: 'DevOps' },
    { key: 'utils', label: 'Утилиты' },
    { key: 'security', label: 'Безопасность' },
    { key: 'social', label: 'Соцсети' },
    { key: 'media', label: 'Медиа' },
    { key: 'science', label: 'Наука' },
    { key: 'cloud', label: 'Cloud' },
    { key: 'design', label: 'Дизайн' },
    { key: 'finance', label: 'Финансы' },
  ]

  const filtered = filter === 'all'
    ? CURATED_MCP_SERVERS
    : CURATED_MCP_SERVERS.filter(s => s.category === filter)

  return (
    <div className="ext-curated-section">
      <div className="ext-curated-title">
        <AppIcon name="star" size="sm" tone="accent" />
        Популярные серверы
        <span className="ext-curated-count">{filtered.length}</span>
      </div>
      <div className="ext-curated-filters">
        {categories.map(c => (
          <button
            key={c.key}
            className={`ext-filter-chip${filter === c.key ? ' ext-filter-chip--active' : ''}`}
            onClick={() => setFilter(c.key)}
          >{c.label}</button>
        ))}
      </div>
      <div className="ext-catalog-grid">
        {filtered.map(server => {
          const isInstalled = installedServers.some(s => s.name === server.name)
          return (
            <div
              key={server.id}
              className={`ext-catalog-card${server.featured ? ' ext-catalog-card--featured' : ''}`}
              onClick={() => !isInstalled && onInstall(server)}
              style={isInstalled ? { opacity: 0.5, cursor: 'default' } : undefined}
            >
              <div className="ext-catalog-card-title">
                {server.name}
                {server.featured && <span className="ext-featured-badge">★</span>}
                {isInstalled && <span className="ext-installed-badge">✓ установлен</span>}
              </div>
              <div className="ext-catalog-card-desc">{server.description}</div>
              <div className="ext-catalog-card-meta">
                <span className="ext-catalog-card-transport">stdio</span>
                {server.envVars.filter(v => v.isRequired).length > 0 && (
                  <span className="ext-catalog-card-version">нужен API ключ</span>
                )}
                {server.positionalArgs?.filter(a => a.isRequired).length && (
                  <span className="ext-catalog-card-version">нужны параметры</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Установка MCP-сервера по URL через AI. Принимает любой URL (GitHub/GitLab/npm/pypi/git). */
function McpUrlInstallBox({
  projectId,
  onInstalled,
}: {
  projectId?: string
  onInstalled?: (chatId: string, projectId: string | undefined, userMsg: Message) => void
}): JSX.Element {
  const [url, setUrl] = useState('')
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [target, setTarget] = useState<InstallTarget>(projectId ? { type: 'project', projectId, workdir: '' } : { type: 'global' })

  useEffect(() => {
    window.syntee.projects.getAll().then((all: Project[]) => {
      setProjects(all)
      if (projectId) {
        const p = all.find(pr => pr.id === projectId)
        if (p) setTarget({ type: 'project', projectId: p.id, workdir: p.workdir })
      }
    })
  }, [projectId])

  const install = async () => {
    if (!url.trim()) return
    setError('')
    setInstalling(true)
    try {
      // Разрешаем scope (workdir) из выбранного target
      let workdir: string | undefined
      let targetProjectId: string | undefined

      if (target.type === 'new-project') {
        const picked = await window.syntee.projects.pickWorkdir()
        if (!picked) { setInstalling(false); return }
        const project = await window.syntee.projects.create(picked) as Project
        workdir = project.workdir
        targetProjectId = project.id
      } else if (target.type === 'project') {
        const p = projects.find(pr => pr.id === target.projectId)
        workdir = p?.workdir
        targetProjectId = target.projectId
      }

      const scope = workdir ? { workdir } : ('global' as const)

      // Получаем инструкцию для AI
      const instruction = await window.syntee.marketplace.buildMcpUrlInstruction({
        url: url.trim(),
        scope,
      }) as string

      // Создаём чат и отправляем инструкцию.
      // chat.create возвращает объект Chat (не строку!) — берём .id
      const chat = await window.syntee.chat.create(false, 'code', targetProjectId) as { id: string }
      const userMsgId = uuid()

      await window.syntee.chat.send({
        chatId: chat.id,
        content: instruction,
        userMsgId,
      })

      const userMsg: Message = {
        id: userMsgId,
        chatId: chat.id,
        role: 'user',
        content: instruction,
        createdAt: Date.now(),
        isPinned: 0,
      }

      setUrl('')
      onInstalled?.(chat.id, targetProjectId, userMsg)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="ext-url-install ext-url-install--mcp">
      <div className="ext-detail-section-title">
        <AppIcon name="git" size="xs" />
        Установить MCP по ссылке (через AI)
      </div>
      <div className="ext-url-install-hint">
        Вставьте ссылку на GitHub/GitLab репозиторий, npm/pypi пакет или git URL — AI сам определит тип, клонирует, настроит и установит.
      </div>

      {/* Scope selector */}
      <div className="ext-url-install-scope">
        <div className="ext-scope-options ext-scope-options--inline">
          <label className={`ext-scope-option${target.type === 'global' ? ' ext-scope-option--active' : ''}`}>
            <input type="radio" checked={target.type === 'global'} onChange={() => setTarget({ type: 'global' })} />
            <div>
              <div className="ext-scope-option-title">Глобально</div>
            </div>
          </label>
          {projects.map(p => (
            <label key={p.id} className={`ext-scope-option${target.type === 'project' && target.projectId === p.id ? ' ext-scope-option--active' : ''}`}>
              <input
                type="radio"
                checked={target.type === 'project' && target.projectId === p.id}
                onChange={() => setTarget({ type: 'project', projectId: p.id, workdir: p.workdir })}
              />
              <div>
                <div className="ext-scope-option-title">{p.name}</div>
              </div>
            </label>
          ))}
          <label className={`ext-scope-option${target.type === 'new-project' ? ' ext-scope-option--active' : ''}`}>
            <input type="radio" checked={target.type === 'new-project'} onChange={() => setTarget({ type: 'new-project' })} />
            <div>
              <div className="ext-scope-option-title">+ Новый проект</div>
            </div>
          </label>
        </div>
      </div>

      <div className="ext-form-row">
        <input
          className="ext-form-input"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://github.com/user/mcp-server или npm:@scope/pkg или git@github.com:..."
          disabled={installing}
          onKeyDown={e => { if (e.key === 'Enter' && url.trim() && !installing) install() }}
        />
        <button
          className="ext-action-btn ext-action-btn--primary"
          onClick={install}
          disabled={installing || !url.trim()}
        >
          {installing ? 'Запуск…' : 'Установить через AI'}
        </button>
      </div>
      {error && <div className="ext-scope-error">{error}</div>}
    </div>
  )
}

function McpCatalog({
  onBack,
  onInstallRequest,
  projectId,
  onInstalled,
}: {
  onBack: () => void
  onInstallRequest: (server: MarketplaceMcpServer, choice: McpInstallChoice) => void
  projectId?: string
  onInstalled?: (chatId: string, projectId: string | undefined, userMsg: Message) => void
}): JSX.Element {
  void onInstallRequest
  const [query, setQuery] = useState('')
  const [remoteTriggered, setRemoteTriggered] = useState(false)
  const results = useExtensionsStore(s => s.mcpCatalogResults)
  const loading = useExtensionsStore(s => s.mcpCatalogLoading)
  const error = useExtensionsStore(s => s.mcpCatalogError)
  const cursor = useExtensionsStore(s => s.mcpCatalogCursor)
  const search = useExtensionsStore(s => s.searchMcpCatalog)
  const cancelSearch = useExtensionsStore(s => s.cancelMcpCatalogSearch)
  const loadMore = useExtensionsStore(s => s.loadMoreMcpCatalog)
  const openDetail = useExtensionsStore(s => s.openMcpDetail)
  const elapsed = useSearchTimer(loading && remoteTriggered)

  // Локальный мгновенный фильтр по curated-списку
  const q = query.trim().toLowerCase()
  const localFiltered = q === '' ? CURATED_MCP_SERVERS : CURATED_MCP_SERVERS.filter(s =>
    s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  )

  // Обработчик установки кураторного сервера — конвертируем в формат
  // McpInstallChoice и передаём в ScopeDialog через onInstallRequest.
  // Создаём временный MarketplaceMcpServer-обёртку для совместимости типов.
  const handleCuratedInstall = (server: CuratedMcpServer) => {
    const isWin = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
    const cmd = getCuratedCommand(server, isWin)
    if (!cmd) return
    // Извлекаем реальное имя npm-пакета из args (после /c npx -y)
    const npmPackage = cmd.args.find(a => a.startsWith('@') || a.includes('-')) ?? server.name
    const fakePackage: McpPackageOption = {
      registryType: 'npm',
      identifier: npmPackage,
      version: 'latest',
      packageArguments: cmd.args.slice(cmd.args.indexOf(npmPackage) + 1),
      environmentVariables: server.envVars,
      positionalArgs: server.positionalArgs,
    }
    const fakeServer: MarketplaceMcpServer = {
      id: server.id,
      title: server.name,
      description: server.description,
      version: 'latest',
      websiteUrl: server.homepage,
      remotes: [],
      packages: [fakePackage],
    }
    onInstallRequest(fakeServer, { type: 'package', package: fakePackage })
  }

  // Remote поиск — ТОЛЬКО по кнопке. Не запускаем автоматически при вводе.
  const triggerRemoteSearch = () => {
    setRemoteTriggered(true)
    search(query)
  }

  // Сбрасываем remote-результаты при изменении запроса
  useEffect(() => {
    if (remoteTriggered) {
      setRemoteTriggered(false)
      cancelSearch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  return (
    <div className="ext-catalog">
      <div className="ext-catalog-header">
        <button className="ext-action-btn" onClick={onBack}>
          <AppIcon name="chevronLeft" size="xs" />
          Назад
        </button>
        <input
          className="ext-catalog-search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Поиск MCP-серверов…"
          autoFocus
        />
        {loading && remoteTriggered && (
          <button className="ext-search-cancel-btn" onClick={() => { cancelSearch(); setRemoteTriggered(false) }}>
            <AppIcon name="x" size="xs" />
          </button>
        )}
      </div>

      {/* URL-установка через AI — всегда видна */}
      <McpUrlInstallBox projectId={projectId} onInstalled={onInstalled} />

      {/* Локальные результаты (мгновенно) */}
      {q !== '' && localFiltered.length > 0 && (
        <div className="ext-curated-section">
          <div className="ext-curated-title">
            <AppIcon name="star" size="sm" tone="accent" />
            Из каталога (мгновенно)
            <span className="ext-curated-count">{localFiltered.length}</span>
          </div>
          <div className="ext-catalog-grid">
            {localFiltered.map(server => {
              const isInstalled = useExtensionsStore.getState().mcpServers.some(s => s.name === server.name)
              return (
                <div
                  key={server.id}
                  className={`ext-catalog-card${server.featured ? ' ext-catalog-card--featured' : ''}`}
                  onClick={() => !isInstalled && handleCuratedInstall(server)}
                  style={isInstalled ? { opacity: 0.5, cursor: 'default' } : undefined}
                >
                  <div className="ext-catalog-card-title">
                    {server.name}
                    {server.featured && <span className="ext-featured-badge">★</span>}
                    {isInstalled && <span className="ext-installed-badge">✓ установлен</span>}
                  </div>
                  <div className="ext-catalog-card-desc">{server.description}</div>
                  <div className="ext-catalog-card-meta">
                    <span className="ext-catalog-card-transport">stdio</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Кураторный список с категориями — только при пустом запросе */}
      {q === '' && (
        <CuratedMcpGrid onInstall={handleCuratedInstall} />
      )}

      {/* Кнопка запуска remote-поиска — только если ещё не запущен */}
      {query.trim() !== '' && !remoteTriggered && !loading && results.length === 0 && (
        <div className="ext-remote-search-cta">
          <div className="ext-remote-search-hint">
            {localFiltered.length > 0
              ? 'Не нашли нужное в каталоге?'
              : 'В каталоге ничего не найдено.'}
          </div>
          <button className="ext-action-btn" onClick={triggerRemoteSearch}>
            <AppIcon name="globe" size="xs" />
            Искать в реестре MCP
          </button>
        </div>
      )}

      {/* Remote: результаты из официального реестра */}
      {remoteTriggered && (
        <>
          <div className="ext-curated-title ext-curated-title--mt">
            <AppIcon name="globe" size="sm" tone="muted" />
            Из реестра MCP
          </div>
          {error ? (
            <div className="ext-empty">
              <AppIcon name="alertCircle" size="lg" tone="danger" />
              <div className="ext-empty-extra">{error}</div>
              <div className="ext-empty-extra-btn">
                <button className="ext-action-btn" onClick={() => search(query)}>Повторить</button>
              </div>
            </div>
          ) : loading && results.length === 0 ? (
            <SearchProgress
              label="Поиск в реестре MCP"
              elapsed={elapsed}
              onCancel={() => { cancelSearch(); setRemoteTriggered(false) }}
            />
          ) : results.length === 0 ? (
            <div className="ext-empty">
              <div className="ext-empty-extra">Ничего не найдено в реестре.</div>
              <div style={{ color: 'var(--text-muted)' }}>Попробуйте установить по URL выше.</div>
            </div>
          ) : (
            <>
              {loading && (
                <SearchProgress label="Догрузка результатов" elapsed={elapsed} onCancel={() => { cancelSearch(); setRemoteTriggered(false) }} />
              )}
              <div className="ext-catalog-grid">
                {results.map(item => (
                  <div key={item.id} className="ext-catalog-card" onClick={() => openDetail(item)}>
                    <div className="ext-catalog-card-title">{item.title}</div>
                    <div className="ext-catalog-card-desc">{item.description || 'Без описания'}</div>
                    <div className="ext-catalog-card-meta">
                      <span className="ext-catalog-card-transport">
                        {item.packages.length > 0 ? 'stdio' : ''}
                        {item.packages.length > 0 && item.remotes.length > 0 ? ' · ' : ''}
                        {item.remotes.length > 0 ? item.remotes.map(r => r.type).join(', ') : ''}
                      </span>
                      <span className="ext-catalog-card-version">v{item.version}</span>
                    </div>
                  </div>
                ))}
              </div>
              {cursor && (
                <div className="ext-actions ext-actions--center">
                  <button className="ext-action-btn" onClick={loadMore} disabled={loading}>
                    {loading ? 'Загрузка…' : 'Загрузить ещё'}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function McpDetail({
  onBack,
  onInstallRequest,
}: {
  onBack: () => void
  onInstallRequest: (server: MarketplaceMcpServer, choice: McpInstallChoice) => void
}): JSX.Element | null {
  const item = useExtensionsStore(s => s.mcpCatalogDetail)
  const [choiceIdx, setChoiceIdx] = useState(0)

  if (!item) return null

  const choices: Array<{ label: string; value: McpInstallChoice }> = [
    ...item.packages.map(p => ({ label: `${p.registryType} · ${p.identifier}`, value: { type: 'package' as const, package: p } })),
    ...item.remotes.map(r => ({ label: `${r.type} · ${new URL(r.url).host}`, value: { type: 'remote' as const, remote: r } })),
  ]
  const selected = choices[choiceIdx]?.value
  const envVars = selected?.type === 'package' ? selected.package.environmentVariables : undefined
  const headers = selected?.type === 'remote' ? selected.remote.headers : undefined
  const requirements = [...(envVars ?? []), ...(headers ?? [])]

  return (
    <div className="ext-detail">
      <button className="ext-action-btn" onClick={onBack}>
        <AppIcon name="chevronLeft" size="xs" />
        Назад к каталогу
      </button>

      <div className="ext-detail-header">
        <div className="ext-detail-icon"><AppIcon name="server" size="lg" tone="accent" /></div>
        <div>
          <div className="ext-detail-title">{item.title} <span className="ext-detail-version">v{item.version}</span></div>
          {item.description && <div className="ext-detail-desc">{item.description}</div>}
        </div>
      </div>

      <div className="ext-detail-links">
        {item.repositoryUrl && (
          <a href={item.repositoryUrl} target="_blank" rel="noreferrer" className="ext-detail-link">
            <AppIcon name="git" size="xs" /> Репозиторий
          </a>
        )}
        {item.websiteUrl && (
          <a href={item.websiteUrl} target="_blank" rel="noreferrer" className="ext-detail-link">
            <AppIcon name="globe" size="xs" /> Сайт
          </a>
        )}
      </div>

      {choices.length > 0 && (
        <div className="ext-detail-section">
          <div className="ext-detail-section-title">Способ установки</div>
          <div className="ext-transport-toggle">
            {choices.map((c, i) => (
              <button
                key={i}
                className={`ext-transport-btn${i === choiceIdx ? ' ext-transport-btn--active' : ''}`}
                onClick={() => setChoiceIdx(i)}
              >{c.label}</button>
            ))}
          </div>
        </div>
      )}

      {requirements.length > 0 && (
        <div className="ext-detail-section">
          <div className="ext-detail-section-title">Переменные окружения / заголовки</div>
          {requirements.map((r, i) => (
            <div key={i} className="ext-card-row">
              <span className="ext-card-row-label">
                {r.name}{r.isRequired ? ' *' : ''}{r.isSecret ? ' 🔒' : ''}
              </span>
              <span className="ext-card-row-val">{r.description}</span>
            </div>
          ))}
        </div>
      )}

      {choices.length === 0 && (
        <div className="ext-empty">У этого сервера нет доступного способа подключения (нет stdio-пакета и удалённого URL).</div>
      )}

      {selected && (
        <div className="ext-actions" style={{ marginTop: 14 }}>
          <button className="ext-action-btn ext-action-btn--primary" onClick={() => onInstallRequest(item, selected)}>
            <AppIcon name="download" size="xs" />
            Установить
          </button>
        </div>
      )}
    </div>
  )
}

// ── Skills каталог (маркетплейс) ─────────────────────────────────────────────

function CuratedSkillsGrid({ onInstall }: { onInstall: (repo: CuratedSkillRepo) => void }): JSX.Element {
  const [filter, setFilter] = useState<CuratedSkillRepo['category'] | 'all'>('all')

  const categories: Array<{ key: CuratedSkillRepo['category'] | 'all'; label: string }> = [
    { key: 'all', label: 'Все' },
    { key: 'coding', label: 'Код' },
    { key: 'workflow', label: 'Workflow' },
    { key: 'writing', label: 'Тексты' },
    { key: 'debugging', label: 'Отладка' },
    { key: 'general', label: 'Разное' },
  ]

  const filtered = filter === 'all' ? CURATED_SKILL_REPOS : CURATED_SKILL_REPOS.filter(s => s.category === filter)

  return (
    <div className="ext-curated-section">
      <div className="ext-curated-title">
        <AppIcon name="star" size="sm" tone="accent" />
        Популярные репозитории
        <span className="ext-curated-count">{filtered.length}</span>
      </div>
      <div className="ext-curated-filters">
        {categories.map(c => (
          <button
            key={c.key}
            className={`ext-filter-chip${filter === c.key ? ' ext-filter-chip--active' : ''}`}
            onClick={() => setFilter(c.key)}
          >{c.label}</button>
        ))}
      </div>
      <div className="ext-catalog-grid">
        {filtered.map(repo => (
          <div key={repo.id} className="ext-catalog-card" onClick={() => onInstall(repo)}>
            <div className="ext-catalog-card-title">{repo.fullName}</div>
            <div className="ext-catalog-card-desc">{repo.description}</div>
            <div className="ext-catalog-card-meta">
              <span className="ext-catalog-card-stars">
                <AppIcon name="star" size="xs" /> {repo.stars.toLocaleString('ru')}
              </span>
              <span className="ext-catalog-card-version">{repo.skills.length} скиллов</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function UrlInstallBox({ onInstalled }: { onInstalled: (count: number) => void }): JSX.Element {
  const [url, setUrl] = useState('')
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')

  const install = async () => {
    if (!url.trim()) return
    setError('')
    setInstalling(true)
    try {
      const result = await window.syntee.skills.installFromUrl({
        url: url.trim(),
        scope: 'global',
      }) as { ok: boolean; installed: number; error?: string }
      if (!result.ok) {
        setError(result.error || 'Не удалось установить')
      } else {
        setUrl('')
        onInstalled(result.installed)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="ext-url-install">
      <div className="ext-detail-section-title">Установить по URL (глобально)</div>
      <div className="ext-form-row">
        <input
          className="ext-form-input"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://github.com/user/repo или прямая ссылка на .md-файл"
          disabled={installing}
        />
        <button
          className="ext-action-btn ext-action-btn--primary"
          onClick={install}
          disabled={installing || !url.trim()}
        >
          {installing ? 'Установка…' : 'Установить'}
        </button>
      </div>
      {error && <div className="ext-scope-error">{error}</div>}
    </div>
  )
}

function SkillsCatalog({
  onBack,
  onInstallRequest,
}: {
  onBack: () => void
  onInstallRequest: (skill: MarketplaceSkill) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [urlMsg, setUrlMsg] = useState('')
  const reloadSkills = useExtensionsStore(s => s.reloadSkills)
  const results = useExtensionsStore(s => s.skillsCatalogResults)
  const loading = useExtensionsStore(s => s.skillsCatalogLoading)
  const error = useExtensionsStore(s => s.skillsCatalogError)
  const hasMore = useExtensionsStore(s => s.skillsCatalogHasMore)
  const search = useExtensionsStore(s => s.searchSkillsCatalog)
  const cancelSearch = useExtensionsStore(s => s.cancelSkillsCatalogSearch)
  const loadMore = useExtensionsStore(s => s.loadMoreSkillsCatalog)
  const openDetail = useExtensionsStore(s => s.openSkillDetail)
  const [remoteTriggered, setRemoteTriggered] = useState(false)
  const elapsed = useSearchTimer(loading && remoteTriggered)

  // Локальный мгновенный фильтр по curated-списку
  const q = query.trim().toLowerCase()
  const localFiltered = q === '' ? CURATED_SKILL_REPOS : CURATED_SKILL_REPOS.filter(s =>
    s.name.toLowerCase().includes(q) || s.fullName.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  )

  // Установка кураторного skill-репозитория — конвертируем в MarketplaceSkill
  const handleCuratedInstall = (repo: CuratedSkillRepo) => {
    const fakeSkill: MarketplaceSkill = {
      id: repo.id,
      name: repo.name,
      fullName: repo.fullName,
      description: repo.description,
      htmlUrl: repo.htmlUrl,
      stars: repo.stars,
      language: null,
      topics: [],
      license: null,
      updatedAt: '',
    }
    onInstallRequest(fakeSkill)
  }

  const handleUrlInstalled = async (count: number) => {
    setUrlMsg(`Установлено скиллов: ${count}`)
    await reloadSkills()
    setTimeout(() => setUrlMsg(''), 3000)
  }

  // Remote поиск — ТОЛЬКО по кнопке
  const triggerRemoteSearch = () => {
    setRemoteTriggered(true)
    search(query)
  }

  // Сбрасываем remote-результаты при изменении запроса
  useEffect(() => {
    if (remoteTriggered) {
      setRemoteTriggered(false)
      cancelSearch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  return (
    <div className="ext-catalog">
      <div className="ext-catalog-header">
        <button className="ext-action-btn" onClick={onBack}>
          <AppIcon name="chevronLeft" size="xs" />
          Назад
        </button>
        <input
          className="ext-catalog-search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Поиск скиллов…"
          autoFocus
        />
        {loading && remoteTriggered && (
          <button className="ext-search-cancel-btn" onClick={() => { cancelSearch(); setRemoteTriggered(false) }}>
            <AppIcon name="x" size="xs" />
          </button>
        )}
      </div>

      {/* URL-установка — всегда видна */}
      <UrlInstallBox onInstalled={handleUrlInstalled} />
      {urlMsg && <div className="ext-scope-success">{urlMsg}</div>}

      {/* Локальные результаты (мгновенно) */}
      {q !== '' && localFiltered.length > 0 && (
        <div className="ext-curated-section">
          <div className="ext-curated-title">
            <AppIcon name="star" size="sm" tone="accent" />
            Из каталога (мгновенно)
            <span className="ext-curated-count">{localFiltered.length}</span>
          </div>
          <div className="ext-catalog-grid">
            {localFiltered.map(repo => (
              <div key={repo.id} className="ext-catalog-card" onClick={() => handleCuratedInstall(repo)}>
                <div className="ext-catalog-card-title">{repo.fullName}</div>
                <div className="ext-catalog-card-desc">{repo.description}</div>
                <div className="ext-catalog-card-meta">
                  <span className="ext-catalog-card-stars">
                    <AppIcon name="star" size="xs" /> {repo.stars.toLocaleString('ru')}
                  </span>
                  <span className="ext-catalog-card-version">{repo.skills.length} скиллов</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Кураторный список с категориями — только при пустом запросе */}
      {q === '' && (
        <CuratedSkillsGrid onInstall={handleCuratedInstall} />
      )}

      {/* Кнопка запуска remote-поиска */}
      {query.trim() !== '' && !remoteTriggered && !loading && results.length === 0 && (
        <div className="ext-remote-search-cta">
          <div className="ext-remote-search-hint">
            {localFiltered.length > 0
              ? 'Не нашли нужное в каталоге?'
              : 'В каталоге ничего не найдено.'}
          </div>
          <button className="ext-action-btn" onClick={triggerRemoteSearch}>
            <AppIcon name="globe" size="xs" />
            Искать на GitHub
          </button>
        </div>
      )}

      {/* Remote: результаты из GitHub */}
      {remoteTriggered && (
        <>
          <div className="ext-curated-title ext-curated-title--mt">
            <AppIcon name="globe" size="sm" tone="muted" />
            Поиск на GitHub
          </div>
          {error ? (
            <div className="ext-empty">
              <AppIcon name="alertCircle" size="lg" tone="danger" />
              <div className="ext-empty-extra">{error}</div>
              <div className="ext-empty-extra-btn">
                <button className="ext-action-btn" onClick={() => search(query)}>Повторить</button>
              </div>
            </div>
          ) : loading && results.length === 0 ? (
            <SearchProgress
              label="Поиск на GitHub"
              elapsed={elapsed}
              onCancel={() => { cancelSearch(); setRemoteTriggered(false) }}
            />
          ) : results.length === 0 ? (
            <div className="ext-empty">
              <div className="ext-empty-extra">Ничего не найдено на GitHub.</div>
              <div style={{ color: 'var(--text-muted)' }}>Попробуйте установить по URL выше.</div>
            </div>
          ) : (
            <>
              {loading && (
                <SearchProgress label="Догрузка результатов" elapsed={elapsed} onCancel={() => { cancelSearch(); setRemoteTriggered(false) }} />
              )}
              <div className="ext-catalog-grid">
                {results.map(item => (
                  <div key={item.id} className="ext-catalog-card" onClick={() => openDetail(item)}>
                    <div className="ext-catalog-card-title">{item.name}</div>
                    <div className="ext-catalog-card-desc">{item.description || 'Без описания'}</div>
                    <div className="ext-catalog-card-meta">
                      <span className="ext-catalog-card-stars">
                        <AppIcon name="star" size="xs" /> {item.stars.toLocaleString('ru')}
                      </span>
                      {item.language && <span className="ext-catalog-card-lang">{item.language}</span>}
                    </div>
                  </div>
                ))}
              </div>
              {hasMore && (
                <div className="ext-actions ext-actions--center">
                  <button className="ext-action-btn" onClick={loadMore} disabled={loading}>
                    {loading ? 'Загрузка…' : 'Загрузить ещё'}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function SkillsDetail({
  onBack,
  onInstallRequest,
}: {
  onBack: () => void
  onInstallRequest: (skill: MarketplaceSkill) => void
}): JSX.Element | null {
  const item = useExtensionsStore(s => s.skillsCatalogDetail)
  const readme = useExtensionsStore(s => s.skillsCatalogReadme)
  const readmeLoading = useExtensionsStore(s => s.skillsCatalogReadmeLoading)

  if (!item) return null

  return (
    <div className="ext-detail">
      <button className="ext-action-btn" onClick={onBack}>
        <AppIcon name="chevronLeft" size="xs" />
        Назад к каталогу
      </button>

      <div className="ext-detail-header">
        <div className="ext-detail-icon"><AppIcon name="puzzle" size="lg" tone="accent" /></div>
        <div>
          <div className="ext-detail-title">{item.name}</div>
          <div className="ext-detail-desc">{item.description || 'Без описания'}</div>
        </div>
      </div>

      <div className="ext-detail-links">
        <a href={item.htmlUrl} target="_blank" rel="noreferrer" className="ext-detail-link">
          <AppIcon name="git" size="xs" /> {item.fullName}
        </a>
        <span className="ext-detail-link">
          <AppIcon name="star" size="xs" /> {item.stars.toLocaleString('ru')}
        </span>
        {item.language && <span className="ext-detail-link"><AppIcon name="code" size="xs" /> {item.language}</span>}
      </div>

      {item.topics.length > 0 && (
        <div className="ext-detail-topics">
          {item.topics.slice(0, 10).map(t => <span key={t} className="ext-detail-topic">{t}</span>)}
        </div>
      )}

      <div className="ext-detail-section">
        <div className="ext-detail-section-title">README</div>
        <div className="ext-detail-readme">
          {readmeLoading ? (
            <AppIcon name="loader" size="sm" tone="muted" animation="spin" />
          ) : readme ? (
            <ReactMarkdown>{readme.slice(0, 4000)}</ReactMarkdown>
          ) : (
            <span className="ext-env-empty">README не найден.</span>
          )}
        </div>
      </div>

      <div className="ext-actions" style={{ marginTop: 14 }}>
        <button className="ext-action-btn ext-action-btn--primary" onClick={() => onInstallRequest(item)}>
          <AppIcon name="download" size="xs" />
          Установить
        </button>
      </div>
    </div>
  )
}

// ── Диалог выбора scope установки ────────────────────────────────────────────

function ScopeDialog({
  pending,
  currentProjectId,
  onCancel,
  onInstalled,
  onMcpInstalledDirect,
}: {
  pending: PendingInstall
  currentProjectId?: string
  onCancel: () => void
  onInstalled: (chatId: string, projectId: string | undefined, userMsg: Message) => void
  /** Прямая установка MCP (без агента) — сервер уже записан и подключается. */
  onMcpInstalledDirect?: (serverName: string) => void
}): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [target, setTarget] = useState<InstallTarget>(currentProjectId ? { type: 'project', projectId: currentProjectId, workdir: '' } : { type: 'global' })
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [envValues, setEnvValues] = useState<Record<string, string>>({})
  const [positionalValues, setPositionalValues] = useState<string[]>([])

  // Вычисляем обязательные env-переменные для MCP package установки
  const mcpEnvRequirements = pending.kind === 'mcp' && pending.choice.type === 'package'
    ? (pending.choice.package.environmentVariables ?? []).filter(v => v.isRequired || v.isSecret)
    : []
  const mcpHeaderRequirements = pending.kind === 'mcp' && pending.choice.type === 'remote'
    ? (pending.choice.remote.headers ?? []).filter(h => h.isRequired || h.isSecret)
    : []
  const requiredSecrets = [...mcpEnvRequirements, ...mcpHeaderRequirements]
  const missingSecrets = requiredSecrets.filter(r => !envValues[r.name]?.trim())

  // Позиционные аргументы (пути, строки подключения и т.д.)
  const positionalArgs = pending.kind === 'mcp' && pending.choice.type === 'package'
    ? (pending.choice.package.positionalArgs ?? [])
    : []
  const missingPositional = positionalArgs.filter((a, i) => a.isRequired && !positionalValues[i]?.trim())

  useEffect(() => {
    window.syntee.projects.getAll().then((all: Project[]) => {
      setProjects(all)
      if (currentProjectId) {
        const p = all.find(pr => pr.id === currentProjectId)
        if (p) setTarget({ type: 'project', projectId: p.id, workdir: p.workdir })
      }
    })
  }, [currentProjectId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const title = pending.kind === 'mcp' ? pending.server.title : pending.skill.name

  const install = async () => {
    setError('')
    // Проверяем что все обязательные секреты заполнены
    if (missingSecrets.length > 0) {
      setError(`Заполните обязательные поля: ${missingSecrets.map(s => s.name).join(', ')}`)
      return
    }
    if (missingPositional.length > 0) {
      setError(`Заполните: ${missingPositional.map(a => a.label).join(', ')}`)
      return
    }
    setInstalling(true)
    try {
      let workdir: string | undefined
      let projectId: string | undefined

      if (target.type === 'new-project') {
        const picked = await window.syntee.projects.pickWorkdir()
        if (!picked) { setInstalling(false); return }
        const project = await window.syntee.projects.create(picked) as Project
        workdir = project.workdir
        projectId = project.id
      } else if (target.type === 'project') {
        const p = projects.find(pr => pr.id === target.projectId)
        workdir = p?.workdir
        projectId = target.projectId
      }

      const scope = workdir ? { workdir } : ('global' as const)

      // ── MCP: прямая установка (без агента) ──
      // Приложение само пишет mcp.json и запускает подключение в фоне.
      // Быстро, надёжно, не создаёт лишний чат.
      if (pending.kind === 'mcp') {
        const choice = pending.choice
        let installParams: {
          name: string
          transport: 'stdio' | 'sse' | 'streamable-http'
          command?: string
          args?: string[]
          env?: Record<string, string>
          url?: string
          headers?: Record<string, string>
        }

        if (choice.type === 'package') {
          // stdio-пакет
          const pkg = choice.package
          const serverName = pending.server.title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || pending.server.id
          const isWin = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
          if (pkg.registryType === 'npm') {
            const cmd = isWin ? 'cmd' : 'npx'
            // Добавляем позиционные значения (пути и т.д.) после packageArguments
            const posArgs = positionalValues.filter(v => v?.trim()).flatMap(v => v.trim().split(/\s+/))
            const cmdArgs = isWin
              ? ['/c', 'npx', '-y', `${pkg.identifier}@${pkg.version}`, ...(pkg.packageArguments ?? []), ...posArgs]
              : ['-y', `${pkg.identifier}@${pkg.version}`, ...(pkg.packageArguments ?? []), ...posArgs]
            installParams = {
              name: serverName,
              transport: 'stdio' as const,
              command: cmd,
              args: cmdArgs,
              env: Object.keys(envValues).length > 0 ? envValues : undefined,
            }
          } else if (pkg.registryType === 'pypi') {
            installParams = {
              name: serverName,
              transport: 'stdio' as const,
              command: 'uvx',
              args: [pkg.identifier, ...(pkg.packageArguments ?? [])],
              env: Object.keys(envValues).length > 0 ? envValues : undefined,
            }
          } else if (pkg.registryType === 'oci') {
            // OCI/Docker — запускаем через docker run -i --rm <image>
            const posArgs = positionalValues.filter(v => v?.trim()).flatMap(v => v.trim().split(/\s+/))
            installParams = {
              name: serverName,
              transport: 'stdio' as const,
              command: 'docker',
              args: ['run', '-i', '--rm', pkg.identifier, ...(pkg.packageArguments ?? []), ...posArgs],
              env: Object.keys(envValues).length > 0 ? envValues : undefined,
            }
          } else {
            throw new Error(`Неподдерживаемый тип пакета: ${pkg.registryType}`)
          }
        } else {
          // remote (sse/streamable-http)
          const remote = choice.remote
          installParams = {
            name: pending.server.title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || pending.server.id,
            transport: remote.type,
            url: remote.url,
            headers: Object.keys(envValues).length > 0 ? envValues : undefined,
          }
        }

        const result = await window.syntee.mcp.installDirect({
          ...installParams,
          scope,
        }) as { ok: boolean; serverName: string; error?: string }

        if (!result.ok) {
          throw new Error(result.error || 'Не удалось установить сервер')
        }

        // Перезагружаем список серверов чтобы новый появился сразу
        await useExtensionsStore.getState().loadMcpServers()
        onMcpInstalledDirect?.(result.serverName)
        return
      }

      // ── Skills: установка через агента (нужен git clone) ──
      const message = await window.syntee.marketplace.buildSkillInstruction({
        skill: pending.skill,
        scope,
      }) as string

      const chat = await window.syntee.chat.create(false, 'code', projectId) as { id: string }
      const userMsgId = uuid()

      await window.syntee.chat.send({
        chatId: chat.id,
        content: message,
        userMsgId,
      })

      const userMsg: Message = {
        id: userMsgId,
        chatId: chat.id,
        role: 'user',
        content: message,
        createdAt: Date.now(),
        isPinned: 0,
      }
      onInstalled(chat.id, projectId, userMsg)
    } catch (e) {
      setError((e as Error).message || 'Не удалось запустить установку')
      setInstalling(false)
    }
  }

  return createPortal(
    <motion.div
      className="ext-modal-overlay"
      style={{ zIndex: 10010 }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <motion.div
        className="ext-scope-dialog"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{
          duration: 0.24,
          ease: [0.16, 1, 0.3, 1],
          exit: { duration: 0.15, ease: 'easeIn' },
        }}
      >
        <div className="ext-scope-dialog-title">Куда установить «{title}»?</div>
        <div className="ext-scope-options">
          <label className={`ext-scope-option${target.type === 'global' ? ' ext-scope-option--active' : ''}`}>
            <input type="radio" checked={target.type === 'global'} onChange={() => setTarget({ type: 'global' })} />
            <div>
              <div className="ext-scope-option-title">Глобально</div>
              <div className="ext-scope-option-sub">Доступно во всех чатах</div>
            </div>
          </label>
          {projects.map(p => (
            <label key={p.id} className={`ext-scope-option${target.type === 'project' && target.projectId === p.id ? ' ext-scope-option--active' : ''}`}>
              <input
                type="radio"
                checked={target.type === 'project' && target.projectId === p.id}
                onChange={() => setTarget({ type: 'project', projectId: p.id, workdir: p.workdir })}
              />
              <div>
                <div className="ext-scope-option-title">{p.name}</div>
                <div className="ext-scope-option-sub">{p.workdir}</div>
              </div>
            </label>
          ))}
          <label className={`ext-scope-option${target.type === 'new-project' ? ' ext-scope-option--active' : ''}`}>
            <input type="radio" checked={target.type === 'new-project'} onChange={() => setTarget({ type: 'new-project' })} />
            <div>
              <div className="ext-scope-option-title">+ Новый проект</div>
              <div className="ext-scope-option-sub">Выбрать папку на диске</div>
            </div>
          </label>
        </div>

        {/* Позиционные аргументы (пути, строки подключения) — для MCP package */}
        {positionalArgs.length > 0 && (
          <div className="ext-detail-section ext-detail-section--mt">
            <div className="ext-detail-section-title">Параметры сервера</div>
            {positionalArgs.map((arg, i) => {
              const isMissing = arg.isRequired && !positionalValues[i]?.trim()
              return (
                <div key={i} className="ext-form-row">
                  <span className="ext-form-label">
                    {arg.label}{arg.isRequired ? ' *' : ''}
                  </span>
                  <input
                    className={`ext-form-input${isMissing ? ' ext-form-input--invalid' : ''}`}
                    type="text"
                    value={positionalValues[i] ?? arg.defaultValue ?? ''}
                    onChange={e => setPositionalValues(prev => {
                      const next = [...prev]
                      next[i] = e.target.value
                      return next
                    })}
                    placeholder={arg.placeholder}
                  />
                  {isMissing && <span className="ext-form-hint">Обязательное поле</span>}
                </div>
              )
            })}
          </div>
        )}

        {/* Форма для обязательных env-переменных/секретов (MCP прямая установка) */}
        {requiredSecrets.length > 0 && (
          <div className="ext-detail-section ext-detail-section--mt">
            <div className="ext-detail-section-title">
              {pending.kind === 'mcp' && pending.choice.type === 'package' ? 'Переменные окружения' : 'Заголовки'}
            </div>
            {requiredSecrets.map(r => {
              const isMissing = r.isRequired && !envValues[r.name]?.trim()
              return (
                <div key={r.name} className="ext-form-row">
                  <span className="ext-form-label">
                    {r.name}{r.isRequired ? ' *' : ''}
                  </span>
                  <input
                    className={`ext-form-input${isMissing ? ' ext-form-input--invalid' : ''}`}
                    type={r.isSecret ? 'password' : 'text'}
                    value={envValues[r.name] ?? ''}
                    onChange={e => setEnvValues(prev => ({ ...prev, [r.name]: e.target.value }))}
                    placeholder={r.description || r.name}
                  />
                  {isMissing && <span className="ext-form-hint">Обязательное поле</span>}
                </div>
              )
            })}
          </div>
        )}

        {/* Для MCP package с необязательными env — тоже показываем форму */}
        {pending.kind === 'mcp' && pending.choice.type === 'package' &&
         (pending.choice.package.environmentVariables ?? []).filter(v => !v.isRequired && !v.isSecret).length > 0 && (
          <div className="ext-detail-section ext-detail-section--mt">
            <div className="ext-detail-section-title">Дополнительные переменные (необязательно)</div>
            {(pending.choice.package.environmentVariables ?? []).filter(v => !v.isRequired && !v.isSecret).map(r => (
              <div key={r.name} className="ext-form-row">
                <span className="ext-form-label">{r.name}</span>
                <input
                  className="ext-form-input"
                  type="text"
                  value={envValues[r.name] ?? ''}
                  onChange={e => setEnvValues(prev => ({ ...prev, [r.name]: e.target.value }))}
                  placeholder={r.description || r.name}
                />
              </div>
            ))}
          </div>
        )}

        {error && <div className="ext-scope-error">{error}</div>}

        <div className="ext-form-actions">
          <button className="ext-action-btn" onClick={onCancel} disabled={installing}>Отмена</button>
          <button className="ext-action-btn ext-action-btn--primary" onClick={install} disabled={installing || missingSecrets.length > 0 || missingPositional.length > 0}>
            {installing ? 'Установка…' : 'Установить'}
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  )
}
