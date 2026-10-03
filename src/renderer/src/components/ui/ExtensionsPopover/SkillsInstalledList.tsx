import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ExtensionScope, Project, SkillState } from '@shared/types'
import { buildSkillTree, type SkillTreeFolder, type SkillWithState } from '@shared/skillsTree'
import { useExtensionsStore } from '../../../store/extensions.store'
import AppIcon from '../AppIcon/AppIcon'
import ExtListToolbar from './ExtListToolbar'
import ScopeSelector, { scopeLabel } from './ScopeSelector'
import './SkillsInstalledList.css'

type Filter = 'all' | 'enabled' | 'disabled' | 'builtin' | 'user' | 'project'
const EXPANSION_KEY = 'syntee.skills.tree.expanded.v1'

function readExpanded(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(EXPANSION_KEY) ?? '{}') ?? {} } catch { return {} }
}

function SkillCheck({ checked, mixed, disabled, label, onChange }: {
  checked: boolean; mixed?: boolean; disabled: boolean; label: string; onChange: () => void
}) {
  return (
    <button type="button" role="checkbox" aria-checked={mixed ? 'mixed' : checked}
      aria-label={label} title={label} disabled={disabled} onClick={onChange}
      className={`skill-tree-check${checked || mixed ? ' skill-tree-check--on' : ''}`}>
      {(checked || mixed) && <AppIcon name={mixed ? 'minus' : 'check'} size="xs" />}
    </button>
  )
}

export default function SkillsInstalledList({ projectId, projects, onBrowseCatalog }: {
  projectId?: string; projects: Project[]; onBrowseCatalog: () => void
}) {
  const skills = useExtensionsStore(s => s.skills)
  const loading = useExtensionsStore(s => s.skillsLoading)
  const loadError = useExtensionsStore(s => s.skillsError)
  const setSkillState = useExtensionsStore(s => s.setSkillState)
  const setFolderState = useExtensionsStore(s => s.setSkillFolderState)
  const reload = useExtensionsStore(s => s.reloadSkills)
  const [expanded, setExpanded] = useState(readExpanded)
  const [detail, setDetail] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const tree = useMemo(() => buildSkillTree(skills), [skills])
  const q = search.trim().toLowerCase()
  const enabledCount = skills.filter(s => s.state.enabled).length

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось обновить скиллы') }
    finally { setBusy(false) }
  }
  const toggleFolder = (node: SkillTreeFolder) => {
    const value = !(expanded[node.key] ?? node.folderPath.split('/').length <= 1)
    const next = { ...expanded, [node.key]: value }
    setExpanded(next)
    try { localStorage.setItem(EXPANSION_KEY, JSON.stringify(next)) } catch { /* Storage unavailable. */ }
  }
  const changeFolder = (node: SkillTreeFolder, patch: Partial<SkillState>) => setFolderState({
    source: node.source, projectId: node.projectId, folderPath: node.folderPath, patch,
  })
  const visible = (skill: SkillWithState) => {
    if (q && !`${skill.name} ${skill.description} ${skill.relativePath ?? ''}`.toLowerCase().includes(q)) return false
    if (filter === 'enabled') return skill.state.enabled
    if (filter === 'disabled') return !skill.state.enabled
    return filter === 'all' || skill.source === filter
  }
  const visibleIds = new Set(skills.filter(visible).map(s => s.id))
  const disabled = busy || loading
  const openFolder = async (path?: string) => {
    if (path) {
      const error = await window.syntee.shell.openPath(path)
      if (error) throw new Error(error)
    }
  }
  const scopeText = (node: SkillTreeFolder) => {
    const scopes = node.descendants.map(s => JSON.stringify(s.state.scope))
    return scopes.every(s => s === scopes[0]) ? scopeLabel(node.descendants[0].state.scope) : 'разные области'
  }

  const renderSkill = (skill: SkillWithState, depth: number) => (
    <div key={skill.id} className={`skill-tree-leaf${skill.state.enabled ? ' skill-tree-leaf--enabled' : ''}`}>
      <div className="skill-tree-row" style={{ '--skill-depth': depth } as CSSProperties}>
        <span className="skill-tree-spacer" />
        <SkillCheck checked={skill.state.enabled} disabled={disabled}
          label={`${skill.state.enabled ? 'Выключить' : 'Включить'} ${skill.name}`}
          onChange={() => { void run(() => setSkillState(skill.id, { ...skill.state, enabled: !skill.state.enabled }, skill.source)) }} />
        <AppIcon name="puzzle" size="sm" tone={skill.state.enabled ? 'accent' : 'muted'} />
        <button className="skill-tree-main" aria-expanded={detail === skill.id} onClick={() => setDetail(detail === skill.id ? null : skill.id)}>
          <span className="skill-tree-name">{skill.name}</span>
          <span className="skill-tree-description">{skill.description}</span>
        </button>
        <span className="skill-tree-scope">{scopeLabel(skill.state.scope)}</span>
        <button className="skill-tree-icon-btn" title="Подробнее" aria-label={`Подробнее о ${skill.name}`}
          onClick={() => setDetail(detail === skill.id ? null : skill.id)}>
          <AppIcon name={detail === skill.id ? 'chevronUp' : 'info'} size="xs" />
        </button>
      </div>
      {detail === skill.id && (
        <div className="skill-tree-details">
          <ScopeSelector scope={skill.state.scope} projects={projects} currentProjectId={projectId}
            disabled={disabled} onChange={(scope: ExtensionScope) => { void run(() => setSkillState(skill.id, { ...skill.state, scope }, skill.source)) }} />
          <div className="skill-tree-path" title={skill.filePath}>{skill.relativePath ?? skill.filePath}</div>
          <div className="ext-instructions-box">{skill.instructions}</div>
          <button className="ext-action-btn" disabled={disabled} onClick={() => { void run(() => window.syntee.shell.showItemInFolder(skill.filePath)) }}>
            <AppIcon name="folder" size="xs" /> Показать файл
          </button>
        </div>
      )}
    </div>
  )

  const renderFolder = (node: SkillTreeFolder, depth: number): JSX.Element | null => {
    if (!node.descendants.some(s => visibleIds.has(s.id))) return null
    const count = node.descendants.filter(s => s.state.enabled).length
    const all = count === node.descendants.length
    const mixed = count > 0 && !all
    const open = !!q || filter !== 'all' || (expanded[node.key] ?? node.folderPath.split('/').length <= 1)
    const scope = node.descendants[0].state.scope
    return (
      <div className={`skill-tree-folder${depth === 0 ? ' skill-tree-root' : ''}`} key={node.key}>
        <div className="skill-tree-row skill-tree-row--folder" style={{ '--skill-depth': depth } as CSSProperties}>
          <button className="skill-tree-icon-btn" onClick={() => toggleFolder(node)} aria-expanded={open}
            aria-label={`${open ? 'Свернуть' : 'Раскрыть'} ${node.name}`}>
            <AppIcon name={open ? 'chevronDown' : 'chevronRight'} size="xs" />
          </button>
          <SkillCheck checked={all} mixed={mixed} disabled={disabled}
            label={`${all ? 'Выключить' : 'Включить'} все скиллы в ${node.name}`}
            onChange={() => { void run(() => changeFolder(node, { enabled: !all })) }} />
          <AppIcon name="folder" size="sm" tone={count ? 'accent' : 'muted'} />
          <button className="skill-tree-main" onClick={() => toggleFolder(node)} title={node.filePath}>
            <span className="skill-tree-name">{node.name}</span>
          </button>
          <span className={`skill-tree-count${count ? ' skill-tree-count--active' : ''}`} title="Включено / всего скиллов, включая вложенные папки">{count} / {node.descendants.length}</span>
          <span className="skill-tree-scope">{scopeText(node)}</span>
          <button className="skill-tree-icon-btn" title="Настройки всей папки" aria-label={`Настройки папки ${node.name}`}
            aria-expanded={detail === node.key} onClick={() => setDetail(detail === node.key ? null : node.key)}>
            <AppIcon name="settings" size="xs" />
          </button>
        </div>
        {detail === node.key && (
          <div className="skill-tree-details">
            <p className="skill-tree-hint">Настройки применяются ко всей папке, включая вложенные и новые скиллы. После этого отдельные скиллы можно переключать независимо.</p>
            {scopeText(node) === 'разные области' && <p className="skill-tree-hint">Сейчас области различаются. Выбор ниже установит одну область для всей папки.</p>}
            <ScopeSelector scope={scope} projects={projects} currentProjectId={projectId} disabled={disabled}
              onChange={scope => { void run(() => changeFolder(node, { scope })) }} />
            <div className="skill-tree-path">{node.filePath}</div>
            <button className="ext-action-btn" disabled={disabled || !node.filePath} onClick={() => { void run(() => openFolder(node.filePath)) }}>
              <AppIcon name="folder" size="xs" /> Открыть папку
            </button>
          </div>
        )}
        {open && <div className="skill-tree-children">
          {node.skills.filter(s => visibleIds.has(s.id)).map(s => renderSkill(s, depth + 1))}
          {node.children.map(child => renderFolder(child, depth + 1))}
        </div>}
      </div>
    )
  }

  return (
    <>
      <div className="ext-catalog-cta skill-tree-toolbar">
        <div className="ext-catalog-cta-actions">
          <button className="ext-action-btn" disabled={disabled} onClick={() => { void run(() => reload(projectId)) }}>
            <AppIcon name="refreshCw" size="xs" animation={loading ? 'spin' : undefined} /> Обновить
          </button>
          <button className="ext-action-btn" disabled={disabled} onClick={() => { void run(async () => {
            const paths = await window.syntee.shell.getExtensionsPaths()
            await openFolder(paths.skillsUserDir)
          }) }}><AppIcon name="folder" size="xs" /> Папка скиллов</button>
          {skills.length > 0 && <button className="ext-action-btn" disabled={disabled} onClick={() => { void run(async () => {
            for (const root of tree) await changeFolder(root, { enabled: enabledCount !== skills.length })
          }) }}><AppIcon name="power" size="xs" />{enabledCount === skills.length ? 'Выключить все' : 'Включить все'}</button>}
        </div>
        <button className="ext-action-btn ext-action-btn--primary" onClick={onBrowseCatalog}><AppIcon name="plus" size="xs" /> Из каталога</button>
      </div>
      {(error || loadError) && <div className="skill-tree-error" role="alert">{error || loadError}</div>}
      <p className="skill-tree-hint">Галочка папки включает все скиллы внутри. Инструкции и связанные материалы агент читает по необходимости.</p>
      {skills.length > 0 && <ExtListToolbar search={search} onSearch={setSearch} placeholder="Поиск скиллов, папок и описаний…"
        filters={[
          { value: 'all', label: 'Все', count: skills.length },
          { value: 'enabled', label: 'Включены', count: enabledCount },
          { value: 'disabled', label: 'Отключены', count: skills.length - enabledCount },
          ...(['user', 'project', 'builtin'] as const).map(source => ({ value: source, label: source === 'user' ? 'Личные' : source === 'project' ? 'Проектные' : 'Встроенные', count: skills.filter(s => s.source === source).length })),
        ]} activeFilter={filter} onFilter={setFilter} />}
      {skills.length === 0 && <div className="ext-empty">
        <AppIcon name="puzzle" size="xl" tone="muted" />
        <p>{loading ? 'Поиск скиллов…' : 'Скиллы не найдены. Добавьте .md-файл или целую папку с пакетом в skills и нажмите «Обновить».'}</p>
        <p>Поддерживаются вложенные папки, SKILL.md и другие .md с name / description.</p>
      </div>}
      {skills.length > 0 && visibleIds.size === 0 && <div className="ext-empty">По этому запросу и фильтру ничего не найдено.</div>}
      <div className="skill-tree" aria-label="Папки и скиллы">{tree.map(root => renderFolder(root, 0))}</div>
    </>
  )
}
