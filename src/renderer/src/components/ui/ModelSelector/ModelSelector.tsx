import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ModelMeta, ModelAssignment, Provider, ModelCapability } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import BrandAvatar from '../BrandAvatar/BrandAvatar'
import ModelFilterBar from '../ModelFilterBar/ModelFilterBar'
import { CAP_LABELS, SPEED_LABEL, SPEED_COLOR, formatCtx, getProviderColor, getBrandLogo } from '../../../utils/modelFormat'
import { filterModels, isModelFree, tooltipPrice, CAP_ICONS, type PriceFilter } from '../../../utils/modelFilters'
import { useGatewayModelsStore, normalizeStatus, GATEWAY_PROVIDER_ID } from '../../../store/gatewayModels.store'
import { useRecentModelsStore, resolveRecentModels, resolvePinnedModels } from '../../../store/recentModels.store'
import { useAuthStore } from '../../../store/auth.store'
import MiniUptimeBar from '../MiniUptimeBar/MiniUptimeBar'
import { whileHoverSm, whileTapSm, springHover, whileHoverTiny, whileTapTiny } from '../../../utils/motionPresets'
import './ModelSelector.css'

interface ModelSelectorProps {
  /** Текущий modelId (per-chat модель чата; подсветка активного пункта). */
  modelId: string
  /** Провайдер текущей модели. Если передан — бейдж и подсветка используют
   *  пару (modelId, providerId) вместо глобального main-назначения
   *  (per-chat модель может отличаться от глобальной). */
  providerId?: string
  /** Колбэк при выборе модели — меняет модель (чата). */
  onChange: (modelId: string, providerId: string) => void
}

const DROP_H = 420

export default function ModelSelector({ modelId, providerId, onChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Фильтры: capabilities (AND-логика) + цена. Панель сворачивается
  // кнопкой-воронкой в строке поиска. Состояние живёт между открытиями
  // дропдауна (компонент не размонтируется) — точка на воронке сигналит.
  const [activeCaps, setActiveCaps] = useState<ModelCapability[]>([])
  const [priceFilter, setPriceFilter] = useState<PriceFilter>('any')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersActive = activeCaps.length > 0 || priceFilter !== 'any'
  const [models, setModels] = useState<ModelMeta[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [assignment, setAssignment] = useState<ModelAssignment | null>(null)
  const [loading, setLoading] = useState(true)
  const [dropPos, setDropPos] = useState<{ top?: number; bottom?: number; left: number; width: number; openUp: boolean; maxH: number } | null>(null)
  const [hovered, setHovered] = useState<ModelMeta | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Закреплённые/недавние — только без поиска и без активных фильтров
  // (иначе секции показывали бы неотфильтрованные модели).
  const showSections = !query.trim() && !filtersActive

  // Секции над виртуализированным списком (закреплённые, недавние,
  // gateway-скелетон/ошибка) живут в ЕДИНОМ скролл-контейнере со списком.
  // Их высота уходит в scrollMargin виртуализатора — поэтому меряем её
  // callback-ref'ом + ResizeObserver (чипсы переносятся на новые ряды).
  const [sectionsH, setSectionsH] = useState(0)
  const sectionsRORef = useRef<ResizeObserver | null>(null)
  const sectionsRef = useCallback((el: HTMLDivElement | null) => {
    sectionsRORef.current?.disconnect()
    sectionsRORef.current = null
    if (!el) { setSectionsH(0); return }
    setSectionsH(el.offsetHeight)
    const ro = new ResizeObserver(() => setSectionsH(el.offsetHeight))
    ro.observe(el)
    sectionsRORef.current = ro
  }, [])

  // Загружаем модели + провайдеров + main-назначение при открытии
  // (также один раз на маунте для бейджа). Провайдеры нужны для аватаров —
  // getBrandLogo() смотрит на provider.type, а не на providerId.
  const lastLoadedAtRef = useRef(0)
  const loadData = async () => {
    try {
      setLoading(true)
      const [all, assigns, provs] = await Promise.all([
        window.syntee.models.getAll() as Promise<ModelMeta[]>,
        window.syntee.models.getAssignments() as Promise<ModelAssignment[]>,
        window.syntee.providers.getAll() as Promise<Provider[]>,
      ])
      setModels(all)
      setProviders(provs)
      const main = assigns.find(a => a.role === 'main') ?? null
      setAssignment(main)
      lastLoadedAtRef.current = Date.now()
    } catch (e) {
      console.error('[ModelSelector] load error', e)
    } finally {
      setLoading(false)
    }
  }

  // Map по providerId для быстрого доступа к provider.type при рендере пунктов.
  const providerMap = useRef<Map<string, Provider>>(new Map())
  providerMap.current = new Map(providers.map(p => [p.id, p]))

  // Статусы и uptime buckets моделей gateway.
  const statusByModel = useGatewayModelsStore(s => s.statusByModel)
  const modelStatusBuckets = useGatewayModelsStore(s => s.modelStatusBuckets)
  const gatewayModelsRaw = useGatewayModelsStore(s => s.models)
  const gatewayLoading = useGatewayModelsStore(s => s.loading)
  const gatewayError = useGatewayModelsStore(s => s.error)
  const gatewayLastFetch = useGatewayModelsStore(s => s.lastFetchAt)
  const gatewayLoad = useGatewayModelsStore(s => s.load)
  const authUser = useAuthStore(s => s.user)

  // Skeleton показываем только пока фетч реально идёт или ещё не запускался.
  // Раньше условие зависело лишь от models.length === 0, из-за чего спиннер
  // висел вечно при пустом/упавшем фетче (модели при этом могли быть видны из
  // протухшего кэша main-процесса). lastFetchAt === 0 → ещё не грузили,
  // gatewayLoading → грузим прямо сейчас.
  const showGatewaySkeleton = !!authUser
    && gatewayModelsRaw.length === 0
    && (gatewayLoading || gatewayLastFetch === 0)
  // Фетч завершился (успех или провал), но моделей нет — показываем состояние
  // ошибки/пустоты вместо вечного спиннера.
  const showGatewayError = !!authUser
    && gatewayModelsRaw.length === 0
    && !gatewayLoading
    && gatewayLastFetch > 0

  // Множество ID моделей-групп (type === 'group') — для сортировки выше обычных.
  const groupModelIds = useMemo(() => {
    const s = new Set<string>()
    for (const m of gatewayModelsRaw) {
      if (m.type === 'group' && m.id) s.add(m.id)
    }
    return s
  }, [gatewayModelsRaw])

  const bucketsByModel = useMemo(() => {
    const m: Record<string, import('../../../store/gatewayModels.store').UptimeBucket[]> = {}
    for (const b of modelStatusBuckets) m[b.model] = b.buckets
    return m
  }, [modelStatusBuckets])

  // Недавно использованные модели
  const recentModels = useRecentModelsStore(s => s.recent)
  const pinnedModels = useRecentModelsStore(s => s.pinned)
  const loadRecent = useRecentModelsStore(s => s.load)
  const addRecent = useRecentModelsStore(s => s.addRecent)
  const togglePin = useRecentModelsStore(s => s.togglePin)
  const resolvedRecent = useMemo(
    () => resolveRecentModels(recentModels, models, providers),
    [recentModels, models, providers],
  )
  const resolvedPinned = useMemo(
    () => resolvePinnedModels(pinnedModels, models, providers),
    [pinnedModels, models, providers],
  )

  // Context menu для правого клика (закрепить/открепить)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; model: ModelMeta } | null>(null)

  useEffect(() => {
    loadData()
    loadRecent()
  }, [])

  // Не гоняем IPC round-trip на каждое открытие — список моделей/провайдеров
  // меняется редко. Перегружаем только если данные старше 5с (защита от
  // staleness, если пользователь поменял провайдеров в этой же сессии).
  useEffect(() => {
    if (open) {
      if (Date.now() - lastLoadedAtRef.current > 5000) loadData()
      loadRecent()
      setTimeout(() => inputRef.current?.focus(), 50)
      // Авто-retry моделей gateway: если предыдущий фетч неуспешен/пуст и протух
      // (или вовсе не запускался) — перетягиваем без спиннера. Самовосстановление
      // без перелогина. При наличии ошибки порог снижен до 30с (vs 5мин в норме),
      // чтобы селектор быстрее подхватил модели после кратковременного сбоя gateway.
      if (authUser && gatewayModelsRaw.length === 0) {
        const staleThreshold = gatewayError ? 30_000 : 300_000
        if (gatewayLastFetch === 0 || Date.now() - gatewayLastFetch > staleThreshold) {
          gatewayLoad(true)
        }
      }
    } else {
      setQuery('')
    }
  }, [open, authUser, gatewayModelsRaw.length, gatewayLastFetch, gatewayError, gatewayLoad])

  // Закрытие по клику снаружи
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      if (dropRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const t = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close) }
  }, [open])

  // Закрытие context menu по клику снаружи
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const t = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close) }
  }, [ctxMenu])

  const handleContextMenu = (e: React.MouseEvent, m: ModelMeta) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, model: m })
  }

  const handleTogglePin = async (model: ModelMeta) => {
    setCtxMenu(null)
    await togglePin(model.id, model.providerId)
  }

  const handleOpen = () => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    // Открываем вверх, если снизу не хватает места (и сверху его больше).
    const openUp = spaceBelow < DROP_H + 12 && spaceAbove > spaceBelow
    const dropW = 360
    // Высота адаптивная: занимаем свободное место в сторону открытия,
    // но не выше 560px (и не ниже 240px, чтобы фильтры+список помещались).
    const maxH = Math.max(240, Math.min((openUp ? spaceAbove : spaceBelow) - 12, 560))
    const rawLeft = r.right - dropW
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - dropW - 8))
    setDropPos({
      left,
      width: dropW,
      openUp,
      maxH,
      ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    })
    setOpen(o => !o)
  }

  // Hover-тултип со статами модели. По умолчанию справа от дропдауна;
  // если справа нет места (220px ширина тултипа + 8px отступ) — слева.
  // Fix 2: clamp по вертикали — не уходить за низ экрана, при необходимости
  // переворачивать тултип вверх (иначе нижние модели показывают тултип за viewport).
  const handleItemHover = (e: React.MouseEvent, m: ModelMeta) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const dropLeft = dropPos?.left ?? 0
    const dropW = dropPos?.width ?? 320
    const tooltipW = 220
    const tooltipH = 280 // примерная высота тултипа с caps + description
    const rightLeft = dropLeft + dropW + 8
    const left = rightLeft + tooltipW > window.innerWidth - 8
      ? dropLeft - tooltipW - 8
      : rightLeft

    // Если тултип не помещается снизу от текущей позиции item —
    // прижимаем к нижнему краю viewport или переворачиваем вверх.
    const maxTop = window.innerHeight - tooltipH - 8
    let top = Math.min(r.top, Math.max(8, maxTop))
    if (r.top > maxTop) {
      // Открываем вверх: низ тултипа на уровне низа item + отступ
      const topUp = r.bottom - tooltipH + Math.round(r.height / 2)
      if (topUp > 8) top = topUp
    }

    setTooltipPos({ top, left })
    setHovered(m)
  }

  // Текущая модель для бейджа. Приоритет: per-chat пара (modelId, providerId)
  // из пропсов → глобальное main-назначение.
  const displayModelId = providerId ? modelId : (assignment?.modelId ?? modelId)
  const displayProviderId = providerId ?? (assignment?.providerId ?? '')
  const current = models.find(m => m.id === displayModelId && m.providerId === displayProviderId)
  const displayName = current?.name ?? displayModelId ?? 'Модель не выбрана'
  // Аватар текущей модели для бейджа в шапке
  const currentProvider = providerMap.current.get(displayProviderId)
  const currentLogo = currentProvider
    ? getBrandLogo(currentProvider.type, displayModelId, displayName, currentProvider.iconUrl)
    : null

  // Единый пайплайн фильтрации (поиск → capabilities → цена) — общий
  // с ModelPicker через utils/modelFilters. Мемоизируем по входам —
  // иначе grouped был бы новым объектом на каждый рендер (включая
  // hover/scroll), съедая пользу от виртуализации (Fix 7).
  const filtered = useMemo(
    () => filterModels(models, { query, caps: activeCaps, price: priceFilter }),
    [models, query, activeCaps, priceFilter],
  )

  const grouped = useMemo(() => {
    const raw = filtered.reduce<Record<string, ModelMeta[]>>((acc, m) => {
      if (!acc[m.providerId]) acc[m.providerId] = []
      acc[m.providerId].push(m)
      return acc
    }, {})
    // Сортировка моделей gateway: groups выше, затем по статусу
    if (raw[GATEWAY_PROVIDER_ID]) {
      const statusOrder: Record<string, number> = { operational: 0, degraded: 1, down: 2, unknown: 3 }
      raw[GATEWAY_PROVIDER_ID] = [...raw[GATEWAY_PROVIDER_ID]].sort((a, b) => {
        const aIsGroup = groupModelIds.has(a.id) ? 0 : 1
        const bIsGroup = groupModelIds.has(b.id) ? 0 : 1
        if (aIsGroup !== bIsGroup) return aIsGroup - bIsGroup
        const sa = statusOrder[normalizeStatus(statusByModel[a.id])] ?? 3
        const sb = statusOrder[normalizeStatus(statusByModel[b.id])] ?? 3
        return sa - sb
      })
    }
    // Reorder: syntee-gateway группа первой
    const ordered: Record<string, ModelMeta[]> = {}
    if (raw[GATEWAY_PROVIDER_ID]) {
      ordered[GATEWAY_PROVIDER_ID] = raw[GATEWAY_PROVIDER_ID]
    }
    for (const [k, v] of Object.entries(raw)) {
      if (k !== GATEWAY_PROVIDER_ID) ordered[k] = v
    }
    return ordered
  }, [filtered, statusByModel, groupModelIds])

  // Fix 7: виртуализация списка. Строим плоский массив рядов
  // (header | item), чтобы один useVirtualizer покрывал весь список.
  // Раньше рендерились ВСЕ модели с per-item motion.div + delay — при 100+
  // моделях это вызывало лаг при открытии дропдауна.
  type Row =
    | { type: 'header'; providerId: string; key: string }
    | { type: 'item'; model: ModelMeta; key: string }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const [pid, mods] of Object.entries(grouped)) {
      out.push({ type: 'header', providerId: pid, key: `h-${pid}` })
      for (const m of mods) {
        out.push({ type: 'item', model: m, key: `i-${m.id}-${m.providerId}` })
      }
    }
    return out
  }, [grouped])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => {
      const row = rows[i]
      if (row.type === 'header') return 26
      if (row.model.providerId === GATEWAY_PROVIDER_ID) return 46
      return 32
    },
    overscan: 8,
    // Секции (закреплённые/недавние/gateway-блок) занимают sectionsH px
    // сверху в том же скролл-контейнере — виртуализатор учитывает их
    // как offset; при рендере вычитаем scrollMargin из translateY.
    scrollMargin: sectionsH,
  })

  const handleSelect = (m: ModelMeta) => {
    onChange(m.id, m.providerId)
    addRecent(m.id, m.providerId)
    // Локально обновляем назначение для мгновенного отклика бейджа
    const next: ModelAssignment = { role: 'main', modelId: m.id, providerId: m.providerId }
    setAssignment(next)
    setOpen(false)
  }

  return (
    <div className="model-selector">
      <motion.button
        ref={btnRef}
        className="model-selector-badge"
        onClick={handleOpen}
        whileHover={whileHoverSm}
        whileTap={{ scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        title={displayModelId ? `${displayName} (${displayProviderId})` : 'Выбрать модель'}
      >
        <BrandAvatar logo={currentLogo} fallbackColor={getProviderColor(displayProviderId)} size={16} className="model-selector-logo" />
        <span className="model-selector-name">{displayName}</span>
        <motion.span
          style={{ display: 'inline-flex' }}
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          <AppIcon name="chevronDown" size="xs" />
        </motion.span>
      </motion.button>

      {createPortal(
        <>
          <AnimatePresence>
            {open && dropPos && (
              <motion.div
                ref={dropRef}
                className="model-selector-dropdown"
                style={{
                  position: 'fixed',
                  left: dropPos.left,
                  width: dropPos.width,
                  maxHeight: dropPos.maxH,
                  zIndex: 9999,
                  ...(dropPos.openUp ? { bottom: dropPos.bottom } : { top: dropPos.top }),
                }}
                initial={{ opacity: 0, y: dropPos.openUp ? 6 : -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: dropPos.openUp ? 6 : -8 }}
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                onMouseDown={e => e.stopPropagation()}
              >
                {/* Поиск + кнопка фильтров */}
                <div className="model-selector-search">
                  <AppIcon name="search" size="sm" />
                  <input
                    ref={inputRef}
                    className="model-selector-search-input"
                    placeholder="Поиск моделей..."
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                  />
                  {query && (
                    <motion.button
                      className="model-selector-search-clear"
                      onClick={() => setQuery('')}
                      whileHover={whileHoverTiny}
                      whileTap={whileTapTiny}
                      transition={springHover}
                    >
                      <AppIcon name="x" size="xs" />
                    </motion.button>
                  )}
                  <motion.button
                    className={`model-filter-toggle ${filtersOpen ? 'model-filter-toggle--open' : ''}`}
                    onClick={() => setFiltersOpen(o => !o)}
                    title="Фильтры: возможности и цена"
                    whileHover={whileHoverSm}
                    whileTap={whileTapSm}
                    transition={springHover}
                  >
                    <AppIcon name="filter" size="xs" />
                    {filtersActive && <span className="model-filter-toggle-dot" />}
                  </motion.button>
                </div>

                {/* Панель фильтров: capabilities + цена (сворачиваемая) */}
                <ModelFilterBar
                  models={models}
                  activeCaps={activeCaps}
                  onCapsChange={setActiveCaps}
                  priceFilter={priceFilter}
                  onPriceChange={setPriceFilter}
                  expanded={filtersOpen}
                  resultCount={filtered.length}
                  totalCount={models.length}
                />

                {/* Единый вертикальный скролл: секции (закреплённые, недавние,
                    gateway-блок) + виртуализированный список в одном контейнере.
                    Высота секций уходит в scrollMargin виртуализатора. */}
                <div
                  className="model-selector-list"
                  ref={listRef}
                  onScroll={() => setHovered(null)}
                >
                  {(showSections || showGatewaySkeleton || showGatewayError) && (
                    <div ref={sectionsRef} className="model-selector-above">
                      {/* Закреплённые модели — чипсы переносятся по рядам */}
                      {showSections && resolvedPinned.length > 0 && (
                        <div className="model-selector-pinned">
                          <div className="model-selector-section-title">
                            <AppIcon name="pin" size="xs" tone="accent" />
                            Закреплённые
                          </div>
                          <div className="model-selector-chips">
                            {resolvedPinned.map(({ model, logo, color }) => {
                              const isActive = model.id === displayModelId && model.providerId === displayProviderId
                              return (
                                <motion.button
                                  key={`pin-${model.id}-${model.providerId}`}
                                  className={`model-selector-chip ${isActive ? 'model-selector-chip--active' : ''}`}
                                  onClick={() => handleSelect(model)}
                                  onContextMenu={e => handleContextMenu(e, model)}
                                  title={model.name}
                                  whileHover={whileHoverSm}
                                  whileTap={whileTapSm}
                                  transition={springHover}
                                >
                                  <BrandAvatar logo={logo} fallbackColor={color} size={12} className="model-selector-chip-logo" />
                                  <span className="model-selector-chip-name">{model.name}</span>
                                </motion.button>
                              )
                            })}
                          </div>
                        </div>
                      )}

                      {/* Недавно использованные модели */}
                      {showSections && resolvedRecent.length > 0 && (
                        <div className="model-selector-recent">
                          <div className="model-selector-section-title">Недавние</div>
                          <div className="model-selector-chips">
                            {resolvedRecent.map(({ model, logo, color }) => {
                              const isActive = model.id === displayModelId && model.providerId === displayProviderId
                              return (
                                <button
                                  key={`recent-${model.id}-${model.providerId}`}
                                  className={`model-selector-chip ${isActive ? 'model-selector-chip--active' : ''}`}
                                  onClick={() => handleSelect(model)}
                                  onContextMenu={e => handleContextMenu(e, model)}
                                  title={model.name}
                                >
                                  <BrandAvatar logo={logo} fallbackColor={color} size={12} className="model-selector-chip-logo" />
                                  <span className="model-selector-chip-name">{model.name}</span>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}

                      {/* Skeleton для gateway-моделей, которые ещё грузятся */}
                      {showGatewaySkeleton && !query.trim() && (
                        <div className="model-selector-gateway-loading">
                          <div className="model-selector-gateway-loading-header">
                            <div className="model-selector-gateway-loading-dot" />
                            <span>Syntee-Gateway</span>
                            <AppIcon name="loader" size="xs" animation="spin" tone="muted" />
                          </div>
                          {[0, 1, 2].map(i => (
                            <div key={i} className="model-selector-skeleton-row" style={{ animationDelay: `${i * 0.08}s` }}>
                              <div className="model-selector-skeleton-icon" />
                              <div className="model-selector-skeleton-text" />
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Gateway: фетч завершён, но моделей нет — ошибка или пусто */}
                      {showGatewayError && !query.trim() && (
                        <div className="model-selector-gateway-loading">
                          <div className="model-selector-gateway-loading-header">
                            <div className="model-selector-gateway-loading-dot" />
                            <span>Syntee-Gateway</span>
                          </div>
                          <div className="model-selector-gateway-error">
                            <span className="model-selector-gateway-error-text">
                              {gatewayError ? `Не удалось загрузить: ${gatewayError}` : 'Модели Syntee-Gateway не найдены'}
                            </span>
                            <button
                              type="button"
                              className="model-selector-gateway-retry"
                              onClick={() => gatewayLoad()}
                            >
                              Повторить
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {loading && rows.length === 0 && (
                    <div className="model-selector-skeleton">
                      {[0, 1, 2, 3, 4, 5].map(i => (
                        <div key={i} className="model-selector-skeleton-row" style={{ animationDelay: `${i * 0.06}s` }}>
                          <div className="model-selector-skeleton-icon" />
                          <div className="model-selector-skeleton-text" />
                        </div>
                      ))}
                    </div>
                  )}
                  {!loading && rows.length === 0 && (
                    <div className="model-selector-empty">
                      <span>
                        {query ? 'Ничего не найдено'
                          : filtersActive ? 'Нет моделей с такими фильтрами'
                          : 'Модели не найдены'}
                      </span>
                      {filtersActive && !query && (
                        <button
                          type="button"
                          className="model-selector-empty-reset"
                          onClick={() => { setActiveCaps([]); setPriceFilter('any') }}
                        >
                          Сбросить фильтры
                        </button>
                      )}
                    </div>
                  )}
                  {rows.length > 0 && (
                    <div
                      style={{
                        height: `${virtualizer.getTotalSize()}px`,
                        width: '100%',
                        position: 'relative',
                      }}
                    >
                      {virtualizer.getVirtualItems().map(vRow => {
                        const row = rows[vRow.index]
                        // scrollMargin = высота секций над списком — вычитаем,
                        // чтобы координаты были относительно virtual-контейнера.
                        const startY = vRow.start - virtualizer.options.scrollMargin
                        if (row.type === 'header') {
                          const prov = providerMap.current.get(row.providerId)
                          const groupLogo = prov ? getBrandLogo(prov.type, '', '', prov.iconUrl) : null
                          const isGatewayGroup = row.providerId === GATEWAY_PROVIDER_ID
                          return (
                            <div
                              key={row.key}
                              className="model-selector-group-label"
                              style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: '26px',
                                transform: `translateY(${startY}px)`,
                              }}
                            >
                              <BrandAvatar logo={groupLogo} fallbackColor={getProviderColor(row.providerId)} size={16} className="model-selector-provider-logo" />
                              {prov?.name ?? row.providerId}
                              {isGatewayGroup && (
                                <AppIcon name="pin" size="xs" tone="accent" />
                              )}
                            </div>
                          )
                        }
                        const m = row.model
                        const isActive = m.id === displayModelId && m.providerId === displayProviderId
                        const mProv = providerMap.current.get(m.providerId)
                        const mLogo = mProv ? getBrandLogo(mProv.type, m.id, m.name, mProv.iconUrl) : null
                        const isGatewayModel = m.providerId === GATEWAY_PROVIDER_ID
                        const status = isGatewayModel ? normalizeStatus(statusByModel[m.id]) : 'unknown'
                        const uptimeBuckets = isGatewayModel ? bucketsByModel[m.id] : undefined
                        return (
                          <div
                            key={row.key}
                            className={`model-selector-item ${isActive ? 'model-selector-item--active' : ''} ${isGatewayModel ? 'model-selector-item--gateway' : ''}`}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              height: isGatewayModel ? '46px' : '32px',
                              transform: `translateY(${startY}px)`,
                            }}
                            onClick={() => handleSelect(m)}
                            onContextMenu={e => handleContextMenu(e, m)}
                            onMouseEnter={e => handleItemHover(e, m)}
                            onMouseLeave={() => setHovered(null)}
                          >
                            <div className="model-selector-item-row">
                              <BrandAvatar logo={mLogo} fallbackColor={getProviderColor(m.providerId)} size={16} className="model-selector-item-logo" />
                              <span className="model-selector-item-name">{m.name}</span>
                              {/* Мини-иконки capabilities + бейдж FREE. Иконки,
                                  совпадающие с активным фильтром, подсвечены. */}
                              {(m.capabilities.length > 0 || isModelFree(m)) && (
                                <span className="model-selector-item-meta">
                                  {m.capabilities.slice(0, 4).map(c => (
                                    <AppIcon
                                      key={c}
                                      name={CAP_ICONS[c]}
                                      size="xs"
                                      className={`model-selector-cap-icon ${activeCaps.includes(c) ? 'model-selector-cap-icon--active' : ''}`}
                                    />
                                  ))}
                                  {isModelFree(m) && <span className="model-free-badge">FREE</span>}
                                </span>
                              )}
                              {isGatewayModel && status !== 'unknown' && (
                                <span
                                  className={`model-status-badge model-status-badge--${status}`}
                                  title={`Статус: ${status}`}
                                />
                              )}
                              {isActive && (
                                <motion.span
                                  style={{ display: 'inline-flex' }}
                                  initial={{ scale: 0.5, opacity: 0 }}
                                  animate={{ scale: 1, opacity: 1 }}
                                  transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                                >
                                  <AppIcon name="check" size="xs" tone="accent" />
                                </motion.span>
                              )}
                            </div>
                            {isGatewayModel && uptimeBuckets && uptimeBuckets.length > 0 && (
                              <div className="model-selector-item-uptime">
                                <MiniUptimeBar buckets={uptimeBuckets} />
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Tooltip со статами модели */}
          <AnimatePresence>
            {hovered && open && (
              <motion.div
                className="model-selector-tooltip"
                style={{ position: 'fixed', top: tooltipPos.top, left: tooltipPos.left, zIndex: 10000 }}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.12 }}
              >
                <div className="mpt-name">{hovered.name}</div>
                <div className="mpt-id">{hovered.id}</div>
                <div className="mpt-row">
                  <span className="mpt-label">Контекст</span>
                  <span className="mpt-val">{formatCtx(hovered.contextWindow)}</span>
                </div>
                <div className="mpt-row">
                  <span className="mpt-label">Вход</span>
                  <span className="mpt-val">
                    {tooltipPrice(hovered, hovered.inputPrice)}{!isModelFree(hovered) && ' / 1M'}
                  </span>
                </div>
                <div className="mpt-row">
                  <span className="mpt-label">Выход</span>
                  <span className="mpt-val">
                    {tooltipPrice(hovered, hovered.outputPrice)}{!isModelFree(hovered) && ' / 1M'}
                  </span>
                </div>
                <div className="mpt-row">
                  <span className="mpt-label">Скорость</span>
                  <span className="mpt-val" style={{ color: SPEED_COLOR[hovered.speed] }}>
                    {SPEED_LABEL[hovered.speed]}
                  </span>
                </div>
                {hovered.capabilities.length > 0 && (
                  <div className="mpt-caps">
                    {hovered.capabilities.map(c => (
                      <span key={c} className="model-cap-badge">{CAP_LABELS[c]}</span>
                    ))}
                  </div>
                )}
                {hovered.description
                  ? <div className="mpt-desc">{hovered.description}</div>
                  : hovered.capabilities.length === 0 && (
                    <div className="mpt-desc">Данные о возможностях отсутствуют</div>
                  )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Context menu (правый клик — закрепить/открепить) */}
          <AnimatePresence>
            {ctxMenu && (
              <motion.div
                className="model-selector-ctx-menu"
                style={{ position: 'fixed', top: ctxMenu.y, left: ctxMenu.x, zIndex: 10001 }}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                onMouseDown={e => e.stopPropagation()}
              >
                <button
                  className="model-selector-ctx-item"
                  onClick={() => handleTogglePin(ctxMenu.model)}
                >
                  <AppIcon name="pin" size="sm" />
                  {pinnedModels.some(p => p.modelId === ctxMenu.model.id && p.providerId === ctxMenu.model.providerId)
                    ? 'Открепить'
                    : 'Закрепить'}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </>,
        document.body
      )}
    </div>
  )
}
