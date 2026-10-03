import type { ExtensionScope, Project } from '@shared/types'

/** Shared scope picker for individual extensions and whole skill folders. */
export default function ScopeSelector({ scope, projects, currentProjectId, onChange, disabled }: {
  scope: ExtensionScope
  projects: Project[]
  currentProjectId?: string
  onChange: (scope: ExtensionScope) => void
  disabled?: boolean
}): JSX.Element {
  const selectedIds = scope.projectIds ?? []
  const allProjects = currentProjectId && !projects.some(p => p.id === currentProjectId)
    ? [{ id: currentProjectId, name: '(текущий проект)' }, ...projects]
    : projects
  const toggleProject = (pid: string) => {
    const ids = selectedIds.includes(pid) ? selectedIds.filter(id => id !== pid) : [...selectedIds, pid]
    // An empty project selection must NOT unexpectedly activate an extension globally.
    onChange({ type: 'projects', projectIds: ids })
  }
  return (
    <div className="ext-scope-selector">
      <div className="ext-card-row">
        <span className="ext-card-row-label">Область применения</span>
        <div className="ext-scope-radios">
          <label className={`ext-scope-radio${scope.type === 'global' ? ' ext-scope-radio--active' : ''}${disabled ? ' ext-scope-radio--disabled' : ''}`}>
            <input type="radio" checked={scope.type === 'global'} disabled={disabled} onChange={() => onChange({ type: 'global' })} />
            Все чаты
          </label>
          <label className={`ext-scope-radio${scope.type === 'projects' ? ' ext-scope-radio--active' : ''}${disabled ? ' ext-scope-radio--disabled' : ''}`}>
            <input type="radio" checked={scope.type === 'projects'} disabled={disabled} onChange={() => {
              const ids = selectedIds.length ? selectedIds : currentProjectId ? [currentProjectId] : []
              onChange({ type: 'projects', projectIds: ids })
            }} />
            Выбранные проекты
          </label>
        </div>
      </div>
      {scope.type === 'projects' && (
        <div className="ext-scope-projects">
          {allProjects.length === 0 ? <div className="ext-scope-projects-empty">Нет проектов. Создайте проект, чтобы выбрать его здесь.</div> : allProjects.map(p => (
            <label key={p.id} className={`ext-scope-project${disabled ? ' ext-scope-project--disabled' : ''}`}>
              <input type="checkbox" checked={selectedIds.includes(p.id)} disabled={disabled} onChange={() => toggleProject(p.id)} />
              <span className="ext-scope-project-name">{p.name}</span>
              {p.id === currentProjectId && <span className="ext-scope-project-current">текущий</span>}
            </label>
          ))}
          {selectedIds.length > 0 && <div className="ext-scope-projects-count">{selectedIds.length} выбрано</div>}
        </div>
      )}
    </div>
  )
}

export function scopeLabel(scope: ExtensionScope): string {
  if (scope.type === 'global') return 'глобально'
  const n = scope.projectIds?.length ?? 0
  if (n === 0) return 'нет проектов'
  if (n === 1) return '1 проект'
  return `${n} проектов`
}
