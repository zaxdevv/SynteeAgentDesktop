import { existsSync, readFileSync, statSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import OpenAI from 'openai'
import type Store from 'electron-store'
import type { Provider, ModelParams } from '../../shared/types'
import { getIdentityHeaders } from '../../shared/constants'
import { isImageMime, mimeFromExt } from '../../shared/mentions'
import { AIClient } from '../ai/AIClient'
import { mainModelSupportsVision } from '../ai/visionSupport'
import { resolveToolPath, type ToolResult } from './_shared'

export async function generateImage(
  args: {
    prompt: string
    model?: string
    size?: string
    quality?: string
    style?: string
  },
  store: Store
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

  const apiKey = provider.apiKeys?.find(k => k.trim()) || provider.apiKey || ''
  if (!apiKey) return { success: false, output: '', error: 'Provider API key is not set' }

  // Стандартный OpenAI-совместимый путь для всех провайдеров
  try {
    const modelParams = store.get('modelParams') as ModelParams | undefined
    const client = new OpenAI({ apiKey, baseURL: provider.baseUrl, defaultHeaders: getIdentityHeaders(modelParams?.anonymousUserAgent ?? false) })
    const model = args.model || imageModelId
    const size = (args.size || store.get('imageDefaultSize', '1024x1024') as string) as Parameters<typeof client.images.generate>[0]['size']
    const quality = (args.quality || store.get('imageDefaultQuality', 'standard') as string) as Parameters<typeof client.images.generate>[0]['quality']
    const style = args.style as Parameters<typeof client.images.generate>[0]['style']

    const response = await client.images.generate({
      model, prompt: args.prompt, n: 1, size, quality, style,
      response_format: 'url',
    })

    const img = response.data?.[0]
    if (!img) return { success: false, output: '', error: 'The provider did not return an image' }
    const url = img.url || ''
    if (!url) return { success: false, output: '', error: 'The provider returned an empty image URL. The image may not have been generated.' }
    const revised = img.revised_prompt ? `\nRevised prompt: ${img.revised_prompt}` : ''
    return { success: true, output: `![Generated Image](${url})${revised}\n\nURL: ${url}\n\nNote: the URL is temporary and may expire within an hour. If you need to save the image, download it before it expires.` }
  } catch (e: unknown) {
    return { success: false, output: '', error: e instanceof Error ? e.message : String(e) }
  }
}

// ── analyze_image: распознавание картинки с диска ──────────────────────
//
// Механика — ПОЛНЫЙ ПАРИТЕТ с attachment-flow (chat.ipc.ts
// processAttachmentsAndStream), решение принимает та же эвристика
// (core/ai/visionSupport.ts mainModelSupportsVision):
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
  const focus = question ? ` Ответь на вопрос пользователя: "${question.slice(0, 500)}"` : ''

  // ── Ветка 1: основная модель видит сама → прямой пас ──
  if (mainModelSupportsVision(store)) {
    return {
      success: true,
      output: `Изображение «${args.path}» приложено к этому результату. Проанализируй его напрямую: тип, весь видимый текст (OCR), визуальные детали.${focus}`,
      imageParts: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } }],
    }
  }

  // ── Ветка 2: text-only основная модель → описание от vision-модели ──
  // Тот же структурированный промпт, что и в attachment-flow.
  const prompt = question
    ? `Analyze the image and provide a structured description:\n\n1. TYPE: What is depicted (screenshot, photo, diagram, schema, code, document)\n2. TEXT: All visible text in the image (exactly, without distortion)\n3. VISUAL: Colors, element layout, UI components, icons\n4. CONTEXT: Relative to the question: "${question.slice(0, 1000)}"\n\nAnswer in Russian. Be precise and concise.`
    : `Analyze the image and provide a structured description:\n\n1. TYPE: What is depicted (screenshot, photo, diagram, schema, code, document)\n2. TEXT: All visible text in the image (exactly, without distortion)\n3. VISUAL: Colors, element layout, UI components, icons\n4. CONTEXT: General context that may be useful for the answer\n\nAnswer in Russian. Be precise and concise.`

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
