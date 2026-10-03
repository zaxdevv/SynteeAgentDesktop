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
import { useShallow } from 'zustand/react/shallow'
import AppIcon from '../AppIcon/AppIcon'
import { useBrowserStore, type BrowserTab } from '../../../store/browser.store'
import { useUIStore } from '../../../store/ui.store'
import BrowserExtensionsPopover from './BrowserExtensions'
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
      window.syntee.browser.registerTab(tab.tabId, wcId).catch(e =>
        console.error('[BrowserPanel] registerTab failed:', e))
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
        if (!tab.discarded) {
          window.syntee.browser.unregisterTab(tab.tabId).catch(() => { /* ok */ })
        }
        registered.current = false
      }
    }
    // tab.discarded НЕ в deps НАМЕРЕННО: cleanup должен читать СВЕЖЕЕ
    // значение (main мутирует entry на месте) в момент анмаунта — webview
    // уходит из-за discard, а запись таба обязана выжить. Deps по
    // discarded перевесили бы слушатели в середине цикла discard/restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId])

  return (
    <webview
      ref={ref}
      className="browser-webview"
      // eslint-disable-next-line react/no-unknown-property -- Electron webview-атрибуты (custom element)
      partition="persist:syntee-browser"
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
  /** Якорь поповера расширений — элемент кнопки (ставится в onClick, не в render). */
  const [extAnchor, setExtAnchor] = useState<HTMLButtonElement | null>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)

  // Эффективный активный таб: activeTabId из main, fallback на первый
  // (при boot-restore activeTabId может быть null — иначе ВСЕ webview
  // получают display:none → белый экран).
  const activeId = activeTabId ?? tabs[0]?.tabId ?? null
  const activeTab = tabs.find(t => t.tabId === activeId) ?? null

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

        <button
          className="browser-nav-btn"
          onClick={e => {
            // Якорь поповера — сам элемент кнопки (в обработчике, не в render).
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
