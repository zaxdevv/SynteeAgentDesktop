import { existsSync, readFileSync, statSync, readdirSync, mkdirSync, writeFileSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { isMainThread } from 'worker_threads'
import OpenAI from 'openai'
import type Store from 'electron-store'
import type { Provider, ModelParams } from '../../shared/types'
import { getIdentityHeaders } from '../../shared/constants'
import { isImageMime, mimeFromExt } from '../../shared/mentions'
import { AIClient } from '../ai/AIClient'
import { agentModelSupportsVision } from '../ai/visionSupport'
import { resolveToolPath, type ToolResult } from './_shared'

export async function generateImage(
  args: {
    prompt: string
    model?: string
    size?: string
    quality?: string
    style?: string
  },
  store: Store,
  opts?: {
    /** Gateway JWT — в worker-потоке приходит из workerData через toolDispatcher. */
    gatewayToken?: string | null
    /** userData path — куда сохранять b64-картинки (в main берём из electron). */
    userDataPath?: string
  },
): Promise<ToolResult> {
  const providers = store.get('providers', []) as Provider[]
  const imageProviderId = store.get('imageProviderId', '') as string
  const imageModelId = store.get('imageModelId', '') as string

  console.log('[generateImage] imageProviderId=', imageProviderId, 'imageModelId=', imageModelId, 'providers count=', (providers as unknown[]).length)
  console.log('[generateImage] known provider ids=', (providers as Provider[]).map(p => p.id))

  let provider: Provider | undefined

  if (imageProviderId) {
    // Сначала точное совпадение по id
    provider = providers.find(p => p.id === imageProviderId)
    // Если не нашли — ищем по частичному совпадению (кастомные провайдеры могут иметь суффикс)
    if (!provider) {
      provider = providers.find(p => p.id.includes(imageProviderId) || imageProviderId.includes(p.id))
    }
    console.log('[generateImage] found provider:', provider?.id ?? 'NOT FOUND')
  }

  if (!provider) {
    // Последний шанс — первый enabled с ключом
    provider = providers.find(p => p.enabled && (p.apiKey || (p.apiKeys && p.apiKeys.length > 0)))
    if (provider) {
      console.log('[generateImage] fallback to first enabled provider:', provider.id)
    }
  }

  if (!provider) {
    return {
      success: false, output: '',
      error: 'No image generation model is configured. Go to Settings → AI → Models → Image generation and select a model.'
    }
  }

  // ── Авторизация ────────────────────────────────────────────────────────
  // Syntee-Gateway авторизуется JWT аккаунта (как AIClient), а не статическим
  // apiKey: провайдер сидится с пустым ключом (providers.ipc.ts auto-seed).
  // В worker-потоке токен приходит через opts (toolDispatcher.gatewayToken из
  // workerData); в main-процессе — lazy import gatewayClient (паттерн
  // AIClient.getClientForRoleAsync: в worker electron-store недоступен).
  const isGateway = provider.id === 'syntee-gateway' || provider.type === 'syntee-gateway'
  let apiKey = provider.apiKeys?.find(k => k.trim()) || provider.apiKey || ''
  let baseURL = provider.baseUrl
  if (isGateway) {
    apiKey = opts?.gatewayToken ?? ''
    if (!apiKey && isMainThread) {
      try {
        const { getGatewayAuthToken } = await import('../../main/services/gatewayClient')
        apiKey = (await getGatewayAuthToken()) ?? ''
      } catch { /* не авторизован — ниже вернём понятную ошибку */ }
    }
    if (!apiKey) {
      return {
        success: false, output: '',
        error: 'Syntee Gateway: нет активной сессии. Войдите в аккаунт (Настройки → Профиль) и повторите генерацию.',
      }
    }
    if (!baseURL) baseURL = `${(process.env.SYNTEE_API_URL ?? '').replace(/\/$/, '')}/v1`
  } else if (!apiKey) {
    return { success: false, output: '', error: 'Provider API key is not set' }
  }

  // Стандартный OpenAI-совместимый путь для всех провайдеров
  try {
    const modelParams = store.get('modelParams') as ModelParams | undefined
    const client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: getIdentityHeaders(modelParams?.anonymousUserAgent ?? false),
    })
    const model = args.model || imageModelId
    const size = (args.size || store.get('imageDefaultSize', '1024x1024') as string) as Parameters<typeof client.images.generate>[0]['size']
    // gpt-image-* принимает только low|medium|high|auto: дефолтный 'standard'
    // (настройка DALL·E) ломает запрос 400-й ошибкой — выкидываем его.
    const rawQuality = args.quality || store.get('imageDefaultQuality', 'standard') as string
    const isGptImage = /^gpt-image/i.test(model)
    const quality = (isGptImage && !['low', 'medium', 'high', 'auto'].includes(rawQuality)
      ? undefined
      : rawQuality) as Parameters<typeof client.images.generate>[0]['quality']
    const style = args.style as Parameters<typeof client.images.generate>[0]['style']

    const response = await client.images.generate({
      model, prompt: args.prompt, n: 1, size, quality, style,
      // gpt-image-* не поддерживает response_format (всегда отдаёт b64_json) —
      // лишний параметр даёт 400 "Unknown parameter".
      ...(isGptImage ? {} : { response_format: 'url' as const }),
    })

    const img = response.data?.[0]
    if (!img) return { success: false, output: '', error: 'The provider did not return an image' }
    const revised = img.revised_prompt ? `\nRevised prompt: ${img.revised_prompt}` : ''

    // URL-ответ (dall-e и OpenAI-совместимые провайдеры) — markdown со ссылкой.
    if (img.url) {
      return { success: true, output: `![Generated Image](${img.url})${revised}\n\nURL: ${img.url}\n\nNote: the URL is temporary and may expire within an hour. If you need to save the image, download it before it expires.` }
    }
    // b64_json (gpt-image-*) — сохраняем в файл и отдаём file://-ссылку:
    // renderer пропускает file:// через safeUrlTransform (MessageBubble).
    if (img.b64_json) {
      const saved = await saveB64Image(img.b64_json, opts?.userDataPath)
      if (saved) {
        return { success: true, output: `![Generated Image](${saved.url})${revised}\n\nSaved to: ${saved.path}` }
      }
    }
    return { success: false, output: '', error: 'The provider returned an empty image URL. The image may not have been generated.' }
  } catch (e: unknown) {
    return { success: false, output: '', error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Сохраняет b64_json-картинку (gpt-image-*) в {userData}/generated-images/
 * (fallback: tmpdir в worker без userDataPath). Возвращает путь и file:// URL
 * для markdown-вставки.
 */
async function saveB64Image(b64: string, userDataPath?: string): Promise<{ path: string; url: string } | null> {
  try {
    let dirBase = userDataPath
    if (!dirBase && isMainThread) {
      try {
        const { app } = await import('electron')
        dirBase = app.getPath('userData')
      } catch { /* без electron — fallback tmpdir ниже */ }
    }
    const dir = join(dirBase || tmpdir(), 'generated-images')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    writeFileSync(file, Buffer.from(b64, 'base64'))
    const p = file.replace(/\\/g, '/')
    return { path: file, url: p.startsWith('/') ? `file://${p}` : `file:///${p}` }
  } catch {
    return null
  }
}

// ── analyze_image: распознавание картинки с диска ──────────────────────
//
// Механика — ПОЛНЫЙ ПАРИТЕТ с attachment-flow (chat.ipc.ts
// processAttachmentsAndStream), решение принимает та же эвристика
// (core/ai/visionSupport.ts agentModelSupportsVision), с учётом роли рана:
//
//  1. Основная модель vision-capable → ПРЯМОЙ ПАС: картинка возвращается
//     в imageParts, Agent встраивает её в tool-сообщение как multipart
//     content (image_url-блок) — модель видит пиксели сама, без
//     промежуточного описания и лишнего запроса к vision-модели.
//  2. Основная модель text-only → картинка уходит во вспомогательную
//     vision-модель (role: 'vision', AIClient.analyzeImage), её
//     структурированное текстовое описание возвращается как output.
//
// Работает и в main-процессе, и в worker-потоке (ai-worker передаёт
// modelAssignments в storeData, каталог моделей — через catalogCachePath).
export async function analyzeImageFile(
  args: { path: string; question?: string },
  store: Store,
  workdir?: string,
  userDataPath?: string,
  role: 'main' | 'subagent' = 'main',
): Promise<ToolResult> {
  let absPath = resolveToolPath(args.path, workdir)
  if (!existsSync(absPath)) {
    // Fallback: AI часто видит только имя файла-вложения (напр. "dollar.png")
    // в инлайн-описании от processAttachmentsAndStream, без полного пути.
    // Ищем файл по имени в userData/draft-attachments/{chatId}/ — там хранятся
    // скопированные/pasted вложения. Если нашли — используем полный путь.
    const found = userDataPath ? findInDraftAttachments(userDataPath, args.path) : null
    if (!found) {
      return { success: false, output: '', error: `File not found: ${absPath}` }
    }
    absPath = found
  }
  const mime = mimeFromExt(absPath)
  // SVG vision-модели не принимают (data:image/svg+xml отклоняется API) —
  // просим конвертировать в растр.
  if (!isImageMime(mime) || mime === 'image/svg+xml') {
    return { success: false, output: '', error: `Not a supported raster image (PNG/JPEG/WebP/GIF): ${absPath}${mime === 'image/svg+xml' ? ' (SVG is not supported — convert to PNG first)' : ''}` }
  }
  let size = 0
  try { size = statSync(absPath).size } catch {
    return { success: false, output: '', error: `Cannot stat file: ${absPath}` }
  }
  if (size > 20 * 1024 * 1024) {
    return { success: false, output: '', error: `Image is too large (${(size / 1024 / 1024).toFixed(1)}MB, limit 20MB)` }
  }

  let base64 = ''
  try { base64 = readFileSync(absPath).toString('base64') } catch (e) {
    return { success: false, output: '', error: `Cannot read image: ${(e as Error).message}` }
  }

  const question = args.question?.trim()

  // ── Ветка 1: основная модель видит сама → прямой пас ──
  // Это квитанция загрузки пикселей, а не завершённый анализ.
  // Agent отслеживает следующий модельный ответ отдельно от успеха чтения.
  if (agentModelSupportsVision(store, role)) {
    return {
      success: true,
      output: `Изображение «${absPath}» загружено и приложено для нативного визуального анализа. Анализ выполняет основная модель в следующем ответе.${question ? `\nВопрос: ${question.slice(0, 1000)}` : '\nЗадача: визуально проверь изображение в контексте текущего запроса.'}`,
      imagePaths: [absPath],
      imageParts: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } }],
    }
  }

  // ── Ветка 2: text-only основная модель → vision-модель ──
  // Промпт = вопрос юзера как есть. Без вопроса — нейтральная просьба
  // описать, БЕЗ жёсткой структуры TYPE/TEXT/VISUAL/CONTEXT: модель сама
  // выбирает формат ответа по картинке и вопросу.
  const prompt = question
    ? question.slice(0, 1000)
    : 'Опиши, что изображено на этой картинке.'

  const aiClient = new AIClient(store)
  const description = await new Promise<string>((resolve) => {
    let full = ''
    aiClient.analyzeImage(
      base64,
      prompt,
      {
        onToken: (token) => { full += token },
        onDone: (text) => resolve(text || full),
        onError: (err) => resolve(`[Ошибка анализа изображения: ${err.message}]`),
      },
      mime,
    ).catch(() => resolve('[Ошибка анализа изображения]'))
  })

  if (description.startsWith('[Ошибка')) {
    return { success: false, output: '', error: description }
  }
  return {
    success: true,
    output: `─── Изображение: ${args.path} ───\n${description}\n─── Конец описания: ${args.path} ───`,
  }
}

/**
 * Fallback-поиск картинки-вложения в draft-attachments.
 *
 * AI видит в инлайн-описании только имя файла (напр. "dollar.png"), без
 * полного пути. Когда вызывает analyze_image("dollar.png") — resolveToolPath
 * строит {workdir}/dollar.png, которого не существует. Ищем по имени в
 * userData/draft-attachments/{chatId}/ — там хранятся pasted/drag&drop
 * вложения. Сканируем все chatId-поддиректории (файл мог быть вложен в
 * другом чате, или chatId неизвестен).
 *
 * Возвращает абсолютный путь или null.
 */
function findInDraftAttachments(userDataPath: string, fileName: string): string | null {
  const target = basename(fileName).toLowerCase()
  const draftRoot = join(userDataPath, 'draft-attachments')
  if (!existsSync(draftRoot)) return null
  try {
    for (const chatDir of readdirSync(draftRoot)) {
      const chatPath = join(draftRoot, chatDir)
      try {
        const stat = statSync(chatPath)
        if (!stat.isDirectory()) continue
        for (const file of readdirSync(chatPath)) {
          if (file.toLowerCase() === target) {
            return join(chatPath, file)
          }
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* skip */ }
  return null
}
