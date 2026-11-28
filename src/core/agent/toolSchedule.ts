import { resolve } from 'node:path'
import type { NormalizedToolCall } from './types'

// Only operations whose effects are known to the dispatcher can share a batch.
// In particular, external tools can change the files a later call will read.
const independentQueries = new Set(['find_files', 'list_directory', 'search_code', 'project_map', 'recall_context'])

function readPaths(call: NormalizedToolCall, workdir: string): string[] | undefined {
  if (call.parseError || !call.args) return undefined
  if (independentQueries.has(call.fn.name)) return []
  const paths = call.fn.name === 'read_file' ? [call.args.path]
    : call.fn.name === 'read_files' ? call.args.paths : undefined
  if (!Array.isArray(paths) || !paths.length) return undefined
  const keys: string[] = []
  for (const path of paths) {
    // A substituted path is only known at dispatch. It may alias an earlier call.
    if (typeof path !== 'string' || !path || path.includes('${{')) return undefined
    const absolute = resolve(workdir, path)
    keys.push(process.platform === 'win32' ? absolute.toLowerCase() : absolute)
  }
  return keys
}

export async function runOrderedTools(
  calls: NormalizedToolCall[],
  workdir: string,
  execute: (call: NormalizedToolCall) => Promise<void>,
): Promise<void> {
  const batch: NormalizedToolCall[] = []
  const files = new Set<string>()
  async function flush(): Promise<void> {
    const results = await Promise.allSettled(batch.map(call => execute(call)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    batch.length = 0
    files.clear()
  }
  for (const call of calls) {
    const paths = readPaths(call, workdir)
    // Repeated reads of the same file share its per-run paging cursor.
    if (batch.length && (!paths || paths.some(path => files.has(path)))) await flush()
    if (paths) {
      batch.push(call)
      for (const path of paths) files.add(path)
    } else {
      await execute(call)
    }
  }
  if (batch.length) await flush()
}
