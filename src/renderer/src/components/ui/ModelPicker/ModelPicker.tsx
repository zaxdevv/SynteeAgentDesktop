import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ModelMeta, ModelCapability, ModelRole, Provider } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import BrandAvatar from '../BrandAvatar/BrandAvatar'
import ModelFilterBar from '../ModelFilterBar/ModelFilterBar'
import { CAP_LABELS, SPEED_LABEL, SPEED_COLOR, formatCtx, getProviderColor, getBrandLogo } from '../../../utils/modelFormat'
import { filterModels, isModelFree, tooltipPrice, matchesModelRole, type PriceFilter } from '../../../utils/modelFilters'
import { useGatewayModelsStore, normalizeStatus, GATEWAY_PROVIDER_ID } from '../../../store/gatewayModels.store'
import { useAuthStore } from '../../../store/auth.store'
import MiniUptimeBar from '../MiniUptimeBar/MiniUptimeBar'
import { whileHoverTiny, whileTapTiny, whileHoverSm, whileTapSm, springHover } from '../../../utils/motionPresets'
import './ModelPicker.css'

interface ModelPickerProps {
  value: string
  providerId: string
  onChange: (modelId: string, providerId: string) => void
  filterCaps?: ModelCapability[]   // начальный фильтр (можно снять)
  filterRole?: ModelRole   // роль назначения; проверяется по metadata
  placeholder?: string
  /** Готовый список моделей. Если передан — не делает IPC-запрос на маунт.
   *  Родитель (напр. AISettingsTab) грузит модели один раз и раздаёт всем
   *  пикерам, чтобы избежать N независимых IPC-вызовов и появления пунктов
   *  по одному с задержкой. */
  sharedModels?: ModelMeta[]
  /** Готовый список провайдеров (та же оптимизация, что sharedModels). */
  sharedProviders?: Provider[]
}

const DROP_H = 460

export default function ModelPicker({ value, providerId, onChange, filterCaps, filterRole, placeholder, sharedModels, sharedProviders }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelMeta[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [activeCaps, setActiveCaps] = useState<ModelCapability[]>(filterCaps ?? [])
  // Фильтр по цене + видимость панели фильтров (общий ModelFilterBar).
  const [priceFilter, setPriceFilter] = useState<PriceFilter>('any')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [dropPos, setDropPos] = useState<{ top?: number; bottom?: number; left: number; width: number; openUp: boolean; maxH: number } | null>(null)
  const [hovered, setHovered] = useState<ModelMeta | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 })
  const [loading, setLoading] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Статусы моделей gateway — для бейджей operational/degraded/down.
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

  // Map по model id для мини uptime-баров.
  const bucketsByModel = useMemo(() => {
    const m: Record<string, import('../../../store/gatewayModels.store').UptimeBucket[]> = {}
    for (const b of modelStatusBuckets) m[b.model] = b.buckets
    return m
  }, [modelStatusBuckets])

  // Map по providerId для быстрого доступа к provider.type при рендере пунктов.
  const providerMap = useRef<Map<string, Provider>>(new Map())
  providerMap.current = new Map(providers.map(p => [p.id, p]))

  // Не гоняем IPC round-trip на каждое открытие — список моделей/провайдеров
  // меняется редко. Перегружаем только один раз на маунт и если данные
  // старше 5с при повторном открытии (защита от staleness).
  // Если родитель передал sharedModels/sharedProviders — используем их и
  // вообще не делаем IPC-запрос (одна загрузка на весь AISettingsTab вместо
  // N независимых запросов от каждого пикера).
  const lastLoadedAtRef = useRef(0)
  const loadData = () => {
    setLoading(true)
    Promise.all([
      window.syntee.models.getAll() as Promise<ModelMeta[]>,
      window.syntee.providers.getAll() as Promise<Provider[]>,
    ])
      .then(([all, provs]) => {
        setModels(all)
        setProviders(provs)
        lastLoadedAtRef.current = Date.now()
      })
      .catch((e: unknown) => console.error('[ModelPicker] load error', e))
      .finally(() => setLoading(false))
  }

  // Синхронизируем shared-данные, если родитель их предоставил.
  useEffect(() => {
    if (sharedModels) setModels(sharedModels)
  }, [sharedModels])
  useEffect(() => {
    if (sharedProviders) setProviders(sharedProviders)
  }, [sharedProviders])

  // Самостоятельная загрузка только если shared-данных нет.
  useEffect(() => {
    if (!sharedModels && !sharedProviders) loadData()
  }, [])

  useEffect(() => {
    if (!open) return
    // Перезагружаем локальный список моделей, если данные устарели.
    if (!sharedModels && Date.now() - lastLoadedAtRef.current > 5000) loadData()
    // Авто-retry моделей gateway: если предыдущий фетч неуспешен/пуст и протух
    // (или вовсе не запускался) — перетягиваем без спиннера. Самовосстановление
    // без перелогина. При наличии ошибки порог снижен до 30с (vs 5мин в норме),
    // чтобы пикер быстрее подхватил модели после кратковременного сбоя gateway.
    if (authUser && gatewayModelsRaw.length === 0) {
      const staleThreshold = gatewayError ? 30_000 : 300_000
      if (gatewayLastFetch === 0 || Date.now() - gatewayLastFetch > staleThreshold) {
        gatewayLoad(true)
      }
    }
  }, [open, sharedModels, authUser, gatewayModelsRaw.length, gatewayLastFetch, gatewayError, gatewayLoad])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  // Сбрасываем activeCaps при смене внешнего filterCaps
  useEffect(() => {
    setActiveCaps(filterCaps ?? [])
  }, [filterCaps?.join(',')])

  const handleOpen = () => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    const openUp = spaceBelow < DROP_H + 12 && spaceAbove > spaceBelow
    const dropW = Math.max(r.width, 320)
    // Адаптивная высота: свободное место в сторону открытия, до 560px.
    const maxH = Math.max(240, Math.min((openUp ? spaceAbove : spaceBelow) - 12, 560))
    const rawLeft = r.left
    const left = Math.min(rawLeft, window.innerWidth - dropW - 8)
    setDropPos({
      left,
      width: dropW,
      openUp,
      maxH,
      ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    })
    setOpen(o => !o)
  }

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // Единый пайплайн фильтрации (поиск → capabilities → цена) — общий
  // с ModelSelector через utils/modelFilters. Мемоизируем по входам —
  // иначе grouped был бы новым объектом на каждый рендер (включая
  // hover/scroll), и useMemo(rows, [grouped]) ниже не давал бы эффекта,
  // съедая пользу от виртуализации (Fix 7).
  const filtered = useMemo(
    () => filterModels(models.filter(m => !filterRole || matchesModelRole(m, filterRole)), { query, caps: activeCaps, price: priceFilter }),
    [models, query, activeCaps, priceFilter, filterRole]
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

  // Fix 7: виртуализация списка. Плоский массив рядов (header | item),
  // один useVirtualizer на весь список. Раньше рендерились ВСЕ модели с
  // per-item motion.div + delay — лаг при большом количестве моделей.
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
      if (row.model.providerId === GATEWAY_PROVIDER_ID) return 48
      return 34
    },
    overscan: 8,
  })

  const current = models.find(m => m.id === value && m.providerId === providerId)
  const currentProvider = providerMap.current.get(providerId)
  const currentLogo = currentProvider
    ? getBrandLogo(currentProvider.type, value, current?.name ?? '', currentProvider.iconUrl)
    : null

  // Fix 2: clamp по вертикали — не уходить за низ экрана, при необходимости
  // переворачивать тултип вверх (иначе нижние модели показывают тултип за viewport).
  const handleItemHover = (e: React.MouseEvent, m: ModelMeta) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const tooltipH = 280
    const left = (dropPos?.left ?? 0) + (dropPos?.width ?? 320) + 8

    const maxTop = window.innerHeight - tooltipH - 8
    let top = Math.min(r.top, Math.max(8, maxTop))
    if (r.top > maxTop) {
      const topUp = r.bottom - tooltipH + Math.round(r.height / 2)
      if (topUp > 8) top = topUp
    }

    setTooltipPos({ top, left })
    setHovered(m)
  }

  return (
    <div className="model-picker">
      <motion.button
        ref={btnRef}
        className="model-picker-btn glass"
        onClick={handleOpen}
        whileTap={{ scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      >
        <BrandAvatar logo={currentLogo} fallbackColor={getProviderColor(providerId)} size={18} className="model-picker-provider-logo" />
        <span className="model-picker-label">
          {current ? current.name : (placeholder || 'Выберите модель')}
        </span>
        <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="sm" />
      </motion.button>

      {createPortal(
        <>
          <AnimatePresence>
            {open && dropPos && (
              <motion.div
                className="model-picker-dropdown"
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
                <div className="model-picker-search">
                  <AppIcon name="search" size="sm" />
                  <input
                    ref={inputRef}
                    className="model-picker-search-input"
                    placeholder="Поиск моделей..."
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                  />
                  {query && (
                    <motion.button className="model-picker-search-clear" onClick={() => setQuery('')} whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
                      <AppIcon name="x" size="xs" />
                    </motion.button>
                  )}
                  <motion.button
                    className={`model-filter-toggle ${filtersOpen ? 'model-filter-toggle--open' : ''}`}
                    onClick={() => setFiltersOpen(o => !o)}
                    title="Фильтры: возможности и цена"
                    whileHover={whileHoverTiny}
                    whileTap={whileTapTiny}
                    transition={springHover}
                  >
                    <AppIcon name="filter" size="xs" />
                    {(activeCaps.length > 0 || priceFilter !== 'any') && <span className="model-filter-toggle-dot" />}
                  </motion.button>
                </div>

                {/* Панель фильтров: capabilities + цена (общая с ModelSelector) */}
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

                {/* Список (виртуализированный — Fix 7) */}
                <div
                  className="model-picker-list"
                  ref={listRef}
                  onScroll={() => setHovered(null)}
                >
                  {loading && rows.length === 0 && (
                    <div className="model-picker-skeleton">
                      {[0, 1, 2, 3, 4, 5].map(i => (
                        <div key={i} className="model-picker-skeleton-row" style={{ animationDelay: `${i * 0.06}s` }}>
                          <div className="model-picker-skeleton-icon" />
                          <div className="model-picker-skeleton-text" />
                        </div>
                      ))}
                    </div>
                  )}
                  {!loading && rows.length === 0 && (
                    <div className="model-picker-empty">
                      {(activeCaps.length > 0 || priceFilter !== 'any') && !query
                        ? 'Нет моделей с такими фильтрами'
                        : query ? 'Ничего не найдено' : 'Модели не найдены'}
                    </div>
                  )}
                  {/* Skeleton для gateway-моделей, которые ещё грузятся */}
                  {showGatewaySkeleton && !query.trim() && (
                    <div className="model-picker-gateway-loading">
                      <div className="model-picker-gateway-loading-header">
                        <div className="model-picker-gateway-loading-dot" />
                        <span>Syntee-Gateway</span>
                        <AppIcon name="loader" size="xs" animation="spin" tone="muted" />
                      </div>
                      {[0, 1, 2].map(i => (
                        <div key={i} className="model-picker-skeleton-row" style={{ animationDelay: `${i * 0.08}s` }}>
                          <div className="model-picker-skeleton-icon" />
                          <div className="model-picker-skeleton-text" />
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Gateway: фетч завершён, но моделей нет — ошибка или пусто */}
                  {showGatewayError && !query.trim() && (
                    <div className="model-picker-gateway-loading">
                      <div className="model-picker-gateway-loading-header">
                        <div className="model-picker-gateway-loading-dot" />
                        <span>Syntee-Gateway</span>
                      </div>
                      <div className="model-picker-gateway-error">
                        <span className="model-picker-gateway-error-text">
                          {gatewayError ? `Не удалось загрузить: ${gatewayError}` : 'Модели Syntee-Gateway не найдены'}
                        </span>
                        <motion.button
                          type="button"
                          className="model-picker-gateway-retry"
                          onClick={() => gatewayLoad()}
                          whileHover={whileHoverSm}
                          whileTap={whileTapSm}
                          transition={springHover}
                        >
                          Повторить
                        </motion.button>
                      </div>
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
                        const startY = vRow.start
                        if (row.type === 'header') {
                          const prov = providerMap.current.get(row.providerId)
                          const groupLogo = prov ? getBrandLogo(prov.type, '', '', prov.iconUrl) : null
                          const isGatewayGroup = row.providerId === GATEWAY_PROVIDER_ID
                          return (
                            <div
                              key={row.key}
                              className="model-picker-group-label"
                              style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: '26px',
                                transform: `translateY(${startY}px)`,
                              }}
                            >
                              <BrandAvatar logo={groupLogo} fallbackColor={getProviderColor(row.providerId)} size={16} className="model-picker-provider-logo" />
                              {prov?.name ?? row.providerId}
                              {isGatewayGroup && (
                                <AppIcon name="pin" size="xs" tone="accent" />
                              )}
                            </div>
                          )
                        }
                        const m = row.model
                        const isActive = m.id === value && m.providerId === providerId
                        const mProv = providerMap.current.get(m.providerId)
                        const mLogo = mProv ? getBrandLogo(mProv.type, m.id, m.name, mProv.iconUrl) : null
                        // Бейдж статуса только для моделей gateway.
                        const isGatewayModel = m.providerId === GATEWAY_PROVIDER_ID
                        const status = isGatewayModel ? normalizeStatus(statusByModel[m.id]) : 'unknown'
                        const uptimeBuckets = isGatewayModel ? bucketsByModel[m.id] : undefined
                        return (
                          <div
                            key={row.key}
                            className={`model-picker-item ${isActive ? 'model-picker-item--active' : ''} ${isGatewayModel ? 'model-picker-item--gateway' : ''}`}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              height: isGatewayModel ? '48px' : '34px',
                              transform: `translateY(${startY}px)`,
                            }}
                            onClick={() => { onChange(m.id, m.providerId); setOpen(false); setQuery('') }}
                            onMouseEnter={e => handleItemHover(e, m)}
                            onMouseLeave={() => setHovered(null)}
                          >
                            <div className="model-picker-item-row">
                              <BrandAvatar logo={mLogo} fallbackColor={getProviderColor(m.providerId)} size={16} className="model-picker-item-logo" />
                              <span className="model-picker-item-name">{m.name}</span>
                              <div className="model-picker-item-caps">
                                {m.capabilities.slice(0, 3).map(c => (
                                  <span key={c} className={`model-cap-badge ${activeCaps.includes(c) ? 'model-cap-badge--active' : ''}`}>
                                    {CAP_LABELS[c]}
                                  </span>
                                ))}
                                {isModelFree(m) && <span className="model-free-badge">FREE</span>}
                              </div>
                              {isGatewayModel && status !== 'unknown' && (
                                <span
                                  className={`model-status-badge model-status-badge--${status}`}
                                  title={`Статус: ${status}`}
                                />
                              )}
                              {isActive && <AppIcon name="check" size="xs" tone="accent" />}
                            </div>
                            {isGatewayModel && uptimeBuckets && uptimeBuckets.length > 0 && (
                              <div className="model-picker-item-uptime">
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

          {/* Tooltip */}
          <AnimatePresence>
            {hovered && open && (
              <motion.div
                className="model-picker-tooltip"
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
        </>,
        document.body
      )}
    </div>
  )
}
