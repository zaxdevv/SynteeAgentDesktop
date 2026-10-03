import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function load(path, mocks = {}) {
  const source = readFileSync(path, 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(id => Object.hasOwn(mocks, id) ? mocks[id] : require(id), module, module.exports)
  return module.exports
}
const loader = load('src/core/skills/skillLoader.ts', { electron: { app: { getPath: () => join(tmpdir(), 'syntee-skills-nonexistent-test-dir') } } })
const tree = load('src/shared/skillsTree.ts')
const { getSkillInstructions } = load('src/core/skills/skillInstructions.ts')
const { buildSkillsBlock } = load('src/core/prompts/sections/skillsSection.ts')
class Store {
  constructor(data = {}) { this.data = structuredClone(data) }
  get(key) { return structuredClone(this.data[key]) }
  set(key, val) { this.data[key] = structuredClone(val) }
}
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'syntee-skills-'))
  const put = (path, content = '---\nname: Test\ndescription: A test skill\n---\nTest instructions') => {
    const dest = join(dir, path)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, content, 'utf8')
  }
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  try {
    const result = fn(dir, put)
    if (result?.then) return result.finally(cleanup)
    cleanup()
    return result
  } catch (e) { cleanup(); throw e }
}
function managerFor(dir, data = {}) {
  const mocks = {
    './skillLoader': { ...loader, loadAllSkills: () => loader.scanSkillDirectory(dir, 'user') },
    '../../shared/skillsTree': tree,
    'electron-store': Store,
  }
  const { SkillManager } = load('src/core/skills/skillManager.ts', mocks)
  const store = new Store(data)
  return { manager: new SkillManager(store), store }
}
const folderUpdate = (path, patch, source = 'user', projectId) => ({ source, folderPath: path, patch, projectId })

test('Recursive packages, named REFERENCE/custom files, BOM and folded description; references stay materials', () => fixture((dir, put) => {
  put('pack/SKILL.md', '\uFEFF---\r\nname: router\r\ndescription: >-\r\n  First line\r\n  second line\r\n---\r\nRouter instructions')
  put('pack/sub/REFERENCE.md')
  put('pack/sub/custom.md', '---\nname: custom\ndescription: Custom skill\n---\nCustom instructions')
  put('pack/sub/timing.md', 'Timing reference, not a skill')
  put('pack/sub/references/api.md', 'API reference')
  put('pack/sub/assets/SKILL.md')
  put('pack/sub/agents/extra.md')
  put('pack/sub/scripts/extra.md')
  put('.hidden/SKILL.md')
  put('README.md', 'Read me')
  put('loose/deep/legacy.md', 'Legacy without YAML')
  const skills = loader.scanSkillDirectory(dir, 'user')
  assert.equal(skills.length, 4)
  assert.ok(skills.some(s => s.relativePath === 'loose/deep/legacy.md'))
  const router = skills.find(s => s.name === 'router')
  assert.equal(router.description, 'First line second line')
  assert.equal(router.baseDir, join(dir, 'pack'))
  assert.equal(router.instructions, 'Router instructions')
  assert.ok(skills.every(s => s.rootDir === dir && !s.relativePath.includes('\\')))
}))

test('Duplicate entrypoint basenames get stable distinct IDs; old root IDs remain valid', () => fixture((dir, put) => {
  put('old.md')
  put('one/SKILL.md')
  put('two/SKILL.md')
  put('one/child/REFERENCE.md')
  put('two/child/REFERENCE.md')
  const skills = loader.scanSkillDirectory(dir, 'user')
  assert.equal(new Set(skills.map(s => s.id)).size, 5)
  assert.ok(skills.some(s => s.id === 'user::old'))
  assert.deepEqual(loader.scanSkillDirectory(dir, 'user').map(s => s.id), skills.map(s => s.id))
}))

test('Symlink/junction directory is not traversed and missing directory is harmless', () => fixture((dir, put) => {
  put('pack/SKILL.md')
  symlinkSync(join(dir, 'pack'), join(dir, 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(loader.scanSkillDirectory(dir, 'user').length, 1)
  assert.deepEqual(loader.scanSkillDirectory(join(dir, 'missing'), 'user'), [])
}))

test('Folder toggle covers all depths but not sibling prefix; new skills inherit after reload', () => fixture((dir, put) => {
  put('pack/SKILL.md')
  put('pack/child/deep/REFERENCE.md')
  put('package/SKILL.md')
  const { manager } = managerFor(dir)
  assert.equal(manager.getActiveSkillsForChat({}).length, 0)
  manager.setFolderState(folderUpdate('pack', { enabled: true }))
  assert.equal(manager.getActiveSkillsForChat({}).length, 2)
  put('pack/new/SKILL.md')
  manager.invalidate()
  assert.equal(manager.getActiveSkillsForChat({}).length, 3)
  assert.equal(manager.getActiveSkillsForChat({ isIncognito: true }).length, 0)
  assert.throws(() => manager.setFolderState(folderUpdate('../pack', { enabled: true })))
  assert.throws(() => manager.setFolderState(folderUpdate('missing', { enabled: true })))
}))

test('Partial selection, individual exceptions, child folder rule and parent reset', () => fixture((dir, put) => {
  put('pack/SKILL.md')
  put('pack/child/REFERENCE.md')
  put('pack/child/deep/SKILL.md')
  const { manager, store } = managerFor(dir)
  manager.setFolderState(folderUpdate('pack', { enabled: true, scope: { type: 'projects', projectIds: ['p'] } }))
  const child = manager.loadSkills().find(s => s.relativePath === 'pack/child/REFERENCE.md')
  manager.setState(child.id, { enabled: false, scope: { type: 'projects', projectIds: ['p'] } })
  assert.equal(manager.getActiveSkillsForChat({ projectId: 'p' }).length, 2)
  assert.equal(manager.getActiveSkillsForChat({ projectId: 'other' }).length, 0)
  manager.invalidate()
  assert.equal(manager.getAllWithState().find(s => s.id === child.id).state.enabled, false)
  manager.setFolderState(folderUpdate('pack/child', { enabled: false }))
  assert.equal(manager.getActiveSkillsForChat({ projectId: 'p' }).length, 1)
  manager.setFolderState(folderUpdate('pack', { enabled: true }))
  assert.equal(manager.getActiveSkillsForChat({ projectId: 'p' }).length, 3)
  manager.setFolderState(folderUpdate('pack', { scope: { type: 'global' } }))
  assert.equal(manager.getActiveSkillsForChat({}).length, 3)
  // State survives a manager restart with the same store contents.
  const fresh = managerFor(dir, store.data).manager
  assert.equal(fresh.getActiveSkillsForChat({}).length, 3)
}))

test('Project identity, legacy state migration does not resurrect after folder toggle', () => fixture((dir, put) => {
  put('.syntee/skills/old.md')
  put('.syntee/skills/pack/SKILL.md')
  const { manager, store } = managerFor(join(dir, 'unused'), {
    skillsState: { 'project::old': { enabled: true, scope: { type: 'projects', projectIds: ['p'] } } },
  })
  const first = manager.loadSkills(dir, 'p').find(s => s.relativePath === 'old.md')
  assert.equal(first.id, 'project:p:old')
  assert.equal(manager.getState(first.id, 'project').enabled, true)
  const other = manager.loadSkills(dir, 'q').find(s => s.relativePath === 'old.md')
  assert.notEqual(first.id, other.id)
  assert.equal(manager.getState(other.id, 'project').enabled, false)
  manager.setFolderState(folderUpdate('', { enabled: false }, 'project', 'p'), dir)
  manager.loadSkills(dir, 'p')
  assert.equal(manager.getState(first.id, 'project').enabled, false)
  assert.equal(store.data.skillsStateMigrated[first.id], true)
  assert.equal(manager.autoEnableProjectSkills('p', dir), false)
}))

test('Tree keeps full descendants and folder path boundaries even when user filters leaves', () => fixture((dir, put) => {
  put('pack/SKILL.md')
  put('pack/nested/REFERENCE.md')
  put('pack/nested/deep/SKILL.md')
  const { manager } = managerFor(dir)
  manager.setFolderState(folderUpdate('pack', { enabled: true }))
  const roots = tree.buildSkillTree(manager.getAllWithState())
  const pack = roots[0].children[0]
  assert.equal(pack.folderPath, 'pack')
  assert.equal(pack.descendants.length, 3)
  assert.equal(pack.children[0].descendants.length, 2)
  assert.equal(pack.children[0].children[0].skills.length, 1)
  assert.equal(tree.isSkillInFolder('pack2/SKILL.md', 'pack'), false)
}))

test('Agent instructions include source/base directory; duplicate names require ID; prompt remains index-only', () => fixture((dir, put) => {
  put('one/SKILL.md')
  put('two/SKILL.md')
  const skills = loader.scanSkillDirectory(dir, 'user')
  assert.match(getSkillInstructions(skills, 'Test'), /get_skill/)
  assert.ok(!getSkillInstructions(skills, 'Test').includes('Test instructions'))
  const result = getSkillInstructions(skills, skills[0].id)
  assert.ok(result.includes(skills[0].filePath))
  assert.ok(result.includes(skills[0].baseDir))
  assert.ok(result.includes('Test instructions'))
  assert.match(getSkillInstructions(skills, 'missing'), /не найден/)
  const block = buildSkillsBlock(skills)
  assert.ok(block.includes(skills[0].id))
  assert.ok(!block.includes('Test instructions'))
}))

test('Installed tree SSR: folders, counts, mixed checkbox, search, refresh and leaf description', () => fixture((dir, put) => {
  put('pack/SKILL.md')
  put('pack/child/REFERENCE.md')
  const { manager } = managerFor(dir)
  const skills = manager.getAllWithState()
  skills[0].state.enabled = true
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const { default: Component } = load('src/renderer/src/components/ui/ExtensionsPopover/SkillsInstalledList.tsx', {
    '@shared/skillsTree': tree,
    '../../../store/extensions.store': { useExtensionsStore: selector => selector({ skills, skillsLoading: false }) },
    '../AppIcon/AppIcon': { __esModule: true, default: () => null },
    './ExtListToolbar': { __esModule: true, default: props => React.createElement('input', { placeholder: props.placeholder }) },
    './ScopeSelector': { __esModule: true, default: () => null, scopeLabel: () => 'глобально' },
    './SkillsInstalledList.css': {},
  })
  const html = renderToStaticMarkup(React.createElement(Component, { projects: [] }))
  assert.ok(html.includes('pack') && html.includes('child') && html.includes('A test skill'))
  assert.ok(html.includes('1 / 2'))
  assert.ok(html.includes('aria-checked="mixed"'))
  assert.ok(html.includes('Обновить') && html.includes('Поиск скиллов'))
}))

test('IPC repository install preserves nested materials, assets and scripts; cleans temporary clone', () => fixture(async (dir, put) => {
  const handlers = new Map()
  put('source/SKILL.md')
  put('source/nested/REFERENCE.md')
  put('source/nested/timing.md', 'Reference')
  put('source/assets/icon.svg', '<svg/>')
  put('source/scripts/task.py', '# helper')
  put('source/.git/config', 'not to copy')
  const fs = require('node:fs')
  let cloneDir
  const execMock = (_cmd, args, _opts, callback) => {
    cloneDir = args.at(-1)
    fs.cpSync(join(dir, 'source'), cloneDir, { recursive: true })
    callback(null, '', '')
  }
  const { manager } = managerFor(join(dir, 'userdata/skills'))
  const { registerSkillsIPC } = load('src/main/ipc/skills.ipc.ts', {
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, app: { getPath: type => type === 'temp' ? dir : join(dir, 'userdata') } },
    'child_process': { execFile: execMock },
    '../../core/skills/skillManager': { getSkillManager: () => manager },
    '../../core/skills/skillLoader': loader,
    '../../core/db': { getAllProjects: () => [], getProjectById: () => null, getChatWorkdirContext: () => ({}) },
  })
  registerSkillsIPC(new Store())
  const result = await handlers.get('skills:installFromUrl')(null, { url: 'https://example.test/owner/pack.git', scope: 'global' })
  assert.deepEqual(result, { ok: true, installed: 2 })
  assert.ok(existsSync(join(dir, 'userdata/skills/pack/nested/REFERENCE.md')))
  assert.ok(existsSync(join(dir, 'userdata/skills/pack/nested/timing.md')))
  assert.ok(existsSync(join(dir, 'userdata/skills/pack/assets/icon.svg')))
  assert.ok(existsSync(join(dir, 'userdata/skills/pack/scripts/task.py')))
  assert.ok(!existsSync(join(dir, 'userdata/skills/pack/.git')))
  assert.ok(!existsSync(cloneDir))
  const all = handlers.get('skills:getAll')(null)
  assert.equal(all.length, 2)
  handlers.get('skills:setFolderState')(null, folderUpdate('pack', { enabled: true }))
  assert.ok(handlers.get('skills:getAll')(null).every(s => s.state.enabled))
}))

test('Real user Remotion pack discovers router, nested references and duplicates without assets pollution', t => {
  const dir = 'C:/Users/cegor/AppData/Roaming/SynteeHelper/skills'
  if (!existsSync(join(dir, 'remotion-best-practices/SKILL.md'))) { t.skip('User package not installed'); return }
  const skills = loader.scanSkillDirectory(dir, 'user').filter(s => s.relativePath.startsWith('remotion-best-practices/'))
  assert.ok(skills.some(s => s.name === 'remotion-best-practices'))
  assert.ok(skills.some(s => s.name === 'remotion-create'))
  assert.ok(skills.some(s => s.relativePath.includes('remotion-markup/remotion-maps/REFERENCE.md')))
  assert.ok(skills.every(s => !s.relativePath.includes('/assets/') && !s.relativePath.includes('/agents/') && !s.relativePath.endsWith('timing.md')))
  assert.equal(new Set(skills.map(s => s.id)).size, skills.length)
  console.log('Remotion entrypoints:', skills.length, 'unique IDs:', new Set(skills.map(s => s.id)).size)
})
