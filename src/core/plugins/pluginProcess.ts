/**
 * pluginProcess — обёртка над utilityProcess одного плагина.
 *
 * Отвечает за:
 *   - spawn изолированного процесса (out/main/plugin-host.js)
 *   - RPC запрос/ответ с requestId и таймаутами
 *   - приём событий (registerTool, log, hostRequest) и колбэки в менеджер
 *   - graceful shutdown (deactivate → kill)
 *
 * Краш процесса плагина НЕ роняет приложение: onExit сообщает менеджеру,
 * тот помечает статус 'error'.
 */

import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import type {
  PluginMsgPluginToHost,
  PluginMsgHostToPlugin,
  PluginMsgInit,
  PluginMsgCallTool,
  PluginMsgCallCommand,
  PluginMsgShutdown,
  PluginMsgUiCall,
  PluginMsgHook,
  PluginMsgCallHandler,
} from './pluginProtocol'
import type {
  PluginLogEntry,
  PluginToolRuntime,
  PluginCommandRuntime,
  PluginUiContribution,
  PluginContextProviderRuntime,
  PluginMarkdownRendererRuntime,
  PluginMessageTagRuntime,
  PluginPromptSectionRuntime,
  PluginSettingsSectionRuntime,
  PluginSearchProviderRuntime,
  PluginAutocompleteRuntime,
  PluginContextMenuRuntime,
  PluginInputActionRuntime,
  PluginThemeContribution,
  PluginBackgroundContribution,
} from '../../shared/types'

/** Таймаут RPC-вызова в процесс плагина (init/callTool/callCommand/shutdown). */
const RPC_TIMEOUT_MS = 60_000
/** Таймаут на ожидание hostRequest-ответа плагину (fetch и т.п.). */
const HOST_REQUEST_TIMEOUT_MS = 60_000
/** Таймаут хука chat:before-send — не должен тормозить отправку сообщения. */
export const HOOK_TIMEOUT_MS = 2_000

interface Waiter {
  resolve: (v: { ok: boolean; output?: string; error?: string; result?: unknown }) => void
  timer: NodeJS.Timeout
}

export interface PluginProcessCallbacks {
  /** Тул зарегистрирован плагином. */
  onToolRegistered: (tool: PluginToolRuntime) => void
  /** Слэш-команда зарегистрирована плагином. */
  onCommandRegistered: (command: PluginCommandRuntime) => void
  /** UI-вклад зарегистрирован плагином. */
  onUiRegistered: (contribution: PluginUiContribution) => void
  /** Context provider зарегистрирован (registerContextProvider). */
  onContextProviderRegistered: (provider: PluginContextProviderRuntime) => void
  /** Рендерер markdown-кодоблоков зарегистрирован. */
  onMarkdownRendererRegistered: (renderer: PluginMarkdownRendererRuntime) => void
  /** Кастомный тег сообщений зарегистрирован (registerMessageTag). */
  onMessageTagRegistered: (tag: PluginMessageTagRuntime) => void
  /** Плагин снял регистрацию тула/команды/панели/секции промпта/тега/секции настроек в рантайме. */
  onUnregistered: (kind: 'tool' | 'command' | 'panel' | 'promptSection' | 'messageTag' | 'settingsSection', name: string) => void
  /** Статическая секция system prompt зарегистрирована (registerPromptSection). */
  onPromptSectionRegistered: (section: PluginPromptSectionRuntime) => void
  /** Секция настроек в SettingsPage зарегистрирована (registerSettingsSection). */
  onSettingsSectionRegistered: (section: PluginSettingsSectionRuntime) => void
  /** Search provider (Spotlight) зарегистрирован. */
  onSearchProviderRegistered: (provider: PluginSearchProviderRuntime) => void
  /** Autocomplete-провайдер инпута зарегистрирован. */
  onAutocompleteRegistered: (provider: PluginAutocompleteRuntime) => void
  /** Пункт контекстного меню сообщений зарегистрирован. */
  onContextMenuRegistered: (item: PluginContextMenuRuntime) => void
  /** Кнопка над полем ввода чата зарегистрирована. */
  onInputActionRegistered: (action: PluginInputActionRuntime) => void
  /** Тема плагина зарегистрирована. */
  onThemeRegistered: (theme: PluginThemeContribution) => void
  /** Фон плагина зарегистрирован. */
  onBackgroundRegistered: (background: PluginBackgroundContribution) => void
  /** Плагин отправил сообщение в свои iframe-панели. */
  onUiPostMessage: (data: unknown) => void
  /** Плагин подписался на события (список всех событий с хендлерами). */
  onEventsSubscribed: (events: string[]) => void
  /** Запись журнала. */
  onLog: (entry: PluginLogEntry) => void
  /** Процесс завершился (сам или по kill). */
  onExit: (code: number) => void
  /** Запрос плагина к host-API. Возвращает { ok, result?, error? }.
   *  requestId — идентификатор RPC (нужен для стриминга ai.chatStream). */
  onHostRequest: (method: string, params: Record<string, unknown>, requestId: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>
}

export class PluginProcess {
  private child: UtilityProcess | null = null
  private waiters = new Map<string, Waiter>()
  private nextId = 0
  private exited = false

  constructor(
    private readonly pluginId: string,
    private readonly pluginDir: string,
    private readonly permissions: string[],
    private readonly callbacks: PluginProcessCallbacks,
    /** Опции запуска: python-рантайм (интерпретатор + SDK для PYTHONPATH). */
    private readonly options: { python?: { exe: string; sdkDir: string } } = {},
  ) {}

  private get hostPath(): string {
    // Отдельная точка входа main-бандла (см. electron.vite.config.ts).
    return join(__dirname, 'plugin-host.js')
  }

  private rpcId(prefix: string): string {
    return `${prefix}-${++this.nextId}-${Date.now()}`
  }

  /** Спавнит процесс и активирует плагин. Бросает при ошибке активации. */
  async start(): Promise<void> {
    const child = utilityProcess.fork(this.hostPath, [], {
      serviceName: `plugin-${this.pluginId}`,
      stdio: 'pipe',
    })
    this.child = child

    child.on('message', (msg) => this.handleMessage(msg as PluginMsgPluginToHost))
    child.on('exit', (code) => {
      if (this.exited) return
      this.exited = true
      // Резолвим всех ждущих ошибкой.
      for (const [, w] of this.waiters) {
        clearTimeout(w.timer)
        w.resolve({ ok: false, error: `Процесс плагина завершился (code ${code})` })
      }
      this.waiters.clear()
      this.callbacks.onExit(code ?? 0)
    })

    const initResult = await this.request('init', {
      type: 'init',
      pluginDir: this.pluginDir,
      permissions: this.permissions,
      env: {
        platform: process.platform,
        appVersion: process.versions.electron,
        locale: process.env.LANG ?? 'en',
      },
      python: this.options.python,
    })
    if (!initResult.ok) {
      // initResult содержит error? — типизировано как { ok: false; error?: string }
      const err = (initResult as { error?: string }).error || 'Активация плагина не удалась'
      this.kill()
      throw new Error(err)
    }
  }

  /** Вызывает тул плагина. */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: string; error?: string }> {
    if (!this.child || this.exited) {
      return { ok: false, error: 'Процесс плагина не запущен' }
    }
    return this.request('callTool', { type: 'callTool', toolName, args })
  }

  /** Вызывает слэш-команду плагина. */
  async callCommand(commandName: string, args: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    if (!this.child || this.exited) {
      return { ok: false, error: 'Процесс плагина не запущен' }
    }
    return this.request('callCommand', { type: 'callCommand', commandName, args })
  }

  /** Отправляет событие хоста (fire-and-forget). */
  sendEvent(event: string, payload: Record<string, unknown>): void {
    if (!this.child || this.exited) return
    try { this.child.postMessage({ type: 'event', event, payload }) } catch { /* dead */ }
  }

  /** Пересылает сообщение из iframe-панели в плагин (fire-and-forget). */
  sendUiMessage(data: unknown): void {
    if (!this.child || this.exited) return
    try { this.child.postMessage({ type: 'uiMessage', data }) } catch { /* dead */ }
  }

  /** RPC-вызов из iframe-панели (synteeBridge.call → ui.handle). */
  async uiCall(method: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (!this.child || this.exited) {
      return { ok: false, error: 'Процесс плагина не запущен' }
    }
    return this.request('uiCall', { type: 'uiCall', method, args })
  }

  /** Хук с ответом (chat:before-send, tool:result, prompt:before-build).
   *  Возвращает { action, content? }. */
  async callHook(event: string, payload: Record<string, unknown>, timeoutMs = HOOK_TIMEOUT_MS): Promise<{ action: 'allow' | 'modify' | 'reject'; content?: string; reason?: string }> {
    if (!this.child || this.exited) {
      return { action: 'allow' }
    }
    const r = await this.request('hook', { type: 'hook', event, payload }, timeoutMs)
    const res = r as { ok?: boolean; result?: { action?: string; content?: string; error?: string }; error?: string }
    const out = res.result as { action?: 'allow' | 'modify' | 'reject'; content?: string; error?: string } | undefined
    if (out && (out.action === 'modify' || out.action === 'reject')) {
      return { action: out.action, content: out.content, reason: out.error }
    }
    return { action: 'allow' }
  }

  /** Вызов зарегистрированного провайдера/хендлера плагина
   *  (context provider / search / autocomplete / context menu). */
  async callHandler(
    kind: 'context' | 'search' | 'autocomplete' | 'menu' | 'aiTool',
    name: string,
    payload: Record<string, unknown>,
    timeoutMs = 3_000,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (!this.child || this.exited) {
      return { ok: false, error: 'Процесс плагина не запущен' }
    }
    const r = await this.request('callHandler', { type: 'callHandler', kind, name, payload } as Omit<PluginMsgCallHandler, 'requestId'>, timeoutMs)
    const res = r as { ok?: boolean; result?: unknown; error?: string }
    return { ok: res.ok !== false, result: res.result, error: res.error }
  }

  /** Graceful shutdown: deactivate() в плагине → kill. */
  async stop(): Promise<void> {
    if (!this.child || this.exited) return
    try {
      await this.request('shutdown', { type: 'shutdown' }, 5_000)
    } catch {
      /* плагин не ответил — просто киляем ниже */
    }
    this.kill()
  }

  /** Жёсткое завершение. */
  kill(): void {
    if (this.exited || !this.child) {
      this.exited = true
      return
    }
    this.exited = true
    try { this.child.kill() } catch { /* already dead */ }
  }

  get isRunning(): boolean {
    return !!this.child && !this.exited
  }

  // ── Внутреннее ──────────────────────────────────────────────────────────

  private request(
    kind: 'init' | 'callTool' | 'callCommand' | 'shutdown' | 'uiCall' | 'hook' | 'callHandler',
    msg: Omit<PluginMsgInit, 'requestId'> | Omit<PluginMsgCallTool, 'requestId'> | Omit<PluginMsgCallCommand, 'requestId'> | Omit<PluginMsgShutdown, 'requestId'> | Omit<PluginMsgUiCall, 'requestId'> | Omit<PluginMsgHook, 'requestId'> | Omit<PluginMsgCallHandler, 'requestId'>,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<{ ok: boolean; output?: string; error?: string; result?: unknown }> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error('Процесс плагина не запущен'))
        return
      }
      const requestId = this.rpcId(kind)
      const timer = setTimeout(() => {
        this.waiters.delete(requestId)
        if (kind === 'shutdown' || kind === 'hook' || kind === 'callHandler') {
          // shutdown/hook/callHandler не должны вешать вызывающего — резолвим «мягко».
          resolve(kind === 'hook'
            ? { ok: true, result: { action: 'allow' } }
            : { ok: false, error: 'timeout' })
        } else {
          reject(new Error(`Таймаут RPC (${kind}) для плагина ${this.pluginId}`))
        }
      }, timeoutMs)
      this.waiters.set(requestId, {
        resolve: (v) => resolve(v),
        timer,
      })
      this.child!.postMessage({ ...msg, requestId } as PluginMsgHostToPlugin)
    })
  }

  private handleMessage(msg: PluginMsgPluginToHost): void {
    switch (msg.type) {
      case 'initResult':
      case 'callToolResult':
      case 'callCommandResult': {
        const w = this.waiters.get(msg.requestId)
        if (w) {
          clearTimeout(w.timer)
          this.waiters.delete(msg.requestId)
          if (msg.type === 'initResult') {
            w.resolve({ ok: msg.ok, error: msg.error })
          } else {
            w.resolve({ ok: msg.ok, output: msg.output, error: msg.error })
          }
        }
        break
      }
      case 'shutdownResult': {
        const w = this.waiters.get(msg.requestId)
        if (w) {
          clearTimeout(w.timer)
          this.waiters.delete(msg.requestId)
          w.resolve({ ok: true })
        }
        break
      }
      case 'registerTool': {
        this.callbacks.onToolRegistered({
          pluginId: this.pluginId,
          name: `plugin__${this.pluginId}__${msg.name}`,
          shortName: msg.name,
          description: msg.description,
          inputSchema: msg.inputSchema ?? { type: 'object', properties: {} },
          requiresApproval: msg.requiresApproval === true,
        })
        break
      }
      case 'registerCommand': {
        this.callbacks.onCommandRegistered({
          pluginId: this.pluginId,
          name: msg.name,
          description: msg.description,
          icon: msg.icon,
        })
        break
      }
      case 'registerUi': {
        this.callbacks.onUiRegistered({
          pluginId: this.pluginId,
          slot: msg.slot ?? 'sidebar',
          type: msg.uiType ?? 'button',
          label: msg.label,
          icon: msg.icon,
          command: msg.command,
          panelId: msg.panelId,
          entry: msg.entry,
        })
        break
      }
      case 'unregisterTool': {
        this.callbacks.onUnregistered('tool', msg.name)
        break
      }
      case 'unregisterCommand': {
        this.callbacks.onUnregistered('command', msg.name)
        break
      }
      case 'unregisterPanel': {
        this.callbacks.onUnregistered('panel', msg.name)
        break
      }
      case 'unregisterPromptSection': {
        this.callbacks.onUnregistered('promptSection', msg.name)
        break
      }
      case 'unregisterMessageTag': {
        this.callbacks.onUnregistered('messageTag', msg.name)
        break
      }
      case 'unregisterSettingsSection': {
        this.callbacks.onUnregistered('settingsSection', msg.name)
        break
      }
      case 'subscribeEvents': {
        this.callbacks.onEventsSubscribed(msg.events ?? [])
        break
      }
      case 'uiCallResult': {
        const w = this.waiters.get(msg.requestId)
        if (w) {
          clearTimeout(w.timer)
          this.waiters.delete(msg.requestId)
          w.resolve({ ok: msg.ok, result: msg.result, error: msg.error })
        }
        break
      }
      case 'hookResult': {
        const w = this.waiters.get(msg.requestId)
        if (w) {
          clearTimeout(w.timer)
          this.waiters.delete(msg.requestId)
          w.resolve({
            ok: msg.ok,
            result: { action: msg.action ?? 'allow', content: msg.content, error: msg.error },
            error: msg.error,
          })
        }
        break
      }
      case 'callHandlerResult': {
        const w = this.waiters.get(msg.requestId)
        if (w) {
          clearTimeout(w.timer)
          this.waiters.delete(msg.requestId)
          w.resolve({ ok: msg.ok, result: msg.result, error: msg.error })
        }
        break
      }
      case 'registerContextProvider': {
        this.callbacks.onContextProviderRegistered({
          pluginId: this.pluginId,
          name: msg.name,
          description: msg.description,
        })
        break
      }
      case 'registerMarkdownRenderer': {
        this.callbacks.onMarkdownRendererRegistered({
          pluginId: this.pluginId,
          language: msg.language,
          entry: msg.entry,
          height: msg.height,
        })
        break
      }
      case 'registerMessageTag': {
        this.callbacks.onMessageTagRegistered({
          pluginId: this.pluginId,
          tag: msg.tag,
          entry: msg.entry,
          height: msg.height,
          description: msg.description,
        })
        break
      }
      case 'registerPromptSection': {
        this.callbacks.onPromptSectionRegistered({
          pluginId: this.pluginId,
          id: msg.id,
          title: msg.title,
          content: msg.content,
        })
        break
      }
      case 'registerSettingsSection': {
        this.callbacks.onSettingsSectionRegistered({
          pluginId: this.pluginId,
          id: msg.id,
          title: msg.title,
          entry: msg.entry,
          icon: msg.icon,
        })
        break
      }
      case 'registerSearchProvider': {
        this.callbacks.onSearchProviderRegistered({
          pluginId: this.pluginId,
          id: msg.id,
          label: msg.label,
        })
        break
      }
      case 'registerAutocomplete': {
        this.callbacks.onAutocompleteRegistered({
          pluginId: this.pluginId,
          trigger: msg.trigger,
        })
        break
      }
      case 'registerContextMenu': {
        this.callbacks.onContextMenuRegistered({
          pluginId: this.pluginId,
          id: msg.id,
          label: msg.label,
          icon: msg.icon,
          scope: msg.scope === 'selection' ? 'selection' : 'message',
          button: msg.button === true,
        })
        break
      }
      case 'registerInputAction': {
        this.callbacks.onInputActionRegistered({
          pluginId: this.pluginId,
          id: msg.id,
          label: msg.label,
          icon: msg.icon,
          tooltip: msg.tooltip,
          command: msg.command,
        })
        break
      }
      case 'registerTheme': {
        this.callbacks.onThemeRegistered({
          pluginId: this.pluginId,
          name: msg.name,
          dark: msg.dark !== false,
          colors: msg.colors ?? {},
        })
        break
      }
      case 'registerBackground': {
        this.callbacks.onBackgroundRegistered({
          pluginId: this.pluginId,
          id: msg.id,
          name: msg.name,
          kind: msg.kind === 'video' ? 'video' : (msg.kind === 'image' ? 'image' : 'shader'),
          src: msg.src,
        })
        break
      }
      case 'uiPostMessage': {
        this.callbacks.onUiPostMessage(msg.data)
        break
      }
      case 'log': {
        this.callbacks.onLog({
          ts: Date.now(),
          level: msg.level,
          message: msg.message,
        })
        break
      }
      case 'hostRequest': {
        // Таймаут-страховка: плагин ждёт ответа; если обработчик завис —
        // отвечаем ошибкой, чтобы промис в плагине не висел вечно.
        const timer = setTimeout(() => {
          this.child?.postMessage({
            type: 'hostResponse',
            requestId: msg.requestId,
            ok: false,
            error: `Таймаут hostRequest: ${msg.method}`,
          } satisfies PluginMsgHostToPlugin)
        }, HOST_REQUEST_TIMEOUT_MS)
        this.callbacks.onHostRequest(msg.method, msg.params, msg.requestId)
          .then(resp => {
            clearTimeout(timer)
            this.child?.postMessage({
              type: 'hostResponse',
              requestId: msg.requestId,
              ok: resp.ok,
              result: resp.result,
              error: resp.error,
            } satisfies PluginMsgHostToPlugin)
          })
          .catch(e => {
            clearTimeout(timer)
            this.child?.postMessage({
              type: 'hostResponse',
              requestId: msg.requestId,
              ok: false,
              error: (e as Error).message,
            } satisfies PluginMsgHostToPlugin)
          })
        break
      }
    }
  }
}
