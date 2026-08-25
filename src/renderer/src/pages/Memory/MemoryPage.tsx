import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import { useVirtualizer } from '@tanstack/react-virtual'
import remarkGfm from 'remark-gfm'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import IconButton from '../../components/ui/IconButton/IconButton'
import MemoryGraphTab from './MemoryGraphTab'
import { useToast } from '../../components/ui/Toast/Toast'
import { whileHoverSm, whileTapSm, whileHoverTiny, whileTapTiny, whileHoverWide, whileTapWide, whileHoverListItem, whileTapListItem, springHover } from '../../utils/motionPresets'
import './MemoryPage.css'

interface MemoryItem {
  id: string
  title: string
  scope: string
  projectId: string | null
  chatId: string | null
  kind: string
  category: string | null
  key: string | null
  content: string
  source: string
  confidence: number
  importance: number
  accessCount: number
  lastAccessedAt: number | null
  pinned: boolean
  createdAt: number
  updatedAt: number
}

interface Filter {
  scope?: string
  kind?: string
  projectId?: string
  category?: string
  search?: string
  limit?: number
  offset?: number
}

type SearchMode = 'list' | 'semantic'

// Module-scope константа — не создаём новый массив remarkPlugins при каждом
// рендере (сбивает мемоизацию ReactMarkdown → ре-парс всех 200 элементов).
const REMARK_PLUGINS = [remarkGfm]

const KIND_COLORS: Record<string, string> = {
  user_fact: '#3b82f6',
  project_decision: '#10b981',
  convention: '#f59e0b',
  conversation: '#8b5cf6',
  agent_outcome: '#ec4899',
}

const KIND_META: Record<string, { label: string; icon: IconName }> = {
  user_fact: { label: 'О пользователе', icon: 'user' },
  project_decision: { label: 'Решения', icon: 'folder' },
  convention: { label: 'Конвенции', icon: 'alertTriangle' },
  conversation: { label: 'Диалоги', icon: 'messageSquare' },
  agent_outcome: { label: 'Уроки', icon: 'wrench' },
}

const SCOPE_META: Record<string, { label: string; icon: IconName }> = {
  global: { label: 'Глобально', icon: 'globe' },
  project: { label: 'Проект', icon: 'folder' },
  chat: { label: 'Чат', icon: 'messageSquare' },
}

const CATEGORY_OPTIONS = [
  { id: 'personal', label: 'Личное', icon: 'user' as IconName },
  { id: 'work', label: 'Работа', icon: 'briefcase' as IconName },
  { id: 'preferences', label: 'Предпочтения', icon: 'sparkles' as IconName },
  { id: 'projects', label: 'Проекты', icon: 'folder' as IconName },
  { id: 'facts', label: 'Факты', icon: 'pin' as IconName },
]

const KIND_OPTIONS = [
  { id: 'user_fact', label: 'О пользователе', icon: 'user' as IconName },
  { id: 'project_decision', label: 'Решения', icon: 'folder' as IconName },
  { id: 'convention', label: 'Конвенции', icon: 'alertTriangle' as IconName },
  { id: 'conversation', label: 'Диалоги', icon: 'messageSquare' as IconName },
  { id: 'agent_outcome', label: 'Уроки', icon: 'wrench' as IconName },
]

const SCOPE_OPTIONS = [
  { id: 'global', label: 'Глобально', icon: 'globe' as IconName },
  { id: 'project', label: 'Проект', icon: 'folder' as IconName },
]

function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const day = 24 * 60 * 60 * 1000
  if (diff < day) return 'сегодня'
  if (diff < 2 * day) return 'вчера'
  if (diff < 7 * day) return `${Math.floor(diff / day)} дн назад`
  return new Date(ts).toLocaleDateString('ru')
}

function importanceTone(imp: number): 'muted' | 'default' | 'accent' | 'warning' {
  if (imp >= 0.8) return 'warning'
  if (imp >= 0.6) return 'accent'
  if (imp >= 0.3) return 'default'
  return 'muted'
}

export default function MemoryPage() {
  const addToast = useToast(s => s.add)
  const [items, setItems] = useState<MemoryItem[]>([])
  const [stats, setStats] = useState<{ total: number; byScope: Record<string, number>; byKind: Record<string, number> } | null>(null)
  const [categories, setCategories] = useState<Array<{ id: string; name: string; label: string; icon: string | null; scope: string }>>([])
  const [searchMode, setSearchMode] = useState<SearchMode>('list')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [filterScope, setFilterScope] = useState<string>('')
  const [filterKind, setFilterKind] = useState<string>('')
  const [filterCategory, setFilterCategory] = useState<string>('')
  const [adding, setAdding] = useState(false)
  const [addingCategory, setAddingCategory] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newKey, setNewKey] = useState('')
  const [newKind, setNewKind] = useState<string>('user_fact')
  const [newScope, setNewScope] = useState<string>('global')
  const [newCategory, setNewCategory] = useState<string>('facts')
  const [newImportance, setNewImportance] = useState<number>(0.5)
  const [newCatName, setNewCatName] = useState('')
  const [newCatLabel, setNewCatLabel] = useState('')
  const [activeTab, setActiveTab] = useState<'list' | 'graph'>('list')
  const [projects, setProjects] = useState<Array<{ id: string; name: string; workdir: string }>>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())
  const [showOverflow, setShowOverflow] = useState(false)
  const [showFilterPopover, setShowFilterPopover] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingRef = useRef(false)

  // Виртуализация списка — рендерим только видимые элементы
  const listRef = useRef<HTMLDivElement>(null)

  // Pinned наверх, потом остальные по updatedAt
  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  }, [items])

  const virtualizer = useVirtualizer({
    count: sortedItems.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 86,
    overscan: 5,
  })

  const PAGE_SIZE = 200

  // Сброс и загрузка первой страницы
  const load = useCallback(async () => {
    if (searchMode === 'semantic' && search.trim()) {
      const results = await (window.syntee as any).memory?.search({
        query: search,
        scope: filterScope || 'all',
        kind: filterKind || undefined,
        limit: 50,
      }) || []
      setItems(results)
      setHasMore(false)
    } else {
      const filter: Filter = { limit: PAGE_SIZE, offset: 0 }
      if (filterScope) filter.scope = filterScope
      if (filterKind) filter.kind = filterKind
      if (filterCategory) filter.category = filterCategory
      if (search) filter.search = search
      const all = await (window.syntee as any).memory?.getAll(filter) || []
      setItems(all)
      setHasMore(all.length >= PAGE_SIZE)
    }
  }, [searchMode, search, filterScope, filterKind, filterCategory])

  // Подгрузка следующей страницы (infinite scroll)
  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMore) return
    if (searchMode === 'semantic') return
    loadingRef.current = true
    setLoadingMore(true)
    try {
      const filter: Filter = { limit: PAGE_SIZE, offset: items.length }
      if (filterScope) filter.scope = filterScope
      if (filterKind) filter.kind = filterKind
      if (filterCategory) filter.category = filterCategory
      if (search) filter.search = search
      const more = await (window.syntee as any).memory?.getAll(filter) || []
      if (more.length > 0) {
        setItems(prev => [...prev, ...more])
      }
      setHasMore(more.length >= PAGE_SIZE)
    } finally {
      loadingRef.current = false
      setLoadingMore(false)
    }
  }, [hasMore, searchMode, items.length, filterScope, filterKind, filterCategory, search])

  // Auto-load when scrolling near the bottom
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      if (scrollHeight - scrollTop - clientHeight < 300) {
        loadMore()
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [loadMore])

  // Stats/categories меняются редко — только при add/delete/prune.
  const loadStats = useCallback(async () => {
    try {
      const s = await (window.syntee as any).memory?.stats()
      setStats(s)
    } catch { /* ok */ }
    try {
      const cats = await (window.syntee as any).memory?.getCategories()
      setCategories(cats || [])
    } catch { /* ok */ }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadStats() }, [loadStats])

  // Загружаем список проектов для tab'а графа
  useEffect(() => {
    ;(async () => {
      try {
        const all = await (window.syntee as any).projects?.getAll() || []
        setProjects(all.map((p: any) => ({ id: p.id, name: p.name, workdir: p.workdir })))
      } catch { /* ok */ }
    })()
  }, [])

  // Авто-сброс inline-подтверждения удаления
  useEffect(() => {
    if (!confirmDeleteId) return
    const t = setTimeout(() => setConfirmDeleteId(null), 3000)
    return () => clearTimeout(t)
  }, [confirmDeleteId])

  const handleDelete = async (id: string) => {
    await (window.syntee as any).memory?.delete(id)
    setItems(prev => prev.filter(m => m.id !== id))
    setConfirmDeleteId(null)
    loadStats()
    addToast('Запись удалена', 'success')
  }

  const handlePin = async (id: string, pinned: boolean) => {
    await (window.syntee as any).memory?.pin(id, pinned)
    setItems(prev => prev.map(m => m.id === id ? { ...m, pinned } : m))
  }

  const handleAdd = async () => {
    if (!newTitle.trim() || !newContent.trim()) return
    await (window.syntee as any).memory?.save({
      title: newTitle.trim(),
      content: newContent.trim(),
      kind: newKind,
      scope: newScope,
      key: newKey.trim() || undefined,
      category: newKind === 'user_fact' ? newCategory : undefined,
      importance: newImportance,
    })
    setNewTitle('')
    setNewContent('')
    setNewKey('')
    setAdding(false)
    load()
    loadStats()
    addToast('Запись добавлена', 'success')
  }

  const handleSearch = () => { setSearch(searchInput) }

  const handlePrune = async () => {
    setShowOverflow(false)
    const count = await (window.syntee as any).memory?.prune()
    if (count > 0) {
      load()
      loadStats()
      addToast(`Удалено ${count} устаревших записей`, 'success')
    } else {
      addToast('Нет записей для удаления', 'info')
    }
  }

  const handleExtractOutcomes = async () => {
    setShowOverflow(false)
    const result = await (window.syntee as any).memory?.extractOutcomes()
    if (result?.extracted) {
      addToast(`Извлечено ${result.extracted} уроков`, 'success')
    } else {
      addToast('Уроков не найдено', 'info')
    }
    load()
    loadStats()
  }

  const handleReindex = async () => {
    setShowOverflow(false)
    const count = await (window.syntee as any).memory?.reindex()
    addToast(`Переиндексировано ${count} записей`, 'success')
  }

  const handleDeleteCategory = async (id: string) => {
    await (window.syntee as any).memory?.deleteCategory(id)
    load()
    loadStats()
  }

  const hasSecondaryFilters = filterScope !== '' || filterCategory !== ''
  const hasAnyFilter = filterKind !== '' || filterScope !== '' || filterCategory !== '' || search !== ''

  const resetAllFilters = () => {
    setFilterKind('')
    setFilterScope('')
    setFilterCategory('')
    setSearch('')
    setSearchInput('')
  }

  const shownCount = items.length
  const totalCount = stats?.total ?? items.length

  return (
    <div className="memory-page">
      {/* Заголовок */}
      <div className="memory-header">
        <div className="memory-title">
          <AppIcon name="brain" size="lg" tone="accent" />
          <h2>Память</h2>
          <span className="memory-count">{totalCount}</span>
        </div>
        <div className="memory-header-actions">
          {activeTab === 'list' && (
            <>
              {/* Overflow-меню сервисных действий */}
              <div className="memory-overflow-wrap">
                <motion.button
                  className={`memory-overflow-btn ${showOverflow ? 'memory-overflow-btn--active' : ''}`}
                  onClick={() => setShowOverflow(p => !p)}
                  title="Действия"
                  whileHover={whileHoverSm}
                  whileTap={whileTapSm}
                  transition={springHover}
                >
                  <AppIcon name="moreHorizontal" size="sm" />
                </motion.button>
                <AnimatePresence>
                  {showOverflow && (
                    <OverflowMenu
                      onClose={() => setShowOverflow(false)}
                      onExtract={handleExtractOutcomes}
                      onPrune={handlePrune}
                      onReindex={handleReindex}
                    />
                  )}
                </AnimatePresence>
              </div>
              <motion.button className="memory-add-btn memory-add-btn--primary" onClick={() => setAdding(p => !p)} whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
                <AppIcon name="plus" size="sm" /> Добавить
              </motion.button>
            </>
          )}
        </div>
      </div>

      {/* Табы: Записи | Граф — segmented control со скользящим pill */}
      <div className="memory-tabs" role="tablist" aria-label="Разделы памяти">
        {(['list', 'graph'] as const).map(t => (
          <motion.button
            key={t}
            role="tab"
            aria-selected={activeTab === t}
            className={`memory-tab ${activeTab === t ? 'memory-tab--active' : ''}`}
            onClick={() => setActiveTab(t)}
            whileHover={whileHoverListItem}
            whileTap={whileTapListItem}
            transition={springHover}
          >
            {activeTab === t && (
              <motion.span
                layoutId="memory-tab-active"
                className="memory-tab-active-pill"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            )}
            <AppIcon name={t === 'list' ? 'listChecks' : 'gitBranch'} size="sm" />
            <span className="memory-tab-label">{t === 'list' ? 'Записи' : 'Граф знаний'}</span>
          </motion.button>
        ))}
      </div>

      {/* Форма добавления */}
      {activeTab === 'list' && (
      <>
      <AnimatePresence>
        {adding && (
          <motion.div
            className="memory-add-form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <div className="memory-form-row">
              <select className="memory-select" value={newKind} onChange={e => setNewKind(e.target.value)}>
                {KIND_OPTIONS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
              <select className="memory-select" value={newScope} onChange={e => setNewScope(e.target.value)}>
                {SCOPE_OPTIONS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              {newKind === 'user_fact' && (
                <select className="memory-select" value={newCategory} onChange={e => setNewCategory(e.target.value)}>
                  {CATEGORY_OPTIONS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              )}
            </div>
            <input
              className="memory-input"
              placeholder="Название (обязательно, напр. «Архитектура авторизации»)"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
            />
            <input
              className="memory-input"
              placeholder="Ключ (опционально, для дедупликации, напр. preferred_stack)"
              value={newKey}
              onChange={e => setNewKey(e.target.value)}
            />
            <textarea
              className="memory-input memory-textarea"
              placeholder="Подробное описание. Markdown поддерживается. Напр. «Решили использовать JWT.&#10;- Access token: 15мин&#10;- Refresh: 7дней»"
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              rows={4}
            />
            <div className="memory-form-row memory-importance-row">
              <label className="memory-label">Важность: {newImportance.toFixed(1)}</label>
              <input
                type="range" min="0" max="1" step="0.1"
                value={newImportance}
                onChange={e => setNewImportance(Number(e.target.value))}
                className="memory-graph-range memory-range-form"
              />
            </div>
            <div className="memory-form-actions">
              <motion.button className="memory-save-btn" onClick={handleAdd} whileHover={whileHoverWide} whileTap={whileTapWide} transition={springHover}>Сохранить</motion.button>
              <motion.button className="memory-cancel-btn" onClick={() => setAdding(false)} whileHover={whileHoverWide} whileTap={whileTapWide} transition={springHover}>Отмена</motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Компактный тулбар — один ряд */}
      <div className="memory-toolbar-primary">
        {/* Kind-фильтры с цветными точками */}
        <div className="memory-filter-chips">
          <motion.button
            className={`memory-cat-btn ${filterKind === '' ? 'memory-cat-btn--active' : ''}`}
            onClick={() => setFilterKind('')}
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            <AppIcon name="brain" size="sm" tone={filterKind === '' ? 'accent' : 'muted'} />
            Все {stats ? `(${stats.total})` : ''}
          </motion.button>
          {KIND_OPTIONS.map(k => {
            const color = KIND_COLORS[k.id]
            const active = filterKind === k.id
            return (
              <motion.button
                key={k.id}
                className={`memory-cat-btn ${active ? 'memory-cat-btn--active' : ''}`}
                style={active ? { borderColor: color, background: `${color}22` } : {}}
                onClick={() => setFilterKind(active ? '' : k.id)}
                whileHover={whileHoverSm}
                whileTap={whileTapSm}
                transition={springHover}
              >
                <span className="memory-kind-dot" style={{ background: color }} />
                {k.label} {stats?.byKind?.[k.id] ? `(${stats.byKind[k.id]})` : ''}
              </motion.button>
            )
          })}
        </div>

        {/* Поповер «Фильтры» (scope + категории) */}
        <div className="memory-filter-popover-wrap">
          <motion.button
            className={`memory-cat-btn memory-filter-popover-btn ${hasSecondaryFilters ? 'memory-cat-btn--active' : ''}`}
            onClick={() => setShowFilterPopover(p => !p)}
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            <AppIcon name="filter" size="sm" tone={hasSecondaryFilters ? 'accent' : 'muted'} />
            Фильтры
            {hasSecondaryFilters && <span className="memory-filter-badge" />}
          </motion.button>
          <AnimatePresence>
            {showFilterPopover && (
              <FilterPopover
                filterScope={filterScope}
                setFilterScope={setFilterScope}
                filterCategory={filterCategory}
                setFilterCategory={setFilterCategory}
                categories={categories}
                addingCategory={addingCategory}
                setAddingCategory={setAddingCategory}
                newCatName={newCatName}
                setNewCatName={setNewCatName}
                newCatLabel={newCatLabel}
                setNewCatLabel={setNewCatLabel}
                newScope={newScope}
                setNewScope={setNewScope}
                onCreateCategory={async () => {
                  if (!newCatName.trim() || !newCatLabel.trim()) return
                  await (window.syntee as any).memory?.createCategory({
                    name: newCatName.trim(),
                    label: newCatLabel.trim(),
                    scope: newScope,
                  })
                  setNewCatName('')
                  setNewCatLabel('')
                  setAddingCategory(false)
                  loadStats()
                }}
                onDeleteCategory={handleDeleteCategory}
                onClose={() => setShowFilterPopover(false)}
              />
            )}
          </AnimatePresence>
        </div>

        {/* Сбросить всё */}
        {hasAnyFilter && (
          <motion.button
            className="memory-reset-btn"
            onClick={resetAllFilters}
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            <AppIcon name="x" size="xs" tone="muted" />
            Сбросить
          </motion.button>
        )}

        {/* Счётчик результатов */}
        <span className="memory-result-count">
          {shownCount === totalCount ? `${shownCount}` : `${shownCount} из ${totalCount}`}
        </span>

        {/* Поиск с × */}
        <div className="memory-search-wrap">
          <AppIcon name="search" size="sm" tone="muted" />
          <input
            className="memory-search"
            placeholder={searchMode === 'semantic' ? 'Поиск по смыслу...' : 'Поиск...'}
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
          {searchInput && (
            <button className="memory-search-clear" onClick={() => { setSearchInput(''); setSearch('') }} title="Очистить">
              <AppIcon name="x" size="xs" tone="muted" />
            </button>
          )}
        </div>

        {/* Режим поиска */}
        <div className="memory-mode-toggle" role="tablist" aria-label="Режим поиска">
          {(['list', 'semantic'] as const).map(m => (
            <motion.button
              key={m}
              role="tab"
              aria-selected={searchMode === m}
              className={`memory-mode-btn ${searchMode === m ? 'memory-mode-btn--active' : ''}`}
              onClick={() => setSearchMode(m)}
              whileHover={whileHoverListItem}
              whileTap={whileTapListItem}
              transition={springHover}
            >
              {searchMode === m && (
                <motion.span
                  layoutId="memory-mode-active"
                  className="memory-mode-active-pill"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className="memory-mode-label">{m === 'list' ? 'Список' : 'Семантика'}</span>
            </motion.button>
          ))}
        </div>
      </div>

      {/* Список — виртуализированный */}
      <div className="memory-list" ref={listRef}>
        {sortedItems.length === 0 ? (
          <div className="memory-empty">
            <AppIcon name="brain" size="xl" tone="muted" />
            <p>
              {hasAnyFilter
                ? 'Ничего не найдено по фильтрам.'
                : searchMode === 'semantic' && search
                  ? 'Ничего не найдено по смыслу. Попробуйте переформулировать.'
                  : 'Память пуста. Syntee запоминает факты автоматически, или добавьте вручную.'}
            </p>
            {hasAnyFilter && (
              <motion.button
                className="memory-empty-reset"
                onClick={resetAllFilters}
                whileHover={whileHoverSm}
                whileTap={whileTapSm}
                transition={springHover}
              >
                <AppIcon name="rewind" size="sm" /> Сбросить фильтры
              </motion.button>
            )}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(virtualItem => {
              const m = sortedItems[virtualItem.index]
              const kindMeta = KIND_META[m.kind] ?? { label: m.kind, icon: 'pin' as IconName }
              const scopeMeta = SCOPE_META[m.scope] ?? { label: m.scope, icon: 'database' as IconName }
              const isExpanded = expandedItems.has(m.id)
              const color = KIND_COLORS[m.kind] ?? '#6b7280'
              const isConfirming = confirmDeleteId === m.id
              return (
                <div
                  key={m.id}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                    paddingBottom: '6px',
                  }}
                >
                  <div
                    className={`memory-item ${m.pinned ? 'memory-item--pinned' : ''}`}
                    style={{ '--kind-color': color } as CSSProperties}
                  >
                    {/* Цветная полоска слева */}
                    <div className="memory-item-stripe" style={{ background: color }} />
                    <div className="memory-item-cat" style={{ borderColor: color, background: `${color}1a` }}>
                      <AppIcon name={kindMeta.icon} size="md" />
                    </div>
                    <div className="memory-item-content">
                      {/* Минимум тегов: только category и key */}
                      {(m.category || m.key) && (
                        <div className="memory-item-tags">
                          {m.category && (
                            <span className="memory-tag memory-tag--category">{m.category}</span>
                          )}
                          {m.key && (
                            <span className="memory-tag memory-tag--key">key: {m.key}</span>
                          )}
                        </div>
                      )}
                      <div className="memory-item-title">{m.title || m.content.slice(0, 80)}</div>
                      {m.content && m.content !== m.title && (
                        <>
                          <div className={`memory-item-content-body ${isExpanded ? 'memory-item-content-body--expanded' : ''}`}>
                            {isExpanded
                              ? <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{m.content}</ReactMarkdown>
                              : <span>{m.content.slice(0, 120)}{m.content.length > 120 ? '…' : ''}</span>
                            }
                          </div>
                          {m.content.length > 120 && (
                            <motion.button
                              className="memory-item-expand"
                              onClick={() => setExpandedItems(prev => {
                                const next = new Set(prev)
                                if (next.has(m.id)) next.delete(m.id)
                                else next.add(m.id)
                                return next
                              })}
                              whileHover={whileHoverSm}
                              whileTap={whileTapSm}
                              transition={springHover}
                            >
                              <AppIcon name={isExpanded ? 'chevronUp' : 'chevronDown'} size="xs" tone="muted" />
                              {isExpanded ? 'Свернуть' : 'Развернуть'}
                            </motion.button>
                          )}
                        </>
                      )}
                      <div className="memory-item-footer">
                        <span className="memory-meta-text">
                          <AppIcon name="clock" size="xs" tone="muted" />
                          {fmtTime(m.updatedAt)}
                        </span>
                        <span className="memory-meta-text">
                          <AppIcon name={scopeMeta.icon} size="xs" tone="muted" />
                          {scopeMeta.label}
                        </span>
                        {m.accessCount > 0 && (
                          <span className="memory-meta-text">
                            <AppIcon name="eye" size="xs" tone="muted" />
                            {m.accessCount}
                          </span>
                        )}
                        <span className="memory-meta-text">
                          <AppIcon name="database" size="xs" tone="muted" />
                          {m.source}
                        </span>
                      </div>
                    </div>
                    <div className="memory-item-meta">
                      <div className="memory-importance-badge" title={`Важность: ${Math.round(m.importance * 100)}%`}>
                        <AppIcon name="star" size="xs" tone={importanceTone(m.importance)} />
                      </div>
                      <motion.button
                        className={`memory-pin-btn ${m.pinned ? 'memory-pin-btn--active' : ''}`}
                        onClick={() => handlePin(m.id, !m.pinned)}
                        title={m.pinned ? 'Открепить' : 'Закрепить (защита от авто-удаления)'}
                        whileHover={whileHoverTiny}
                        whileTap={whileTapTiny}
                        transition={springHover}
                      >
                        <AppIcon name="pin" size="sm" tone={m.pinned ? 'warning' : 'muted'} />
                      </motion.button>
                      {isConfirming ? (
                        <motion.button
                          className="memory-delete-confirm"
                          onClick={() => handleDelete(m.id)}
                          initial={{ scale: 0.8 }}
                          animate={{ scale: 1 }}
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.92 }}
                        >
                          <AppIcon name="trash" size="xs" tone="danger" />
                          Удалить?
                        </motion.button>
                      ) : (
                        <IconButton
                          icon="trash"
                          label="Удалить"
                          danger
                          onClick={() => setConfirmDeleteId(m.id)}
                        />
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {loadingMore && (
              <div className="memory-load-more">
                <AppIcon name="refreshCw" size="sm" tone="muted" animation="spin" />
                <span>Загрузка…</span>
              </div>
            )}
          </div>
        )}
      </div>
      </>
      )}

      {/* Граф знаний */}
      {activeTab === 'graph' && (
        <div className="memory-graph-container">
          <MemoryGraphTab
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            projects={projects}
          />
        </div>
      )}
    </div>
  )
}

// ─── Overflow-меню сервисных действий ─────────────────────────────────────────

interface OverflowMenuProps {
  onClose: () => void
  onExtract: () => void
  onPrune: () => void
  onReindex: () => void
}

function OverflowMenu({ onClose, onExtract, onPrune, onReindex }: OverflowMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let handler: ((e: MouseEvent) => void) | null = null
    const id = setTimeout(() => {
      handler = (e: MouseEvent) => {
        if (ref.current && !ref.current.contains(e.target as Node)) onClose()
      }
      document.addEventListener('mousedown', handler)
    }, 0)
    return () => {
      clearTimeout(id)
      if (handler) document.removeEventListener('mousedown', handler)
    }
  }, [onClose])

  return (
    <motion.div
      ref={ref}
      className="chat-ctx-menu memory-overflow-menu"
      initial={{ opacity: 0, scale: 0.95, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: -4 }}
      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
    >
      <CtxItem icon="wrench" label="Извлечь уроки" desc="Из логов агента" onClick={onExtract} />
      <CtxItem icon="trash" label="Чистка" desc="Удалить устаревшие" onClick={onPrune} />
      <div className="ctx-divider" />
      <CtxItem icon="refreshCw" label="Реиндекс" desc="Переиндексировать embeddings" onClick={onReindex} />
    </motion.div>
  )
}

function CtxItem({ icon, label, desc, onClick }: { icon: string; label: string; desc?: string; onClick: () => void }) {
  return (
    <motion.button
      className="ctx-item memory-ctx-item"
      onClick={onClick}
      whileHover={whileHoverListItem}
      whileTap={whileTapListItem}
      transition={springHover}
    >
      <AppIcon name={icon as 'eye'} size="sm" />
      <span className="memory-ctx-text">
        <span className="memory-ctx-label">{label}</span>
        {desc && <span className="memory-ctx-desc">{desc}</span>}
      </span>
    </motion.button>
  )
}

// ─── Поповер фильтров (scope + категории) ─────────────────────────────────────

interface FilterPopoverProps {
  filterScope: string
  setFilterScope: (v: string) => void
  filterCategory: string
  setFilterCategory: (v: string) => void
  categories: Array<{ id: string; name: string; label: string; icon: string | null; scope: string }>
  addingCategory: boolean
  setAddingCategory: (v: boolean) => void
  newCatName: string
  setNewCatName: (v: string) => void
  newCatLabel: string
  setNewCatLabel: (v: string) => void
  newScope: string
  setNewScope: (v: string) => void
  onCreateCategory: () => void
  onDeleteCategory: (id: string) => void
  onClose: () => void
}

function FilterPopover(props: FilterPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { onClose } = props

  useEffect(() => {
    let handler: ((e: MouseEvent) => void) | null = null
    const id = setTimeout(() => {
      handler = (e: MouseEvent) => {
        if (ref.current && !ref.current.contains(e.target as Node)) onClose()
      }
      document.addEventListener('mousedown', handler)
    }, 0)
    return () => {
      clearTimeout(id)
      if (handler) document.removeEventListener('mousedown', handler)
    }
  }, [onClose])

  return (
    <motion.div
      ref={ref}
      className="memory-filter-popover"
      initial={{ opacity: 0, scale: 0.95, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: -4 }}
      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
    >
      <div className="memory-popover-section">
        <div className="memory-popover-title">Область</div>
        <div className="memory-popover-chips">
          <motion.button
            className={`memory-cat-btn ${props.filterScope === '' ? 'memory-cat-btn--active' : ''}`}
            onClick={() => props.setFilterScope('')}
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            <AppIcon name="layers" size="sm" tone={props.filterScope === '' ? 'accent' : 'muted'} />
            Все
          </motion.button>
          {SCOPE_OPTIONS.map(s => (
            <motion.button
              key={s.id}
              className={`memory-cat-btn ${props.filterScope === s.id ? 'memory-cat-btn--active' : ''}`}
              onClick={() => props.setFilterScope(props.filterScope === s.id ? '' : s.id)}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <AppIcon name={s.icon} size="sm" tone={props.filterScope === s.id ? 'accent' : 'muted'} />
              {s.label}
            </motion.button>
          ))}
        </div>
      </div>

      <div className="memory-popover-section">
        <div className="memory-popover-title">Категории</div>
        <div className="memory-popover-chips">
          <motion.button
            className={`memory-cat-btn ${props.filterCategory === '' ? 'memory-cat-btn--active' : ''}`}
            onClick={() => props.setFilterCategory('')}
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            <AppIcon name="filter" size="sm" tone={props.filterCategory === '' ? 'accent' : 'muted'} />
            Все
          </motion.button>
          {props.categories.map(c => (
            <motion.button
              key={c.id}
              className={`memory-cat-btn ${props.filterCategory === c.name ? 'memory-cat-btn--active' : ''}`}
              onClick={() => props.setFilterCategory(props.filterCategory === c.name ? '' : c.name)}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <AppIcon name={(c.icon as IconName) || 'pin'} size="sm" tone={props.filterCategory === c.name ? 'accent' : 'muted'} />
              {c.label}
              {!c.id.startsWith('builtin-') && (
                <span
                  className="memory-cat-delete"
                  onClick={(e) => { e.stopPropagation(); props.onDeleteCategory(c.id) }}
                  title="Удалить категорию"
                >×</span>
              )}
            </motion.button>
          ))}
          <motion.button
            className="memory-cat-btn memory-cat-btn--add"
            onClick={() => props.setAddingCategory(!props.addingCategory)}
            title="Создать категорию"
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            <AppIcon name="plus" size="sm" tone="muted" />
          </motion.button>
        </div>
      </div>

      <AnimatePresence>
        {props.addingCategory && (
          <motion.div
            className="memory-popover-cat-form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <div className="memory-form-row">
              <input
                className="memory-input"
                placeholder="Имя (машинное, напр. bugs)"
                value={props.newCatName}
                onChange={e => props.setNewCatName(e.target.value)}
              />
              <input
                className="memory-input"
                placeholder="Метка (напр. Баги)"
                value={props.newCatLabel}
                onChange={e => props.setNewCatLabel(e.target.value)}
              />
            </div>
            <div className="memory-form-actions">
              <motion.button
                className="memory-save-btn"
                onClick={props.onCreateCategory}
                whileHover={whileHoverWide}
                whileTap={whileTapWide}
                transition={springHover}
              >Создать</motion.button>
              <motion.button
                className="memory-cancel-btn"
                onClick={() => props.setAddingCategory(false)}
                whileHover={whileHoverWide}
                whileTap={whileTapWide}
                transition={springHover}
              >Отмена</motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
