// ── Shell провайдер: shellcheck + shfmt ──

import { resolve } from 'path'
import { readdirSync } from 'fs'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasFileMatching, commandFailure } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// shellcheck JSON: [{ file, line, column, level, message, code }]
function parseShellcheckJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const item of data) {
      entries.push({
        file: item.file || '',
        line: item.line ?? 0,
        col: item.column,
        severity: item.level === 'error' ? 'error' : 'warning',
        message: item.code ? `SC${item.code}: ${item.message}` : item.message,
        source: 'shellcheck',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

export const shellProvider: DiagnosticProvider = {
  name: 'shell',

  detect(dir) {
    return hasFileMatching(dir, ['.sh', '.bash', '.subshell']) ||
      hasFileMatching(dir, ['.shellcheckrc'])
  },

  async run(dir, files?) {
    // shellcheck требует file-level — нельзя запустить на всю директорию
    // Если files не передан, ищем .sh файлы в корне
    let targets = files && files.length > 0
      ? files.map((f) => resolve(dir, f))
      : []

    if (targets.length === 0) {
      // Пытаемся найти .sh файлы в корне (нерекурсивно)
      try {
        const allFiles = readdirSync(dir).filter((f: string) => f.endsWith('.sh') || f.endsWith('.bash'))
        targets = allFiles.map((f: string) => resolve(dir, f))
      } catch { /* ignore */ }
    }

    if (targets.length === 0) {
      return { entries: [], note: 'no .sh files found in project root' }
    }

    const entries: DiagnosticEntry[] = []

    // 1. shellcheck
    if (await isCommandAvailable('shellcheck --version')) {
      const cmd = `shellcheck --format json ${targets.map((f) => `"${f}"`).join(' ')}`
      const res = await runDiagnosticCommand(cmd, dir, 60_000)
      const parsed = parseShellcheckJson(res.stdout)
      const failure = commandFailure(res, 'shellcheck', parsed.length)
      if (failure) return { entries, failed: failure }
      entries.push(...parsed)
    }

    // 2. shfmt (formatting check)
    if (await isCommandAvailable('shfmt --version')) {
      for (const f of targets) {
        const res = await runDiagnosticCommand(`shfmt -d "${f}"`, dir, 30_000)
        const failure = commandFailure(res, `shfmt (${f})`, res.stdout.trim() ? 1 : 0)
        if (failure) return { entries, failed: failure }
        if (res.stdout.trim() || (res.stderr && res.stderr.includes('differences'))) {
          entries.push({
            file: f,
            line: 1,
            severity: 'warning',
            message: 'file is not shfmt-compliant',
            source: 'shfmt',
          })
        }
      }
    }

    if (entries.length === 0) {
      return { entries: [], note: 'shellcheck not installed — Shell diagnostics skipped. Install: apt install shellcheck' }
    }

    return { entries }
  },
}
