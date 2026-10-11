import { resolve } from 'path'
import { readdirSync } from 'fs'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching, parseJsonStrict, commandFailure } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

type MarkdownIssue = {
  fileName?: string
  lineNumber?: number
  ruleNames?: string[]
  ruleDescription?: string
}

function parseMarkdown(text: string): { entries: DiagnosticEntry[]; error?: string } {
  const parsed = parseJsonStrict<unknown>(text, 'markdownlint')
  if (parsed.error) return { entries: [], error: parsed.error }
  if (!Array.isArray(parsed.value)) return { entries: [], error: 'markdownlint: expected a JSON array' }
  const entries: DiagnosticEntry[] = []
  for (const item of parsed.value) {
    if (!item || typeof item !== 'object') return { entries: [], error: 'markdownlint: invalid issue object' }
    const issue = item as MarkdownIssue
    if (typeof issue.fileName !== 'string' || typeof issue.lineNumber !== 'number' || !Array.isArray(issue.ruleNames) ||
        !issue.ruleNames.every((name) => typeof name === 'string') || typeof issue.ruleDescription !== 'string') {
      return { entries: [], error: 'markdownlint: issue does not match the expected schema' }
    }
    entries.push({ file: issue.fileName, line: issue.lineNumber, severity: 'warning',
      message: `${issue.ruleNames.join('/')} : ${issue.ruleDescription}`, source: 'markdownlint' })
  }
  return { entries }
}

export const markdownProvider: DiagnosticProvider = {
  name: 'markdown',
  extensions: ['.md', '.mdx'],
  detect(dir) {
    return hasAnyMarker(dir, ['.markdownlint.json', '.markdownlint.yaml', '.markdownlint.yml', '.markdownlintignore', '.markdownlint-cli2.jsonc']) ||
      hasFileMatching(dir, ['.md', '.markdown'])
  },
  async run(dir, files?) {
    if (!await isCommandAvailable('markdownlint --version', dir)) {
      return { entries: [], note: 'markdownlint not installed — Markdown diagnostics skipped' }
    }
    let targets = files?.length ? files.map((file) => resolve(dir, file)) : []
    if (!targets.length) {
      try { targets = readdirSync(dir).filter((file) => file.endsWith('.md') || file.endsWith('.markdown')).map((file) => resolve(dir, file)) }
      catch { /* no root markdown files */ }
    }
    if (!targets.length) return { entries: [], note: 'no Markdown files found' }

    const result = await runDiagnosticCommand(`markdownlint --json ${targets.map((file) => `"${file}"`).join(' ')}`, dir, 60_000)
    const parsed = parseMarkdown(result.stdout)
    const entries = parsed.entries
    const stderr = result.stderr.trim()
    const stderrIsJson = stderr.startsWith('[') || stderr.startsWith('{')
    const failure = parsed.error || commandFailure(result, 'markdownlint', entries.length)
    return { entries, failed: [failure, stderr && !stderrIsJson ? `markdownlint stderr: ${stderr.slice(0, 500)}` : undefined].filter(Boolean).join('; ') || undefined }
  }
}
