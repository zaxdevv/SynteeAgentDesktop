import type { Message, ToolStep } from '../../shared/types'
import { JANITOR_MARKER } from '../../shared/assistants'
import { estimateTokensCalibrated } from '../tokens/usageTracker'
import {
  parseReadSections, hasIdenticalReadCoverage, normalizePath, stableStringify,
  PINNED_TOOLS, FILE_MUTATORS, UNKNOWN_MUTATORS, READ_TOOLS,
  STALE_MIN_SAVED, MIN_STUB_CHARS,
  type ParsedReadSection,
} from './janitor'

/**
 * Персистентная компрессия истории (вариант B): детерминированное сжатие
 * tool-результатов ПРЯМО В БД на конце рана. Джанитор рана сжимает контекст
 * только в памяти — каждый новый запрос разворачивает сырые toolSteps из БД
 * заново (кольцо контекста осциллирует 130k → 280k). Здесь те же правила
 * применяются к сохранённым записям, и сжатие становится постоянным.
 *
 * Принципы точности:
 *  - Заменяется ТОЛЬКО content у tool_result (call+result пары сохраняются) —
 *    структура итераций остаётся валидной для провайдера, кэш UI не ломается.
 *  - Активный хвост = последние tailKeep ходов (assistant-сообщений с тулами)
 *    не трогаем; всё старее — сжимаем.
 *  - Перечитывания сворачиваются, если более поздние чтения содержат те же строки.
 *  - Дедуп идентичных вызовов валиден, только если между ними не было мутаций.
 *  - Степы с визуалом (imagePaths/imageUrl), diff'ами, ошибками и pinned-тулы
 *    никогда не сжимаются. Анализ (покрытие/сталость) учитывает и хвостовые
 *    ходы — заменяется только история за хвостом.
 *  - Уникальные tool outputs остаются в БД. Их in-run резюме восстанавливает
 *    recall-архив при старте следующего worker; безвозвратно удаляются только
 *    точные дубли и чтения, для которых все файлы перекрыты/устарели.
 */

export interface CompressOptions {
  /** Порог экономии для UPDATE строки сообщения (janitorMinSavingsTokens). */
  minSavingsTokens: number
  /** Сколько последних ходов (assistant-сообщений с тулами) не трогать. */
  tailKeep: number
  /**
   * Пара provider:model для калибровки. «Сэкономлено токенов» считается в той
   * же шкале, что и кольцо контекста (usageTracker) — иначе рядом стоят два
   * разных числа про одно и то же сжатие.
   */
  calibrationKey?: string
}

export interface CompressionPlan {
  messageId: string
  savedTokens: number
  actions: string[]
  /** Обновлённый toolSteps (заменены content у свёрнутых результатов). */
  toolSteps: ToolStep[]
  /** Обновлённая копия iterations (UI рендерит именно её). */
  iterations?: Message['iterations']
}

/** Замена: контент уже сжат локальным помощником — не обрабатываем повторно. */
function alreadyCompressed(content: string): boolean {
  return content.includes(JANITOR_MARKER)
}

/** Признаки результата, который сжимать нельзя (потеря данных для UI/агента). */
function isProtected(result: ToolStep): boolean {
  if (result.success === false) return true
  if (result.imagePaths?.length || result.imageUrl) return true
  if (result.diff) return true
  if (result.visualAnalysis) return true
  return false
}

interface StepPair {
  msg: Message
  call: ToolStep
  result: ToolStep
  /** Глобальный хронологический номер пары (по всем ходам, включая хвост). */
  seq: number
  round: number
}

/** Собирает валидные пары call→result из toolSteps сообщения (по callId). */
function collectPairs(m: Message): StepPair[] {
  const steps = m.toolSteps ?? []
  const resultByCall = new Map<string, ToolStep>()
  for (const s of steps) {
    if (s.type === 'tool_result' && s.callId) resultByCall.set(s.callId, s)
  }
  const pairs: StepPair[] = []
  const roundByCall = new Map<string, number>()
  let round = 0
  let sawResult = false
  for (const s of steps) {
    if (s.type === 'tool_call' && s.callId) {
      if (sawResult) { round++; sawResult = false }
      roundByCall.set(s.callId, round)
    } else if (s.type === 'tool_result') sawResult = true
  }
  // Saved iterations retain the exact parallel call batches.
  m.iterations?.forEach((iteration, index) => {
    for (const s of iteration.steps ?? []) {
      if (s.type === 'tool_call' && s.callId) roundByCall.set(s.callId, index)
    }
  })
  for (const s of steps) {
    if (s.type !== 'tool_call' || !s.callId) continue
    const result = resultByCall.get(s.callId)
    if (result) pairs.push({ msg: m, call: s, result, seq: 0, round: roundByCall.get(s.callId) ?? 0 })
  }
  return pairs
}

/**
 * Сжимает сохранённую историю чата. Возвращает планы только для сообщений,
 * чья суммарная экономия ≥ minSavingsTokens (иначе UPDATE не окупается).
 */
export function compressStoredMessages(messages: Message[], opts: CompressOptions): Map<string, CompressionPlan> {
  const plans = new Map<string, CompressionPlan>()
  const stepMessages = messages.filter(m => m.role === 'assistant' && (m.toolSteps?.length ?? 0) > 0)

  // Анализ — по всем ходам (чтения/правки в хвосте тоже перекрывают и
  // устаревают старую историю), замены — только для кандидатов.
  let roundCount = 0
  const allPairs = stepMessages.flatMap(message => {
    const pairs = collectPairs(message)
    const count = pairs.length ? Math.max(...pairs.map(pair => pair.round)) + 1 : 0
    for (const pair of pairs) pair.round += roundCount
    roundCount += count
    return pairs
  })
  allPairs.forEach((p, seq) => { p.seq = seq })
  if (allPairs.length === 0) return plans
  const boundary = roundCount - Math.max(1, opts.tailKeep)
  const candidatePairs = new Set(allPairs.filter(pair => pair.round < boundary))
  const candidates = stepMessages.filter(message => allPairs.some(pair => pair.msg === message && candidatePairs.has(pair)))
  const editable = (pair: StepPair): boolean => candidatePairs.has(pair)
    && !alreadyCompressed(pair.result.content) && !isProtected(pair.result)
    && !PINNED_TOOLS.has(pair.call.toolName ?? '')

  // Мутации: явные правки по путям + недетерминированные тулы.
  const editsByPath = new Map<string, number[]>()
  const unknownMutSeqs: number[] = []
  for (const p of allPairs) {
    const name = p.call.toolName ?? ''
    if (FILE_MUTATORS.has(name)) {
      const path = normalizePath(String((p.call.toolArgs as { path?: unknown } | undefined)?.path ?? ''))
      if (path) {
        const arr = editsByPath.get(path)
        if (arr) arr.push(p.seq)
        else editsByPath.set(path, [p.seq])
      }
    } else if (UNKNOWN_MUTATORS.has(name)) {
      unknownMutSeqs.push(p.seq)
    }
  }
  const unknownBetween = (a: number, b: number): boolean => unknownMutSeqs.some(s => s > a && s < b)
  const anyEditBetween = (a: number, b: number): boolean => {
    for (const arr of editsByPath.values()) {
      if (arr.some(s => s > a && s < b)) return true
    }
    return false
  }

  // Замены: result-степ → финальный контент (с маркером).
  const replace = new Map<ToolStep, string>()
  const kindOf = new Map<ToolStep, 'dedup' | 'reread' | 'stale'>()
  const put = (p: StepPair, text: string, kind: 'dedup' | 'reread' | 'stale'): void => {
    if (replace.has(p.result) || !editable(p)) return
    const finalText = `${JANITOR_MARKER} ${text}`
    const saved = estimateTokensCalibrated(p.result.content ?? '', opts.calibrationKey)
      - estimateTokensCalibrated(finalText, opts.calibrationKey)
    if (saved < STALE_MIN_SAVED) return
    replace.set(p.result, finalText)
    kindOf.set(p.result, kind)
  }

  // 1) Дедуп: тот же тул с теми же аргументами (не чтения/мутаторы/pinned).
  //    Свёртка валидна, только если между повторами не было мутаций — иначе
  //    результаты могли различаться и «идентичен» было бы ложью. Группа — по
  //    всем ходам (эталон может быть в хвосте), замена — только у кандидатов.
  const byFingerprint = new Map<string, StepPair[]>()
  for (const p of allPairs) {
    const name = p.call.toolName ?? ''
    if (alreadyCompressed(p.result.content) || isProtected(p.result)) continue
    if (!name || READ_TOOLS.has(name) || FILE_MUTATORS.has(name) || UNKNOWN_MUTATORS.has(name) || PINNED_TOOLS.has(name)) continue
    const key = `${name}|${stableStringify(p.call.toolArgs ?? {})}`
    const arr = byFingerprint.get(key)
    if (arr) arr.push(p)
    else byFingerprint.set(key, [p])
  }
  for (const arr of byFingerprint.values()) {
    arr.sort((a, b) => a.seq - b.seq)
    for (let k = 0; k < arr.length - 1; k++) {
      const a = arr[k]
      if (!editable(a)) continue
      const content = a.result.content ?? ''
      if (content.length < MIN_STUB_CHARS) continue
      if (anyEditBetween(a.seq, arr[k + 1].seq) || unknownBetween(a.seq, arr[k + 1].seq)) continue
      if (content !== arr[k + 1].result.content) continue
      put(a, `Повтор ${a.call.toolName ?? 'tool'}: тот же результат сохранён ниже.`, 'dedup')
    }
  }

  // 2) Перечитывания: диапазонная логика по parsed-секциям.
  interface ReadOcc { pair: StepPair; sections: ParsedReadSection[] }
  const readOccs: ReadOcc[] = []
  for (const p of allPairs) {
    const name = p.call.toolName ?? ''
    if (!READ_TOOLS.has(name)) continue
    if (alreadyCompressed(p.result.content) || isProtected(p.result)) continue
    readOccs.push({ pair: p, sections: parseReadSections(name, p.result.content ?? '') })
  }
  readOccs.sort((a, b) => a.pair.seq - b.pair.seq)
  for (let k = 0; k < readOccs.length; k++) {
    const occ = readOccs[k]
    if (!editable(occ.pair)) continue
    const later = readOccs.slice(k + 1).flatMap(entry => entry.sections)
    if (!occ.sections.length || !occ.sections.every(section => hasIdenticalReadCoverage(section, later))) continue

    const files = occ.sections.map(section => section.displayPath).join(', ')
    put(occ.pair, `Результат чтения свёрнут: ${files}. Те же строки сохранены в более поздних чтениях.`, 'reread')
  }

  // Unique tool outputs stay in the DB. In-run summaries are reapplied from
  // the bounded recall archive; deleting the raw DB copy would make them
  // irrecoverable after an archive failure or a restart.

  if (replace.size === 0) return plans

  // 4) Группируем по сообщениям, применяем к toolSteps и iterations.
  for (const m of candidates) {
    const steps = m.toolSteps ?? []
    const msgReplacements = steps.filter(s => replace.has(s))
    if (msgReplacements.length === 0) continue
    const savedTokens = msgReplacements.reduce(
      (sum, s) => sum + Math.max(0, estimateTokensCalibrated(s.content ?? '', opts.calibrationKey)
        - estimateTokensCalibrated(replace.get(s)!, opts.calibrationKey)),
      0,
    )
    if (savedTokens < opts.minSavingsTokens) continue

    const newSteps: ToolStep[] = steps.map(s => replace.has(s) ? { ...s, content: replace.get(s)! } : s)

    // Копия iterations (UI рендерит именно её): match по callId.
    const repByCallId = new Map<string, string>()
    for (const s of msgReplacements) if (s.callId) repByCallId.set(s.callId, replace.get(s)!)
    let iterations = m.iterations
    if (iterations?.length) {
      iterations = iterations.map(it => ({
        ...it,
        steps: (it.steps ?? []).map(s => {
          const rep = s.callId ? repByCallId.get(s.callId) : undefined
          return rep && s.type === 'tool_result' ? { ...s, content: rep } : s
        }),
      }))
    }

    const counts: Record<string, number> = {}
    for (const s of msgReplacements) {
      const label = kindOf.get(s) === 'dedup' ? 'дедуп' : kindOf.get(s) === 'reread' ? 'перечитывания' : kindOf.get(s) === 'stale' ? 'резюме старья' : 'прочее'
      counts[label] = (counts[label] ?? 0) + 1
    }
    const actions = Object.entries(counts).map(([label, n]) => `${label} ×${n}`)

    plans.set(m.id, { messageId: m.id, savedTokens, actions, toolSteps: newSteps, iterations })
  }

  return plans
}
