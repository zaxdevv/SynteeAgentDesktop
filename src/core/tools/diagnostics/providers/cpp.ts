// ── C / C++ провайдер: cmake → clang-tidy → cppcheck → gcc ──

import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { filterEntriesByFiles, hasFileMatching, commandFailure } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// gcc/clang: "file:line:col: error: message" или "file:line: error: message"
const GCC_RE = /^(.+?):(\d+):(?:(\d+):)?\s+(error|warning):\s*(.+)$/

function parseGccFormat(output: string, source: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(GCC_RE)
    if (!m) continue
    const [, file, lineNum, col, severity, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: col ? Number(col) : undefined,
      severity: severity as 'error' | 'warning',
      message: message.trim(),
      source,
    })
  }
  return entries
}

// cppcheck: "[file:line]: (severity) message"
const CPPCHECK_RE = /^\[(.+?):(\d+)\]:\s+\((error|warning|style|performance|portability)\)\s*(.+)$/
function parseCppcheck(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(CPPCHECK_RE)
    if (!m) continue
    const [, file, lineNum, level, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      severity: level === 'error' ? 'error' : 'warning',
      message: message.trim(),
      source: 'cppcheck',
    })
  }
  return entries
}

export const cppProvider: DiagnosticProvider = {
  name: 'cpp',

  detect(dir) {
    return existsSync(join(dir, 'CMakeLists.txt')) ||
      (existsSync(join(dir, 'Makefile')) && hasFileMatching(dir, ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp']))
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []
    const notes: string[] = []
    const failures: string[] = []

    // 1. Если есть build/ — cmake --build build
    const buildDir = join(dir, 'build')
    if (existsSync(buildDir)) {
      const res = await runDiagnosticCommand('cmake --build build', dir, 180_000)
      const parsed = parseGccFormat(res.stdout + '\n' + res.stderr, 'cmake')
      const failure = commandFailure(res, 'cmake build', parsed.length)
      if (failure) failures.push(failure)
      if (!failure) {
        let buildEntries = parsed
        if (files && files.length > 0) buildEntries = filterEntriesByFiles(buildEntries, dir, files)
        entries.push(...buildEntries)
      }
    }

    // 2. clang-tidy (если есть compile_commands.json и files переданы)
    const compileDb = join(buildDir, 'compile_commands.json')
    if (existsSync(compileDb) && files && files.length > 0 && await isCommandAvailable('clang-tidy --version')) {
      const fileList = files.map((f) => `"${resolve(dir, f)}"`).join(' ')
      const res = await runDiagnosticCommand(
        `clang-tidy -p build ${fileList}`,
        dir, 120_000,
      )
      const tidyEntries = parseGccFormat(res.stdout + '\n' + res.stderr, 'clang-tidy')
      const failure = commandFailure(res, 'clang-tidy', tidyEntries.length)
      if (failure) failures.push(failure)
      else entries.push(...tidyEntries)
    }

    // 3. cppcheck (если доступен)
    if (await isCommandAvailable('cppcheck --version')) {
      const cmd = files && files.length > 0
        ? `cppcheck --enable=warning,style ${files.map((f) => `"${resolve(dir, f)}"`).join(' ')}`
        : 'cppcheck --enable=warning,style .'
      const res = await runDiagnosticCommand(cmd, dir, 120_000)
      let cppEntries = parseCppcheck(res.stdout + '\n' + res.stderr)
      const failure = commandFailure(res, 'cppcheck', cppEntries.length)
      if (failure) failures.push(failure)
      else {
        if (files && files.length > 0) cppEntries = filterEntriesByFiles(cppEntries, dir, files)
        entries.push(...cppEntries)
      }
    }

    // 4. Fallback: gcc -fsyntax-only (per-file, только syntax)
    if (entries.length === 0 && files && files.length > 0) {
      const hasGcc = await isCommandAvailable('gcc --version')
      const hasClang = await isCommandAvailable('clang --version')
      const compiler = hasGcc ? 'gcc' : hasClang ? 'clang' : null
      if (compiler) {
        for (const f of files) {
          const fp = resolve(dir, f)
          const res = await runDiagnosticCommand(
            `${compiler} -fsyntax-only -I. "${fp}"`,
            dir, 30_000,
          )
          if (!res.failed) {
            entries.push(...parseGccFormat(res.stderr, 'gcc'))
          }
        }
      }
    }

    if (entries.length === 0 && !existsSync(buildDir)) {
      notes.push('no build/ directory — cmake build skipped. Run cmake -B build first.')
    }

    return { entries, failed: failures.length ? failures.join('; ') : undefined, note: notes.length > 0 ? notes.join('; ') : undefined }
  },
}
