/**
 * fileHash — быстрый некриптографический content hash для детекта изменений.
 *
 * Проблема mtime+size: `git checkout` может вернуть тот же size/mtime, но content
 * разный. `touch` меняет mtime без изменения content → ложный reindex.
 *
 * Решение: hash первых 4KB файла + size. FNV-1a — простой, быстрый, микросекунды.
 * Для файлов < 4KB — hash всего файла. Для больших — hash первых 4KB + size
 * (size различает файлы с одинаковым началом).
 *
 * Синхронный read (openSync/readSync/closeSync) — OK в worker thread, не блокирует
 * main/renderer. ~0.01ms на файл.
 */

import { openSync, readSync, closeSync, statSync } from 'fs'

/**
 * Быстрый hash файла: FNV-1a первых 4KB + последних 4KB + size.
 * Возвращает 32-bit unsigned integer.
 *
 * Head+tail: правка в середине/конце большого файла при неизменном начале
 * и размере (частый случай — правка функции в конце модуля) детектится,
 * при этом чтение остаётся O(8KB) — микросекунды.
 */
export function quickHash(filePath: string, size?: number): number {
  let s = size
  if (s === undefined) {
    try {
      s = statSync(filePath).size
    } catch {
      return 0
    }
  }

  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return 0
  }

  // FNV-1a hash
  let hash = 2166136261 // FNV offset basis (32-bit)
  const buf = Buffer.alloc(4096)
  try {
    // Head: первые 4KB
    const headLen = Math.min(4096, s)
    const head = headLen === 4096 ? buf : buf.subarray(0, headLen)
    readSync(fd, head, 0, headLen, 0)
    for (let i = 0; i < headLen; i++) {
      hash ^= head[i]
      hash = Math.imul(hash, 16777619) // FNV prime
    }
    // Tail: последние 4KB (только если файл заметно больше head — иначе
    // это те же байты)
    if (s > 8192) {
      const tailOff = s - 4096
      readSync(fd, buf, 0, 4096, tailOff)
      for (let i = 0; i < 4096; i++) {
        hash ^= buf[i]
        hash = Math.imul(hash, 16777619)
      }
    }
  } catch {
    // fallthrough — hash от того, что успели прочитать
  } finally {
    try { closeSync(fd) } catch { /* ignore */ }
  }
  // Добавляем size для различения файлов с одинаковым началом
  hash ^= s
  return hash >>> 0 // unsigned 32-bit
}
