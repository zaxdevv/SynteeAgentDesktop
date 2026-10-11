// ── BrowserManager: встроенный браузер (webview в правой панели) ──────────
//
// Архитектура (см. план 02.10.2026):
//  • Renderer (BrowserPanel) хостит <webview>-элементы — они в DOM, поэтому
//    весь React-UI (меню/модалки/поповеры) рендерится ПОВЕРХ браузера
//    нативно, без overlay-костылей WebContentsView.
//  • Регистрация: renderer при did-attach/webview-событиях шлёт
//    browser:registerTab {tabId, webContentsId} — менеджер держит реестр.
//  • ВЕСЬ контроль (AI-тулы + UI-навигация) идёт из main через
//    webContents.fromId(webContentsId): executeJavaScript (снапшот),
//    sendInputEvent (trusted-клики — сайты считают их реальным вводом),
//    capturePage (скриншоты). Renderer в операциях не участвует.
//  • AI-раунд-трип: worker → postMessage 'browser_op' → execute() →
//    'browser_op_reply' (паттерн manage_dots).
//  • request_access: AI просит включить browser_mode → AgentConfirmDialog
//    (переиспользуем существующий confirm-пайплайн agent:confirm) →
//    setChatBrowserMode → event BROWSER_MODE_CHANGED → worker мутирует
//    тулсет рана (browser-тулы появляются со следующего раунда).
//
// A11y-снапшот: инжект в страницу через executeJavaScript — DOM-обходчик
// строит YAML-дерево с ref'ами (паттерн Playwright MCP). Элементы хранятся
// в window.__syntee_refs (Map) в контексте страницы — умирают при навигации,
// модель обязана ре-снапшотиться после перехода.

import { ipcMain, webContents, session, app, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { log } from '../../core/logger'
import { BROWSER_PARTITION, DEFAULT_BROWSER_PROFILE_ID, IPC_EVENTS } from '../../shared/constants'
import { getChatBrowserMode, setChatBrowserMode } from '../../core/db/chats'
import { domAction, inspect, condition, isChildFrame, locate, refInfo, snapshot, clampTimeout, resolveFrame } from '../browser/pageAutomation'
import { createHash } from 'node:crypto'
import { BrowserExtras as defaultBrowserExtras } from '../browser/BrowserExtras'

/** Таб браузера в реестре менеджера. */
export interface BrowserTabEntry {
  tabId: string
  webContentsId: number
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  favicon?: string
  /** Таб выгружен (idle-discard): webview-процесс убит ради памяти, запись
   *  в реестре живёт; восстановится при выборе таба (webview монтируется
   *  заново, registerTab перевешивает слушатели на новый guest). */
  discarded?: boolean
  partition?: string
}

/** Ответ browser_op для воркера (см. ai-worker.ts onBrowserAction). */
export interface BrowserOpResult {
  success: boolean
  output?: string
  error?: string
  /** request_access: подтверждено ли включение. */
  enabled?: boolean
  /** screenshot: base64 PNG (без data:-префикса) для vision-модели. */
  imageBase64?: string
}

/** Параметры browser_op из воркера. */
export type BrowserLocator = {
  type: 'css' | 'role' | 'text' | 'label' | 'placeholder' | 'testid'
  value: string
  name?: string
  exact?: boolean
}

export interface BrowserOpPayload {
  action: string
  url?: string
  ref?: string
  text?: string
  submit?: boolean
  key?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  tabId?: string
  reason?: string
  ms?: number
  snapshotId?: string
  selector?: string
  by?: BrowserLocator['type']
  locator?: BrowserLocator
  value?: string
  role?: string
  name?: string
  frameId?: number
  args?: Record<string, unknown>
  timeoutMs?: number
  source?: string
  full_page?: boolean
  clip?: { x: number; y: number; width: number; height: number }
  persistent?: boolean
  remove_id?: string
  target_ref?: string
  target_locator?: BrowserLocator
  [key: string]: unknown
}

export interface BrowserExtrasContext {
  signal: AbortSignal
  confirm: (title: string, details?: Record<string, unknown>) => Promise<boolean>
}
export interface BrowserExtras {
  execute(wc: Electron.WebContents, p: BrowserOpPayload, context: BrowserExtrasContext): Promise<BrowserOpResult | undefined>
  attach?(wc: Electron.WebContents): void
  detach?(wc: Electron.WebContents): void
}

let browserExtras: BrowserExtras | null = defaultBrowserExtras
export function setBrowserExtras(extras: BrowserExtras | null): void { browserExtras = extras }

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

class BrowserManagerImpl {
  /** Лимит табов: каждый webview = отдельный renderer-процесс (50-200 МБ).
   *  Агентский цикл tab_new не должен съесть всю RAM. */
  private static readonly MAX_TABS = 12
  /** Idle-discard: выгрузка фонового таба после N простоя. */
  private static readonly DISCARD_AFTER_MS = 10 * 60_000
  private static readonly DISCARD_CHECK_MS = 60_000
  /** Агентская активность: троттлинг снят на N мс после последнего
   *  browser-тула (серия navigate→snapshot должна рендериться на полной
   *  скорости даже в скрытом табе). */
  private static readonly AGENT_GRACE_MS = 20_000
  /** Ожидание регистрации webview (мост через гонку авто-открытия панели):
   *  первый browser-тул рана приходит в main раньше, чем панель успевает
   *  смонтировать webview (did-attach ≈ 100-500мс). 4с — с запасом на
   *  холодный старт; когда webview жив, ожидание не срабатывает вовсе. */
  private static readonly WC_WAIT_MS = 4_000

  /** AI-операции, которым нужен живой webContents активного таба.
   *  Остальные (tabs/tab_new/tab_select/tab_close/wait/request_access)
   *  работают с реестром и вебвью не требуют — их не ждём. */
  private static readonly WC_ACTIONS = new Set([
    'navigate', 'back', 'forward', 'reload', 'snapshot',
    'click', 'type', 'fill', 'press_key', 'scroll', 'screenshot',
    'evaluate', 'add_script', 'add_style', 'hover', 'focus', 'double_click', 'right_click', 'check', 'uncheck', 'select_option', 'drag', 'frames', 'wait_for',
    'console', 'errors', 'network', 'dialog', 'downloads', 'upload', 'cookies', 'storage', 'set_user_agent', 'zoom', 'trace_start', 'trace_stop', 'performance', 'permissions', 'clear_cache', 'accessibility',
  ])

  private tabs = new Map<string, BrowserTabEntry>()
  private win: BrowserWindow | null = null
  private profileId = DEFAULT_BROWSER_PROFILE_ID
  /** IDs remain retired until the old renderer unmounts after deletion. */
  private readonly retiredTabIds = new Set<string>()
  private profileStore: { get: (key: string, def?: unknown) => unknown; set: (key: string, value: unknown) => void } | null = null

  setProfileStore(store: { get: (key: string, def?: unknown) => unknown; set: (key: string, value: unknown) => void }): void {
    this.profileStore = store
  }

  getProfileId(): string { return this.profileId }
  getPartition(): string { return this.profileId === DEFAULT_BROWSER_PROFILE_ID ? BROWSER_PARTITION : `persist:syntee-browser-${this.profileId}` }

  listProfiles(): Array<{ id: string; name: string }> {
    const profiles = this.profileStore?.get('browser.profiles', [{ id: DEFAULT_BROWSER_PROFILE_ID, name: 'Личный' }]) as Array<{ id: string; name: string }>
    return Array.isArray(profiles) && profiles.length ? profiles : [{ id: DEFAULT_BROWSER_PROFILE_ID, name: 'Личный' }]
  }

  createProfile(name: string): { id: string; name: string } {
    const profile = { id: `profile-${randomUUID().slice(0, 8)}`, name: name.trim().slice(0, 40) || 'Новый профиль' }
    const profiles = this.listProfiles()
    this.profileStore?.set('browser.profiles', [...profiles, profile])
    return profile
  }

  async deleteProfile(id: string, userDataPath: string): Promise<{ activeId: string }> {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,100}$/.test(id)) throw new Error('Некорректный идентификатор профиля.')
    if (id === DEFAULT_BROWSER_PROFILE_ID) throw new Error('Профиль «Личный» нельзя удалить.')
    const profiles = this.listProfiles()
    if (!profiles.some(profile => profile.id === id)) throw new Error('Профиль не найден.')

    // Retire all current tabs before switching, so old renderer callbacks cannot
    // register guests into the replacement profile.
    if (this.profileId === id) {
      const oldTabs = [...this.tabs.values()]
      for (const tab of oldTabs) {
        this.retiredTabIds.add(tab.tabId)
        this.unregisterTab(tab.tabId)
        if (tab.webContentsId > 0) {
          try { webContents.fromId(tab.webContentsId)?.close() } catch { /* already gone */ }
        }
      }
      this.tabs.clear(); this.activeTabId = null
    }
    if (this.profileId === id) {
      const fallback = profiles.find(profile => profile.id === DEFAULT_BROWSER_PROFILE_ID) ?? { id: DEFAULT_BROWSER_PROFILE_ID, name: 'Личный' }
      this.profileId = fallback.id
      this.newTab()
    }

    this.profileStore?.set('browser.profiles', profiles.filter(profile => profile.id !== id))
    const partition = `persist:syntee-browser-${id}`
    try {
      const profileSession = session.fromPartition(partition)
      await profileSession.clearStorageData()
      await profileSession.clearCache()
    } catch (error) { log('[browser] profile storage cleanup failed: %s', (error as Error).message) }
    const importFile = join(userDataPath, 'browser-imports', `${id}.json`)
    try { await rm(importFile, { force: true }) } catch (error) { throw new Error(`Не удалось удалить импортированные данные: ${(error as Error).message}`) }
    this.pushTabState()
    return { activeId: this.profileId }
  }

  async switchProfile(id: string): Promise<boolean> {
    if (!this.listProfiles().some(p => p.id === id) || id === this.profileId) return false
    for (const tab of [...this.tabs.keys()]) this.unregisterTab(tab)
    this.tabs.clear(); this.activeTabId = null; this.profileId = id
    this.newTab()
    this.pushTabState()
    return true
  }
  /** Ленивый геттер окна: главное окно создаётся ПОСЛЕ регистрации IPC
   *  (main/index.ts: mainWindow.create() в конце whenReady). Eager
   *  setWindow(mainWindow.getWindow()) до create() передавал null НАВСЕГДА —
   *  pushTabState молча уходил в no-op, рендерер не получал состояние табов,
   *  webview не создавался (белый экран). Геттер решает на каждом вызове. */
  private winGetter: (() => BrowserWindow | null) | null = null
  /** Log-once: push пропущен из-за отсутствия окна (диагностика регрессий). */
  private pushSkipLogged = false
  /** LRU: последнее использование таба (select/navigate/агент/просмотр). */
  private lastUsed = new Map<string, number>()
  /** Видимый таб (панель открыта + таб «Браузер» + этот таб активен);
   *  null = браузер не виден. Управляет аудио-мьютом невидимых табов. */
  private visibleTabId: string | null = null
  /** До этого времени табы не троттлятся и не выгружаются (агент работает). */
  private agentActiveUntil = 0
  private agentThrottleTimer: ReturnType<typeof setTimeout> | null = null
  private discardTimer: ReturnType<typeof setInterval> | null = null
  /** Батчинг pushTabState: события страниц коалесцим раз в 100мс. */
  private pushTimer: ReturnType<typeof setTimeout> | null = null

  /** @deprecated окно создаётся позже — использовать setWindowGetter. */
  setWindow(win: BrowserWindow | null): void {
    this.win = win
  }

  /** Settings-store (electron-store из main) — гейт mouseNavEnabled
   *  для боковых кнопок мыши в webview. Прокидывается из browser.ipc. */
  private settingsStore: { get: (key: string, def?: unknown) => unknown } | null = null

  setSettingsStore(store: { get: (key: string, def?: unknown) => unknown }): void {
    this.settingsStore = store
  }

  /** Инжект X1/X2-навигации в контекст страницы (см. attachGuestListeners). */
  private injectSideButtonNav(wc: Electron.WebContents): void {
    const enabled = this.settingsStore
      ? this.settingsStore.get('mouseNavEnabled', true) !== false
      : true
    if (!enabled) return
    wc.executeJavaScript(SIDE_BUTTON_SCRIPT, false).catch(() => { /* страница могла уйти — ок */ })
  }

  setWindowGetter(getter: () => BrowserWindow | null): void {
    this.winGetter = getter
  }

  /** Актуальное окно: приоритет — ленивый геттер (живое значение), fallback —
   *  setWindow (для тестов/явной установки). */
  private getWin(): BrowserWindow | null {
    if (this.winGetter) {
      try {
        const w = this.winGetter()
        if (w) return w
      } catch { /* fallthrough → this.win */ }
    }
    return this.win
  }

  /** Сессия браузера: персистентная, отдельная от сессии приложения.
   *  Расширения грузятся в неё; webview с partition=BROWSER_PARTITION
   *  автоматически подхватывает. Chrome-подобный UA — для сайтов и для
   *  скачивания CRX из Chrome Web Store. */
  getSession(): Electron.Session {
    const ses = session.fromPartition(this.getPartition())
    if (!(ses as unknown as { __synteeUaSet?: boolean }).__synteeUaSet) {
      try { ses.setUserAgent(CHROME_UA) } catch { /* ok */ }
      ;(ses as unknown as { __synteeUaSet?: boolean }).__synteeUaSet = true
      this.attachSessionListeners(ses)
    }
    return ses
  }

  /** Скачивания: диалог сохранения (всегда — файлы из браузера не льём
   *  молча на диск) + тост-уведомление о результате. */
  private attachSessionListeners(ses: Electron.Session): void {
    ses.on('will-download', (_event, item) => {
      try {
        const downloadsDir = app.getPath('downloads')
        const defaultPath = join(downloadsDir, item.getFilename())
        // savePath = путь диалога; юзер может отменить → item.cancel().
        const showSave = this.getWin() && !this.getWin()?.isDestroyed()
          ? dialog.showSaveDialog(this.getWin()!, { title: 'Сохранить файл', defaultPath })
          : dialog.showSaveDialog({ title: 'Сохранить файл', defaultPath })
        void showSave.then(result => {
          if (result.canceled || !result.filePath) {
            item.cancel()
            return
          }
          item.setSavePath(result.filePath)
          item.once('done', (_e, state) => {
            const ok = state === 'completed'
            this.win?.webContents.send('plugins:toast', {
              text: ok ? `Файл сохранён: ${result.filePath}` : `Скачивание ${state === 'cancelled' ? 'отменено' : 'прервано'}`,
              kind: ok ? 'success' : 'error',
            })
          })
        })
      } catch (e) {
        log('[browser] will-download failed: %s', (e as Error).message)
        item.cancel()
      }
    })
  }

  // ── Реестр табов ────────────────────────────────────────────────────────

  private readonly guestCleanups = new Map<string, () => void>()

  private abortTabOperations(tabId: string, except?: AbortSignal): void {
    for (const controller of this.activeOperations.get(tabId) ?? []) {
      if (controller.signal !== except) controller.abort()
    }
  }

  registerTab(tabId: string, webContentsId: number): void {
    // A late did-attach from a webview belonging to a deleted profile must
    // never resurrect that tab in the new profile.
    if (this.retiredTabIds.has(tabId)) return
    const prev = this.tabs.get(tabId)
    this.lastUsed.set(tabId, Date.now())
    if (prev && prev.webContentsId === webContentsId) {
      this.updateTab(tabId, { loading: false })
      return
    }
    if (prev && prev.webContentsId > 0) {
      // Initial -1 registration is expected; replacing a real guest invalidates
      // both running and queued operations before they can resolve a new guest.
      this.abortTabOperations(tabId)
      this.guestCleanups.get(tabId)?.()
    }
    // webContentsId мог смениться (webview пересоздан) — перевешиваем.
    this.tabs.set(tabId, {
      tabId,
      webContentsId,
      url: prev?.url ?? 'about:blank',
      title: prev?.title ?? 'Новая вкладка',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      partition: this.getPartition(),
    })
    this.attachGuestListeners(tabId, webContentsId)
    log('[browser] registerTab tabId=%s wcId=%d (total %d)', tabId, webContentsId, this.tabs.size)
    this.pushTabState()
    this.startDiscardTimer()
  }

  unregisterTab(tabId: string, closingSignal?: AbortSignal): void {
    this.abortTabOperations(tabId, closingSignal)
    this.guestCleanups.get(tabId)?.()
    const guestId = this.tabs.get(tabId)?.webContentsId
    if (guestId !== undefined) this.persistentScripts.delete(guestId)
    this.lastUsed.delete(tabId)
    if (this.tabs.delete(tabId)) {
      // Закрыли активный — активируем первый оставшийся (иначе все webview
      // получают display:none → белый экран).
      if (this.activeTabId === tabId) {
        const fallback = this.getTabs()[0] ?? null
        this.activeTabId = fallback?.tabId ?? null
        // Фолбэк может быть выгружен — восстанавливаем: активный таб должен
        // быть живым (иначе wc()=null и тулы слепнут).
        if (fallback?.discarded) {
          fallback.discarded = false
          this.lastUsed.set(fallback.tabId, Date.now())
        }
      }
      if (this.visibleTabId === tabId) this.visibleTabId = null
      log('[browser] unregisterTab tabId=%s (total %d)', tabId, this.tabs.size)
      this.pushTabState()
    }
  }

  updateTab(tabId: string, patch: Partial<BrowserTabEntry>): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    Object.assign(t, patch)
    this.schedulePush()
  }

  /** Батчинг пушей: события страниц идут пачками (did-navigate + title +
   *  favicon + loading за секунду) — каждый пуш = IPC + ре-рендер панели.
   *  Коалесцим в один пуш раз в 100мс (троттлинг с трейлингом). */
  private schedulePush(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.pushTabState()
    }, 100)
    if (typeof this.pushTimer.unref === 'function') this.pushTimer.unref()
  }

  getTabs(): BrowserTabEntry[] {
    return Array.from(this.tabs.values())
  }

  /** Активный таб — первый в реестре (renderer шлёт registerTab для
   *  активного последним; активность трекается через tab_select). */
  private activeTab(): BrowserTabEntry | null {
    if (this.activeTabId) return this.tabs.get(this.activeTabId) ?? null
    const first = this.getTabs()[0]
    return first ?? null
  }

  private activeTabId: string | null = null

  setActiveTab(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (entry?.discarded) {
      // Восстановление выгруженного таба: renderer смонтирует webview
      // заново, registerTab перевешает слушатели на новый guest-процесс.
      entry.discarded = false
    }
    this.lastUsed.set(tabId, Date.now())
    this.activeTabId = tabId
    this.pushTabState()
  }

  private wc(tabId?: string): Electron.WebContents | null {
    const id = tabId ?? this.activeTabId ?? undefined
    const entry = id ? this.tabs.get(id) : this.activeTab()
    if (!entry) return null
    try {
      const wc = webContents.fromId(entry.webContentsId)
      if (!wc || wc.isDestroyed()) return null
      return wc
    } catch {
      return null
    }
  }

  /** wc() с ожиданием регистрации webview. Два сценария, где wc()=null, но
   *  webview ВОТ-ВОТ появится:
   *  1) Гонка авто-открытия: useBrowserAutoOpen открывает панель по
   *     tool_call-событию — тому же, что исполняет этот тул, — но монтирование
   *     BrowserPanel + did-attach + registerTab занимают ~100-500мс, а тул
   *     доходит до main за миллисекунды. Раньше первый browser_navigate рана
   *  ВСЕГДА падал «No browser tab available», хотя панель уже открывалась.
   *  2) Восстановление выгруженного таба: tab_select снимает discarded,
   *     renderer перемонтирует WebviewHost → registerTab перевешивает entry
   *     на новый webContentsId (старый уничтожен).
   *  Поллинг 100мс; registerTab обновляет entry, wc() находит новый id. */
  private async wcAwait(timeoutMs: number, tabId?: string, signal?: AbortSignal): Promise<Electron.WebContents | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      guard(signal)
      const wc = this.wc(tabId)
      if (wc) return wc
      if (Date.now() >= deadline) return null
      await sleep(100, signal)
    }
  }

  /** Push состояния табов в renderer (BrowserPanel). */
  private pushTabState(): void {
    const win = this.getWin()
    if (!win || win.isDestroyed()) {
      if (!this.pushSkipLogged) {
        this.pushSkipLogged = true
        log('[browser] pushTabState SKIPPED: no live window (getter=%s, eager=%s) — renderer не получит состояние табов',
          this.winGetter ? 'set' : 'none', this.win ? 'set' : 'null')
      }
      return
    }
    win.webContents.send(IPC_EVENTS.BROWSER_TAB_STATE, {
      tabs: this.getTabs(),
      activeTabId: this.activeTabId,
    })
  }

  /** Слушатели событий guest webContents → обновление реестра. */
  private attachGuestListeners(tabId: string, webContentsId: number): void {
    try {
      const wc = webContents.fromId(webContentsId)
      if (!wc || wc.isDestroyed()) return

      // Троттлинг НЕ выключаем (раньше был setBackgroundThrottling(false)
      // навсегда — скрытые табы жгли CPU на полную). Скрытые табы теперь
      // дешёвые: таймеры/rAF замирают. Агентские операции снимают троттлинг
      // временно (markAgentActivity), видимые табы Chromium не троттлит.

      // Звук — только у видимого таба (панель открыта + таб активен).
      try { wc.setAudioMuted(this.visibleTabId !== tabId) } catch { /* ok */ }

      // window.open / target=_blank → новый таб панели, не попап.
      // Активируем его: юзер кликнул ссылку «в новой вкладке» и ожидает
      // увидеть результат сразу (как в браузере); агентские window.open
      // (JS попапы) тоже попадают в поле зрения юзера.
      wc.setWindowOpenHandler(({ url }) => {
        if (this.tabs.get(tabId)?.webContentsId !== webContentsId) return { action: 'deny' }
        const newTabId = this.newTab(url)
        this.setActiveTab(newTabId)
        return { action: 'deny' }
      })

      // Боковые кнопки мыши (X1/X2) = назад/вперёд по истории СТРАНИЦЫ.
      // События над webview уходят в guest-процесс — host-рендерер их не
      // видит (App.tsx X1/X2-навигация по разделам не срабатывает), а
      // Windows app-command гасится в MainWindow. Инжектим слушатель в
      // контекст страницы на dom-ready: history.back() — как в браузере.
      const current = () => this.tabs.get(tabId)?.webContentsId === webContentsId
      const update = (patch: Partial<BrowserTabEntry>) => { if (current()) this.updateTab(tabId, patch) }
      const events: NodeJS.EventEmitter = wc
      const listeners: Array<[string, (...args: any[]) => void]> = []
      const on = (event: string, listener: (...args: any[]) => void) => {
        listeners.push([event, listener]); events.on(event, listener)
      }
      const extras = browserExtras
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        for (const [event, listener] of listeners) events.removeListener(event, listener)
        if (this.guestCleanups.get(tabId) === dispose) this.guestCleanups.delete(tabId)
        this.persistentScripts.delete(webContentsId)
        try { extras?.detach?.(wc) } catch { /* destroyed guest */ }
        if (!wc.isDestroyed()) wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      }
      this.guestCleanups.set(tabId, dispose)
      on('destroyed', () => {
        // Replacement/unregister already abort before disposing this listener.
        // A live registered guest dying also invalidates all its queued work.
        this.abortTabOperations(tabId)
        dispose()
      })
      on('dom-ready', () => { if (current()) this.injectSideButtonNav(wc) })
      on('did-start-loading', () => update({ loading: true }))
      on('did-stop-loading', () => update({
        loading: false,
        canGoBack: safe(() => wc.navigationHistory.canGoBack()) ?? false,
        canGoForward: safe(() => wc.navigationHistory.canGoForward()) ?? false,
        url: safe(() => wc.getURL()) ?? 'about:blank',
      }))
      on('did-navigate', (_e, url) => update({ url }))
      on('did-navigate-in-page', (_e, url) => update({ url }))
      on('page-title-updated', (_e, title) => update({ title }))
      on('page-favicon-updated', (_e, icons) => {
        const favicon = icons?.[icons.length - 1]
        if (favicon) update({ favicon })
      })
    } catch (e) {
      log('[browser] attachGuestListeners failed: %s', (e as Error).message)
    }
  }

  // ── UI-операции (из renderer через browser.ipc) ─────────────────────────

  navigate(tabId: string, url: string): void {
    this.lastUsed.set(tabId, Date.now())
    const target = normalizeUrl(url)
    const wc = this.wc(tabId)
    if (wc) {
      // Таб attached — навигация напрямую из main. НЕ пушим url в updateTab:
      // push → renderer обновит src-атрибут webview → двойная навигация
      // (loadURL + src-mutation) → GUEST_VIEW_MANAGER_CALL error у проигравшей.
      // url придёт из did-navigate-листенера (attachGuestListeners).
      this.updateTab(tabId, { loading: true })
      wc.loadURL(target).catch(err => {
        log('[browser] navigate failed: %s', (err as Error).message)
        this.updateTab(tabId, { loading: false })
      })
    } else {
      // Таб ещё не attached (webContentsId=-1, guest не создан): обновляем
      // url в реестре + push → renderer обновит src-атрибут webview —
      // Electron наблюдает изменение src и навигирует (MutationObserver
      // в webview-impl). Иначе navigate был бы тихим no-op.
      this.updateTab(tabId, { url: target, loading: true, title: 'Загрузка…' })
    }
  }

  goBack(tabId: string): void { this.wc(tabId)?.goBack() }
  goForward(tabId: string): void { this.wc(tabId)?.goForward() }
  reload(tabId: string): void { this.wc(tabId)?.reload() }

  newTab(url?: string): string {
    // Лимит табов: каждый webview = отдельный renderer-процесс (50-200 МБ).
    // Выгружаем самый давно неиспользуемый НЕ-активный таб (LRU).
    if (this.tabs.size >= BrowserManagerImpl.MAX_TABS) {
      let oldest: string | null = null
      let oldestTs = Infinity
      for (const t of this.tabs.values()) {
        if (t.tabId === this.activeTabId) continue
        const ts = this.lastUsed.get(t.tabId) ?? 0
        if (ts < oldestTs) { oldestTs = ts; oldest = t.tabId }
      }
      if (oldest) {
        log('[browser] MAX_TABS: evict oldest non-active tab=%s', oldest)
        this.unregisterTab(oldest)
      }
    }
    const tabId = `bt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    // Таб создаётся в renderer (webview-элемент); здесь — только запись в
    // реестре-заготовке. Renderer при did-attach вызовет registerTab с этим
    // tabId. URL применяется через атрибут src webview — поэтому стартовый
    // таб БЕЗ url получает дефолтную страницу (webview без src не создаёт
    // guest-процесс вообще — dom-ready не стреляет, белый экран).
    this.tabs.set(tabId, {
      tabId,
      webContentsId: -1, // до did-attach
      url: url ? normalizeUrl(url) : 'https://www.google.com',
      title: url ? 'Загрузка…' : 'Новая вкладка',
      loading: true,
      canGoBack: false,
      canGoForward: false,
      partition: this.getPartition(),
    })
    this.lastUsed.set(tabId, Date.now())
    if (!this.activeTabId) this.activeTabId = tabId
    this.pushTabState()
    this.startDiscardTimer()
    return tabId
  }

  /** Активный таб (null если табов нет). */
  getActiveTabId(): string | null {
    return this.activeTabId
  }

  // ── Оптимизация фоновой нагрузки ────────────────────────────────────────

  /** Видимый таб (renderer: панель открыта + таб «Браузер» + этот таб
   *  активен). null = браузер не виден → звук мьютится у всех табов. */
  setVisibleTab(tabId: string | null): void {
    if (this.visibleTabId === tabId) return
    this.visibleTabId = tabId
    if (tabId) this.lastUsed.set(tabId, Date.now())
    for (const t of this.tabs.values()) {
      if (t.webContentsId < 0) continue
      try {
        const wc = webContents.fromId(t.webContentsId)
        if (wc && !wc.isDestroyed()) wc.setAudioMuted(t.tabId !== tabId)
      } catch { /* ок */ }
    }
  }

  /** Агентская browser-операция: снимаем троттлинг со всех табов на
   *  AGENT_GRACE_MS (каждая новая операция продлевает окно). По истечении
   *  троттлинг возвращается — скрытые табы снова дешёвые. Видимые табы
   *  Chromium не троттлит в любом случае (снятие/возврат — no-op). */
  markAgentActivity(): void {
    this.agentActiveUntil = Date.now() + BrowserManagerImpl.AGENT_GRACE_MS
    for (const t of this.tabs.values()) {
      this.lastUsed.set(t.tabId, Date.now())
      if (t.webContentsId < 0) continue
      try {
        const wc = webContents.fromId(t.webContentsId)
        if (wc && !wc.isDestroyed()) wc.setBackgroundThrottling(false)
      } catch { /* ок */ }
    }
    if (this.agentThrottleTimer) clearTimeout(this.agentThrottleTimer)
    this.agentThrottleTimer = setTimeout(() => {
      this.agentThrottleTimer = null
      this.agentActiveUntil = 0
      for (const t of this.tabs.values()) {
        if (t.webContentsId < 0) continue
        try {
          const wc = webContents.fromId(t.webContentsId)
          if (wc && !wc.isDestroyed()) wc.setBackgroundThrottling(true)
        } catch { /* ок */ }
      }
    }, BrowserManagerImpl.AGENT_GRACE_MS)
    if (typeof this.agentThrottleTimer.unref === 'function') this.agentThrottleTimer.unref()
  }

  /** Idle-discard: выгружаем фоновые табы после DISCARD_AFTER_MS простоя —
   *  webview-процесс умирает (renderer прячет элемент), запись в реестре
   *  живёт. Не трогаем: активный, видимый, недавно использованные и пока
   *  агент работает с браузером. */
  private discardIdleTabs(): void {
    const now = Date.now()
    if (now < this.agentActiveUntil) return
    let changed = false
    for (const t of this.tabs.values()) {
      if (t.discarded) continue
      if (t.tabId === this.activeTabId || t.tabId === this.visibleTabId) continue
      const used = this.lastUsed.get(t.tabId) ?? now
      if (now - used < BrowserManagerImpl.DISCARD_AFTER_MS) continue
      t.discarded = true
      changed = true
      log('[browser] idle-discard tab=%s (idle %d min)', t.tabId, Math.round((now - used) / 60000))
    }
    if (changed) this.pushTabState()
  }

  private startDiscardTimer(): void {
    if (this.discardTimer) return
    this.discardTimer = setInterval(() => this.discardIdleTabs(), BrowserManagerImpl.DISCARD_CHECK_MS)
    if (typeof this.discardTimer.unref === 'function') this.discardTimer.unref()
  }

  // ── AI-операции (browser_op из воркера) ─────────────────────────────────

  /** Главная точка входа AI-операций. Гейтинг по browserMode чата. */
  private readonly operationQueues = new Map<string, Promise<void>>()

  private readonly activeOperations = new Map<string, Set<AbortController>>()
  private readonly persistentScripts = new Map<number, Set<string>>()

  async execute(chatId: string, p: BrowserOpPayload, signal?: AbortSignal): Promise<BrowserOpResult> {
    const tabId = p.tabId ?? this.activeTabId ?? ''
    const timeoutMs = clampTimeout(p.timeoutMs, ['request_access', 'evaluate', 'add_script', 'add_style', 'click', 'type', 'fill', 'press_key', 'upload', 'cookies', 'storage', 'dialog', 'permissions'].includes(p.action) ? 120_000 : 30_000)
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(abort, timeoutMs)
    const set = this.activeOperations.get(tabId) ?? new Set<AbortController>()
    set.add(controller); this.activeOperations.set(tabId, set)
    // Closing a tab cannot wait behind an operation blocked on a page dialog.
    if (p.action === 'tab_close') {
      for (const c of set) if (c !== controller) c.abort()
    }
    const previous = p.action === 'tab_close' ? Promise.resolve() : this.operationQueues.get(tabId) ?? Promise.resolve()
    const task = previous.then(async () => {
      guard(controller.signal)
      return this.executeQueued(chatId, { ...p, tabId }, controller.signal, tabId)
    }).catch((error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error) }))
    // Quarantine the underlying task until it drains; a timeout does NOT unlock
    // the tab while an uncancellable Electron/CDP request is still in flight.
    const tail = task.then(() => undefined)
    if (p.action !== 'tab_close') this.operationQueues.set(tabId, tail)
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      set.delete(controller)
      if (!set.size && this.activeOperations.get(tabId) === set) this.activeOperations.delete(tabId)
      if (this.operationQueues.get(tabId) === tail) this.operationQueues.delete(tabId)
    }
    void task.finally(cleanup)
    try {
      return await abortable(task, controller.signal)
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  private async executeQueued(chatId: string, p: BrowserOpPayload, signal: AbortSignal, tabId: string): Promise<BrowserOpResult> {
    if (signal.aborted) return { success: false, error: 'Browser operation aborted.' }
    // Агентская активность: снять троттлинг + отложить idle-discard.
    this.markAgentActivity()
    // request_access доступен всегда — это и есть путь включения.
    if (p.action === 'request_access') return this.handleRequestAccess(chatId, p.reason, signal)

    const enabled = chatId ? getChatBrowserMode(chatId) : false
    if (!enabled) {
      return {
        success: false,
        error:
          'Browser control is disabled for this chat. Call request_access (capability: browser_control) with a reason to ask the user to enable it.',
      }
    }

    // ── Мост через гонку авто-открытия панели ──────────────────────────────
    // Для wc-зависимых операций: если активного webview нет — ждём его
    // регистрации (см. wcAwait). markAgentActivity выше уже отложил
    // idle-discard на время ожидания. Когда webview жив — проверка
    // мгновенная, оверхеда нет; реально ждём только в холодных сценариях
    // (панель ни разу не монтировалась в этой сессии / восстановление
    // выгруженного таба). Закрытие правой панели webview НЕ убивает
    // (keep-alive в RightPanel) — юзер, закрывший панель посреди рана,
    // 4-секундных пауз не получит.
    let operationWc: Electron.WebContents | null = null
    if (BrowserManagerImpl.WC_ACTIONS.has(p.action)) {
      operationWc = this.wc(tabId)
      if (!operationWc) operationWc = await this.wcAwait(BrowserManagerImpl.WC_WAIT_MS, tabId, signal)
      if (!operationWc) {
        return {
          success: false,
          error:
            'No browser tab available (waited for the Browser panel to mount). Ask the user to open the Browser panel (right side), or create a tab with browser_tab_new and retry.',
        }
      }
    }

    try {
      if (signal.aborted) return { success: false, error: 'Browser operation aborted.' }
      if (operationWc && browserExtras) browserExtras.attach?.(operationWc)
      const context: BrowserExtrasContext = {
        signal,
        confirm: (title, details) => this.confirmBrowserAction(chatId, `browser_${p.action}`, details ?? {}, title, signal),
      }
      if (operationWc && browserExtras) {
        const extra = await browserExtras.execute(operationWc, p, context)
        if (extra) return extra
      }
      switch (p.action) {
        case 'navigate':
          await this.approveUrl(chatId, p.url, signal)
          return await this.opNavigate(p.url, tabId, signal)
        case 'back':           return await this.opHistory('back', operationWc, signal)
        case 'forward':        return await this.opHistory('forward', operationWc, signal)
        case 'reload':         return this.opReload(operationWc, signal)
        case 'snapshot':       return await this.opSnapshot(operationWc, p, signal)
        case 'click':          return await this.opClick(chatId, p, operationWc, signal)
        case 'type':
        case 'fill':           return await this.opType(chatId, p, operationWc, signal)
        case 'press_key':      return await this.opPressKey(chatId, p.key, operationWc, signal)
        case 'scroll':         return await this.opScroll(p, operationWc, signal)
        case 'screenshot':     return await this.opScreenshot(operationWc, p, signal)
        case 'tabs':           return this.opTabsList()
        case 'tab_new':
          await this.approveUrl(chatId, p.url, signal)
          return await this.opTabNew(p.url, signal)
        case 'tab_select':     return await this.opTabSelect(p.tabId, signal)
        case 'tab_close':      return this.opTabClose(p.tabId, signal)
        case 'wait':           return await this.opWait(p.ms, signal)
        case 'evaluate':
        case 'add_script':
        case 'add_style':
        case 'select_option':
        case 'hover':
        case 'focus':
        case 'double_click':
        case 'right_click':
        case 'check':
        case 'uncheck':
        case 'drag':
        case 'screenshot_clip':
        case 'wait_for':
        case 'frames':
        case 'performance':
        case 'cookies':
        case 'storage':
        case 'set_user_agent':
        case 'zoom':
        case 'trace_start':
        case 'trace_stop':
          return await this.opExtended(chatId, { ...p, tabId }, signal)
        default:
          return { success: false, error: `Unknown browser action: ${p.action}` }
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async opExtended(chatId: string, p: BrowserOpPayload, signal: AbortSignal): Promise<BrowserOpResult> {
    const wc = this.wc(p.tabId)
    if (!wc) throw new Error('No browser tab available.')
    const frame = resolveFrame(wc, p.frameId)
    const a = { ...p, ...p.args }
    const codeApproval = async (source: string) => {
      const url = wc.getURL()
      const preview = source.replace(/(Bearer\s+)[\w.-]+/gi, '$1[masked]').replace(/((?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[masked]$2').slice(0, 2000)
      const approved = await this.confirmBrowserAction(chatId, `browser_${p.action}`, {
        tabId: p.tabId, frameId: p.frameId, origin: safeOrigin(url),
        sourcePreview: preview, sourceSHA256: createHash('sha256').update(source).digest('hex'),
        persistent: a.persistent === true,
      }, 'Разрешить выполнение этого кода в странице?', signal)
      guard(signal)
      if (!approved) throw new Error('User declined page code.')
      if (wc.getURL() !== url || resolveFrame(wc, p.frameId) !== frame) throw new Error('Page changed during approval.')
      log('[browser] approved %s tab=%s bytes=%d', p.action, p.tabId, source.length)
    }
    if (['evaluate', 'add_script', 'add_style'].includes(p.action)) {
      if (p.action === 'add_script' && a.remove_id) {
        const id = String(a.remove_id)
        if (!this.persistentScripts.get(wc.id)?.has(id)) throw new Error('Unknown persistent script identifier.')
        await codeApproval(`Remove persistent script ${id}`)
        await wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: id })
        this.persistentScripts.get(wc.id)?.delete(id)
        return { success: true, output: 'Persistent script removed.' }
      }
      const source = p.source ?? String(a.source ?? '')
      if (!source || source.length > 100000) throw new Error('Source required (maximum 100000 characters).')
      await codeApproval(source)
      if (p.action === 'add_style') {
        if (isChildFrame(wc, p.frameId)) throw new Error('CSS injection is main-frame only; use frame evaluation after approval.')
        await wc.insertCSS(source)
        guard(signal)
        return { success: true, output: 'CSS inserted in current document (not persistent).' }
      }
      let identifier: string | undefined
      if (p.action === 'add_script' && a.persistent === true) {
        if (isChildFrame(wc, p.frameId)) throw new Error('Persistent scripts are main-frame only.')
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
        const result = await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source })
        identifier = result.identifier
        if (identifier) {
          const ids = this.persistentScripts.get(wc.id) ?? new Set<string>()
          ids.add(identifier); this.persistentScripts.set(wc.id, ids)
        }
      }
      guard(signal)
      const result = await frame.executeJavaScript(source, false)
      guard(signal)
      const output = (JSON.stringify(result) ?? String(result)).slice(0, 50000)
      return { success: true, output: identifier ? `Persistent script identifier: ${identifier}\n${output}` : output }
    }
    if (p.action === 'frames') return { success: true, output: JSON.stringify(wc.mainFrame.framesInSubtree.map(f => ({ frameId: f.routingId, name: f.name, url: f.url }))) }
    if (p.action === 'wait_for') {
      const kind = String(a.condition ?? 'selector'), value = String(a.value ?? '')
      if (!['selector', 'text', 'url', 'load', 'function'].includes(kind)) throw new Error('Unsupported wait condition.')
      if (kind === 'load' && !['load', 'domcontentloaded'].includes(value)) throw new Error('Load state must be load or domcontentloaded (networkidle is not supported).')
      if (kind === 'function') await codeApproval(value)
      while (true) {
        guard(signal)
        let done = false
        if (kind === 'url') done = frame.url.includes(value)
        else if (kind === 'function') done = !!await frame.executeJavaScript(value, false)
        else done = await condition(wc, p, signal)
        guard(signal)
        if (done) return { success: true, output: `${kind} condition satisfied.` }
        await sleep(100, signal)
      }
    }
    if (p.action === 'focus' || p.action === 'select_option') {
      await this.actionable(wc, p, signal)
      const result = await domAction(wc, p, p.action, signal)
      if (result !== 'ok') throw new Error(`${p.action} failed: ${result}`)
      return { success: true, output: `${p.action} completed and verified.` }
    }
    if (['hover', 'double_click', 'right_click', 'check', 'uncheck', 'drag'].includes(p.action)) {
      if (isChildFrame(wc, p.frameId)) throw new Error('Trusted pointer actions in child frames are unsupported.')
      const point = await this.actionable(wc, p, signal)
      if (p.action === 'hover') {
        wc.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x + point.width / 2), y: Math.round(point.y + point.height / 2) })
      } else if (p.action === 'check' || p.action === 'uncheck') {
        const state = await inspect(wc, p, signal)
        if (!['checkbox', 'radio'].includes(state.type) || p.action === 'uncheck' && state.type === 'radio') throw new Error('Expected native checkbox/radio (radio cannot be unchecked).')
        const wanted = p.action === 'check'
        if (state.checked !== wanted) trustedClick(wc, point, signal)
        await sleep(50, signal)
        if ((await inspect(wc, p, signal)).checked !== wanted) throw new Error('Checkbox state did not change.')
      } else if (p.action === 'drag') {
        const destination: BrowserOpPayload = { ...p, ref: a.target_ref as string | undefined, locator: a.target_locator as BrowserLocator | undefined, args: {} }
        const end = await this.actionable(wc, destination, signal)
        const x = Math.round(point.x + point.width / 2), y = Math.round(point.y + point.height / 2)
        wc.sendInputEvent({ type: 'mouseMove', x, y })
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        try {
          for (let i = 1; i <= 10; i++) { guard(signal); wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x + (end.x + end.width / 2 - x) * i / 10), y: Math.round(y + (end.y + end.height / 2 - y) * i / 10) }); await sleep(20, signal) }
        } finally { if (!wc.isDestroyed()) wc.sendInputEvent({ type: 'mouseUp', x: Math.round(end.x + end.width / 2), y: Math.round(end.y + end.height / 2), button: 'left', clickCount: 1 }) }
      } else trustedClick(wc, point, signal, p.action === 'right_click' ? 'right' : 'left', p.action === 'double_click' ? 2 : 1)
      return { success: true, output: `${p.action} input dispatched; verify page result with a snapshot.` }
    }
    throw new Error(`Unsupported browser action: ${p.action}`)
  }

  private async actionable(wc: Electron.WebContents, p: BrowserOpPayload, signal: AbortSignal): Promise<{ x: number; y: number; width: number; height: number }> {
    while (true) {
      guard(signal)
      const point = await locate(wc, p, signal)
      if (point) return point
      await sleep(100, signal)
    }
  }

  private async approveUrl(chatId: string, url: string | undefined, signal: AbortSignal): Promise<void> {
    if (!url) return
    const target = normalizeUrl(url)
    if (/^https?:/i.test(target) || target === 'about:blank') return
    if (!await this.confirmBrowserAction(chatId, 'browser_navigate', { protocol: target.split(':')[0] }, 'Разрешить навигацию по нестандартному протоколу?', signal)) throw new Error('User declined non-web navigation.')
    guard(signal)
  }


  // ── request_access: confirm через AgentConfirmDialog ────────────────────

  private async handleRequestAccess(chatId: string, reason?: string, signal?: AbortSignal): Promise<BrowserOpResult> {
    if (!chatId) return { success: false, error: 'request_access: no chat context' }
    if (getChatBrowserMode(chatId)) {
      return { success: true, enabled: true, output: 'Browser control is already enabled for this chat.' }
    }

    const approved = await this.confirmBrowserAction(
      chatId,
      'request_access',
      { capability: 'browser_control', reason: reason ?? '' },
      'AI просит включить управление браузером для этой задачи. Включить?',
      signal,
    )

    if (approved) {
      try { setChatBrowserMode(chatId, true) } catch { /* ok */ }
      // Синк UI: чип в StatusRow + тумблер в плюс-меню.
      const win = this.getWin()
      win?.webContents.send(IPC_EVENTS.BROWSER_MODE_CHANGED, { chatId, enabled: true })
      return {
        success: true,
        enabled: true,
        output: 'Browser control ENABLED. The browser_* tools are now available — use them immediately to continue the task.',
      }
    }
    return {
      success: true,
      enabled: false,
      output: 'The user declined browser control. Continue without browser tools.',
    }
  }

  // ── Реализации AI-операций ──────────────────────────────────────────────

  private async opNavigate(url?: string, tabId?: string, signal?: AbortSignal): Promise<BrowserOpResult> {
    if (!url) return { success: false, error: 'navigate: url is required' }
    const wc = this.wc(tabId)
    if (!wc) return { success: false, error: 'No browser tab available. Open the Browser panel (right panel) first.' }
    if (signal?.aborted) return { success: false, error: 'Browser operation aborted.' }
    const target = normalizeUrl(url)
    const stop = () => { if (!wc.isDestroyed()) wc.stop() }
    signal?.addEventListener('abort', stop, { once: true })
    try {
      guard(signal)
      await wc.loadURL(target)
      while (wc.isLoading()) { guard(signal); await sleep(25, signal) }
      if (signal?.aborted) return { success: false, error: 'Browser operation aborted.' }
      // Ждём dom-ready-ish: loadURL резолвится на did-finish-load.
      const title = safe(() => wc.getURL()) === target ? safe(() => wc.getTitle()) : target
      return { success: true, output: `Navigated to ${target}${title ? ` — ${title}` : ''}. Page refs from previous snapshots are gone — take a new snapshot before interacting.` }
    } catch (e) {
      return { success: false, error: signal?.aborted ? 'Browser operation aborted.' : `Navigation failed: ${e instanceof Error ? e.message : String(e)}` }
    } finally {
      signal?.removeEventListener('abort', stop)
    }
  }

  private async opHistory(dir: 'back' | 'forward', wcArg?: Electron.WebContents | null, signal?: AbortSignal): Promise<BrowserOpResult> {
    const wc = wcArg ?? this.wc()
    guard(signal)
    if (!wc) throw new Error('No browser tab available.')
    const history = wc.navigationHistory
    if (dir === 'back' ? !history.canGoBack() : !history.canGoForward()) throw new Error('No history available.')
    await navigation(wc, () => dir === 'back' ? history.goBack() : history.goForward(), signal)
    return { success: true, output: 'History navigation completed. Take a new snapshot.' }
  }
  private async opReload(wcArg?: Electron.WebContents | null, signal?: AbortSignal): Promise<BrowserOpResult> {
    const wc = wcArg ?? this.wc()
    if (!wc) throw new Error('No browser tab available.')
    await navigation(wc, () => wc.reload(), signal)
    return { success: true, output: 'Page reloaded. Take a new snapshot.' }
  }

  private async opSnapshot(wcArg?: Electron.WebContents | null, p: BrowserOpPayload = { action: 'snapshot' }, signal?: AbortSignal): Promise<BrowserOpResult> {
    const wc = wcArg ?? this.wc()
    if (!wc) return { success: false, error: 'No browser tab available. Open the Browser panel first.' }
    const tree = await snapshot(wc, p, signal)
    if (typeof tree !== 'string' || !tree) {
      return { success: false, error: 'Snapshot failed: the page did not return an accessibility tree.' }
    }
    const url = safe(() => wc.getURL()) ?? ''
    const title = safe(() => wc.getTitle()) ?? ''
    return { success: true, output: `Page: ${title}\nURL: ${url}\n\n${tree}` }
  }

  private async opClick(chatId: string, p: BrowserOpPayload, wc: Electron.WebContents | null, signal: AbortSignal): Promise<BrowserOpResult> {
    if (!wc) throw new Error('No browser tab available.')
    if (isChildFrame(wc, p.frameId)) throw new Error('Trusted coordinates in child frames are unsupported; use frame snapshot/evaluate/locator.')
    await this.actionable(wc, p, signal)
    const info = await refInfo(wc, p, signal)
    if (!info) throw new Error('Element changed while checking submission state.')
    if (info.submit && !await this.confirmBrowserAction(chatId, 'browser_click', { ref: p.ref }, 'Allow form submission?', signal)) return { success: false, error: 'User declined form submission.' }
    const point = await locate(wc, p, signal)
    if (!point) throw new Error('Element no longer actionable.')
    trustedClick(wc, point, signal)
    return { success: true, output: 'Clicked element.' }
  }

  /** Универсальный confirm через AgentConfirmDialog (переиспользуем
   *  существующий пайплайн agent:confirm). Возвращает approved. */
  private confirmBrowserAction(
    chatId: string,
    toolName: string,
    args: Record<string, unknown>,
    title: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return new Promise(resolve => {
      const win = this.getWin()
      if (!win || win.isDestroyed()) return resolve(false)
      const reqId = `browser-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      let settled = false
      const finish = (approved: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ipcMain.removeListener('agent:confirm:response:' + reqId, listener)
        signal?.removeEventListener('abort', abort)
        resolve(approved)
      }
      const timer = setTimeout(() => finish(false), 90_000)
      if (typeof timer.unref === 'function') timer.unref()
      const listener = (_e: Electron.IpcMainEvent, approved: boolean) => finish(!!approved)
      const abort = () => finish(false)
      ipcMain.once('agent:confirm:response:' + reqId, listener)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { finish(false); return }
      win.webContents.send('agent:confirm', {
        reqId,
        toolName,
        args: { ...args, _title: title, chatId },
        dangerLevel: 'warn',
      })
      void chatId
    })
  }

  private async opType(chatId: string, p: BrowserOpPayload, wc: Electron.WebContents | null, signal: AbortSignal): Promise<BrowserOpResult> {
    if (!wc) throw new Error('No browser tab available.')
    if (isChildFrame(wc, p.frameId)) throw new Error('Trusted input in child frames unsupported.')
    const text = p.text ?? p.value
    if (typeof text !== 'string' || text.length > 100000) throw new Error('text is required (maximum 100000 characters).')
    if (p.submit && !await this.confirmBrowserAction(chatId, 'browser_type', { tabId: p.tabId }, 'Allow form submission?', signal)) throw new Error('User declined form submission.')
    const before = await inspect(wc, p, signal)
    if (!before?.editable) throw new Error('Element is not editable.')
    const point = await this.actionable(wc, p, signal)
    if (await domAction(wc, p, 'prepare_value', signal) !== 'ok') throw new Error('Element is not editable.')
    trustedClick(wc, point, signal)
    if (await domAction(wc, p, 'focus', signal) !== 'ok') throw new Error('Element focus failed.')
    sendKey(wc, 'Control+End', signal)
    if (p.action === 'fill') {
      sendKey(wc, 'Control+A', signal)
      sendKey(wc, 'Backspace', signal)
    }
    guard(signal)
    if (text) await wc.insertText(text)
    await sleep(30, signal)
    const verified = await domAction(wc, p, 'verify_value', signal)
    if (verified !== 'ok') throw new Error('Text readback verification failed (value not returned).')
    if (p.submit) sendKey(wc, 'Enter', signal)
    return { success: true, output: 'Text entered and verified (value not returned).' }
  }

  private async opPressKey(chatId: string, key: string | undefined, wc: Electron.WebContents | null, signal: AbortSignal): Promise<BrowserOpResult> {
    if (!wc || !key) throw new Error('WebContents and key required.')
    if (/^(enter|return)$/i.test(key.split('+').at(-1)!) && !await this.confirmBrowserAction(chatId, 'browser_press_key', { key }, 'Allow Enter (may submit a form)?', signal)) throw new Error('User declined form submission.')
    sendKey(wc, key, signal)
    await sleep(30, signal)
    return { success: true, output: 'Key pressed.' }
  }

  private async opScroll(p: BrowserOpPayload, wc: Electron.WebContents | null, signal: AbortSignal): Promise<BrowserOpResult> {
    if (!wc) throw new Error('No browser tab available.')
    guard(signal)
    const direction = p.direction ?? 'down'
    if (!['up', 'down', 'left', 'right'].includes(direction) || !Number.isFinite(p.amount ?? 600)) throw new Error('Invalid scroll direction or amount.')
    const amount = Math.min(Math.abs(p.amount ?? 600), 10000)
    if (p.ref || p.locator || p.selector) {
      await this.actionable(wc, p, signal)
      const result = await domAction(wc, { ...p, direction, amount }, 'scroll', signal)
      if (result !== 'ok') throw new Error(`Targeted scroll failed: ${result}`)
    } else {
      const result = await domAction(wc, { ...p, direction, amount }, 'page_scroll', signal)
      if (result !== 'ok') throw new Error(`Page scroll failed: ${result}`)
    }
    return { success: true, output: 'Scroll dispatched; verify position with a snapshot.' }
  }

  private async opScreenshot(wcArg?: Electron.WebContents | null, p: BrowserOpPayload = { action: 'screenshot' }, signal?: AbortSignal): Promise<BrowserOpResult> {
    const wc = wcArg ?? this.wc()
    guard(signal)
    if (!wc) return { success: false, error: 'No browser tab available.' }
    try {
      let image: Electron.NativeImage
      const args = { ...p, ...p.args }
      if (isChildFrame(wc, p.frameId)) throw new Error('Screenshots are main-frame only.')
      let clip = args.clip as BrowserOpPayload['clip']
      if (p.ref || p.locator || p.selector) {
        const point = await this.actionable(wc, p, signal ?? new AbortController().signal)
        const offset = await wc.mainFrame.executeJavaScript('({x:scrollX,y:scrollY})', false) as { x: number; y: number }
        clip = { ...point, x: point.x + offset.x, y: point.y + offset.y }
      }
      if (args.full_page || clip) {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
        const metrics = await wc.debugger.sendCommand('Page.getLayoutMetrics')
        guard(signal)
        const size = metrics.cssContentSize ?? metrics.contentSize
        const bounds = clip ?? { x: 0, y: 0, width: size.width, height: size.height }
        if (!['x', 'y', 'width', 'height'].every(k => typeof bounds[k] === 'number' && Number.isFinite(bounds[k])) || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 || bounds.width > 16384 || bounds.height > 16384 || bounds.width * bounds.height > 32000000 || bounds.x + bounds.width > size.width + 1 || bounds.y + bounds.height > size.height + 1) throw new Error('Screenshot bounds invalid or exceed 16384px / 32 megapixels.')
        // Hidden Electron guests can deadlock CDP's surface screenshot. Capture
        // via Electron with an explicitly bounded CDP viewport instead, then
        // restore emulation even on cancellation. This may reflow responsive pages.
        const width = Math.ceil(Math.max(metrics.cssLayoutViewport?.clientWidth ?? size.width, bounds.x + bounds.width))
        const height = Math.ceil(bounds.y + bounds.height)
        if (width > 16384 || width * height > 32000000) throw new Error('Screenshot viewport exceeds safety bounds.')
        await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        try {
          guard(signal)
          await sleep(100, signal)
          image = await wc.capturePage(undefined, { stayHidden: false, stayAwake: true })
          guard(signal)
          image = image.crop({ x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) })
        } finally {
          if (!wc.isDestroyed() && wc.debugger.isAttached()) await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
        }
      } else {
        image = await wc.capturePage()
      }
      guard(signal)
      if (image.isEmpty()) {
        return { success: false, error: 'Screenshot failed: the page is not visible (browser panel hidden?). Open the Browser panel and retry.' }
      }
      const base64 = image.toPNG().toString('base64')
      return {
        success: true,
        imageBase64: base64,
        output: `Screenshot captured (${Math.round(base64.length * 0.75 / 1024)} KB PNG).`,
      }
    } catch (e) {
      return { success: false, error: `Screenshot failed: ${(e as Error).message}` }
    }
  }

  private opTabsList(): BrowserOpResult {
    const tabs = this.getTabs().map((t, i) =>
      `${i + 1}. [${t.tabId}]${t.tabId === this.activeTabId ? ' (active)' : ''} ${t.title} — ${t.url}`
    )
    if (tabs.length === 0) return { success: false, error: 'No browser tabs open. Open the Browser panel (right panel) first.' }
    return { success: true, output: `Browser tabs (${tabs.length}):\n${tabs.join('\n')}` }
  }

  private async opTabNew(url?: string, signal?: AbortSignal): Promise<BrowserOpResult> {
    const tabId = this.newTab(url)
    this.setActiveTab(tabId)
    await this.tabReady(tabId, signal)
    return { success: true, output: `New browser tab [${tabId}] opening${url ? ` at ${normalizeUrl(url)}` : ''}. Wait a moment, then use tab_select + snapshot.` }
  }

  private async opTabSelect(tabId?: string, signal?: AbortSignal): Promise<BrowserOpResult> {
    if (!tabId) return { success: false, error: 'tab_select: tab_id is required (see tabs list)' }
    if (!this.tabs.has(tabId)) return { success: false, error: `Tab ${tabId} not found. Use tabs to list open tabs.` }
    this.setActiveTab(tabId)
    await this.tabReady(tabId, signal)
    return { success: true, output: `Switched to tab [${tabId}]. Take a snapshot to see its content.` }
  }

  private async tabReady(tabId: string, signal?: AbortSignal): Promise<void> {
    const wc = await this.wcAwait(BrowserManagerImpl.WC_WAIT_MS, tabId, signal)
    if (!wc) throw new Error('Tab registration did not complete.')
    for (;;) {
      guard(signal)
      const current = this.wc(tabId)
      if (!current || current !== wc) throw new Error('Tab guest changed or was destroyed while waiting for readiness.')
      if (!current.isLoading() && current.getURL()) return
      await sleep(50, signal)
    }
  }

  private opTabClose(tabId?: string, signal?: AbortSignal): BrowserOpResult {
    if (!tabId) return { success: false, error: 'tab_close: tab_id is required' }
    if (!this.tabs.has(tabId)) return { success: false, error: `Tab ${tabId} not found.` }
    this.unregisterTab(tabId, signal)
    return { success: true, output: `Closed tab [${tabId}].` }
  }

  private async opWait(ms?: number, signal?: AbortSignal): Promise<BrowserOpResult> {
    const t = Math.min(Math.max(ms ?? 1000, 100), 10_000)
    await sleep(t, signal)
    return { success: true, output: `Waited ${t}ms.` }
  }


}
function guard(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('Browser operation aborted.') }
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(new Error('Browser operation aborted.')) }
    signal.addEventListener('abort', abort, { once: true })
    task.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
  })
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  guard(signal)
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(new Error('Browser operation aborted.')) }
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
function safeOrigin(url: string): string { try { return new URL(url).origin } catch { return '[unknown]' } }
function navigation(wc: Electron.WebContents, start: () => void, signal?: AbortSignal): Promise<void> {
  guard(signal)
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      wc.removeListener('did-stop-loading', done); wc.removeListener('did-navigate-in-page', inPage)
      wc.removeListener('did-fail-load', failed); wc.removeListener('destroyed', destroyed)
      signal?.removeEventListener('abort', abort)
    }
    const done = () => { cleanup(); resolve() }
    const inPage = (_event: Electron.Event, _url: string, main: boolean) => { if (main && !wc.isLoading()) done() }
    const failed = (_event: Electron.Event, code: number, description: string, _url: string, main: boolean) => { if (main && code !== -3) { cleanup(); reject(new Error(description)) } }
    const destroyed = () => { cleanup(); reject(new Error('Tab destroyed.')) }
    const abort = () => { cleanup(); if (!wc.isDestroyed()) wc.stop(); reject(new Error('Browser operation aborted.')) }
    wc.on('did-stop-loading', done); wc.on('did-navigate-in-page', inPage); wc.on('did-fail-load', failed); wc.once('destroyed', destroyed)
    signal?.addEventListener('abort', abort, { once: true })
    try { guard(signal); start() } catch (error) { cleanup(); reject(error) }
  })
}
function trustedClick(wc:Electron.WebContents,p:{x:number;y:number;width:number;height:number},signal?:AbortSignal,button:'left'|'right'='left',count=1):void{ guard(signal); const x=Math.round(p.x+p.width/2),y=Math.round(p.y+p.height/2); wc.sendInputEvent({type:'mouseMove',x,y}); wc.sendInputEvent({type:'mouseDown',x,y,button,clickCount:count}); wc.sendInputEvent({type:'mouseUp',x,y,button,clickCount:count}) }
function sendKey(wc: Electron.WebContents, key: string, signal?: AbortSignal): void {
  guard(signal)
  const parts = key.split('+')
  const raw = parts.pop() ?? ''
  const aliases: Record<string, string> = { ctrl: 'control', control: 'control', shift: 'shift', alt: 'alt', meta: 'meta', cmd: 'meta', command: 'meta' }
  const modifiers = parts.map(part => aliases[part.toLowerCase()])
  if (modifiers.some(modifier => !modifier) || new Set(modifiers).size !== modifiers.length) throw new Error('Unknown or duplicate keyboard modifier.')
  const navigation: Record<string, string> = { enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', arrowup: 'Up', up: 'Up', arrowdown: 'Down', down: 'Down', arrowleft: 'Left', left: 'Left', arrowright: 'Right', right: 'Right', space: 'Space' }
  const code = navigation[raw.toLowerCase()] ?? (raw.length === 1 ? raw : '')
  if (!code || modifiers.includes('alt') || modifiers.includes('meta')) throw new Error('Unsupported or dangerous keyboard shortcut.')
  const control = modifiers.includes('control')
  const editKeys = ['a', 'c', 'v', 'x', 'z', 'y', 'home', 'end', 'left', 'right', 'up', 'down', 'backspace', 'delete']
  if (control && !editKeys.includes(code.toLowerCase())) throw new Error('Unsupported or dangerous keyboard shortcut.')
  const inputModifiers = modifiers as Electron.InputEvent['modifiers']
  wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: inputModifiers })
  if (!control && code.length === 1) wc.sendInputEvent({ type: 'char', keyCode: code, modifiers: inputModifiers })
  wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: inputModifiers })
}
function normalizeUrl(input:string):string{const s=input.trim();if(/^(https?|file|about|chrome|data):/i.test(s))return s;if(/^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(s))return 'https://'+s;return 'https://www.google.com/search?q='+encodeURIComponent(s)}
function safe<T>(fn:()=>T):T|null{try{return fn()}catch{return null}}

const SIDE_BUTTON_SCRIPT = `(()=>{if(window.__syntee_sidebtn)return;window.__syntee_sidebtn=true;addEventListener('mouseup',e=>{if(e.button===3)history.back();if(e.button===4)history.forward()},true)})()`
export const browserManager = new BrowserManagerImpl()
