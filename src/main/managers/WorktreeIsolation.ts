import { app } from 'electron'
import { join } from 'path'
import { createHash } from 'crypto'
import { existsSync, writeFileSync, unlinkSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { runGit, isGitRepo, GIT_TIMEOUT_MS } from '../git/runGit'

/**
 * Изоляция параллельных суб-агентов через git worktree.
 *
 * Проблема: без изоляции параллельные суб-агенты одного проекта пишут в одно
 * рабочее дерево → гонки записи. Даже sequential суб-агент правит файлы родителя
 * в обход его undoStack, портя undo/снапшоты.
 *
 * Решение: для каждого суб-агента в режиме изоляции создаётся отдельный
 * `git worktree` от HEAD родителя. После завершения дельта сливается обратно
 * через `git apply --3way`; при конфликте worktree оставляется для ручного
 * разбора (данные не теряются).
 *
 * Worktree-и кладутся в `userData/worktrees/<parentHash>/<agentId>/` — вне
 * project workdir, чтобы не плодить двойную индексацию fast-context (watcher
 * смотрит только project workdir) и не требовать правок IGNORED_DIRS_DEFAULT.
 */

export interface WorktreeInfo {
  worktreePath: string
  branch: string
  baseSha: string
}

export interface MergeResult {
  ok: boolean
  conflict: boolean
  /** true — worktree оставлен (конфликт/ошибка) для ручного разбора; false — очищен. */
  worktreeKept: boolean
  error?: string
}

function worktreesRootFor(parentWorkdir: string): string {
  const parentHash = createHash('sha1').update(parentWorkdir).digest('hex').slice(0, 12)
  return join(app.getPath('userData'), 'worktrees', parentHash)
}

/**
 * Создаёт отдельный git worktree от HEAD родителя.
 * @returns null, если parentWorkdir — не git-репо (caller fallback на shared).
 */
export async function createSubagentWorktree(
  parentWorkdir: string,
  agentId: string,
): Promise<WorktreeInfo | null> {
  const repoOk = await isGitRepo(parentWorkdir)
  if (!repoOk) return null

  // Подчищаем битые метаданные от прошлых сессий (краши и т.п.).
  try { await runGit(parentWorkdir, ['worktree', 'prune']) } catch { /* noop */ }

  const worktreesRoot = worktreesRootFor(parentWorkdir)
  const worktreePath = join(worktreesRoot, agentId)
  const branch = `syntee-sub/${agentId}`

  // baseSha — точка ветвления (HEAD родителя на момент spawn). Сохраняем, чтобы
  // позже вычислить дельту суб-агента даже если он делал коммиты в своей ветке.
  const baseSha = (await runGit(parentWorkdir, ['rev-parse', 'HEAD'])).trim()

  // Если путь существует — это битый worktree от краха с тем же agentId
  // (коллизия практически невозможна: agentId = agent-<ts>-<rand>). Удаляем.
  if (existsSync(worktreePath)) {
    try { rmSync(worktreePath, { recursive: true, force: true }) } catch { /* noop */ }
  }
  try { mkdirSync(worktreesRoot, { recursive: true }) } catch { /* noop */ }

  // Создаём worktree от HEAD с новой веткой. Ветка удобнее для диагностики
  // (`git branch --list 'syntee-sub/*'`), чем detached HEAD.
  await runGit(parentWorkdir, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'])

  return { worktreePath, branch, baseSha }
}

/**
 * Сливает дельту суб-агента обратно в рабочий дерево родителя через
 * `git apply --3way`. 3way позволяет разрешать пересечения с WIP-правками
 * родителя, если контекст совпадает; при неразрешимом конфликте — non-zero
 * exit, worktree оставляется.
 *
 * Дельта вычисляется как `git -C <worktree> diff <baseSha>` — это diff между
 * точкой ветвления и текущим состоянием worktree (включая staged + unstaged
 * правки суб-агента, а также его коммиты в ветке).
 */
export async function mergeWorktreeBack(
  parentWorkdir: string,
  info: WorktreeInfo,
): Promise<MergeResult> {
  // Проверяем, что worktree ещё существует (мог быть удалён вручную).
  if (!existsSync(info.worktreePath)) {
    return { ok: true, conflict: false, worktreeKept: false, error: 'worktree already gone' }
  }

  let diff: string
  try {
    diff = await runGit(info.worktreePath, ['diff', '--no-color', info.baseSha])
  } catch (e: any) {
    return { ok: false, conflict: false, worktreeKept: true, error: `diff failed: ${e.message}` }
  }

  // Нет изменений — применять нечего, можно чистить.
  if (!diff.trim()) {
    return { ok: true, conflict: false, worktreeKept: false }
  }

  // Записываем diff во временный файл и применяем в родительском workdir.
  // `git apply --3way` требует доступа к git object store родителя (есть, т.к.
  // worktree shares один object store с родителем по умолчанию).
  const patchFile = join(tmpdir(), `syntee-merge-${info.branch.replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}.patch`)
  try {
    writeFileSync(patchFile, diff, 'utf-8')
    await runGit(parentWorkdir, ['apply', '--3way', '--whitespace=nowarn', patchFile])
    return { ok: true, conflict: false, worktreeKept: false }
  } catch (e: any) {
    // Non-zero exit — конфликт применения или ошибка. Оставляем worktree для
    // ручного разбора, чтобы данные суб-агента не потерялись.
    return {
      ok: false,
      conflict: true,
      worktreeKept: true,
      error: `git apply --3way failed: ${e.message}`,
    }
  } finally {
    try { unlinkSync(patchFile) } catch { /* noop */ }
  }
}

/**
 * Удаляет worktree и ветку. Безусловный — вызывается при discard (error/cancel)
 * и при успешном cleanup после merge. Силой (--force), т.к. в worktree могут
 * быть незакоммиченные правки (при discard они уже не нужны).
 */
export async function discardWorktree(
  parentWorkdir: string,
  info: WorktreeInfo,
): Promise<void> {
  try {
    await runGit(parentWorkdir, ['worktree', 'remove', '--force', info.worktreePath])
  } catch {
    // worktree уже удалён или путь пропал — тихо игнорируем
  }
  try {
    await runGit(parentWorkdir, ['branch', '-D', info.branch])
  } catch {
    // ветка может быть захвачена или уже удалена — игнорируем
  }
  // Подчищаем директорию, если git не смог (например, файлы вне git)
  try {
    if (existsSync(info.worktreePath)) {
      rmSync(info.worktreePath, { recursive: true, force: true })
    }
  } catch { /* noop */ }
  try { await runGit(parentWorkdir, ['worktree', 'prune']) } catch { /* noop */ }
}

/** Синоним для cleanup после успешного merge — та же логика, что и discard. */
export async function cleanupWorktree(
  parentWorkdir: string,
  info: WorktreeInfo,
): Promise<void> {
  return discardWorktree(parentWorkdir, info)
}

export { GIT_TIMEOUT_MS }
