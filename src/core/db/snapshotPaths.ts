// §rollback — резолв пути file-снапшота для восстановления файлов.
//
// file_snapshots исторически (до фикса §rollback, 11.09.2026) хранили сырой
// путь из аргументов тула — часто ОТНОСИТЕЛЬНЫЙ («src/foo.ts»). Файловые
// операции (writeFileSync/unlinkSync/existsSync) в main-процессе резолвят
// такой путь против process.cwd() — папки установки приложения, а не папки
// проекта чата. Из-за этого chat:rewindTo «проходил» (писал сообщение об
// откате), а реальные файлы в проекте не менялись.
//
// Модуль без зависимостей (кроме path) — тестируется офлайн, импортируется
// chatCheckpoint.ipc.ts.

import { isAbsolute, resolve } from 'path'

/**
 * Приводит путь снапшота к абсолютному.
 * - Абсолютный путь остаётся как есть.
 * - Относительный резолвится против workdir чата (fallback — process.cwd()
 *   для старых чатов без workdir / Work-режима).
 */
export function resolveSnapshotPath(p: string, workdir?: string): string {
  try {
    if (isAbsolute(p)) return p
    return resolve(workdir ?? process.cwd(), p)
  } catch {
    return p
  }
}
