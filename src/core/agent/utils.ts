import { estimateTokens, TOOL_SCHEMAS_OVERHEAD } from '../context/contextManager'
import { log } from '../logger'
import type { AgentMessage, AgentToolCallFingerprint, ToolRound } from './types'

export const FALLBACK_SYSTEM_PROMPT = 'You are a capable coding agent. Follow the provided system prompt and use tools when needed.'

// Число успешных file-edit тулов между авто-верификациями (упрощённый
// аналог PostToolUse-хука Claude Code) — фиксированное значение для MVP,
// можно вынести в AgentSettings позже если понадобится настройка в UI.
export const VERIFICATION_INTERVAL = 3

export function normalizeToolName(name: string, schemas: Array<{ function: { name: string } }>): string {
  const knownNames = schemas.map(s => s.function.name)
  if (knownNames.includes(name)) return name

  const parts = name.split('_')
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join('_')
    if (knownNames.includes(candidate)) return candidate
  }

  for (let i = parts.length - 1; i > 0; i--) {
    const candidate = parts.slice(0, i).join('_')
    if (knownNames.includes(candidate)) return candidate
  }

  for (const known of knownNames) {
    if (name.includes(known)) return known
  }

  return name
}

// Универсальная проверка обязательных аргументов по TOOL_SCHEMAS.required —
// одна проверка для всех тулов сразу, вместо точечных if-ов в executeTool.
// Ловит случаи когда модель не передала обязательное поле или JSON.parse
// аргументов тихо упал (args = {}) — раньше это доходило до низкоуровневых
// ошибок вида `The "paths[1]" argument must be of type string. Received
// undefined` внутри path.resolve(), непонятных и для модели, и для пользователя.
export function findMissingRequiredArgs(
  name: string,
  args: Record<string, unknown>,
  schemas: Array<{ function: { name: string; parameters?: { required?: string[] } } }>,
): string[] {
  const schema = schemas.find(s => s.function.name === name)
  const required = schema?.function.parameters?.required
  if (!required?.length) return []
  return required.filter(key => args[key] === undefined || args[key] === null || args[key] === '')
}

export function getToolErrorHint(toolName: string, error: string): string {
  const e = error.toLowerCase()
  if ((toolName === 'edit_file' || toolName === 'multi_edit_file') && (e.includes('not found') || e.includes('old_str'))) {
    return '\n\n[Hint: refresh the file with read_file before retrying edit_file.]'
  }
  if ((toolName === 'read_file' || toolName === 'write_file') && (e.includes('no such file') || e.includes('enoent') || e.includes('not found'))) {
    return '\n\n[Hint: locate the exact path with find_files first.]'
  }
  if (toolName === 'run_command') {
    if (e.includes('not recognized') || e.includes('command not found')) {
      return '\n\n[Hint: verify the command exists or use an installed alternative.]'
    }
    if (e.includes('permission') || e.includes('access denied')) {
      return '\n\n[Hint: the command likely needs different permissions or a safer target path.]'
    }
  }
  if (toolName === 'search_code' && (e.includes('rg') || e.includes('ripgrep') || e.includes('not found'))) {
    return '\n\n[Hint: ripgrep unavailable — автоматически задействован PowerShell-фолбэк. Если поиск пуст, проверь path и pattern, либо используй literal=true для дословного поиска.]'
  }
  if (toolName === 'http_request' && e.includes('timed out')) {
    return '\n\n[Hint: increase the timeout parameter or try a different endpoint.]'
  }
  if (toolName === 'find_files' && e.includes('not found') && e.includes('pattern')) {
    return '\n\n[Hint: use a simpler glob pattern like *.ts or a partial filename.]'
  }
  return ''
}

export function isSequentialTool(name: string): boolean {
  return name === 'write_file' ||
    name === 'edit_file' ||
    name === 'multi_edit_file' ||
    name === 'run_command'
}

export function stableStringify(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }
  return String(value)
}

export function buildToolFingerprint(toolName: string, args: Record<string, unknown>): AgentToolCallFingerprint {
  const normalizedArgs: Record<string, unknown> = { ...args }
  for (const key of ['content', 'old_str', 'new_str']) {
    if (typeof normalizedArgs[key] === 'string' && normalizedArgs[key].length > 160) {
      normalizedArgs[key] = `${normalizedArgs[key].slice(0, 160)}...`
    }
  }
  // Для search_code нормализуем `pattern` так, чтобы косметические вариации
  // (foo / Foo / foo( / " foo " / foo$) давали ОДИНАКОВЫЙ fingerprint — иначе
  // loop-guard на N повторов не срабатывает и модель десятками шагов перебирает
  // паттерны в надежде найти то же самое. Семантически они идентичны.
  // ignore_case / literal флаги не учитываем — они не меняют対象 поиска.
  if (toolName === 'search_code' && typeof normalizedArgs.pattern === 'string') {
    normalizedArgs.pattern = (normalizedArgs.pattern as string)
      .toLowerCase()
      .replace(/[\s\t\r\n]+/g, '')
      .replace(/[(){}[\].,*+?^$|\\/-]/g, '')
    normalizedArgs.ignore_case = undefined
    normalizedArgs.literal = undefined
    if (typeof normalizedArgs.pattern === 'string' && normalizedArgs.pattern.length > 120) {
      normalizedArgs.pattern = (normalizedArgs.pattern as string).slice(0, 120)
    }
  }
  return {
    toolName,
    argsKey: stableStringify(normalizedArgs),
  }
}

export function getToolRounds(messages: AgentMessage[]): ToolRound[] {
  const rounds: ToolRound[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as AgentMessage & { tool_calls?: Array<{ function?: { name?: string } }> }
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue
    const toolIndices: number[] = []
    let j = i + 1
    while (j < messages.length && messages[j].role === 'tool') {
      toolIndices.push(j)
      j++
    }
    rounds.push({
      assistantIndex: i,
      toolIndices,
      toolNames: msg.tool_calls.map((tc: { function?: { name?: string } }) => tc.function?.name || 'tool'),
    })
  }
  return rounds
}

/**
 * Аварийный клапан: если токены сообщений реально подбираются к лимиту модели
 * (hardLimitTokens, см. getHardLimitTokens) — физически удаляем самые старые
 * целые tool-раунды (assistant+tool сообщения целиком), без замены на
 * текст-резюме. Это защита от hard-fail API, а не проактивное сжатие:
 * срабатывает исключительно на грани реального предела.
 *
 * Гистерезис: при срабатывании дропаем НЕ до hardLimitTokens, а до
 * targetTokens (значительно ниже) — иначе следующий же раунд тулов сразу
 * снова превышает hardLimitTokens и клапан триггерится повторно на каждом
 * шаге, давая пилообразный (то много, то мало) реальный prompt_tokens вместо
 * плавного роста. targetTokens задаёт запас, в который новые раунды могут
 * расти, прежде чем клапан сработает снова.
 */
export function dropOldestRoundsIfOverflow(
  messages: AgentMessage[],
  hardLimitTokens: number,
  targetTokens: number,
): AgentMessage[] {
  const estimated = messages.reduce((sum, msg) => sum + estimateTokens(msg.content || '') + 4, TOOL_SCHEMAS_OVERHEAD)
  if (estimated <= hardLimitTokens) return messages

  const rounds = getToolRounds(messages)
  if (rounds.length === 0) return messages

  // Удаляем раунды с начала (самые старые), пока не уложимся в targetTokens
  // (не hardLimitTokens — см. комментарий выше про гистерезис).
  // Сохраняем system-сообщения и последнее user-сообщение.
  const removeIndices = new Set<number>()
  let currentEstimate = estimated
  for (const round of rounds) {
    if (currentEstimate <= targetTokens) break
    removeIndices.add(round.assistantIndex)
    for (const toolIndex of round.toolIndices) removeIndices.add(toolIndex)
    for (const idx of [round.assistantIndex, ...round.toolIndices]) {
      currentEstimate -= estimateTokens(messages[idx].content || '') + 4
    }
  }

  if (removeIndices.size === 0) return messages

  const result = messages.filter((_, index) => !removeIndices.has(index))
  // Вставляем короткую метку чтобы модель знала что старые раунды были удалены
  const firstNonSystem = result.findIndex(msg => msg.role !== 'system')
  const insertAt = firstNonSystem === -1 ? result.length : firstNonSystem
  result.splice(insertAt, 0, {
    role: 'system',
    content: `[Старые tool-раунды удалены для экономии контекста — ${removeIndices.size} сообщений]`,
  })
  log('[Agent] dropOldestRoundsIfOverflow сработал: estimated=%s hardLimitTokens=%s targetTokens=%s removedMessages=%s остаток~=%s',
    estimated, hardLimitTokens, targetTokens, removeIndices.size, currentEstimate)
  return result
}

/**
 * Извлекает имя MCP-сервера из полного имени тула `mcp__server__tool`.
 * Возвращает undefined для встроенных тулов. Sanitized-имя сервера может
 * содержать подчёркивания, поэтому берём всё между первым и последним `__`.
 */
export function extractMcpServerName(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined
  const rest = toolName.slice(5) // убираем 'mcp__'
  const firstSep = rest.indexOf('__')
  if (firstSep === -1) return undefined
  const lastSep = rest.lastIndexOf('__')
  if (lastSep === firstSep) {
    // Только один `__` — сервер до него, тул после
    return rest.slice(0, firstSep)
  }
  // Несколько `__` — сервер между первым и последним, но имя сервера
  // это всё до последнего `__` (т.к. тул — последний сегмент)
  return rest.slice(0, lastSep)
}
