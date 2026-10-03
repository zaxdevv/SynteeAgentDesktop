/** Skill discovery, per-file overrides and persistent folder inheritance. */
import Store from 'electron-store'
import { join } from 'path'
import { loadAllSkills, scanSkillDirectory, tagProjectSkills } from './skillLoader'
import { isSkillInFolder, skillFolderKey } from '../../shared/skillsTree'
import type { Skill, SkillState, ExtensionScope, SkillFolderUpdate, SkillSource } from '../../shared/types'

type StateMap = Record<string, Partial<SkillState>>

export class SkillManager {
  private globalSkills: Skill[] | null = null
  constructor(private store: Store) {}

  invalidate(): void {
    this.globalSkills = null
  }

  autoEnableProjectSkills(projectId: string, workdir: string): boolean {
    this.invalidate()
    const skills = this.loadSkills(workdir, projectId).filter(s => s.source === 'project')
    const stateMap = this.readStates()
    const folderStates = this.readFolderStates()
    let changed = false
    for (const skill of skills) {
      // A disabled/enabled folder is an explicit choice, not a new skill to auto-enable.
      if (stateMap[skill.id] || this.folderRules(skill.id, skill.source, folderStates).length) continue
      stateMap[skill.id] = { enabled: true, scope: { type: 'projects', projectIds: [projectId] } }
      changed = true
    }
    if (changed) this.store.set('skillsState', stateMap)
    return changed
  }

  loadSkills(projectWorkdir?: string, projectId?: string): Skill[] {
    if (this.globalSkills === null) this.globalSkills = loadAllSkills()
    let projectSkills: Skill[] = []
    if (projectWorkdir) {
      projectSkills = scanSkillDirectory(join(projectWorkdir, '.syntee', 'skills'), 'project')
      // Also disambiguate chats with a workdir not registered as a project.
      projectSkills = tagProjectSkills(projectSkills, projectId ?? encodeURIComponent(projectWorkdir.toLowerCase()))
    }
    const all = [...this.globalSkills, ...projectSkills]
    // Old root project IDs omitted projectId. Migrate only root files and only if
    // the old project's scope allows this project; never alias nested basenames.
    const states = this.readStates()
    const migrated = (this.store.get('skillsStateMigrated') as Record<string, boolean> | undefined) ?? {}
    let changed = false
    for (const skill of all) {
      const old = skill.legacyId && skill.legacyId !== skill.id ? states[skill.legacyId] : undefined
      if (!old || migrated[skill.id]) continue
      if (old.scope?.type === 'projects' && !old.scope.projectIds?.includes(skill.projectId ?? '')) continue
      if (!states[skill.id]) states[skill.id] = { ...old }
      migrated[skill.id] = true
      changed = true
    }
    if (changed) {
      this.store.set('skillsState', states)
      this.store.set('skillsStateMigrated', migrated)
    }
    return all
  }

  private readStates(): StateMap {
    return (this.store.get('skillsState') as StateMap | undefined) ?? {}
  }

  private readFolderStates(): StateMap {
    return (this.store.get('skillsFolderState') as StateMap | undefined) ?? {}
  }

  /** Root → nearest directory, on exact path boundaries, never 'foo' matching 'foobar'. */
  private folderRules(skillId: string, source: SkillSource, states: StateMap): Partial<SkillState>[] {
    const prefix = `${source}:`
    const rest = skillId.slice(prefix.length)
    const colon = rest.indexOf(':')
    if (colon < 0) return []
    const projectId = rest.slice(0, colon) || undefined
    const path = rest.slice(colon + 1)
    const dirs = path.split('/').slice(0, -1)
    return ['', ...dirs.map((_, i) => dirs.slice(0, i + 1).join('/'))]
      .map(dir => states[skillFolderKey(source, projectId, dir)]).filter((s): s is Partial<SkillState> => !!s)
  }

  getState(skillId: string, source: Skill['source']): SkillState {
    const defaults: SkillState = { enabled: source === 'builtin', scope: { type: 'global' } }
    return Object.assign(defaults, ...this.folderRules(skillId, source, this.readFolderStates()), this.readStates()[skillId])
  }

  setState(skillId: string, state: SkillState): void {
    const states = this.readStates()
    states[skillId] = state
    this.store.set('skillsState', states)
  }

  patchState(skillId: string, patch: Partial<SkillState>, source: Skill['source']): void {
    this.setState(skillId, { ...this.getState(skillId, source), ...patch })
  }

  /** One store operation per map, no per-skill IPC/write races. New children inherit the rule. */
  setFolderState(update: SkillFolderUpdate, projectWorkdir?: string): void {
    const path = update.folderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (path.split('/').some(p => p === '..' || p === '.')) throw new Error('Некорректный путь папки')
    if (!['builtin', 'user', 'project'].includes(update.source)) throw new Error('Некорректный источник')
    const patch: Partial<SkillState> = {}
    if (typeof update.patch.enabled === 'boolean') patch.enabled = update.patch.enabled
    if (update.patch.scope) patch.scope = update.patch.scope
    if (!Object.keys(patch).length) return
    const skills = this.loadSkills(projectWorkdir, update.projectId)
    const candidates = skills.filter(s => s.source === update.source &&
      (s.source !== 'project' || s.projectId === update.projectId))
    if (!candidates.some(s => isSkillInFolder(s.relativePath ?? '', path))) throw new Error('Папка скиллов не найдена')
    const states = this.readStates()
    const folders = this.readFolderStates()
    const clearPatchedFields = (map: StateMap, key: string) => {
      const value = { ...map[key] }
      for (const field of Object.keys(patch) as Array<keyof SkillState>) delete value[field]
      if (Object.keys(value).length) map[key] = value
      else delete map[key]
    }
    // Clear descendant folder overrides for the fields changed by this action.
    for (const key of Object.keys(folders)) {
      try {
        const [source, pid, folder] = JSON.parse(key) as string[]
        if (source === update.source && pid === (update.projectId ?? '') && folder !== path && isSkillInFolder(`${folder}/`, path)) {
          clearPatchedFields(folders, key)
        }
      } catch { /* Ignore invalid obsolete keys. */ }
    }
    // Include stored overrides for temporarily removed files too: re-adding one
    // must obey the most recent folder action rather than resurrecting an old choice.
    const prefix = `${update.source}:${update.projectId ?? ''}:`
    for (const id of Object.keys(states)) {
      if (id.startsWith(prefix) && isSkillInFolder(id.slice(prefix.length), path)) clearPatchedFields(states, id)
    }
    const key = skillFolderKey(update.source, update.projectId, path)
    folders[key] = { ...folders[key], ...patch }
    this.store.set('skillsState', states)
    this.store.set('skillsFolderState', folders)
  }

  private scopeApplies(scope: ExtensionScope, projectId?: string): boolean {
    return scope.type === 'global' || !!projectId && !!scope.projectIds?.includes(projectId)
  }

  getActiveSkillsForChat(opts: { projectWorkdir?: string; projectId?: string; isIncognito?: boolean }): Skill[] {
    if (opts.isIncognito) return []
    return this.loadSkills(opts.projectWorkdir, opts.projectId).filter(skill => {
      const state = this.getState(skill.id, skill.source)
      return state.enabled && this.scopeApplies(state.scope, opts.projectId)
    })
  }

  getAllWithState(opts: { projectWorkdir?: string; projectId?: string } = {}): Array<Skill & { state: SkillState }> {
    return this.loadSkills(opts.projectWorkdir, opts.projectId).map(skill => ({
      ...skill, state: this.getState(skill.id, skill.source),
    }))
  }
}

let skillManagerInstance: SkillManager | null = null
export function initSkillManager(store: Store): SkillManager {
  skillManagerInstance = new SkillManager(store)
  return skillManagerInstance
}
export function getSkillManager(): SkillManager {
  if (!skillManagerInstance) throw new Error('SkillManager не инициализирован. Вызови initSkillManager() в main.')
  return skillManagerInstance
}
