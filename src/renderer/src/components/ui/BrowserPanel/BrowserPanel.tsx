// ── BrowserPanel: встроенный браузер в правой панели ──────────────────────
//
// <webview> в DOM — React-UI (меню/модалки/поповеры) рендерится поверх
// нативно, z-index работает (главное преимущество перед WebContentsView).
//
// Архитектура:
//  • main (BrowserManager) — источник истины: реестр табов, навигация,
//    AI-тулы. Пушит BROWSER_TAB_STATE при изменениях.
//  • Здесь: таб-стрип браузера, адресная строка, назад/вперёд/обновление.
//  • Регистрация: каждый webview при did-attach регистрируется в main
//    (browser:registerTab) — дальше всем управляет main.
//  • Keep-alive: webview'ы не анмаунтятся при переключении активного таба
//    (display:none) — состояние страниц живёт. При закрытии правой панели
//    (панель целиком) — тоже (mountedPanels в RightPanel).
//
// Расширения (фаза 4): кнопка-пазл в тулбаре → ExtensionsPopover.

import { useEffect, useRef, useState, useCallback, memo } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import AppIcon from '../AppIcon/AppIcon'
import { useBrowserStore, type BrowserTab } from '../../../store/browser.store'
import { useUIStore } from '../../../store/ui.store'
import BrowserExtensionsPopover from './BrowserExtensions'
import BrowserImportDialog from './BrowserImportDialog'
import BrowserCreateProfileDialog from './BrowserCreateProfileDialog'
import BrowserDeleteProfileDialog from './BrowserDeleteProfileDialog'
import type { WebviewElement } from './webview.d'
import './BrowserPanel.css'

/** Хост webview-элемента. Монтируется пока таб жив; при idle-discard
 *  анмаунтится (guest-процесс умирает), при восстановлении таба создаётся
 *  ЗАНОВО — свежий mount → did-attach → registerTab перевешивает
 *  слушатели на новый guest-процесс. Поэтому логика attach живёт здесь,
 *  а не в родителе.
 *
 *  memo с полевым компаратором: main мутирует entry-объекты на месте
 *  (Object.assign) — ссылка не меняется, дефолтный shallow-компаратор
 *  заморозил бы UI. Сравниваем значимые поля: ре-рендер только когда
 *  что-то из них реально изменилось (пуши идут пачками). */
const WebviewHost = memo(function WebviewHost({ tab, isActive }: { tab: BrowserTab; isActive: boolean }) {
  const ref = useRef<WebviewElement>(null)
  const registered = useRef(false)

  // src-атрибут: mount + обновления ТОЛЬКО пока guest не attached.
  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const url = tab.url && tab.url !== 'about:blank' ? tab.url : 'about:blank'
    let attached = false
    try { wv.getWebContentsId(); attached = true } catch { attached = false }
    // webview без src не создаёт guest-процесс вообще (белый экран) —
    // поэтому на mount src ставится всегда; дальше — только не-attached.
    if (!attached && wv.getAttribute('src') !== url) {
      wv.setAttribute('src', url)
    }
  }, [tab.url])

  useEffect(() => {
    const wv = ref.current
    if (!wv) return

    const onAttach = () => {
      if (registered.current) return
      // getWebContentsId бросает, пока guest-процесс не создан — НЕ ставим
      // registered.current до успешного получения id, иначе ранний вызов
      // (mount) навсегда заблокирует регистрацию: did-attach позже уйдёт
      // в ранний return, реестр main останется с webContentsId=-1.
      let wcId: number
      try {
        wcId = wv.getWebContentsId()
      } catch {
        return // ещё не attached — ждём did-attach/dom-ready
      }
      registered.current = true
      window.syntee.browser.registerTab(tab.tabId, wcId).catch(e => {
        registered.current = false // Allow dom-ready to retry a failed attach request.
        console.error('[BrowserPanel] registerTab failed:', e)
      })
    }

    // did-attach стреляет раньше dom-ready (guest создан) — регистрируем
    // как можно раньше, дальше main управляет через webContents.fromId.
    wv.addEventListener('did-attach', onAttach)
    wv.addEventListener('dom-ready', onAttach)
    // События могли прийти до подписки — пробуем сразу (getWebContentsId
    // кидает, если guest ещё не создан — тогда просто ждём did-attach).
    onAttach()

    return () => {
      wv.removeEventListener('did-attach', onAttach)
      wv.removeEventListener('dom-ready', onAttach)
      if (registered.current) {
        // Выгруженный (discarded) таб живёт в реестре main — webview уходит,
        // запись остаётся (восстановится при tab_select). При обычном
        // закрытии таб уже удалён из реестра (browser:closeTab) — повторный
        // unregister в main это no-op.
        // IPC pushes clone tab objects; the effect closure is NOT updated when
        // main mutates an entry. Read the current store before removing the tab.
        const latest = useBrowserStore.getState().tabs.find(t => t.tabId === tab.tabId)
        if (!latest?.discarded) {
          window.syntee.browser.unregisterTab(tab.tabId).catch(() => { /* ok */ })
        }
        registered.current = false
      }
    }
    // Cleanup reads discarded from the store, not the captured tab object.
    // Changing discarded in deps would unregister mid discard/restore cycle.
  }, [tab.tabId])

  return (
    <webview
      ref={ref}
      className="browser-webview"
      // eslint-disable-next-line react/no-unknown-property -- Electron webview-атрибуты (custom element)
      partition={tab.partition ?? 'persist:syntee-browser'}
      // Без allowpopups webview блокирует target=_blank / window.open НА
      // УРОВНЕ КОНТЕНТА — setWindowOpenHandler в main даже не вызывается
      // (ссылки «открыть в новой вкладке» молча не открывались). С атрибутом
      // вызывается хендлер → deny + новый таб панели.
      // eslint-disable-next-line react/no-unknown-property -- Electron webview-атрибут (custom element)
      allowpopups={true}
      style={{ display: isActive ? 'flex' : 'none', flex: 1, width: '100%' }}
    />
  )
}, (a, b) =>
  a.isActive === b.isActive
  && a.tab.tabId === b.tab.tabId
  && a.tab.url === b.tab.url
  && a.tab.title === b.tab.title
  && a.tab.loading === b.tab.loading
  && a.tab.favicon === b.tab.favicon
  && a.tab.discarded === b.tab.discarded
  && a.tab.canGoBack === b.tab.canGoBack
  && a.tab.canGoForward === b.tab.canGoForward
)

/** Один таб браузера: webview (живой) или заглушка (выгружен idle-discard).
 *  Монтируется при появлении в реестре, НЕ анмаунтится при переключении
 *  (keep-alive). */
function BrowserTabView({ tab, isActive }: { tab: BrowserTab; isActive: boolean }) {
  if (tab.discarded) {
    return (
      <div
        className="browser-tab-discarded"
        style={{ display: isActive ? 'flex' : 'none' }}
      >
        <AppIcon name="globe" size="sm" />
        <span>Вкладка выгружена для экономии памяти — кликни по ней в списке, чтобы восстановить</span>
      </div>
    )
  }
  return <WebviewHost tab={tab} isActive={isActive} />
}

export default function BrowserPanel() {
  const { tabs, activeTabId, urlDraft, urlFocused, setUrlDraft, setUrlFocused } = useBrowserStore(
    useShallow(s => ({ tabs: s.tabs, activeTabId: s.activeTabId, urlDraft: s.urlDraft, urlFocused: s.urlFocused, setUrlDraft: s.setUrlDraft, setUrlFocused: s.setUrlFocused })),
  )
  /** Агент сейчас выполняет browser_* тул → бейдж «AI» в тулбаре. */
  const agentActiveTool = useBrowserStore(s => s.agentActiveTool)
  const [extOpen, setExtOpen] = useState(false)
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([])
  const [activeProfileId, setActiveProfileId] = useState('default')
  const [profileOpen, setProfileOpen] = useState(false)
  const [createProfileOpen, setCreateProfileOpen] = useState(false)
  const [deleteProfile, setDeleteProfile] = useState<{ id: string; name: string } | null>(null)
  const [dataDialog, setDataDialog] = useState<'import' | 'bookmarks' | 'history' | null>(null)
  const [chromeOpen, setChromeOpen] = useState(false)
  const [chromeState, setChromeState] = useState<{ available: boolean; profiles: Array<{ id: string; name: string }> } | null>(null)
  const [chromeLoading, setChromeLoading] = useState(false)
  const [chromeBusy, setChromeBusy] = useState(false)
  const [chromeError, setChromeError] = useState<string | null>(null)
  /** Якорь поповера расширений — элемент кнопки (ставится в onClick, не в render). */
  const [extAnchor, setExtAnchor] = useState<HTMLButtonElement | null>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)

  // Эффективный активный таб: activeTabId из main, fallback на первый
  // (при boot-restore activeTabId может быть null — иначе ВСЕ webview
  // получают display:none → белый экран).
  const activeId = activeTabId ?? tabs[0]?.tabId ?? null
  const activeTab = tabs.find(t => t.tabId === activeId) ?? null

  // ── Профили браузера ──
  useEffect(() => {
    window.syntee.browser.profilesList().then(s => { setProfiles(s.profiles); setActiveProfileId(s.activeId) }).catch(() => { /* ok */ })
  }, [])

  const switchProfile = useCallback(async (id: string) => {
    if (id === activeProfileId) { setProfileOpen(false); return }
    if (await window.syntee.browser.profilesSwitch(id)) {
      setActiveProfileId(id); setProfileOpen(false)
      const state = await window.syntee.browser.getState()
      useBrowserStore.getState().setTabs(state.tabs, state.activeTabId)
    }
  }, [activeProfileId])

  const createProfile = useCallback(async (name: string) => {
    const profile = await window.syntee.browser.profilesCreate(name)
    setProfiles(current => [...current, profile])
    await switchProfile(profile.id)
  }, [switchProfile])

  const confirmDeleteProfile = useCallback(async () => {
    if (!deleteProfile || deleteProfile.id === 'default') return
    const result = await window.syntee.browser.profilesDelete(deleteProfile.id)
    const state = await window.syntee.browser.profilesList()
    setProfiles(state.profiles)
    setActiveProfileId(result.activeId)
    setDeleteProfile(null)
    const tabsState = await window.syntee.browser.getState()
    useBrowserStore.getState().setTabs(tabsState.tabs, tabsState.activeTabId)
  }, [deleteProfile])

  // ── Подписка на push состояния табов из main ──
  useEffect(() => {
    const off = window.syntee.browser.onTabState(state => {
      useBrowserStore.getState().setTabs(state.tabs, state.activeTabId)
    })
    // Начальное состояние (после рестарта панели/приложения).
    window.syntee.browser.getState().then(state => {
      if (state.tabs.length > 0) {
        useBrowserStore.getState().setTabs(state.tabs, state.activeTabId)
      } else {
        // Первый запуск — создаём стартовый таб. Push может проиграть гонку
        // (событие ушло до подписки / окно не было готово) — перепроверяем
        // реестр через getState после создания.
        window.syntee.browser.newTab().then(() =>
          window.syntee.browser.getState().then(s => {
            if (s.tabs.length > 0) {
              useBrowserStore.getState().setTabs(s.tabs, s.activeTabId)
            }
          })
        ).catch(e => console.error('[BrowserPanel] newTab failed:', e))
      }
    }).catch(e => console.error('[BrowserPanel] getState failed:', e))
    return () => { off() }
  }, [])

  // ── Черновик адресной строки следует за активным табом ──
  // Пока инпут НЕ в фокусе — обновляем на каждый URL-пуш (навигация
  // агентом, кнопками, ссылками, target=_blank). Раньше синкался только
  // при ПУСТОМ черновике → после первой загрузки поле навсегда
  // показывало стартовый google. В фокусе — не трогаем (юзер печатает).
  useEffect(() => {
    if (!urlFocused) {
      setUrlDraft(activeTab?.url && activeTab.url !== 'about:blank' ? activeTab.url : '')
    }
  }, [activeTab?.url, urlFocused, setUrlDraft])

  // ── Видимость браузера → main (мьют звука невидимых табов) ──
  // Браузер виден = правая панель открыта + таб «Браузер» активен + есть
  // активный таб браузера. Иначе (панель закрыта / другой таб панели) —
  // звук гасится у всех webview: фоновые видео не орут из закрытой панели.
  const panelOpen = useUIStore(s => s.agentPanelOpen)
  const panelTab = useUIStore(s => s.agentPanelTab)
  useEffect(() => {
    const visible = panelOpen && panelTab === 'browser' ? (activeId ?? null) : null
    window.syntee.browser.setVisibleTab(visible).catch(() => { /* ок */ })
  }, [panelOpen, panelTab, activeId])

  const handleNavigate = useCallback(() => {
    const url = urlDraft.trim()
    if (!url || !activeTab) return
    window.syntee.browser.navigate(activeTab.tabId, url).catch(() => { /* ok */ })
    urlInputRef.current?.blur()
  }, [urlDraft, activeTab])

  const handleNewTab = useCallback(() => {
    window.syntee.browser.newTab().catch(() => { /* ok */ })
  }, [])

  const openChromeDialog = useCallback(async () => {
    setProfileOpen(false); setChromeOpen(true); setChromeLoading(true); setChromeError(null)
    try { setChromeState(await window.syntee.browser.chromeProfiles()) } catch (e) { setChromeError(e instanceof Error ? e.message : 'Не удалось найти Chrome') }
    finally { setChromeLoading(false) }
  }, [])
  const launchChrome = useCallback(async (profileId: string) => {
    setChromeBusy(true); setChromeError(null)
    try {
      let safeUrl: string | undefined
      try { if (activeTab?.url && ['http:', 'https:'].includes(new URL(activeTab.url).protocol)) safeUrl = activeTab.url } catch { /* about:blank or invalid draft */ }
      const result = await window.syntee.browser.chromeOpen(profileId, safeUrl)
      if (!result.ok) setChromeError(result.error || 'Не удалось открыть Chrome')
      else setChromeOpen(false)
    } catch (e) { setChromeError(e instanceof Error ? e.message : 'Не удалось открыть Chrome') }
    finally { setChromeBusy(false) }
  }, [activeTab])

  const handleCloseTab = useCallback((tabId: string) => {
    window.syntee.browser.closeTab(tabId).catch(() => { /* ok */ })
  }, [])

  const handleSelectTab = useCallback((tabId: string) => {
    window.syntee.browser.selectTab(tabId).catch(() => { /* ok */ })
  }, [])

  return (
    <div className="browser-panel">
      {/* ── Тулбар: навигация + адресная строка + расширения ── */}
      <div className="browser-toolbar">
        {/* Агент управляет браузером прямо сейчас */}
        {agentActiveTool && (
          <div
            className="browser-ai-badge"
            title={`AI выполняет: ${agentActiveTool}`}
          >
            <span className="browser-ai-badge__dot" />
            AI
          </div>
        )}
        <button
          className="browser-nav-btn"
          disabled={!activeTab?.canGoBack}
          onClick={() => activeTab && window.syntee.browser.back(activeTab.tabId)}
          title="Назад"
        >
          <AppIcon name="chevronLeft" size="xs" />
        </button>
        <button
          className="browser-nav-btn"
          disabled={!activeTab?.canGoForward}
          onClick={() => activeTab && window.syntee.browser.forward(activeTab.tabId)}
          title="Вперёд"
        >
          <AppIcon name="chevronRight" size="xs" />
        </button>
        <button
          className="browser-nav-btn"
          onClick={() => activeTab && window.syntee.browser.reload(activeTab.tabId)}
          title="Обновить"
        >
          <AppIcon name="refreshCw" size="xs" />
        </button>

        <div className="browser-url-wrap">
          {activeTab?.loading ? (
            <span className="browser-url-spinner" />
          ) : (
            <AppIcon name="lock" size="xs" className="browser-url-icon" />
          )}
          <input
            ref={urlInputRef}
            className="browser-url-input"
            value={urlDraft}
            onChange={e => setUrlDraft(e.target.value)}
            onFocus={e => { setUrlFocused(true); e.target.select() }}
            onBlur={() => setUrlFocused(false)}
            onKeyDown={e => { if (e.key === 'Enter') handleNavigate() }}
            placeholder="Поиск или адрес"
            spellCheck={false}
          />
        </div>

        <div className="browser-profile-wrap">
          <button className="browser-profile-btn" onClick={() => setProfileOpen(v => !v)} title="Профиль браузера">
            <AppIcon name="user" size="xs" />
            <span>{profiles.find(p => p.id === activeProfileId)?.name ?? 'Личный'}</span>
          </button>
          {profileOpen && (
            <div className="browser-profile-menu">
              {profiles.map(profile => (
                <div key={profile.id} className="browser-profile-row">
                  <button className={profile.id === activeProfileId ? 'is-active' : ''} onClick={() => switchProfile(profile.id)}>
                    {profile.id === activeProfileId ? '✓ ' : ''}{profile.name}
                  </button>
                  {profile.id !== 'default' && <button type="button" title={`Удалить профиль ${profile.name}`} onClick={() => { setProfileOpen(false); setDeleteProfile(profile) }}>×</button>}
                </div>
              ))}
              <div className="browser-profile-divider" />
              <button onClick={() => { setProfileOpen(false); setCreateProfileOpen(true) }}>＋ Создать пустой профиль</button>
              {activeProfileId !== 'default' && (
                <button onClick={() => { setProfileOpen(false); setDeleteProfile(profiles.find(p => p.id === activeProfileId) ?? null) }}>Удалить профиль</button>
              )}
              <button onClick={openChromeDialog}>🌐 Использовать оригинальный Chrome</button>
              <button onClick={() => { setProfileOpen(false); setDataDialog('import') }}>↓ Импортировать из Chrome / Edge</button>
              <div className="browser-profile-divider" />
              <button onClick={() => { setProfileOpen(false); setDataDialog('bookmarks') }}>Импортированные закладки</button>
              <button onClick={() => { setProfileOpen(false); setDataDialog('history') }}>Импортированная история</button>
            </div>
          )}
        </div>
        <button
          className="browser-nav-btn"
          onClick={e => {
            setExtAnchor(e.currentTarget)
            setExtOpen(v => !v)
          }}
          title="Расширения браузера"
        >
          <AppIcon name="puzzle" size="xs" />
        </button>
        <button
          className="browser-nav-btn"
          onClick={handleNewTab}
          title="Новая вкладка"
        >
          <AppIcon name="plus" size="xs" />
        </button>
      </div>

      {/* ── Таб-стрип браузера ── */}
      {tabs.length > 1 && (
        <div className="browser-tabstrip">
          {tabs.map(t => (
            <div
              key={t.tabId}
              className={`browser-tab ${t.tabId === activeId ? 'browser-tab--active' : ''}`}
              onClick={() => handleSelectTab(t.tabId)}
              title={t.url}
            >
              {t.favicon ? (
                <img src={t.favicon} alt="" className="browser-tab-favicon" />
              ) : (
                <AppIcon name="globe" size="xs" />
              )}
              <span className="browser-tab-title">{t.loading ? 'Загрузка…' : t.title}</span>
              <button
                className="browser-tab-close"
                onClick={e => { e.stopPropagation(); handleCloseTab(t.tabId) }}
                title="Закрыть вкладку"
              >
                <AppIcon name="x" size="xs" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Webview-контейнер (keep-alive) ── */}
      <div className="browser-content">
        {tabs.map(t => (
          <BrowserTabView key={t.tabId} tab={t} isActive={t.tabId === activeId} />
        ))}
      </div>

      {createProfileOpen && (
        <BrowserCreateProfileDialog onClose={() => setCreateProfileOpen(false)} onCreate={createProfile} />
      )}
      {deleteProfile && (
        <BrowserDeleteProfileDialog profile={deleteProfile} onClose={() => setDeleteProfile(null)} onDelete={confirmDeleteProfile} />
      )}
      {chromeOpen && createPortal(
        <div className="browser-chrome-modal" role="dialog" aria-modal="true">
          <div className="browser-chrome-modal__card">
            <h3>Использовать оригинальный Chrome</h3>
            <p>Откроется внешнее окно настоящего Chrome. Авторизации оригинального профиля сохраняются; управление Syntee к нему не подключено.</p>
            {chromeLoading && <p>Поиск профилей…</p>}
            {!chromeLoading && chromeState && !chromeState.available && <p>Chrome не найден в стандартных папках Windows.</p>}
            {!chromeLoading && chromeState?.profiles.map(profile => (
              <button key={profile.id} disabled={chromeBusy} onClick={() => launchChrome(profile.id)}>{chromeBusy ? 'Открытие…' : profile.name}</button>
            ))}
            {chromeError && <p role="alert">{chromeError}</p>}
            <button type="button" disabled={chromeBusy} onClick={() => setChromeOpen(false)}>Отмена</button>
          </div>
        </div>, document.body,
      )}

      {dataDialog && (
        <BrowserImportDialog
          mode={dataDialog}
          profileId={activeProfileId}
          onClose={() => setDataDialog(null)}
          onImported={async profile => {
            const state = await window.syntee.browser.profilesList()
            setProfiles(state.profiles)
            await switchProfile(profile.id)
          }}
        />
      )}

      {/* ── Поповер расширений (portal — поверх webview) ── */}
      {extOpen && (
        <BrowserExtensionsPopover
          anchorEl={extAnchor}
          onClose={() => setExtOpen(false)}
          onChanged={() => { /* расширения применяются к сессии сразу */ }}
        />
      )}
    </div>
  )
}
