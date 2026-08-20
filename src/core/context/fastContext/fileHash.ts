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
 * Быстрый hash файла: FNV-1a первых 4KB + size.
 * Возвращает 32-bit unsigned integer.
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

  let buf: Buffer
  try {
    const fd = openSync(filePath, 'r')
    const readLen = Math.min(4096, s)
    buf = Buffer.alloc(readLen)
    readSync(fd, buf, 0, readLen, 0)
    closeSync(fd)
  } catch {
    return 0
  }

  // FNV-1a hash
  let hash = 2166136261 // FNV offset basis (32-bit)
  for (let i = 0; i < buf.length; i++) {
    hash ^= buf[i]
    hash = Math.imul(hash, 16777619) // FNV prime
  }
  // Добавляем size для различения файлов с одинаковым началом
  hash ^= s
  return hash >>> 0 // unsigned 32-bit
}
