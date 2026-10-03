import { basename, extname } from 'path'
import type { SymbolDef } from './symbols'

const ARTIFACT_EXTS = new Set(['.md', '.mdx', '.json', '.yaml', '.yml', '.toml'])
const LOCK_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'composer.lock'])
const MAX_ARTIFACT_BYTES = 512_000

export function isIndexableArtifact(filePath: string, size?: number): boolean {
  const name = basename(filePath).toLowerCase()
  if (LOCK_FILES.has(name)) return false
  if (!ARTIFACT_EXTS.has(extname(name))) return false
  return size === undefined || size <= MAX_ARTIFACT_BYTES
}

export function getArtifactLang(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  return ext === '.md' || ext === '.mdx' ? 'markdown' : 'config'
}

export async function extractArtifactSymbols(filePath: string): Promise<SymbolDef[] | null> {
  const { readFile } = await import('fs/promises')
  let source: string
  try {
    source = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  if (Buffer.byteLength(source, 'utf-8') > MAX_ARTIFACT_BYTES) return null

  const lines = source.split(/\r?\n/)
  const ext = extname(filePath).toLowerCase()
  const defs: SymbolDef[] = []

  if (ext === '.md' || ext === '.mdx') {
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
      if (!match) continue
      defs.push({
        name: match[2].trim(), kind: 'heading', lineStart: i + 1,
        lineEnd: i + 1, signature: lines[i].trim().slice(0, 120),
      })
    }
    if (defs.length === 0) {
      for (let i = 0; i < lines.length && defs.length < 20; i++) {
        const text = lines[i].replace(/[`*_>#]/g, '').trim()
        if (text.length < 24) continue
        defs.push({ name: text.slice(0, 80), kind: 'document-line', lineStart: i + 1, lineEnd: i + 1, signature: text.slice(0, 120) })
      }
    }
  } else {
    // Index top-level configuration/schema keys, not arbitrary scalar values.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const match = ext === '.json'
        ? line.match(/^\s*"([^"\\]+)"\s*:/)
        : line.match(/^(?:\s{0,2})([A-Za-z_][\w.-]*)\s*[:=]/)
      if (!match) continue
      const key = match[1]
      if (['dependencies', 'devDependencies', 'peerDependencies', 'scripts'].includes(key)) continue
      defs.push({ name: key, kind: 'config-key', lineStart: i + 1, lineEnd: i + 1, signature: line.trim().slice(0, 120) })
    }
  }

  return defs.length > 0 ? defs.slice(0, 200) : null
}
