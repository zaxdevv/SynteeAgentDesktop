import { resolve, basename } from 'path'
import { readdirSync, readFileSync } from 'fs'
import { hasAnyMarker } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

export const jsonProvider: DiagnosticProvider = {
  name: 'json', extensions: ['.json'],
  detect(dir) {
    if (hasAnyMarker(dir, ['.jsonlintrc', '.jsonlintrc.json'])) return true
    try { return readdirSync(dir).some(f => f.endsWith('.json')) } catch { return false }
  },
  async run(dir, files?) {
    const entries: DiagnosticEntry[] = [], failures: string[] = []
    let targets: string[]
    try { targets = files?.length ? files.map(f => resolve(dir, f)) : readdirSync(dir).filter(f => f.endsWith('.json')).map(f => resolve(dir, f)) }
    catch (e) { return { entries, failed: String(e) } }
    for (const file of targets) {
      // TypeScript configs are JSONC, not strict JSON; tsc validates them separately.
      if (/^(tsconfig|jsconfig)(\..*)?\.json$/i.test(basename(file))) continue
      let text: string
      try { text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '') }
      catch (e) { failures.push(`${file}: ${String(e)}`); continue }
      try { JSON.parse(text) }
      catch (e) {
        const message = String(e), position = message.match(/position\s+(\d+)/i)
        const location = message.match(/line (\d+) column (\d+)/i)
        let line = location ? Number(location[1]) : 0, col = location ? Number(location[2]) : undefined
        if (position) {
          const prefix = text.slice(0, Number(position[1]))
          line = prefix.split('\n').length; col = prefix.length - prefix.lastIndexOf('\n')
        }
        entries.push({ file, line, col, severity: 'error', message: message.replace(/^SyntaxError:\s*/, ''), source: 'json-parse' })
      }
    }
    return { entries, failed: failures.length ? failures.join('; ') : undefined }
  },
}
