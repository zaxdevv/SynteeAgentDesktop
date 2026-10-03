// ── Vision capability detection ─────────────────────────────────────────
// Вынесено из chat.ipc.ts (modelSupportsVisionByHeuristic) в общий модуль:
// используется и в attachment-flow (chat.ipc.ts processAttachmentsAndStream),
// и в тулe analyze_image (core/tools/image.ts) — решение «основная модель
// видит картинку сама / нужна вспомогательная vision-модель» всегда
// принимается одинаково, в одном месте.
import type Store from 'electron-store'
import { getCatalogModel, isCatalogReady } from '../tokens/modelCatalog'

/**
 * Эвристика vision-способности модели.
 *
 * Провайдер НЕ проверяем (провайдер ≠ модель — gateway/OpenAI/Anthropic
 * могут обслуживать и vision, и text-only модели). Только по имени модели
 * + каталог models.dev как fallback.
 */
export function modelSupportsVisionByHeuristic(providerId: string, modelId: string): boolean {
  const id = modelId.toLowerCase()
  // Известные vision-модели по имени (БЕЗ провайдера — провайдер не определяет vision)
  if (id.includes('gpt-4o') || id.includes('gpt-4-turbo') || id.includes('gpt-4-vision')) return true
  if (id.includes('claude-3') || id.includes('claude-sonnet') || id.includes('claude-opus') || id.includes('claude-haiku')) return true
  if (id.includes('gemini') && !id.includes('gemini-1.0-pro') && !id.includes('gemini-1.5-pro-text')) return true
  if (id.includes('grok-2') || id.includes('grok-3') || id.includes('grok-4')) return true
  // Qwen VL — vision variant (qwen-vl, qwen2-vl, qwen2.5-vl)
  if (id.includes('qwen') && id.includes('vl')) return true
  // Llama vision variant
  if (id.includes('llama') && id.includes('vision')) return true
  // GLM: только -V варианты (glm-4v, glm-4.5v). glm-4, glm-5, glm-5.2 — text-only!
  if (id.includes('glm') && (id.includes('-v') || id.includes('4v') || id.includes('vision'))) return true
  // Fallback: проверяем каталог если он есть
  if (isCatalogReady()) {
    const info = getCatalogModel(providerId, modelId)
    if (info?.capabilities?.includes('vision')) return true
  }
  return false
}

/**
 * Поддерживает ли ОСНОВНАЯ модель (role: 'main') vision.
 *  true  → картинки можно передавать напрямую (multipart, без посредников).
 *  false → нужен анализ через вспомогательную vision-модель (role: 'vision').
 */
export function mainModelSupportsVision(store: Store): boolean {
  return agentModelSupportsVision(store, 'main')
}

/** Matches AIClient's effective agent role, including legacy model settings. */
export function agentModelSupportsVision(store: Store, role: 'main' | 'subagent'): boolean {
  const assignments = store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
  const modelForRole = (r: string): string => assignments?.find(a => a.role === r)?.modelId
    || (store.get(`${r}Model`) as string) || (r === 'main' ? 'claude-sonnet-4-6' : '')
  const effectiveRole = role === 'subagent' && modelForRole('subagent') ? 'subagent' : 'main'
  const assignment = assignments?.find(a => a.role === effectiveRole)
  return modelSupportsVisionByHeuristic(assignment?.providerId ?? '', modelForRole(effectiveRole))
}
