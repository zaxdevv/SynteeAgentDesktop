import { ipcMain, BrowserWindow } from 'electron'
import { readdir as fsReaddir, stat as fsStat, open as fsOpen, writeFile as fsWriteFile, rename as fsRename, mkdir as fsMkdir } from 'fs/promises'
import { join, resolve as pathResolve, relative, sep, dirname } from 'path'
import { homedir } from 'os'
import { getChatWorkdirContext } from '../../core/db'

// Dotfiles, которые нужно показывать несмотря на точку в начале имени.
// .env и .gitignore — для редактора; .cursorrules/.windsurfrules/.clinerules —
// AI rules-файлы, которые могут быть интересны в файловом пикере инструкций.
const VISIBLE_DOTFILES = new Set([
  '.env', '.gitignore',
  '.cursorrules', '.windsurfrules', '.clinerules',
])

const DEFAULT_IGNORE_DIRS = new Set(['node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build', '.next', 'coverage', '.cache'])

export interface FsEntry {
  name: string
  path: string
  relPath: string
  isDir: boolean
  isSymlink: boolean
  size: number
  mtime: number
}

export interface FsTreeEntry extends FsEntry {
  children?: FsEntry[]
}

function safeJoin(root: string, relativePath: string): string | null {
  // pathResolve(root) нормализует разделители и регистр диска: root с
  // forward-слэшами (C:/Projects/x) иначе не совпадает с resolved
  // (native C:\Projects\x\...) и ЛЮБОЙ путь отбрасывается как
  // «Path outside root» — даже существующие файлы проекта.
  const rootNorm = pathResolve(root)
  const resolved = pathResolve(root, relativePath)
  if (resolved !== rootNorm && !resolved.startsWith(rootNorm + sep)) {
    return null
  }
  return resolved
}

export function registerFsIPC(): void {
  // Cancellation is per renderer + explorer instance, never global: two
  // independent explorers may search the same root concurrently.
  const searches = new Map<string, { cancelled: boolean }>()
  const scopeKey = (senderId: number, scopeId: string) => `${senderId}:${scopeId}`
  ipcMain.on('fs:cancelSearch', (event, scopeId: string) => {
    const key = scopeKey(event.sender.id, scopeId)
    const job = searches.get(key)
    if (job) job.cancelled = true
    searches.delete(key)
  })
  ipcMain.handle('fs:getWorkdir', async (_e, chatId: string) => {
    if (!chatId) return null
    try {
      const ctx = getChatWorkdirContext(chatId)
      return ctx.workdir ?? null
    } catch {
      return null
    }
  })

  ipcMain.handle('fs:listDirectory', async (_e, params: { root: string; relPath?: string; maxEntries?: number }) => {
    const root = params.root
    if (!root) return { success: false, entries: [], error: 'root is required' }
    const relPath = params.relPath ?? ''
    const dirPath = safeJoin(root, relPath)
    if (!dirPath) return { success: false, entries: [], error: 'Path outside root' }

    try {
      // withFileTypes: Dirent[] — isDirectory/isSymbolicLink уже доступны
      // из данных readdir БЕЗ дополнительных stat вызовов. Раньше был stat
      // на каждую запись (500 stat вызовов даже параллельно = тормоза на Windows).
      // size/mtime не используются в дереве — size получаем при открытии файла.
      const dirents = await fsReaddir(dirPath, { withFileTypes: true })
      const max = params.maxEntries ?? 500
      const entries: FsEntry[] = []
      for (const d of dirents) {
        if (entries.length >= max) break
        if (DEFAULT_IGNORE_DIRS.has(d.name)) continue
        if (d.name.startsWith('.') && !VISIBLE_DOTFILES.has(d.name)) continue
        const fullPath = join(dirPath, d.name)
        entries.push({
          name: d.name,
          path: fullPath,
          relPath: relative(root, fullPath).split(sep).join('/'),
          isDir: d.isDirectory(),
          isSymlink: d.isSymbolicLink(),
          size: 0,
          mtime: 0,
        })
      }
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })
      return { success: true, entries }
    } catch (e) {
      return { success: false, entries: [], error: String((e as Error)?.message ?? e) }
    }
  })

  // ── Рекурсивный поиск файлов по имени ────────────────────────────────
  // Обходит файловую систему от root, фильтрует по query (case-insensitive
  // substring match по имени файла). Возвращает до maxResults записей.
  // Игнорирует node_modules/.git/dist и т.п. (DEFAULT_IGNORE_DIRS).
  // Используется FileExplorer для поиска по всем файлам, а не только по
  // загруженным/раскрытым папкам.
  ipcMain.handle('fs:searchFiles', async (event, params: { root: string; query: string; maxResults?: number; scopeId?: string }) => {
    const root = params.root
    if (!root) return { success: false, entries: [], error: 'root is required' }
    const query = params.query?.toLowerCase().trim() ?? ''
    if (!query) return { success: true, entries: [] }

    const key = params.scopeId ? scopeKey(event.sender.id, params.scopeId) : null
    if (key) {
      const old = searches.get(key)
      if (old) old.cancelled = true
    }
    const job = { cancelled: false }
    if (key) searches.set(key, job)
    const cancelled = () => job.cancelled || event.sender.isDestroyed()
    const maxResults = params.maxResults ?? 200
    const results: FsEntry[] = []
    const visited = new Set<string>()

    const walk = async (dirPath: string): Promise<void> => {
      if (cancelled() || results.length >= maxResults) return
      if (visited.has(dirPath)) return
      visited.add(dirPath)

      let dirents
      try {
        dirents = await fsReaddir(dirPath, { withFileTypes: true })
      } catch {
        return // нет прав / нет папки — пропускаем
      }

      for (const d of dirents) {
        if (cancelled() || results.length >= maxResults) return
        if (DEFAULT_IGNORE_DIRS.has(d.name)) continue
        if (d.name.startsWith('.') && !VISIBLE_DOTFILES.has(d.name)) continue

        const fullPath = join(dirPath, d.name)
        const relPath = relative(root, fullPath).split(sep).join('/')

        if (d.isDirectory()) {
          await walk(fullPath)
        } else {
          if (d.name.toLowerCase().includes(query) || relPath.toLowerCase().includes(query)) {
            results.push({
              name: d.name,
              path: fullPath,
              relPath,
              isDir: false,
              isSymlink: d.isSymbolicLink(),
              size: 0,
              mtime: 0,
            })
          }
        }
      }
    }

    try {
      await walk(root)
      results.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true, sensitivity: 'base' }))
      return { success: true, entries: results }
    } catch (e) {
      return { success: false, entries: [], error: String((e as Error)?.message ?? e) }
    } finally {
      if (key && searches.get(key) === job) searches.delete(key)
    }
  })

  ipcMain.handle('fs:readFile', async (_e, params: { root: string; relPath: string; maxBytes?: number }) => {
    const root = params.root
    if (!root) return { success: false, content: '', error: 'root is required' }
    const filePath = safeJoin(root, params.relPath)
    if (!filePath) return { success: false, content: '', error: 'Path outside root' }

    const maxBytes = params.maxBytes ?? 512 * 1024
    try {
      const st = await fsStat(filePath)
      if (st.isDirectory()) return { success: false, content: '', error: 'Is a directory' }
      if (st.size > maxBytes * 4) return { success: false, content: '', error: `File too large (${(st.size / 1024).toFixed(1)} KB). Max ${(maxBytes * 4 / 1024).toFixed(0)} KB.` }

      // Частичное чтение через handle.read — раньше fsReadFile читал ВЕСЬ файл
      // в память (до 2MB), потом slice. Бинарность проверяем прямо в прочитанном
      // буфере (раньше отдельный 8KB read через isBinaryFile).
      const readSize = Math.min(st.size, maxBytes)
      const handle = await fsOpen(filePath, 'r')
      try {
        const buf = Buffer.alloc(readSize)
        const { bytesRead } = await handle.read(buf, 0, readSize, 0)
        const data = buf.slice(0, bytesRead)

        if (data.includes(0)) {
          return { success: false, content: '', error: 'Binary file', isBinary: true, size: st.size }
        }

        const truncated = st.size > maxBytes
        let content = data.toString('utf8')

        // Кап строк — чтобы CodePreview/Prism не токенизировал огромные файлы
        const MAX_LINES = 2000
        const lines = content.split('\n')
        if (lines.length > MAX_LINES) {
          content = lines.slice(0, MAX_LINES).join('\n')
          return {
            success: true,
            content,
            truncated: true,
            size: st.size,
            mtime: st.mtimeMs,
            truncatedReason: `Показано ${MAX_LINES} из ${lines.length} строк`,
          }
        }

        return { success: true, content, truncated, size: st.size, mtime: st.mtimeMs }
      } finally {
        await handle.close()
      }
    } catch (e) {
      return { success: false, content: '', error: String((e as Error)?.message ?? e) }
    }
  })

  // ── fs:writeFile — запись файла (атомарная: tmp + rename) ──────────
  // Используется FileEditorPane (Monaco) для сохранения правок.
  // Атомарная запись через tmp+rename предотвращает повреждение файла
  // при краше/закрытии во время записи (паттерн из LauncherBridge).
  // После записи эмитит 'file:changed' событие в renderer — для live-
  // обновления открытых файловых табов.
  ipcMain.handle('fs:writeFile', async (_e, params: {
    root: string
    relPath: string
    content: string
  }) => {
    const root = params.root
    if (!root) return { success: false, error: 'root is required' }
    const filePath = safeJoin(root, params.relPath)
    if (!filePath) return { success: false, error: 'Path outside root' }

    try {
      // Создаём родительскую директорию если её нет
      await fsMkdir(dirname(filePath), { recursive: true })

      // Атомарная запись: tmp + rename
      const tmp = filePath + '.syntee-tmp'
      // BOM для .ps1 (как в writeWithOptionalBom — PowerShell 5.1 читает
      // файлы без BOM как cp1251)
      if (/\.ps1$/i.test(filePath)) {
        const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(params.content, 'utf-8')])
        await fsWriteFile(tmp, buf)
      } else {
        await fsWriteFile(tmp, params.content, 'utf-8')
      }
      await fsRename(tmp, filePath)

      const st = await fsStat(filePath)

      // Эмитим событие об изменении файла для live-обновления в renderer
      const win = BrowserWindow.getAllWindows()[0] ?? null
      win?.webContents.send('file:changed', { path: filePath, relPath: params.relPath, root })

      return { success: true, size: st.size, mtime: st.mtimeMs }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── fs:statPath — stat по абсолютному пути (вне зависимости от workdir) ──
  // Используется кликабельными путями в сообщениях: до открытия решаем,
  // файл это (→ правая панель) или папка (→ Проводник через shell:openPath),
  // и существует ли путь вообще (→ тост «не найдено» вместо сломанного таба).
  // Абсолютный путь обязателен — относительные резолвит renderer от workdir.
  // Возвращает resolved — путь с развёрнутым ~ (для shell.openPath и табов).
  ipcMain.handle('fs:statPath', async (_e, absPath: string) => {
    const empty = { exists: false, isDir: false, isFile: false, size: 0, resolved: '' }
    if (typeof absPath !== 'string' || !absPath) return empty
    // Только абсолютные пути: C:\... , C:/... , /... , \\server\... , ~/...
    if (!/^([a-zA-Z]:[\\/]|\\\\|\/|~\/)/.test(absPath)) return empty
    const resolved = absPath.startsWith('~')
      ? join(homedir(), absPath.slice(2))
      : absPath
    try {
      const st = await fsStat(resolved)
      return { exists: true, isDir: st.isDirectory(), isFile: st.isFile(), size: st.size, resolved }
    } catch {
      return { exists: false, isDir: false, isFile: false, size: 0, resolved }
    }
  })

  // ── fs:checkFilesExist — проверка существования файлов по списку путей ──
  // Принимает root + массив относительных путей, возвращает массив существующих.
  // Используется ProjectSettingsModal для отображения найденных авто-дискавери файлов.
  ipcMain.handle('fs:checkFilesExist', async (_e, params: { root: string; relPaths: string[] }) => {
    const root = params.root
    if (!root) return { success: false, existing: [], error: 'root is required' }
    const existing: string[] = []
    for (const relPath of params.relPaths ?? []) {
      const filePath = safeJoin(root, relPath)
      if (!filePath) continue
      try {
        const st = await fsStat(filePath)
        if (st.isFile()) existing.push(relPath)
      } catch { /* not found */ }
    }
    return { success: true, existing }
  })
}
