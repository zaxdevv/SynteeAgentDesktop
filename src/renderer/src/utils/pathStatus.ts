// ── Кэш статуса путей (существует/папка/файл) для кликабельных путей ──────
//
// Оптимизация: один IPC fs:statPath на уникальный абсолютный путь за сессию.
// - statusCache — Map<absPath, PathStatusRecord>, переживает всё;
// - подписки — только те компоненты, чей путь изменился, ре-рендерятся
//   (useSyncExternalStore в usePathStatus);
// - инвалдиация по событию 'file:changed' (агент записал/удалил файл) —
//   статус перевычисляется лениво при следующем обращении.
//
// Статусы:
//   pending  — проверка в полёте (первый рендер)
//   exists   — путь существует (isDir/isFile уточняют тип)
//   missing  — не существует (ссылка приглушается)
//   unknown  — проверить нельзя (нет workdir для относительного пути, IPC ошибка)

import { useCallback, useSyncExternalStore } from 'react'

export interface PathStatusRecord {
  status: 'pending' | 'exists' | 'missing' | 'unknown'
  isDir?: boolean
  isFile?: boolean
}

const statusCache = new Map<string, PathStatusRecord>()
const inflight = new Map<string, Promise<void>>()
const listeners = new Map<string, Set<() => void>>()

let fileChangedHooked = false

/** Подписка на 'file:changed' — агент записал файл → сбрасываем кэш статуса. */
function ensureFileChangedHook(): void {
  if (fileChangedHooked) return
  fileChangedHooked = true
  try {
    window.syntee?.on?.('file:changed', (data: unknown) => {
      const p = (data as { path?: string })?.path
      if (p && statusCache.has(p)) statusCache.delete(p)
      // relPath-ключи тоже могли закэшироваться — чистим по суффиксу
      for (const key of statusCache.keys()) {
        if (key === p || key.endsWith('/' + p) || key.endsWith('\\' + p)) statusCache.delete(key)
      }
      notifyAll()
    })
  } catch { /* вне electron — ок */ }
}

function notifyAll(): void {
  for (const set of listeners.values()) {
    for (const fn of set) fn()
  }
}

function notify(abs: string): void {
  const set = listeners.get(abs)
  if (set) for (const fn of set) fn()
}

async function checkPath(abs: string): Promise<void> {
  let p = inflight.get(abs)
  if (!p) {
    p = (async () => {
      try {
        const r = await window.syntee.fs.statPath(abs)
        statusCache.set(abs, {
          status: r.exists ? 'exists' : 'missing',
          isDir: r.isDir || undefined,
          isFile: r.isFile || undefined,
        })
      } catch {
        statusCache.set(abs, { status: 'unknown' })
      }
      notify(abs)
    })()
    inflight.set(abs, p)
    void p.finally(() => inflight.delete(abs))
  }
  return p
}

/**
 * Статус пути (с побочным эффектом запуска проверки при первом обращении).
 * Идемпотентно — повторные вызовы дёшевы (Map lookup).
 */
export function getPathStatus(absPath: string): PathStatusRecord {
  ensureFileChangedHook()
  let s = statusCache.get(absPath)
  if (s === undefined) {
    s = { status: 'pending' }
    statusCache.set(absPath, s)
    void checkPath(absPath)
  }
  return s
}

/** Принудительный перевычислить статус (после клика-открытия). */
export function invalidatePathStatus(absPath: string): void {
  if (statusCache.delete(absPath)) {
    void checkPath(absPath)
  }
}

// ── React-хук: подписка на статус одного пути (useSyncExternalStore) ─────
// Ре-рендерится только компонент с изменившимся путём, не всё сообщение.
// ВАЖНО: getSnapshot обязан возвращать СТАБИЛЬНУЮ ссылку между вызовами —
// новый объект-литерал на каждый вызов = «стор изменился» на каждом рендере
// = бесконечный ре-рендер (React #185, Maximum update depth exceeded).
const UNKNOWN_STATUS: PathStatusRecord = { status: 'unknown' }
const NOOP_UNSUB = () => {}

export function usePathStatus(absPath: string | undefined): PathStatusRecord {
  const subscribe = useCallback(
    (fn: () => void) => (absPath ? subscribePathStatus(absPath, fn) : NOOP_UNSUB),
    [absPath],
  )
  const getSnapshot = useCallback((): PathStatusRecord => {
    if (!absPath) return UNKNOWN_STATUS
    return getPathStatus(absPath)
  }, [absPath])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function subscribePathStatus(absPath: string, fn: () => void): () => void {
  let set = listeners.get(absPath)
  if (!set) {
    set = new Set()
    listeners.set(absPath, set)
  }
  set.add(fn)
  return () => {
    set.delete(fn)
    if (set.size === 0) listeners.delete(absPath)
  }
}

/** Асинхронное ожидание статуса (для не-React потребителей: терминал,
 *  поповер). Если статус уже в кэше — резолвится сразу; иначе ждёт IPC. */
export function awaitPathStatus(absPath: string): Promise<PathStatusRecord> {
  const s = getPathStatus(absPath) // заодно запускает проверку
  if (s.status !== 'pending') return Promise.resolve(s)
  return new Promise<PathStatusRecord>(resolve => {
    const unsub = subscribePathStatus(absPath, () => {
      const cur = statusCache.get(absPath)
      if (cur && cur.status !== 'pending') {
        unsub()
        resolve(cur)
      }
    })
  })
}
