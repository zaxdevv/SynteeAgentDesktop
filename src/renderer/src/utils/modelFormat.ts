/**
 * Общие хелперы для форматирования статов моделей в UI.
 * Используются в ModelPicker (настройки) и ModelSelector (чат),
 * чтобы избежать дублирования formatCtx/formatPrice/getProviderColor/CAP_LABELS/SPEED_*.
 */
import type { ModelCapability, ModelSpeed } from '../../../shared/types'

/** Подписи capabilities для бейджей и фильтров. */
export const CAP_LABELS: Record<ModelCapability, string> = {
  vision: 'Vision',
  tools: 'Tools',
  reasoning: 'Reason',
  code: 'Code',
  embedding: 'Embed',
  tts: 'TTS',
  stt: 'STT',
  image_gen: 'Image',
  video: 'Video',
  audio_input: 'Audio in',
  audio_output: 'Audio out',
}

/** Человекочитаемые подписи скорости модели. */
export const SPEED_LABEL: Record<ModelSpeed, string> = {
  fast: 'Быстро',
  medium: 'Средне',
  slow: 'Медленно',
}

/** Цвет скорости для тултипов/бейджей. */
export const SPEED_COLOR: Record<ModelSpeed, string> = {
  fast: '#4ade80',
  medium: '#facc15',
  slow: '#f87171',
}

/** Форматирование контекстного окна: 128000 → "128K", 1000000 → "1M". */
export function formatCtx(n: number): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${n / 1_000_000}M`
  return `${n / 1_000}K`
}

/** Форматирование цены за 1M токенов: 2.5 → "$2.50", undefined → "—". */
export function formatPrice(n?: number): string {
  if (n === undefined) return '—'
  return `$${n.toFixed(2)}`
}

/**
 * Цвет провайдера по id. Источник каноничных значений — BUILTIN_PROVIDERS_META
 * в src/shared/data/builtinModels.ts, здесь инлайн-копия чтобы не тянуть
 * тяжёлый модуль с данными в каждый UI-компонент.
 */
export function getProviderColor(pid: string): string {
  const colors: Record<string, string> = {
    openai: '#10a37f',
    anthropic: '#d4763b',
    google: '#4285f4',
    groq: '#f55036',
    cerebras: '#e0524d',
    mistral: '#ff7000',
    ollama: '#aaaaaa',
    cohere: '#39594d',
    together: '#7c3aed',
    fireworks: '#ef4444',
    deepseek: '#2563eb',
    xai: '#ffffff',
    onlysq: '#a855f7',
    voidai: '#06b6d4',
    bfl: '#e11d48',
    openrouter: '#8b5cf6',
  }
  return colors[pid] || '#888'
}

// ── Аватары моделей (бренд-логотипы) ──────────────────────────────────────
// Eager-glob всех SVG из assets/brand-logos как URL-строки. Vite резолвит
// пути на этапе сборки, в рантайме получаем готовые URL (без SVGR-плагина).
const LOGO_URLS = import.meta.glob<string>('../assets/brand-logos/*.svg', {
  eager: true,
  as: 'url',
})

// Кеш: имя файла (без расширения) → URL
const LOGO_BY_NAME: Record<string, string> = {}
for (const [p, url] of Object.entries(LOGO_URLS) as Array<[string, string]>) {
  const name = p.split('/').pop()!.replace('.svg', '')
  LOGO_BY_NAME[name] = url
}

function logoUrl(name: string): string | null {
  return LOGO_BY_NAME[name] ?? null
}

// Логотипы, нарисованные однотонным fill="currentColor" — при рендере через
// <img> они теряют наследование цвета и рисуются чёрным силуэтом (невидимым
// на тёмном фоне). Для них рендерим через CSS mask-image + background-color
// вместо <img>, чтобы цвет подхватывался из темы.
const MONO_LOGOS = new Set(['openai', 'grok', 'flux', 'midjourney', 'ollama', 'runway', 'zai-glm'])

export interface BrandLogo {
  url: string
  /** true — однотонный SVG (currentColor), рендерить через CSS mask, не <img> */
  mono: boolean
}

/**
 * Определяет логотип бренда по провайдеру и модели.
 * Приоритет:
 *   1. provider type → прямой бренд (openai, anthropic, google, mistral,
 *      ollama, deepseek, xai, bfl).
 *   2. Паттерны в modelId/modelName — для прокси-провайдеров (onlysq,
 *      together, fireworks, groq, voidai, custom), которые serve много
 *      брендов одновременно (например OnlySQ проксирует claude/gpt/gemini).
 *   3. providerIconUrl — для кастомных провайдеров.
 *   4. null — caller рендерит цветную точку через getProviderColor().
 *
 * `providerId` здесь не нужен: он используется только для цвета в fallback,
 * а цвет уже есть в getProviderColor(). Главное поле для Тир 1 — providerType.
 */
export function getBrandLogo(
  providerType: string,
  modelId: string,
  modelName: string,
  providerIconUrl?: string,
): BrandLogo | null {
  const mid = modelId.toLowerCase()
  const mname = modelName.toLowerCase()
  const hay = `${mid} ${mname}`

  const pick = (name: string): BrandLogo | null => {
    const url = logoUrl(name)
    return url ? { url, mono: MONO_LOGOS.has(name) } : null
  }

  // ── Тир 1: provider type → прямой бренд ──────────────────────────
  // Для прокси-провайдеров (onlysq/together/fireworks/groq/voidai/custom)
  // provider type не определяет бренд — переходим к Тир 2 (паттерны).
  switch (providerType) {
    case 'openai':    return pick('openai')
    case 'anthropic': return pick('claude-color')
    case 'google':    return pick('google-color')
    case 'mistral':   return pick('mistral-color')
    case 'ollama':    return pick('ollama')
    case 'deepseek':  return pick('deepseek-color')
    case 'xai':       return pick('grok')
    case 'bfl':       return pick('flux')
    case 'openrouter': return pick('openrouter')
  }

  // ── Тир 2: паттерны в model id/name (прокси-провайдеры) ──────────
  // Порядок важен: более специфичные паттерны раньше.
  // DALL-E / GPT-Image — раньше общих gpt-паттернов.
  if (/dall-?e|gpt-image/.test(hay))          return pick('dalle-color')
  if (/claude|opus|sonnet|haiku/.test(hay))   return pick('claude-color')
  if (/\bglm\b|zhipu|zai/.test(hay))          return pick('zai-glm')
  if (/gemini|gemma/.test(hay))               return pick('gemini-color')
  if (/deepseek/.test(hay))                   return pick('deepseek-color')
  if (/grok/.test(hay))                       return pick('grok')
  if (/qwen/.test(hay))                       return pick('qwen-color')
  if (/llama|meta-llama/.test(hay))           return pick('meta-color')
  if (/mixtral|codestral|mistral/.test(hay))  return pick('mistral-color')
  if (/kimi/.test(hay))                       return pick('kimi-color')
  if (/minimax/.test(hay))                    return pick('minimax-color')
  if (/flux/.test(hay))                       return pick('flux')
  if (/stable-diffusion|sdxl|stability/.test(hay)) return pick('stability-color')
  if (/midjourney/.test(hay))                 return pick('midjourney')
  if (/runway/.test(hay))                     return pick('runway')
  if (/microsoft|phi-|wizardlm/.test(hay))    return pick('microsoft-color')
  // gpt/o3/o4 — после всех специфичных (gpt-image уже отработал выше).
  if (/\bgpt\b|o3|o4/.test(hay))              return pick('openai')

  // ── Тир 3: provider iconUrl (кастомные провайдеры) ───────────────
  if (providerIconUrl) return { url: providerIconUrl, mono: false }

  // ── Тир 4: fallback на цветную точку ─────────────────────────────
  return null
}
