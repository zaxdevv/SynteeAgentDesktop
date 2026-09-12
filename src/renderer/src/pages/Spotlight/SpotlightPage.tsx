import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { readClipboard } from '@renderer/utils/clipboard'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import Logo from '../../components/ui/Logo/Logo'
import { getPluginsExt, type PluginSearchProviderResult } from '../../utils/pluginExtApi'
import './SpotlightPage.css'

// ── Типы результатов поиска из main (chat:searchHistory) ──────────────
type SearchSource = 'memory' | 'messages' | 'summaries' | 'agent_logs' | 'pinned'
interface HistoryResult {
  source: SearchSource
  content: string
  score: number
  chatId?: string
  chatTitle?: string
  messageId?: string
  role?: string
  date?: number
}

interface ChatBrief {
  id: string
  title: string
  updatedAt: number
  lastMessage?: string
  messageCount?: number
}

// ── Универсальный item для списка Spotlight ────────────────────────────
interface SuggestionItem {
  id: string
  icon: IconName
  label: string
  sub?: string
  /** 2-строчное превью содержимого (для messages/pinned — content). */
  preview?: string
  group: string
  /** Подсветить совпадение с этим query в label/preview. */
  match?: string
  action: () => void
}

const SOURCE_META: Record<SearchSource, { icon: IconName; group: string }> = {
  memory: { icon: 'brain', group: 'Память' },
  messages: { icon: 'messageSquare', group: 'Сообщения' },
  summaries: { icon: 'fileText', group: 'Сводки чатов' },
  agent_logs: { icon: 'terminal', group: 'Логи агента' },
  pinned: { icon: 'pin', group: 'Закреплённое' },
}

const SOURCE_ORDER: SearchSource[] = ['messages', 'summaries', 'pinned', 'agent_logs', 'memory']

// ── Команды с ключами для fuzzy-матча (рус + англ) ─────────────────────
interface CommandDef {
  id: string
  icon: IconName
  label: string
  sub: string
  keys: string[] // подстроки для матча (рус + англ)
  section?: string // секция настроек, если применимо
  run: (ctx: ActionContext) => void
}

const COMMANDS: CommandDef[] = [
  { id: 'new-chat', icon: 'plus', label: 'Новый чат', sub: 'Открыть главное окно', keys: ['новый чат', 'чат', 'new chat', 'chat', 'новый'], run: c => c.newChat() },
  { id: 'voice', icon: 'mic', label: 'Голосовой режим', sub: 'Голосовой ввод', keys: ['голос', 'voice', 'микро', 'mic', 'speech'], run: c => c.showVoice() },
  { id: 'overlay', icon: 'search', label: 'Circle to Search', sub: 'Захват экрана', keys: ['circle', 'overlay', 'поиск экран', 'screen', 'захват'], run: c => c.showOverlay() },
  { id: 'settings-general', icon: 'settings', label: 'Настройки', sub: 'Общие', keys: ['настройки', 'settings', 'config', 'настр'], section: 'general', run: c => c.openSettings('general') },
  { id: 'settings-voice', icon: 'mic', label: 'Настройки → Голос', sub: 'Голосовой ввод', keys: ['голос настройки', 'voice settings', 'настройки голос'], section: 'voice', run: c => c.openSettings('voice') },
  { id: 'settings-memory', icon: 'brain', label: 'Настройки → Память', sub: 'Память ассистента', keys: ['память настройки', 'memory settings', 'настройки память'], section: 'memory', run: c => c.openSettings('memory') },
]

interface ActionContext {
  askAI: (text: string, chatId?: string) => void
  newChat: () => void
  openChat: (chatId: string) => void
  openSettings: (section?: string) => void
  showVoice: () => void
  showOverlay: () => void
}

export default function SpotlightPage() {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [items, setItems] = useState<SuggestionItem[]>([])
  const [quickMode, setQuickMode] = useState(false)
  const [loading, setLoading] = useState(false)
  const [hasResults, setHasResults] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchSeq = useRef(0)

  // Кеш поиска (TTL 30 сек) — чтобы не дёргать IPC при повторе того же query.
  const searchCache = useRef<Map<string, { results: HistoryResult[]; ts: number }>>(new Map())

  // Контекстные данные (подгружаем при показе).
  const [recentChats, setRecentChats] = useState<ChatBrief[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [clipboardText, setClipboardText] = useState('')

  // ── Загрузка контекста при монтировании/показе ──────────────────────
  const loadContext = useCallback(async () => {
    try {
      const [chats, activeId, hist] = await Promise.all([
        window.syntee.chat.getAll() as Promise<ChatBrief[]>,
        window.syntee.chat.getActive() as Promise<string | null>,
        window.syntee.spotlight.getHistory() as Promise<string[]>,
      ])
      const sorted = (chats ?? [])
        .filter(c => c && c.id)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 4)
      setRecentChats(sorted)
      setActiveChatId(activeId ?? null)
      setHistory(Array.isArray(hist) ? hist : [])
    } catch { /* ок — вне electron */ }

    // Буфер обмена — через нативный IPC (работает на file://).
    const text = (await readClipboard()) ?? ''
    setClipboardText(text.length > 20 ? text : '')
  }, [])

  // ── Слушатель spotlight:mode (main шлёт 'normal' / 'quick' при show) ──
  useEffect(() => {
    const off = window.syntee.on('spotlight:mode', (mode: unknown) => {
      setQuickMode(String(mode ?? 'normal') === 'quick')
      setQuery('')
      setSelected(0)
      searchCache.current.clear()
      void loadContext()
      requestAnimationFrame(() => inputRef.current?.focus())
    })
    return () => { off() }
  }, [loadContext])

  // ── Сброс при каждом открытии окна: фокус + чистый query ─────────────
  useEffect(() => {
    inputRef.current?.focus()
    void loadContext()
    const onShow = () => {
      setQuery('')
      setSelected(0)
      searchCache.current.clear()
      void loadContext()
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    const offShow = window.syntee.on('spotlight:show', onShow)
    return () => { offShow() }
  }, [loadContext])

  // ── Управление высотой окна: expand когда есть контент ────────────────
  useEffect(() => {
    if (items.length > 0 || hasResults || loading) {
      window.syntee.spotlight.expand()
    } else {
      window.syntee.spotlight.collapse()
    }
  }, [items.length, hasResults, loading])

  // ── Закрытие ─────────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    setQuery('')
    setSelected(0)
    window.syntee.spotlight.hide()
  }, [])

  // ── Реальные actions ──────────────────────────────────────────────────
  const askAI = useCallback((text: string, chatId?: string) => {
    if (!text.trim()) return
    window.syntee.spotlight.addHistory(text).catch(() => {})
    window.syntee.spotlight.quickAsk(text, chatId)
    setQuery('')
    setSelected(0)
  }, [])

  const newChat = useCallback(() => {
    window.syntee.spotlight.newChat()
    setQuery('')
    setSelected(0)
  }, [])

  const openChat = useCallback((chatId: string) => {
    window.syntee.spotlight.openChat(chatId)
    setQuery('')
    setSelected(0)
  }, [])

  const openSettings = useCallback((section?: string) => {
    window.syntee.spotlight.openSettings(section)
    setQuery('')
    setSelected(0)
  }, [])

  const showVoice = useCallback(() => {
    window.syntee.voice.show()
    handleClose()
  }, [handleClose])

  const showOverlay = useCallback(() => {
    window.syntee.overlay.show()
    handleClose()
  }, [handleClose])

  const actionCtx: ActionContext = useMemo(() => ({
    askAI, newChat, openChat, openSettings, showVoice, showOverlay,
  }), [askAI, newChat, openChat, openSettings, showVoice, showOverlay])

  // ── Default suggestions (когда query пустой) ─────────────────────────
  const defaultSuggestions = useMemo<SuggestionItem[]>(() => {
    const out: SuggestionItem[] = []

    // Буфер обмена — топ-результат если есть длинный текст.
    if (clipboardText.trim()) {
      out.push({
        id: 'clipboard',
        icon: 'clipboard',
        label: 'Вставить из буфера',
        sub: truncate(clipboardText, 60),
        group: 'Действия',
        action: () => askAI(clipboardText.trim()),
      })
    }

    // Недавние чаты.
    for (const c of recentChats) {
      out.push({
        id: `recent-${c.id}`,
        icon: 'messageSquare',
        label: c.title || 'Без названия',
        sub: c.lastMessage ? truncate(c.lastMessage, 50) : relativeTime(c.updatedAt),
        group: 'Недавние чаты',
        action: () => openChat(c.id),
      })
    }

    // Команды.
    for (const cmd of COMMANDS) {
      out.push({
        id: `cmd-${cmd.id}`,
        icon: cmd.icon,
        label: cmd.label,
        sub: cmd.sub,
        group: 'Команды',
        action: () => cmd.run(actionCtx),
      })
    }

    // История запросов.
    for (const h of history.slice(0, 6)) {
      out.push({
        id: `hist-q-${h}`,
        icon: 'clock',
        label: h,
        sub: 'Недавний запрос',
        group: 'Недавние запросы',
        action: () => askAI(h),
      })
    }

    return out
  }, [clipboardText, recentChats, history, actionCtx, askAI, openChat])

  // Финализация поиска: собираем items, ставим selected на первый history.
  const finishSearch = useCallback((
    seq: number, q: string,
    actionItems: SuggestionItem[],
    matchedCmds: SuggestionItem[],
    results: HistoryResult[],
    pluginItems: SuggestionItem[] = [],
  ) => {
    if (seq !== searchSeq.current) return
    const historyItems: SuggestionItem[] = results.map((r, i) => {
      const meta = SOURCE_META[r.source]
      const isMsg = r.source === 'messages' || r.source === 'pinned'
      return {
        id: `hist-${r.source}-${r.messageId ?? r.chatId ?? i}`,
        icon: meta.icon,
        label: r.chatTitle || truncate(r.content, 70),
        sub: buildSub(r),
        preview: isMsg ? truncate(r.content, 160) : undefined,
        group: meta.group,
        match: q,
        action: () => {
          if (r.chatId) openChat(r.chatId)
          else openSettings('memory')
        },
      }
    })

    const all = [...actionItems, ...matchedCmds, ...historyItems, ...pluginItems]
    setHasResults(historyItems.length > 0 || pluginItems.length > 0)
    setItems(all)
    // Автовыбор: если есть history-результаты — встаём на первый найденный
    // (пропуская action-items). Иначе — на top (Спросить).
    const firstHistoryIdx = actionItems.length + matchedCmds.length
    setSelected(historyItems.length > 0 ? firstHistoryIdx : 0)
    if (seq === searchSeq.current) setLoading(false)
  }, [openChat, openSettings])

  // Собрать SuggestionItem[] из ответа search-провайдеров плагинов.
  // Каждый провайдер становится отдельной секцией-группой (label — заголовок).
  const buildPluginSearchItems = useCallback((providers: PluginSearchProviderResult[], query: string): SuggestionItem[] => {
    const out: SuggestionItem[] = []
    for (const p of providers) {
      if (!p || !Array.isArray(p.items) || p.items.length === 0) continue
      for (const it of p.items) {
        if (!it || typeof it.id !== 'string' || typeof it.label !== 'string') continue
        const provider = p
        const item = it
        out.push({
          id: `plugin-${p.pluginId}-${p.providerId}-${it.id}`,
          icon: 'sparkles',
          label: it.label,
          sub: it.sub || p.label,
          group: `Плагины · ${p.label}`,
          match: query,
          action: () => {
            getPluginsExt().searchClick?.({ pluginId: provider.pluginId, providerId: provider.providerId, item })
              .catch(() => {})
            handleClose()
          },
        })
      }
    }
    return out
  }, [handleClose])

  // ── Debounced поиск по истории чатов + fuzzy-матч команд ──────────────
  useEffect(() => {
    const q = query.trim()

    if (!q) {
      setItems(defaultSuggestions)
      setHasResults(false)
      setLoading(false)
      return
    }

    // ── Action-items: "Спросить (новый)" + опционально "Спросить (в текущем)"
    const actionItems: SuggestionItem[] = [{
      id: 'ask-new',
      icon: 'sparkles',
      label: `Спросить (новый чат)`,
      sub: `"${truncate(q, 48)}"`,
      group: 'Действия',
      match: q,
      action: () => askAI(q, undefined),
    }]
    if (activeChatId) {
      actionItems.push({
        id: 'ask-current',
        icon: 'reply',
        label: `Спросить в текущем чате`,
        sub: `"${truncate(q, 42)}" · Shift+Enter`,
        group: 'Действия',
        match: q,
        action: () => askAI(q, activeChatId),
      })
    }

    // ── Fuzzy-матч команд по подстроке (рус + англ) ──────────────────────
    const ql = q.toLowerCase()
    const matchedCmds = COMMANDS.filter(cmd =>
      cmd.keys.some(k => k.includes(ql) || ql.includes(k))
    ).map<SuggestionItem>(cmd => ({
      id: `cmd-${cmd.id}`,
      icon: cmd.icon,
      label: cmd.label,
      sub: cmd.sub,
      group: 'Команды',
      match: q,
      action: () => cmd.run(actionCtx),
    }))

    // Мгновенно показываем actions + matched cmds, параллельно запускаем
    // асинхронный поиск по истории с debounce 120ms.
    const instant = [...actionItems, ...matchedCmds]
    setLoading(true)
    setHasResults(false)
    setItems(instant)
    setSelected(0)

    const seq = ++searchSeq.current
    const timer = setTimeout(async () => {
      // Кеш: если недавно уже искали этот query — переиспользуем.
      const cached = searchCache.current.get(q)
      const cachedResults = cached && Date.now() - cached.ts < 30_000 ? cached.results : null

      let pluginItems: SuggestionItem[] = []
      let results: HistoryResult[] = cachedResults ?? []
      try {
        // Параллельно: поиск по истории чатов + search-провайдеры плагинов
        // (минимум 2 символа, как требует API поиска плагинов).
        const [h, pRes] = await Promise.all([
          cachedResults ? Promise.resolve(cachedResults) : window.syntee.chat.searchHistory(q, 12) as Promise<HistoryResult[]>,
          q.length >= 2 && getPluginsExt().search
            ? getPluginsExt().search!({ query: q })
            : Promise.resolve([]),
        ])
        if (seq !== searchSeq.current) return
        results = h ?? []
        pluginItems = buildPluginSearchItems(pRes ?? [], q)
        if (!cachedResults) searchCache.current.set(q, { results: results ?? [], ts: Date.now() })
        finishSearch(seq, q, actionItems, matchedCmds, results ?? [], pluginItems)
      } catch (e) {
        if (seq !== searchSeq.current) return
        console.error('[spotlight search]', e)
        setHasResults(pluginItems.length > 0)
        if (seq === searchSeq.current) {
          // Даже при ошибке истории — показываем результаты плагинов.
          finishSearch(seq, q, actionItems, matchedCmds, [], pluginItems)
        }
      }
    }, 120)

    return () => clearTimeout(timer)
  }, [query, defaultSuggestions, actionCtx, askAI, activeChatId, finishSearch, buildPluginSearchItems])

  // ── Группировка для рендера ──────────────────────────────────────────
  const grouped = useMemo(() => {
    const map = new Map<string, SuggestionItem[]>()
    for (const item of items) {
      if (!map.has(item.group)) map.set(item.group, [])
      map.get(item.group)!.push(item)
    }
    const order = ['Действия', 'Недавние чаты', 'Недавние запросы', 'Команды', ...SOURCE_ORDER.map(s => SOURCE_META[s].group)]
    const seen = new Set<string>()
    const ordered: { group: string; items: SuggestionItem[] }[] = []
    for (const g of order) {
      if (map.has(g) && !seen.has(g)) {
        ordered.push({ group: g, items: map.get(g)! })
        seen.add(g)
      }
    }
    for (const [g, gItems] of map) {
      if (!seen.has(g)) {
        ordered.push({ group: g, items: gItems })
        seen.add(g)
      }
    }
    return ordered
  }, [items])

  const flat = useMemo(() => grouped.flatMap(g => g.items), [grouped])

  // ── Клавиатурная навигация ───────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); handleClose(); return
      }
      // ↑ в пустом инпуте — листаем историю запросов (как в терминале).
      if (e.key === 'ArrowUp' && !query.trim() && history.length > 0) {
        e.preventDefault()
        // Циклически подставляем из history по текущей позиции.
        const curIdx = history.indexOf(query)
        const nextIdx = curIdx === -1 ? 0 : (curIdx + 1) % history.length
        setQuery(history[nextIdx])
        requestAnimationFrame(() => inputRef.current?.select())
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault(); setSelected(s => Math.min(s + 1, flat.length - 1)); return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); return
      }
      // Shift+Enter → "в текущем чате" (ask-current), обычный Enter → top item.
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        const cur = flat.find(it => it.id === 'ask-current')
        if (cur) { cur.action(); return }
        // Нет текущего чата — падаем на обычный top.
        const top = flat[selected]
        if (top) top.action()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = flat[selected] ?? flat[0]
        if (item) item.action()
        return
      }
      if (e.key === 'Tab' && flat[0]) {
        e.preventDefault()
        const top = flat[0]
        if (top.label && top.id.startsWith('recent-')) {
          setQuery(top.label); requestAnimationFrame(() => inputRef.current?.select())
        } else {
          inputRef.current?.focus()
        }
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flat, selected, handleClose, query, history])

  const showEmpty = query.trim() !== '' && !loading && !hasResults && flat.length <= 1

  return (
    <div className="spotlight-root" onMouseDown={e => { if (e.target === e.currentTarget) handleClose() }}>
      <motion.div
        className="spotlight-box"
        initial={{ y: -14, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: -14, opacity: 0, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 420, damping: 30 }}
      >
        {/* Поле ввода */}
        <div className="spotlight-input-row">
          <span className="spotlight-logo"><Logo size={18} /></span>
          <input
            ref={inputRef}
            className="spotlight-input"
            value={query}
            onChange={e => { setQuery(e.target.value); setSelected(0) }}
            placeholder={quickMode ? 'Быстрый вопрос к Syntee…' : 'Спросить или поискать…'}
            spellCheck={false}
            autoComplete="off"
          />
          <AnimatePresence>
            {query && (
              <motion.button
                className="spotlight-clear"
                onClick={() => setQuery('')}
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                whileTap={{ scale: 0.85 }}
                title="Очистить"
                aria-label="Очистить"
              >
                <AppIcon name="x" size="sm" tone="muted" />
              </motion.button>
            )}
          </AnimatePresence>
          {loading && (
            <motion.span
              className="spotlight-spinner"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              aria-hidden
            >
              <AppIcon name="loader" size="sm" tone="muted" animation="spin" />
            </motion.span>
          )}
        </div>

        {/* Результаты / empty */}
        <AnimatePresence initial={false}>
          {flat.length > 0 && !showEmpty && (
            <motion.div
              className="spotlight-results"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              {grouped.map(group => (
                <div className="spotlight-group" key={group.group}>
                  <div className="spotlight-group-title">{group.group}</div>
                  {group.items.map(item => {
                    const idx = flat.indexOf(item)
                    const isActive = idx === selected
                    return (
                      <motion.button
                        key={item.id}
                        className={`spotlight-result-item ${isActive ? 'is-active' : ''}`}
                        onClick={item.action}
                        onMouseEnter={() => setSelected(idx)}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.16, delay: Math.min(idx * 0.02, 0.15) }}
                      >
                        <span className="spotlight-result-icon">
                          <AppIcon name={item.icon} size="md" tone={isActive ? 'accent' : 'muted'} />
                        </span>
                        <div className="spotlight-result-text">
                          <span className="spotlight-result-label">
                            {item.match ? highlightMatch(item.label, item.match) : item.label}
                          </span>
                          {item.sub && <span className="spotlight-result-sub">{item.sub}</span>}
                          {item.preview && (
                            <span className="spotlight-result-preview">
                              {item.match ? highlightMatch(item.preview, item.match) : item.preview}
                            </span>
                          )}
                        </div>
                        <span className="spotlight-result-enter">↵</span>
                      </motion.button>
                    )
                  })}
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showEmpty && (
            <motion.div
              className="spotlight-empty"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18 }}
            >
              <AppIcon name="search" size="md" tone="muted" />
              <span>Ничего не найдено по «{truncate(query.trim(), 40)}»</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Футер с kbd-подсказками */}
        <div className="spotlight-footer">
          <span className="spotlight-hint"><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> навигация</span>
          <span className="spotlight-hint"><kbd className="kbd">↵</kbd> выбрать</span>
          {activeChatId && <span className="spotlight-hint"><kbd className="kbd">⇧</kbd><kbd className="kbd">↵</kbd> в текущем</span>}
          <span className="spotlight-hint"><kbd className="kbd">Tab</kbd> дополнить</span>
          <span className="spotlight-hint"><kbd className="kbd">Esc</kbd> закрыть</span>
        </div>
      </motion.div>
    </div>
  )
}

// ── helpers ───────────────────────────────────────────────────────────
function truncate(s: string, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function buildSub(r: HistoryResult): string {
  const parts: string[] = []
  if (r.chatTitle) parts.push(r.chatTitle)
  if (r.role) parts.push(r.role === 'user' ? 'вы' : r.role === 'assistant' ? 'ИИ' : r.role)
  if (r.date) parts.push(formatDate(r.date))
  return parts.join(' · ')
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return 'вчера'
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })
}

function relativeTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return 'только что'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`
  return formatDate(ts)
}

// Подсветка совпадений query в тексте (case-insensitive, <mark>).
function highlightMatch(text: string, query: string): ReactNode {
  const q = query.trim()
  if (!q) return text
  const ql = q.toLowerCase()
  const tl = text.toLowerCase()
  const idx = tl.indexOf(ql)
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="spotlight-mark">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  )
}
