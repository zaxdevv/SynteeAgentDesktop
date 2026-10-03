// ── Dots: CRUD конфигов + история пробуждений ───────────────────────────
// Dot — always-on фоновый агент (см. shared/types/dot.ts). Конфиги живут
// в таблице dots, история пробуждений — в dot_runs. Чат Dot'а — обычный
// чат (chats.id), создаётся/удаляется через chats.ts.
import type { DotConfig, DotRun, DotTrigger } from '../../shared/types'
import { v4 as uuid } from 'uuid'
import { getDB } from './handle'

// === DOTS (конфиги) ===

interface DotRow {
  id: string
  name: string
  emoji: string
  color: string
  purpose: string
  rules: string | null
  schedule_kind: string | null
  schedule_value: string | null
  watch_paths: string | null
  webhook_enabled: number
  webhook_secret: string | null
  model_id: string | null
  model_provider: string | null
  chat_id: string
  enabled: number
  created_at: number
  updated_at: number
}

function rowToConfig(row: DotRow): DotConfig {
  return {
    id: row.id,
    name: row.name,
    // Колонка исторически называется emoji — теперь хранит имя иконки AppIcon.
    icon: row.emoji || 'bot',
    color: row.color,
    purpose: row.purpose,
    rules: row.rules ?? undefined,
    schedule: row.schedule_kind
      ? { kind: row.schedule_kind as 'cron' | 'interval', value: row.schedule_value ?? '' }
      : undefined,
    watchPaths: row.watch_paths ? JSON.parse(row.watch_paths) as string[] : undefined,
    webhookEnabled: row.webhook_enabled === 1,
    webhookSecret: row.webhook_secret ?? undefined,
    modelId: row.model_id,
    modelProvider: row.model_provider,
    chatId: row.chat_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Создать Dot. chatId должен уже существовать (createChat в DotManager). */
export function createDot(config: Omit<DotConfig, 'createdAt' | 'updatedAt'>): DotConfig {
  const db = getDB()
  const now = Date.now()
  db.prepare(`
    INSERT INTO dots (id, name, emoji, color, purpose, rules, schedule_kind, schedule_value,
                      watch_paths, webhook_enabled, webhook_secret, model_id, model_provider,
                      chat_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `  ).run(
    config.id,
    config.name,
    // Колонка emoji хранит имя иконки AppIcon (историческое имя колонки).
    config.icon,
    config.color,
    config.purpose,
    config.rules ?? null,
    config.schedule?.kind ?? null,
    config.schedule?.value ?? null,
    config.watchPaths ? JSON.stringify(config.watchPaths) : null,
    config.webhookEnabled ? 1 : 0,
    config.webhookSecret ?? null,
    config.modelId ?? null,
    config.modelProvider ?? null,
    config.chatId,
    config.enabled ? 1 : 0,
    now,
    now,
  )
  return { ...config, createdAt: now, updatedAt: now }
}

/** Все Dot'ы (включая выключенных). */
export function getAllDots(): DotConfig[] {
  const rows = getDB().prepare(`SELECT * FROM dots ORDER BY created_at ASC`).all() as DotRow[]
  return rows.map(rowToConfig)
}

export function getDotById(id: string): DotConfig | null {
  const row = getDB().prepare(`SELECT * FROM dots WHERE id = ?`).get(id) as DotRow | undefined
  return row ? rowToConfig(row) : null
}

/** Частичное обновление конфига. */
export function updateDot(id: string, patch: Partial<DotConfig>): void {
  const db = getDB()
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name) }
  if (patch.icon !== undefined) { sets.push('emoji = ?'); vals.push(patch.icon) }
  if (patch.color !== undefined) { sets.push('color = ?'); vals.push(patch.color) }
  if (patch.purpose !== undefined) { sets.push('purpose = ?'); vals.push(patch.purpose) }
  if (patch.rules !== undefined) { sets.push('rules = ?'); vals.push(patch.rules ?? null) }
  if (patch.schedule !== undefined) {
    sets.push('schedule_kind = ?'); vals.push(patch.schedule?.kind ?? null)
    sets.push('schedule_value = ?'); vals.push(patch.schedule?.value ?? null)
  }
  if (patch.watchPaths !== undefined) { sets.push('watch_paths = ?'); vals.push(patch.watchPaths ? JSON.stringify(patch.watchPaths) : null) }
  if (patch.webhookEnabled !== undefined) { sets.push('webhook_enabled = ?'); vals.push(patch.webhookEnabled ? 1 : 0) }
  if (patch.webhookSecret !== undefined) { sets.push('webhook_secret = ?'); vals.push(patch.webhookSecret ?? null) }
  if (patch.modelId !== undefined) { sets.push('model_id = ?'); vals.push(patch.modelId) }
  if (patch.modelProvider !== undefined) { sets.push('model_provider = ?'); vals.push(patch.modelProvider) }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0) }
  if (sets.length === 0) return
  sets.push('updated_at = ?'); vals.push(Date.now())
  vals.push(id)
  db.prepare(`UPDATE dots SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

/** Удалить Dot (чат удаляет вызывающий — DotManager). */
export function deleteDot(id: string): void {
  getDB().prepare(`DELETE FROM dots WHERE id = ?`).run(id)
  getDB().prepare(`DELETE FROM dot_runs WHERE dot_id = ?`).run(id)
}

// === DOT_RUNS (история пробуждений) ===

interface DotRunRow {
  id: string
  dot_id: string
  trigger: string
  started_at: number
  finished_at: number | null
  status: string
  summary: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
}

function rowToRun(row: DotRunRow): DotRun {
  return {
    id: row.id,
    dotId: row.dot_id,
    trigger: row.trigger as DotTrigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    status: row.status as DotRun['status'],
    summary: row.summary ?? undefined,
    promptTokens: row.prompt_tokens ?? undefined,
    completionTokens: row.completion_tokens ?? undefined,
  }
}

/** Начать ран (status='running'). */
export function startDotRun(dotId: string, trigger: DotTrigger): DotRun {
  const run: DotRun = { id: uuid(), dotId, trigger, startedAt: Date.now(), status: 'running' }
  getDB().prepare(`
    INSERT INTO dot_runs (id, dot_id, trigger, started_at, finished_at, status, summary, prompt_tokens, completion_tokens)
    VALUES (?, ?, ?, ?, NULL, 'running', NULL, NULL, NULL)
  `).run(run.id, run.dotId, run.trigger, run.startedAt)
  return run
}

/** Завершить ран. */
export function finishDotRun(
  runId: string,
  status: DotRun['status'],
  summary?: string,
  usage?: { promptTokens?: number; completionTokens?: number },
): void {
  getDB().prepare(`
    UPDATE dot_runs SET finished_at = ?, status = ?, summary = ?, prompt_tokens = ?, completion_tokens = ?
    WHERE id = ?
  `).run(Date.now(), status, summary ?? null, usage?.promptTokens ?? null, usage?.completionTokens ?? null, runId)
}

/** История ранов Dot'а (новые первыми). */
export function getDotRuns(dotId: string, limit = 20): DotRun[] {
  const rows = getDB()
    .prepare(`SELECT * FROM dot_runs WHERE dot_id = ? ORDER BY started_at DESC LIMIT ?`)
    .all(dotId, limit) as DotRunRow[]
  return rows.map(rowToRun)
}

/** Счётчики для DotState: всего ранов / report / silent / error. */
export function getDotRunStats(dotId: string): { runCount: number; reportCount: number; silentCount: number; errorCount: number } {
  const row = getDB().prepare(`
    SELECT
      COUNT(*) as runCount,
      SUM(CASE WHEN status = 'report' THEN 1 ELSE 0 END) as reportCount,
      SUM(CASE WHEN status = 'silent' THEN 1 ELSE 0 END) as silentCount,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errorCount
    FROM dot_runs WHERE dot_id = ?
  `).get(dotId) as { runCount: number; reportCount: number | null; silentCount: number | null; errorCount: number | null }
  return {
    runCount: row.runCount ?? 0,
    reportCount: row.reportCount ?? 0,
    silentCount: row.silentCount ?? 0,
    errorCount: row.errorCount ?? 0,
  }
}

/** Последний завершённый ран Dot'а. */
export function getLastDotRun(dotId: string): DotRun | null {
  const row = getDB()
    .prepare(`SELECT * FROM dot_runs WHERE dot_id = ? AND status != 'running' ORDER BY started_at DESC LIMIT 1`)
    .get(dotId) as DotRunRow | undefined
  return row ? rowToRun(row) : null
}

/** Последний ОТЧЁТ Dot'а (status='report') — для превью в карточке списка:
 *  «что Dot сказал в последний раз» важнее статуса последнего рана
 *  (последним мог быть тихий ран или ошибка). */
export function getLastDotReport(dotId: string): DotRun | null {
  const row = getDB()
    .prepare(`SELECT * FROM dot_runs WHERE dot_id = ? AND status = 'report' ORDER BY started_at DESC LIMIT 1`)
    .get(dotId) as DotRunRow | undefined
  return row ? rowToRun(row) : null
}

/** Число отчётов после ts — для unread-бейджей (renderer хранит lastSeen
 *  в localStorage и спрашивает пачкой: «сколько нового у каждого Dot'а?»). */
export function getDotReportCountSince(dotId: string, since: number): number {
  const row = getDB()
    .prepare(`SELECT COUNT(*) as n FROM dot_runs WHERE dot_id = ? AND status = 'report' AND started_at > ?`)
    .get(dotId, since) as { n: number } | undefined
  return row?.n ?? 0
}

/** Найти Dot по chatId (для привязки run-статусов чата к Dot'у). */
export function getDotByChatId(chatId: string): DotConfig | null {
  const row = getDB().prepare(`SELECT * FROM dots WHERE chat_id = ?`).get(chatId) as DotRow | undefined
  return row ? rowToConfig(row) : null
}

/**
 * Ремонт «застрявших» ранов после рестарта: если приложение закрылось/упало
 * во время wake-рана, строка в dot_runs навсегда остаётся status='running'
 * (воркеры worker_threads убиты рестартом процесса, продолжить их нельзя).
 * Помечаем 'cancelled' с понятной причиной — история не врёт вечной «работе».
 * Вызывается из DotManager.init() ДО загрузки конфигов. Возвращает число
 * отремонтированных строк (для лога).
 */
export function repairStaleDotRuns(): number {
  const info = getDB().prepare(`
    UPDATE dot_runs
    SET status = 'cancelled',
        finished_at = ?,
        summary = COALESCE(summary, 'приложение перезапущено во время рана')
    WHERE status = 'running'
  `).run(Date.now())
  return info.changes
}
