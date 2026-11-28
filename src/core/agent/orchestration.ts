/**
 * §orchestration — рантайм one-turn оркестрации.
 *
 * Контракт (`src/shared/orchestration.ts`) описывает ТОЛЬКО снимок выбора
 * моделей. Всё, что происходит между выбором и финальным ответом, живёт здесь:
 *
 *   planning  → planner  (read-only: исследование + план)
 *   executing → executor (полный тулсет: реальная работа)
 *   reviewing → reviewer (read-only: вердикт approve/revise/replan)
 *   replanning→ planner  (read-only: исправленный план после «replan»)
 *
 * Инварианты:
 *  - ОДИН существующий цикл Agent.run(): никаких вложенных агентов/сабагентов,
 *    только смена фазовой модели, набора тулов и инструкции.
 *  - Фаза получает ЯВНУЮ модель (provider/model/effort из снимка). Нет
 *    неявного fallback: если провайдер фазы недоступен — AIClient бросает
 *    ошибку, ран останавливается честно.
 *  - Read-only фазы ограничены allowlist'ом И на уровне схем, И на уровне
 *    dispatch (Agent.ts проверяет isToolAllowedInPhase перед выполнением,
 *    включая вложенные вызовы execute_code — «убежать» через Code Mode нельзя).
 *  - Репланы/ревью ограничены счётчиками: ран не может крутиться вечно.
 *  - Планировщик может ответить САМ (`<answer/>`): read-only вопрос не обязан
 *    проходить через исполнителя.
 *  - Явный блокер исполнителя (`<blocker>…</blocker>`) уводит ран в
 *    ограниченный replanning; по исчерпании бюджета — честный финал.
 *  - Нечитаемый тег вердикта ревью — НЕ approve: переспрос, затем честный
 *    финал «не проверено» (§no-false-approval).
 *  - Прогресс — ровно одно событие на переход фазы. UI мержит по phase,
 *    порядок задаётся startedAt (см. renderer/utils/orchestrationProgress.ts).
 */
import type {
  OrchestrationModel,
  OrchestrationResume,
  OrchestrationRun,
  OrchestrationPhase,
  OrchestrationProgress,
} from '../../shared/orchestration'

/** Порядок фаз (для тестов/валидации; UI сортирует по startedAt). */
export const ORCHESTRATION_PHASES: readonly OrchestrationPhase[] = [
  'planning', 'executing', 'reviewing', 'replanning',
]

/** Жёсткие границы рана: репланы и круги ревью не бесконечны. */
export const MAX_ORCHESTRATION_REPLANS = 2
export const MAX_ORCHESTRATION_REVIEW_ROUNDS = 3
/**
 * Сколько раз можно переспросить ревьюера, если тег вердикта есть, но
 * распознать его нельзя (обрезанный/кривой `<review verdict=…>`).
 * Нечитаемый вердикт НЕ считается approve — иначе ран «одобрял» бы работу,
 * которую никто не проверял.
 */
export const MAX_ORCHESTRATION_VERDICT_RETRIES = 2

/**
 * Read-only allowlist исследовательских фаз.
 *
 * Именно allowlist, а не «всё минус мутирующие»: новая тул-схема по умолчанию
 * НЕ попадает в planning/reviewing/replanning, пока её явно не добавят сюда.
 * ask_user/update_todo не трогают рабочее дерево — планировщику они нужны.
 */
export const ORCHESTRATION_READ_ONLY_TOOLS: readonly string[] = [
  'read_file',
  'read_files',
  'find_files',
  'search_code',
  'list_directory',
  'get_diagnostics',
  'project_map',
  'recall_memory',
  'recall_context',
  'read_mcp_result',
  'fetch_page',
  'search_web',
  'search_images',
  'analyze_image',
  'analyze_audio',
  'analyze_video',
  'ask_user',
  'update_todo',
]

/**
 * Разрешён ли тул в фазе.
 *
 * executing — полный тулсет рана (реальная работа). Остальные фазы —
 * только read-only allowlist. execute_code запрещён в read-only фазах
 * безусловно (иначе Code Mode стал бы обходом allowlist'а), MCP/plugin-тулы —
 * тоже: их побочные эффекты неизвестны статически.
 */
export function isToolAllowedInPhase(phase: OrchestrationPhase, toolName: string): boolean {
  if (phase === 'executing') return true
  if (toolName === 'execute_code') return false
  if (toolName.startsWith('mcp__') || toolName.startsWith('plugin__')) return false
  return ORCHESTRATION_READ_ONLY_TOOLS.includes(toolName)
}

/** Фазовый срез схем: то, что реально уходит в запрос и в dispatch-guard. */
export function filterSchemasForPhase<T extends { function: { name: string } }>(
  schemas: T[],
  phase: OrchestrationPhase,
): T[] {
  if (phase === 'executing') return schemas
  return schemas.filter(schema => isToolAllowedInPhase(phase, schema.function.name))
}

/**
 * Модель фазы. null — только для reviewing без ревьюера: такой ран не входит
 * в фазу ревью вообще (см. advanceAfterPhaseAnswer), потому что «модель по
 * умолчанию» была бы неявным fallback'ом.
 */
export function phaseModel(
  run: OrchestrationRun,
  phase: OrchestrationPhase,
): OrchestrationModel | null {
  switch (phase) {
    case 'planning':
    case 'replanning':
      return run.planner
    case 'executing':
      return run.executor
    case 'reviewing':
      return run.reviewer ?? null
  }
}

/** Одно событие прогресса фазы. */
export function makeProgress(
  phase: OrchestrationPhase,
  model: OrchestrationModel,
  status: OrchestrationProgress['status'],
  opts: { detail?: string; startedAt?: number; at?: number; plan?: string } = {},
): OrchestrationProgress {
  const at = opts.at ?? Date.now()
  return {
    phase,
    model,
    startedAt: opts.startedAt ?? at,
    updatedAt: at,
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(opts.plan ? { plan: opts.plan } : {}),
    status,
  }
}

/**
 * Кросс-провайдерная чистота истории.
 *
 * thinking_blocks (Anthropic, подписанные) и reasoning_content ([OI]-совместимые
 * GLM/DeepSeek/Qwen) — артефакты КОНКРЕТНОЙ модели. При смене фазовой модели
 * их нельзя переотправлять: Anthropic проверяет signature, часть [OI]-прокси
 * отвергает чужой reasoning_content. Перед сменой провайдера/модели снимаем
 * их с истории (tool_calls/tool_call_id остаются — это структура раунда).
 *
 * Возвращает число изменённых сообщений (0 = история уже портативна).
 */
export function portableizeMessages<
  T extends { thinking_blocks?: unknown; reasoning_content?: string },
>(messages: T[]): number {
  let changed = 0
  for (const message of messages) {
    let touched = false
    if (message.thinking_blocks !== undefined) {
      delete message.thinking_blocks
      touched = true
    }
    if (message.reasoning_content !== undefined) {
      delete message.reasoning_content
      touched = true
    }
    if (touched) changed++
  }
  return changed
}

/** Модель и провайдер совпадают — историю можно переиспользовать как есть. */
export function sameModel(a: OrchestrationModel | null, b: OrchestrationModel | null): boolean {
  if (!a || !b) return a === b
  return a.providerId === b.providerId && a.modelId === b.modelId
}

export type OrchestrationReviewVerdict = 'approve' | 'revise' | 'replan' | 'unknown'

/**
 * Вердикт ревьюера.
 *
 * Только явный завершённый вердикт считается проверкой. Пропущенный или
 * обрезанный тег запускает ограниченный переспрос, а не одобрение.
 */
export function parseReviewVerdict(text: string): { verdict: OrchestrationReviewVerdict; feedback: string } {
  const match = /<review\s+verdict\s*=\s*(["'])(approve|revise|replan)\1\s*>[\s\S]*?<\/review\s*>/i.exec(text)
  const verdict: OrchestrationReviewVerdict = match
    ? (match[2].toLowerCase() as OrchestrationReviewVerdict)
    : 'unknown'
  const feedback = text.replace(/<\/?review\b[^>]*>/gi, '').trim()
  return { verdict, feedback }
}

/** Служебные теги фаз не должны попадать в ответ пользователю. */
export function stripOrchestrationTags(text: string): string {
  return text
    .replace(/<\/?(?:answer|plan|blocker|orchestration)\b[^>]*>/gi, '')
    .trim()
}

/**
 * §direct — планировщик может ответить сам.
 *
 * Read-only вопрос («как устроено X?», «где лежит Y?») не требует исполнения:
 * гонять исполнителя с полным тулсетом по уже полученному ответу бессмысленно.
 * Планировщик помечает такой ответ `<answer/>` (или `<orchestration
 * verdict="answer">`), отсутствие маркера = план → executing (прежнее
 * поведение, безопасный дефолт).
 */
export function parsePlannerOutcome(text: string): { direct: boolean; text: string } {
  const direct = /<answer\s*\/?>/i.test(text)
    || /<orchestration\b[^>]*\bverdict\s*=\s*["']?answer\b/i.test(text)
  return { direct, text: stripOrchestrationTags(text) }
}

/** §blocker — явный блокер исполнителя (не «сделано», а «не могу»). */
export function parseExecutorBlocker(text: string): { blocked: boolean; reason: string } {
  const paired = /<blocker\b[^>]*>([\s\S]*?)<\/blocker>/i.exec(text)
  if (paired) return { blocked: true, reason: paired[1].trim() }
  if (/<blocker\b[^>]*\/>/i.test(text)) return { blocked: true, reason: '' }
  const verdict = /<orchestration\b[^>]*\bverdict\s*=\s*["']?block(?:ed)?\b[^>]*>([\s\S]*?)(?:<\/orchestration>|$)/i.exec(text)
  if (verdict) return { blocked: true, reason: verdict[1].trim() }
  return { blocked: false, reason: '' }
}

/**
 * Убрать элемент блокера ЦЕЛИКОМ (тег + текст): причина блокера и так
 * пересказана в самом сообщении исполнителя, дублировать её в ответе не нужно.
 */
export function stripBlockerElement(text: string): string {
  return text
    .replace(/<blocker\b[^>]*>[\s\S]*?<\/blocker>/gi, '')
    .replace(/<blocker\b[^>]*\/>/gi, '')
    .replace(/<orchestration\b[^>]*\bverdict\s*=\s*["']?block(?:ed)?\b[^>]*>[\s\S]*?(?:<\/orchestration>|$)/gi, '')
    .trim()
}

/** Инструкция фазы — единственное, что дописывается в messages при переходе. */
export function phaseInstruction(
  phase: OrchestrationPhase,
  model: OrchestrationModel,
  opts: { feedback?: string; resume?: OrchestrationResume } = {},
): string {
  const who = `${model.modelId} (${model.providerId})`
  switch (phase) {
    case 'planning':
      return '[orchestration] PLANNING PHASE. You are the planner, model ' + who + '.\n'
        + 'Work read-only: research with the allowed read-only tools — no edits, no commands, no code execution.\n'
        + 'If the request only needs an answer (a question about the code, docs or behaviour, no changes required), answer it fully yourself '
        + 'and end with <answer/> — your message is then delivered to the user as the final answer.\n'
        + 'Otherwise finish this turn with a concrete plan: numbered steps, files to touch, and how each step is verified. Do not implement anything yet.'
    case 'replanning':
      return '[orchestration] REPLANNING PHASE. The plan did not survive review.\n'
        + (opts.feedback ? `Feedback: ${opts.feedback}\n` : '')
        + 'Produce a corrected plan: numbered steps, files to touch, verification per step. Read-only tools only.'
    case 'executing': {
      const base = '[orchestration] EXECUTING PHASE. You are the executor, model ' + who + '.\n'
        + 'The plan above is approved. Implement it now with the full toolset, verify the work (tests/commands/diagnostics), '
        + 'then answer with the final result for the user.\n'
        + 'If you genuinely cannot complete the plan (missing access, broken prerequisites, the plan is wrong), do not pretend success: '
        + 'stop and report <blocker>what blocks you and what you already tried</blocker>.'
      const resume = opts.resume
      if (!resume) return base
      // §resume — продолжение прерванного рана. План уже утверждён, часть работы
      // сделана: заново исследовать запрос и пересобирать план нельзя, иначе
      // пользователь видит «Planning · researching the request» вместо остатка.
      const plan = resume.plan?.trim()
      const done = (resume.done ?? []).filter(Boolean).map(item => `- ${item}`).join('\n')
      return '[orchestration] CONTINUATION PHASE. You are the executor, model ' + who + '.\n'
        + 'This run was INTERRUPTED and you are resuming it — not starting over.\n'
        + 'Do NOT re-research the request and do NOT rebuild the plan: it is already approved.\n'
        + (plan ? `Approved plan:\n${plan}\n` : '')
        + (done ? `Already done:\n${done}\n` : '')
        + 'First check the actual state of the files, then continue from the first unfinished step, finish the remainder, '
        + 'verify the work (tests/commands/diagnostics) and answer with the final result.\n'
        + 'If you genuinely cannot continue, report <blocker>what blocks you and what you already tried</blocker>.'
    }
    case 'reviewing':
      return '[orchestration] REVIEWING PHASE. You are the reviewer, model ' + who + '.\n'
        + 'The executor reports the work as done. Check it against the original request and the work log: is the task actually done, '
        + 'verified, and free of regressions? Read-only tools are available if you must check something yourself.\n'
        + 'End your message with exactly one tag: <review verdict="approve">…</review>, '
        + '<review verdict="revise">what must be fixed</review>, or <review verdict="replan">why the plan is wrong</review>.'
  }
}

/** Атрибуция расходов по моделям внутри рана. */
export interface OrchestrationModelUsage {
  providerId: string
  modelId: string
  promptTokens: number
  completionTokens: number
  calls: number
}

/** Компактная сводка рана (уходит в AgentSummaryDetails). */
export interface OrchestrationRunSummary {
  replans: number
  reviewRounds: number
  revision: number
  perModel: OrchestrationModelUsage[]
  phases: OrchestrationProgress[]
}

/** Результат завершения фазы: что делать дальше в том же цикле. */
export interface OrchestrationStepResult {
  outcome: 'continue' | 'done' | 'blocked'
  events: OrchestrationProgress[]
  /** Текст, который дописывается в messages перед следующим раундом. */
  instruction?: string
  /** Финальный ответ пользователю (outcome='done'). */
  answer?: string
  /** Причина остановки (outcome='blocked'). */
  reason?: string
}

/** Состояние фазового автомата одного рана. */
export class OrchestrationRuntime {
  readonly run: OrchestrationRun
  private phaseValue: OrchestrationPhase = 'planning'
  private phaseStartedAt: number
  private replans = 0
  private reviewRounds = 0
  private revision = 0
  private verdictRetries = 0
  // 0 = «ревью ещё не было»: до первого markReviewed ничего не устарело.
  private reviewedRevision = 0
  private finalAnswer = ''
  private isBlocked = false
  private readonly usage = new Map<string, OrchestrationModelUsage>()
  private readonly events: OrchestrationProgress[] = []

  constructor(run: OrchestrationRun, now = Date.now()) {
    this.run = run
    this.phaseStartedAt = now
    // Продолжение прерванного рана: план уже утверждён — планировщик не нужен.
    // Старт сразу с исполнения, иначе он заново «исследует запрос» с нуля.
    if (run.resume) this.phaseValue = 'executing'
  }

  get phase(): OrchestrationPhase { return this.phaseValue }
  get blocked(): boolean { return this.isBlocked }
  get replanCount(): number { return this.replans }
  get reviewRoundCount(): number { return this.reviewRounds }
  get verdictRetryCount(): number { return this.verdictRetries }
  get taskRevision(): number { return this.revision }
  /** Финальный ответ исполнителя (его отдаём пользователю после approve). */
  get finalExecutorAnswer(): string { return this.finalAnswer }
  get history(): OrchestrationProgress[] { return this.events.slice() }

  /** Модель текущей фазы (null только для reviewing без ревьюера). */
  currentModel(): OrchestrationModel | null {
    return phaseModel(this.run, this.phaseValue)
  }

  /** Первое событие рана: планировщик стартовал. */
  start(detail?: string, at = Date.now()): OrchestrationProgress[] {
    const model = this.currentModel()
    if (!model) return []
    const event = makeProgress(this.phaseValue, model, 'running', { detail, startedAt: this.phaseStartedAt, at })
    this.events.push(event)
    return [event]
  }

  /**
   * Переход фазы: закрываем текущую ('done'|'blocked') и открываем новую
   * ('running'). Ровно два события на переход — UI мержит по phase.
   */
  transition(
    to: OrchestrationPhase,
    opts: { detail?: string; status?: 'done' | 'blocked'; at?: number; plan?: string } = {},
  ): OrchestrationProgress[] {
    const at = opts.at ?? Date.now()
    const events: OrchestrationProgress[] = []
    const prev = this.currentModel()
    if (prev) {
      const close = makeProgress(this.phaseValue, prev, opts.status ?? 'done', {
        detail: opts.detail,
        startedAt: this.phaseStartedAt,
        at,
        // План фиксируем на закрытии planning/replanning: из этого снапшота
        // «Продолжить» возьмёт его, чтобы не планировать заново.
        plan: this.phaseValue === 'planning' || this.phaseValue === 'replanning' ? opts.plan : undefined,
      })
      this.events.push(close)
      events.push(close)
    }
    this.phaseValue = to
    this.phaseStartedAt = at
    const next = this.currentModel()
    if (next) {
      const open = makeProgress(to, next, 'running', { detail: opts.detail, startedAt: at, at })
      this.events.push(open)
      events.push(open)
    }
    return events
  }

  /** Закрыть текущую фазу успехом, не открывая новую (финал рана). */
  finish(detail?: string, at = Date.now()): OrchestrationProgress[] {
    const model = this.currentModel()
    if (!model) return []
    const event = makeProgress(this.phaseValue, model, 'done', { detail, startedAt: this.phaseStartedAt, at })
    this.events.push(event)
    return [event]
  }

  /** Обрыв/бюджет/ошибка: текущая фаза закрывается как blocked. */
  block(detail: string, at = Date.now()): OrchestrationProgress | null {
    if (this.isBlocked) return null
    this.isBlocked = true
    const model = this.currentModel()
    if (!model) return null
    const event = makeProgress(this.phaseValue, model, 'blocked', { detail, startedAt: this.phaseStartedAt, at })
    this.events.push(event)
    return event
  }

  /** Учёт расхода конкретной модели-роли (атрибуция по фазам). */
  recordUsage(model: OrchestrationModel, promptTokens: number, completionTokens: number): void {
    const key = `${model.providerId}::${model.modelId}`
    const acc = this.usage.get(key)
      ?? { providerId: model.providerId, modelId: model.modelId, promptTokens: 0, completionTokens: 0, calls: 0 }
    acc.promptTokens += Math.max(0, Number(promptTokens) || 0)
    acc.completionTokens += Math.max(0, Number(completionTokens) || 0)
    acc.calls += 1
    this.usage.set(key, acc)
  }

  attribution(): OrchestrationModelUsage[] {
    return [...this.usage.values()].map(entry => ({ ...entry }))
  }

  /**
   * §steer — постановка задачи изменилась посреди рана. Вердикт, посчитанный
   * по прошлой ревизии, не применяется: ревью будет переспрошено.
   */
  bumpRevision(): number {
    this.revision += 1
    return this.revision
  }

  markReviewed(): void { this.reviewedRevision = this.revision }

  get reviewIsStale(): boolean { return this.reviewedRevision !== this.revision }

  canReplan(): boolean { return this.replans < MAX_ORCHESTRATION_REPLANS }
  noteReplan(): void { this.replans += 1 }
  canReview(): boolean { return this.reviewRounds < MAX_ORCHESTRATION_REVIEW_ROUNDS }
  noteReview(): void { this.reviewRounds += 1 }
  /** Переспрос ревьюера из-за нечитаемого вердикта (не круг ревью). */
  canReaskVerdict(): boolean { return this.verdictRetries < MAX_ORCHESTRATION_VERDICT_RETRIES }
  noteVerdictRetry(): void { this.verdictRetries += 1 }

  setFinalAnswer(answer: string): void { this.finalAnswer = answer }

  summary(): OrchestrationRunSummary {
    return {
      replans: this.replans,
      reviewRounds: this.reviewRounds,
      revision: this.revision,
      perModel: this.attribution(),
      phases: this.history,
    }
  }
}

/**
 * Фаза закончилась финальным ответом модели — что делать дальше.
 *
 * Без ревьюера ран закрывается ответом исполнителя: подставлять «модель по
 * умолчанию» вместо явного ревьюера запрещено (никакого неявного fallback).
 */
export function advanceAfterPhaseAnswer(
  runtime: OrchestrationRuntime,
  answer: string,
  opts: { at?: number } = {},
): OrchestrationStepResult {
  const at = opts.at ?? Date.now()
  const phase = runtime.phase

  if (phase === 'planning' || phase === 'replanning') {
    // §direct — read-only вопрос: планировщик ответил сам и пометил это
    // `<answer/>`. Отдаём ЕГО текст как финальный ответ: гонять исполнителя с
    // полным тулсетом по уже полученному ответу бессмысленно (и опасно — он
    // «начнёт делать работу» по вопросу). Только первая фаза: после replan
    // план обязан дойти до исполнения.
    const planner = parsePlannerOutcome(answer)
    if (phase === 'planning' && planner.direct && planner.text) {
      runtime.setFinalAnswer(planner.text)
      return {
        outcome: 'done',
        answer: planner.text,
        events: runtime.finish('direct answer (no execution needed)', at),
      }
    }
    const executor = phaseModel(runtime.run, 'executing')
    const events = runtime.transition('executing', {
      detail: phase === 'replanning' ? 'plan updated after review' : 'plan accepted',
      at,
      // План сохраняется в снапшоте фазы: из него «Продолжить» соберёт resume.
      plan: answer,
    })
    return {
      outcome: 'continue',
      events,
      instruction: executor ? phaseInstruction('executing', executor) : undefined,
    }
  }

  if (phase === 'executing') {
    // §blocker — исполнитель ЯВНО сказал, что не может продолжить. Это не
    // «сделано»: ран обязан вернуться к планировщику (в пределах бюджета
    // репланов), а не отдавать блокер за результат.
    const blocker = parseExecutorBlocker(answer)
    if (blocker.blocked) {
      const honestAnswer = stripBlockerElement(answer) || stripOrchestrationTags(answer) || answer
      runtime.setFinalAnswer(honestAnswer)
      const reason = (blocker.reason || 'the executor reported a blocker').slice(0, 1200)
      if (runtime.canReplan()) {
        runtime.noteReplan()
        const events = runtime.transition('replanning', {
          detail: ('executor blocked: ' + reason).slice(0, 200),
          at,
        })
        const planner = runtime.currentModel()
        return {
          outcome: 'continue',
          events,
          instruction: planner
            ? phaseInstruction('replanning', planner, { feedback: 'the executor is blocked: ' + reason })
            : undefined,
        }
      }
      // Бюджет репланов исчерпан — честный финал: отдаём блокер исполнителя,
      // но НЕ выдаём ран за одобренный (§no-false-approval).
      return {
        outcome: 'done',
        answer: honestAnswer,
        events: runtime.finish('executor blocked — replan budget exhausted (not approved)', at),
      }
    }
    runtime.setFinalAnswer(answer)
    if (!runtime.run.reviewer) {
      return { outcome: 'done', answer, events: runtime.finish('final answer (no reviewer selected)', at) }
    }
    if (!runtime.canReview()) {
      return {
        outcome: 'done',
        answer,
        events: runtime.finish('review budget exhausted — result not verified (not approved)', at),
      }
    }
    runtime.noteReview()
    const events = runtime.transition('reviewing', { detail: 'checking the result against the request', at })
    const reviewer = runtime.currentModel()
    return {
      outcome: 'continue',
      events,
      instruction: reviewer ? phaseInstruction('reviewing', reviewer) : undefined,
    }
  }

  // phase === 'reviewing'
  const { verdict, feedback } = parseReviewVerdict(answer)

  // §steer — постановка задачи изменилась, пока ревьюер думал. Вердикт по
  // прошлой ревизии не применяем: переспрашиваем ревьюера о текущем состоянии
  // (он уже видит реплику пользователя в истории).
  if (runtime.reviewIsStale) {
    runtime.markReviewed()
    return {
      outcome: 'continue',
      events: [],
      instruction: '[orchestration] REVIEW RE-ASK. The request changed while you were reviewing: your previous verdict '
        + 'was about a stale state and is discarded. Re-check the CURRENT state (the user message above) and end with exactly one tag: '
        + '<review verdict="approve">…</review>, <review verdict="revise">what must be fixed</review>, '
        + 'or <review verdict="replan">why the plan is wrong</review>.',
    }
  }

  // §no-false-approval — тег есть, но вердикт не читается (обрезан/кривой).
  // Это НЕ approve: переспрашиваем ограниченно, затем закрываем честно.
  if (verdict === 'unknown') {
    runtime.markReviewed()
    if (runtime.canReaskVerdict()) {
      runtime.noteVerdictRetry()
      return {
        outcome: 'continue',
        events: [],
        instruction: '[orchestration] REVIEW VERDICT UNREADABLE. Your message contained a <review> tag without a valid verdict. '
          + 'End your message with exactly one tag: <review verdict="approve">…</review>, '
          + '<review verdict="revise">what must be fixed</review>, or <review verdict="replan">why the plan is wrong</review>.',
      }
    }
    return {
      outcome: 'done',
      answer: runtime.finalExecutorAnswer || answer,
      events: runtime.finish('review verdict unreadable — result not verified (not approved)', at),
    }
  }

  runtime.markReviewed()
  if (verdict === 'replan' && runtime.canReplan()) {
    runtime.noteReplan()
    const events = runtime.transition('replanning', {
      detail: feedback.slice(0, 200) || 'review rejected the plan',
      at,
    })
    const planner = runtime.currentModel()
    return {
      outcome: 'continue',
      events,
      instruction: planner ? phaseInstruction('replanning', planner, { feedback: feedback.slice(0, 1200) }) : undefined,
    }
  }
  if (verdict === 'revise') {
    const events = runtime.transition('executing', {
      detail: feedback.slice(0, 200) || 'review asked for changes',
      at,
    })
    return {
      outcome: 'continue',
      events,
      instruction: '[orchestration] REVIEW FEEDBACK (revise):\n' + (feedback.slice(0, 1200) || 'the reviewer asked for changes')
        + '\n\nFix these points, verify them, then answer with the final result.',
    }
  }
  const events = runtime.finish(
    verdict === 'approve' ? 'approved' : 'replan budget exhausted — closing with the executor answer (not approved)',
    at,
  )
  return { outcome: 'done', answer: runtime.finalExecutorAnswer || answer, events }
}
