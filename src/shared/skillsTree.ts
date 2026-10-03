import type { Skill, SkillSource, SkillState } from './types/skill'

export type SkillWithState = Skill & { state: SkillState }

export interface SkillTreeFolder {
  key: string
  name: string
  source: SkillSource
  projectId?: string
  folderPath: string
  filePath: string
  children: SkillTreeFolder[]
  skills: SkillWithState[]
  /** All descendants, independent of UI search/filter. */
  descendants: SkillWithState[]
}

export function skillFolderKey(source: SkillSource, projectId: string | undefined, path: string): string {
  return JSON.stringify([source, projectId ?? '', path])
}

export function isSkillInFolder(relativePath: string, folderPath: string): boolean {
  return !folderPath || relativePath.startsWith(`${folderPath}/`)
}

/** Build the full tree first; filtering must not change the target of a folder toggle. */
export function buildSkillTree(skills: SkillWithState[]): SkillTreeFolder[] {
  const roots = new Map<string, SkillTreeFolder>()
  for (const skill of skills) {
    const rootKey = skillFolderKey(skill.source, skill.projectId, '')
    let root = roots.get(rootKey)
    if (!root) {
      root = {
        key: rootKey, source: skill.source, projectId: skill.projectId,
        name: skill.source === 'builtin' ? 'Встроенные' : skill.source === 'user' ? 'Личные скиллы' : 'Скиллы проекта',
        folderPath: '', filePath: skill.rootDir ?? '', children: [], skills: [], descendants: [],
      }
      roots.set(rootKey, root)
    }
    root.descendants.push(skill)
    let node = root
    const segments = (skill.relativePath ?? skill.filePath.split(/[\\/]/).pop() ?? skill.name).split('/').slice(0, -1)
    for (let i = 0; i < segments.length; i++) {
      const folderPath = segments.slice(0, i + 1).join('/')
      let child = node.children.find(c => c.folderPath === folderPath)
      if (!child) {
        child = {
          key: skillFolderKey(skill.source, skill.projectId, folderPath), name: segments[i],
          source: skill.source, projectId: skill.projectId, folderPath,
          filePath: skill.rootDir ? `${skill.rootDir}/${folderPath}` : '',
          children: [], skills: [], descendants: [],
        }
        node.children.push(child)
      }
      child.descendants.push(skill)
      node = child
    }
    node.skills.push(skill)
  }
  const sort = (node: SkillTreeFolder) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name))
    node.skills.sort((a, b) => a.name.localeCompare(b.name))
    node.children.forEach(sort)
  }
  const result = [...roots.values()]
  result.forEach(sort)
  const order: SkillSource[] = ['user', 'project', 'builtin']
  return result.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))
}
