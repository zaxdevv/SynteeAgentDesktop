/**
 * Авто-назначение ролей: после входа в Syntee-Gateway переносит роли с
 * дефолтных провайдеров (anthropic/openai/opencode-free/openrouter) на
 * первые подходящие модели gateway.
 *
 * Логика:
 *  - Запускается один раз после первого успешного fetch gateway-моделей.
 *  - Для каждой роли (main/fast/vision/...) ищет первую модель gateway
 *    с нужной capability и статусом ≠ 'down'.
 *  - Не трогает назначения, которые юзер уже явно поменял на другие модели
 *    (сравниваем с DEFAULT_ASSIGNMENTS из providers.ipc).
 *  - Сохраняет через models:setAssignment — юзер потом может переназначить.
 */
import type { ModelRole } from '../../../shared/types'
import {
  GATEWAY_PROVIDER_ID,
  useGatewayModelsStore,
  type GatewayModel,
} from './gatewayModels.store'

/** Дефолтные назначения (зеркало DEFAULT_ASSIGNMENTS из providers.ipc). */
const DEFAULT_ASSIGNMENTS: { role: ModelRole; modelId: string; providerId: string }[] = [
  { role: 'main',        modelId: 'claude-sonnet-4-6',                providerId: 'anthropic' },
  { role: 'fast',        modelId: 'mimo-v2.5-free',                   providerId: 'opencode-free' },
  { role: 'fastContext', modelId: 'inclusionai/ling-3.0-flash:free', providerId: 'openrouter' },
  { role: 'vision',      modelId: 'gpt-4o',                           providerId: 'openai' },
  { role: 'memory',      modelId: 'claude-haiku-4-5',                 providerId: 'anthropic' },
  { role: 'summary',     modelId: 'claude-haiku-4-5',                 providerId: 'anthropic' },
]

/** Какие capability нужны каждой роли. */
const ROLE_CAPS: Partial<Record<ModelRole, string[]>> = {
  vision: ['vision'],
  video: ['video'],
  audio: ['audio_input'],
  stt: ['stt'],
  tts: ['tts'],
}

/** Какой id модели искать для роли (если capability не задан). */
const ROLE_PREFERRED_ID: Partial<Record<ModelRole, string[]>> = {
  main: ['claude-sonnet', 'gpt-5', 'claude-opus'],
  fast: ['claude-haiku', 'gpt-5-mini', 'gemini-flash'],
  memory: ['claude-haiku', 'gpt-5-mini'],
  summary: ['claude-haiku', 'gpt-5-mini'],
}

/**
 * Применяет авто-назначения если юзер ещё на дефолтах.
 * Возвращает true если что-то поменялось.
 */
export async function autoAssignGatewayModels(): Promise<boolean> {
  const gatewayModels = useGatewayModelsStore.getState().models
  if (gatewayModels.length === 0) return false

  // Текущие назначения
  const current = await window.syntee.models.getAssignments() as { role: ModelRole; modelId: string; providerId: string }[]
  const currentMap = new Map(current.map(a => [a.role, a]))

  let changed = false
  for (const def of DEFAULT_ASSIGNMENTS) {
    const cur = currentMap.get(def.role)
    // Если текущее назначение совпадает с дефолтом (та же модель + тот же
    // провайдер) — переносим на gateway. Если юзер уже выбрал что-то своё
    // — не трогаем.
    if (!cur || cur.modelId !== def.modelId || cur.providerId !== def.providerId) {
      // Уже изменено — пропускаем.
      // Но если назначение пустое (modelId='') — попробуем заполнить.
      if (cur && cur.modelId === '' && cur.providerId === '') {
        // пустое назначение — попробуем назначить
      } else {
        continue
      }
    }

    const candidate = pickGatewayModel(gatewayModels, def.role)
    if (candidate) {
      await window.syntee.models.setAssignment({
        role: def.role,
        modelId: candidate.id,
        providerId: GATEWAY_PROVIDER_ID,
      })
      changed = true
    }
  }

  return changed
}

function pickGatewayModel(
  models: GatewayModel[],
  role: ModelRole,
): GatewayModel | null {
  const statusByModel = useGatewayModelsStore.getState().statusByModel

  // Сначала по preferred id (подстрока в id/name).
  const preferred = ROLE_PREFERRED_ID[role]
  if (preferred) {
    for (const pref of preferred) {
      const match = models.find(m =>
        (m.id.toLowerCase().includes(pref.toLowerCase()) ||
          (m.display_name ?? '').toLowerCase().includes(pref.toLowerCase())) &&
        statusByModel[m.id] !== 'down' &&
        statusByModel[m.id] !== 'unavailable',
      )
      if (match) return match
    }
  }

  // По capability.
  const caps = ROLE_CAPS[role]
  if (caps) {
    const match = models.find(m => {
      const mCaps: string[] = []
      if (m.supports_vision) mCaps.push('vision')
      if (m.supports_tools) mCaps.push('tools')
      // Gateway contract currently exposes vision/tools flags only; media roles
      // are deliberately not inferred from absent transport metadata.
      return caps.every(c => mCaps.includes(c)) &&
        statusByModel[m.id] !== 'down' &&
        statusByModel[m.id] !== 'unavailable'
    })
    if (match) return match
  }

  // Fallback — первая не-down модель.
  return models.find(m =>
    statusByModel[m.id] !== 'down' &&
    statusByModel[m.id] !== 'unavailable',
  ) ?? null
}

/**
 * Флаг чтобы авто-назначение сработало один раз за сессию (не при каждом
 * polling-обновлении моделей). Сбрасывается при logout.
 */
let autoAssignDone = false

export function resetAutoAssignFlag(): void {
  autoAssignDone = false
}

export function isAutoAssignDone(): boolean {
  return autoAssignDone
}

export function markAutoAssignDone(): void {
  autoAssignDone = true
}
