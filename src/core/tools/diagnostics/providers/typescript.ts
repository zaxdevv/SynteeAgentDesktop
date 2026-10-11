import { existsSync, readdirSync } from 'fs'
import { join, dirname, relative } from 'path'
import ts from 'typescript'
import { runDiagnosticCommand } from '../runner'
import { commandFailure, filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry, ProviderRunResult } from '../types'

const DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.+)$/

function parse(text: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(DIAGNOSTIC_RE)
    if (match) {
      entries.push({ file: match[1].trim(), line: Number(match[2]), col: Number(match[3]),
        severity: match[4] as 'error' | 'warning', message: `${match[5]}: ${match[6].trim()}`, source: 'tsc' })
    } else if (/^error TS\d+:/.test(line.trim())) {
      entries.push({ file: '', line: 0, severity: 'error', message: line.trim(), source: 'tsc' })
    }
  }
  return entries
}

function readConfig(configPath: string): ts.ParsedCommandLine | undefined {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) return undefined
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath), undefined, configPath)
  return parsed.errors.length ? undefined : parsed
}

function configs(dir: string): string[] {
  const discovered: string[] = []
  try {
    for (const name of readdirSync(dir)) {
      // Start only from the conventional project config; referenced configs are added below.
      if (name.toLowerCase() === 'tsconfig.json') discovered.push(join(dir, name))
    }
  } catch { return [] }

  const visited = new Set<string>()
  const ordered: string[] = []
  const visit = (file: string): void => {
    const absolute = join(dirname(file), relative(dirname(file), file))
    if (visited.has(absolute) || !existsSync(absolute)) return
    visited.add(absolute)
    ordered.push(absolute)
    const configFile = ts.readConfigFile(absolute, ts.sys.readFile)
    if (configFile.error) return
    // parseJsonConfigFileContent handles JSONC and resolves compiler options relative to this config.
    readConfig(absolute)
    const raw = configFile.config as { references?: Array<{ path?: string }> }
    for (const reference of raw.references ?? []) {
      if (!reference.path) continue
      const refConfig = /\.json$/i.test(reference.path) ? reference.path : join(reference.path, 'tsconfig.json')
      visit(join(dirname(absolute), refConfig))
    }
  }
  if (!discovered.length) {
    for (const name of ['tsconfig.node.json', 'tsconfig.web.json']) {
      if (existsSync(join(dir, name))) discovered.push(join(dir, name))
    }
  }
  discovered.sort((a, b) => a.localeCompare(b)).forEach(visit)
  return ordered
}

export const typescriptProvider: DiagnosticProvider = {
  name: 'typescript',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  detect: (dir) => configs(dir).length > 0,
  async run(dir, files?): Promise<ProviderRunResult> {
    const foundConfigs = configs(dir)
    if (!foundConfigs.length) return { entries: [], note: 'No TypeScript project config found; diagnostics skipped' }

    const entries: DiagnosticEntry[] = []
    const failures: string[] = []
    for (const config of foundConfigs) {
      const rel = relative(dir, config).replace(/\\/g, '/')
      const result = await runDiagnosticCommand(`npx --no-install tsc -p "${rel}" --noEmit --pretty false`, dir, 120_000)
      const parsed = parse(`${result.stdout}\n${result.stderr}`)
      entries.push(...parsed)
      const failure = commandFailure(result, `tsc (${rel})`, parsed.length)
      if (failure) failures.push(failure)
    }
    return { entries: files?.length ? filterEntriesByFiles(entries, dir, files) : entries,
      failed: failures.length ? failures.join('; ') : undefined }
  }
}
