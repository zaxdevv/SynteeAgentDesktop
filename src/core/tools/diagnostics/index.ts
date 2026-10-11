import { existsSync, readdirSync, lstatSync, statSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, relative, resolve, dirname, sep } from 'path'
import { execFileAsync, type ToolResult } from '../_shared'
import { DIAGNOSTIC_PROVIDERS } from './providers'
import { formatDiagnosticsOutput } from './formatter'
import { withDiagnosticCommandTrace, type CommandTrace } from './runner'
import type { DiagnosticEntry, DiagnosticProvider } from './types'

const IGNORES = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.venv', 'venv', 'vendor', 'target', '__pycache__'])
const EXTENSIONS: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], eslint: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py', '.pyi'], go: ['.go'], rust: ['.rs'], dotnet: ['.cs', '.fs', '.vb'], kotlin: ['.kt', '.kts'], java: ['.java'],
  cpp: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'], ruby: ['.rb'], php: ['.php'], lua: ['.lua'], swift: ['.swift'], shell: ['.sh', '.bash'],
  dart: ['.dart'], elixir: ['.ex', '.exs'], haskell: ['.hs', '.lhs'], scala: ['.scala', '.sc'], r: ['.r'], nim: ['.nim'], zig: ['.zig'],
  ocaml: ['.ml', '.mli'], crystal: ['.cr'], v: ['.v'], clojure: ['.clj', '.cljs', '.cljc'], groovy: ['.groovy'], perl: ['.pl', '.pm'],
  objc: ['.m', '.mm'], erlang: ['.erl', '.hrl'], fortran: ['.f', '.f90', '.f95'], julia: ['.jl'], graphql: ['.graphql', '.gql'], protobuf: ['.proto'],
  toml: ['.toml'], cmake: ['CMakeLists.txt', '.cmake'], bazel: ['BUILD', 'BUILD.bazel', '.bzl'], json: ['.json'], yaml: ['.yaml', '.yml'],
  docker: ['Dockerfile', '.dockerfile'], terraform: ['.tf', '.tfvars'], sql: ['.sql'], markdown: ['.md', '.markdown'],
}
const FILE_PROVIDERS = new Set(['json', 'yaml', 'toml', 'markdown', 'shell', 'docker', 'sql', 'cmake', 'protobuf', 'graphql'])
function filesFor(provider: DiagnosticProvider, files: string[]): string[] {
  const extensions = provider.extensions ?? EXTENSIONS[provider.name]
  if (!extensions) return []
  return files.filter(f => extensions.some(e => e.startsWith('.') ? f.toLowerCase().endsWith(e.toLowerCase()) : f.split(/[\\/]/).pop() === e))
}
function discover(root: string): { files: string[]; dirs: string[]; incomplete: boolean } {
  const files: string[] = [], dirs: string[] = []
  let incomplete = false
  function walk(dir: string, depth: number): void {
    if (depth > 8 || dirs.length >= 300 || files.length >= 5000) { incomplete = true; return }
    dirs.push(dir)
    try {
      for (const name of readdirSync(dir).sort()) {
        if (IGNORES.has(name)) continue
        const path = join(dir, name), stat = lstatSync(path)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) walk(path, depth + 1)
        else if (stat.isFile()) {
          if (files.length >= 5000) { incomplete = true; break }
          files.push(path)
        }
      }
    } catch { incomplete = true }
  }
  walk(root, 0)
  return { files, dirs, incomplete }
}
async function getChangedFiles(dir: string): Promise<Set<string> | null> {
  try {
    const opts = { timeout: 8000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' as const, windowsHide: true }
    const { stdout: top } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], opts)
    const gitRoot = top.trim()
    const { stdout } = await execFileAsync('git', ['-C', gitRoot, 'diff', '--name-only', '-z', 'HEAD'], opts)
    const { stdout: untracked } = await execFileAsync('git', ['-C', gitRoot, 'ls-files', '--others', '--exclude-standard', '-z'], opts)
    return new Set((stdout + '\0' + untracked).split('\0').filter(Boolean).map(f => resolve(gitRoot, f)))
  } catch { return null }
}
export interface GetDiagnosticsOptions { offset?: number; limit?: number; max_chars?: number; maxChars?: number }
export async function getDiagnostics(cwd?: string, files?: string[], options: GetDiagnosticsOptions = {}): Promise<ToolResult> {
  const dir = resolve(cwd || process.cwd())
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { success: false, output: '', error: 'Directory not found: ' + dir }
  const explicit = files?.length ? files.map(f => resolve(dir, f)) : undefined
  const ancestors = new Set<string>([dir])
  for (const file of explicit ?? []) {
    let parent = dirname(file)
    while (parent.startsWith(dir + sep)) {
      ancestors.add(parent)
      parent = dirname(parent)
    }
  }
  const discovery = explicit ? { files: explicit, dirs: [...ancestors], incomplete: false } : discover(dir)
  const allFiles = explicit ?? discovery.files
  const entries: DiagnosticEntry[] = [], failures: string[] = [], notes: string[] = []
  if (discovery.incomplete) notes.push('Discovery reached a limit or unreadable directory; pass path for a narrower check.')
  const todo: { p: DiagnosticProvider; root: string; files?: string[] }[] = []
  for (const p of DIAGNOSTIC_PROVIDERS) {
    const matches = filesFor(p, allFiles)
    if (explicit && !matches.length) continue
    const roots = discovery.dirs.filter(root => {
      try { return p.detect(root) } catch { return false }
    })
    if (!roots.length && matches.length && FILE_PROVIDERS.has(p.name)) roots.push(dir)
    // Standalone explicitly selected sources also get a best-effort language check.
    if (!roots.length && explicit && matches.length) roots.push(dir)
    for (const root of roots) {
      const nested = roots.filter(r => r !== root && r.startsWith(root + sep))
      const targets = matches.filter(f => f.startsWith(root + sep) && !nested.some(r => f.startsWith(r + sep)))
      if ((explicit || FILE_PROVIDERS.has(p.name)) && !targets.length) continue
      todo.push({ p, root, files: explicit || FILE_PROVIDERS.has(p.name) ? targets : undefined })
    }
  }
  if (!todo.length) return { success: true, output: 'DIAGNOSTICS_UNKNOWN: No supported checks apply to the requested targets.' }
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
    while (cursor < todo.length) {
      const { p, root, files: targets } = todo[cursor++]
      const trace: CommandTrace = { failed: false, output: [], results: [] }
      const label = `${p.name} (${relative(dir, root) || '.'})`
      try {
        const result = await withDiagnosticCommandTrace(trace, () => p.run(root, targets))
        if (result.failed) failures.push(`${label}: ${result.failed}`)
        if (result.note) notes.push(`[${label}] ${result.note}`)
        const unparsed = trace.results.some(r => r.exitCode !== 0 && !(r.parsedCount && r.parsedCount > 0))
        if (trace.output.length && !trace.failed && !unparsed && !result.failed && trace.results.some(r => r.parsedCount === undefined)) {
          notes.push(`[${label}] Nonzero command output retained in the full report; verify all commands were parsed:\n${trace.output.join('\n')}`)
        }
        if (trace.failed || unparsed) failures.push(`${label}: incomplete command check\n${trace.output.join('\n')}`)
        entries.push(...result.entries.map(e => ({ ...e, file: e.file ? resolve(root, e.file) : '' })))
      } catch (e) { failures.push(`${label}: crashed — ${String(e)}`) }
    }
  }))
  const deduped = [...new Map(entries.map(e => [JSON.stringify([e.file, e.line, e.col, e.source, e.message, e.severity]), e])).values()]
  const changedFiles = explicit ? null : await getChangedFiles(dir)
  const maxChars = Math.max(1000, Math.min(100000, options.max_chars ?? options.maxChars ?? 8000))
  const input = { entries: deduped, failures, notes, detectedProviders: todo.map(x => `${x.p.name}@${relative(dir, x.root) || '.'}`), changedFiles, cwd: dir, checked: todo.length, skipped: notes.length, partial: notes.length > 0, scope: explicit ? 'Selected files and global configuration diagnostics only; errors in other files may be filtered.' : 'Discovered project checks (bounded traversal).' }
  const full = formatDiagnosticsOutput({ ...input, maxChars: Number.MAX_SAFE_INTEGER }).output
  let reportPath: string | undefined
  if (full.length > maxChars || options.offset || options.limit) {
    try {
      reportPath = join(tmpdir(), `diagnostics-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
      await writeFile(reportPath, full, 'utf8')
    } catch { notes.push('Could not save full report; request a larger max_chars budget.') }
  }
  const formatted = formatDiagnosticsOutput({ ...input, offset: options.offset, limit: options.limit, maxChars, reportPath })
  return { success: true, output: formatted.output }
}
export type { DiagnosticEntry, DiagnosticProvider } from './types'
