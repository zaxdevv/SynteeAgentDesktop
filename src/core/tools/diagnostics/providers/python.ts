import { resolve, join } from 'path'
import { existsSync } from 'fs'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, filterEntriesByFiles, commandFailure, parseJsonStrict } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

const MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', '.python-version', 'Pipfile', 'tox.ini']

type RuffDiagnostic = {
  filename?: string
  code?: string
  message?: string
  location?: { row?: number; column?: number }
}

function parseRuff(text: string): { entries: DiagnosticEntry[]; error?: string } {
  const parsed = parseJsonStrict<unknown>(text, 'ruff')
  if (parsed.error) return { entries: [], error: parsed.error }
  if (!Array.isArray(parsed.value)) return { entries: [], error: 'ruff: expected a JSON array' }
  const entries: DiagnosticEntry[] = []
  for (const item of parsed.value) {
    if (!item || typeof item !== 'object') return { entries: [], error: 'ruff: invalid diagnostic object' }
    const diagnostic = item as RuffDiagnostic
    if (typeof diagnostic.filename !== 'string' || typeof diagnostic.code !== 'string' || typeof diagnostic.message !== 'string' ||
        !diagnostic.location || typeof diagnostic.location.row !== 'number' || typeof diagnostic.location.column !== 'number') {
      return { entries: [], error: 'ruff: diagnostic does not match the expected schema' }
    }
    entries.push({ file: diagnostic.filename, line: diagnostic.location.row, col: diagnostic.location.column,
      severity: 'error', message: `${diagnostic.code}: ${diagnostic.message}`, source: 'ruff' })
  }
  return { entries }
}

const MYPY_RE = /^(.+?):(\d+):\s+(error|warning|note):\s+(.+?)(?:\s+\[(.+)\])?$/
function parseMypy(text: string): DiagnosticEntry[] {
  return text.split('\n').flatMap((line) => {
    const match = line.match(MYPY_RE)
    if (!match) return []
    return [{ file: match[1].trim(), line: Number(match[2]), severity: match[3] === 'error' ? 'error' as const : 'warning' as const,
      message: match[5] ? `${match[5]}: ${match[4]}` : match[4], source: 'mypy' }]
  })
}

function parsePythonSyntax(text: string, file: string): DiagnosticEntry[] {
  const match = text.match(/File "(.+?)", line (\d+)/)
  if (!match) return []
  return [{ file: match[1] || file, line: Number(match[2]), severity: 'error',
    message: text.match(/(?:SyntaxError|IndentationError):[^\n]*/)?.[0] || 'Syntax error', source: 'py-compile' }]
}

function localTool(dir: string, tool: string): string | undefined {
  const executable = process.platform === 'win32' ? `${tool}.exe` : tool
  const candidates = [join(dir, '.venv', 'Scripts', executable), join(dir, '.venv', 'bin', executable), join(dir, 'node_modules', '.bin', executable)]
  return candidates.find(existsSync)
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function pythonCommand(): string {
  // cmd requires a quoted executable when its path contains spaces.
  const executable = 'python'
  return process.platform === 'win32' ? quote(executable) : executable
}

export const pythonProvider: DiagnosticProvider = {
  name: 'python',
  extensions: ['.py', '.pyi'],
  detect: (dir) => hasAnyMarker(dir, MARKERS),
  async run(dir, files?) {
    const targets = files?.length ? files.map((file) => resolve(dir, file)) : []
    const args = targets.length ? targets.map(quote).join(' ') : '.'
    const entries: DiagnosticEntry[] = []
    const failures: string[] = []
    let toolCount = 0

    const ruff = quote(localTool(dir, 'ruff') || 'ruff')
    if (await isCommandAvailable(`${ruff} --version`, dir)) {
      toolCount++
      const result = await runDiagnosticCommand(`${ruff} check --output-format=json ${args}`, dir, 120_000)
      const parsed = parseRuff(result.stdout)
      entries.push(...parsed.entries)
      const failure = parsed.error || commandFailure(result, 'ruff', parsed.entries.length)
      if (failure) failures.push(failure)
    }

    const mypy = quote(localTool(dir, 'mypy') || 'mypy')
    if (await isCommandAvailable(`${mypy} --version`, dir)) {
      toolCount++
      const result = await runDiagnosticCommand(`${mypy} ${args} --no-error-summary`, dir, 120_000)
      const parsed = parseMypy(`${result.stdout}\n${result.stderr}`)
      entries.push(...parsed)
      const failure = commandFailure(result, 'mypy', parsed.length)
      if (failure) failures.push(failure)
    }

    if (toolCount === 0) {
      if (!targets.length) return { entries, failed: 'python: no files specified for syntax check and no lint tools are available' }
      const python = pythonCommand()
      for (const file of targets) {
        const result = await runDiagnosticCommand(`${python} -c "import sys; compile(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1], 'exec')" ${quote(file)}`, dir, 30_000)
        const parsed = parsePythonSyntax(`${result.stderr}\n${result.stdout}`, file)
        entries.push(...parsed)
        const failure = commandFailure(result, `python syntax check (${file})`, parsed.length)
        if (failure) failures.push(failure)
      }
    }

    return {
      entries: targets.length ? filterEntriesByFiles(entries, dir, targets) : entries,
      failed: failures.length ? failures.join('; ') : undefined
    }
  }
}
