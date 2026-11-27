const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const { getEncoding } = require('js-tiktoken')
const ts = require('typescript')

const source = readFileSync(join(__dirname, '..', 'src/core/projectMap/projectScan.ts'), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const api = {}
new Function('exports', js)(api)

test('large legacy scan keeps a relative project outline and stays bounded with a dirty worktree', t => {
  const workdir = 'C:\\Users\\fixture\\Source\\large-repository'
  const paths = [
    'README.md', 'package.json', 'clients', 'services', '.env.production', '../other/README.md',
    ...Array.from({ length: 72 }, (_, i) => `clients\\frontend\\components\\file-${i}.ts`),
    'services\\auth\\server.ts',
  ]
  const gitChanges = Array.from({ length: 10_000 }, (_, i) => `?? generated/deep/tree/component-${i}.tsx`).join('\n')
  const old = `# Project: ${workdir}\n\n## File structure\n${workdir}\n${paths.map(p => `${workdir}\\${p}`).join('\n')}\n...[truncated]\n\n## README\nRead _on demand_.\n\n## Git\nChanges:\n${gitChanges}`
  const compact = api.compactStoredProjectScan(old.replace(/\n/g, '\r\n'), workdir.toLowerCase())
  assert.match(compact, /^Root directories: "clients", "services", …/)
  assert.match(compact, /"README.md", "package.json"/)
  assert.match(compact, /list_directory\/find_files.*project_map/)
  assert.doesNotMatch(compact, /fixture|server\.ts|\.env|other|generated|Read _on demand_/)
  const encoding = getEncoding('cl100k_base')
  const before = encoding.encode(old).length
  const after = encoding.encode(compact).length
  t.diagnostic(`cl100k_base: legacy project scan with 10,000 changed paths ${before} → ${after} tokens`)
  assert.ok(before > 50_000 && after < 60)
})

test('legacy compaction is scoped to recognizable scans of the current workdir', () => {
  const notes = 'Custom project notes, injected by a plugin.'
  const legacy = '# Project: /parent/sibling\n\n## File structure\n/parent/sibling\n/parent/sibling/README.md'
  assert.equal(api.compactStoredProjectScan(notes, '/parent/repo'), notes)
  assert.equal(api.compactStoredProjectScan(legacy, '/parent/repo'), legacy)
  assert.ok(api.compactStoredProjectScan(legacy, '/parent/sibling').includes('README.md'))
})

test('new scan selects bounded root entries in stable order', () => {
  const directories = Array.from({ length: 50 }, (_, i) => ({ name: `module${i}`, directory: true }))
  const files = ['package.json', 'README.md', 'src/db.ts', '.env', 'a\nb', 'index.ts'].map(name => ({ name, directory: false }))
  const entries = [...directories, ...files]
  const compact = api.formatProjectScan(entries)
  assert.equal(compact, api.formatProjectScan(entries.reverse()))
  assert.equal((compact.split('\n')[0].match(/"module\d+"/g) ?? []).length, 12)
  assert.match(compact, /"README.md", "package.json"/)
  assert.doesNotMatch(compact, /index\.ts|src\/db|\.env/)
})
