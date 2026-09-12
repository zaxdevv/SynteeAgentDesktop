/**
 * PluginIframe — общий iframe для ВСЕХ UI-панелей плагинов
 * (правые табы, модальные панели, инлайн-виджеты в чате).
 *
 * Контент (HTML плагина) грузится через syntee-plugin://{pluginId}/{entry}
 * (main отдаёт файлы только из папки плагина) в sandboxed iframe БЕЗ
 * allow-same-origin — DOM приложения недоступен, только postMessage.
 *
 * Мост (протокол):
 *  iframe → parent: {source:'syntee-plugin', rpc:true, id, method, args}
 *      → plugins.uiCall → ответ {source:'syntee-plugin-host', rpc:true, id, ok, result, error}
 *  iframe → parent: {source:'syntee-plugin', data} (legacy) → plugins.uiMessage
 *  push plugins:ui-message (pluginId совпал) → {source:'syntee-plugin-host', data}
 *  загрузка/смена темы → {source:'syntee-plugin-host', theme:{theme,accentColor,dark}}
 *      + plugins.themeChanged (только при изменении, не при маунте)
 *  widgetData → {source:'syntee-plugin-host', widgetData} при onLoad
 */
import { useEffect, useMemo, useRef } from 'react'
import { useUIStore } from '../../../store/ui.store'
import { IFRAME_HOST_METHODS as IFRAME_HOST_METHODS_SHARED } from '@shared/constants'
import './PluginIframe.css'

// Светлые темы — для флага dark в theme-сообщении.
const LIGHT_THEMES = new Set(['light', 'paper', 'latte', 'sepia', 'dawn', 'mist', 'solarized'])

// Прямые host-методы для iframe-панелей (plugins:iframeCall в main,
// белый список + проверка прав по манифесту). Всё остальное — RPC в
// процесс плагина (ui.handle). Единый источник — shared/constants.
const IFRAME_HOST_METHODS = new Set(IFRAME_HOST_METHODS_SHARED)

export interface PluginIframeProps {
  pluginId: string
  /** HTML-файл относительно папки плагина (entry нормализуется, fallback 'index.html'). */
  entry: string
  className?: string
  title?: string
  /** Данные инлайн-виджета — отправляются в iframe при загрузке. */
  widgetData?: unknown
}

export default function PluginIframe({ pluginId, entry, className, title, widgetData }: PluginIframeProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const theme = useUIStore(s => s.theme)
  const accentColor = useUIStore(s => s.accentColor)
  const dark = !LIGHT_THEMES.has(theme)

  // src: syntee-plugin://{pluginId}/{normalized entry}
  const iframeSrc = useMemo(() => {
    const rel = (entry || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '')
    return `syntee-plugin://${pluginId}/${rel}`
  }, [pluginId, entry])

  const postToIframe = (data: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ source: 'syntee-plugin-host', ...data }, '*')
  }

  // ── iframe → parent: RPC (uiCall) и legacy (uiMessage) ──
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { source?: string; rpc?: boolean; id?: string; method?: string; args?: unknown; data?: unknown } | null
      if (!d || d.source !== 'syntee-plugin') return
      // Обрабатываем только сообщения СВОЕГО iframe (на странице может быть
      // несколько iframe одного плагина: таб правой панели + инлайн-виджет).
      if (e.source !== iframeRef.current?.contentWindow) return

      if (d.rpc === true) {
        const method = typeof d.method === 'string' ? d.method : ''
        const id = typeof d.id === 'string' ? d.id : ''
        // Прямой host-метод (read-only белый список) — без хопа через
        // процесс плагина. Иначе — RPC в ui.handle плагина.
        const callPromise = IFRAME_HOST_METHODS.has(method)
          ? window.syntee.plugins.iframeCall({ pluginId, method, args: d.args as Record<string, unknown> | undefined })
          : window.syntee.plugins.uiCall({ pluginId, method, args: d.args as Record<string, unknown> | undefined })
        void callPromise.then((res: { ok: boolean; result?: unknown; error?: unknown }) => {
          const target = (e.source as Window | null)
          target?.postMessage(
            { source: 'syntee-plugin-host', rpc: true, id, ok: res?.ok ?? false, result: res?.result, error: res?.error },
            '*',
          )
        }).catch((err: unknown) => {
          const target = (e.source as Window | null)
          target?.postMessage(
            { source: 'syntee-plugin-host', rpc: true, id, ok: false, error: String((err as Error)?.message ?? err) },
            '*',
          )
        })
        return
      }

      // Legacy fire-and-forget.
      if (e.source === window) return
      void window.syntee.plugins.uiMessage({ pluginId, data: d.data }).catch(() => {})
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [pluginId])

  // ── push плагина → iframe (plugins:ui-message, фильтр по pluginId) ──
  useEffect(() => {
    const off = window.syntee.on('plugins:ui-message', (data: unknown) => {
      const d = data as { pluginId: string; data: unknown }
      if (!d || d.pluginId !== pluginId) return
      postToIframe({ data: d.data })
    })
    return () => { off?.() }
  }, [pluginId])

  // ── Тема: шлём при загрузке iframe и при изменении theme/accentColor ──
  // themeChanged уведомляет main ТОЛЬКО при реальном изменении (не при маунте) —
  // иначе main ответит push'ем → смена темы → цикл.
  const prevThemeRef = useRef<{ theme: string; accentColor: string } | null>(null)

  useEffect(() => {
    const prev = prevThemeRef.current
    prevThemeRef.current = { theme, accentColor }
    if (!prev) return // первый рендер — тема уйдёт через onLoad
    if (prev.theme !== theme || prev.accentColor !== accentColor) {
      postToIframe({ theme: { theme, accentColor, dark } })
      void window.syntee.plugins.themeChanged({ theme, accentColor }).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, accentColor])

  const handleLoad = () => {
    postToIframe({ theme: { theme, accentColor, dark } })
    if (widgetData !== undefined) {
      postToIframe({ widgetData })
    }
  }

  return (
    <iframe
      ref={iframeRef}
      src={iframeSrc}
      title={title}
      // sandbox без allow-same-origin: DOM приложения недоступен.
      // Навигация на внешние URL заблокирована CSP главного окна
      // (frame-src 'self' syntee-plugin:) — frame-src действует и на
      // повторные навигации iframe; вложенные iframe запрещены CSP
      // самой страницы плагина (main/index.ts handlePluginProtocol).
      sandbox="allow-scripts allow-forms"
      className={className ?? 'plugin-iframe'}
      onLoad={handleLoad}
    />
  )
}
