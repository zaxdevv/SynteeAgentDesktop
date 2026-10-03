/** Recursive discovery of skill packages and legacy standalone Markdown skills. */
import { existsSync, statSync, readdirSync, readFileSync } from 'fs'
import { join, relative, dirname, basename, resolve } from 'path'
import { app } from 'electron'
import type { Skill, SkillSource } from '../../shared/types'

interface ParsedFrontmatter {
  name?: string
  description?: string
}

/** Flat YAML, including folded/literal multiline descriptions used by skill packs. */
function parseFlatYaml(text: string): ParsedFrontmatter {
  const raw: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) continue
    let val = m[2].trim()
    if (/^[>|][+-]?$/.test(val)) {
      const parts: string[] = []
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        parts.push(lines[++i].trim())
      }
      val = parts.join(val.startsWith('>') ? ' ' : '\n').trim()
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    raw[m[1]] = val
  }
  return { name: raw.name, description: raw.description }
}

function parseSkillFile(filePath: string, rootDir: string, source: SkillSource, inPackage: boolean): Skill | null {
  try {
    const content = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '')
    const filename = basename(filePath)
    const nameNoExt = filename.replace(/\.md$/i, '')
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    const fm = fmMatch ? parseFlatYaml(fmMatch[1]) : {}
    const entrypoint = /^skill\.md$/i.test(filename)
    // REFERENCE.md (and other filenames) with skill metadata is an entrypoint too.
    const namedSkill = !!fm.name?.trim() && !!fm.description?.trim()
    // Preserve old plain .md collections, but never turn package reference docs into skills.
    if (!entrypoint && !namedSkill && (inPackage || /^(readme|changelog|license|reference|technique)\.md$/i.test(filename))) return null
    const instructions = (fmMatch ? fmMatch[2] : content).trim()
    if (!instructions) return null
    const relativePath = relative(rootDir, filePath).replace(/\\/g, '/')
    const name = fm.name?.trim() || (entrypoint ? basename(dirname(filePath)) : nameNoExt)
    const description = fm.description?.trim() || instructions.split(/\r?\n/).find(ln => ln.trim())?.trim() || name
    return {
      // Keep old global root-file IDs; nested files are unique by relative path.
      id: `${source}::${relativePath.replace(/\.md$/i, '')}`,
      name,
      description,
      instructions,
      source,
      filePath,
      rootDir,
      baseDir: dirname(filePath),
      relativePath,
      legacyId: relativePath.includes('/') ? undefined : `${source}::${nameNoExt}`,
      mtimeMs: statSync(filePath).mtimeMs,
    }
  } catch {
    return null
  }
}

const IGNORED_DIRS = new Set(['node_modules', 'assets', 'agents', 'scripts', 'dist', 'out', '__pycache__'])

/** Symlinks/junctions are not followed, avoiding cycles and escaping the skills root. */
export function scanSkillDirectory(dir: string, source: SkillSource): Skill[] {
  if (!existsSync(dir)) return []
  const rootDir = resolve(dir)
  const skills: Skill[] = []
  const visit = (current: string, parentIsPackage: boolean) => {
    try {
      const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      const inPackage = parentIsPackage || entries.some(e => e.isFile() && /^(skill|reference)\.md$/i.test(e.name))
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name.toLowerCase())) continue
          visit(full, inPackage)
        } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          const skill = parseSkillFile(full, rootDir, source, inPackage)
          if (skill) skills.push(skill)
        }
      }
    } catch { /* Unreadable folders do not hide the rest of the collection. */ }
  }
  visit(rootDir, false)
  return skills
}

export function loadAllSkills(projectWorkdir?: string, builtinDir?: string): Skill[] {
  const out: Skill[] = []
  const builtinPath = builtinDir ?? join(process.resourcesPath ?? '', 'skills')
  if (builtinPath && existsSync(builtinPath)) out.push(...scanSkillDirectory(builtinPath, 'builtin'))
  try {
    out.push(...scanSkillDirectory(join(app.getPath('userData'), 'skills'), 'user'))
  } catch { /* app unavailable in headless tests */ }
  if (projectWorkdir) out.push(...scanSkillDirectory(join(projectWorkdir, '.syntee', 'skills'), 'project'))
  return out
}

/** Include project identity BEFORE looking up state, preventing collisions between projects. */
export function tagProjectSkills(skills: Skill[], projectId: string): Skill[] {
  return skills.map(s => s.source === 'project' ? {
    ...s,
    projectId,
    id: `project:${projectId}:${(s.relativePath ?? basename(s.filePath)).replace(/\.md$/i, '')}`,
  } : s)
}
