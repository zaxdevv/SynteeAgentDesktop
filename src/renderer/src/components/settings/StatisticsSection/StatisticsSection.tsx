import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react'
import { motion } from 'framer-motion'
import AppIcon, { type IconName } from '../../ui/AppIcon/AppIcon'
import SegmentedControl from '../../ui/SegmentedControl/SegmentedControl'
import AttachmentPreviewModal from '../../ui/AttachmentPreviewModal/AttachmentPreviewModal'
import { useAuthStore } from '../../../store/auth.store'
import { useBillingStore, type UsageBreakdownRow, type PlanUsage } from '../../../store/billing.store'
import { whileHoverSm, whileTapSm, springHover } from '../../../utils/motionPresets'
import { toFileUrl } from '../../../utils/openFilePath'
import './StatisticsSection.css'

// ─── Типы (контракт IPC stats:overview) ──────────────────────────────────────

interface StatsOverview {
  totals: {
    messages: number
    userMessages: number
    assistantMessages: number
    promptTokens: number
    completionTokens: number
    avgDurationMs: number | null
    toolCalls: number
    thinkingMs: number
    chatsCount: number
    projectsCount: number
  }
  activity: { bucket: string; messages: number; tokens: number }[]
  byModel: {
    model: string
    requests: number
    promptTokens: number
    completionTokens: number
    avgDurationMs: number | null
  }[]
  topChats: {
    chatId: string
    title: string
    messages: number
    tokens: number
    lastActive: number
  }[]
  attachments: {
    total: number
    byKind: { kind: string; count: number }[]
    bySource: { source: string; count: number }[]
    items: {
      id: string
      kind: string
      name: string
      source: string
      chatId: string
      chatTitle: string
      createdAt: number
      path: string | null
      dataUrl: string | null
      mime: string | null
      size: number | null
    }[]
  }
  links: {
    total: number
    unique: number
    topDomains: { domain: string; count: number }[]
    items: {
      url: string
      chatId: string
      chatTitle: string
      createdAt: number
    }[]
  }
}

type RangeValue = '24h' | '7d' | '30d' | 'all'
const RANGES: { value: RangeValue; label: string; hours: number | undefined }[] = [
  { value: '24h', label: '24 часа', hours: 24 },
  { value: '7d', label: '7 дней', hours: 24 * 7 },
  { value: '30d', label: '30 дней', hours: 24 * 30 },
  { value: 'all', label: 'Всё время', hours: undefined },
]

// ─── Хелперы форматирования ──────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}
function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('ru')
}
function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)}мс`
  return `${(ms / 1000).toFixed(1)}с`
}
function fmtCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}
function fmtRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'только что'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`
  return `${Math.floor(diff / 86_400_000)} д назад`
}

// ─── CountUp: анимация «накручивания» числа ──────────────────────────────────

function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const [display, setDisplay] = useState(0)
  const fromRef = useRef(0)
  useEffect(() => {
    const from = fromRef.current
    const to = value
    if (from === to) return
    const start = performance.now()
    const duration = 700
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3) // ease-out-cubic
      const current = from + (to - from) * eased
      setDisplay(current)
      if (t < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = to
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{format(display)}</>
}

// ─── KPI-карточка ────────────────────────────────────────────────────────────

interface KpiCard {
  icon: IconName
  label: string
  value: number
  format: (n: number) => string
}

// ─── Подписи для вложений ────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  file: 'Файлы',
  image: 'Изображения',
  skill: 'Скиллы',
  command: 'Команды',
}
const SOURCE_LABELS: Record<string, string> = {
  mention: '@mention',
  dragdrop: 'Drag & Drop',
  paste: 'Вставка',
  dialog: 'Диалог',
}

// ─── Подвкладки ──────────────────────────────────────────────────────────────

type SubTab = 'overview' | 'models' | 'chats' | 'attachments' | 'links' | 'gateway'

const SUB_TABS: { id: SubTab; label: string; icon: IconName }[] = [
  { id: 'overview',    label: 'Обзор',    icon: 'chart' },
  { id: 'models',      label: 'Модели',   icon: 'brain' },
  { id: 'chats',       label: 'Чаты',     icon: 'messageCircle' },
  { id: 'attachments', label: 'Вложения', icon: 'paperclip' },
  { id: 'links',       label: 'Ссылки',   icon: 'link' },
  { id: 'gateway',     label: 'Gateway',  icon: 'server' },
]

// ─── Основной компонент ──────────────────────────────────────────────────────

export default function StatisticsSection() {
  const user = useAuthStore(s => s.user)
  const [range, setRange] = useState<RangeValue>('24h')
  const [subtab, setSubtab] = useState<SubTab>('overview')
  const [data, setData] = useState<StatsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastFetchAt, setLastFetchAt] = useState(0)
  const [previewAtt, setPreviewAtt] = useState<StatsOverview['attachments']['items'][number] | null>(null)
  // Фильтр вложений (клик по чипу → фильтр галереи по типу/источнику)
  const [attFilter, setAttFilter] = useState<{ type: 'kind' | 'source'; value: string } | null>(null)

  // Billing store для gateway-блока
  const summary = useBillingStore(s => s.summary)
  const breakdown = useBillingStore(s => s.breakdown)
  const planUsage = useBillingStore(s => s.planUsage)
  const balance = useBillingStore(s => s.balance)
  const billingLoad = useBillingStore(s => s.load)
  const billingLoadUsage = useBillingStore(s => s.loadUsage)

  const hours = RANGES.find(r => r.value === range)!.hours

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      // Локальная статистика — основной приоритет.
      // Для «Всё время» отправляем {} (hours=undefined), не { hours: undefined } —
      // structured clone всё равно стрипает undefined, но явно чище.
      const params = hours != null ? { hours } : {}
      const local = await window.syntee.stats.overview(params) as StatsOverview
      setData(local)
      setLastFetchAt(Date.now())
    } catch {
      // Тихо — данные просто не загрузятся
    } finally {
      setLoading(false)
    }
    // Billing — НЕ блокирует локальную статистику (если gateway недоступен,
    // локальные данные всё равно должны показаться).
    if (user) {
      billingLoadUsage(hours ?? 24).catch(() => {})
    }
  }, [hours, user, billingLoadUsage])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern: setState inside async callback, not synchronous
    fetchData()
  }, [fetchData])

  // Загружаем billing summary/plan при первом монтировании (если залогинен)
  useEffect(() => {
    if (user) billingLoad()
  }, [user, billingLoad])

  // Переключение периода — без transitioningRef (он блокировл клики)
  const handleRangeChange = (v: string) => {
    if (v !== range) setRange(v as RangeValue)
  }

  // Сброс превью и фильтра при переключении подвкладки — модалка не должна
  // «зависать» невидимым оверлеем после ухода с вкладки вложений.
  const handleSubtabChange = (t: SubTab) => {
    setSubtab(t)
    setPreviewAtt(null)
    setAttFilter(null)
  }

  const handleRefresh = () => fetchData()

  // KPI-карточки (зависят от data + gateway summary)
  const kpis: KpiCard[] = useMemo(() => {
    if (!data) return []
    const cards: KpiCard[] = [
      { icon: 'messageSquare', label: 'Сообщений', value: data.totals.messages, format: fmtNum },
      { icon: 'activity', label: 'Токенов', value: data.totals.promptTokens + data.totals.completionTokens, format: fmtTokens },
      { icon: 'brain', label: 'Моделей', value: data.byModel.length, format: fmtNum },
      { icon: 'clock', label: 'Ср. ответ', value: data.totals.avgDurationMs ?? 0, format: fmtDuration },
    ]
    if (summary) {
      cards.push({ icon: 'dollar', label: 'Расход (gateway)', value: summary.total_cost, format: fmtCost })
      cards.push({ icon: 'zap', label: 'Запросов (gateway)', value: summary.total_requests, format: fmtNum })
    } else {
      cards.push({ icon: 'messageCircle', label: 'Чатов', value: data.totals.chatsCount, format: fmtNum })
      cards.push({ icon: 'paperclip', label: 'Вложений', value: data.attachments.total, format: fmtNum })
    }
    return cards
  }, [data, summary])

  // Доступные подвкладки: gateway только если залогинен.
  // ВАЖНО: useMemo ДО early return — иначе нарушение правил хуков
  // (React error #310: "Rendered more hooks than during the previous render").
  const visibleTabs = useMemo(() => {
    const tabs = [...SUB_TABS]
    if (!user) {
      const gwIdx = tabs.findIndex(t => t.id === 'gateway')
      if (gwIdx >= 0) tabs.splice(gwIdx, 1)
    }
    return tabs
  }, [user])

  // ── Первичная загрузка ──
  if (!data && loading) {
    return (
      <div className="stats-section">
        <h2 className="settings-section-title">Статистика</h2>
        <div className="stats-loading">
          <AppIcon name="loader" size="md" animation="spin" />
          <span>Загрузка статистики…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="stats-section">
      <h2 className="settings-section-title">Статистика</h2>

      {/* Тулбар: период + обновить */}
      <div className="stats-toolbar">
        <SegmentedControl
          value={range}
          onChange={handleRangeChange}
          options={RANGES.map(r => ({ value: r.value, label: r.label }))}
          layoutKey="stats-range"
        />
        <div className="stats-toolbar__right">
          {lastFetchAt > 0 && (
            <span className="stats-updated">
              Обновлено: {new Date(lastFetchAt).toLocaleTimeString('ru')}
            </span>
          )}
          <motion.button
            type="button"
            className="stats-refresh"
            onClick={handleRefresh}
            disabled={loading}
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            {loading ? (
              <AppIcon name="loader" size="sm" animation="spin" />
            ) : (
              <AppIcon name="refreshCw" size="sm" />
            )}
            Обновить
          </motion.button>
        </div>
      </div>

      {/* Подвкладки */}
      <div className="stats-subtabs">
        {visibleTabs.map(t => (
          <button
            key={t.id}
            type="button"
            className={`stats-subtab${subtab === t.id ? ' stats-subtab--active' : ''}`}
            onClick={() => handleSubtabChange(t.id)}
          >
            <AppIcon name={t.icon} size="xs" tone={subtab === t.id ? 'accent' : 'muted'} />
            <span>{t.label}</span>
            {t.id === 'attachments' && data && data.attachments.total > 0 && (
              <span className="stats-subtab__badge">{data.attachments.total}</span>
            )}
            {t.id === 'links' && data && data.links.total > 0 && (
              <span className="stats-subtab__badge">{data.links.total}</span>
            )}
          </button>
        ))}
      </div>

      {/* Контент подвкладки.
          ВАЖНО: НЕТ key={subtab} и НЕТ motion.div — обычный div.
          key={subtab} на motion.div ломал навигацию SettingsPage
          (перехват exit-анимации родительского AnimatePresence). */}
      <div className="stats-content">
        {/* Оверлей загрузки при смене периода (не блокирующий, поверх старых данных) */}
        {loading && data && (
          <div className="stats-loading-overlay">
            <AppIcon name="loader" size="sm" animation="spin" />
          </div>
        )}

        {/* ── Обзор: KPI + график ── */}
        {subtab === 'overview' && (
          <>
            {kpis.length > 0 && (
              <div className="stats-kpi-grid">
                {kpis.map((k, i) => (
                  <motion.div
                    key={k.label}
                    className="stats-kpi"
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 28, delay: 0.04 + i * 0.05 }}
                    whileHover={{ y: -2 }}
                  >
                    <AppIcon name={k.icon} size="sm" tone="accent" />
                    <div className="stats-kpi__value">
                      <CountUp value={k.value} format={k.format} />
                    </div>
                    <span className="stats-kpi__label">{k.label}</span>
                  </motion.div>
                ))}
              </div>
            )}
            {data && data.activity.length > 0 && (
              <ActivityChart points={data.activity} />
            )}
            {data && data.totals.messages === 0 && (
              <div className="stats-empty">
                <AppIcon name="chart" size="lg" />
                <p>Нет данных за выбранный период. Попробуйте выбрать больший диапазон.</p>
              </div>
            )}
          </>
        )}

        {/* ── Модели ── */}
        {subtab === 'models' && (
          <>
            {data && data.byModel.length > 0 ? (
              <div className="stats-block">
                <ModelTable rows={data.byModel} />
              </div>
            ) : (
              <div className="stats-empty">
                <AppIcon name="brain" size="lg" />
                <p>Нет данных по моделям за выбранный период.</p>
              </div>
            )}
          </>
        )}

        {/* ── Чаты ── */}
        {subtab === 'chats' && (
          <>
            {data && data.topChats.length > 0 ? (
              <div className="stats-block">
                <ChatsTable rows={data.topChats} />
              </div>
            ) : (
              <div className="stats-empty">
                <AppIcon name="messageCircle" size="lg" />
                <p>Нет данных по чатам за выбранный период.</p>
              </div>
            )}
          </>
        )}

        {/* ── Вложения ── */}
        {subtab === 'attachments' && (
          <>
            {data && data.attachments.total > 0 ? (
              <>
                <AttachmentsGrid
                  attachments={data.attachments}
                  filter={attFilter}
                  onFilterChange={setAttFilter}
                />
                {data.attachments.items.length > 0 && (
                  <AttachmentsGallery
                    items={data.attachments.items}
                    filter={attFilter}
                    onImageClick={setPreviewAtt}
                  />
                )}
              </>
            ) : (
              <div className="stats-empty">
                <AppIcon name="paperclip" size="lg" />
                <p>Нет вложений за выбранный период.</p>
              </div>
            )}
          </>
        )}

        {/* ── Ссылки ── */}
        {subtab === 'links' && (
          <>
            {data && data.links.total > 0 ? (
              <>
                <LinksBlock links={data.links} />
                {data.links.items.length > 0 && (
                  <LinksList items={data.links.items} />
                )}
              </>
            ) : (
              <div className="stats-empty">
                <AppIcon name="link" size="lg" />
                <p>Нет ссылок за выбранный период.</p>
              </div>
            )}
          </>
        )}

        {/* ── Gateway ── */}
        {subtab === 'gateway' && (
          <>
            {user && planUsage ? (
              <GatewayBlock
                planUsage={planUsage}
                balance={balance}
                breakdown={breakdown}
                summary={summary}
              />
            ) : (
              <div className="stats-empty">
                <AppIcon name="server" size="lg" />
                <p>Войдите в Syntee-Gateway, чтобы видеть статистику расходов и лимиты.</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Превью вложения (модалка).
          ВАЖНО: всегда рендерим, не условно! Условный рендер {previewAtt && ...}
          ломал очистку портала в document.body — AnimatePresence внутри модалки
          не успевал проиграть exit при размонтировании StatisticsSection, и
          невидимый оверлей (position:fixed, z-index:99999) оставался в DOM,
          блокируя весь интерфейс. С always-rendered модалка сама возвращает null
          при attachment=null и корректно анимирует exit. */}
      <AttachmentPreviewModal
        key={previewAtt?.id ?? 'none'}
        attachment={previewAtt ? ({
          id: previewAtt.id,
          kind: previewAtt.kind as any,
          name: previewAtt.name,
          source: previewAtt.source as any,
          path: previewAtt.path ?? undefined,
          // dataUrl из IPC больше не приходит (слишком тяжёлый) —
          // превращаем path в file:// URL, модалка рендерит по нему.
          dataUrl: previewAtt.dataUrl ?? (previewAtt.path ? toFileUrl(previewAtt.path) : undefined),
          mime: previewAtt.mime ?? undefined,
          size: previewAtt.size ?? undefined,
          attachedAt: previewAtt.createdAt,
        } as any) : null}
        onClose={() => setPreviewAtt(null)}
      />
    </div>
  )
}

// ─── График активности (анимированные бары) ──────────────────────────────────

const ActivityChart = memo(function ActivityChart({
  points,
}: {
  points: { bucket: string; messages: number; tokens: number }[]
}) {
  const max = Math.max(...points.map(p => p.messages), 1)
  const maxTokens = Math.max(...points.map(p => p.tokens), 1)
  return (
    <div className="stats-block">
      <h3 className="stats-block__title">
        <AppIcon name="activity" size="xs" tone="muted" />
        Активность
      </h3>
      <div className="stats-chart">
        <div className="stats-chart__bars">
          {points.map((p, i) => {
            const h = Math.max(3, (p.messages / max) * 100)
            const tokenH = Math.max(1, (p.tokens / maxTokens) * 100)
            return (
              <motion.div
                key={p.bucket}
                className="stats-chart__col"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.015, duration: 0.2 }}
                title={`${p.bucket} · ${p.messages} сообщ · ${fmtTokens(p.tokens)} токенов`}
              >
                <div className="stats-chart__bar-wrap">
                  <motion.div
                    className="stats-chart__bar stats-chart__bar--tokens"
                    initial={{ height: 0 }}
                    animate={{ height: `${tokenH}%` }}
                    transition={{ type: 'spring', stiffness: 300, damping: 24, delay: i * 0.015 }}
                  />
                  <motion.div
                    className="stats-chart__bar stats-chart__bar--messages"
                    initial={{ height: 0 }}
                    animate={{ height: `${h}%` }}
                    transition={{ type: 'spring', stiffness: 300, damping: 24, delay: i * 0.015 + 0.03 }}
                  />
                </div>
              </motion.div>
            )
          })}
        </div>
        <div className="stats-chart__legend">
          <span className="stats-chart__legend-item">
            <span className="stats-chart__dot stats-chart__dot--messages" /> Сообщения
          </span>
          <span className="stats-chart__legend-item">
            <span className="stats-chart__dot stats-chart__dot--tokens" /> Токены
          </span>
        </div>
      </div>
    </div>
  )
})

// ─── Таблица по моделям ──────────────────────────────────────────────────────

const ModelTable = memo(function ModelTable({
  rows,
}: {
  rows: StatsOverview['byModel']
}) {
  return (
    <div className="stats-table-wrap">
      <table className="stats-table">
        <thead>
          <tr>
            <th>Модель</th>
            <th className="stats-table__num">Запросы</th>
            <th className="stats-table__num">In</th>
            <th className="stats-table__num">Out</th>
            <th className="stats-table__num">Латентность</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <motion.tr
              key={r.model}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(0.03 + i * 0.02, 0.5), type: 'spring', stiffness: 400, damping: 30 }}
            >
              <td className="stats-table__model">{r.model}</td>
              <td className="stats-table__num">{fmtNum(r.requests)}</td>
              <td className="stats-table__num">{fmtTokens(r.promptTokens)}</td>
              <td className="stats-table__num">{fmtTokens(r.completionTokens)}</td>
              <td className="stats-table__num">{fmtDuration(r.avgDurationMs)}</td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  )
})

// ─── Таблица топ-чатов ───────────────────────────────────────────────────────

const ChatsTable = memo(function ChatsTable({
  rows,
}: {
  rows: StatsOverview['topChats']
}) {
  return (
    <div className="stats-table-wrap">
      <table className="stats-table">
        <thead>
          <tr>
            <th>Чат</th>
            <th className="stats-table__num">Сообщений</th>
            <th className="stats-table__num">Токены</th>
            <th className="stats-table__num">Активность</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <motion.tr
              key={r.chatId}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(0.03 + i * 0.02, 0.5), type: 'spring', stiffness: 400, damping: 30 }}
            >
              <td className="stats-table__chat">{r.title}</td>
              <td className="stats-table__num">{fmtNum(r.messages)}</td>
              <td className="stats-table__num">{fmtTokens(r.tokens)}</td>
              <td className="stats-table__num stats-table__muted">{fmtRelativeTime(r.lastActive)}</td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  )
})

// ─── Сетка вложений ──────────────────────────────────────────────────────────

const AttachmentsGrid = memo(function AttachmentsGrid({
  attachments,
  filter,
  onFilterChange,
}: {
  attachments: StatsOverview['attachments']
  filter: { type: 'kind' | 'source'; value: string } | null
  onFilterChange: (f: { type: 'kind' | 'source'; value: string } | null) => void
}) {
  const toggle = (type: 'kind' | 'source', value: string) => {
    if (filter?.type === type && filter?.value === value) {
      onFilterChange(null) // повторный клик — сброс
    } else {
      onFilterChange({ type, value })
    }
  }
  return (
    <div className="stats-attachments">
      {/* По типам */}
      <div className="stats-attachments__group">
        <div className="stats-attachments__subtitle">По типам {filter?.type === 'kind' ? '· фильтр' : ''}</div>
        <div className="stats-attachments__chips">
          {attachments.byKind.map((k, i) => {
            const active = filter?.type === 'kind' && filter?.value === k.kind
            return (
              <motion.button
                key={k.kind}
                className={`stats-chip${active ? ' stats-chip--active' : ''}`}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: Math.min(i * 0.04, 0.3), type: 'spring', stiffness: 400, damping: 25 }}
                onClick={() => toggle('kind', k.kind)}
              >
                <span className="stats-chip__icon">
                  <AppIcon
                    name={k.kind === 'image' ? 'image' : k.kind === 'skill' ? 'puzzle' : k.kind === 'command' ? 'command' : 'fileText'}
                    size="xs"
                    tone={active ? 'accent' : 'muted'}
                  />
                </span>
                <span className="stats-chip__label">{KIND_LABELS[k.kind] ?? k.kind}</span>
                <span className="stats-chip__count">{k.count}</span>
              </motion.button>
            )
          })}
        </div>
      </div>
      {/* По источникам */}
      {attachments.bySource.length > 0 && (
        <div className="stats-attachments__group">
          <div className="stats-attachments__subtitle">По источнику {filter?.type === 'source' ? '· фильтр' : ''}</div>
          <div className="stats-attachments__chips">
            {attachments.bySource.map((s, i) => {
              const active = filter?.type === 'source' && filter?.value === s.source
              return (
                <motion.button
                  key={s.source}
                  className={`stats-chip${active ? ' stats-chip--active' : ''}`}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: Math.min(i * 0.04, 0.3), type: 'spring', stiffness: 400, damping: 25 }}
                  onClick={() => toggle('source', s.source)}
                >
                  <span className="stats-chip__label">{SOURCE_LABELS[s.source] ?? s.source}</span>
                  <span className="stats-chip__count">{s.count}</span>
                </motion.button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
})

// ─── Блок ссылок ─────────────────────────────────────────────────────────────

const LinksBlock = memo(function LinksBlock({
  links,
}: {
  links: StatsOverview['links']
}) {
  return (
    <div className="stats-links">
      <div className="stats-links__summary">
        <div className="stats-links__stat">
          <span className="stats-links__value">{fmtNum(links.total)}</span>
          <span className="stats-links__label">всего ссылок</span>
        </div>
        <div className="stats-links__stat">
          <span className="stats-links__value">{fmtNum(links.unique)}</span>
          <span className="stats-links__label">уникальных</span>
        </div>
      </div>
      {links.topDomains.length > 0 && (
        <div className="stats-links__domains">
          <div className="stats-links__subtitle">Топ доменов</div>
          {links.topDomains.map((d, i) => {
            const pct = Math.round((d.count / links.total) * 100)
            return (
              <motion.div
                key={d.domain}
                className="stats-domain"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(i * 0.04, 0.3), type: 'spring', stiffness: 400, damping: 30 }}
              >
                <span className="stats-domain__name">{d.domain}</span>
                <div className="stats-domain__bar-wrap">
                  <motion.div
                    className="stats-domain__bar"
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ delay: Math.min(i * 0.04 + 0.1, 0.4), type: 'spring', stiffness: 300, damping: 26 }}
                  />
                </div>
                <span className="stats-domain__count">{d.count}</span>
              </motion.div>
            )
          })}
        </div>
      )}
    </div>
  )
})

// ─── Галерея вложений (картинки + файлы) ─────────────────────────────────────

function fmtSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

const ATTACH_KIND_ICON: Record<string, IconName> = {
  image: 'image',
  file: 'fileText',
  skill: 'puzzle',
  command: 'command',
}

type AttachItem = StatsOverview['attachments']['items'][number]

// ─── Догрузка порциями (infinite scroll) ─────────────────────────────────────
// Данные приходят из IPC целиком (метаданные лёгкие, без dataUrl), но DOM
// создаём порциями: сначала chunkSize элементов, дальше — по мере приближения
// скролла к концу (IntersectionObserver на sentinel). Картинки в сетке и так
// loading="lazy" — браузер не декодирует невидимые file:// превью.

function useInfiniteChunk<T>(items: T[], chunkSize: number) {
  const [count, setCount] = useState(chunkSize)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // Сброс порции при смене набора (фильтр / период / обновление данных)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс порции при смене источника данных
    setCount(chunkSize)
  }, [items, chunkSize])

  // Догрузка: sentinel попадает в viewport (+600px запас) → +chunkSize.
  // Пересоздаём observer при изменении count — иначе после догрузки
  // оставшийся видимым sentinel не стреляет повторно.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || count >= items.length) return
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setCount(c => Math.min(c + chunkSize, items.length))
        }
      },
      { rootMargin: '600px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [count, items.length, chunkSize])

  return {
    visible: items.slice(0, count),
    sentinelRef,
    hasMore: count < items.length,
  }
}

const AttachmentsGallery = memo(function AttachmentsGallery({
  items,
  filter,
  onImageClick,
}: {
  items: AttachItem[]
  filter: { type: 'kind' | 'source'; value: string } | null
  onImageClick: (item: AttachItem) => void
}) {
  // Фильтруем элементы по выбранному чипу (тип или источник).
  // useMemo обязателен: без него новые массивы каждый рендер сбрасывали бы
  // порцию догрузки в useInfiniteChunk.
  const filtered = useMemo(
    () => filter
      ? items.filter(a => (filter.type === 'kind' ? a.kind === filter.value : a.source === filter.value))
      : items,
    [items, filter],
  )
  const images = useMemo(() => filtered.filter(a => a.kind === 'image'), [filtered])
  const files = useMemo(() => filtered.filter(a => a.kind !== 'image'), [filtered])
  // Деструктурируем (не объектом): eslint react-hooks/refs флагует доступ
  // к свойствам объекта, содержащего ref, при обращении в рендере.
  const {
    visible: visibleImages,
    hasMore: imagesHasMore,
    sentinelRef: imagesSentinelRef,
  } = useInfiniteChunk(images, 60)
  const {
    visible: visibleFiles,
    hasMore: filesHasMore,
    sentinelRef: filesSentinelRef,
  } = useInfiniteChunk(files, 60)
  return (
    <div className="stats-gallery">
      {/* Картинки — превью с кликом для открытия в модалке */}
      {images.length > 0 && (
        <div className="stats-gallery__section">
          <div className="stats-gallery__subtitle">
            Изображения{imagesHasMore
              ? ` · показано ${visibleImages.length} из ${images.length}`
              : ` (${images.length})`}
          </div>
          <div className="stats-gallery__grid">
            {visibleImages.map((a, i) => {
              // dataUrl → рендерим напрямую; path → file:// URL; иначе заглушка
              const imgSrc = a.dataUrl ?? (a.path ? toFileUrl(a.path) : null)
              return (
                <motion.div
                  key={a.id}
                  className="stats-gallery__item stats-gallery__item--image"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: i < 60 ? Math.min(i * 0.03, 0.4) : 0, type: 'spring', stiffness: 400, damping: 28 }}
                  whileHover={{ y: -2, scale: 1.03 }}
                  onClick={() => onImageClick(a)}
                  title={`${a.name}\n${a.chatTitle}\n${fmtRelativeTime(a.createdAt)}\n— клик чтобы открыть`}
                >
                  {imgSrc ? (
                    <img src={imgSrc} alt={a.name} loading="lazy" />
                  ) : (
                    <div className="stats-gallery__placeholder">
                      <AppIcon name="image" size="md" tone="muted" />
                    </div>
                  )}
                  <div className="stats-gallery__overlay">
                    <span className="stats-gallery__name">{a.name}</span>
                    <span className="stats-gallery__meta">{a.chatTitle}</span>
                  </div>
                </motion.div>
              )
            })}
          </div>
          {/* Sentinel догрузки — невидимая метка конца порции */}
          {imagesHasMore && <div ref={imagesSentinelRef} className="stats-gallery__sentinel" />}
        </div>
      )}
      {/* Файлы — список */}
      {files.length > 0 && (
        <div className="stats-gallery__section">
          <div className="stats-gallery__subtitle">
            Файлы{filesHasMore
              ? ` · показано ${visibleFiles.length} из ${files.length}`
              : ` (${files.length})`}
          </div>
          <div className="stats-gallery__files">
            {visibleFiles.map((a, i) => (
              <motion.div
                key={a.id}
                className="stats-file"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i < 60 ? Math.min(i * 0.02, 0.4) : 0, type: 'spring', stiffness: 400, damping: 30 }}
                whileHover={{ x: 2 }}
                onClick={() => onImageClick(a)}
                title={`${a.name}\n${a.chatTitle}\n${fmtRelativeTime(a.createdAt)}`}
              >
                <AppIcon name={ATTACH_KIND_ICON[a.kind] ?? 'fileText'} size="xs" tone="muted" />
                <span className="stats-file__name">{a.name}</span>
                <span className="stats-file__size">{fmtSize(a.size)}</span>
                <span className="stats-file__chat">{a.chatTitle}</span>
                <span className="stats-file__time">{fmtRelativeTime(a.createdAt)}</span>
              </motion.div>
            ))}
          </div>
          {filesHasMore && <div ref={filesSentinelRef} className="stats-gallery__sentinel" />}
        </div>
      )}
      {/* Фильтр активен, но ничего не найдено */}
      {filter && images.length === 0 && files.length === 0 && (
        <div className="stats-empty">
          <AppIcon name="paperclip" size="md" />
          <p>Нет вложений выбранного типа.</p>
        </div>
      )}
    </div>
  )
})

// ─── Список всех ссылок ──────────────────────────────────────────────────────

const LinksList = memo(function LinksList({
  items,
}: {
  items: StatsOverview['links']['items']
}) {
  // Порционный рендер — как в галерее вложений (данные все, DOM по 60)
  const {
    visible: visibleLinks,
    hasMore: linksHasMore,
    sentinelRef: linksSentinelRef,
  } = useInfiniteChunk(items, 60)
  return (
    <div className="stats-links-list">
      <div className="stats-links-list__subtitle">
        Ссылки{linksHasMore ? ` · показано ${visibleLinks.length} из ${items.length}` : ` (${items.length})`}
      </div>
      {visibleLinks.map((l, i) => {
        let host: string
        try { host = new URL(l.url).hostname.replace(/^www\./, '') } catch { host = l.url }
        return (
          <motion.a
            key={`${l.url}-${i}`}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            className="stats-link-item"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i < 60 ? Math.min(i * 0.02, 0.4) : 0, type: 'spring', stiffness: 400, damping: 30 }}
            whileHover={{ x: 2 }}
            title={l.url}
          >
            <AppIcon name="externalLink" size="xs" tone="muted" />
            <span className="stats-link-item__host">{host}</span>
            <span className="stats-link-item__url">{l.url.length > 80 ? l.url.slice(0, 80) + '…' : l.url}</span>
            <span className="stats-link-item__chat">{l.chatTitle}</span>
            <span className="stats-link-item__time">{fmtRelativeTime(l.createdAt)}</span>
          </motion.a>
        )
      })}
      {linksHasMore && <div ref={linksSentinelRef} className="stats-gallery__sentinel" />}
    </div>
  )
})

// ─── Gateway-блок: баланс + лимиты + breakdown ───────────────────────────────

const GatewayBlock = memo(function GatewayBlock({
  planUsage,
  balance,
  breakdown,
  summary,
}: {
  planUsage: PlanUsage
  balance: { balance: number; held: number } | null
  breakdown: UsageBreakdownRow[]
  summary: { total_requests: number; total_input_tokens: number; total_output_tokens: number; total_cost: number } | null
}) {
  const windows: { label: string; used: number; limit: number; reset: string }[] = [
    { label: '5 часов', ...planUsage.usage.five_hour, reset: planUsage.usage.five_hour.reset_at },
    { label: 'Неделя', ...planUsage.usage.weekly, reset: planUsage.usage.weekly.reset_at },
    { label: 'Месяц', ...planUsage.usage.monthly, reset: planUsage.usage.monthly.reset_at },
  ]
  return (
    <div className="stats-block stats-gateway">
      <h3 className="stats-block__title">
        <AppIcon name="server" size="xs" tone="accent" />
        Syntee-Gateway
      </h3>

      {/* Баланс + summary */}
      <div className="stats-gateway__row">
        {balance && (
          <div className="stats-gateway__card">
            <span className="stats-gateway__card-label">Баланс</span>
            <span className="stats-gateway__card-value">${balance.balance.toFixed(2)}</span>
          </div>
        )}
        {summary && (
          <>
            <div className="stats-gateway__card">
              <span className="stats-gateway__card-label">Запросов (24ч)</span>
              <span className="stats-gateway__card-value">{fmtNum(summary.total_requests)}</span>
            </div>
            <div className="stats-gateway__card">
              <span className="stats-gateway__card-label">Токенов (24ч)</span>
              <span className="stats-gateway__card-value">{fmtTokens(summary.total_input_tokens + summary.total_output_tokens)}</span>
            </div>
            <div className="stats-gateway__card">
              <span className="stats-gateway__card-label">Расход (24ч)</span>
              <span className="stats-gateway__card-value">{fmtCost(summary.total_cost)}</span>
            </div>
          </>
        )}
      </div>

      {/* Лимиты плана */}
      <div className="stats-gateway__limits">
        <div className="stats-gateway__plan-name">
          План: {planUsage.plan.name}
        </div>
        {windows.map((w, i) => {
          const pct = w.limit > 0 ? Math.min(100, (w.used / w.limit) * 100) : 0
          const danger = pct >= 80
          return (
            <div key={w.label} className="stats-limit">
              <div className="stats-limit__head">
                <span className="stats-limit__label">{w.label}</span>
                <span className="stats-limit__values">
                  ${w.used.toFixed(2)} / ${w.limit.toFixed(2)}
                </span>
              </div>
              <div className="stats-limit__track">
                <motion.div
                  className={`stats-limit__fill${danger ? ' stats-limit__fill--danger' : ''}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ delay: Math.min(i * 0.08 + 0.1, 0.4), type: 'spring', stiffness: 300, damping: 26 }}
                />
              </div>
            </div>
          )
        })}
      </div>

      {/* Breakdown по моделям (gateway) */}
      {breakdown.length > 0 && (
        <div className="stats-gateway__breakdown">
          <div className="stats-gateway__breakdown-title">По моделям (gateway)</div>
          {breakdown.slice(0, 10).map((b, i) => (
            <motion.div
              key={b.key}
              className="stats-bd-row"
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.3) }}
            >
              <span className="stats-bd-row__name">{b.key}</span>
              <span className="stats-bd-row__reqs">{fmtNum(b.requests)} зап</span>
              <span className="stats-bd-row__tokens">{fmtTokens(b.tokens)}</span>
              <span className="stats-bd-row__cost">{fmtCost(b.cost)}</span>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
})
