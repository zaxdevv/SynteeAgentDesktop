import { readdir } from 'node:fs/promises'
import { formatProjectScan } from '../projectMap/projectScan'
import { DEFAULT_IGNORE_DIRS, resolveToolPath, type ToolResult } from './_shared'

export async function analyzeProject(projectPath: string, workdir?: string): Promise<ToolResult> {
  try {
    const entries = await readdir(resolveToolPath(projectPath, workdir), { withFileTypes: true })
    const candidates = entries.filter(entry => (entry.isDirectory() || entry.isFile()) && !DEFAULT_IGNORE_DIRS.includes(entry.name))
    return {
      success: true,
      output: formatProjectScan(candidates.map(entry => ({ name: entry.name, directory: entry.isDirectory() }))),
    }
  } catch (error) {
    return { success: false, output: '', error: error instanceof Error ? error.message : String(error) }
  }
}
