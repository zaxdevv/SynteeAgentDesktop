/**
 * Кэш моделей Syntee-Gateway — единственный экземпляр на процесс.
 *
 * Живёт в core/tokens (а не в main/ipc), чтобы core-модули без electron-
 * зависимостей могли читать данные gateway-моделей:
 *  - contextManager.getModelContextWindow() — contextWindow для счётчика
 *    контекста и порогов компакции;
 *  - usageTracker.getModelPriceInfo() — цены для подсчёта стоимости сессии.
 *
 * Gateway — первоисточник для провайдера 'syntee-gateway': каталог models.dev
 * его не знает и через vendor-sniff + substring-матчинг подменяет модель
 * похожей (glm-5.3 → zai:glm-5 с 204.8k вместо 1M от gateway).
 *
 * Наполняется gateway.ipc.ts (gateway:fetchModels) в main-процессе.
 * Worker-потоки получают снапшот через workerData и вызывают
 * setGatewayModelsCache на старте (см. ai-worker.ts) — gateway:fetchModels
 * в worker_threads недоступен.
 */

import type { ModelMeta } from '../../shared/types'

/** providerId виртуального провайдера Syntee-Gateway. */
export const GATEWAY_PROVIDER_ID = 'syntee-gateway'

let gatewayModelsCache: ModelMeta[] = []

export function setGatewayModelsCache(models: ModelMeta[]): void {
  gatewayModelsCache = models
}

export function getGatewayModelsCache(): ModelMeta[] {
  // Кэш не протухает по таймеру — однажды загруженные модели держатся до
  // logout/рестарта. Раньше здесь был 5-минутный TTL, который молча обнулял
  // список; т.к. в BUILTIN_MODELS нет записей 'syntee-gateway', группа
  // исчезала из дропдауна без ошибки и не восстанавливалась (renderer-стор
  // хранит свой непустой список и не триггерил retry). Stale-защита при
  // транзиентном сбое /v1/models уже есть в gateway.ipc.ts (возвращаем
  // последний raw-кэш + error) и в gatewayModels.store.ts (не затираем
  // непустой список при ошибке) — TTL тут дублировал её с побочным эффектом.
  return gatewayModelsCache
}
