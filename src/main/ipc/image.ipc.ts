import { ipcMain, BrowserWindow } from 'electron'
import OpenAI from 'openai'
import type Store from 'electron-store'
import type { Provider, ModelParams } from '../../shared/types'
import { getIdentityHeaders } from '../../shared/constants'

export interface ImageGenParams {
  prompt: string
  model?: string
  size?: string
  quality?: string
  style?: string
  n?: number
}

export interface ImageGenResult {
  url?: string
  b64?: string
  revisedPrompt?: string
  error?: string
}

export function registerImageIPC(store: Store, _mainWindow: { getWindow: () => BrowserWindow | null }): void {

  ipcMain.handle('image:generate', async (_, params: ImageGenParams): Promise<ImageGenResult> => {
    const providers = store.get('providers', []) as Provider[]
    const imageProviderId = store.get('imageProviderId', '') as string
    const imageModelId = store.get('imageModelId', '') as string
    const modelId = params.model || imageModelId

    if (!imageProviderId) {
      return { error: 'Не настроена модель генерации изображений. Зайдите в Настройки → AI → Модели → Генерация изображений.' }
    }

    const provider = providers.find(p => p.id === imageProviderId)
    if (!provider) {
      return { error: 'Выбранный провайдер генерации изображений не найден. Проверьте Настройки → AI → Модели.' }
    }

    const apiKey = provider.apiKeys?.find(k => k.trim()) || provider.apiKey || ''
    if (!apiKey) return { error: 'API ключ провайдера не задан' }

    const baseURL = provider.baseUrl

    try {
      const modelParams = store.get('modelParams') as ModelParams | undefined
      const client = new OpenAI({ apiKey, baseURL, defaultHeaders: getIdentityHeaders(modelParams?.anonymousUserAgent ?? false) })
      const size = (params.size || '1024x1024') as Parameters<typeof client.images.generate>[0]['size']

      const response = await client.images.generate({
        model: modelId,
        prompt: params.prompt,
        n: params.n || 1,
        size,
        quality: params.quality as Parameters<typeof client.images.generate>[0]['quality'],
        style: params.style as Parameters<typeof client.images.generate>[0]['style'],
        response_format: 'url',
      })

      const img = response.data?.[0]
      if (!img) return { error: 'Провайдер не вернул изображение' }
      return {
        url: img.url ?? undefined,
        b64: img.b64_json ?? undefined,
        revisedPrompt: img.revised_prompt ?? undefined,
      }
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('image:getSettings', () => {
    return {
      providerId: store.get('imageProviderId', '') as string,
      modelId: store.get('imageModelId', '') as string,
      defaultSize: store.get('imageDefaultSize', '1024x1024') as string,
      defaultQuality: store.get('imageDefaultQuality', 'standard') as string,
    }
  })

  ipcMain.handle('image:setSettings', (_, settings: {
    providerId?: string
    modelId?: string
    defaultSize?: string
    defaultQuality?: string
  }) => {
    if (settings.providerId !== undefined) store.set('imageProviderId', settings.providerId)
    if (settings.modelId !== undefined) store.set('imageModelId', settings.modelId)
    if (settings.defaultSize !== undefined) store.set('imageDefaultSize', settings.defaultSize)
    if (settings.defaultQuality !== undefined) store.set('imageDefaultQuality', settings.defaultQuality)
  })
}
