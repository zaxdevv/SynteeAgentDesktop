import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { JanitorArchiveEntry } from './janitor'

/**
 * Персистентное состояние мини-агентов per chat: конституция (закреплённые
 * ограничения юзера) и recall-архив джанитора.
 *
 * Worker (и Agent вместе с ним) живёт один запрос — без этого файла
 * конституция и архив умирают между сообщениями чата, а маркеры [recall:id]
 * в сохранённой истории БД остаются без источника. Инкогнито-чаты и
 * суб-агенты сюда не пишут (см. Agent.persistAssistantState).
 */
export interface AssistantState {
  /** Версия схемы. 2 — конституция содержит только явные правила
   *  (/rule, «запомни правило:»). Файлы без версии писались авто-экстрактором,
   *  и их пункты нельзя применять (см. loadAssistantState). */
  version?: number
  constitution?: string[]
  janitorArchive?: JanitorArchiveEntry[]
}

/** Текущая версия схемы состояния мини-агентов. */
export const ASSISTANT_STATE_VERSION = 2

/** Хвост архива: достаточно для restore недавних компакций, не свалка. */
const MAX_ARCHIVE_ENTRIES = 50

function stateFile(userDataPath: string, chatId: string): string {
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(userDataPath, 'assistants-state', `${safe}.json`)
}

export interface LoadedAssistantState extends AssistantState {
  /** Состояние пришло из старой схемы и было вычищено — вызывающий должен
   *  перезаписать файл, иначе миграция повторится на следующем старте. */
  migrated: boolean
}

/**
 * Читает состояние чата. Миграция v1 → v2: пункты конституции, накопленные
 * авто-извлечением (regex по любому тексту + LLM в main), больше НЕ
 * применяются — их нельзя отличить от явных правил, а в контекст они
 * попадали без спроса. Архив джанитора сохраняется (он не про правила).
 */
export function loadAssistantState(userDataPath: string, chatId: string): LoadedAssistantState | null {
  try {
    const p = stateFile(userDataPath, chatId)
    if (!existsSync(p)) return null
    const raw = JSON.parse(readFileSync(p, 'utf8')) as AssistantState
    if (!raw || typeof raw !== 'object') return null
    if (raw.version === ASSISTANT_STATE_VERSION) return { ...raw, migrated: false }
    return {
      version: ASSISTANT_STATE_VERSION,
      constitution: [],
      janitorArchive: raw.janitorArchive ?? [],
      migrated: true,
    }
  } catch { /* битый файл — считаем пустым состоянием */ return null }
}

export function saveAssistantState(userDataPath: string, chatId: string, state: AssistantState): void {
  try {
    mkdirSync(join(userDataPath, 'assistants-state'), { recursive: true })
    const payload = {
      version: ASSISTANT_STATE_VERSION,
      constitution: state.constitution ?? [],
      janitorArchive: (state.janitorArchive ?? []).slice(-MAX_ARCHIVE_ENTRIES),
    }
    writeFileSync(stateFile(userDataPath, chatId), JSON.stringify(payload))
  } catch { /* персист не критичен */ }
}
