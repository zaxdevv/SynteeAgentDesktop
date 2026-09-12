import type { ModelMeta, ModelSpeed, ModelCapability } from '../types'

function m(
  id: string, providerId: string, name: string,
  ctx: number, inp: number, out: number,
  speed: ModelSpeed, caps: ModelCapability[], desc: string
): ModelMeta {
  return { id, providerId, name, contextWindow: ctx, inputPrice: inp, outputPrice: out, speed, capabilities: caps, description: desc }
}

const V: ModelCapability = 'vision'
const T: ModelCapability = 'tools'
const R: ModelCapability = 'reasoning'
const C: ModelCapability = 'code'
const I: ModelCapability = 'image_gen'

export const BUILTIN_MODELS: ModelMeta[] = [
  // OpenAI
  m('gpt-4o',               'openai', 'GPT-4o',                128_000,  2.50,  10.00, 'fast',   [V,T,C],   'Мультимодальная флагманская модель OpenAI'),
  m('gpt-4o-mini',          'openai', 'GPT-4o mini',           128_000,  0.15,   0.60, 'fast',   [V,T,C],   'Быстрая и дешёвая версия GPT-4o'),
  m('gpt-4.1',              'openai', 'GPT-4.1',               1_000_000, 2.00,   8.00, 'medium', [V,T,C],   'Улучшенный GPT-4 с контекстом 1M'),
  m('o3',                   'openai', 'o3',                    200_000, 10.00,  40.00, 'slow',   [T,R,C],   'Мощная reasoning-модель OpenAI'),
  m('o4-mini',              'openai', 'o4-mini',               200_000,  1.10,   4.40, 'medium', [T,R,C],   'Быстрый reasoning от OpenAI'),

  // Anthropic
  m('claude-opus-4-5',      'anthropic', 'Claude Opus 4.5',    200_000, 15.00,  75.00, 'slow',   [V,T,R,C], 'Самая мощная модель Anthropic'),
  m('claude-sonnet-4-5',    'anthropic', 'Claude Sonnet 4.5',  200_000,  3.00,  15.00, 'medium', [V,T,C],   'Баланс мощности и скорости'),
  m('claude-sonnet-4-6',    'anthropic', 'Claude Sonnet 4.6',  200_000,  3.00,  15.00, 'medium', [V,T,C],   'Обновлённый Sonnet с улучшенными возможностями'),
  m('claude-haiku-4-5',     'anthropic', 'Claude Haiku 4.5',   200_000,  0.80,   4.00, 'fast',   [V,T,C],   'Самая быстрая и дешёвая модель Anthropic'),

  // Google
  m('gemini-2.5-pro',       'google', 'Gemini 2.5 Pro',        1_000_000, 1.25,  10.00, 'medium', [V,T,R,C], 'Флагман Google с огромным контекстом'),
  m('gemini-2.5-flash',     'google', 'Gemini 2.5 Flash',      1_000_000, 0.15,   0.60, 'fast',   [V,T,C],   'Быстрый и дешёвый Gemini'),
  m('gemini-2.0-flash',     'google', 'Gemini 2.0 Flash',        32_000,  0.10,   0.40, 'fast',   [V,T,C],   'Предыдущее поколение Flash'),

  // Groq
  m('llama-3.3-70b-versatile', 'groq', 'Llama 3.3 70B',        128_000,  0.59,   0.79, 'fast',   [T,C],     'Мета Llama 3.3 70B на Groq — очень быстро'),
  m('llama-3.1-8b-instant',    'groq', 'Llama 3.1 8B Instant', 128_000,  0.05,   0.08, 'fast',   [T,C],     'Молниеносная маленькая модель'),
  m('mixtral-8x7b-32768',      'groq', 'Mixtral 8x7B',          32_768,  0.24,   0.24, 'fast',   [T,C],     'Mixture-of-Experts от Mistral'),
  m('gemma2-9b-it',            'groq', 'Gemma 2 9B',             8_192,  0.20,   0.20, 'fast',   [C],       'Google Gemma 2 на инфраструктуре Groq'),
  m('openai/gpt-oss-120b',     'groq', 'GPT-OSS 120B',         131_072,  0.15,   0.60, 'fast',   [T,R,C],   'OpenAI GPT-OSS 120B на Groq LPU — ~500 t/s'),
  m('openai/gpt-oss-20b',      'groq', 'GPT-OSS 20B',          131_072,  0.075,  0.30, 'fast',   [T,R,C],   'OpenAI GPT-OSS 20B на Groq LPU — ~1000 t/s'),

  // Cerebras (Wafer-Scale Engine, ~3000 t/s на 120B)
  m('gpt-oss-120b',            'cerebras', 'GPT-OSS 120B',     131_072,  0.35,   0.75, 'fast',   [T,R,C],   'Cerebras WSE — ~3000 t/s, самая быстрая 120B в мире'),
  m('gpt-oss-20b',             'cerebras', 'GPT-OSS 20B',      131_072,  0.075,  0.30, 'fast',   [T,R,C],   'Cerebras WSE — быстрая 20B'),

  // Mistral
  m('mistral-large-latest',    'mistral', 'Mistral Large',      128_000,  2.00,   6.00, 'medium', [T,C],     'Флагман Mistral AI'),
  m('mistral-small-latest',    'mistral', 'Mistral Small',      128_000,  0.20,   0.60, 'fast',   [T,C],     'Быстрый и дешёвый Mistral'),
  m('codestral-latest',        'mistral', 'Codestral',          256_000,  0.30,   0.90, 'fast',   [T,C],     'Специализированная модель для кода'),
  m('mistral-embed',           'mistral', 'Mistral Embed',        8_192,  0.10,   0.00, 'fast',   ['embedding'], 'Embeddings от Mistral'),

  // DeepSeek
  m('deepseek-v3',             'deepseek', 'DeepSeek V3',        64_000,  0.27,   1.10, 'medium', [T,C],     'Мощная открытая модель DeepSeek'),
  m('deepseek-r1',             'deepseek', 'DeepSeek R1',        64_000,  0.55,   2.19, 'slow',   [R,C],     'Reasoning-модель DeepSeek уровня o1'),
  m('deepseek-v4-pro',         'deepseek', 'DeepSeek V4 Pro',   128_000,  0.50,   2.00, 'medium', [T,C,R],   'Новейший флагман DeepSeek'),

  // xAI
  m('grok-3',                  'xai', 'Grok 3',                 131_072,  3.00,  15.00, 'medium', [V,T,C],   'Флагман xAI с веб-доступом'),
  m('grok-3-mini',             'xai', 'Grok 3 Mini',            131_072,  0.30,   0.50, 'fast',   [T,C],     'Быстрый Grok для повседневных задач'),

  // Cohere
  m('command-r-plus',          'cohere', 'Command R+',          128_000,  2.50,  10.00, 'medium', [T,C],     'Флагман Cohere для RAG и агентов'),
  m('command-r',               'cohere', 'Command R',           128_000,  0.15,   0.60, 'fast',   [T,C],     'Быстрый Command R'),
  m('embed-english-v3.0',      'cohere', 'Embed English v3',      512,   0.10,   0.00, 'fast',   ['embedding'], 'Embeddings Cohere для английского'),

  // Together AI
  m('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together', 'Llama 3.3 70B Turbo', 128_000, 0.88, 0.88, 'fast', [T,C], 'Llama 3.3 70B оптимизированный на Together'),
  m('Qwen/Qwen2.5-72B-Instruct-Turbo',         'together', 'Qwen 2.5 72B Turbo',  128_000, 1.20, 1.20, 'fast', [T,C], 'Qwen 2.5 72B на Together AI'),
  m('mistralai/Mixtral-8x22B-Instruct-v0.1',   'together', 'Mixtral 8x22B',       64_000,  1.20, 1.20, 'medium', [T,C], 'Большая MoE от Mistral'),

  // Fireworks
  m('accounts/fireworks/models/llama-v3p3-70b-instruct', 'fireworks', 'Llama 3.3 70B', 128_000, 0.90, 0.90, 'fast', [T,C], 'Llama 3.3 70B на Fireworks'),
  m('accounts/fireworks/models/qwen3-32b',               'fireworks', 'Qwen3 32B',      32_768, 0.30, 0.30, 'fast', [T,C,R], 'Qwen3 32B с reasoning'),
  m('accounts/fireworks/models/deepseek-v3',             'fireworks', 'DeepSeek V3',    64_000, 0.90, 0.90, 'medium', [T,C], 'DeepSeek V3 на Fireworks'),

  // ── Генерация изображений (OpenAI) ──────────────────────────────────────
  m('dall-e-3',               'openai', 'DALL-E 3',                  0,  0.04,   0.00, 'medium', [I],       'OpenAI — качественная генерация, style/quality параметры'),
  m('dall-e-2',               'openai', 'DALL-E 2',                  0,  0.02,   0.00, 'fast',   [I],       'OpenAI — быстрая базовая генерация'),
  m('gpt-image-1',            'openai', 'GPT Image 1',               0,  0.04,   0.00, 'medium', [I],       'OpenAI — новейшая модель генерации изображений'),

  // ── Генерация изображений (Black Forest Labs — FLUX) ─────────────────────
  m('flux-pro-1.1-ultra',     'bfl',    'FLUX 1.1 Pro Ultra',        0,  0.06,   0.00, 'medium', [I],       'BFL — наивысшее качество, до 4MP'),
  m('flux-pro-1.1',           'bfl',    'FLUX 1.1 Pro',              0,  0.04,   0.00, 'fast',   [I],       'BFL — высокое качество, быстрее Pro'),
  m('flux-pro',               'bfl',    'FLUX.1 Pro',                0,  0.05,   0.00, 'medium', [I],       'BFL — стандартное качество'),
  m('flux-dev',               'bfl',    'FLUX.1 Dev',                0,  0.025,  0.00, 'fast',   [I],       'BFL — исследовательский, некоммерческий'),
  m('flux-schnell',           'bfl',    'FLUX.1 Schnell',            0,  0.003,  0.00, 'fast',   [I],       'BFL — самый быстрый, некоммерческий'),

  // ── Генерация изображений (Together AI) ─────────────────────────────────
  m('black-forest-labs/FLUX.1-schnell',  'together', 'FLUX.1 Schnell',  0, 0.001, 0.00, 'fast',   [I], 'Together — FLUX Schnell'),
  m('black-forest-labs/FLUX.1-dev',      'together', 'FLUX.1 Dev',      0, 0.010, 0.00, 'medium', [I], 'Together — FLUX Dev'),
  m('black-forest-labs/FLUX.1.1-pro',    'together', 'FLUX 1.1 Pro',    0, 0.040, 0.00, 'medium', [I], 'Together — FLUX 1.1 Pro'),
  m('stabilityai/stable-diffusion-xl-base-1.0', 'together', 'SDXL 1.0', 0, 0.008, 0.00, 'fast',   [I], 'Together — Stable Diffusion XL'),

  // ── OpenCode Zen Free (без ключа, только free-модели) ─────────────────────
  // Pre-seed free-моделей (видны в пикере сразу, до фетча). Список сверен с
  // live /zen/v1/models 11.09.2026; далее актуализируется авто-фетчем
  // (providers.ipc.ts autoRefreshOpencodeModels, старт + каждые 6ч) — builtin
  // для opencode скрывается, если есть live-кэш и модели в нём нет.
  // Удалены с Zen (мёртвые): north-mini-code-free, laguna-s-2.1-free, ling-3.0-flash-free.
  m('mimo-v2.5-free',                  'opencode-free', 'MiMo V2.5 (Free)',               200_000, 0, 0, 'fast',   [V,T,R,C], 'OpenCode Zen Free — мультимодальная, image/audio/video, дефолт для fast'),
  m('ling-3.0-flash-fin-free',         'opencode-free', 'Ling 3.0 Flash Fin (Free)',      262_144, 0, 0, 'fast',   [T,R,C],   'OpenCode Zen Free — быстрая текстовая'),
  m('nemotron-3.5-lightning-free',     'opencode-free', 'Nemotron 3.5 Lightning (Free)',1_000_000, 0, 0, 'fast',   [T,R,C],   'OpenCode Zen Free — большой контекст, очередь до 20с'),
  m('nemotron-3-ultra-free',           'opencode-free', 'Nemotron 3 Ultra (Free)',      1_000_000, 0, 0, 'slow',   [T,R,C],   'OpenCode Zen Free — огромный контекст 1M, очередь до 40с'),
  m('muse-spark-1.3-contributor-free','opencode-free', 'Muse Spark 1.3 (Contributor)',   256_000, 0, 0, 'medium', [T,R,C],   'OpenCode Zen Free — reasoning, работает через Responses API'),
  m('muse-spark-1.2-contributor-free','opencode-free', 'Muse Spark 1.2 (Contributor)',   256_000, 0, 0, 'medium', [T,R,C],   'OpenCode Zen Free — reasoning, работает через Responses API'),
  m('big-pickle',                      'opencode-free', 'Big Pickle (Free)',              131_072, 0, 0, 'fast',   [T,R,C],   'OpenCode Zen Free — reasoning-модель (ответ идёт в reasoning_content)'),

  // ── OpenRouter — агрегатор моделей, OpenAI-совместимый (https://openrouter.ai) ──
  // Требует API-ключ пользователя. 200 t/s на free-моделях — идеально для fast-context.
  m('inclusionai/ling-3.0-flash:free', 'openrouter', 'Ling 3.0 Flash (Free)', 262_144, 0, 0, 'fast', [T,R,C], 'OpenRouter — 200 t/s бесплатно, дефолт для fast-context'),
]

export const BUILTIN_PROVIDERS_META: Record<string, { name: string; baseUrl: string; docsUrl: string; color: string }> = {
  openai:    { name: 'OpenAI',      baseUrl: 'https://api.openai.com/v1',                color: '#10a37f', docsUrl: 'https://platform.openai.com' },
  anthropic: { name: 'Anthropic',   baseUrl: 'https://api.anthropic.com',                color: '#d4763b', docsUrl: 'https://console.anthropic.com' },
  google:    { name: 'Google',      baseUrl: 'https://generativelanguage.googleapis.com/v1beta', color: '#4285f4', docsUrl: 'https://aistudio.google.com' },
  groq:      { name: 'Groq',        baseUrl: 'https://api.groq.com/openai/v1',            color: '#f55036', docsUrl: 'https://console.groq.com' },
  cerebras:  { name: 'Cerebras',    baseUrl: 'https://api.cerebras.ai/v1',                color: '#e0524d', docsUrl: 'https://inference.cerebras.ai' },
  mistral:   { name: 'Mistral AI',  baseUrl: 'https://api.mistral.ai/v1',                 color: '#ff7000', docsUrl: 'https://console.mistral.ai' },
  ollama:    { name: 'Ollama',      baseUrl: 'http://localhost:11434/v1',                  color: '#aaaaaa', docsUrl: 'https://ollama.ai' },
  cohere:    { name: 'Cohere',      baseUrl: 'https://api.cohere.ai/v1',                  color: '#39594d', docsUrl: 'https://dashboard.cohere.com' },
  together:  { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1',               color: '#7c3aed', docsUrl: 'https://api.together.ai' },
  fireworks: { name: 'Fireworks',   baseUrl: 'https://api.fireworks.ai/inference/v1',     color: '#ef4444', docsUrl: 'https://fireworks.ai' },
  deepseek:  { name: 'DeepSeek',    baseUrl: 'https://api.deepseek.com/v1',               color: '#2563eb', docsUrl: 'https://platform.deepseek.com' },
  xai:       { name: 'xAI Grok',    baseUrl: 'https://api.x.ai/v1',                       color: '#ffffff', docsUrl: 'https://console.x.ai' },
  voidai:    { name: 'VoidAI',      baseUrl: 'https://api.voidai.app/v1',                  color: '#06b6d4', docsUrl: 'https://docs.voidai.app' },
  bfl:       { name: 'Black Forest Labs', baseUrl: 'https://api.bfl.ai',                   color: '#e11d48', docsUrl: 'https://docs.bfl.ml' },
  // ── OpenCode Zen — публичный OpenAI-совместимый шлюз (https://opencode.ai/zen) ──
  'opencode-free': { name: 'OpenCode Zen Free', baseUrl: 'https://opencode.ai/zen/v1',    color: '#10b981', docsUrl: 'https://opencode.ai' },
  opencode:        { name: 'OpenCode Zen',      baseUrl: 'https://opencode.ai/zen/v1',    color: '#6366f1', docsUrl: 'https://opencode.ai' },
  'opencode-go':   { name: 'OpenCode Go',       baseUrl: 'https://opencode.ai/zen/go/v1', color: '#f59e0b', docsUrl: 'https://opencode.ai' },
  // ── OpenRouter — OpenAI-совместимый агрегатор моделей ──
  openrouter:  { name: 'OpenRouter',   baseUrl: 'https://openrouter.ai/api/v1',          color: '#8b5cf6', docsUrl: 'https://openrouter.ai/keys' },
  // ── Syntee-Gateway — собственный шлюз с JWT-авторизацией (модели тянем из /v1/models) ──
  'syntee-gateway': { name: 'Syntee Gateway', baseUrl: '', color: '#10b981', docsUrl: '' },
}
