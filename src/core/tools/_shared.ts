import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { mkdir as fsMkdir, open as fsOpen } from 'fs/promises'
import { dirname, resolve as pathResolve } from 'path'
import * as Diff from 'diff'

export const execAsync = promisify(exec)
export const execFileAsync = promisify(execFile)

// Единый список игнорируемых директорий для list_directory/find_files/search_code/analyze_project
export const DEFAULT_IGNORE_DIRS = ['node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build', '.next', 'coverage']

// Нормализация CRLF→LF (используется в edit_file/strReplaceCore)
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

// Создаёт родительскую директорию для файла, если её нет
export async function ensureDirFor(filePath: string): Promise<void> {
  const dir = dirname(filePath)
  if (!existsSync(dir)) await fsMkdir(dir, { recursive: true })
}

// Подсчёт изменённых строк в unified diff (пропускает +++/--- заголовки)
export function countChangedLines(diff: string): number {
  return diff.split('\n').filter((l: string) =>
    (l.startsWith('+') || l.startsWith('-')) &&
    !l.startsWith('+++') && !l.startsWith('---')
  ).length
}

// Детекция бинарного файла: проверяем первые 8KB на наличие null-байтов.
// Если есть — файл бинарный, текстовое чтение бессмысленно.
// Используем FileHandle API правильно: fsOpen возвращает FileHandle,
// у которого есть методы .read() и .close() — а не fsPromises.close(fd),
// которого в некоторых версиях Node нет (отсюда "promises.close is not a function").
export async function isBinaryFile(filePath: string): Promise<boolean> {
  let handle: { read: (buf: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>; close: () => Promise<void> } | undefined
  try {
    handle = await fsOpen(filePath, 'r') as unknown as { read: (buf: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>; close: () => Promise<void> }
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buf, 0, 8192, 0)
    return buf.slice(0, bytesRead).includes(0)
  } catch {
    return false  // если не можем открыть — пусть чтение выдаст свою ошибку
  } finally {
    if (handle) await handle.close()
  }
}

// Единая резолюция путей: относительные пути резолвятся через workdir
// (если задан) или process.cwd() (для обратной совместимости — старые чаты
// без workdir, Work-режим, вызовы вне контекста чата), абсолютные остаются как есть.
// Применяется во всех файловых тулах для единообразия.
export function resolveToolPath(p: string, workdir?: string): string {
  return pathResolve(workdir ?? process.cwd(), p)
}

// Удаление ANSI escape-последовательностей из вывода PTY. Path A (persistent
// PTY) возвращает raw-байты с цветами/курсором/очисткой строк — без стрипинга
// они попадают в <pre> (визуальный мусор) и в markdown textBefore (ломают
// рендер). Path B (exec) ANSI не имеет, поэтому функция для него no-op.
// Покрывает: SGR (цвета), CSI cursor/erase, OSC, простые escape (\r, \b).
export function stripAnsi(text: string): string {
  if (!text) return text
  // eslint-disable-next-line no-control-regex
  return text
    // CSI sequences: ESC [ ... letter  (цвета, курсор, очистка строк/экрана)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // OSC sequences: ESC ] ... BEL/ST  (заголовок окна и т.п.)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Прочие ESC-коды: ESC + один символ (например \x1b=, \x1b>)
    // Исключаем [ и ] чтобы не матчить CSI/OSC (уже обработаны выше).
    .replace(/\x1b[^[\]]/g, '')
    // Backspace и вертикальный таб — артефакты PTY
    .replace(/[\b]/g, '')
}

// Умная обрезка вывода команды — показываем начало (контекст) и конец (результат/ошибки)
export function smartTrimOutput(text: string, maxChars = 4000): string {
  // Сначала стрипаем ANSI — иначе обрезка по длине считается вместе с
  // невидимыми кодами и реальный текст обрезается раньше времени.
  const clean = stripAnsi(text)
  if (!clean || clean.length <= maxChars) return clean
  const head = 800   // начало — контекст команды
  const tail = 2000  // конец — результат и ошибки (самое важное)
  const removed = clean.length - head - tail
  return `${clean.slice(0, head)}\n\n...[обрезано ${removed} символов, показано начало и конец]...\n\n${clean.slice(-tail)}`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / 1024 / 1024).toFixed(1) + 'MB'
}

// Генерирует unified diff через npm diff (LCS-based, как git).
// Нормализуем CRLF→LF перед сравнением — иначе на Windows файлы с CRLF
// показывают каждую строку как изменённую (trailing \r делает строки неравными).
export function makeDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldNorm = normalizeLineEndings(oldContent)
  const newNorm = normalizeLineEndings(newContent)
  const patch = Diff.createPatch(filePath, oldNorm, newNorm, '', '', { context: 3 })
  // Убираем заголовок "Index: ...\n======\n" — оставляем только с --- строки
  const lines = patch.split('\n')
  const start = lines.findIndex(l => l.startsWith('---'))
  return start >= 0 ? lines.slice(start).join('\n') : patch
}

/** Изображение для прямой передачи в основную модель (multipart tool-результат).
 *  Структурно совместимо с ContentPart (agent/types.ts) — image_url-блок
 *  в OpenAI-формате. */
export interface ToolImagePart {
  type: 'image_url'
  image_url: { url: string; detail?: string }
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
  diff?: string
  hidden?: boolean  // скрытые тулы (think, update_working_memory) — не показываются в UI
  originalContent?: string | null  // §1.8 — для undo/rollback: содержимое до записи; null = файл был создан
  /** Persistent cwd после выполнения команды (Claude Code approach: pwd -P marker).
   *  Передаётся в следующий runCommand как cwd — cd переживает между вызовами. */
  cwd?: string
  /** Изображения, которые Agent встраивает в tool-сообщение как multipart
   *  content (image_url-блоки + текст) — прямой пас в vision-способную
   *  основную модель (analyze_image). AIClient адаптирует роль под API,
   *  не удаляя визуальные данные при ошибках. */
  imageParts?: ToolImagePart[]
  /** Absolute image paths persisted instead of base64 for history restoration. */
  imagePaths?: string[]
}
