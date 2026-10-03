// Compare diagnostics against HEAD in memory; never checkout or overwrite working files.
const ts = require('typescript')
const cp = require('node:child_process')
const path = require('node:path')
const normalize = p => path.resolve(p).replace(/\\/g, '/').toLowerCase()
// Explicit feature scope: concurrent edits by other chats remain identical in both programs.
const changed = [
  'src/core/agent/Agent.ts', 'src/core/agent/injectionGuard.ts', 'src/core/agent/toolDispatcher.ts',
  'src/core/agent/types.ts', 'src/core/agent/utils.ts', 'src/core/db/migrations/index.ts',
  'src/core/prompts/sections/codeModeSection.ts', 'src/core/tools/schemas/index.ts',
  'src/main/ipc/chat.ipc.ts', 'src/main/workers/ai-worker.ts',
  'src/renderer/src/components/ui/ToolChain/ToolResultRenderer.tsx', 'src/renderer/src/hooks/useRunStatus.ts',
  'src/shared/modes.ts', 'src/shared/toolMeta.ts',
]
const added = new Set([
  'src/core/db/delegatedChats.ts', 'src/core/db/migrations/delegatedChats.ts',
  'src/core/tools/schemas/chats.ts', 'src/main/services/delegatedChats.ts', 'src/shared/delegatedChats.ts',
].map(normalize))
const original = new Map(changed.map(p => [normalize(p), cp.execFileSync('git', ['show', `HEAD:${p}`], { encoding: 'utf8' })]))
function check(config, baseline) {
  const host = ts.createCompilerHost({})
  const read = host.readFile.bind(host)
  const exists = host.fileExists.bind(host)
  host.readFile = p => baseline && original.has(normalize(p)) ? original.get(normalize(p)) : baseline && added.has(normalize(p)) ? undefined : read(p)
  host.fileExists = p => baseline && added.has(normalize(p)) ? false : exists(p)
  const json = ts.readConfigFile(config, ts.sys.readFile)
  const cfg = ts.parseJsonConfigFileContent(json.config, ts.sys, path.dirname(path.resolve(config)))
  const program = ts.createProgram(cfg.fileNames.filter(p => !baseline || !added.has(normalize(p))), { ...cfg.options, noEmit: true }, host)
  return ts.getPreEmitDiagnostics(program).map(d => ({
    file: d.file ? normalize(d.file.fileName) : '', code: d.code,
    text: ts.flattenDiagnosticMessageText(d.messageText, ' '),
  }))
}
for (const cfg of ['tsconfig.node.json', 'tsconfig.web.json']) {
  const before = check(cfg, true)
  const after = check(cfg, false)
  const keys = new Set(before.map(d => JSON.stringify(d)))
  const newErrors = after.filter(d => !keys.has(JSON.stringify(d)))
  console.log(`${cfg}: baseline ${before.length}, current ${after.length}, new ${newErrors.length}`)
  console.log(JSON.stringify(newErrors, null, 2))
  if (newErrors.length) process.exitCode = 1
}
