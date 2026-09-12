/**
 * PluginManager — синглтон в main-процессе.
 *
 * Отвечает за:
 *   - сканирование папок плагинов (глобальные + проектные) и валидацию
 *   - per-plugin состояние (enabled + scope) в electron-store (pluginsState)
 *   - жизненный цикл процессов: start / stop / reload (utilityProcess)
 *   - агрегацию тулов активных плагинов для конкретного чата
 *   - вызов тулов по имени (plugin__{pluginId}__{toolName})
 *   - обработку hostRequest-ов плагинов (storage / clipboard / net / notify)
 *   - push-события в renderer (plugins:changed, plugins:logs)
 *
 * Модель состояний:
 *   - плагин без записи в pluginsState — по умолчанию ВЫключен (opt-in)
 *   - включение = запуск процесса; выключение = graceful stop
 *   - крах процесса → статус 'error', повторная попытка при следующем
 *     включении/reload или при обращении (getActiveToolsForChat не
 *     перезапускает упавшие — как MCP cooldown, но проще: только вручную)
 *
 * Инкогнито: getActiveToolsForChat возвращает [] (приватность).
 */

import Store from 'electron-store'
import { BrowserWindow, app, clipboard, dialog, globalShortcut, net as electronNet, Notification, safeStorage, screen, shell } from 'electron'
import { exec as childExec } from 'child_process'
import * as http from 'http'
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher,
} from 'fs'
import { join, dirname, resolve as resolvePath } from 'path'
import { v4 as uuid } from 'uuid'
import { scanPluginsDir } from './pluginLoader'
import { PluginProcess } from './pluginProcess'
import { PluginStorage } from './pluginStorage'
import { DEFAULT_ENABLED_BUILTINS, getBuiltinPluginsDir, syncBuiltinPlugins, syncBuiltinPluginDir } from './builtinPlugins'
import {
  depsInstalled, detectPython, installRequirements, syncPythonSdk,
  type PythonInfo,
} from './pythonRuntime'
import { installNpmDependencies, npmDepsInstalled } from './npmRuntime'
import { AIClient } from '../ai/AIClient'
import { getMcpManager } from '../mcp/McpManager'
import { getNotificationManager } from '../../main/managers/NotificationManager'
import { runGit } from '../../main/git/runGit'
import { getEmbedder } from '../context/embeddings'
import { readFile as toolReadFile } from '../tools/fileRead'
import { listDirectory as toolListDirectory, findFiles as toolFindFiles } from '../tools/fileTree'
import { searchCode as toolSearchCode } from '../tools/codeSearch'
import { writeFile as toolWriteFile, editFile as toolEditFile } from '../tools/fileEdit'
import { searchWeb as toolSearchWeb } from '../tools/web'
import { getGatewayAuthToken, getGatewayApiUrl } from '../../main/services/gatewayClient'
import { getGatewayModelsCache } from '../tokens/gatewayModelsCache'
import { BUILTIN_MODELS } from '../../shared/data/builtinModels'
import { IPC_EVENTS } from '../../shared/constants'
import { createChat, getAllChats, getChatWorkdirContext, renameChat, deleteChat } from '../db/chats'
import { getMessages, getMessagesPage, saveMessage, editMessageContent, deleteMessageById, getMessageById } from '../db/messages'
import { getAllProjects, createProject, renameProject } from '../db/projects'
import { agentManager } from '../../main/managers/AgentManager'
import { generateImage as toolGenerateImage } from '../tools/image'
import { lastActiveChatId } from '../../main/ipc/chatShared'
import { whisperTranscribe } from '../../main/ipc/voice.ipc'
import { searchMemories, saveMemory } from '../memory/MemoryEngine'
import { matchesCronExpression } from './pluginScheduler'
import type {
  Plugin,
  PluginState,
  PluginRuntime,
  PluginToolRuntime,
  PluginLogEntry,
  PluginPromptInfo,
  PluginCommandRuntime,
  PluginUiContribution,
  PluginThemeInfo,
  PluginWidgetRuntime,
  PluginStatusbarItem,
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
  ExtensionScope,
  Message,
  Provider,
} from '../../shared/types'
import type { SlashCommand } from '../../shared/slashCommands'

/** Cap журнала плагина (кольцевой буфер для UI). */
const LOG_CAP = 200
/** Максимальный размер ответа net.fetch (1 МБ). */
const NET_FETCH_MAX_BYTES = 1_048_576
/** Максимальный размер файла для fs.readFile (5 МБ). */
const FS_READ_MAX_BYTES = 5_242_880
/** Максимальный размер одного файла для записи (fs.writeFile/writeFiles). */
const FS_WRITE_MAX_BYTES = 5_242_880
/** Лимиты fs.writeFiles (батч-скаффолдинг). */
const WRITEFILES_MAX_FILES = 200
const WRITEFILES_MAX_TOTAL_BYTES = 10_485_760
/** Дебаунс fs.watch перед hot-reload (мс). */
const WATCH_DEBOUNCE_MS = 800
/** Троттлинг message:delta в плагины (мс на chatId). */
const DELTA_THROTTLE_MS = 250
/** Троттлинг appendChunk → БД/UI при стриминге ответа плагина (мс). */
const REPLY_CHUNK_THROTTLE_MS = 120
/** Лимит суммарной длины стримингового ответа плагина. */
const REPLY_MAX_LENGTH = 200_000
/** Таймаут одного aiTool-вызова (function calling в ai.chat). */
const AI_TOOL_TIMEOUT_MS = 30_000

/** Разбор WAV-файла → Float32Array mono 16 кГц (линейный ресемплинг).
 *  Для speech.stt: локальный Whisper ожидает именно такой формат.
 *  Поддерживает PCM 16/24/32-bit int и 32/64-bit float, любое число каналов. */
function parseWavToMono16k(buf: Buffer): Float32Array {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('speech.stt: не WAV-файл (ожидался RIFF/WAVE заголовок)')
  }
  let offset = 12
  let sampleRate = 0
  let channels = 1
  let bits = 16
  let isFloat = false
  let dataStart = -1
  let dataLen = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      const audioFormat = buf.readUInt16LE(offset + 8)
      isFloat = audioFormat === 3
      channels = Math.max(1, buf.readUInt16LE(offset + 10))
      sampleRate = buf.readUInt32LE(offset + 12)
      bits = buf.readUInt16LE(offset + 22)
    } else if (id === 'data') {
      dataStart = offset + 8
      dataLen = Math.min(size, buf.length - dataStart)
      break
    }
    offset += 8 + size + (size % 2)
  }
  if (dataStart < 0 || !sampleRate) throw new Error('speech.stt: битый WAV (нет fmt/data чанков)')
  const bytesPerSample = bits / 8
  if (![2, 3, 4, 8].includes(bytesPerSample)) throw new Error(`speech.stt: неподдерживаемая битность WAV (${bits} bit)`)
  const frames = Math.floor(dataLen / (bytesPerSample * channels))
  // 1. Декодинг в mono float [-1..1].
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let acc = 0
    for (let c = 0; c < channels; c++) {
      const p = dataStart + (i * channels + c) * bytesPerSample
      let v = 0
      if (isFloat && bits === 32) v = buf.readFloatLE(p)
      else if (isFloat && bits === 64) v = buf.readDoubleLE(p)
      else if (bits === 16) v = buf.readInt16LE(p) / 32768
      else if (bits === 24) v = ((buf.readUInt8(p) | (buf.readInt8(p + 1) << 8) | (buf.readInt8(p + 2) << 16)) / 8_388_608)
      else if (bits === 32) v = buf.readInt32LE(p) / 2_147_483_648
      acc += v
    }
    mono[i] = acc / channels
  }
  // 2. Ресемплинг в 16 кГц (линейная интерполяция).
  if (sampleRate === 16000) return mono
  const ratio = sampleRate / 16000
  const outLen = Math.max(1, Math.floor(frames / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(frames - 1, i0 + 1)
    const frac = src - i0
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac
  }
  return out
}
/** Лимиты process.exec. */
const EXEC_TIMEOUT_DEFAULT_MS = 30_000
const EXEC_TIMEOUT_MAX_MS = 120_000
const EXEC_MAX_BUFFER = 1_048_576
/** Лимиты ai.chat. */
const AI_MAX_TOKENS = 8192
/** Таймаут context provider (не тормозим сборку промпта). */
const CONTEXT_PROVIDER_TIMEOUT_MS = 2_000
/** Таймаут tool:result / prompt:before-build хуков. */
const TOOL_HOOK_TIMEOUT_MS = 1_500
/** Таймаут search-провайдера (Spotlight). */
const SEARCH_TIMEOUT_MS = 3_000
/** Таймаут autocomplete-провайдера. */
const AUTOCOMPLETE_TIMEOUT_MS = 1_500
/** Лимит текста ai.embed. */
const EMBED_MAX_CHARS = 32_768
/** Лимит вывода git-команд. */
const GIT_MAX_OUTPUT = 262_144
/** Лимит тела webhook-запроса. */
const WEBHOOK_MAX_BODY = 1_048_576

/** Джоба планировщика плагина. */
interface SchedulerJob {
  kind: 'interval' | 'timeout' | 'cron'
  timer?: NodeJS.Timeout
  expr?: string
}

/** Плагинский fs.watch. */
interface PluginFsWatch {
  watcher: FSWatcher
  path: string
}

/** Пункт меню трея от плагина. */
export interface PluginTrayItem {
  pluginId: string
  label: string
  command?: string
  type: 'item' | 'separator'
}

interface RunningPlugin {
  proc: PluginProcess
  tools: Map<string, PluginToolRuntime> // shortName → tool
  commands: Map<string, PluginCommandRuntime> // name → command
  ui: PluginUiContribution[]
  /** Инлайн-виджеты (registerWidget): name → widget. */
  widgets: Map<string, PluginWidgetRuntime>
  /** Context providers: name → provider. */
  contextProviders: Map<string, PluginContextProviderRuntime>
  /** Рендереры markdown-кодоблоков: language → renderer. */
  markdownRenderers: Map<string, PluginMarkdownRendererRuntime>
  /** Кастомные теги сообщений: tag → tag def. */
  messageTags: Map<string, PluginMessageTagRuntime>
  /** Статические секции system prompt: id → section. */
  promptSections: Map<string, PluginPromptSectionRuntime>
  /** Секции настроек в SettingsPage: id → section. */
  settingsSections: Map<string, PluginSettingsSectionRuntime>
  /** Search providers: id → provider. */
  searchProviders: Map<string, PluginSearchProviderRuntime>
  /** Autocomplete: trigger → provider. */
  autocomplete: Map<string, PluginAutocompleteRuntime>
  /** Пункты контекстного меню: id → item. */
  contextMenu: Map<string, PluginContextMenuRuntime>
  /** Кнопки над полем ввода: id → action. */
  inputActions: Map<string, PluginInputActionRuntime>
  /** Темы плагина. */
  themes: PluginThemeContribution[]
  /** Фоны плагина. */
  backgrounds: PluginBackgroundContribution[]
  logs: PluginLogEntry[]
  /** События, на которые плагин подписан (для short-circuit хуков). */
  subscribedEvents: Set<string>
}

export class PluginManager {
  private store: Store
  private storage: PluginStorage
  private win: BrowserWindow | null = null

  /** pluginId → запущенный процесс + агрегаты. */
  private running = new Map<string, RunningPlugin>()
  /** Последний ошибочный статус по pluginId (для UI, когда процесс умер). */
  private errors = new Map<string, string>()
  /** Кэш последнего скана (для getAll без перечитывания диска). */
  private lastScan: Plugin[] = []
  /** fs.watch-еры: путь папки → watcher + debounce. Для hot-reload. */
  private watchers = new Map<string, { watcher: FSWatcher; timer: NodeJS.Timeout | null }>()

  // ── Инфраструктура новых API (все ключуются по pluginId, чистятся в stop) ──
  /** Планировщик: pluginId → (jobId → job). */
  private schedulerJobs = new Map<string, Map<string, SchedulerJob>>()
  /** Hot reload: pluginId → вотчеры entry/plugin.json (разработка плагинов). */
  private hotReloadWatchers = new Map<string, { watchers: FSWatcher[]; timer: NodeJS.Timeout | null }>()
  /** Общий минутный тикер для cron-джоб (создаётся лениво). */
  private cronTicker: NodeJS.Timeout | null = null
  /** Глобальные шорткаты: pluginId → Set<accelerator>. */
  private pluginShortcuts = new Map<string, Set<string>>()
  /** Плагинские fs.watch: pluginId → (watchId → watcher). */
  private pluginWatchers = new Map<string, Map<string, PluginFsWatch>>()
  /** WebSocket-ы плагинов: pluginId → (id → WebSocket). */
  private pluginSockets = new Map<string, Map<string, WebSocket>>()
  /** Status bar: pluginId → (itemId → item). */
  private statusbarItems = new Map<string, Map<string, PluginStatusbarItem>>()
  /** Пункты меню трея: pluginId → items. */
  private trayItems = new Map<string, PluginTrayItem[]>()
  /** Overlay-окно плагина (одно на всё приложение — последний show). */
  private pluginOverlayWin: BrowserWindow | null = null
  private pluginOverlayTimer: NodeJS.Timeout | null = null
  /** Буферы message:delta для троттлинга: chatId → { buffer, timer }. */
  private deltaBuffers = new Map<string, { buffer: string; timer: NodeJS.Timeout | null }>()
  /** Стриминг ответов плагинов (chat.beginReply/appendChunk/endReply):
   *  replyId → { pluginId, chatId, messageId, content, timer }. */
  private pluginReplies = new Map<string, {
    pluginId: string
    chatId: string
    messageId: string
    content: string
    timer: NodeJS.Timeout | null
  }>()
  /** Билдер system prompt (регистрируется chat.ipc) — для prompt.get()
   *  плагинов и превью в UI. Без рекурсии: хук prompt:before-build не зовётся. */
  private promptBuilder: ((chatId?: string) => Promise<string>) | null = null
  /** Webhook-серверы плагинов: pluginId → (port → server). */
  private webhookServers = new Map<string, Map<number, http.Server>>()
  /** Провайдеры моделей, зарегистрированные плагинами: pluginId → Set<storeId>.
   *  Удаляются из store при остановке/краше плагина. */
  private pluginProviders = new Map<string, Set<string>>()
  /** Папка Python SDK (синхронизируется в конструкторе). */
  private pythonSdkDir = ''

  constructor(store: Store) {
    this.store = store
    this.storage = new PluginStorage(app.getPath('userData'))
    // Создаём папку глобальных плагинов сразу — чтобы кнопка «Открыть папку
    // плагинов» и установка из папки работали даже при нулевом количестве
    // плагинов (иначе shell.openPath показывает «Не удается найти путь»).
    if (!existsSync(this.globalPluginsDir)) {
      try { mkdirSync(this.globalPluginsDir, { recursive: true }) } catch { /* ignore */ }
    }
    // Встроенные плагины (resources/builtin-plugins → {userData}/plugins):
    // установка при первом запуске + обновление вместе с приложением.
    try {
      const synced = syncBuiltinPlugins(this.globalPluginsDir)
      for (const id of synced.installed) {
        if (DEFAULT_ENABLED_BUILTINS.has(id)) {
          this.setState(id, { enabled: true, scope: { type: 'global' } })
        }
      }
    } catch (e) {
      console.warn('[plugins] builtin sync failed:', (e as Error).message)
    }
    // Python SDK (resources/python-sdk → {userData}/python-sdk) — реальный
    // путь на диске для PYTHONPATH sidecar-процессов (asar не читается).
    this.pythonSdkDir = syncPythonSdk(app.getPath('userData'))
  }

  setWindow(win: BrowserWindow | null): void {
    this.win = win
  }

  get globalPluginsDir(): string {
    return join(app.getPath('userData'), 'plugins')
  }

  projectPluginsDir(workdir: string): string {
    return join(workdir, '.syntee', 'plugins')
  }

  // ── Скан и состояние ───────────────────────────────────────────────────

  /** Сканирует глобальные + проектные папки. */
  scan(projectWorkdir?: string, projectId?: string): Plugin[] {
    const globalPlugins = scanPluginsDir(this.globalPluginsDir, 'global')
    const projectPlugins = projectWorkdir
      ? scanPluginsDir(this.projectPluginsDir(projectWorkdir), 'project', projectId)
      : []
    // Дедуп по id (глобальный приоритетнее).
    const seen = new Set(globalPlugins.map(p => p.id))
    this.lastScan = [...globalPlugins, ...projectPlugins.filter(p => !seen.has(p.id))]
    // Hot-reload watcher: глобальная папка — всегда; проектная — при скане.
    this.ensureWatcher(this.globalPluginsDir)
    if (projectWorkdir) this.ensureWatcher(this.projectPluginsDir(projectWorkdir))
    return this.lastScan
  }

  // ── Hot-reload (fs.watch) ──────────────────────────────────────────────

  /** Регистрирует рекурсивный watcher на папку плагинов. При изменении
   *  файлов — дебаунс → hot-reload затронутого запущенного плагина.
   *  Разработка плагина: сохранил файл → плагин перезапустился сам. */
  private ensureWatcher(dir: string): void {
    if (this.watchers.has(dir) || !existsSync(dir)) return
    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        const rel = String(filename ?? '')
        // Игнорируем временные файлы редакторов/сборщиков.
        if (/(^|[\\/])~|\.(tmp|crdownload|lock)$/.test(rel)) return
        const entry = this.watchers.get(dir)
        if (entry?.timer) clearTimeout(entry.timer)
        const timer = setTimeout(() => {
          const e = this.watchers.get(dir)
          if (e) e.timer = null
          this.handleFsChange(rel)
        }, WATCH_DEBOUNCE_MS)
        const existing = this.watchers.get(dir)
        if (existing) existing.timer = timer
      })
      this.watchers.set(dir, { watcher, timer: null })
    } catch {
      // recursive watch может не поддерживаться на некоторых платформах —
      // hot-reload просто отключается, остальное работает.
    }
  }

  /** Изменение в папке плагинов: обновляем список (манифест/readme могли
   *  измениться) push-событием в renderer. НЕ перезагружаем запущенные
   *  плагины отсюда — за hot-reload кода отвечает per-plugin вотчер
   *  (setupHotReloadWatcher: dist/ + ui/ + plugin.json). Иначе запись
   *  плагином данных/кэша/.deps.json в свою папку перезапускала его же
   *  (баг: «плагин сам по себе перезапускается»). */
  private handleFsChange(relPath: string): void {
    const pluginId = relPath.split(/[\\/]/)[0]
    if (!pluginId) return
    // Сбрасываем кэш скана — при следующем getAll манифест/readme
    // перечитаются с диска.
    this.lastScan = []
    this.emitChanged()
  }

  /** Остановить все watcher-ы (при выходе). */
  stopWatchers(): void {
    for (const [, entry] of this.watchers) {
      if (entry.timer) clearTimeout(entry.timer)
      try { entry.watcher.close() } catch { /* ignore */ }
    }
    this.watchers.clear()
  }

  /** Состояние плагина (по умолчанию выключен — явный opt-in). */
  getState(pluginId: string): PluginState {
    const stateMap = (this.store.get('pluginsState') as Record<string, PluginState> | undefined) ?? {}
    return stateMap[pluginId] ?? { enabled: false, scope: { type: 'global' } }
  }

  setState(pluginId: string, state: PluginState): void {
    const stateMap = (this.store.get('pluginsState') as Record<string, PluginState> | undefined) ?? {}
    stateMap[pluginId] = state
    this.store.set('pluginsState', stateMap)
  }

  private scopeApplies(scope: ExtensionScope, projectId?: string): boolean {
    if (scope.type === 'global') return true
    if (!projectId || !scope.projectIds?.length) return false
    return scope.projectIds.includes(projectId)
  }

  /** Все плагины с состоянием + runtime-статусом — для UI (popover). */
  getAllWithState(opts: { projectWorkdir?: string; projectId?: string } = {}): PluginRuntime[] {
    const plugins = this.scan(opts.projectWorkdir, opts.projectId)
    return plugins.map(p => {
      const run = this.running.get(p.id)
      return {
        ...p,
        state: this.getState(p.id),
        status: run ? 'running' : (this.errors.get(p.id) ? 'error' : 'stopped'),
        error: this.errors.get(p.id),
        tools: run ? [...run.tools.values()] : [],
        commands: run ? [...run.commands.values()] : [],
        ui: run ? run.ui : [],
        widgets: run ? [...run.widgets.values()] : [],
        contextProviders: run ? [...run.contextProviders.values()] : [],
        markdownRenderers: run ? [...run.markdownRenderers.values()] : [],
        messageTags: run ? [...run.messageTags.values()] : [],
        promptSections: run ? [...run.promptSections.values()] : [],
        settingsSections: run ? [...run.settingsSections.values()] : [],
        searchProviders: run ? [...run.searchProviders.values()] : [],
        autocomplete: run ? [...run.autocomplete.values()] : [],
        contextMenu: run ? [...run.contextMenu.values()] : [],
        inputActions: run ? [...run.inputActions.values()] : [],
        themes: run ? run.themes : [],
        backgrounds: run ? run.backgrounds : [],
        configValues: this.getConfigValues(p.id, p.manifest.config),
        ...(p.manifest.runtime === 'python'
          ? {
            deps: {
              required: p.manifest.requirements ?? [],
              installed: depsInstalled(p.dir, p.manifest.requirements ?? []),
            },
          }
          : p.manifest.dependencies?.length
            ? {
              deps: {
                required: p.manifest.dependencies,
                installed: npmDepsInstalled(p.dir, p.manifest.dependencies),
              },
            }
            : {}),
        logs: run ? run.logs : [],
      }
    })
  }

  // ── Жизненный цикл процессов ───────────────────────────────────────────

  /** Резолвит интерпретатор Python для плагина: runtimePath манифеста →
   *  переменная SYNTEE_PYTHON → авто-детект (python/python3/py). */
  private async resolvePython(manifest: { runtimePath?: string }): Promise<PythonInfo | null> {
    if (manifest.runtimePath && existsSync(manifest.runtimePath)) {
      return { exe: manifest.runtimePath, version: 'runtimePath' }
    }
    return detectPython()
  }

  /** Статус Python для UI (карточки python-плагинов, диагностика). */
  async checkPython(): Promise<{ found: boolean; exe?: string; version?: string }> {
    const info = await detectPython()
    return info ? { found: true, exe: info.exe, version: info.version } : { found: false }
  }

  /** Установка зависимостей плагина (python: pip, node: npm) по кнопке
   *  в карточке UI. */
  async installPluginDeps(pluginId: string): Promise<{ ok: boolean; error?: string; output?: string }> {
    const plugin = this.lastScan.find(p => p.id === pluginId)
      ?? this.scan().find(p => p.id === pluginId)
    if (!plugin) return { ok: false, error: `Плагин не найден: ${pluginId}` }
    // Node-плагин: npm-зависимости.
    const npmDeps = plugin.manifest.runtime !== 'python' ? (plugin.manifest.dependencies ?? []) : []
    if (npmDeps.length) {
      const res = await installNpmDependencies(plugin.dir, npmDeps)
      this.emitChanged()
      return res
    }
    // Python-плагин: pip-зависимости.
    if (plugin.manifest.runtime !== 'python') {
      return { ok: true, output: 'Зависимости не объявлены' }
    }
    const requirements = plugin.manifest.requirements ?? []
    if (!requirements.length) return { ok: true, output: 'Зависимости не объявлены' }
    const info = await this.resolvePython(plugin.manifest)
    if (!info) return { ok: false, error: 'Python не найден — установите Python 3.8+ с python.org' }
    const res = await installRequirements(info.exe, plugin.dir, requirements)
    this.emitChanged()
    return res
  }

  /** Запускает процесс плагина (по id из последнего скана). */
  async start(pluginId: string): Promise<void> {
    if (this.running.has(pluginId)) return
    const plugin = this.lastScan.find(p => p.id === pluginId)
      ?? this.scan().find(p => p.id === pluginId)
    if (!plugin) throw new Error(`Плагин не найден: ${pluginId}`)

    const run: RunningPlugin = {
      proc: null as unknown as RunningPlugin['proc'],
      tools: new Map(),
      commands: new Map(),
      ui: [],
      widgets: new Map(),
      contextProviders: new Map(),
      markdownRenderers: new Map(),
      messageTags: new Map(),
      promptSections: new Map(),
      settingsSections: new Map(),
      searchProviders: new Map(),
      autocomplete: new Map(),
      contextMenu: new Map(),
      inputActions: new Map(),
      themes: [],
      backgrounds: [],
      logs: [],
      subscribedEvents: new Set(),
    }
    // Node-рантайм: при объявленных npm-зависимостях и отсутствии маркера —
    // ставим их в папку плагина (node_modules резолвится из utilityProcess).
    if (plugin.manifest.runtime !== 'python' && plugin.manifest.dependencies?.length) {
      const npmDeps = plugin.manifest.dependencies
      if (!npmDepsInstalled(plugin.dir, npmDeps)) {
        this.pushLog(pluginId, run, 'info', `Установка npm-зависимостей: ${npmDeps.join(', ')}`)
        const res = await installNpmDependencies(plugin.dir, npmDeps, line => {
          this.pushLog(pluginId, run, 'info', `[npm] ${line}`)
        })
        if (!res.ok) {
          const err = `Не удалось установить npm-зависимости (${res.error}). Установите вручную: npm install ${npmDeps.join(' ')} (в папке плагина)`
          this.errors.set(pluginId, err)
          this.pushLog(pluginId, run, 'error', err)
          this.emitChanged()
          throw new Error(err)
        }
        this.pushLog(pluginId, run, 'info', 'npm-зависимости установлены')
      }
    }
    // Python-рантайм: резолвим интерпретатор, при необходимости ставим
    // зависимости (pip) — логи идут в журнал плагина (виден в карточке).
    let python: { exe: string; sdkDir: string } | undefined
    if (plugin.manifest.runtime === 'python') {
      const info = await this.resolvePython(plugin.manifest)
      if (!info) {
        const err = 'Python не найден. Установите Python 3.8+ с python.org (или задайте путь в runtimePath манифеста / переменной SYNTEE_PYTHON) и включите плагин снова.'
        this.errors.set(pluginId, err)
        this.emitChanged()
        throw new Error(err)
      }
      const requirements = plugin.manifest.requirements ?? []
      if (requirements.length && !depsInstalled(plugin.dir, requirements)) {
        this.pushLog(pluginId, run, 'info', `Установка Python-зависимостей: ${requirements.join(', ')}`)
        const res = await installRequirements(info.exe, plugin.dir, requirements, line => {
          this.pushLog(pluginId, run, 'info', `[pip] ${line}`)
        })
        if (!res.ok) {
          const err = `Не удалось установить зависимости (${res.error}). Установите вручную: ${info.exe} -m pip install ${requirements.join(' ')}`
          this.errors.set(pluginId, err)
          this.pushLog(pluginId, run, 'error', err)
          this.emitChanged()
          throw new Error(err)
        }
        this.pushLog(pluginId, run, 'info', 'Зависимости установлены')
      }
      python = { exe: info.exe, sdkDir: this.pythonSdkDir }
    }
    const proc = new PluginProcess(plugin.id, plugin.dir, plugin.manifest.permissions ?? [], {
      onToolRegistered: tool => {
        run.tools.set(tool.shortName, tool)
        this.emitChanged()
      },
      onCommandRegistered: command => {
        run.commands.set(command.name, command)
        this.emitChanged()
      },
      onUiRegistered: contribution => {
        // Дедуп по panelId (right/modal) или label+type (sidebar).
        run.ui = run.ui.filter(u => {
          if (contribution.panelId) return u.panelId !== contribution.panelId
          return !(u.label === contribution.label && u.type === contribution.type)
        })
        run.ui.push(contribution)
        this.emitChanged()
      },
      onContextProviderRegistered: provider => {
        run.contextProviders.set(provider.name, provider)
        this.emitChanged()
      },
      onMarkdownRendererRegistered: renderer => {
        run.markdownRenderers.set(renderer.language.toLowerCase(), renderer)
        this.emitChanged()
      },
      onMessageTagRegistered: tag => {
        run.messageTags.set(tag.tag, tag)
        this.emitChanged()
      },
      onPromptSectionRegistered: section => {
        run.promptSections.set(section.id, section)
        this.emitChanged()
      },
      onSettingsSectionRegistered: section => {
        run.settingsSections.set(section.id, section)
        this.emitChanged()
      },
      onSearchProviderRegistered: provider => {
        run.searchProviders.set(provider.id, provider)
        this.emitChanged()
      },
      onAutocompleteRegistered: provider => {
        run.autocomplete.set(provider.trigger, provider)
        this.emitChanged()
      },
      onContextMenuRegistered: item => {
        run.contextMenu.set(item.id, item)
        this.emitChanged()
      },
      onInputActionRegistered: action => {
        run.inputActions.set(action.id, action)
        this.emitChanged()
      },
      onUnregistered: (kind, name) => {
        if (kind === 'tool') run.tools.delete(name)
        else if (kind === 'command') run.commands.delete(name)
        else if (kind === 'panel') {
          run.ui = run.ui.filter(u => u.panelId !== name)
        } else if (kind === 'promptSection') {
          run.promptSections.delete(name)
        } else if (kind === 'messageTag') {
          run.messageTags.delete(name)
        } else if (kind === 'settingsSection') {
          run.settingsSections.delete(name)
        }
        this.emitChanged()
      },
      onThemeRegistered: theme => {
        run.themes = run.themes.filter(t => t.name !== theme.name)
        run.themes.push(theme)
        this.emitChanged()
      },
      onBackgroundRegistered: background => {
        run.backgrounds = run.backgrounds.filter(b => b.id !== background.id)
        run.backgrounds.push(background)
        this.emitChanged()
      },
      onUiPostMessage: data => {
        this.win?.webContents.send(IPC_EVENTS.PLUGINS_UI_MESSAGE, { pluginId, data })
      },
      onEventsSubscribed: events => {
        run.subscribedEvents = new Set(events)
      },
      onLog: entry => {
        run.logs.push(entry)
        if (run.logs.length > LOG_CAP) run.logs.splice(0, run.logs.length - LOG_CAP)
        this.win?.webContents.send(IPC_EVENTS.PLUGINS_LOGS, { pluginId, logs: run.logs })
      },
      onExit: code => {
        // Процесс умер (краш или stop уже обработан — stop удаляет из running).
        if (this.running.get(pluginId)?.proc === proc) {
          this.running.delete(pluginId)
          // Краш ≠ stop: инфраструктура (globalShortcut, cron, вотчеры,
          // webhook-серверы, tray, statusbar) остаётся в main и утекает —
          // чистим её и здесь, иначе шорткаты живут до перезапуска приложения.
          this.cleanupPluginInfrastructure(pluginId)
          if (code !== 0) {
            this.errors.set(pluginId, `Процесс плагина завершился (code ${code})`)
          }
          this.emitChanged()
        }
      },
      onHostRequest: (method, params) => this.handleHostRequest(pluginId, method, params),
    }, { python })
    run.proc = proc
    this.errors.delete(pluginId)
    try {
      await proc.start()
      this.running.set(pluginId, run)
      this.pushLog(pluginId, run, 'info', `Плагин запущен (${plugin.manifest.name} v${plugin.manifest.version})`)
      // Dev-режим + builtin-плагин: следим ещё и за ИСХОДНИКОМ в репозитории
      // (resources/builtin-plugins/{id}) — правка там → перезаливка копии в
      // {userData} → reload с новым кодом. Правишь плагин в гите — он сам
      // обновляется, копировать руками не нужно.
      let builtinSrcDir: string | undefined
      if (plugin.manifest.builtin && !app.isPackaged) {
        const src = join(getBuiltinPluginsDir(), pluginId)
        if (existsSync(src)) builtinSrcDir = src
      }
      this.setupHotReloadWatcher(pluginId, plugin.dir, plugin.manifest.main, {
        extraWatchDir: builtinSrcDir,
        onBeforeReload: builtinSrcDir
          ? () => { syncBuiltinPluginDir(builtinSrcDir!, plugin.dir) }
          : undefined,
      })
    } catch (e) {
      this.errors.set(pluginId, (e as Error).message)
      this.emitChanged()
      throw e
    }
    this.emitChanged()
  }

  /** Hot reload для разработчиков: следим за ИСХОДНИКАМИ запущенного
   *  плагина (папки dist/ и ui/ рекурсивно + plugin.json); при изменении
   *  (дебаунс 800 мс) — reload. Правка ЛЮБОГО файла кода/UI подхватывается
   *  автоматически. Данные плагина (storage, кэш вне dist/ui) не смотрим —
   *  их запись не должна вызывать перезапуск.
   *
   *  Защита от ложных срабатываний (Windows: антивирус, индексатор поиска,
   *  бэкап-софт трогают файлы БЕЗ изменения содержимого — fs.watch при
   *  этом всё равно шлёт события):
   *   - события без filename игнорируются;
   *   - временные файлы редакторов (~, .tmp, .swp, .lock…) игнорируются;
   *   - сверяем mtime файла с последним известным: не изменился — не
   *     перезагружаем (реальная правка всегда меняет mtime). */
  private setupHotReloadWatcher(
    pluginId: string,
    pluginDir: string,
    mainEntry: string,
    opts?: {
      /** Дополнительная папка для наблюдения (dev: исходник builtin-плагина
       *  в resources/builtin-plugins — правка там дёргает тот же reload). */
      extraWatchDir?: string
      /** Вызывается перед reload (dev: перезаливка builtin-копии из репо). */
      onBeforeReload?: () => void
    },
  ): void {
    this.closeHotReloadWatcher(pluginId)
    // Код лежит в папке entry (обычно dist/) — следим за ней целиком +
    // ui/ + манифест. Если entry в корне (одиночный index.js) — следим
    // только за ним и plugin.json.
    const entryDir = dirname(join(pluginDir, mainEntry))
    const watchTargets: Array<{ target: string; recursive: boolean; label: string }> = []
    if (entryDir !== pluginDir) {
      watchTargets.push({ target: entryDir, recursive: true, label: mainEntry + ' (папка)' })
    } else {
      watchTargets.push({ target: join(pluginDir, mainEntry), recursive: false, label: mainEntry })
    }
    watchTargets.push({ target: join(pluginDir, 'ui'), recursive: true, label: 'ui/' })
    watchTargets.push({ target: join(pluginDir, 'plugin.json'), recursive: false, label: 'plugin.json' })
    if (opts?.extraWatchDir) {
      watchTargets.push({ target: opts.extraWatchDir, recursive: true, label: 'builtin-src/' })
    }

    // Entry создаём ЗАРАНЕЕ и таймер дебаунса храним в нём: иначе
    // closeHotReloadWatcher не сможет отменить висящий setTimeout →
    // отложенный reload срабатывал уже после закрытия вотчера.
    const entry: { watchers: FSWatcher[]; timer: NodeJS.Timeout | null } = { watchers: [], timer: null }
    this.hotReloadWatchers.set(pluginId, entry)
    /** Последний известный mtime файла → защита от ложных событий. */
    const mtimes = new Map<string, number>()
    /** Снапшот mtime всех файлов наблюдаемых путей на момент установки
     *  вотчера — чтобы ПЕРВОЕ же событие по файлу (например, ложное
     *  касание антивирусом) сравнивалось с реальным состоянием, а не
     *  считалось изменением. */
    const snapshotMtimes = (dir: string, depth = 0): void => {
      if (depth > 6) return
      let entries: string[]
      try { entries = readdirSync(dir) } catch { return }
      for (const name of entries) {
        const full = join(dir, name)
        try {
          const st = statSync(full)
          if (st.isDirectory()) snapshotMtimes(full, depth + 1)
          else mtimes.set(full, st.mtimeMs)
        } catch { /* файл исчез между readdir и stat — ок */ }
      }
    }
    for (const t of watchTargets) {
      try {
        const st = statSync(t.target)
        if (st.isDirectory()) snapshotMtimes(t.target)
        else mtimes.set(t.target, st.mtimeMs)
      } catch { /* путь не существует — вотчер его и не создаст */ }
    }
    const fire = (label: string) => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = null
        // Перезагружаем только если плагин всё ещё включён (reload()
        // поднимет и упавший — удобнее для разработки).
        if (this.getState(pluginId).enabled === false) return
        console.log(`[plugins] hot reload: ${pluginId} (изменён ${label})`)
        // Dev/builtin: перезаливаем копию из репозитория ДО reload —
        // reload загрузит уже новый код. (События от перезаливки самой
        // копии в {userData} отменяются вместе с этим вотчером в stop().)
        try { opts?.onBeforeReload?.() } catch { /* ignore */ }
        void this.reload(pluginId).catch(err => {
          console.warn(`[plugins] hot reload ${pluginId} не удался:`, (err as Error).message)
        })
      }, 800)
    }
    /** Событие вотчера: проверяем, что файл реально изменился. */
    const onFsEvent = (target: { target: string; recursive: boolean; label: string }, filename: string | null) => {
      if (!filename) return // событие без имени файла — не знаем, что менять
      const name = String(filename)
      // Временные файлы редакторов/сборщиков — не код.
      if (/(^|[\\/])~|\.(tmp|crdownload|lock|swp|bak|log)$/.test(name)) return
      // Абсолютный путь: filename относителен к наблюдаемой папке
      // (recursive-режим) или совпадает с именем наблюдаемого файла.
      const abs = target.recursive
        ? join(target.target, name)
        : (mtimes.has(target.target) ? target.target : join(target.target, name))
      let mtime = 0
      try { mtime = statSync(abs).mtimeMs } catch { /* файл удалён — реальное изменение */ }
      const prev = mtimes.get(abs)
      mtimes.set(abs, mtime)
      // Файла не было в снапшоте (новый файл) → изменение. Был и mtime
      // совпадает → ложное событие (антивирус/индексатор тронул файл
      // без правки) — игнорируем. Реальная правка всегда меняет mtime.
      // Сравнение с допуском: на Windows mtimeMs одного и того же
      // нетронутого файла «гуляет» на ~0.1 мс между stat-вызовами
      // (округление float), строгое равенство даёт ложные reload.
      if (prev !== undefined && Math.abs(prev - mtime) < 2) return
      fire(`${name} [${target.label}]`)
    }
    for (const t of watchTargets) {
      try {
        const w = watch(t.target, { persistent: false, recursive: t.recursive }, (_event, filename) =>
          onFsEvent(t, filename ?? null))
        entry.watchers.push(w)
      } catch { /* файл/папка может не существовать — пропускаем */ }
    }
  }

  private closeHotReloadWatcher(pluginId: string): void {
    const entry = this.hotReloadWatchers.get(pluginId)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      for (const w of entry.watchers) {
        try { w.close() } catch { /* ignore */ }
      }
      this.hotReloadWatchers.delete(pluginId)
    }
  }

  /** Останавливает процесс плагина. */
  async stop(pluginId: string): Promise<void> {
    const run = this.running.get(pluginId)
    if (!run) return
    this.running.delete(pluginId)
    this.cleanupPluginInfrastructure(pluginId)
    await run.proc.stop()
    this.emitChanged()
  }

  /** Очистка всей инфраструктуры плагина (таймеры, шорткаты, вотчеры,
   *  сокеты, statusbar, tray). Вызывается в stop() ДО завершения процесса
   *  и в onExit при краше. */
  private cleanupPluginInfrastructure(pluginId: string): void {
    // Незавершённые стриминговые ответы плагина — финализируем как есть.
    for (const [replyId, entry] of [...this.pluginReplies]) {
      if (entry.pluginId === pluginId) this.flushPluginReply(replyId, true)
    }
    // Зарегистрированные плагином провайдеры моделей — убираем из store
    // (вместе с плагином уходит и его endpoint).
    const provs = this.pluginProviders.get(pluginId)
    if (provs && provs.size > 0) {
      try {
        const list = (this.store.get('providers', []) as Array<{ id: string }>).filter(p => !provs.has(p.id))
        this.store.set('providers', list)
      } catch { /* ignore */ }
      this.pluginProviders.delete(pluginId)
    }
    // Hot reload-вотчеры.
    this.closeHotReloadWatcher(pluginId)
    // Планировщик.
    const jobs = this.schedulerJobs.get(pluginId)
    if (jobs) {
      for (const job of jobs.values()) {
        if (job.timer) clearTimeout(job.timer)
      }
      jobs.clear()
      this.schedulerJobs.delete(pluginId)
      // Если cron-джоб больше нет ни у кого — глушим минутный тикер.
      if (![...this.schedulerJobs.values()].some(m => [...m.values()].some(j => j.kind === 'cron'))) {
        if (this.cronTicker) {
          clearInterval(this.cronTicker)
          this.cronTicker = null
        }
      }
    }
    // Глобальные шорткаты.
    const accs = this.pluginShortcuts.get(pluginId)
    if (accs) {
      for (const acc of accs) {
        try { globalShortcut.unregister(acc) } catch { /* ignore */ }
      }
      accs.clear()
      this.pluginShortcuts.delete(pluginId)
    }
    // fs.watch-еры.
    const watches = this.pluginWatchers.get(pluginId)
    if (watches) {
      for (const w of watches.values()) {
        try { w.watcher.close() } catch { /* ignore */ }
      }
      watches.clear()
      this.pluginWatchers.delete(pluginId)
    }
    // WebSocket-ы.
    const sockets = this.pluginSockets.get(pluginId)
    if (sockets) {
      for (const ws of sockets.values()) {
        try { ws.close() } catch { /* ignore */ }
      }
      sockets.clear()
      this.pluginSockets.delete(pluginId)
    }
    // Status bar — пушим пустой снапшот.
    if (this.statusbarItems.has(pluginId)) {
      this.statusbarItems.delete(pluginId)
      this.win?.webContents.send(IPC_EVENTS.PLUGINS_STATUSBAR, { pluginId, items: [] })
    }
    // Меню трея.
    if (this.trayItems.has(pluginId)) {
      this.trayItems.delete(pluginId)
      this.notifyTrayMenuChanged()
    }
    // Webhook-серверы.
    const servers = this.webhookServers.get(pluginId)
    if (servers) {
      for (const srv of servers.values()) {
        try { srv.close() } catch { /* ignore */ }
      }
      servers.clear()
      this.webhookServers.delete(pluginId)
    }
  }

  /** Hot reload: stop + start. */
  async reload(pluginId: string): Promise<void> {
    await this.stop(pluginId)
    this.errors.delete(pluginId)
    this.lastScan = [] // форсируем перескан (манифест мог измениться)
    await this.start(pluginId)
  }

  /** Включение/выключение из UI. Consent: плагин с permissions включается
   *  только после подтверждения прав пользователем (state.consented). */
  async setEnabled(pluginId: string, enabled: boolean, projectWorkdir?: string, projectId?: string): Promise<void> {
    const state = this.getState(pluginId)
    if (enabled) {
      this.scan(projectWorkdir, projectId)
      const plugin = this.lastScan.find(p => p.id === pluginId)
      const perms = plugin?.manifest.permissions ?? []
      if (perms.length > 0 && !state.consented) {
        throw new Error('Требуется подтверждение прав плагина (consent)')
      }
    }
    this.setState(pluginId, { ...state, enabled })
    if (enabled) {
      // Пересканируем чтобы найти плагин (start использует lastScan).
      this.scan(projectWorkdir, projectId)
      await this.start(pluginId)
    } else {
      await this.stop(pluginId)
    }
  }

  /** Подтверждение прав (consent-диалог в UI). */
  setConsented(pluginId: string, consented: boolean): void {
    const state = this.getState(pluginId)
    this.setState(pluginId, { ...state, consented })
  }

  setScope(pluginId: string, scope: ExtensionScope): void {
    const state = this.getState(pluginId)
    this.setState(pluginId, { ...state, scope })
  }

  /** Остановить все процессы (при выходе из приложения). */
  async shutdownAll(): Promise<void> {
    this.stopWatchers()
    this.overlayHide()
    for (const [chatId, e] of this.deltaBuffers) {
      if (e.timer) clearTimeout(e.timer)
      this.deltaBuffers.delete(chatId)
    }
    await Promise.allSettled([...this.running.keys()].map(id => this.stop(id)))
    this.storage.flushAll()
  }

  // ── Команды ────────────────────────────────────────────────────────────

  /**
   * Слэш-команды активных плагинов для UI (автокомплит ChatInput).
   * Возвращает SlashCommand-подобные объекты с маркером plugin —
   * ChatPage перехватывает их ДО агента и вызывает executeCommand.
   */
  getCommandsForUI(opts: { projectWorkdir?: string; projectId?: string } = {}): SlashCommand[] {
    const plugins = this.scan(opts.projectWorkdir, opts.projectId)
    const out: SlashCommand[] = []
    for (const plugin of plugins) {
      const state = this.getState(plugin.id)
      if (!state.enabled) continue
      if (!this.scopeApplies(state.scope, opts.projectId)) continue
      const run = this.running.get(plugin.id)
      if (!run) continue
      for (const cmd of run.commands.values()) {
        out.push({
          name: cmd.name,
          label: `/${cmd.name}`,
          description: `${cmd.description} · ${plugin.manifest.name}`,
          icon: cmd.icon || 'puzzle',
          systemPrompt: () => '',
          source: 'user',
          custom: true,
          plugin: { pluginId: plugin.id, name: cmd.name },
        })
      }
    }
    return out
  }

  /** Вызов слэш-команды плагина. */
  async executeCommand(pluginId: string, commandName: string, args: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    const run = this.running.get(pluginId)
    if (!run) return { ok: false, error: `Плагин не запущен: ${pluginId}` }
    return run.proc.callCommand(commandName, args)
  }

  // ── Хуки ───────────────────────────────────────────────────────────────

  /** Рассылает событие chat:message всем запущенным плагинам.
   *  Fire-and-forget — НИКОГДА не блокирует отправку сообщения в чате.
   *  payload: { chatId, content, role, messageId, attachments? }. */
  emitChatMessage(chatId: string, content: string, extra?: {
    role?: string
    messageId?: string
    attachments?: Array<{ name?: string; kind?: string; path?: string }>
  }): void {
    const payload: Record<string, unknown> = { chatId, content }
    if (extra?.role) payload.role = extra.role
    if (extra?.messageId) payload.messageId = extra.messageId
    if (extra?.attachments?.length) {
      payload.attachments = extra.attachments.slice(0, 20).map(a => ({ name: a.name, kind: a.kind, path: a.path }))
    }
    for (const [pluginId, run] of this.running) {
      try {
        run.proc.sendEvent('chat:message', payload)
      } catch (e) {
        console.warn(`[plugins] emitChatMessage → ${pluginId} failed:`, (e as Error).message)
      }
    }
  }

  /** Жизненный цикл панелей: renderer сообщает об открытии/закрытии панели
   *  плагина → событие 'panel:opened'/'panel:closed' в процесс (если
   *  подписан). Плагин может лениво грузить данные только когда панель
   *  реально видна. */
  emitPanelLifecycle(pluginId: string, action: 'opened' | 'closed', panelId: string): void {
    const run = this.running.get(pluginId)
    if (!run) return
    const event = action === 'opened' ? 'panel:opened' : 'panel:closed'
    if (!run.subscribedEvents.has(event)) return
    try {
      run.proc.sendEvent(event, { panelId })
    } catch (e) {
      console.warn(`[plugins] emitPanelLifecycle → ${pluginId} failed:`, (e as Error).message)
    }
  }

  /** Хук chat:before-send — плагины могут модифицировать или отклонить
   *  сообщение. Опрашиваются ТОЛЬКО плагины с подписчиками (short-circuit),
   *  таймаут каждого — HOOK_TIMEOUT_MS (не тормозим чат). */
  async beforeChatSend(chatId: string, content: string): Promise<{ allowed: boolean; content: string; reason?: string }> {
    let result = content
    for (const [pluginId, run] of this.running) {
      if (!run.subscribedEvents.has('chat:before-send')) continue
      try {
        const r = await run.proc.callHook('chat:before-send', { chatId, content: result })
        if (r.action === 'reject') {
          return { allowed: false, content: result, reason: r.reason || `Отклонено плагином ${pluginId}` }
        }
        if (r.action === 'modify' && typeof r.content === 'string') {
          result = r.content
        }
      } catch (e) {
        console.warn(`[plugins] beforeChatSend → ${pluginId} failed:`, (e as Error).message)
      }
    }
    return { allowed: true, content: result }
  }

  /** Событие tool:call — вызов любого тула агентом (fire-and-forget). */
  emitToolCall(toolName: string, args: Record<string, unknown>): void {
    for (const run of this.running.values()) {
      try {
        run.proc.sendEvent('tool:call', { toolName, args })
      } catch { /* dead — ок */ }
    }
  }

  /** Рассылка события ТОЛЬКО плагинам с подписчиками на него
   *  (short-circuit — иначе message:delta зафлудит процессы). */
  private emitToSubscribed(event: string, payload: Record<string, unknown>): void {
    for (const run of this.running.values()) {
      if (!run.subscribedEvents.has(event)) continue
      try {
        run.proc.sendEvent(event, payload)
      } catch { /* dead — ок */ }
    }
  }

  /** Жизненный цикл агента: 'started' | 'finished' | 'error'. */
  emitAgentStatus(chatId: string, status: 'started' | 'finished' | 'error', toolName?: string): void {
    this.emitToSubscribed('agent:status', { chatId, status, toolName })
  }

  /** Пользователь переключил активный чат (chat:setActive из renderer). */
  emitChatSwitched(chatId: string | null): void {
    this.emitToSubscribed('chat:switched', { chatId })
  }

  /** Главное окно получило фокус. */
  emitAppFocus(): void {
    this.emitToSubscribed('app:focus', {})
  }

  /** Стриминг ответа агента — с троттлингом DELTA_THROTTLE_MS на chatId. */
  emitMessageDelta(chatId: string, delta: string): void {
    if (!delta) return
    let entry = this.deltaBuffers.get(chatId)
    if (!entry) {
      entry = { buffer: '', timer: null }
      this.deltaBuffers.set(chatId, entry)
    }
    entry.buffer += delta
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      const e = this.deltaBuffers.get(chatId)
      if (!e) return
      e.timer = null
      if (e.buffer) {
        this.emitToSubscribed('message:delta', { chatId, delta: e.buffer })
        e.buffer = ''
      }
    }, DELTA_THROTTLE_MS)
  }

  /** Агент завершил ответ в чате. */
  emitChatCompleted(chatId: string): void {
    // Флашим остатки дельт до события завершения.
    const entry = this.deltaBuffers.get(chatId)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      if (entry.buffer) {
        this.emitToSubscribed('message:delta', { chatId, delta: entry.buffer })
      }
      this.deltaBuffers.delete(chatId)
    }
    this.emitToSubscribed('chat:completed', { chatId })
  }

  /** One-off LLM-запрос от плагина через модель/провайдер приложения.
   *  messages — vision-вариант: массив частей { type:'text'|'image' }. */
  async aiChat(params: {
    prompt?: string
    messages?: Array<{ type: string; text?: string; path?: string; url?: string; base64?: string }>
    system?: string
    model?: string
    maxTokens?: number
    /** Function calling: декларации тулов (хендлеры живут в процессе
     *  плагина — вызываются через callHandler kind 'aiTool'). */
    tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>
    /** Подмешать историю чата (chatId, по умолчанию активный). */
    chatContext?: boolean
    chatId?: string
    /** pluginId вызывающего плагина — для роутинга aiTool-вызовов. */
    pluginId?: string
  }): Promise<string> {
    const client = new AIClient(this.store)
    const maxTokens = Math.min(Math.max(1, Number(params.maxTokens) || 1024), AI_MAX_TOKENS)
    const opts = params.model ? { model: String(params.model), maxTokens } : { maxTokens }

    // Function calling / chatContext — отдельный путь (текстовый).
    const tools = (Array.isArray(params.tools) ? params.tools : []).filter(t => t && typeof t.name === 'string' && t.name)
    if (tools.length > 0 || params.chatContext === true) {
      const prompt = Array.isArray(params.messages)
        ? params.messages.filter(m => m?.type === 'text').map(m => String(m.text ?? '')).join('\n')
        : String(params.prompt ?? '')
      if (!prompt) throw new Error('ai.chat: prompt обязателен')
      // История чата (последние 40 текстовых сообщений).
      const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = []
      if (params.chatContext === true) {
        const chatId = String(params.chatId || lastActiveChatId || '')
        if (chatId) {
          const hist = getMessages(chatId)
            .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
            .slice(-40)
          for (const m of hist) msgs.push({ role: m.role as 'user' | 'assistant', content: m.content })
        }
      }
      msgs.push({ role: 'user', content: prompt })
      if (tools.length > 0) {
        const pluginId = String(params.pluginId ?? '')
        const run = pluginId ? this.running.get(pluginId) : undefined
        if (!run) throw new Error('ai.chat: процесс плагина не найден (tools недоступны)')
        return client.completeWithTools(
          msgs,
          tools.map(t => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description || `Tool ${t.name}`,
              parameters: t.parameters ?? { type: 'object', properties: {} },
            },
          })),
          async (name, args) => {
            const r = await run.proc.callHandler('aiTool', name, { args }, AI_TOOL_TIMEOUT_MS)
            if (!r.ok) throw new Error(r.error || `AI-tool ${name} failed`)
            return r.result
          },
          'main',
          params.system ? String(params.system) : undefined,
          opts,
        )
      }
      return client.complete(msgs as never, 'main', params.system ? String(params.system) : undefined, opts)
    }

    // Vision: собираем content-части (text + image_url с data URL).
    if (Array.isArray(params.messages) && params.messages.length > 0) {
      const parts: Array<Record<string, unknown>> = []
      for (const m of params.messages) {
        if (m?.type === 'text' && typeof m.text === 'string') {
          parts.push({ type: 'text', text: m.text })
        } else if (m?.type === 'image') {
          let url = ''
          if (m.path) {
            const p = String(m.path)
            if (!existsSync(p)) throw new Error(`ai.chat: файл не найден: ${p}`)
            const st = statSync(p)
            if (st.size > 10_485_760) throw new Error('ai.chat: картинка больше 10 МБ')
            const buf = readFileSync(p)
            const ext = p.split('.').pop()?.toLowerCase() ?? 'png'
            const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : (ext === 'webp' ? 'image/webp' : 'image/png')
            url = `data:${mime};base64,${buf.toString('base64')}`
          } else if (m.url) {
            url = String(m.url)
          } else if (m.base64) {
            url = `data:image/png;base64,${String(m.base64)}`
          }
          if (!url) throw new Error('ai.chat: image-часть требует path/url/base64')
          parts.push({ type: 'image_url', image_url: { url } })
        }
      }
      if (parts.length === 0) throw new Error('ai.chat: пустой messages')
      return client.complete(
        [{ role: 'user', content: parts as unknown } as never],
        'main',
        params.system ? String(params.system) : undefined,
        opts,
      )
    }
    const prompt = String(params.prompt ?? '')
    if (!prompt) throw new Error('ai.chat: prompt обязателен')
    return client.complete(
      [{ role: 'user', content: prompt }],
      'main',
      params.system ? String(params.system) : undefined,
      opts,
    )
  }

  /** Стриминговый LLM-запрос от плагина: дельты → событие 'ai:delta'
   *  { requestId, delta } в процесс плагина, финал — полный текст. */
  async aiChatStream(pluginId: string, requestId: string, params: {
    prompt?: string
    messages?: Array<{ type: string; text?: string; path?: string; url?: string; base64?: string }>
    system?: string
    model?: string
    maxTokens?: number
  }): Promise<string> {
    // Vision-части не поддерживаем в стриминге (упрощение) — только текст.
    const prompt = Array.isArray(params.messages)
      ? params.messages.filter(m => m?.type === 'text').map(m => String(m.text ?? '')).join('\n')
      : String(params.prompt ?? '')
    if (!prompt) throw new Error('ai.chatStream: prompt обязателен')
    const client = new AIClient(this.store)
    const send = (delta: string) => {
      try { this.running.get(pluginId)?.proc.sendEvent('ai:delta', { requestId, delta }) } catch { /* dead */ }
    }
    return new Promise<string>((resolve, reject) => {
      void client.streamChat(
        [{ role: 'user', content: prompt }],
        {
          onToken: token => send(token),
          onDone: fullText => resolve(fullText),
          onError: err => reject(err),
        },
        'main',
        params.system ? String(params.system) : undefined,
      ).catch(reject)
    })
  }

  // ── Провайдеры и хуки (context / search / autocomplete / menu) ──────────

  /** Collect context: все context providers всех запущенных плагинов.
   *  Таймаут на провайдера, ошибки молча пропускаются — промпт не тормозим. */
  async collectContext(chatId: string): Promise<Array<{ name: string; content: string }>> {
    const out: Array<{ name: string; content: string }> = []
    for (const [pluginId, run] of this.running) {
      for (const [name] of run.contextProviders) {
        try {
          const r = await run.proc.callHandler('context', name, { chatId }, CONTEXT_PROVIDER_TIMEOUT_MS)
          if (r.ok && typeof r.result === 'string' && r.result.trim()) {
            out.push({ name, content: r.result.trim().slice(0, 16_384) })
          } else if (!r.ok) {
            console.warn(`[plugins] context provider ${pluginId}/${name} failed: ${r.error}`)
          }
        } catch (e) {
          console.warn(`[plugins] context provider ${pluginId}/${name} error: ${(e as Error).message}`)
        }
      }
    }
    return out
  }

  /** Хук tool:result — плагины могут модифицировать результат тула ДО того,
   *  как его увидит модель. Опрашиваются только подписчики (short-circuit). */
  async runToolResultHook(toolName: string, args: Record<string, unknown>, result: string): Promise<string> {
    let content = result
    for (const [pluginId, run] of this.running) {
      if (!run.subscribedEvents.has('tool:result')) continue
      try {
        const r = await run.proc.callHook('tool:result', { toolName, args, result: content }, TOOL_HOOK_TIMEOUT_MS)
        if (r.action === 'modify' && typeof r.content === 'string') {
          content = r.content
        }
      } catch (e) {
        console.warn(`[plugins] tool:result hook → ${pluginId} failed: ${(e as Error).message}`)
      }
    }
    return content
  }

  /** Хук prompt:before-build — последняя точка вмешательства в system prompt. */
  async runPromptHook(chatId: string, prompt: string): Promise<string> {
    let content = prompt
    for (const [pluginId, run] of this.running) {
      if (!run.subscribedEvents.has('prompt:before-build')) continue
      try {
        const r = await run.proc.callHook('prompt:before-build', { chatId, prompt: content }, TOOL_HOOK_TIMEOUT_MS)
        if (r.action === 'modify' && typeof r.content === 'string') {
          content = r.content
        }
      } catch (e) {
        console.warn(`[plugins] prompt:before-build hook → ${pluginId} failed: ${(e as Error).message}`)
      }
    }
    return content
  }

  /** Поиск по всем search-провайдерам (Spotlight). Параллельно, с таймаутом. */
  async searchAll(query: string): Promise<Array<{
    pluginId: string
    providerId: string
    label: string
    items: Array<{ id: string; label: string; sub?: string; icon?: string }>
  }>> {
    const tasks: Array<Promise<{
      pluginId: string
      providerId: string
      label: string
      items: Array<{ id: string; label: string; sub?: string; icon?: string }>
    }>> = []
    for (const [pluginId, run] of this.running) {
      for (const [providerId, provider] of run.searchProviders) {
        tasks.push((async () => {
          const r = await run.proc.callHandler('search', providerId, { query }, SEARCH_TIMEOUT_MS)
          const raw = (r.ok && Array.isArray(r.result)) ? r.result : []
          const items = raw
            .filter(it => it && typeof it === 'object' && typeof (it as { label?: unknown }).label === 'string')
            .slice(0, 20)
            .map((it, i) => {
              const o = it as { id?: unknown; label: string; sub?: unknown; icon?: unknown }
              return {
                id: typeof o.id === 'string' ? o.id : String(i),
                label: String(o.label),
                sub: typeof o.sub === 'string' ? o.sub : undefined,
                icon: typeof o.icon === 'string' ? o.icon : undefined,
              }
            })
          return { pluginId, providerId, label: provider.label, items }
        })().catch(() => ({ pluginId, providerId, label: provider.label, items: [] })))
      }
    }
    const settled = await Promise.all(tasks)
    return settled.filter(s => s.items.length > 0)
  }

  /** Клик по результату поиска плагина → хендлер провайдера. */
  async searchClick(pluginId: string, providerId: string, item: Record<string, unknown>): Promise<void> {
    const run = this.running.get(pluginId)
    if (!run) return
    try {
      await run.proc.callHandler('search', providerId, { click: item }, SEARCH_TIMEOUT_MS)
    } catch { /* ignore */ }
  }

  /** Autocomplete: находит триггер в тексте и спрашивает провайдера.
   *  Возвращает null, если ни один триггер не матчится. */
  async autocompleteSuggest(text: string): Promise<{
    pluginId: string
    trigger: string
    suggestions: Array<{ label: string; insertText?: string; command?: string }>
  } | null> {
    const lower = text.toLowerCase()
    for (const [pluginId, run] of this.running) {
      for (const [trigger, provider] of run.autocomplete) {
        // Триггер должен быть началом слова в тексте, после него —
        // непустой остаток без пробелов (query).
        const idx = lower.lastIndexOf(trigger)
        if (idx === -1) continue
        const beforeOk = idx === 0 || /\s/.test(lower[idx - 1])
        const query = text.slice(idx + trigger.length)
        if (!beforeOk || !query || /\s/.test(query)) continue
        try {
          const r = await run.proc.callHandler('autocomplete', trigger, { query }, AUTOCOMPLETE_TIMEOUT_MS)
          const raw = (r.ok && Array.isArray(r.result)) ? r.result : []
          const suggestions = raw
            .filter(s => s && typeof s === 'object' && typeof (s as { label?: unknown }).label === 'string')
            .slice(0, 10)
            .map(s => {
              const o = s as { label: string; insertText?: unknown; command?: unknown }
              return {
                label: String(o.label),
                insertText: typeof o.insertText === 'string' ? o.insertText : undefined,
                command: typeof o.command === 'string' ? o.command : undefined,
              }
            })
          if (suggestions.length > 0) {
            return { pluginId, trigger: provider.trigger, suggestions }
          }
        } catch { /* ignore */ }
      }
    }
    return null
  }

  /** Клик по пункту контекстного меню сообщений → хендлер плагина. */
  async contextMenuAction(pluginId: string, itemId: string, payload: Record<string, unknown>): Promise<void> {
    const run = this.running.get(pluginId)
    if (!run) return
    try {
      await run.proc.callHandler('menu', itemId, payload, SEARCH_TIMEOUT_MS)
    } catch { /* ignore */ }
  }

  // ── Трей ────────────────────────────────────────────────────────────────

  /** Все плагинские пункты меню трея (агрегированный снапшот). */
  getTrayItems(): PluginTrayItem[] {
    const out: PluginTrayItem[] = []
    for (const items of this.trayItems.values()) out.push(...items)
    return out
  }

  /** Клик по плагинскому пункту трея: command → выполнить слэш-команду,
   *  иначе — событие 'tray:action' в процесс плагина. */
  async trayAction(pluginId: string, label: string, command?: string): Promise<void> {
    if (command) {
      await this.executeCommand(pluginId, command, '')
      return
    }
    this.running.get(pluginId)?.proc.sendEvent('tray:action', { label })
  }

  /** Колбэк «пункты трея изменились» — подключается из main/index.ts
   *  (пушит свежие пункты в живое окно трей-меню). */
  onTrayItemsChanged: (() => void) | null = null

  /** Пуш обновлённых пунктов в окно трей-меню (если оно живо). */
  private notifyTrayMenuChanged(): void {
    this.onTrayItemsChanged?.()
  }

  // ── Overlay ─────────────────────────────────────────────────────────────

  /** Показать overlay-окно с HTML плагина (syntee-plugin://). */
  overlayShow(pluginId: string, params: {
    entry: string
    data?: unknown
    width?: number
    height?: number
    timeoutMs?: number
  }): void {
    const entry = String(params.entry ?? '')
    if (!entry) throw new Error('overlay.show: entry обязателен')
    const pluginDir = this.findPluginDir(pluginId)
    if (!pluginDir) throw new Error('overlay.show: плагин не найден')

    this.overlayHide()
    const width = Math.min(Math.max(160, Number(params.width) || 360), 1200)
    const height = Math.min(Math.max(120, Number(params.height) || 240), 900)
    const work = screen.getPrimaryDisplay().workArea
    const win = new BrowserWindow({
      x: work.x + work.width - width - 16,
      y: work.y + work.height - height - 16,
      width,
      height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    // data → query-параметр (страница плагина читает location.search).
    let url = `syntee-plugin://${pluginId}/${entry.replace(/^\/+/, '')}`
    if (params.data !== undefined) {
      url += `?data=${encodeURIComponent(JSON.stringify(params.data))}`
    }
    win.loadURL(url).catch(e => {
      console.warn(`[plugins] overlay.loadURL failed: ${(e as Error).message}`)
    })
    win.once('ready-to-show', () => win.show())
    // Клик мимо окна / потеря фокуса — скрыть (как уведомление).
    win.on('blur', () => this.overlayHide())
    this.pluginOverlayWin = win

    const timeoutMs = Number(params.timeoutMs) || 0
    if (timeoutMs > 0) {
      this.pluginOverlayTimer = setTimeout(() => this.overlayHide(), Math.min(timeoutMs, 600_000))
    }
  }

  /** Скрыть overlay-окно плагина. */
  overlayHide(): void {
    if (this.pluginOverlayTimer) {
      clearTimeout(this.pluginOverlayTimer)
      this.pluginOverlayTimer = null
    }
    if (this.pluginOverlayWin) {
      const w = this.pluginOverlayWin
      this.pluginOverlayWin = null
      try { w.destroy() } catch { /* ignore */ }
    }
  }

  /** Какой плагин владеет accelerator (null — никто). */
  private findShortcutOwner(accelerator: string): string | null {
    for (const [pluginId, accs] of this.pluginShortcuts) {
      if (accs.has(accelerator)) return pluginId
    }
    return null
  }

  /** Ленивый минутный тикер для cron-джоб. Тикает на границе минуты. */
  private ensureCronTicker(): void {
    if (this.cronTicker) return
    this.cronTicker = setInterval(() => {
      const now = new Date()
      for (const [pluginId, jobs] of this.schedulerJobs) {
        for (const [id, job] of jobs) {
          if (job.kind !== 'cron' || !job.expr) continue
          if (matchesCronExpression(job.expr, now)) {
            this.running.get(pluginId)?.proc.sendEvent('scheduler:tick', { id })
          }
        }
      }
    }, 60_000)
    this.cronTicker.unref?.()
  }

  /** Смена темы: кэш для ui.getTheme + рассылка события theme:changed. */
  setTheme(theme: string, accentColor: string): void {
    const dark = !LIGHT_THEMES.has(theme)
    for (const [, run] of this.running) {
      try {
        run.proc.sendEvent('theme:changed', { theme, accentColor, dark })
      } catch { /* dead — ок */ }
    }
  }

  /** Текущая тема (для ui.getTheme из плагина). */
  getThemeInfo(): PluginThemeInfo {
    const theme = String(this.store.get('theme') ?? 'dark')
    const accentColor = String(this.store.get('accentColor') ?? '#22d3ee')
    return { theme, accentColor, dark: !LIGHT_THEMES.has(theme) }
  }

  // ── UI-мост (iframe-панели) ────────────────────────────────────────────

  /** Сообщение из iframe-панели плагина (renderer → plugin process). */
  sendUiMessage(pluginId: string, data: unknown): void {
    this.running.get(pluginId)?.proc.sendUiMessage(data)
  }

  /** RPC-вызов из iframe-панели (synteeBridge.call → ui.handle). */
  async uiCall(pluginId: string, method: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const run = this.running.get(pluginId)
    if (!run) return { ok: false, error: `Плагин не запущен: ${pluginId}` }
    return run.proc.uiCall(method, args)
  }

  /** Плагин просит открыть/закрыть свою панель (right-таб или modal). */
  panelAction(pluginId: string, action: 'open' | 'close', panelId: string): void {
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_PANEL_ACTION, { pluginId, action, panelId })
  }

  /** Бейдж на табе панели плагина (null — убрать). */
  setPanelBadge(pluginId: string, panelId: string, badge: number | null): void {
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_BADGE, { pluginId, panelId, badge })
  }

  /** Тост от плагина. */
  toast(text: string, kind: 'info' | 'success' | 'error' = 'info'): void {
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_TOAST, { text, kind })
  }

  /** Действие плагина в чате (renderer знает текущий chatId).
   *  send — с опциональными вложениями (пути файлов); open — открыть чат. */
  chatAction(action: 'send' | 'reply' | 'open', text: string, silent = false, attachments?: Array<{ path: string; name?: string; kind?: string }>): void {
    if (action === 'open') {
      this.win?.webContents.send(IPC_EVENTS.PLUGINS_CHAT_ACTION, { action, chatId: text })
      return
    }
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_CHAT_ACTION, { action, text, silent, attachments })
  }

  /** Клик по кнопке плагина над инпутом без command → событие 'input-action'. */
  emitInputAction(pluginId: string, actionId: string): void {
    this.running.get(pluginId)?.proc.sendEvent('input-action', { id: actionId })
  }

  /** Находит папку плагина по id (для syntee-plugin:// протокола). */
  findPluginDir(pluginId: string): string | null {
    const found = this.lastScan.find(p => p.id === pluginId)
      ?? this.scan().find(p => p.id === pluginId)
    return found?.dir ?? null
  }

  /** UI-файл плагина (манифест ui) — для iframe-панели. */
  getPluginUiEntry(pluginId: string): string | null {
    const found = this.lastScan.find(p => p.id === pluginId)
      ?? this.scan().find(p => p.id === pluginId)
    return found?.manifest.ui ?? null
  }

  // ── Настройки (config) ─────────────────────────────────────────────────

  /** Значения настроек плагина: дефолты манифеста + сохранённые значения. */
  getConfigValues(pluginId: string, manifestConfig?: Array<{ key: string; default?: unknown }>): Record<string, unknown> {
    const saved = (this.store.get('pluginsConfig') as Record<string, Record<string, unknown>> | undefined)?.[pluginId] ?? {}
    const out: Record<string, unknown> = {}
    for (const field of manifestConfig ?? []) {
      out[field.key] = saved[field.key] !== undefined ? saved[field.key] : (field.default ?? '')
    }
    // Сохранённые ключи вне схемы — тоже возвращаем (на случай изменения схемы).
    for (const [k, v] of Object.entries(saved)) {
      if (!(k in out)) out[k] = v
    }
    return out
  }

  /** Сохраняет значения настроек (merge с существующими). */
  setConfigValues(pluginId: string, values: Record<string, unknown>): void {
    const all = (this.store.get('pluginsConfig') as Record<string, Record<string, unknown>> | undefined) ?? {}
    all[pluginId] = { ...(all[pluginId] ?? {}), ...values }
    this.store.set('pluginsConfig', all)
  }

  // ── Тулы для агента ────────────────────────────────────────────────────

  /**
   * Активные тулы плагинов для конкретного чата (enabled + scope + running).
   * Инкогнито → []. Синхронно, никогда не ждёт запуска процессов.
   */
  getActiveToolsForChat(opts: {
    projectWorkdir?: string
    projectId?: string
    isIncognito?: boolean
  }): PluginToolRuntime[] {
    if (opts.isIncognito) return []
    const plugins = this.scan(opts.projectWorkdir, opts.projectId)
    const out: PluginToolRuntime[] = []
    for (const plugin of plugins) {
      const state = this.getState(plugin.id)
      if (!state.enabled) continue
      if (!this.scopeApplies(state.scope, opts.projectId)) continue
      const run = this.running.get(plugin.id)
      if (!run) continue // не запущен — тулы недоступны в этом запросе
      out.push(...run.tools.values())
    }
    return out
  }

  /** Активные плагины для system prompt (краткая инфа + имена тулов). */
  getActivePluginsForChat(opts: {
    projectWorkdir?: string
    projectId?: string
    isIncognito?: boolean
  }): PluginPromptInfo[] {
    if (opts.isIncognito) return []
    const plugins = this.scan(opts.projectWorkdir, opts.projectId)
    const out: PluginPromptInfo[] = []
    for (const plugin of plugins) {
      const state = this.getState(plugin.id)
      if (!state.enabled) continue
      if (!this.scopeApplies(state.scope, opts.projectId)) continue
      const run = this.running.get(plugin.id)
      out.push({
        id: plugin.id,
        name: plugin.manifest.name,
        promptDescription: plugin.manifest.promptDescription,
        tools: run ? [...run.tools.keys()] : [],
        widgets: run
          ? [...run.widgets.values()].map(w => ({ name: w.name, description: w.description }))
          : [],
        messageTags: run
          ? [...run.messageTags.values()].map(t => ({ tag: t.tag, description: t.description }))
          : [],
        contextProviders: run ? [...run.contextProviders.keys()] : [],
      })
    }
    return out
  }

  /** Статические секции system prompt активных плагинов
   *  (registerPromptSection) — для buildSystemPrompt. */
  collectPromptSections(opts: {
    projectWorkdir?: string
    projectId?: string
    isIncognito?: boolean
  }): Array<{ title: string; content: string }> {
    if (opts.isIncognito) return []
    const out: Array<{ title: string; content: string }> = []
    for (const plugin of this.scan(opts.projectWorkdir, opts.projectId)) {
      const state = this.getState(plugin.id)
      if (!state.enabled) continue
      if (!this.scopeApplies(state.scope, opts.projectId)) continue
      const run = this.running.get(plugin.id)
      if (!run) continue
      for (const s of run.promptSections.values()) {
        out.push({ title: s.title, content: s.content })
      }
    }
    return out
  }

  /** Регистрация билдера system prompt (вызывает chat.ipc при старте) —
   *  для prompt.get() плагинов и превью промпта в UI. */
  setPromptBuilder(fn: (chatId?: string) => Promise<string>): void {
    this.promptBuilder = fn
  }

  /** Превью system prompt для UI (plugins:getSystemPrompt). */
  async getPromptPreview(chatId?: string): Promise<string> {
    if (!this.promptBuilder) return ''
    return this.promptBuilder(chatId || lastActiveChatId || undefined)
  }

  /** Флаш стримингового ответа плагина: контент в БД + push в renderer. */
  private flushPluginReply(replyId: string, final = false): void {
    const entry = this.pluginReplies.get(replyId)
    if (!entry) return
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    try { editMessageContent(entry.messageId, entry.content) } catch { /* ignore */ }
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_REPLY_CHUNK, {
      action: final ? 'end' : 'chunk',
      chatId: entry.chatId,
      messageId: entry.messageId,
      content: entry.content,
    })
    if (final) this.pluginReplies.delete(replyId)
  }

  /** Вызов тула по полному имени plugin__{pluginId}__{toolName}. */
  async callToolByName(
    fullToolName: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const parsed = parsePluginToolName(fullToolName)
    if (!parsed) return { success: false, output: '', error: `Некорректное имя тула плагина: ${fullToolName}` }
    const run = this.running.get(parsed.pluginId)
    if (!run) return { success: false, output: '', error: `Плагин не запущен: ${parsed.pluginId}` }
    const r = await run.proc.callTool(parsed.toolName, args)
    return {
      success: r.ok,
      output: r.output ?? '',
      error: r.error,
    }
  }

  // ── Host-API для плагинов ──────────────────────────────────────────────

  /** Публичный вход для iframe-панелей (plugins:iframeCall): тот же
   *  handleHostRequest, но только для read-only белого списка методов
   *  (фильтрация — в plugins.ipc.ts). */
  async handleHostRequestForIframe(
    pluginId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    return this.handleHostRequest(pluginId, method, params)
  }

  private async handleHostRequest(
    pluginId: string,
    method: string,
    params: Record<string, unknown>,
    requestId: string = '',
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    try {
      switch (method) {
        case 'storage.get':
          return { ok: true, result: this.storage.get(pluginId, String(params.key ?? '')) }
        case 'storage.set':
          this.storage.set(pluginId, String(params.key ?? ''), params.value)
          return { ok: true }
        case 'storage.delete':
          this.storage.delete(pluginId, String(params.key ?? ''))
          return { ok: true }
        case 'clipboard.readText':
          return { ok: true, result: clipboard.readText() }
        case 'clipboard.writeText':
          clipboard.writeText(String(params.text ?? ''))
          return { ok: true }
        case 'notification.show': {
          const title = String(params.title ?? 'Плагин')
          const body = String(params.body ?? '')
          // Кнопки-действия: через кастомный notification overlay
          // (type 'system'); клик выполняет слэш-команду плагина или
          // открывает его панель (action.panel).
          const rawActions = (params.actions as Array<{ label?: string; command?: string; panel?: string }>) ?? []
          const actions = rawActions
            .filter(a => a && a.label && (a.command || a.panel))
            .slice(0, 3)
            .map(a => ({
              // panel-действие — отдельный префикс (NotificationManager
              // открывает панель вместо выполнения команды).
              id: a.panel
                ? `plugin-panel:${pluginId}:${String(a.panel)}`
                : `plugin:${pluginId}:${String(a.command)}`,
              label: String(a.label),
            }))
          if (actions.length > 0) {
            const nm = getNotificationManager()
            if (nm) {
              nm.push({ type: 'system', title, body, priority: 'info', actions, duration: 10_000 })
              return { ok: true }
            }
          }
          if (Notification.isSupported()) {
            new Notification({ title, body }).show()
          }
          return { ok: true }
        }
        case 'net.fetch': {
          const url = String(params.url ?? '')
          if (!/^https?:\/\//.test(url)) {
            return { ok: false, error: 'net.fetch: только http/https' }
          }
          const init = (params.init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string }
          const resp = await electronNet.fetch(url, {
            method: init.method ?? 'GET',
            headers: init.headers,
            body: init.body,
          })
          const headers: Record<string, string> = {}
          resp.headers.forEach((v, k) => { headers[k] = v })
          // binary: true → bodyBase64 (картинки, архивы и т.п.; текст ломался
          // при декодировании). Лимит тот же 1 МБ.
          const binary = params.binary === true
          if (binary) {
            let b64 = ''
            if (resp.body) {
              const buf = await resp.arrayBuffer()
              const bytes = buf.byteLength > NET_FETCH_MAX_BYTES
                ? buf.slice(0, NET_FETCH_MAX_BYTES)
                : buf
              b64 = Buffer.from(bytes).toString('base64')
            }
            return { ok: true, result: { status: resp.status, headers, bodyBase64: b64 } }
          }
          let bodyText = ''
          if (resp.body) {
            const buf = await resp.arrayBuffer()
            const bytes = buf.byteLength > NET_FETCH_MAX_BYTES
              ? buf.slice(0, NET_FETCH_MAX_BYTES)
              : buf
            bodyText = new TextDecoder().decode(bytes)
            if (buf.byteLength > NET_FETCH_MAX_BYTES) bodyText += '\n…(обрезано до 1 МБ)'
          }
          return { ok: true, result: { status: resp.status, headers, body: bodyText } }
        }
        case 'fs.readFile': {
          const p = String(params.path ?? '')
          if (!p) return { ok: false, error: 'fs.readFile: path обязателен' }
          const st = statSync(p)
          if (!st.isFile()) return { ok: false, error: 'fs.readFile: не файл' }
          if (st.size > FS_READ_MAX_BYTES) {
            return { ok: false, error: `fs.readFile: файл больше ${FS_READ_MAX_BYTES} байт` }
          }
          // encoding: 'base64' → бинарное содержимое (картинки и т.п.)
          if (params.encoding === 'base64') {
            return { ok: true, result: readFileSync(p).toString('base64') }
          }
          return { ok: true, result: readFileSync(p, 'utf-8') }
        }
        case 'fs.writeFile': {
          const p = String(params.path ?? '')
          if (!p) return { ok: false, error: 'fs.writeFile: path обязателен' }
          const content = String(params.content ?? '')
          // encoding: 'base64' → content — base64 бинарных данных.
          const isBase64 = params.encoding === 'base64'
          const byteLen = isBase64
            ? Buffer.byteLength(Buffer.from(content, 'base64'))
            : Buffer.byteLength(content, 'utf-8')
          if (byteLen > FS_WRITE_MAX_BYTES) {
            return { ok: false, error: `fs.writeFile: контент больше ${FS_WRITE_MAX_BYTES} байт` }
          }
          // Права проверены в pluginHost (fs:write внутри папки плагина /
          // fs:write:any вне её) — процесс плагина имеет доступ к Node API,
          // поэтому это consent-гейт, а не жёсткая песочница.
          const resolved = resolvePath(p)
          mkdirSync(dirname(resolved), { recursive: true })
          if (isBase64) {
            writeFileSync(resolved, Buffer.from(content, 'base64'))
          } else {
            writeFileSync(resolved, content, 'utf-8')
          }
          return { ok: true }
        }
        case 'fs.stat': {
          const p = String(params.path ?? '')
          if (!p) return { ok: false, error: 'fs.stat: path обязателен' }
          if (!existsSync(p)) {
            return { ok: true, result: { exists: false, isFile: false, isDir: false, size: 0, mtime: 0 } }
          }
          const st = statSync(p)
          return {
            ok: true,
            result: { exists: true, isFile: st.isFile(), isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs },
          }
        }
        case 'fs.mkdir': {
          const p = String(params.path ?? '')
          if (!p) return { ok: false, error: 'fs.mkdir: path обязателен' }
          mkdirSync(p, { recursive: params.recursive !== false })
          return { ok: true }
        }
        case 'fs.delete': {
          const p = String(params.path ?? '')
          if (!p) return { ok: false, error: 'fs.delete: path обязателен' }
          const resolved = resolvePath(p)
          // Защита от удаления корня диска / коротких системных путей.
          if (resolved.length <= 3 || /^[a-zA-Z]:\\?$/.test(resolved)) {
            return { ok: false, error: 'fs.delete: отказано (системный путь)' }
          }
          if (!existsSync(resolved)) return { ok: true }
          rmSync(resolved, { recursive: true, force: false })
          return { ok: true }
        }
        case 'fs.rename': {
          const from = String(params.from ?? '')
          const to = String(params.to ?? '')
          if (!from || !to) return { ok: false, error: 'fs.rename: from и to обязательны' }
          if (!existsSync(from)) return { ok: false, error: 'fs.rename: from не найден' }
          mkdirSync(dirname(resolvePath(to)), { recursive: true })
          renameSync(from, to)
          return { ok: true }
        }
        case 'fs.copy': {
          const from = String(params.from ?? '')
          const to = String(params.to ?? '')
          if (!from || !to) return { ok: false, error: 'fs.copy: from и to обязательны' }
          if (!existsSync(from)) return { ok: false, error: 'fs.copy: from не найден' }
          mkdirSync(dirname(resolvePath(to)), { recursive: true })
          if (statSync(from).isDirectory()) {
            cpSync(from, to, { recursive: true })
          } else {
            copyFileSync(from, to)
          }
          return { ok: true }
        }
        case 'fs.writeFiles': {
          const raw = (params.files ?? {}) as Record<string, unknown>
          const baseDir = params.baseDir ? String(params.baseDir) : ''
          const entries = Object.entries(raw)
          if (entries.length === 0) return { ok: false, error: 'fs.writeFiles: files пуст' }
          if (entries.length > WRITEFILES_MAX_FILES) {
            return { ok: false, error: `fs.writeFiles: максимум ${WRITEFILES_MAX_FILES} файлов за вызов` }
          }
          let total = 0
          for (const [, v] of entries) {
            total += Buffer.byteLength(String(v ?? ''), 'utf-8')
          }
          if (total > WRITEFILES_MAX_TOTAL_BYTES) {
            return { ok: false, error: `fs.writeFiles: суммарный размер больше ${WRITEFILES_MAX_TOTAL_BYTES} байт` }
          }
          for (const [rel, v] of entries) {
            const content = String(v ?? '')
            if (Buffer.byteLength(content, 'utf-8') > FS_WRITE_MAX_BYTES) {
              return { ok: false, error: `fs.writeFiles: файл ${rel} больше ${FS_WRITE_MAX_BYTES} байт` }
            }
            const full = baseDir ? join(baseDir, rel) : rel
            const resolved = resolvePath(full)
            mkdirSync(dirname(resolved), { recursive: true })
            writeFileSync(resolved, content, 'utf-8')
          }
          return { ok: true, result: { written: entries.length } }
        }
        case 'fs.listDir': {
          const p = String(params.path ?? '')
          if (!p) return { ok: false, error: 'fs.listDir: path обязателен' }
          if (!existsSync(p)) return { ok: false, error: 'fs.listDir: путь не найден' }
          return { ok: true, result: readdirSync(p) }
        }
        case 'config.get': {
          const key = String(params.key ?? '')
          const plugin = this.lastScan.find(pl => pl.id === pluginId)
          const values = this.getConfigValues(pluginId, plugin?.manifest.config)
          return { ok: true, result: values[key] }
        }
        case 'config.getAll': {
          const plugin = this.lastScan.find(pl => pl.id === pluginId)
          return { ok: true, result: this.getConfigValues(pluginId, plugin?.manifest.config) }
        }
        case 'ui.openPanel':
          this.panelAction(pluginId, 'open', String(params.panelId ?? ''))
          return { ok: true }
        case 'ui.closePanel':
          this.panelAction(pluginId, 'close', String(params.panelId ?? ''))
          return { ok: true }
        case 'ui.setBadge': {
          const badge = params.badge
          this.setPanelBadge(pluginId, String(params.panelId ?? ''), badge === null || badge === undefined ? null : Number(badge))
          return { ok: true }
        }
        case 'ui.getTheme':
          return { ok: true, result: this.getThemeInfo() }
        case 'chat.send':
          this.chatAction('send', String(params.text ?? ''), params.silent === true,
            Array.isArray(params.attachments)
              ? (params.attachments as Array<{ path: string; name?: string; kind?: string }>)
                  .filter(a => a && typeof a.path === 'string')
                  .slice(0, 10)
                  .map(a => ({ path: a.path, name: a.name, kind: a.kind }))
              : undefined)
          return { ok: true }
        case 'chat.reply':
          this.chatAction('reply', String(params.text ?? ''))
          return { ok: true }
        case 'chat.beginReply': {
          const chatId = lastActiveChatId
          if (!chatId) return { ok: false, error: 'chat.beginReply: нет активного чата' }
          const replyId = `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const messageId = uuid()
          const msg: Message = {
            id: messageId,
            chatId,
            role: 'assistant',
            content: '',
            createdAt: Date.now(),
            isPinned: 0,
          }
          try {
            saveMessage(msg)
          } catch (e) {
            return { ok: false, error: `chat.beginReply: ${(e as Error).message}` }
          }
          this.pluginReplies.set(replyId, { pluginId, chatId, messageId, content: '', timer: null })
          // Renderer создаёт пузырь сообщения (добавит в store).
          this.win?.webContents.send(IPC_EVENTS.PLUGINS_REPLY_CHUNK, {
            action: 'begin', chatId, messageId, content: '',
          })
          return { ok: true, result: replyId }
        }
        case 'chat.appendChunk': {
          const replyId = String(params.replyId ?? '')
          const entry = this.pluginReplies.get(replyId)
          if (!entry) return { ok: false, error: 'chat.appendChunk: неизвестный replyId (стриминг завершён или не начинался)' }
          if (entry.pluginId !== pluginId) return { ok: false, error: 'chat.appendChunk: replyId принадлежит другому плагину' }
          const delta = String(params.delta ?? '')
          if (delta) entry.content = (entry.content + delta).slice(0, REPLY_MAX_LENGTH)
          if (!entry.timer) {
            entry.timer = setTimeout(() => this.flushPluginReply(replyId), REPLY_CHUNK_THROTTLE_MS)
          }
          return { ok: true }
        }
        case 'chat.endReply': {
          const replyId = String(params.replyId ?? '')
          const entry = this.pluginReplies.get(replyId)
          if (!entry) return { ok: false, error: 'chat.endReply: неизвестный replyId' }
          if (entry.pluginId !== pluginId) return { ok: false, error: 'chat.endReply: replyId принадлежит другому плагину' }
          this.flushPluginReply(replyId, true)
          return { ok: true }
        }
        case 'chat.getActive':
          return { ok: true, result: { chatId: lastActiveChatId ?? null } }
        case 'prompt.get': {
          if (!this.promptBuilder) {
            return { ok: false, error: 'prompt.get: system prompt ещё не доступен (чат не инициализирован)' }
          }
          const chatId = params.chatId ? String(params.chatId) : (lastActiveChatId ?? undefined)
          const prompt = await this.promptBuilder(chatId)
          return { ok: true, result: prompt }
        }
        case 'chats.list': {
          const chats = getAllChats().map(c => ({
            id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
          }))
          return { ok: true, result: chats }
        }
        case 'chats.get': {
          const chatId = String(params.chatId ?? '')
          if (!chatId) return { ok: false, error: 'chats.get: chatId обязателен' }
          const chat = getAllChats().find(c => c.id === chatId)
          if (!chat) return { ok: true, result: null }
          const messages = getMessages(chatId).map(m => ({
            id: m.id, role: m.role, content: m.content, createdAt: m.createdAt,
          }))
          return { ok: true, result: { chat, messages } }
        }
        case 'projects.list': {
          const projects = getAllProjects().map(p => ({ id: p.id, name: p.name, workdir: p.workdir }))
          return { ok: true, result: projects }
        }
        case 'memory.search':
          return { ok: true, result: searchMemories(String(params.query ?? '')) }
        case 'memory.save': {
          const key = String(params.key ?? '')
          if (!key) return { ok: false, error: 'memory.save: key обязателен' }
          saveMemory({ key, value: String(params.value ?? ''), category: 'facts', confidence: 0.6, source: `plugin:${pluginId}` })
          return { ok: true }
        }
        case 'window.toast':
          this.toast(String(params.text ?? ''), (params.kind as 'info' | 'success' | 'error') ?? 'info')
          return { ok: true }
        case 'window.dialog': {
          const buttons = (params.buttons as string[] | undefined) ?? ['OK']
          const res = await dialog.showMessageBox(this.win!, {
            type: 'info',
            title: String(params.title ?? 'Плагин'),
            message: String(params.body ?? ''),
            buttons,
            defaultId: 0,
            cancelId: buttons.length - 1,
          })
          return { ok: true, result: res.response }
        }
        // ── AI ──
        // (ai.chat — см. полный case с vision-поддержкой ниже, в блоке
        //  «AI: стриминг, vision, embeddings»; дубликат убран: первый
        //  case в switch делал второй недостижимым.)
        // ── Шина между плагинами ──
        case 'bus.emit': {
          const event = String(params.event ?? '')
          if (!event) return { ok: false, error: 'bus.emit: event обязателен' }
          const payload = { data: params.data ?? null, from: pluginId }
          for (const run of this.running.values()) {
            try { run.proc.sendEvent(`bus:${event}`, payload) } catch { /* dead — ок */ }
          }
          return { ok: true }
        }
        // ── Планировщик ──
        case 'scheduler.every': {
          const id = String(params.id ?? '')
          const intervalMs = Number(params.intervalMs) || 0
          if (!id || intervalMs < 1000) return { ok: false, error: 'scheduler.every: id и intervalMs>=1000 обязательны' }
          const jobs = this.schedulerJobs.get(pluginId) ?? new Map<string, SchedulerJob>()
          this.schedulerJobs.set(pluginId, jobs)
          const timer = setInterval(() => {
            this.running.get(pluginId)?.proc.sendEvent('scheduler:tick', { id })
          }, intervalMs)
          timer.unref?.()
          jobs.set(id, { kind: 'interval', timer })
          return { ok: true }
        }
        case 'scheduler.at': {
          const id = String(params.id ?? '')
          const delayMs = Number(params.delayMs) || 0
          if (!id || delayMs < 0) return { ok: false, error: 'scheduler.at: id и delayMs>=0 обязательны' }
          const jobs = this.schedulerJobs.get(pluginId) ?? new Map<string, SchedulerJob>()
          this.schedulerJobs.set(pluginId, jobs)
          const timer = setTimeout(() => {
            jobs.delete(id)
            this.running.get(pluginId)?.proc.sendEvent('scheduler:tick', { id })
          }, delayMs)
          timer.unref?.()
          jobs.set(id, { kind: 'timeout', timer })
          return { ok: true }
        }
        case 'scheduler.cron': {
          const id = String(params.id ?? '')
          const expr = String(params.expr ?? '')
          if (!id || !expr) return { ok: false, error: 'scheduler.cron: id и expr обязательны' }
          const jobs = this.schedulerJobs.get(pluginId) ?? new Map<string, SchedulerJob>()
          this.schedulerJobs.set(pluginId, jobs)
          jobs.set(id, { kind: 'cron', expr })
          this.ensureCronTicker()
          return { ok: true }
        }
        case 'scheduler.cancel': {
          const id = String(params.id ?? '')
          const jobs = this.schedulerJobs.get(pluginId)
          const job = jobs?.get(id)
          if (job?.timer) clearTimeout(job.timer)
          jobs?.delete(id)
          return { ok: true }
        }
        // ── Глобальные шорткаты ──
        case 'shortcut.register': {
          const accelerator = String(params.accelerator ?? '')
          if (!accelerator) return { ok: false, error: 'shortcut.register: accelerator обязателен' }
          // Занят другим плагином или приложением?
          const owner = this.findShortcutOwner(accelerator)
          if (owner && owner !== pluginId) {
            return { ok: false, error: `shortcut.register: "${accelerator}" уже занят (плагин ${owner})` }
          }
          const accs = this.pluginShortcuts.get(pluginId) ?? new Set<string>()
          this.pluginShortcuts.set(pluginId, accs)
          try {
            globalShortcut.register(accelerator, () => {
              this.running.get(pluginId)?.proc.sendEvent('shortcut', { accelerator })
            })
          } catch (e) {
            return { ok: false, error: `shortcut.register: ${(e as Error).message}` }
          }
          accs.add(accelerator)
          return { ok: true }
        }
        case 'shortcut.unregister': {
          const accelerator = String(params.accelerator ?? '')
          const accs = this.pluginShortcuts.get(pluginId)
          if (accs?.has(accelerator)) {
            accs.delete(accelerator)
            try { globalShortcut.unregister(accelerator) } catch { /* ignore */ }
          }
          return { ok: true }
        }
        // ── Плагинский fs.watch ──
        case 'fs.watch': {
          const id = String(params.id ?? '')
          const path = String(params.path ?? '')
          if (!id || !path) return { ok: false, error: 'fs.watch: id и path обязательны' }
          if (!existsSync(path)) return { ok: false, error: 'fs.watch: путь не найден' }
          const watches = this.pluginWatchers.get(pluginId) ?? new Map<string, PluginFsWatch>()
          this.pluginWatchers.set(pluginId, watches)
          // Замена существующего watcher с тем же id.
          const old = watches.get(id)
          if (old) { try { old.watcher.close() } catch { /* ignore */ } }
          try {
            const watcher = watch(path, { recursive: params.recursive === true }, (event, filename) => {
              const file = String(filename ?? '')
              if (/(^|[\\/])~|\.(tmp|crdownload|lock)$/.test(file)) return
              this.running.get(pluginId)?.proc.sendEvent('fs:change', { id, event, file })
            })
            watches.set(id, { watcher, path })
            return { ok: true }
          } catch (e) {
            return { ok: false, error: `fs.watch: ${(e as Error).message}` }
          }
        }
        case 'fs.unwatch': {
          const id = String(params.id ?? '')
          const watches = this.pluginWatchers.get(pluginId)
          const w = watches?.get(id)
          if (w) {
            try { w.watcher.close() } catch { /* ignore */ }
            watches!.delete(id)
          }
          return { ok: true }
        }
        // ── Запуск команд ──
        case 'process.exec': {
          const command = String(params.command ?? '')
          if (!command) return { ok: false, error: 'process.exec: command обязателен' }
          const timeoutMs = Math.min(Math.max(1000, Number(params.timeoutMs) || EXEC_TIMEOUT_DEFAULT_MS), EXEC_TIMEOUT_MAX_MS)
          const result = await new Promise<{ stdout: string; stderr: string; code: number }>(resolve => {
            childExec(command, {
              cwd: params.cwd ? String(params.cwd) : undefined,
              timeout: timeoutMs,
              maxBuffer: EXEC_MAX_BUFFER,
              windowsHide: true,
            }, (err, stdout, stderr) => {
              resolve({
                stdout: String(stdout ?? ''),
                stderr: String(stderr ?? (err && !stdout ? err.message : '')),
                code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? -1) : 0,
              })
            })
          })
          return { ok: true, result }
        }
        // ── WebSocket ──
        case 'net.ws.connect': {
          const id = String(params.id ?? '')
          const url = String(params.url ?? '')
          if (!id || !url) return { ok: false, error: 'net.ws.connect: id и url обязательны' }
          if (!/^wss?:\/\//.test(url)) return { ok: false, error: 'net.ws.connect: только ws:// и wss://' }
          if (typeof WebSocket === 'undefined') {
            return { ok: false, error: 'net.ws: WebSocket недоступен в этом окружении' }
          }
          const sockets = this.pluginSockets.get(pluginId) ?? new Map<string, WebSocket>()
          this.pluginSockets.set(pluginId, sockets)
          // Замена существующего соединения с тем же id.
          const old = sockets.get(id)
          if (old) { try { old.close() } catch { /* ignore */ } }
          try {
            const ws = new WebSocket(url)
            ws.onopen = () => {
              this.running.get(pluginId)?.proc.sendEvent('ws:open', { id })
            }
            ws.onmessage = (ev: MessageEvent) => {
              const data = typeof ev.data === 'string' ? ev.data : '[binary]'
              this.running.get(pluginId)?.proc.sendEvent('ws:message', { id, data })
            }
            ws.onclose = (ev: CloseEvent) => {
              const s = this.pluginSockets.get(pluginId)
              if (s?.get(id) === ws) s.delete(id)
              this.running.get(pluginId)?.proc.sendEvent('ws:close', { id, code: ev.code, reason: ev.reason })
            }
            ws.onerror = () => {
              this.running.get(pluginId)?.proc.sendEvent('ws:error', { id, error: 'connection error' })
            }
            sockets.set(id, ws)
            return { ok: true }
          } catch (e) {
            return { ok: false, error: `net.ws.connect: ${(e as Error).message}` }
          }
        }
        case 'net.ws.send': {
          const id = String(params.id ?? '')
          const data = String(params.data ?? '')
          const ws = this.pluginSockets.get(pluginId)?.get(id)
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            return { ok: false, error: `net.ws.send: соединение "${id}" не открыто` }
          }
          try { ws.send(data) } catch (e) {
            return { ok: false, error: `net.ws.send: ${(e as Error).message}` }
          }
          return { ok: true }
        }
        case 'net.ws.close': {
          const id = String(params.id ?? '')
          const ws = this.pluginSockets.get(pluginId)?.get(id)
          if (ws) {
            try { ws.close() } catch { /* ignore */ }
            this.pluginSockets.get(pluginId)?.delete(id)
          }
          return { ok: true }
        }
        // ── Overlay ──
        case 'overlay.show': {
          this.overlayShow(pluginId, {
            entry: String(params.entry ?? ''),
            data: params.data,
            width: params.width as number | undefined,
            height: params.height as number | undefined,
            timeoutMs: params.timeoutMs as number | undefined,
          })
          return { ok: true }
        }
        case 'overlay.hide': {
          this.overlayHide()
          return { ok: true }
        }
        // ── Status bar ──
        case 'statusbar.set': {
          const id = String(params.id ?? '')
          const text = String(params.text ?? '')
          if (!id) return { ok: false, error: 'statusbar.set: id обязателен' }
          const items = this.statusbarItems.get(pluginId) ?? new Map<string, PluginStatusbarItem>()
          this.statusbarItems.set(pluginId, items)
          items.set(id, {
            pluginId,
            id,
            text,
            tooltip: params.tooltip ? String(params.tooltip) : undefined,
            command: params.command ? String(params.command) : undefined,
          })
          this.win?.webContents.send(IPC_EVENTS.PLUGINS_STATUSBAR, { pluginId, items: [...items.values()] })
          return { ok: true }
        }
        case 'statusbar.clear': {
          const id = String(params.id ?? '')
          const items = this.statusbarItems.get(pluginId)
          if (items) {
            items.delete(id)
            this.win?.webContents.send(IPC_EVENTS.PLUGINS_STATUSBAR, { pluginId, items: [...items.values()] })
          }
          return { ok: true }
        }
        // ── Трей ──
        case 'tray.setMenu': {
          const raw = (params.items as Array<{ label?: string; command?: string; type?: string }>) ?? []
          const items: PluginTrayItem[] = raw.map(it => ({
            pluginId,
            label: String(it.label ?? ''),
            command: it.command ? String(it.command) : undefined,
            type: it.type === 'separator' ? 'separator' : 'item',
          }))
          this.trayItems.set(pluginId, items)
          this.notifyTrayMenuChanged()
          return { ok: true }
        }
        case 'tray.clearMenu': {
          this.trayItems.delete(pluginId)
          this.notifyTrayMenuChanged()
          return { ok: true }
        }
        // ── Чаты: CRUD ──
        case 'chats.create': {
          const title = params.title ? String(params.title) : undefined
          const projectId = params.projectId ? String(params.projectId) : undefined
          const chat = createChat(false, 'code', projectId)
          if (title) renameChat(chat.id, title)
          this.win?.webContents.send('chat:created', { chatId: chat.id })
          return { ok: true, result: { id: chat.id } }
        }
        case 'chats.rename': {
          const chatId = String(params.chatId ?? '')
          const title = String(params.title ?? '')
          if (!chatId || !title) return { ok: false, error: 'chats.rename: chatId и title обязательны' }
          renameChat(chatId, title)
          this.win?.webContents.send('chat:renamed', { chatId, title })
          return { ok: true }
        }
        case 'chats.delete': {
          const chatId = String(params.chatId ?? '')
          if (!chatId) return { ok: false, error: 'chats.delete: chatId обязателен' }
          deleteChat(chatId)
          this.win?.webContents.send('chat:deleted', { chatId })
          return { ok: true }
        }
        case 'chats.appendMessage': {
          const chatId = String(params.chatId ?? '')
          const role: 'user' | 'assistant' = params.role === 'user' ? 'user' : 'assistant'
          const content = String(params.content ?? '')
          if (!chatId || !content) return { ok: false, error: 'chats.appendMessage: chatId и content обязательны' }
          const msg: Message = {
            id: uuid(),
            chatId,
            role,
            content,
            createdAt: Date.now(),
            isPinned: 0,
          }
          saveMessage(msg)
          return { ok: true, result: { id: msg.id } }
        }
        case 'chats.editMessage': {
          const messageId = String(params.messageId ?? '')
          const content = String(params.content ?? '')
          if (!messageId || !content) return { ok: false, error: 'chats.editMessage: messageId и content обязательны' }
          const ok = editMessageContent(messageId, content)
          return ok ? { ok: true } : { ok: false, error: 'chats.editMessage: сообщение не найдено' }
        }
        case 'chats.deleteMessage': {
          const messageId = String(params.messageId ?? '')
          if (!messageId) return { ok: false, error: 'chats.deleteMessage: messageId обязателен' }
          deleteMessageById(messageId)
          return { ok: true }
        }
        case 'chats.open': {
          // Открыть чат пользователю: renderer переключает currentChatId.
          const chatId = String(params.chatId ?? '')
          if (!chatId) return { ok: false, error: 'chats.open: chatId обязателен' }
          if (!getAllChats().some(c => c.id === chatId)) {
            return { ok: false, error: 'chats.open: чат не найден' }
          }
          this.win?.webContents.send(IPC_EVENTS.PLUGINS_CHAT_ACTION, { action: 'open', chatId })
          return { ok: true }
        }
        case 'chats.getAttachments': {
          // Вложения сообщения (файлы/картинки юзера) — для плагинов-анализаторов.
          const messageId = String(params.messageId ?? '')
          if (!messageId) return { ok: false, error: 'chats.getAttachments: messageId обязателен' }
          const msg = getMessageById(messageId)
          if (!msg) return { ok: false, error: 'chats.getAttachments: сообщение не найдено' }
          return { ok: true, result: msg.attachments ?? [] }
        }
        case 'projects.current': {
          const chatId = lastActiveChatId
          if (!chatId) return { ok: true, result: { chatId: null } }
          const chat = getAllChats().find(c => c.id === chatId)
          const ctx = getChatWorkdirContext(chatId)
          const projectId = chat?.projectId ?? undefined
          const project = projectId ? getAllProjects().find(p => p.id === projectId) : undefined
          return {
            ok: true,
            result: {
              chatId,
              projectId: project?.id,
              projectName: project?.name,
              workdir: ctx.workdir,
            },
          }
        }
        case 'projects.create': {
          const workdir = String(params.workdir ?? '')
          if (!workdir) return { ok: false, error: 'projects.create: workdir обязателен' }
          if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
            return { ok: false, error: 'projects.create: папка не найдена' }
          }
          const project = createProject(workdir, params.projectContext ? String(params.projectContext) : undefined)
          if (params.name) {
            // createProject берёт имя из папки — переопределяем явным именем.
            renameProject(project.id, String(params.name))
            project.name = String(params.name)
          }
          return { ok: true, result: { id: project.id, name: project.name, workdir: project.workdir } }
        }
        case 'shell.openExternal': {
          const url = String(params.url ?? '')
          if (!/^https?:\/\//.test(url)) {
            return { ok: false, error: 'shell.openExternal: только http/https' }
          }
          await shell.openExternal(url)
          return { ok: true }
        }
        case 'sound.play': {
          // Звук приложения (Web Audio в renderer): { soundId } — id из
          // BUILTIN_SOUNDS ('synth.send', 'synth.done', ...) или путь к
          // кастомному звуку. Renderer проигрывает через playSoundById.
          const soundId = String(params.soundId ?? '')
          if (!soundId) return { ok: false, error: 'sound.play: soundId обязателен' }
          this.win?.webContents.send(IPC_EVENTS.PLUGINS_PLAY_SOUND, { soundId })
          return { ok: true }
        }
        case 'ai.generateImage': {
          // Генерация картинки через image-провайдер приложения.
          const prompt = String(params.prompt ?? '')
          if (!prompt) return { ok: false, error: 'ai.generateImage: prompt обязателен' }
          // Gateway-провайдер авторизуется JWT аккаунта — тул в main-процессе
          // достанет токен сам, но передаём явно (как search_web выше).
          let gatewayToken: string | null = null
          try { gatewayToken = await getGatewayAuthToken() } catch { /* не авторизован — ок */ }
          const r = await toolGenerateImage({
            prompt,
            model: params.model ? String(params.model) : undefined,
            size: params.size ? String(params.size) : undefined,
            quality: params.quality ? String(params.quality) : undefined,
            style: params.style ? String(params.style) : undefined,
          }, this.store, { gatewayToken })
          if (!r.success) return { ok: false, error: r.error || 'ai.generateImage failed' }
          return { ok: true, result: r.output }
        }
        case 'agent.run': {
          // Полноценный субагент хоста (как spawn_agent у агента): воркер,
          // тулы, планировщик. Возвращает финальный summary.
          const task = String(params.task ?? '')
          if (!task) return { ok: false, error: 'agent.run: task обязателен' }
          const workdir = params.workdir ? String(params.workdir)
            : (lastActiveChatId ? getChatWorkdirContext(lastActiveChatId).workdir : undefined)
          const chatId = lastActiveChatId ?? 'plugin-runs'
          // storeData — снапшот настроек для воркера (как в chat.ipc.ts).
          const storeData: Record<string, unknown> = {}
          const storeKeys = [
            'apiKey', 'apiEndpoint', 'providers', 'modelAssignments', 'customModels',
            'temperature', 'maxTokens', 'reasoningValue', 'agentSettings', 'agentPermissions', 'projectPermissions', 'integrations',
            'voiceId', 'embeddingModel',
            'imageProviderId', 'imageModelId', 'imageDefaultSize', 'imageDefaultQuality',
            'contextSettings',
          ]
          for (const k of storeKeys) {
            const v = this.store.get(k)
            if (v !== undefined) storeData[k] = v
          }
          const agentId = `plugin-agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          const result = await agentManager.spawn({
            id: agentId,
            parentId: `plugin:${pluginId}`,
            chatId,
            task,
            model: params.model ? String(params.model) : undefined,
            mode: 'code',
            storeData,
            context: {
              systemPrompt: `Ты суб-агент, запущенный плагином ${pluginId}. Твоя задача: ${task}

Работай только в рамках этой подзадачи. Используй минимальное количество tool calls.
Как только задача выполнена — сразу давай финальный ответ (максимум 15 строк): что найдено или сделано, какие файлы важны, какие есть риски.`,
              workdir,
              mode: 'code',
            },
          })
          if (result.error) return { ok: false, error: result.error }
          return { ok: true, result: { agentId, summary: result.summary } }
        }
        // ── UI: виджеты и модалки ──
        case 'ui.registerWidget': {
          const run = this.running.get(pluginId)
          if (!run) return { ok: false, error: 'Плагин не запущен' }
          const name = String(params.name ?? '')
          const entry = String(params.entry ?? '')
          if (!name || !entry) return { ok: false, error: 'registerWidget: name и entry обязательны' }
          run.widgets.set(name, {
            pluginId,
            name,
            entry,
            height: params.height ? Number(params.height) : undefined,
            description: params.description ? String(params.description) : undefined,
          })
          this.emitChanged()
          return { ok: true }
        }
        case 'ui.openModal': {
          this.win?.webContents.send(IPC_EVENTS.PLUGINS_MODAL_ACTION, {
            pluginId,
            action: 'open',
            entry: params.entry ? String(params.entry) : this.getPluginUiEntry(pluginId) ?? undefined,
            title: params.title ? String(params.title) : undefined,
            width: params.width ? Number(params.width) : undefined,
            height: params.height ? Number(params.height) : undefined,
          })
          return { ok: true }
        }
        case 'ui.closeModal': {
          this.win?.webContents.send(IPC_EVENTS.PLUGINS_MODAL_ACTION, { pluginId, action: 'close' })
          return { ok: true }
        }
        // ── Chat overlay: iframe-оверлей ПОВЕРХ области чата в главном
        //    окне (в отличие от overlay.show — отдельного окна). Плагин
        //    может показывать плавающую панель/виджет рядом с перепиской.
        case 'ui.showChatOverlay': {
          const entry = params.entry ? String(params.entry) : this.getPluginUiEntry(pluginId)
          if (!entry) return { ok: false, error: 'ui.showChatOverlay: entry не задан (и нет manifest.ui)' }
          this.win?.webContents.send(IPC_EVENTS.PLUGINS_CHAT_OVERLAY, {
            pluginId,
            action: 'show',
            entry,
            title: params.title ? String(params.title) : undefined,
            width: params.width ? Number(params.width) : undefined,
            height: params.height ? Number(params.height) : undefined,
            position: params.position === 'left' ? 'left' : (params.position === 'center' ? 'center' : 'right'),
          })
          return { ok: true }
        }
        case 'ui.hideChatOverlay': {
          this.win?.webContents.send(IPC_EVENTS.PLUGINS_CHAT_OVERLAY, { pluginId, action: 'hide' })
          return { ok: true }
        }
        // ── AI: стриминг, vision, embeddings ──
        case 'ai.chat': {
          const text = await this.aiChat({
            prompt: params.prompt as string | undefined,
            messages: params.messages as Array<{ type: string; text?: string; path?: string; url?: string; base64?: string }> | undefined,
            system: params.system as string | undefined,
            model: params.model as string | undefined,
            maxTokens: params.maxTokens as number | undefined,
            tools: params.tools as Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> | undefined,
            chatContext: params.chatContext === true,
            chatId: params.chatId as string | undefined,
            pluginId,
          })
          return { ok: true, result: text }
        }
        case 'ai.chatStream': {
          // Дельты уходят событием 'ai:delta' { requestId, delta }; финальный
          // ответ — hostResponse с полным текстом (requestId тот же).
          const text = await this.aiChatStream(pluginId, requestId, {
            prompt: params.prompt as string | undefined,
            messages: params.messages as Array<{ type: string; text?: string }> | undefined,
            system: params.system as string | undefined,
            model: params.model as string | undefined,
            maxTokens: params.maxTokens as number | undefined,
          })
          return { ok: true, result: text }
        }
        case 'ai.embed': {
          const text = String(params.text ?? '')
          if (!text) return { ok: false, error: 'ai.embed: text обязателен' }
          const clipped = text.slice(0, EMBED_MAX_CHARS)
          const embedder = await getEmbedder()
          const emb = await embedder.embed(clipped)
          return { ok: true, result: Array.from(emb) }
        }
        case 'ai.listModels': {
          // Компактный список моделей приложения (как models:getAll, без enrichment).
          const providers = (this.store.get('providers', []) as Array<{ id: string; enabled: boolean }>)
          const enabledIds = providers.filter(p => p.enabled).map(p => p.id)
          const builtin = enabledIds.length > 0
            ? BUILTIN_MODELS.filter(m => enabledIds.includes(m.providerId))
            : BUILTIN_MODELS
          const custom = (this.store.get('customModels', []) as Array<{ id: string; providerId: string; name?: string; contextWindow?: number }>)
          const cached = (this.store.get('cachedModels', []) as Array<{ id: string; providerId: string; name?: string; contextWindow?: number }>)
          const seen = new Set<string>()
          const out: Array<{ id: string; providerId: string; name: string; contextWindow: number }> = []
          for (const m of [...builtin, ...cached, ...custom, ...getGatewayModelsCache()]) {
            const key = `${m.providerId}:${m.id}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push({
              id: m.id,
              providerId: m.providerId,
              name: m.name ?? m.id,
              contextWindow: Number(m.contextWindow) || 0,
            })
          }
          return { ok: true, result: out }
        }
        // ── Host-тулы агента (read-only) ──
        case 'agent.useTool': {
          const tool = String(params.tool ?? '')
          const args = (params.args ?? {}) as Record<string, unknown>
          let r: { success: boolean; output: string; error?: string }
          switch (tool) {
            case 'read_file':
              r = await toolReadFile(
                String(args.path ?? ''),
                args.offset !== undefined ? Number(args.offset) : undefined,
                args.limit !== undefined ? Number(args.limit) : undefined,
                typeof args.workdir === 'string' ? args.workdir : undefined,
                args.full === true,
              )
              break
            case 'search_code':
              r = await toolSearchCode(
                String(args.pattern ?? ''),
                typeof args.path === 'string' ? args.path : undefined,
                {
                  maxResults: args.max_results !== undefined ? Number(args.max_results) : undefined,
                  context: args.context !== undefined ? Number(args.context) : undefined,
                  ignoreCase: args.ignore_case === true,
                  workdir: typeof args.workdir === 'string' ? args.workdir : undefined,
                },
              )
              break
            case 'list_directory':
              r = await toolListDirectory(String(args.path ?? '.'), {
                recursive: args.recursive === true,
                depth: args.depth !== undefined ? Number(args.depth) : undefined,
                workdir: typeof args.workdir === 'string' ? args.workdir : undefined,
              })
              break
            case 'find_files':
              r = await toolFindFiles(
                String(args.pattern ?? '*'),
                String(args.path ?? '.'),
                {
                  maxResults: args.max_results !== undefined ? Number(args.max_results) : undefined,
                  workdir: typeof args.workdir === 'string' ? args.workdir : undefined,
                },
              )
              break
            case 'write_file':
              r = await toolWriteFile(
                String(args.path ?? ''),
                String(args.content ?? ''),
                {
                  dryRun: args.dry_run === true,
                  workdir: typeof args.workdir === 'string' ? args.workdir : undefined,
                },
              )
              break
            case 'edit_file':
              r = await toolEditFile({
                path: String(args.path ?? ''),
                old_str: String(args.old_str ?? ''),
                new_str: String(args.new_str ?? ''),
                create_if_not_exists: args.create_if_not_exists === true,
                dryRun: args.dry_run === true,
                workdir: typeof args.workdir === 'string' ? args.workdir : undefined,
              })
              break
            case 'search_web': {
              const integrations = (this.store.get('integrations') as { tavily?: { key?: string } } | undefined)
              let gatewayToken: string | null = null
              try { gatewayToken = await getGatewayAuthToken() } catch { /* не авторизован — ок */ }
              r = await toolSearchWeb(String(args.query ?? ''), {
                tavilyKey: integrations?.tavily?.key,
                gatewayToken: gatewayToken ?? undefined,
                gatewayApiUrl: getGatewayApiUrl(),
              })
              break
            }
            default:
              return { ok: false, error: `agent.useTool: поддерживаются read_file, search_code, list_directory, find_files, write_file, edit_file, search_web (получил "${tool}")` }
          }
          if (!r.success) return { ok: false, error: r.error || `${tool} failed` }
          return { ok: true, result: r.output.slice(0, 262_144) }
        }
        // ── MCP-мост ──
        case 'mcp.listTools': {
          const mgr = getMcpManager()
          const servers = mgr.getAllServers()
          const out: Array<{ server: string; name: string; description?: string }> = []
          for (const s of servers) {
            if (!s.enabled || s.status !== 'connected') continue
            for (const t of s.tools) {
              out.push({ server: s.name, name: t.shortName ?? t.name, description: t.description })
            }
          }
          return { ok: true, result: out }
        }
        case 'mcp.call': {
          const server = String(params.server ?? '')
          const tool = String(params.tool ?? '')
          if (!server || !tool) return { ok: false, error: 'mcp.call: server и tool обязательны' }
          const sanitize = (n: string) => n.replace(/[^A-Za-z0-9_]/g, '_')
          const full = `mcp__${sanitize(server)}__${tool}`
          const r = await getMcpManager().callToolByName(full, (params.args ?? {}) as Record<string, unknown>, {})
          if (!r.success) return { ok: false, error: r.error || 'mcp.call failed' }
          return { ok: true, result: r.output }
        }
        // ── Секреты (safeStorage) ──
        case 'secrets.get':
        case 'secrets.set':
        case 'secrets.delete': {
          const key = String(params.key ?? '')
          if (!key) return { ok: false, error: `${method}: key обязателен` }
          const dir = join(app.getPath('userData'), 'plugins', 'secrets')
          const file = join(dir, `${pluginId}.json`)
          let data: Record<string, string> = {}
          try {
            if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>
          } catch { /* повреждённый файл — начинаем с пустого */ }
          if (method === 'secrets.get') {
            const enc = data[key]
            if (!enc) return { ok: true, result: undefined }
            try {
              return { ok: true, result: safeStorage.decryptString(Buffer.from(enc, 'base64')) }
            } catch {
              return { ok: false, error: 'secrets.get: расшифровка не удалась (файл перенесён с другой машины?)' }
            }
          }
          if (method === 'secrets.set') {
            const value = String(params.value ?? '')
            if (!safeStorage.isEncryptionAvailable()) {
              return { ok: false, error: 'secrets: шифрование недоступно в этой системе (safeStorage)' }
            }
            data[key] = safeStorage.encryptString(value).toString('base64')
          } else {
            delete data[key]
          }
          try {
            mkdirSync(dir, { recursive: true })
            writeFileSync(file, JSON.stringify(data), { encoding: 'utf-8' })
          } catch (e) {
            return { ok: false, error: `secrets: запись не удалась: ${(e as Error).message}` }
          }
          return { ok: true }
        }
        // ── Webhook-сервер (локальный HTTP) ──
        case 'net.listen': {
          const port = Number(params.port ?? 0)
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return { ok: false, error: 'net.listen: port должен быть 1..65535' }
          }
          // Порт уже занят (нами или системой)?
          for (const [, servers] of this.webhookServers) {
            if (servers.has(port)) {
              return { ok: false, error: `net.listen: порт ${port} уже слушается другим плагином` }
            }
          }
          const servers = this.webhookServers.get(pluginId) ?? new Map<number, http.Server>()
          this.webhookServers.set(pluginId, servers)
          await new Promise<void>((resolve, reject) => {
            const srv = http.createServer((req, res) => {
              const chunks: Buffer[] = []
              let size = 0
              req.on('data', (c: Buffer) => {
                size += c.length
                if (size > WEBHOOK_MAX_BODY) {
                  res.writeHead(413)
                  res.end('payload too large')
                  req.destroy()
                  return
                }
                chunks.push(c)
              })
              req.on('end', () => {
                try {
                  this.running.get(pluginId)?.proc.sendEvent('webhook:request', {
                    port,
                    method: req.method ?? 'GET',
                    path: req.url ?? '/',
                    body: Buffer.concat(chunks).toString('utf-8'),
                  })
                } catch { /* dead */ }
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end('{"ok":true}')
              })
              req.on('error', () => {
                res.writeHead(400)
                res.end()
              })
            })
            srv.once('error', e => reject(e))
            srv.listen(port, '127.0.0.1', () => resolve())
            servers.set(port, srv)
          }).catch(e => {
            servers.delete(port)
            return Promise.reject(e)
          })
          return { ok: true }
        }
        case 'net.close': {
          const port = Number(params.port ?? 0)
          const servers = this.webhookServers.get(pluginId)
          const srv = servers?.get(port)
          if (srv) {
            try { srv.close() } catch { /* ignore */ }
            servers!.delete(port)
          }
          return { ok: true }
        }
        // ── Git ──
        case 'git.status': {
          const workdir = String(params.workdir ?? '')
          if (!workdir) return { ok: false, error: 'git.status: workdir обязателен' }
          const out = await runGit(workdir, ['status', '--porcelain=v1', '-b'])
          const lines = out.split('\n').filter(Boolean)
          const branchLine = lines.find(l => l.startsWith('##')) ?? ''
          const branch = (branchLine.match(/## (.+?)(\.\.|$)/)?.[1]) ?? null
          const ahead = Number(branchLine.match(/ahead (\d+)/)?.[1] ?? 0)
          const behind = Number(branchLine.match(/behind (\d+)/)?.[1] ?? 0)
          const files = lines
            .filter(l => !l.startsWith('##'))
            .map(l => ({ path: l.slice(3).trim(), status: l.slice(0, 2).trim() }))
          return { ok: true, result: { branch, ahead, behind, clean: files.length === 0, files } }
        }
        case 'git.diff': {
          const workdir = String(params.workdir ?? '')
          if (!workdir) return { ok: false, error: 'git.diff: workdir обязателен' }
          const args = params.staged === true ? ['diff', '--cached'] : ['diff']
          if (params.file) args.push('--', String(params.file))
          const out = await runGit(workdir, args)
          return { ok: true, result: out.slice(0, GIT_MAX_OUTPUT) }
        }
        case 'git.log': {
          const workdir = String(params.workdir ?? '')
          if (!workdir) return { ok: false, error: 'git.log: workdir обязателен' }
          const limit = Math.min(Math.max(1, Number(params.limit) || 20), 200)
          const out = await runGit(workdir, ['log', `-n${limit}`, '--pretty=format:%H%x09%an%x09%ad%x09%s'])
          const commits = out.split('\n').filter(Boolean).map(line => {
            const [hash, author, date, ...msg] = line.split('\t')
            return { hash: hash ?? '', author: author ?? '', date: date ?? '', message: msg.join('\t') ?? '' }
          })
          return { ok: true, result: commits }
        }
        case 'git.commit': {
          const workdir = String(params.workdir ?? '')
          const message = String(params.message ?? '')
          if (!workdir || !message) return { ok: false, error: 'git.commit: workdir и message обязательны' }
          if (params.addAll === true || params.add === true) {
            await runGit(workdir, ['add', params.addAll === true ? '-A' : '.'])
          }
          const out = await runGit(workdir, ['commit', '-m', message])
          return { ok: true, result: out.slice(0, GIT_MAX_OUTPUT) }
        }
        case 'git.branches': {
          const workdir = String(params.workdir ?? '')
          if (!workdir) return { ok: false, error: 'git.branches: workdir обязателен' }
          const out = await runGit(workdir, ['branch', '--list', '--format=%(refname:short)%09%(HEAD)'])
          const branches = out.split('\n').filter(Boolean).map(line => {
            const [name, head] = line.split('\t')
            return { name: name ?? '', current: head === '*' }
          })
          return { ok: true, result: branches }
        }
        // ── Нативные диалоги выбора ──
        case 'fs.pickFile': {
          const filters = (params.filters as Array<{ name?: string; extensions?: string[] }>)?.map(f => ({
            name: String(f.name ?? 'Files'),
            extensions: Array.isArray(f.extensions) ? f.extensions.map(String) : ['*'],
          }))
          const res = await dialog.showOpenDialog(this.win!, {
            title: params.title ? String(params.title) : 'Выберите файл',
            properties: ['openFile'],
            filters: filters?.length ? filters : undefined,
          })
          return { ok: true, result: res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0] }
        }
        case 'fs.pickDir': {
          const res = await dialog.showOpenDialog(this.win!, {
            title: params.title ? String(params.title) : 'Выберите папку',
            properties: ['openDirectory'],
          })
          return { ok: true, result: res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0] }
        }
        case 'fs.pickFiles': {
          const filters = (Array.isArray(params.filters) ? params.filters : []).map(f => ({
            name: String(f?.name ?? 'Files'),
            extensions: Array.isArray(f?.extensions) ? f.extensions.map(String) : ['*'],
          }))
          const res = await dialog.showOpenDialog(this.win!, {
            title: params.title ? String(params.title) : 'Выберите файлы',
            properties: ['openFile', 'multiSelections'],
            filters: filters.length ? filters : undefined,
          })
          return { ok: true, result: res.canceled ? [] : res.filePaths }
        }
        case 'fs.saveDialog': {
          const filters = (Array.isArray(params.filters) ? params.filters : []).map(f => ({
            name: String(f?.name ?? 'Files'),
            extensions: Array.isArray(f?.extensions) ? f.extensions.map(String) : ['*'],
          }))
          const res = await dialog.showSaveDialog(this.win!, {
            title: params.title ? String(params.title) : 'Сохранить файл',
            defaultPath: params.defaultPath ? String(params.defaultPath) : undefined,
            filters: filters.length ? filters : undefined,
          })
          return { ok: true, result: res.canceled ? null : res.filePath }
        }
        // ── Live-карточка прогресса тула ──
        case 'ui.progress': {
          this.win?.webContents.send(IPC_EVENTS.PLUGINS_TOOL_PROGRESS, {
            pluginId,
            progressId: String(params.progressId ?? ''),
            action: String(params.action ?? ''),
            label: String(params.label ?? ''),
          })
          return { ok: true }
        }
        // ── Публичные настройки (read-only) ──
        case 'settings.get': {
          const theme = this.getThemeInfo()
          const mp = (this.store.get('modelParams') as { streaming?: boolean } | undefined)
          return {
            ok: true,
            result: {
              theme: theme.theme,
              accentColor: theme.accentColor,
              dark: theme.dark,
              streaming: mp?.streaming ?? true,
              platform: process.platform,
              appVersion: app.getVersion(),
              locale: app.getLocale(),
            },
          }
        }
        // ── Провайдеры моделей от плагинов ──
        case 'provider.register': {
          const id = String(params.id ?? '')
          if (!id || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) {
            return { ok: false, error: 'provider.register: id обязателен ([a-zA-Z][a-zA-Z0-9_-]*)' }
          }
          const baseUrl = String(params.baseUrl ?? '')
          if (!/^https?:\/\//.test(baseUrl)) {
            return { ok: false, error: 'provider.register: baseUrl должен быть http(s)://' }
          }
          const storeId = `plugin-${pluginId}-${id}`
          const list = (this.store.get('providers', []) as Provider[])
          const next = list.filter(p => p.id !== storeId)
          next.push({
            id: storeId,
            type: 'custom',
            name: String(params.name || id),
            baseUrl,
            apiKey: String(params.apiKey ?? ''),
            enabled: true,
            isCustom: true,
            modelsOverride: Array.isArray(params.models) ? params.models.map(String).slice(0, 100) : undefined,
          })
          this.store.set('providers', next)
          let set = this.pluginProviders.get(pluginId)
          if (!set) { set = new Set(); this.pluginProviders.set(pluginId, set) }
          set.add(storeId)
          return { ok: true, result: { id: storeId } }
        }
        case 'provider.unregister': {
          const storeId = `plugin-${pluginId}-${String(params.id ?? '')}`
          this.store.set('providers', (this.store.get('providers', []) as Provider[]).filter(p => p.id !== storeId))
          this.pluginProviders.get(pluginId)?.delete(storeId)
          return { ok: true }
        }
        // ── Речь ──
        case 'speech.tts': {
          const text = String(params.text ?? '')
          if (!text) return { ok: false, error: 'speech.tts: text обязателен' }
          const client = new AIClient(this.store)
          const audioBase64 = await client.textToSpeech(text.slice(0, 4000))
          return { ok: true, result: audioBase64 }
        }
        case 'speech.stt': {
          const p = String(params.path ?? '')
          if (!p) return { ok: false, error: 'speech.stt: path обязателен' }
          if (!existsSync(p)) return { ok: false, error: `speech.stt: файл не найден: ${p}` }
          const st = statSync(p)
          if (st.size > 26_214_400) return { ok: false, error: 'speech.stt: файл больше 25 МБ' }
          const audio = parseWavToMono16k(readFileSync(p))
          const text = await whisperTranscribe(this.store, audio)
          return { ok: true, result: text }
        }
        // ── Пагинация сообщений чата ──
        case 'chats.getMessages': {
          const chatId = String(params.chatId ?? '')
          if (!chatId) return { ok: false, error: 'chats.getMessages: chatId обязателен' }
          const limit = Math.min(Math.max(1, Number(params.limit) || 50), 200)
          const page = getMessagesPage(
            chatId,
            limit,
            params.beforeCreatedAt !== undefined ? Number(params.beforeCreatedAt) : undefined,
            params.beforeId !== undefined ? String(params.beforeId) : undefined,
          )
          return { ok: true, result: page }
        }
        // ── Chat-scoped память плагина ──
        case 'memory.chat.get':
        case 'memory.chat.set':
        case 'memory.chat.delete': {
          const chatId = String(params.chatId ?? '')
          const key = String(params.key ?? '')
          if (!chatId || !key) return { ok: false, error: `${method}: chatId и key обязательны` }
          const storageKey = `__chatmem__:${chatId}:${key}`
          if (method === 'memory.chat.get') {
            return { ok: true, result: this.storage.get(pluginId, storageKey) }
          }
          if (method === 'memory.chat.set') {
            this.storage.set(pluginId, storageKey, params.value)
            return { ok: true }
          }
          this.storage.delete(pluginId, storageKey)
          return { ok: true }
        }
        default:
          return { ok: false, error: `Неизвестный hostRequest: ${method}` }
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  // ── Push в renderer ────────────────────────────────────────────────────

  private emitChanged(): void {
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_CHANGED, {})
  }

  private pushLog(pluginId: string, run: RunningPlugin, level: PluginLogEntry['level'], message: string): void {
    run.logs.push({ ts: Date.now(), level, message })
    if (run.logs.length > LOG_CAP) run.logs.splice(0, run.logs.length - LOG_CAP)
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_LOGS, { pluginId, logs: run.logs })
  }
}

/** Светлые темы (для PluginThemeInfo.dark). */
const LIGHT_THEMES = new Set(['light', 'paper', 'latte', 'sepia', 'dawn', 'mist', 'solarized'])

/** Парсит plugin__{pluginId}__{toolName}. */
export function parsePluginToolName(toolName: string): { pluginId: string; toolName: string } | null {
  if (!toolName.startsWith('plugin__')) return null
  const rest = toolName.slice(8)
  const sep = rest.indexOf('__')
  if (sep === -1) return null
  return { pluginId: rest.slice(0, sep), toolName: rest.slice(sep + 2) }
}

// ── Синглтон ─────────────────────────────────────────────────────────────

let pluginManagerInstance: PluginManager | null = null

export function initPluginManager(store: Store): PluginManager {
  pluginManagerInstance = new PluginManager(store)
  return pluginManagerInstance
}

export function getPluginManager(): PluginManager {
  if (!pluginManagerInstance) {
    throw new Error('PluginManager не инициализирован. Вызови initPluginManager() в main.')
  }
  return pluginManagerInstance
}
