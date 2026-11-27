const MAX_ENTRIES = 12
const MAX_NAME_LENGTH = 100
const MANIFEST = /^(?:readme(?:\.[^.]+)?|package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|composer\.json|makefile|cmakelists\.txt|pom\.xml|build\.gradle(?:\.kts)?|deno\.jsonc?|[^.]+\.sln)$/i

const HINT = 'Use list_directory/find_files for the current tree or project_map for code relationships.'

function isSafeName(name: string): boolean {
  return Boolean(name) && name.length <= MAX_NAME_LENGTH && !/^[.]|[\x00-\x1f\x7f/\\]/.test(name)
}

/** Capture an orientation hint, without enumerating descendants or pasting file contents. */
export function formatProjectScan(entries: Iterable<{ name: string; directory: boolean }>, incomplete = false): string {
  const directories = new Set<string>()
  const manifests = new Set<string>()
  for (const { name, directory } of entries) {
    if (!isSafeName(name)) continue
    if (directory) directories.add(name)
    else if (MANIFEST.test(name)) manifests.add(name)
  }
  const summarize = (label: string, names: Set<string>) => {
    if (!names.size) return ''
    const shown = [...names].sort().slice(0, MAX_ENTRIES)
    return `${label}: ${shown.map(name => JSON.stringify(name)).join(', ')}${names.size > shown.length || incomplete ? ', …' : ''}`
  }
  return [summarize('Root directories', directories), summarize('Root manifests and docs', manifests), HINT].filter(Boolean).join('\n')
}

/** Convert legacy generated scans at read time. Plugin-provided context keeps its original format. */
export function compactStoredProjectScan(text: string | undefined, workdir: string | undefined): string | undefined {
  if (!text || !workdir || !text.startsWith('# Project: ')) return text
  // The legacy producer wrote at most 80 tree rows before README and Git.
  // Inspect only that bounded prefix even if the saved Git status is huge.
  const prefix = text.slice(0, 64 * 1024)
  const header = /^# Project: ([^\r\n]+)\r?\n\r?\n## File structure\r?\n([^\r\n]+)\r?\n/.exec(prefix)
  if (!header) return text
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '')
  const isWindowsPath = /^[A-Za-z]:[/\\]|^\\\\/.test(workdir)
  const compare = (value: string) => isWindowsPath ? value.toLowerCase() : value
  const root = normalize(workdir)
  if (compare(root) !== compare(normalize(header[1])) || compare(root) !== compare(normalize(header[2]))) return text
  const rows = prefix.slice(header[0].length).split(/\r?\n/, 81)
  const entries = new Map<string, boolean>()
  const rootPrefix = compare(`${root}/`)
  for (const row of rows) {
    if (!row || row === '...[truncated]') break
    const normalized = normalize(row)
    if (!compare(normalized).startsWith(rootPrefix)) continue
    const relative = normalized.slice(rootPrefix.length)
    const slash = relative.indexOf('/')
    const name = slash < 0 ? relative : relative.slice(0, slash)
    entries.set(name, slash >= 0 || entries.get(name) === true)
  }
  return formatProjectScan(Array.from(entries, ([name, directory]) => ({ name, directory })), rows.includes('...[truncated]'))
}
