/**
 * FileIndexer — индексатор файлов проекта для @mention-пикера.
 *
 * Watcher: fs.watch(recursive: true) на корень workdir — тот же паттерн, что
 * у fastContext-worker: на Windows это ReadDirectoryChangesW (kernel-level
 * callback, 0% CPU в простое, один handle на всё дерево). chokidar здесь
 * заменён сознательно: он держит тысячи FS-handles + stat-calls и грузит
 * main-процесс даже в простое. Рекурсивные события приходят с полным
 * путём — игнор-фильтрация та же, что и в scanDir.
 *
 * API:
 *  - startIndexing(workdir) — запускает watcher + первичный scan
 *  - stopIndexing(workdir) — останавливает
 *  - searchFiles(workdir, query) — возвращает FileEntry[] отсортированный
 *    через filterMentions (fuzzy)
 *  - getRecentFiles(workdir, limit) — последние изменённые файлы (для @ без query)
 *
 * Лимиты: maxFiles=20000 на проект (защита от гигантских mono-repo),
 * maxDepth=10 (как fastContextWatcher, но 10 вместо 8 — глубже для полноты).
 */
import { watch, type FSWatcher } from 'fs'
import { basename, relative, sep } from 'path'
import { readdir, stat } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import type { MentionItem } from '../../shared/types'
import { filterMentions, mimeFromExt, mentionTypeFromFilename } from '../../shared/mentions'

export interface FileEntry {
  path: string
  relPath: string
  name: string
  mime: string
  size: number
  mtime: number
  type: 'file' | 'image'
}

interface IndexEntry {
  workdir: string
  watcher: FSWatcher
  files: FileEntry[]
  ready: boolean
}

const _indexes = new Map<string, IndexEntry>()

// Игнорируемые директории (union из fastContextWatcher.IGNORED_DIRS_DEFAULT
// и fs.ipc.DEFAULT_IGNORE_DIRS). Дополнительно — типичные мусорные папки.
const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build',
  '.next', 'coverage', '.cache', '.turbo', '.parcel-cache', 'target',
  '.gradle', '.idea', '.vscode', '.hermes', '.mimocode', '.playwright-mcp',
  '.planning', 'logs', 'tmp', 'tmp_out', '.opencode', '.syntee',
  '.angular', '.svelte-kit', '.nuxt', '.expo', 'Pods', 'vendor',
])

const IGNORED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', // картинки — НЕТ, они нужны! убираем ниже
])

// Картинки НЕ игнорируем — они нужны для @прикрепления. Убираем из IGNORED_EXTS.
IGNORED_EXTS.clear()

const BINARY_EXTS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.lib', '.obj', '.bin', '.dat',
  '.db', '.sqlite', '.db-shm', '.db-wal', '.o', '.a', '.class', '.jar', '.war',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.lock', '.log', '.zip', '.gz',
  '.tar', '.rar', '.7z', '.bz2', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
])

const MAX_FILES = 20000
const MAX_DEPTH = 10
const SCAN_DEBOUNCE_MS = 200

// ── .gitignore парсинг (упрощённый) ──────────────────────────────────────────

interface GitignorePatterns {
  dirs: Set<string>
  files: Set<string>
  exts: Set<string>
}

function parseGitignore(workdir: string): GitignorePatterns {
  const result: GitignorePatterns = { dirs: new Set(), files: new Set(), exts: new Set() }
  const giPath = workdir + sep + '.gitignore'
  if (!existsSync(giPath)) return result
  try {
    const content = readFileSync(giPath, 'utf-8')
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      // Убираем ведущий / (anchor to root) для упрощения
      const pat = line.replace(/^\//, '')
      // Директория (заканчивается на /)
      if (pat.endsWith('/')) {
        result.dirs.add(pat.slice(0, -1))
        continue
      }
      // Глоб расширения (*.log, *.tmp)
      if (pat.startsWith('*.')) {
        result.exts.add(pat.slice(1)) // '.log'
        continue
      }
      // Точный файл/паттерн без слеша — добавляем как файл
      if (!pat.includes('/')) {
        result.files.add(pat)
      }
    }
  } catch { /* ok */ }
  return result
}

function isIgnored(relPath: string, name: string, gitignore: GitignorePatterns): boolean {
  const segments = relPath.split('/')
  for (const seg of segments) {
    if (IGNORED_DIRS.has(seg)) return true
    if (gitignore.dirs.has(seg)) return true
  }
  if (gitignore.files.has(name)) return true
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot >= 0) {
    const ext = lower.slice(dot)
    if (gitignore.exts.has(ext)) return true
    if (BINARY_EXTS.has(ext)) return true
  }
  // Скрытые файлы (.env, .gitignore — оставляем; остальные .dotfiles — скрываем)
  if (name.startsWith('.') && name !== '.env' && name !== '.gitignore' && name !== '.editorconfig') {
    return true
  }
  return false
}

// ── Первичный scan ───────────────────────────────────────────────────────────

async function scanDir(
  workdir: string,
  gitignore: GitignorePatterns,
  onFile: (entry: FileEntry) => void,
  count: { n: number },
): Promise<void> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: workdir, depth: 0 }]
  while (stack.length > 0 && count.n < MAX_FILES) {
    const { dir, depth } = stack.pop()!
    if (depth > MAX_DEPTH) continue
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirents) {
      if (count.n >= MAX_FILES) break
      const fullPath = dir + sep + d.name
      const relPath = relative(workdir, fullPath).split(sep).join('/')
      if (d.isDirectory()) {
        if (IGNORED_DIRS.has(d.name) || gitignore.dirs.has(d.name)) continue
        if (d.name.startsWith('.') && d.name !== '.env') continue
        stack.push({ dir: fullPath, depth: depth + 1 })
        continue
      }
      if (d.isFile()) {
        if (isIgnored(relPath, d.name, gitignore)) continue
        let st
        try {
          st = await stat(fullPath)
        } catch {
          continue
        }
        const mime = mimeFromExt(d.name)
        onFile({
          path: fullPath,
          relPath,
          name: d.name,
          mime,
          size: st.size,
          mtime: st.mtimeMs,
          type: mentionTypeFromFilename(d.name),
        })
        count.n++
      }
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Запускает индексацию workdir. Idempotent — повторный вызов для того же
 *  workdir не создаёт второй watcher. Возвращает Promise<void> который
 *  резолвится когда первичный scan завершён. */
export async function startIndexing(workdir: string): Promise<void> {
  if (_indexes.has(workdir)) return
  const gitignore = parseGitignore(workdir)
  const entry: IndexEntry = {
    workdir,
    watcher: undefined as unknown as FSWatcher,
    files: [],
    ready: false,
  }
  _indexes.set(workdir, entry)

  // Первичный scan (быстрее chokidar для нашего кэша)
  const count = { n: 0 }
  await scanDir(workdir, gitignore, (fe) => entry.files.push(fe), count)
  entry.files.sort((a, b) => b.mtime - a.mtime)
  entry.ready = true

  // Запускаем watcher для incremental-обновлений.
  // fs.watch(recursive) — Windows ReadDirectoryChangesW: один kernel-handle
  // на всё дерево, 0% CPU в простое (chokidar давал тысячи handles + stat).
  // ── Incremental update: только изменившиеся файлы, НЕ полный rescan. ──
  // Копим изменившиеся пути в Set и debounce'ом обрабатываем только их
  // (stat каждого + upsert/remove в entry.files + re-sort).
  let debounceTimer: NodeJS.Timeout | null = null
  const pendingPaths = new Set<string>()
  const flush = async (): Promise<void> => {
    debounceTimer = null
    const paths = Array.from(pendingPaths)
    pendingPaths.clear()
    if (paths.length === 0) return
    for (const fullPath of paths) {
      const relPath = relative(workdir, fullPath).split(sep).join('/')
      const name = basename(fullPath)
      if (isIgnored(relPath, name, gitignore)) {
        // игнорируемый файл — удаляем из кэша если был
        const idx = entry.files.findIndex(f => f.path === fullPath)
        if (idx >= 0) entry.files.splice(idx, 1)
        continue
      }
      let st
      try {
        st = await stat(fullPath)
      } catch {
        // файл удалён — убираем из кэша
        const idx = entry.files.findIndex(f => f.path === fullPath)
        if (idx >= 0) entry.files.splice(idx, 1)
        continue
      }
      const fe: FileEntry = {
        path: fullPath,
        relPath,
        name,
        mime: mimeFromExt(name),
        size: st.size,
        mtime: st.mtimeMs,
        type: mentionTypeFromFilename(name),
      }
      const idx = entry.files.findIndex(f => f.path === fullPath)
      if (idx >= 0) entry.files[idx] = fe
      else entry.files.push(fe)
    }
    // re-sort — дёшево даже для 10к (ms), зато порядок mtime актуален.
    entry.files.sort((a, b) => b.mtime - a.mtime)
  }
  const scheduleRescan = (fullPath: string): void => {
    pendingPaths.add(fullPath)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flush, SCAN_DEBOUNCE_MS)
  }
  try {
    const watcher = watch(workdir, { recursive: true, persistent: true }, (_event, filename) => {
      // filename может быть null (редкие случаи на Windows) — такие события
      // пропускаем; индекс перепроверит stat при следующем обращении через
      // @mention (файл не найдётся — не страшно).
      if (!filename) return
      // filename приходит с '\\' или '/' сепараторами — нормализуем.
      const fullPath = workdir + sep + filename.split('/').join(sep).split('\\').join(sep)
      scheduleRescan(fullPath)
    })
    entry.watcher = watcher
    watcher.on('error', (e) => console.warn(`[fileIndexer] error for ${workdir}:`, e))
  } catch (e) {
    console.warn(`[fileIndexer] watcher failed for ${workdir}:`, e)
  }
}

/** Останавливает индексацию workdir. */
export async function stopIndexing(workdir: string): Promise<void> {
  const entry = _indexes.get(workdir)
  if (!entry) return
  try {
    await entry.watcher?.close()
  } catch { /* ignore */ }
  _indexes.delete(workdir)
}

/** Останавливает все индексации (при выходе из приложения). */
export async function stopAllIndexing(): Promise<void> {
  const dirs = Array.from(_indexes.keys())
  await Promise.all(dirs.map(stopIndexing))
}

/** Готов ли индекс для workdir (первичный scan завершён). */
export function isIndexReady(workdir: string): boolean {
  return _indexes.get(workdir)?.ready ?? false
}

/** Возвращает все файлы индекса (без фильтрации). Для отладки/экспорта. */
export function getAllFiles(workdir: string): FileEntry[] {
  return _indexes.get(workdir)?.files ?? []
}

/** Поиск файлов по query. Возвращает отсортированный через filterMentions
 *  список MentionItem[]. limit — макс. кол-во результатов. */
export function searchFiles(workdir: string, query: string, limit = 30): MentionItem[] {
  const entry = _indexes.get(workdir)
  if (!entry || !entry.ready) return []
  const items: MentionItem[] = entry.files.map(f => ({
    id: `file:${f.path}`,
    type: f.type,
    label: f.name,
    description: f.relPath,
    path: f.path,
    relPath: f.relPath,
    mime: f.mime,
    size: f.size,
    mtime: f.mtime,
  }))
  return filterMentions(query, items, limit)
}

/** Последние изменённые файлы (для @ без query). */
export function getRecentFiles(workdir: string, limit = 20): MentionItem[] {
  const entry = _indexes.get(workdir)
  if (!entry || !entry.ready) return []
  return entry.files.slice(0, limit).map(f => ({
    id: `file:${f.path}`,
    type: f.type,
    label: f.name,
    description: f.relPath,
    path: f.path,
    relPath: f.relPath,
    mime: f.mime,
    size: f.size,
    mtime: f.mtime,
  }))
}
