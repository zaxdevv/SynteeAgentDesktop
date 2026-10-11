// ── Go провайдер: go vet + gofmt, golangci-lint если доступен ──

import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { filterEntriesByFiles, commandFailure } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// go vet: "path/file.go:12:3: message"
const GO_VET_RE = /^(.+?):(\d+):(\d+):\s*(.+)$/

function parseGoVet(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(GO_VET_RE)
    if (!m) continue
    const [, file, lineNum, col, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: 'error',
      message: message.trim(),
      source: 'go-vet',
    })
  }
  return entries
}

// golangci-lint JSON: {Issues: [{Pos: {Filename, Line, Column}, Text, FromLinter}]}
function parseGolangciJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const issue of data.Issues || []) {
      entries.push({
        file: issue.Pos?.Filename || '',
        line: issue.Pos?.Line ?? 0,
        col: issue.Pos?.Column,
        severity: 'warning',
        message: issue.Text || '',
        source: `golangci-lint:${issue.FromLinter || 'go'}`,
      })
    }
  } catch { /* not JSON */ }
  return entries
}

export const goProvider: DiagnosticProvider = {
  name: 'go',

  detect(dir) {
    return existsSync(join(dir, 'go.mod'))
  },

  async run(dir, files?) {
    // 1. Если доступен golangci-lint — используем его (он включает go vet + многое)
    if (await isCommandAvailable('golangci-lint version')) {
      const cmd = 'golangci-lint run --out-format json'
      const res = await runDiagnosticCommand(cmd, dir, 120_000)
      const parsed = parseGolangciJson(res.stdout)
      const failure = commandFailure(res, 'golangci-lint', parsed.length)
      if (!failure) {
        let entries = parsed
        if (files && files.length > 0) entries = filterEntriesByFiles(entries, dir, files)
        return { entries }
      }
    }

    // 2. Fallback: go vet + gofmt
    const [vetRes, fmtRes] = await Promise.all([
      runDiagnosticCommand('go vet ./...', dir, 120_000),
      runDiagnosticCommand('gofmt -l .', dir, 30_000),
    ])

    const entries: DiagnosticEntry[] = []
    const failures: string[] = []
    const vetParsed = parseGoVet(vetRes.stdout + '\n' + vetRes.stderr)
    const vetFailure = commandFailure(vetRes, 'go vet', vetParsed.length)
    if (vetFailure) failures.push(vetFailure)
    const fmtFailure = commandFailure(fmtRes, 'gofmt', fmtRes.stdout.trim() ? 1 : 0)
    if (fmtFailure) failures.push(fmtFailure)

    if (!vetRes.failed) {
      let vetEntries = parseGoVet(vetRes.stdout + '\n' + vetRes.stderr)
      if (files && files.length > 0) vetEntries = filterEntriesByFiles(vetEntries, dir, files)
      entries.push(...vetEntries)
    }

    // gofmt -l: выводит имена файлов, которые не отформатированы
    if (!fmtRes.failed && fmtRes.stdout.trim()) {
      const unformatted = fmtRes.stdout.trim().split('\n').filter(Boolean)
      for (const f of unformatted) {
        if (files && files.length > 0) {
          const resolved = files.map((fp) => resolve(dir, fp))
          if (!resolved.includes(resolve(dir, f.trim()))) continue
        }
        entries.push({
          file: f.trim(),
          line: 1,
          severity: 'warning',
          message: 'file is not gofmt-compliant',
          source: 'gofmt',
        })
      }
    }

    return { entries, failed: failures.length ? failures.join('; ') : undefined }
  },
}
