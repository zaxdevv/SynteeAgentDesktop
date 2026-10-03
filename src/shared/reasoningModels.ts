/**
 * Reasoning-конфигурации моделей — данные из каталога models.dev.
 *
 * models.dev отдаёт для каждой reasoning-модели поле reasoning_options —
 * реальные контролы её API:
 *   [{ type: "effort", values: ["low","medium","high","max"] }]   — gpt-5*, claude 4.6+/5, relays
 *   [{ type: "toggle" }, { type: "budget_tokens", min: 1024 }]    — deepseek/qwen/glm, claude 4.5-
 *   []  — модель размышляет всегда, управлять нельзя (deepseek-r1 и т.п.)
 *
 * Это единственный источник уровней для не-gateway моделей. Раньше здесь
 * лежала статическая таблица с hardcoded-уровнями — она протухала (нет
 * gpt-5*, glm-5*, актуальных claude) и всем моделям выдавала одинаковый
 * набор off/low/medium/high. Теперь уровни берутся per-model из каталога.
 *
 * Для моделей Syntee-Gateway авторитетен /v1/models (meta.reasoning.supported
 * + levels) — gateway сам транслирует reasoning_effort в native-формат.
 *
 * Спецификация: https://models.dev (AGENTS.md → Reasoning options).
 */

import type { ReasoningOptionSpec } from './types/provider'

export type ReasoningParamType =
  | 'reasoning_effort'   // OpenAI-совместимый reasoning_effort (gpt-5/o-series, claude 4.6+, relays, gateway)
  | 'toggle'             // thinking: {type: enabled|disabled} (deepseek/glm/qwen thinking-режим)
  | 'thinking_budget'    // thinking: {type: enabled, budget_tokens: N} (claude 4.5-, gemini)
  | 'always_on'          // reasoning_content всегда есть, управлять нельзя

export interface ReasoningOption {
  /** Отображается в UI */
  label: string
  /** Реальное значение для API */
  value: string
}

export interface ModelReasoningConfig {
  paramType: ReasoningParamType
  /** Название параметра в API запроса */
  apiParam: string
  options: ReasoningOption[]
  default: string
  /** Подсказка в UI */
  hint: string
  /** Для effort-моделей: значение API, явно выключающее мышление ('none').
   *  Если задано — «off» шлётся как reasoning_effort='none' (иначе параметр
   *  не шлём вовсе и модель думает со своим дефолтом). */
  offValue?: string
}

// ── Бюджетные пресеты для budget_tokens-моделей ─────────────────────────────

function budgetOptions(min?: number, max?: number): ReasoningOption[] {
  // API-минимум Anthropic — 1024; каталог может отдать свой min/max.
  const lo = Math.max(min ?? 1024, 1024)
  const presets = [1024, 4096, 10000, 24000, 64000]
    .filter(n => n >= lo && (max == null || n <= max))
  const list = presets.length > 0 ? presets : [lo]
  // Короткие лейблы для компактных чипов: 1024 → 1k, 24000 → 24k
  const fmt = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
  return [
    { label: 'off', value: '' },
    ...list.map(n => ({ label: fmt(n), value: String(n) })),
  ]
}

// ── Публичные функции ────────────────────────────────────────────────────────

/**
 * Строит конфиг reasoning из спек каталога models.dev.
 *
 * undefined → null (данных нет, селектор не показываем).
 * []        → always_on-бейдж (думает всегда, контроля нет).
 * Приоритет контролов: effort > toggle > budget_tokens (если модель
 * поддерживает несколько — effort даёт самую богатую градацию).
 */
export function configFromSpecs(specs: ReasoningOptionSpec[] | undefined): ModelReasoningConfig | null {
  if (!specs) return null
  if (specs.length === 0) {
    return {
      paramType: 'always_on',
      apiParam: '',
      options: [{ label: 'Всегда включено', value: 'on' }],
      default: 'on',
      hint: 'Модель размышляет всегда (models.dev)',
    }
  }

  const effort = specs.find(s => s.type === 'effort' && s.values && s.values.length > 0)
  if (effort?.values) {
    const values = effort.values.filter(v => v !== 'none')
    return {
      paramType: 'reasoning_effort',
      apiParam: 'reasoning_effort',
      options: [
        { label: 'off', value: '' },
        ...values.map(v => ({ label: v, value: v })),
      ],
      default: '',
      // 'none' в values — явное выключение мышления через API
      offValue: effort.values.includes('none') ? 'none' : undefined,
      hint: 'Уровень мышления (models.dev)',
    }
  }

  if (specs.some(s => s.type === 'toggle')) {
    return {
      paramType: 'toggle',
      apiParam: 'thinking',
      options: [
        { label: 'off', value: '' },
        { label: 'on', value: 'on' },
      ],
      default: '',
      hint: 'Режим мышления (models.dev)',
    }
  }

  const budget = specs.find(s => s.type === 'budget_tokens')
  if (budget) {
    return {
      paramType: 'thinking_budget',
      apiParam: 'thinking',
      options: budgetOptions(budget.min, budget.max),
      default: '',
      hint: 'budget_tokens для extended thinking (models.dev)',
    }
  }

  return null
}

/** Конфиг для gateway-модели: уровни из /v1/models (admin-конфиг группы). */
export function configFromGatewayLevels(levels: string[]): ModelReasoningConfig {
  return {
    paramType: 'reasoning_effort',
    apiParam: 'reasoning_effort',
    options: [
      { label: 'off', value: '' },
      ...levels.map(l => ({ label: l, value: l })),
    ],
    default: '',
    hint: 'Режим мышления — Syntee-Gateway',
  }
}

function isReasoningOff(value: string): boolean {
  return !value || value === 'off' || value === 'none'
}

// Порядок не зависит от порядка уровней, присланного провайдером.
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Совпадение или ближайший доступный ниже; неизвестные шкалы не угадываем. */
function compatibleEffort(value: string, supported: string[]): string | undefined {
  if (isReasoningOff(value)) return undefined
  if (supported.includes(value)) return value
  const index = EFFORT_ORDER.indexOf(value)
  if (index < 0) return undefined
  for (let i = index - 1; i >= 0; i--) {
    if (supported.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i]
  }
  // Нет меньшего уровня — не повышаем, оставляем дефолт API.
  return undefined
}

/**
 * Строит extra-параметры для API запроса.
 *
 * meta — данные модели: для Syntee-Gateway это кэш /v1/models
 * (meta.reasoning.supported → уровни группы, шлём reasoning_effort как есть,
 * gateway сам транслирует в native-формат); для остальных провайдеров —
 * спеки models.dev (meta.reasoningOptions).
 */
export function buildReasoningParams(
  selectedValue: string,
  meta?: {
    reasoning?: { supported: boolean; levels: string[] }
    reasoningOptions?: ReasoningOptionSpec[]
  } | null,
): Record<string, unknown> {
  // Gateway metadata authoritative, в том числе supported=false:
  // не пытаемся включить мышление через каталог в обход провайдера.
  if (meta?.reasoning) {
    if (!meta.reasoning.supported || isReasoningOff(selectedValue)) return {}
    const effort = compatibleEffort(selectedValue, meta.reasoning.levels)
    return effort ? { reasoning_effort: effort } : {}
  }

  const config = configFromSpecs(meta?.reasoningOptions)
  if (!config || config.paramType === 'always_on') return {}

  if (isReasoningOff(selectedValue)) {
    if (config.paramType === 'toggle') return { thinking: { type: 'disabled' } }
    return config.offValue ? { reasoning_effort: config.offValue } : {}
  }

  switch (config.paramType) {
    case 'reasoning_effort': {
      const effort = compatibleEffort(selectedValue, config.options.map(o => o.value))
      return effort ? { reasoning_effort: effort } : {}
    }

    case 'toggle':
      return { thinking: { type: 'enabled' } }

    case 'thinking_budget': {
      // Уровни effort и числовой бюджет несопоставимы: никаких случайных 10000.
      if (!/^\d+$/.test(selectedValue)) return {}
      const requested = Number(selectedValue)
      const spec = meta?.reasoningOptions?.find(s => s.type === 'budget_tokens')
      const budget = Math.min(requested, spec?.max ?? requested)
      if (!Number.isSafeInteger(budget) || budget < Math.max(spec?.min ?? 1024, 1024)) return {}
      return { thinking: { type: 'enabled', budget_tokens: budget } }
    }
  }
  return {}
}

/**
 * Responses API (OpenAI /responses): переводит reasoningExtra в формат
 * `reasoning: { effort }`. Мапится только reasoning_effort — toggle и
 * budget_tokens (chat/completions-специфика) в Responses не имеют аналога,
 * 'none'/'off' Responses не поддерживает (параметр не шлём вовсе).
 */
export function responsesReasoningParam(
  reasoningExtra: Record<string, unknown>,
): Record<string, unknown> {
  const effort = reasoningExtra.reasoning_effort
  return typeof effort === 'string' && effort && effort !== 'none' && effort !== 'off'
    ? { reasoning: { effort } }
    : {}
}
