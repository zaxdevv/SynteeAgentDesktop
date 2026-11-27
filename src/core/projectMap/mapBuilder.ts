/**
 * ProjectMapManager — единый менеджер карт проектов.
 *
 *  - Фон: строит карты всех проектов, активный (открытый чат) — первым и быстро,
 *    остальные — медленнее (пауза между файлами). Уступает foreground (чат busy).
 *  - Инкрементал: подписка на fileIndexer → debounce → переразбор изменённого
 *    файла + перерезолвинг его импортёров. Кэш по sha256 — неизменённые файлы не
 *    перепарсиваются, карта переживает рестарт приложения.
 *  - Прогресс: наружу через setProgressCallback (IPC шлёт в renderer-баннер).
 *
 * Тяжёлый парсинг — в Rust sidecar; здесь только оркестрация и резолвинг (лёгкий).
 */
import { readFile, stat } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import * as path from 'path'
import * as os from 'os'
import { log } from '../logger'
import { getAllProjects, getProjectById, getProjectByWorkdir } from '../db'
import { sidecarSymbols, type SidecarSymbolsResult } from '../sidecar/sidecarClient'
import {
  startIndexing, getAllFiles, subscribeFileChanges, isPathIgnored,
  getInventoryStatus, whenInventoryReady, onInventoryComplete,
  type FileInventoryStatus,
} from '../mentions/fileIndexer'
import type { CodeMapFile, CodeMapNode, CodeMapProgress, CodeMapState, CodeMapEdge, ProjectMapSpeedSettings, ProjectMapAutoInfo } from '../../shared/projectMap'
import { DEFAULT_PROJECT_MAP_SPEED } from '../../shared/projectMap'
import * as store from './mapStore'
import {
  ProjectIndex, definitionsToNodes, markExported, containsEdges, resolveFileImports,
  resolveFileCalls, ensurePackages, loadTsconfigAliases, markdownNodes, docReferenceEdges,
  fileLookupKeys,
} from './mapResolver'
import {
  syncFileDocs, removeFileDocs, pruneProjectDocs, semanticWorker,
} from './mapSemantic'
import { invalidateAnalytics } from './mapAnalytics'

/**
 * Языки с реальной поддержкой в sidecar (tree-sitter). Держать в синхроне с
 * `Sidecar/src/symbols/language.rs`: иначе парсер умеет, а карта такие файлы
 * молча не индексирует.
 */
const CODE_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rs', '.go',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.java', '.cs', '.rb', '.php', '.sh', '.bash',
  '.swift', '.kt', '.kts', '.scala', '.lua', '.dart', '.ex', '.exs',
])

/** Markdown/ADR — отдельный тип узлов (секции), индексируется своим проходом. */
const DOC_EXTS = new Set(['.md', '.mdx'])

/** Пауза между файлами для неактивных проектов задаётся backgroundDelay(). */
const CHANGE_DEBOUNCE_MS = 400
/**
 * Потолок debounce: пока файлы меняются непрерывно (git checkout, сборка,
 * автоформат), таймер перевзводится и карта не обновляется вообще. По потолку
 * пачку сбрасываем принудительно.
 */
const MAX_DEBOUNCE_MS = 2_000
const MAX_FILES = 20000
/**
 * Сколько ждём первичный скан инвентаря, прежде чем строить ЧАСТИЧНУЮ карту.
 * Ждать 30 с в очереди менеджера нельзя: остальные проекты и активный чат
 * стоят, а старая карта уже рабочая.
 */
const PARTIAL_WAIT_MS = 1_500
/** Предел ожидания финальной сверки после досканирования инвентаря. */
const RECONCILE_TIMEOUT_MS = 5 * 60_000
/** Кэш importDetails/callSites: без него перерезолв импортёра = чтение+sidecar. */
const MAX_SYMBOL_CACHE = 1_500
/**
 * Файлы больше этого размера в карту не берём ВООБЩЕ и, главное, не читаем:
 * чтение 100 МБ бандла занимало память и время ради узлов, которые потом всё
 * равно отбрасывались как minified.
 */
const MAX_FILE_BYTES = 1_000_000
/**
 * Сколько фоновый проект ждёт занятый чат. Раньше здесь было 60 с и это шло
 * ПОВЕРХ паузы между файлами: одна итерация могла стоять минуту. Теперь пауза
 * ограничена и проверяет отмену/приоритет активного проекта.
 */
const FOREGROUND_WAIT_MS = 5_000
/**
 * Границы точечного восстановления неразрешённых ссылок: кандидаты берутся
 * обратным lookup'ом по durable-следу (не сканом проекта), число импортёров и
 * принудительных разборов на проход ограничено — иначе одна правка могла бы
 * стоить перерезолва всего проекта.
 */
const RECOVERY_MAX_CANDIDATES = 200
const RECOVERY_MAX_IMPORTERS = 40
const RECOVERY_MAX_PARSES = 8

/**
 * `partial` — карта построена по неполному инвентарю (скан не завершён,
 * упёрлись в лимит файлов, watcher мёртв). Удаления в этом состоянии
 * запрещены: отсутствующий в списке файл ≠ удалённый файл.
 */
const STATE_PARTIAL: CodeMapState = 'partial'
const PHASE_PARTIAL: CodeMapProgress['phase'] = 'partial'

/**
 * Версия правил построения карты. Меняется, когда меняется СМЫСЛ сохранённых
 * данных (парсинг, exported, состав узлов, отбор документов). Несовпадение
 * версии → одноразовая полная пересборка: иначе старая БД живёт со старыми
 * правилами (например, exported=0 у всех символов или 333 сгенерированных
 * *.d.ts в графе), и никакой код это не замечает.
 *  3 — exported по исходнику, git-фильтр файлов, markdown-секции, tier-0.
 *  4 — exported для языков с публичностью по умолчанию (Kotlin/Swift/Scala/
 *      Dart/Ruby/Elixir/Lua/PHP). Документы НЕ пересоздаются с нуля: textHash
 *      не меняется → векторы сохраняются (hash-гейт), пересчитывается только tier.
 *  5 — durable-след неразрешённых ссылок (code_map_unresolved) заполняется при
 *      резолвинге файла. Без пересборки у старой карты следа нет, и точечное
 *      восстановление «висящих» импортов/вызовов не сработало бы для них.
 */
const MAP_SCHEMA_VERSION = '5'

interface RawFile {
  meta: CodeMapFile
  symbols: SidecarSymbolsResult
  nodes: CodeMapNode[]
}

/**
 * Результат обработки одного файла. Ключевое различие: `excluded` — файл
 * намеренно не индексируется (minified/неподдерживаемый), его узлы можно
 * убрать из графа; `transient` — временный сбой (EACCES, таймаут парсера),
 * старый граф файла НЕ трогаем; `missing` — файла действительно нет.
 */
type FileOutcome =
  | { kind: 'ok'; raw: RawFile }
  | { kind: 'unchanged'; mtime: number; size: number }
  | { kind: 'missing' }
  | { kind: 'excluded' }
  | { kind: 'transient'; error: string }

/** Дорогая часть разбора, нужная для перерезолва импортёров без чтения файла. */
interface CachedSymbols {
  hash: string
  language: string | null
  importDetails: SidecarSymbolsResult['importDetails']
  callSites: SidecarSymbolsResult['callSites']
}

/**
 * Опции разбора одного файла.
 *
 *  - `force` — пересобрать, даже если stat/hash совпали (явная пересборка).
 *  - `forceHash` — сравнить содержимое, даже когда mtime+size совпали. Нужно
 *    watcher-правкам: инструменты (git checkout, некоторые редакторы) сохраняют
 *    mtime, и stat-гейт молча пропустил бы реальное изменение.
 *  - `statHint` — mtime/size из инвентаря: неизменённый файл не требует даже
 *    stat, а значит и паузы между файлами.
 */
interface ProcessOptions {
  force?: boolean
  forceHash?: boolean
  statHint?: { mtime: number; size: number }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const yieldNow = () => new Promise<void>(r => setImmediate(r))

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** errno из ошибки fs/sidecar ('' если кода нет). */
function errnoOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

function isMissingErrno(code: string): boolean {
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Инвентарь полон И актуален: только тогда допустимы удаления из графа. */
function isAuthoritative(inv: FileInventoryStatus | null | undefined): boolean {
  return inv?.authoritative === true
}

function isCodeFile(relPath: string): boolean {
  return CODE_EXTS.has(path.extname(relPath).toLowerCase())
}

function isDocFile(relPath: string): boolean {
  return DOC_EXTS.has(path.extname(relPath).toLowerCase())
}

/** Минифицированный/гигантский файл: очень длинные строки или большой размер. */
function isMinifiedOrHuge(content: string): boolean {
  if (content.length > MAX_FILE_BYTES) return true
  // Минификация = мало переносов строк при большом размере либо строка-гигант.
  const head = content.slice(0, 50_000)
  const firstLines = head.split('\n', 40)
  for (const line of firstLines) {
    if (line.length > 1500) return true
  }
  const newlines = (head.match(/\n/g) ?? []).length
  if (head.length > 10_000 && newlines < 5) return true
  return false
}

class ProjectMapManager {
  private queue: string[] = []
  private activeProjectId: string | null = null
  private building: string | null = null
  private running = false
  private stopRequested = false
  private loopActive = false
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private progressCb: ((p: CodeMapProgress) => void) | null = null
  private foregroundBusy: () => boolean = () => false
  private watchers = new Map<string, () => void>()
  private watchedBuilds = new Map<string, { workdir: string; inventoryStartedAt: number }>()
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingChanges = new Map<string, Set<string>>()
  private incrementalBusy = new Set<string>()
  private lastEmit = new Map<string, number>()
  private enabled = true
  private speed: ProjectMapSpeedSettings = DEFAULT_PROJECT_MAP_SPEED
  private configReader: (() => { enabled: boolean; speed: ProjectMapSpeedSettings }) | null = null
  /** Тёплый индекс в памяти: не перечитываем весь граф из SQLite на каждый чих. */
  private indexCache = new Map<string, ProjectIndex>()
  /** Кэш importDetails/callSites (bounded LRU) — перерезолв без чтения файла. */
  private symbolCache = new Map<string, CachedSymbols>()
  /** Отложенные сверки: ждём завершения первичного скана инвентаря. */
  private reconcileUnsubs = new Map<string, () => void>()
  /** Когда по workdir впервые накопились изменения (потолок debounce). */
  private pendingFirstSeen = new Map<string, number>()

  /** Источник конфига (settings store). Вызывается при reloadConfig. */
  setConfigReader(fn: () => { enabled: boolean; speed: ProjectMapSpeedSettings }): void {
    this.configReader = fn
  }

  reloadConfig(): void {
    if (!this.configReader) return
    const cfg = this.configReader()
    this.enabled = cfg.enabled !== false
    this.speed = cfg.speed ?? DEFAULT_PROJECT_MAP_SPEED
    if (!this.enabled) this.stop()
    else if (!this.running) this.start()
  }

  /** Пауза между файлами фоновой индексации: manual = уровень, auto = железо. */
  private backgroundDelay(): number {
    if (this.speed.mode === 'manual') {
      const lvl = Math.max(0, Math.min(100, this.speed.level))
      return Math.round(150 * (1 - lvl / 100))
    }
    return this.autoInfo().backgroundDelayMs
  }

  /** Авто-бюджет от железа: больше ядер/памяти → меньше пауза, но всегда >0. */
  autoInfo(): ProjectMapAutoInfo {
    const cores = os.availableParallelism()
    const memGB = Math.round(os.totalmem() / 1024 / 1024 / 1024)
    let delay: number
    if (cores >= 8 && memGB >= 16) delay = 10
    else if (cores >= 4 && memGB >= 8) delay = 25
    else delay = 60
    return { cores, memGB, backgroundDelayMs: delay }
  }

  setProgressCallback(cb: (p: CodeMapProgress) => void): void {
    this.progressCb = cb
  }

  setForegroundPredicate(fn: () => boolean): void {
    this.foregroundBusy = fn
    semanticWorker.setForegroundPredicate(fn)
  }

  private emit(p: CodeMapProgress): void {
    // Busy-фазы шлём не чаще ~8/сек: иначе на каждый файл летит IPC + рендер
    // renderer'а (сотни/сек) и UI подвисает. ready/error всегда проходят.
    const busy = p.phase !== 'ready' && p.phase !== 'error'
    if (busy) {
      const now = Date.now()
      const last = this.lastEmit.get(p.projectId) ?? 0
      if (now - last < 120) return
      this.lastEmit.set(p.projectId, now)
    }
    try { this.progressCb?.(p) } catch { /* ignore */ }
  }

  /** Активный проект (открытый чат) получает приоритет в очереди. */
  setActiveProject(projectId: string | null): void {
    if (this.activeProjectId !== projectId) {
      this.activeProjectId = projectId
      semanticWorker.setActiveProject(projectId)
    }
    if (projectId) this.ensureProject(projectId)
    else this.kick()
  }

  /** Запустить фоновую индексацию всех проектов (активный — первым). */
  start(): void {
    if (this.running) return
    this.running = true
    this.stopRequested = false
    // Worker семантики: предикат «идёт сборка карты» → меньшие пачки и паузы,
    // чтобы embed-запросы не конкурировали с парсингом в serial-sidecar.
    semanticWorker.setMapBuildingPredicate(() => this.building !== null)
    semanticWorker.start()
    // Отложенный старт: БД инициализируется в registerChatIPC (позже регистрации
    // IPC), а startup не должен конкурировать с индексацией. Паттерн semanticIndex.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      if (this.stopRequested || !this.running || !this.enabled) return
      try {
        const projects = getAllProjects()
        const ordered = this.activeProjectId
          ? [this.activeProjectId, ...projects.map(p => p.id).filter(id => id !== this.activeProjectId)]
          : projects.map(p => p.id)
        for (const id of ordered) this.enqueueIfNeeded(id)
        this.kick()
      } catch (e) {
        console.warn('[projectMap] start failed:', e instanceof Error ? e.message : e)
      }
    }, 3000)
  }

  stop(): void {
    this.stopRequested = true
    this.running = false
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    semanticWorker.stop()
    for (const unsub of this.watchers.values()) unsub()
    this.watchers.clear()
    this.watchedBuilds.clear()
    for (const t of this.debounceTimers.values()) clearTimeout(t)
    this.debounceTimers.clear()
    this.indexCache.clear()
    this.symbolCache.clear()
    this.pendingFirstSeen.clear()
    // Очередь и флаги — часть состояния «идёт работа»: после stop() их нельзя
    // оставлять, иначе следующий start() подхватит протухшие отмены/форс и
    // соберёт проект, которого уже никто не просил.
    this.queue = []
    this.pendingChanges.clear()
    this.forceRebuild.clear()
    this.cancelBuild.clear()
    this.incrementalBusy.clear()
    this.lastEmit.clear()
    for (const unsub of this.reconcileUnsubs.values()) { try { unsub() } catch { /* ignore */ } }
    this.reconcileUnsubs.clear()
  }

  /** Принудительная полная пересборка карты проекта.
   *  Прерывает текущую сборку (и целевую, и чужую, занявшую builder — чужая
   *  достроится позже, hash-гейт делает это дешёвым).
   *
   *  Старый граф НЕ чистим: карта остаётся рабочей (и поиск по ней), пока
   *  новый проход не завершится успешно. Документы семантики тоже не
   *  удаляем — sync сохраняет векторы неизменённых текстов (hash-гейт), а
   *  осиротевшие документы снимает pruneProjectDocs после успешного прохода. */
  rebuildProject(projectId: string): void {
    this.forceRebuild.add(projectId)
    const current = this.building
    if (current) {
      this.cancelBuild.add(current)
      if (current !== projectId) this.enqueue(current)
    }
    semanticWorker.nudge()
    this.queue = [projectId, ...this.queue.filter(id => id !== projectId)]
    this.kick()
  }

  /** Построить карту проекта, если её ещё нет (или устарела). */
  ensureProject(projectId: string): void {
    this.enqueueIfNeeded(projectId)
    this.kick()
  }

  private enqueueIfNeeded(projectId: string): void {
    if (projectId === this.building || this.queue.includes(projectId)) return
    const project = getProjectById(projectId)
    if (!project) return
    // Reuse a complete map only when this manager built it against the same
    // live inventory. A persisted map still gets a check on startup; a stale,
    // replaced or incomplete inventory can trigger a new reconciliation.
    const watched = this.watchedBuilds.get(projectId)
    if (watched?.workdir === project.workdir) {
      const inventory = getInventoryStatus(project.workdir)
      if (inventory?.authoritative && inventory.startedAt === watched.inventoryStartedAt) return
    }
    this.enqueue(projectId)
  }

  private enqueue(projectId: string): void {
    // Проект может быть ЗАНЯТ сборкой прямо сейчас: сверка инвентаря,
    // отменённая пересборка и сверка инвентаря требуют следующего прохода.
    // Обычный ensure во время сборки проверяется отдельно.
    if (this.queue.includes(projectId)) return
    this.queue.push(projectId)
  }

  private kick(): void {
    if (this.loopActive || !this.running || this.stopRequested) return
    this.loopActive = true
    void this.loop().finally(() => { this.loopActive = false })
  }

  /** Сборку пора свернуть: стоп приложения или явная пересборка этого проекта. */
  private shouldStopBuild(projectId: string): boolean {
    return this.stopRequested || this.cancelBuild.has(projectId)
  }

  /**
   * Активный проект важнее фоновой сборки: его живые правки и его карта не
   * должны ждать, пока менеджер домучает чужой проект. Фоновая сборка в этом
   * случае сворачивается и возвращается в очередь (hash-гейт делает повтор
   * дешёвым).
   */
  private shouldDeferToActive(projectId: string): boolean {
    const active = this.activeProjectId
    if (!active || active === projectId) return false
    if (this.queue.includes(active)) return true
    const activeProject = getProjectById(active)
    return !!activeProject && this.pendingChanges.has(activeProject.workdir)
  }

  /**
   * Свернуть текущий проход: статус не должен остаться «building» (баннер
   * висел бы вечно), а тёплый индекс — опережать store (мы уже успели положить
   * в него узлы, которые не записали).
   */
  private abandonBuild(projectId: string): void {
    this.indexCache.delete(projectId)
    const hadFiles = store.listFiles(projectId).length > 0
    store.setStatus(projectId, { state: hadFiles ? 'ready' : 'idle' })
  }

  /** Вернуть проект в очередь, сохранив запрос на полную пересборку. */
  private deferBuild(projectId: string, force: boolean): void {
    if (force) this.forceRebuild.add(projectId)
    this.enqueue(projectId)
  }

  private async loop(): Promise<void> {
    while (this.running && !this.stopRequested) {
      // Живые правки активного проекта дренируем раньше фоновых сборок: иначе
      // открытый чат ждёт карту, пока менеджер парсит чужой проект.
      const activeId = this.activeProjectId
      if (activeId && this.building === null && !this.incrementalBusy.has(activeId) && !this.queue.includes(activeId)) {
        const activeProject = getProjectById(activeId)
        if (activeProject && this.pendingChanges.has(activeProject.workdir)) {
          await this.flushChanges(activeProject.workdir)
          continue
        }
      }
      if (this.queue.length === 0) break
      // Проект, по которому уже идёт инкрементал, полной сборкой не трогаем:
      // два писателя в один граф недопустимы. Ждём, пока он освободится.
      let pick = -1
      if (activeId && !this.incrementalBusy.has(activeId)) {
        const ai = this.queue.indexOf(activeId)
        if (ai >= 0) pick = ai
      }
      if (pick < 0) pick = this.queue.findIndex(id => !this.incrementalBusy.has(id))
      if (pick < 0) {
        await sleep(50)
        continue
      }
      const projectId = this.queue.splice(pick, 1)[0]
      this.building = projectId
      const force = this.forceRebuild.delete(projectId)
      // Прошлый прогон этого проекта могли отменить ради пересборки — новый
      // старт снимает отмену (иначе свежая сборка тут же прервёт сама себя).
      this.cancelBuild.delete(projectId)
      try {
        await this.buildProject(projectId, force)
        // Сборку прервали ради пересборки: флаг force уже взведён вызывающим
        // (rebuildProject) и проект снова в очереди — не теряем его.
        if (this.cancelBuild.has(projectId)) {
          log('[mapBuilder] build of %s cancelled by rebuild — force preserved', projectId)
          this.cancelBuild.delete(projectId)
          this.deferBuild(projectId, force)
        }
      } catch (e) {
        const msg = errorText(e)
        this.indexCache.delete(projectId)
        store.setStatus(projectId, { state: 'error', error: msg })
        this.emit({ projectId, phase: 'error', percent: 0, indexedFiles: 0, totalFiles: 0, error: msg, projectName: getProjectById(projectId)?.name, pendingProjects: this.queue.length })
        console.warn(`[projectMap] build failed for ${projectId}:`, msg)
      } finally {
        this.building = null
      }
      // Правки, накопившиеся ПОКА шла сборка, не должны ждать следующего
      // события watcher'а: ставим сброс сразу после освобождения проекта.
      const workdir = getProjectById(projectId)?.workdir
      if (workdir && this.pendingChanges.has(workdir) && !this.stopRequested) {
        this.armDebounce(workdir, 0)
      }
      await yieldNow()
    }
  }

  private forceRebuild = new Set<string>()
  /** Сборки, прерванные явной пересборкой: buildProject проверяет в циклах. */
  private cancelBuild = new Set<string>()

  /**
   * Пауза между файлами с проверкой приоритета.
   *
   * Раньше здесь был waitWhileBusy() до 60 с, а ПОСЛЕ него — ещё и пауза
   * backgroundDelay(): активный проект не ждал чат, но фоновая сборка стояла
   * двойной бюджет на каждом файле. Теперь ожидание ограничено и прерывается
   * отменой/приоритетом активного проекта.
   *
   * Возвращает false — проход надо свернуть.
   */
  private async yieldForForeground(projectId: string, isActive: boolean): Promise<boolean> {
    if (this.shouldStopBuild(projectId)) return false
    if (isActive) {
      // Активный проект не ждёт занятый чат — только отдаёт event loop.
      await yieldNow()
      return !this.shouldStopBuild(projectId)
    }
    if (this.shouldDeferToActive(projectId)) return false
    const deadline = Date.now() + FOREGROUND_WAIT_MS
    while (this.foregroundBusy() && Date.now() < deadline) {
      if (this.shouldStopBuild(projectId) || this.shouldDeferToActive(projectId)) return false
      await sleep(100)
    }
    // Чат всё ещё занят — одна пауза между файлами (не wait + sleep дважды).
    await sleep(this.backgroundDelay())
    return !this.shouldStopBuild(projectId) && !this.shouldDeferToActive(projectId)
  }

  private ensureWatcher(projectId: string, workdir: string): void {
    if (this.watchers.has(workdir)) return
    const unsub = subscribeFileChanges(workdir, (relPaths) => this.onFileChanges(workdir, relPaths))
    this.watchers.set(workdir, unsub)
    void projectId
  }

  private scanCodeFiles(workdir: string): { relPath: string; absPath: string; size: number; mtime: number }[] {
    return getAllFiles(workdir)
      .filter(f => isCodeFile(f.relPath))
      .slice(0, MAX_FILES + 1)
      .map(f => ({ relPath: f.relPath, absPath: f.path, size: f.size, mtime: f.mtime }))
  }

  /** Markdown/ADR-файлы проекта (README, docs/, ADR) — узлы-секции карты. */
  private scanDocFiles(workdir: string): { relPath: string; absPath: string; size: number; mtime: number }[] {
    return getAllFiles(workdir)
      .filter(f => isDocFile(f.relPath))
      .slice(0, MAX_FILES + 1)
      .map(f => ({ relPath: f.relPath, absPath: f.path, size: f.size, mtime: f.mtime }))
  }

  /**
   * Разбор markdown из уже прочитанного содержимого: узлы file + секции по
   * заголовкам. Содержимое секции попадает в `doc`, поэтому документ семантики
   * — реальный текст, а не путь.
   */
  private buildDocRaw(
    projectId: string, relPath: string, content: string, hash: string, size: number, mtime: number,
  ): RawFile {
    const nodes = markdownNodes(projectId, relPath, content)
    const meta: CodeMapFile = {
      projectId,
      path: relPath,
      language: 'markdown',
      hash,
      mtime,
      size,
      parser: 'markdown-headings',
      truncated: false,
      indexedAt: Date.now(),
    }
    return {
      meta,
      symbols: {
        definitions: [],
        imports: [],
        references: [],
        importDetails: [],
        callSites: [],
        language: 'markdown',
        parser: 'markdown-headings',
        supported: true,
        truncated: false,
      },
      nodes,
    }
  }

  /**
   * Обработать один файл: async stat → async чтение → hash-гейт → парсер.
   *
   * Файл читается РОВНО один раз (раньше инкрементал читал его дважды: для
   * hash-проверки и внутри parseFile). Ошибки классифицируются, а не сваливаются
   * в `null`: удалять узлы файла можно только при ENOENT или намеренном
   * исключении — EACCES/таймаут парсера оставляют старый граф живым.
   */
  private async processFile(
    projectId: string, relPath: string, absPath: string,
    prev: CodeMapFile | undefined, opts: ProcessOptions = {},
  ): Promise<FileOutcome> {
    const { force = false, forceHash = false, statHint } = opts
    // Мгновенный фильтр по подсказке инвентаря: mtime+size совпали с прошлой
    // записью → файл не менялся, даже stat не нужен (а значит и пауза).
    if (!force && !forceHash && prev && prev.hash && statHint
      && prev.mtime === statHint.mtime && prev.size === statHint.size) {
      return { kind: 'unchanged', mtime: statHint.mtime, size: statHint.size }
    }
    let st: { size: number; mtimeMs: number; isDirectory: () => boolean }
    try {
      const s = await stat(absPath)
      st = { size: s.size, mtimeMs: s.mtimeMs, isDirectory: () => s.isDirectory() }
    } catch (e) {
      const code = errnoOf(e)
      if (isMissingErrno(code)) return { kind: 'missing' }
      return { kind: 'transient', error: `stat ${relPath}: ${errorText(e)}` }
    }
    // Каталог (watcher присылает и их) и гигантский файл отбрасываем ДО чтения.
    if (st.isDirectory()) return { kind: 'excluded' }
    if (st.size > MAX_FILE_BYTES) return { kind: 'excluded' }
    // Мгновенный фильтр: mtime+size совпали → файл не менялся, не читаем.
    if (!force && !forceHash && prev && prev.hash && prev.mtime === st.mtimeMs && prev.size === st.size) {
      return { kind: 'unchanged', mtime: st.mtimeMs, size: st.size }
    }
    let content: string
    try {
      content = await readFile(absPath, 'utf-8')
    } catch (e) {
      const code = errnoOf(e)
      if (isMissingErrno(code)) return { kind: 'missing' }
      return { kind: 'transient', error: `read ${relPath}: ${errorText(e)}` }
    }
    const hash = sha256(content)
    // touch без правки содержимого — обновляем stat, граф не трогаем.
    if (!force && prev && prev.hash === hash) {
      return { kind: 'unchanged', mtime: st.mtimeMs, size: st.size }
    }
    // Markdown не минифицируют: эвристика «мало переносов = мусор» ломала бы
    // длинные таблицы/абзацы и выбрасывала README из карты. Размер уже
    // проверен по stat до чтения.
    if (isDocFile(relPath)) {
      return { kind: 'ok', raw: this.buildDocRaw(projectId, relPath, content, hash, st.size, st.mtimeMs) }
    }
    if (!isCodeFile(relPath)) return { kind: 'excluded' }
    if (isMinifiedOrHuge(content)) return { kind: 'excluded' }
    let symbols: SidecarSymbolsResult
    try {
      symbols = await sidecarSymbols(absPath, content, { skipReferences: false })
    } catch (e) {
      // Таймаут/ошибка парсера — временный сбой: узлы файла не удаляем,
      // иначе один сбойный файл выпадал бы из графа вместе со связями.
      return { kind: 'transient', error: `parse ${relPath}: ${errorText(e)}` }
    }
    if (!symbols.supported) return { kind: 'excluded' }
    const nodes = definitionsToNodes(projectId, relPath, symbols.definitions)
    // `exported` считается по исходнику: sidecar отдаёт signature без модификатора.
    markExported(nodes, content, symbols.language)
    const fileNode: CodeMapNode = {
      id: store.fileNodeId(relPath),
      projectId,
      filePath: relPath,
      name: path.basename(relPath),
      kind: 'file',
      parentName: null,
      lineStart: 0,
      lineEnd: 0,
      signature: '',
      exported: false,
    }
    const meta: CodeMapFile = {
      projectId,
      path: relPath,
      language: symbols.language,
      hash,
      mtime: st.mtimeMs,
      size: st.size,
      parser: symbols.parser,
      truncated: symbols.truncated,
      indexedAt: Date.now(),
    }
    this.cacheSymbols(projectId, relPath, {
      hash,
      language: symbols.language,
      importDetails: symbols.importDetails,
      callSites: symbols.callSites,
    })
    return { kind: 'ok', raw: { meta, symbols, nodes: [fileNode, ...nodes] } }
  }

  private symbolKey(projectId: string, relPath: string): string {
    return projectId + '\0' + relPath
  }

  private cacheSymbols(projectId: string, relPath: string, entry: CachedSymbols): void {
    const key = this.symbolKey(projectId, relPath)
    this.symbolCache.delete(key)
    this.symbolCache.set(key, entry)
    while (this.symbolCache.size > MAX_SYMBOL_CACHE) {
      const oldest = this.symbolCache.keys().next().value
      if (oldest === undefined) break
      this.symbolCache.delete(oldest)
    }
  }

  /** Кэш только для того же содержимого (hash) — иначе запись протухла. */
  private cachedSymbols(projectId: string, relPath: string, hash: string): CachedSymbols | null {
    const key = this.symbolKey(projectId, relPath)
    const hit = this.symbolCache.get(key)
    if (!hit) return null
    if (hit.hash !== hash) {
      this.symbolCache.delete(key)
      return null
    }
    // LRU-touch: свежие импортёры не вымываются первыми.
    this.symbolCache.delete(key)
    this.symbolCache.set(key, hit)
    return hit
  }

  /**
   * Отложенная сверка: первичный скан инвентаря ещё идёт, карта построена
   * частично. Ждём событие окончания скана (без polling и без блокировки
   * очереди) и ставим проект в очередь на финальный проход.
   */
  private scheduleReconcile(projectId: string, workdir: string): void {
    if (this.reconcileUnsubs.has(workdir)) return
    const unsub = onInventoryComplete(workdir, (status) => {
      this.reconcileUnsubs.delete(workdir)
      if (!status) return
      if (this.stopRequested || !this.running || !this.enabled) return
      log(
        '[mapBuilder] inventory complete for %s (authoritative=%s, files=%d) — планирую сверку карты',
        projectId, status.authoritative, status.files,
      )
      this.enqueue(projectId)
      this.kick()
    }, { timeoutMs: RECONCILE_TIMEOUT_MS })
    this.reconcileUnsubs.set(workdir, unsub)
  }

  /**
   * Файлы, зависящие от изменённого (входящие imports/calls/references, включая
   * ссылки на символы внутри файла). Их рёбра могли поменяться.
   */
  private dependentPaths(projectId: string, filePath: string): string[] {
    return store.getDependentFilePaths(projectId, filePath).filter(p => p !== filePath)
  }

  /**
   * Пересчитать ТОЛЬКО рёбра файла (узлы и документы семантики не менялись):
   * importDetails/callSites из кэша, replaceFileEdges вместо полного
   * replaceFile. false — кэша нет, вызывающий разбирает файл сам (один раз).
   */
  private reResolveFromCache(
    projectId: string, index: ProjectIndex, relPath: string, prev: CodeMapFile | null | undefined,
  ): boolean {
    if (!prev || isDocFile(relPath)) return false
    const nodes = index.defsByFile.get(relPath)
    if (!nodes || nodes.length === 0) return false
    const cached = this.cachedSymbols(projectId, relPath, prev.hash)
    if (!cached) return false
    this.writeFileEdges(index, relPath, nodes, cached.importDetails, cached.callSites, cached.language)
    return true
  }

  /**
   * Записать рёбра файла и durable-след его неразрешённых ссылок ОДНИМ
   * проходом резолвинга: у неразрешённой ссылки ребра нет, поэтому без следа
   * её не найти, когда цель появится (см. recoverUnresolved).
   */
  private writeFileEdges(
    index: ProjectIndex,
    relPath: string,
    nodes: CodeMapNode[],
    importDetails: CachedSymbols['importDetails'],
    callSites: CachedSymbols['callSites'],
    language: string | null,
  ): void {
    const projectId = index.projectId
    const importRes = resolveFileImports(index, relPath, importDetails, language)
    ensurePackages(projectId, importRes.packages)
    const callRes = resolveFileCalls(index, relPath, callSites, importDetails, language)
    const contains = containsEdges(projectId, relPath, nodes)
    store.replaceFileEdges(projectId, relPath, [...importRes.edges, ...callRes.edges, ...contains])
    store.replaceUnresolved(projectId, relPath, [...importRes.unresolved, ...callRes.unresolved])
  }

  /**
   * Кандидаты на точечное восстановление ранее неразрешённых ссылок.
   *
   * У «висящего» импорта/вызова ребра нет, поэтому по входящим рёбрам такой
   * импортёр не находится. Ищем его обратным lookup'ом по durable-следу
   * code_map_unresolved (индекс (project_id, kind, key)): ключи — имена
   * новых/изменённых файлов и их символов, т.е. ровно то, чем правка могла
   * закрыть чужую ссылку. Без полного скана проекта и без чтения файлов.
   */
  private recoveryCandidates(
    projectId: string, index: ProjectIndex, arrived: string[], skip: Set<string>,
  ): string[] {
    if (arrived.length === 0) return []
    const fileKeys = new Set<string>()
    const symbolKeys = new Set<string>()
    for (const relPath of arrived) {
      if (isDocFile(relPath)) continue
      for (const k of fileLookupKeys(relPath)) fileKeys.add(k)
      for (const n of index.defsByFile.get(relPath) ?? []) {
        if (n.kind === 'file' || n.kind === 'package' || !n.name) continue
        symbolKeys.add(n.name.toLowerCase())
      }
    }
    const out = new Set<string>()
    const add = (filePath: string): void => {
      if (!filePath || skip.has(filePath) || out.has(filePath)) return
      if (out.size >= RECOVERY_MAX_CANDIDATES) return
      out.add(filePath)
    }
    for (const hit of store.findUnresolvedByKeys(projectId, 'import', [...fileKeys], RECOVERY_MAX_CANDIDATES)) {
      add(hit.filePath)
    }
    for (const hit of store.findUnresolvedByKeys(projectId, 'call', [...symbolKeys], RECOVERY_MAX_CANDIDATES)) {
      add(hit.filePath)
    }
    return [...out]
  }

  /**
   * Пересчитать рёбра импортёра без переразбора узлов и БЕЗ переэмбеддинга:
   * importDetails/callSites из кэша, при промахе — один принудительный разбор
   * (не больше RECOVERY_MAX_PARSES на проход), запись только через
   * replaceFileEdges. Документы семантики не трогаются.
   */
  private async refreshFileEdges(
    projectId: string, index: ProjectIndex, workdir: string, relPath: string,
    prev: CodeMapFile | null | undefined, budget: { parses: number },
  ): Promise<void> {
    if (isDocFile(relPath)) {
      const nodes = index.defsByFile.get(relPath)
      if (nodes) store.replaceFileEdges(projectId, relPath, [
        ...containsEdges(projectId, relPath, nodes),
        ...docReferenceEdges(index, relPath, nodes),
      ])
      return
    }
    if (this.reResolveFromCache(projectId, index, relPath, prev)) return
    // Промах кэша: processFile без force вернул бы 'unchanged' и рёбра никогда
    // бы не пересчитались. Разбор ограничен бюджетом прохода.
    if (budget.parses <= 0) return
    budget.parses--
    const outcome = await this.processFile(projectId, relPath, path.join(workdir, relPath), prev ?? undefined, { force: true })
    if (outcome.kind !== 'ok') return
    if (prev && outcome.raw.meta.hash !== prev.hash) {
      // Содержимое поменялось, пока шёл проход — обычный путь (переразбор файла).
      this.onFileChanges(workdir, [relPath])
      return
    }
    this.writeEdgesOnly(index, outcome.raw)
  }

  /** Запись markdown-файла: contains от файла к секциям + references на символы. */
  private resolveAndWriteDoc(index: ProjectIndex, raw: RawFile): void {
    const { meta, nodes } = raw
    const contains = containsEdges(index.projectId, meta.path, nodes)
    const refs = docReferenceEdges(index, meta.path, nodes)
    store.replaceFile(index.projectId, meta, nodes, [...contains, ...refs])
    syncFileDocs(index.projectId, meta.path, nodes)
  }

  private loadAliases(workdir: string): Map<string, string> {
    return loadTsconfigAliases(workdir, (p) => {
      try { return existsSync(p) ? readFileSync(p, 'utf-8') : null } catch { return null }
    })
  }

  /** Загрузить индекс проекта из уже сохранённых узлов (для warm/инкрементал).
      Страницами с yield — чтобы не блокировать main длинным sync-чтением. */
  private async indexFromStore(projectId: string, workdir: string): Promise<ProjectIndex> {
    const index = new ProjectIndex(projectId, workdir)
    index.aliases = this.loadAliases(workdir)
    const byFile = new Map<string, CodeMapNode[]>()
    const PAGE = 2000
    let offset = 0
    for (;;) {
      const nodes = store.listNodes(projectId, PAGE, offset)
      if (nodes.length === 0) break
      for (const n of nodes) {
        if (n.kind === 'package') continue
        const list = byFile.get(n.filePath) ?? []
        list.push(n)
        byFile.set(n.filePath, list)
      }
      offset += nodes.length
      if (nodes.length === PAGE) await yieldNow()
    }
    let i = 0
    for (const [filePath, fileNodes] of byFile) {
      index.addFileNodes(filePath, fileNodes)
      if (++i % 200 === 0) await yieldNow()
    }
    for (const f of store.listFiles(projectId)) index.files.add(f.path)
    return index
  }

  /** Индекс из кэша или тёплая загрузка из store (один раз на проект). */
  private async getIndex(projectId: string, workdir: string): Promise<ProjectIndex> {
    let idx = this.indexCache.get(projectId)
    if (!idx) {
      idx = await this.indexFromStore(projectId, workdir)
      this.indexCache.set(projectId, idx)
    }
    return idx
  }

  private resolveAndWrite(index: ProjectIndex, raw: RawFile): void {
    const { meta, symbols, nodes } = raw
    const importRes = resolveFileImports(index, meta.path, symbols.importDetails, meta.language)
    ensurePackages(index.projectId, importRes.packages)
    const callRes = resolveFileCalls(index, meta.path, symbols.callSites, symbols.importDetails, meta.language)
    const contains = containsEdges(index.projectId, meta.path, nodes)
    const edges: CodeMapEdge[] = [...importRes.edges, ...callRes.edges, ...contains]
    store.replaceFile(index.projectId, meta, nodes, edges)
    // След неразрешённых ссылок пишем В ТОЙ ЖЕ точке, что и рёбра: позже по
    // нему точечно восстановим ребро, когда цель появится в проекте.
    store.replaceUnresolved(index.projectId, meta.path, [...importRes.unresolved, ...callRes.unresolved])
    // Семантика — производное карты: документы пересчитываются из узлов здесь же
    // (полная сборка и инкрементал проходят через эту точку). Хэш-гейт в store
    // сохраняет векторы неизменённых текстов, worker доэмбеддит только новое.
    syncFileDocs(index.projectId, meta.path, nodes)
  }

  private async buildProject(projectId: string, force: boolean): Promise<void> {
    this.watchedBuilds.delete(projectId)
    const project = getProjectById(projectId)
    if (!project) return
    const workdir = project.workdir
    const projectName = project.name
    if (!existsSync(workdir)) {
      // Проект переехал/удалён — это не «ошибка карты», а отсутствующая папка.
      store.setStatus(projectId, { state: 'error', error: 'Папка проекта не найдена: ' + workdir })
      return
    }

    // Смена правил построения карты → одноразовая полная пересборка. Старый
    // граф НЕ чистим: карта и поиск по ней остаются рабочими, пока новый
    // проход не завершится успешно. schemaVersion пишем ТОЛЬКО после успешного
    // авторитетного прохода — иначе частичная сборка «застолбила» бы новую
    // схему, не пересобрав данные (и апгрейд больше не повторился бы).
    const storedVersion = store.getMeta(projectId, 'schemaVersion')
    const schemaOutdated = storedVersion !== MAP_SCHEMA_VERSION
    if (schemaOutdated) {
      force = true
      log('[mapBuilder] %s: schema %s → %s, полная пересборка (граф сохраняется до успеха)', projectName, storedVersion ?? 'none', MAP_SCHEMA_VERSION)
    }

    store.setStatus(projectId, { state: 'building', startedAt: Date.now(), error: null })
    this.emit({ projectId, phase: 'scanning', percent: 0, indexedFiles: 0, totalFiles: 0, projectName, pendingProjects: this.queue.length })

    // startIndexing теперь резолвится только после полного первичного скана:
    // ждать его в очереди менеджера нельзя (встанут все проекты и активный
    // чат) — fire-and-catch, а готовность читаем из статуса инвентаря.
    void startIndexing(workdir).catch(e => {
      log('[mapBuilder] %s: startIndexing failed: %s', projectName, errorText(e))
    })

    // Тёплый индекс = текущий граф из store. Он же основа резолвинга при force:
    // файлы, которые ещё не перепарсились, продолжают участвовать в связях.
    const index = await this.getIndex(projectId, workdir)
    if (index.aliases.size === 0) index.aliases = this.loadAliases(workdir)

    let inv = getInventoryStatus(workdir)
    const readyAtStart = inv?.ready === true
    if (!readyAtStart) {
      // Очень короткое ожидание: на тёплом инвентаре оно мгновенное, на
      // холодном — не превращается в блокировку очереди.
      const waited = await whenInventoryReady(workdir, PARTIAL_WAIT_MS)
      inv = waited ?? getInventoryStatus(workdir)
    }
    const files = this.scanCodeFiles(workdir)
    const docFiles = this.scanDocFiles(workdir)
    const capped = files.length > MAX_FILES || docFiles.length > MAX_FILES
    if (files.length > MAX_FILES) files.pop()
    if (docFiles.length > MAX_FILES) docFiles.pop()
    const authoritative = isAuthoritative(inv) && !capped
    if (!authoritative) {
      if (!readyAtStart && inv?.ready !== true) this.scheduleReconcile(projectId, workdir)
      log(
        '[mapBuilder] %s: инвентарь неполон (ready=%s complete=%s watcher=%s truncated=%s errors=%s) — строю частичную карту, удаления отключены',
        projectName, String(inv?.ready), String(inv?.complete), String(inv?.watcherActive), String(inv?.truncated), String(inv?.scanErrors),
      )
    }
    this.ensureWatcher(projectId, workdir)
    const total = files.length + docFiles.length
    store.setStatus(projectId, { totalFiles: total })

    const existing = new Map(store.listFiles(projectId).map(f => [f.path, f]))

    const isActive = projectId === this.activeProjectId
    const toResolve: RawFile[] = []
    const toResolveDocs: RawFile[] = []
    const excludedPaths: string[] = []
    const gonePaths: string[] = []
    let done = 0
    /** Временные сбои: проход не может считаться полным (ready/schemaVersion). */
    let transient = 0

    // ── Фаза 1: парсинг/чтение ──
    // Сначала узлы ВСЕХ файлов попадают в индекс, только потом резолвим: иначе
    // ссылка из файла N на файл N+1 не находилась бы (порядок обхода решал,
    // какие связи существуют — «same-batch linkage»).
    const scan = async (
      list: { relPath: string; absPath: string; size: number; mtime: number }[],
      sink: RawFile[], progressBase: number, progressSpan: number,
    ): Promise<boolean> => {
      for (const f of list) {
        if (this.shouldStopBuild(projectId)) return false
        const prev = existing.get(f.relPath)
        // Подсказка инвентаря: неизменённый файл не читается и не статится.
        const outcome = await this.processFile(projectId, f.relPath, f.absPath, prev, {
          force, statHint: { mtime: f.mtime, size: f.size },
        })
        done++
        let settled = false
        switch (outcome.kind) {
          case 'ok': {
            const raw = outcome.raw
            index.removeFile(f.relPath)
            index.addFileNodes(f.relPath, raw.nodes)
            sink.push(raw)
            break
          }
          case 'unchanged':
            // stat тот же — писать нечего; при touch обновляем только mtime/size.
            if (prev && (prev.mtime !== outcome.mtime || prev.size !== outcome.size)) {
              store.updateFileStat(projectId, f.relPath, outcome.mtime, outcome.size)
            }
            settled = true
            break
          case 'excluded':
            // Намеренное исключение (minified/каталог/гигант): узлы убираем —
            // это не сбой, файл просто не индексируется.
            excludedPaths.push(f.relPath)
            break
          case 'missing':
            gonePaths.push(f.relPath)
            break
          case 'transient':
            // Временный сбой: старый граф файла сохраняем целиком.
            transient++
            console.warn(`[projectMap] ${projectName}: временный сбой, файл оставлен в графе — ${outcome.error}`)
            settled = true
            break
        }
        this.emit({ projectId, phase: 'parsing', percent: progressBase + Math.round((done / Math.max(1, total)) * progressSpan), indexedFiles: done, totalFiles: total, projectName, pendingProjects: this.queue.length })
        // Неизменённые/сбойные файлы не стоят паузы: иначе тёплый проход по
        // 10k файлам «отдыхал» бы между ними часами.
        if (settled) continue
        if (!(await this.yieldForForeground(projectId, isActive))) return false
      }
      return true
    }

    if (!(await scan(files, toResolve, 0, 90))) {
      this.abandonBuild(projectId)
      this.deferBuild(projectId, force)
      return
    }

    // ── Удаления подтверждённых отсутствующих/исключённых — ДО резолвинга ──
    // Иначе импорт на удалённый файл «разрешился» бы в его же осиротевшие узлы,
    // которые мы уберём строкой позже, и в графе осталось бы ребро в никуда.
    let removed = 0
    const deleteFiles = (paths: Iterable<string>): void => {
      for (const p of paths) {
        store.removeFile(projectId, p)
        removeFileDocs(projectId, p)
        index.removeFile(p)
        removed++
      }
    }
    deleteFiles(excludedPaths)
    deleteFiles(gonePaths)
    if (gonePaths.length > 0) {
      log('[mapBuilder] %s: удалено %d подтверждённо отсутствующих файлов', projectName, gonePaths.length)
    }

    // ── Фаза 2: резолвинг + запись (все узлы уже в индексе) ──
    let resolved = 0
    for (const raw of toResolve) {
      if (this.shouldStopBuild(projectId)) {
        this.abandonBuild(projectId)
        this.deferBuild(projectId, force)
        return
      }
      this.resolveAndWrite(index, raw)
      resolved++
      this.emit({ projectId, phase: 'resolving', percent: 90 + Math.round((resolved / Math.max(1, toResolve.length)) * 5), indexedFiles: done, totalFiles: total, projectName, pendingProjects: this.queue.length })
      await yieldNow()
    }

    // ── Документы (markdown/ADR) ──
    // ПОСЛЕ кода: references секций ищутся по полному индексу символов проекта.
    if (!(await scan(docFiles, toResolveDocs, 90, 5))) {
      this.abandonBuild(projectId)
      this.deferBuild(projectId, force)
      return
    }
    for (const raw of toResolveDocs) {
      if (this.shouldStopBuild(projectId)) {
        this.abandonBuild(projectId)
        this.deferBuild(projectId, force)
        return
      }
      this.resolveAndWriteDoc(index, raw)
      await yieldNow()
    }

    // ── Удаления по авторитетному инвентарю ──
    // Авторитетный инвентарь → файлы, которых нет в списке, реально удалены.
    // Частичный → НИЧЕГО не удаляем по списку (отсутствие в неполном списке не
    // значит удаление); подтверждённые ENOENT уже убраны выше.
    if (authoritative) {
      const onDisk = new Set([...files.map(f => f.relPath), ...docFiles.map(f => f.relPath)])
      const vanished: string[] = []
      for (const f of store.listFiles(projectId)) {
        if (!onDisk.has(f.path)) vanished.push(f.path)
      }
      // Перепроверка живого инвентаря перед разрушительной чисткой: скан мог
      // завершиться, пока мы парсили, и список уже другой.
      const live = getInventoryStatus(workdir)
      if (live?.authoritative && live.startedAt === inv?.startedAt) {
        const liveSet = new Set(getAllFiles(workdir).map(f => f.relPath))
        for (const p of vanished) {
          if (liveSet.has(p)) continue
          // existsSync возвращает false и на EACCES/EPERM — удалять по нему
          // живой файл нельзя. Различаем «нет файла» и «нет доступа».
          let st: { isDirectory: () => boolean } | null = null
          try {
            st = await stat(path.join(workdir, p))
          } catch (e) {
            const code = errnoOf(e)
            if (!isMissingErrno(code)) {
              log('[mapBuilder] %s: %s не удалён — stat вернул %s', projectName, p, code || errorText(e))
              continue
            }
          }
          if (st) continue
          store.removeFile(projectId, p)
          removeFileDocs(projectId, p)
          index.removeFile(p)
          removed++
        }
      } else {
        log('[mapBuilder] %s: инвентарь перестал быть авторитетным во время сборки — удаление отменено', projectName)
      }
    }

    // ── Бэкфилл документов семантики ──
    // syncFileDocs вызывается при переразборе файла; карта, построенная до
    // появления семантического слоя, документов не имеет. Каждый файл даёт
    // минимум один документ, причём tier-0 (lexicalOnly) тоже документ: без
    // него условие «docs < files» было верным всегда и весь проект
    // пересинхронизировался на КАЖДОМ проходе. Синхронизируем только файлы,
    // у которых документов реально нет.
    const docs = store.countDocs(projectId)
    if (docs.total + docs.lexicalOnly < index.files.size) {
      let backfilled = 0
      let i = 0
      for (const [filePath, fileNodes] of index.defsByFile) {
        if (this.shouldStopBuild(projectId)) break
        if (store.listDocMetaByFile(projectId, filePath).size > 0) continue
        syncFileDocs(projectId, filePath, fileNodes)
        backfilled++
        if (++i % 100 === 0) await yieldNow()
      }
      if (backfilled > 0) {
        log('[projectMap] semantic backfill: %d files synced for %s (docs %d+%d, files %d)', backfilled, projectName, docs.total, docs.lexicalOnly, index.files.size)
      }
    }

    // prune — полный скан рёбер (sync): только когда реально что-то удалили.
    if (removed > 0) store.pruneDanglingEdges(projectId)
    // Финальная авторитетность — по ЖИВОМУ инвентарю: скан мог упасть/умереть,
    // пока мы парсили, и тогда «ready» был бы ложью.
    const finalInv = getInventoryStatus(workdir)
    const finalAuthoritative = authoritative && finalInv?.authoritative === true && inv?.startedAt === finalInv.startedAt
    // Временные сбои (EACCES, таймаут парсера) — карта неполна по составу:
    // ready не врём, схему не «застолбляем».
    const complete = finalAuthoritative && transient === 0
    // Осиротевшие документы снимаем только после успешного прохода и только
    // если граф полон: на частичной карте pruneProjectDocs удалил бы документы
    // живых файлов вместе с их векторами.
    if (complete) pruneProjectDocs(projectId)
    // Схема «застолблена» только успешным полным проходом.
    if (complete && schemaOutdated) store.setMeta(projectId, 'schemaVersion', MAP_SCHEMA_VERSION)
    store.refreshCounts(projectId)
    const status = store.getStatus(projectId)
    const finalState: CodeMapState = complete ? 'ready' : STATE_PARTIAL
    // «Файлы» — фактическое содержимое графа, а не число найденных на диске
    // файлов (часть пропускается как minified/огромные).
    store.setStatus(projectId, { state: finalState, indexedFiles: status.indexedFiles, totalFiles: status.indexedFiles })
    if (complete && !this.shouldStopBuild(projectId) && finalInv) {
      this.watchedBuilds.set(projectId, { workdir, inventoryStartedAt: finalInv.startedAt })
    }
    invalidateAnalytics(projectId)
    const summary = `${status.totalNodes} узлов, ${status.totalEdges} связей`
    this.emit({
      projectId,
      phase: complete ? 'ready' : PHASE_PARTIAL,
      percent: 100,
      indexedFiles: status.indexedFiles,
      totalFiles: status.indexedFiles,
      message: complete ? summary : `частичная карта (инвентарь неполон или были сбои: ${transient}): ${summary}`,
      projectName,
      pendingProjects: this.queue.length,
    })
  }

  // ─── Инкрементальные обновления ────────────────────────────────────────────

  private onFileChanges(workdir: string, relPaths: string[]): void {
    // Двойная защита: fileIndexer уже не эмитит игнорируемые пути, но watcher
    // может прислать что угодно (node_modules после npm i, сгенерированные
    // *.d.ts, каталоги). Такие файлы в карту не пускаем вообще.
    const code = relPaths.filter(p => (isCodeFile(p) || isDocFile(p)) && !isPathIgnored(workdir, p))
    if (code.length === 0) return
    this.addPending(workdir, code)
    // Потолок debounce: непрерывный поток событий (git checkout, автоформат,
    // сборка) перевзводил бы таймер бесконечно и карта не обновлялась бы вовсе.
    const firstSeen = this.pendingFirstSeen.get(workdir)
    const now = Date.now()
    if (firstSeen === undefined) this.pendingFirstSeen.set(workdir, now)
    const elapsed = firstSeen === undefined ? 0 : now - firstSeen
    this.armDebounce(workdir, Math.max(50, Math.min(CHANGE_DEBOUNCE_MS, MAX_DEBOUNCE_MS - elapsed)))
  }

  /** Добавить пути в набор «ждёт сброса», без таймера. */
  private addPending(workdir: string, relPaths: Iterable<string>): void {
    let set = this.pendingChanges.get(workdir)
    if (!set) {
      set = new Set()
      this.pendingChanges.set(workdir, set)
    }
    for (const p of relPaths) set.add(p)
  }

  /** (Пере)взвести таймер сброса правок для workdir. */
  private armDebounce(workdir: string, delay: number): void {
    const prev = this.debounceTimers.get(workdir)
    if (prev) clearTimeout(prev)
    this.debounceTimers.set(workdir, setTimeout(() => {
      this.debounceTimers.delete(workdir)
      this.pendingFirstSeen.delete(workdir)
      void this.flushChanges(workdir)
    }, delay))
  }

  /**
   * Пересчитать ТОЛЬКО рёбра файла из свежего разбора (узлы те же: hash
   * совпал). Используется, когда файл перечитали ради проверки содержимого
   * (watcher), но узлы писать заново не нужно.
   */
  private writeEdgesOnly(index: ProjectIndex, raw: RawFile): void {
    const { meta, symbols, nodes } = raw
    this.writeFileEdges(index, meta.path, nodes, symbols.importDetails, symbols.callSites, meta.language)
  }

  private async flushChanges(workdir: string): Promise<void> {
    const pending = this.pendingChanges.get(workdir)
    this.pendingChanges.delete(workdir)
    if (!pending || pending.size === 0) return
    const project = getProjectByWorkdir(workdir)
    if (!project) return
    const projectId = project.id
    // Полная сборка этого проекта идёт — правки не теряем, а откладываем.
    // Таймер НЕ взводим: пока сборка идёт, он перевзводился бы бесконечно, а
    // карту всё равно нельзя обновлять двумя писателями. Сброс взведёт сам
    // builder сразу после того, как освободит проект (loop → armDebounce(0)).
    if (this.building === projectId) {
      this.addPending(workdir, pending)
      return
    }
    // Никакой конкуренции за один проект: полная и инкрементальная сборки не
    // идут одновременно (иначе два писателя в граф).
    if (this.incrementalBusy.has(projectId)) {
      this.addPending(workdir, pending)
      this.armDebounce(workdir, CHANGE_DEBOUNCE_MS)
      return
    }
    this.incrementalBusy.add(projectId)
    try {
      // Правки активного проекта не ждут чат: уступаем только фоновые, и
      // ожидание ограничено (иначе одна правка стояла бы минуту).
      const isActive = projectId === this.activeProjectId
      if (!isActive) {
        const deadline = Date.now() + FOREGROUND_WAIT_MS
        while (this.foregroundBusy() && Date.now() < deadline && !this.stopRequested) {
          await sleep(100)
        }
      }
      const index = await this.getIndex(projectId, workdir)
      const changed = [...pending]
      const prevMap = new Map(changed.map(filePath => [filePath, store.getFile(projectId, filePath) ?? undefined]))
      const toResolve: RawFile[] = []
      const toResolveDocs: RawFile[] = []
      /** Файл перечитан, но содержимое то же: пишем только рёбра. */
      const edgeOnly: RawFile[] = []
      const excludedPaths: string[] = []
      const gonePaths: string[] = []
      const unchanged: { path: string; mtime: number; size: number }[] = []

      // ── Фаза 1: чтение/парсинг всех изменённых, узлы сразу в индекс ──
      // forceHash: watcher прислал путь, значит содержимое могло измениться,
      // даже если mtime/size совпали (git checkout, атомарное сохранение).
      for (const relPath of changed) {
        if (this.stopRequested) return
        const prev = prevMap.get(relPath)
        const outcome = await this.processFile(projectId, relPath, path.join(workdir, relPath), prev, { forceHash: true })
        switch (outcome.kind) {
          case 'ok': {
            const raw = outcome.raw
            if (prev && prev.hash === raw.meta.hash) {
              // Узлы не изменились: переписывать файл/документы незачем,
              // пересчитываем только рёбра (соседи могли поменяться).
              if (prev.mtime !== raw.meta.mtime || prev.size !== raw.meta.size) {
                store.updateFileStat(projectId, relPath, raw.meta.mtime, raw.meta.size)
              }
              if (isDocFile(relPath)) unchanged.push({ path: relPath, mtime: raw.meta.mtime, size: raw.meta.size })
              else edgeOnly.push(raw)
            } else {
              index.removeFile(relPath)
              index.addFileNodes(relPath, raw.nodes)
              if (isDocFile(relPath)) toResolveDocs.push(raw)
              else toResolve.push(raw)
            }
            break
          }
          case 'unchanged':
            unchanged.push({ path: relPath, mtime: outcome.mtime, size: outcome.size })
            break
          case 'excluded': excludedPaths.push(relPath); break
          case 'missing': gonePaths.push(relPath); break
          case 'transient':
            // Временный сбой (EACCES, таймаут парсера): граф файла не трогаем.
            this.watchedBuilds.delete(projectId)
            console.warn(`[projectMap] ${project.name}: пропуск правки ${relPath}: ${outcome.error}`)
            break
        }
        await yieldNow()
      }
      // mtime/size пишем только когда реально разошлись (иначе лишний UPDATE).
      for (const u of unchanged) {
        const prev = prevMap.get(u.path)
        if (!prev || prev.mtime !== u.mtime || prev.size !== u.size) {
          store.updateFileStat(projectId, u.path, u.mtime, u.size)
        }
      }

      // Импортёры собираем ДО мутации графа (removals/replaceFile ниже):
      // после удаления файла его входящие рёбра уже не находятся, а после
      // replaceFile переписаны свои.
      const touched = new Set<string>([
        ...toResolve.map(r => r.meta.path),
        ...toResolveDocs.map(r => r.meta.path),
        ...edgeOnly.map(r => r.meta.path),
        ...excludedPaths,
        ...gonePaths,
      ])
      const dependents = new Set<string>()
      for (const relPath of touched) {
        for (const dep of this.dependentPaths(projectId, relPath)) {
          if (!touched.has(dep)) dependents.add(dep)
        }
      }

      for (const relPath of excludedPaths) {
        store.removeFile(projectId, relPath)
        removeFileDocs(projectId, relPath)
        index.removeFile(relPath)
      }
      // ENOENT — файла действительно нет: убираем из графа (это не «список
      // неполон», а подтверждённое отсутствие).
      for (const relPath of gonePaths) {
        store.removeFile(projectId, relPath)
        removeFileDocs(projectId, relPath)
        index.removeFile(relPath)
      }

      // ── Фаза 2: резолвинг (индекс уже содержит все новые узлы) ──
      for (const raw of toResolve) {
        if (this.stopRequested) return
        this.resolveAndWrite(index, raw)
        await yieldNow()
      }
      for (const raw of toResolveDocs) {
        if (this.stopRequested) return
        this.resolveAndWriteDoc(index, raw)
        await yieldNow()
      }
      for (const raw of edgeOnly) {
        if (this.stopRequested) return
        this.writeEdgesOnly(index, raw)
        await yieldNow()
      }

      // ── Зависимые файлы: пересчитываем ТОЛЬКО рёбра ──
      // Узлы и документы семантики не менялись → не перечитываем и не
      // переэмбеддим: importDetails/callSites из кэша (или один разбор при
      // промахе), replaceFileEdges вместо полного replaceFile.
      const dependentBudget = { parses: Number.MAX_SAFE_INTEGER }
      for (const relPath of dependents) {
        if (this.stopRequested) return
        const prev = store.getFile(projectId, relPath)
        if (!prev) continue
        await this.refreshFileEdges(projectId, index, workdir, relPath, prev, dependentBudget)
        await yieldNow()
      }

      // ── Точечное восстановление ранее неразрешённых ссылок ──
      // Новый/изменённый файл мог закрыть чужой «висящий» импорт или вызов.
      // Такой импортёр не находится по входящим рёбрам (ребра нет — ссылка не
      // разрешилась), поэтому ищем кандидатов обратным lookup'ом по
      // durable-следу неразрешённых ссылок и пересчитываем ТОЛЬКО их рёбра.
      const arrived = [
        ...toResolve.map(r => r.meta.path),
        ...edgeOnly.map(r => r.meta.path),
      ]
      if (arrived.length > 0) {
        const skip = new Set<string>([...touched, ...dependents])
        const candidates = this.recoveryCandidates(projectId, index, arrived, skip)
        if (candidates.length > 0) {
          const budget = { parses: RECOVERY_MAX_PARSES }
          let refreshed = 0
          for (const relPath of candidates.slice(0, RECOVERY_MAX_IMPORTERS)) {
            if (this.stopRequested) break
            // Строка файла могла исчезнуть (удалён, prune ещё не прошёл) —
            // тогда следу верить нельзя: перерезолв писал бы рёбра в никуда.
            const prev = store.getFile(projectId, relPath)
            if (!prev) continue
            await this.refreshFileEdges(projectId, index, workdir, relPath, prev, budget)
            refreshed++
            await yieldNow()
          }
          log('[mapBuilder] %s: восстановление неразрешённых ссылок — %d импортёр(ов) перерезолвлено', project.name, refreshed)
        }
      }

      if (gonePaths.length > 0 || excludedPaths.length > 0) store.pruneDanglingEdges(projectId)
      store.refreshCounts(projectId)
      invalidateAnalytics(projectId)
      const status = store.getStatus(projectId)
      // Правки, пришедшие пока шёл этот проход, вернулись в pendingChanges —
      // сброс взводим здесь же, чтобы они не ждали нового события watcher'а.
      if (this.pendingChanges.has(workdir)) this.armDebounce(workdir, CHANGE_DEBOUNCE_MS)
      this.emit({ projectId, phase: 'ready', percent: 100, indexedFiles: status.indexedFiles, totalFiles: status.totalFiles, message: 'Карта обновлена', projectName: project.name, pendingProjects: this.queue.length, incremental: true, changedFiles: changed.length })
    } catch (e) {
      this.watchedBuilds.delete(projectId)
      console.warn('[projectMap] incremental failed:', errorText(e))
    } finally {
      this.incrementalBusy.delete(projectId)
    }
  }
}

export const projectMapManager = new ProjectMapManager()
