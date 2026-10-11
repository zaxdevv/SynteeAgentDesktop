// ── Terraform провайдер: terraform fmt + tflint ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasFileMatching, commandFailure } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// tflint JSON: { issues: [{ rule, message, range: { filename, start: { line, column } }, severity }] }
function parseTflintJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const issue of data.issues || []) {
      entries.push({
        file: issue.range?.filename || '',
        line: issue.range?.start?.line ?? 0,
        col: issue.range?.start?.column,
        severity: issue.severity === 'error' ? 'error' : 'warning',
        message: issue.rule ? `${issue.rule}: ${issue.message}` : issue.message,
        source: 'tflint',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

export const terraformProvider: DiagnosticProvider = {
  name: 'terraform',

  detect(dir) {
    return hasFileMatching(dir, ['.tf']) || hasFileMatching(dir, ['.terraform-version'])
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []
    const notes: string[] = []

    // 1. terraform fmt -check (formatting)
    if (await isCommandAvailable('terraform version')) {
      const cmd = files && files.length > 0
        ? `terraform fmt -check ${files.map((f) => `"${resolve(dir, f)}"`).join(' ')}`
        : 'terraform fmt -check -recursive'
      const res = await runDiagnosticCommand(cmd, dir, 60_000)
      const failure = commandFailure(res, 'terraform fmt', res.stdout.trim() ? 1 : 0)
      if (failure) notes.push(failure)
      if (!failure && res.stdout.trim()) {
        // terraform fmt -check выводит имена файлов, которые не отформатированы
        for (const line of res.stdout.split('\n')) {
          if (line.trim()) {
            entries.push({
              file: line.trim(),
              line: 1,
              severity: 'warning',
              message: 'file is not terraform fmt-compliant',
              source: 'terraform-fmt',
            })
          }
        }
      }
    } else {
      notes.push('terraform not installed — fmt check skipped')
    }

    // 2. tflint (если доступен)
    if (await isCommandAvailable('tflint --version')) {
      const cmd = files && files.length > 0
        ? `tflint --format json ${files.map((f) => `"${resolve(dir, f)}"`).join(' ')}`
        : 'tflint --format json'
      const res = await runDiagnosticCommand(cmd, dir, 60_000)
      const parsed = parseTflintJson(res.stdout)
      const failure = commandFailure(res, 'tflint', parsed.length)
      if (failure) notes.push(failure)
      else entries.push(...parsed)
    }

    if (entries.length === 0 && notes.length > 0) return { entries: [], failed: notes.join('; ') }
    return { entries, failed: notes.length ? notes.join('; ') : undefined }
  },
}
