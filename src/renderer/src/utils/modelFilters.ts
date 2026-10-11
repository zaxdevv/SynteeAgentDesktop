/**
 * Общая логика фильтрации моделей для пикеров (ModelSelector в чате,
 * ModelPicker в настройках): capability-фильтры (AND), фильтр по цене,
 * предикат «бесплатности» и иконки/подписи для UI.
 */
import type { ModelCapability, ModelMeta, ModelRole } from '../../../shared/types'
import type { IconName } from '../components/ui/AppIcon/AppIcon'
import { formatPrice } from './modelFormat'

/** Фильтр по цене. Пороги — по input-цене за 1M токенов (кумулятивные). */
export type PriceFilter = 'any' | 'free' | 'under1' | 'under10' | 'expensive'

/** Пилюли цены в UI (без 'any' — сброс фильтра = все модели). */
export const PRICE_FILTERS: Exclude<PriceFilter, 'any'>[] = ['free', 'under1', 'under10', 'expensive']

export const PRICE_FILTER_LABELS: Record<PriceFilter, string> = {
  any: 'Все',
  free: 'Бесплатно',
  under1: '≤ $1',
  under10: '≤ $10',
  expensive: '> $10',
}

/** Иконки capabilities для пилюль фильтров и мини-бейджей в строках моделей. */
export const CAP_ICONS: Record<ModelCapability, IconName> = {
  vision: 'eye',
  tools: 'wrench',
  reasoning: 'brain',
  code: 'code',
  embedding: 'database',
  tts: 'volume',
  stt: 'mic',
  image_gen: 'image',
  video: 'camera',
  audio_input: 'mic',
  audio_output: 'volume',
}

/** Провайдеры, чьи модели всегда бесплатны (локальный инференс). */
const FREE_PROVIDER_IDS = new Set(['ollama'])

/**
 * true, если модель заведомо бесплатна: цены известны и равны нулю
 * (на уровне каталога models.dev это фиксирует hasPricing), либо это
 * локальный провайдер. Модели с НЕизвестной ценой (undefined) — не
 * бесплатные: они не попадают в фильтр «Бесплатно».
 */
export function isModelFree(m: ModelMeta): boolean {
  if (FREE_PROVIDER_IDS.has(m.providerId)) return true
  return m.inputPrice !== undefined && m.outputPrice !== undefined
    && m.inputPrice === 0 && m.outputPrice === 0
}

/** Эффективная цена для пороговых фильтров; undefined — цена неизвестна. */
function effectivePrice(m: ModelMeta): number | undefined {
  return m.inputPrice ?? m.outputPrice
}

export function matchesPriceFilter(m: ModelMeta, f: PriceFilter): boolean {
  if (f === 'any') return true
  if (f === 'free') return isModelFree(m)
  const p = effectivePrice(m)
  if (p === undefined) return false // цена неизвестна — видна только в 'any'
  if (f === 'under1') return p <= 1
  if (f === 'under10') return p <= 10
  if (f === 'expensive') return p > 10
  return true
}

/** AND-логика: модель должна иметь ВСЕ выбранные capabilities. */
export function matchesCaps(m: ModelMeta, caps: ModelCapability[]): boolean {
  return caps.every(c => {
    const inputKinds: Partial<Record<ModelCapability, string>> = { vision: 'image', video: 'video', audio_input: 'audio', stt: 'audio' }
    const outputKinds: Partial<Record<ModelCapability, string>> = { audio_output: 'audio', tts: 'audio', image_gen: 'image' }
    const inputKind = inputKinds[c]
    const outputKind = outputKinds[c]
    if (inputKind && m.inputModalities !== undefined) return m.inputModalities.includes(inputKind)
    if (outputKind && m.outputModalities !== undefined) return m.outputModalities.includes(outputKind)
    if (c === 'audio_input') return m.capabilities.includes(c) || m.capabilities.includes('stt')
    if (c === 'audio_output') return m.capabilities.includes(c) || m.capabilities.includes('tts')
    return m.capabilities.includes(c)
  })
}

/**
 * Checks role metadata without claiming that a transport/API supports it.
 * Explicit modalities are authoritative; legacy capability flags are fallbacks.
 */
export function matchesModelRole(m: ModelMeta, role: ModelRole): boolean {
  const input = m.inputModalities?.map(x => x.toLowerCase())
  const output = m.outputModalities?.map(x => x.toLowerCase())
  const hasInput = (kind: string, fallback: ModelCapability) =>
    input ? input.includes(kind) : m.capabilities.includes(fallback)
  const hasTextOutput = output === undefined || output.includes('text')
  switch (role) {
    case 'vision': return hasInput('image', 'vision') && hasTextOutput
    case 'video': return hasInput('video', 'video') && hasTextOutput
    case 'audio': return (input ? input.includes('audio') : matchesCaps(m, ['audio_input'])) && hasTextOutput
    case 'stt': return hasInput('audio', 'stt')
    case 'tts': return output !== undefined ? output.includes('audio') : m.capabilities.includes('tts')
    default: return true
  }
}

export interface ModelFilter {
  query: string
  caps: ModelCapability[]
  price: PriceFilter
}

/** true, если активен хоть один фильтр (кроме поиска). */
export function hasActiveFilters(f: ModelFilter): boolean {
  return f.caps.length > 0 || f.price !== 'any'
}

/**
 * Единый пайплайн фильтрации: поиск (имя/id/провайдер) → capabilities (AND)
 * → цена. Группировка/сортировка остаются на стороне пикеров.
 */
export function filterModels(models: ModelMeta[], f: ModelFilter): ModelMeta[] {
  let out = models
  const q = f.query.trim().toLowerCase()
  if (q) {
    out = out.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.providerId.toLowerCase().includes(q)
    )
  }
  if (f.caps.length) out = out.filter(m => matchesCaps(m, f.caps))
  if (f.price !== 'any') out = out.filter(m => matchesPriceFilter(m, f.price))
  return out
}

/**
 * Подпись цены для тултипа. «Бесплатно» — только когда модель бесплатна
 * целиком (обе цены = 0), иначе обычный $-формат или «—» при неизвестной цене.
 */
export function tooltipPrice(m: ModelMeta, v?: number): string {
  if (isModelFree(m)) return 'Бесплатно'
  return formatPrice(v)
}
