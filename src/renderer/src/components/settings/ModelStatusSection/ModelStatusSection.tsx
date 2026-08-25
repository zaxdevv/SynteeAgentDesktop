import { useMemo, memo, useEffect } from 'react'
import { motion } from 'framer-motion'
import AppIcon from '../../ui/AppIcon/AppIcon'
import { useAuthStore } from '../../../store/auth.store'
import {
  useGatewayModelsStore,
  normalizeStatus,
  type UptimeBucket,
} from '../../../store/gatewayModels.store'
import { whileHoverSm, whileTapSm, springHover } from '../../../utils/motionPresets'
import './ModelStatusSection.css'

/**
 * Панель «Статус моделей» в настройках.
 *
 * Показывает:
 *  - Сводку по провайдерам gateway (operational/degraded/down, ключи, uptime)
 *  - Per-model hourly uptime buckets за 12 часов (горизонтальные бары)
 *  - Запросы и ошибки за последний час
 *
 * Данные тянем из gatewayModels.store, который polling-обновляется каждые 60с.
 */
export default function ModelStatusSection() {
  const user = useAuthStore(s => s.user)
  const models = useGatewayModelsStore(s => s.models)
  const statusByModel = useGatewayModelsStore(s => s.statusByModel)
  const modelStatusBuckets = useGatewayModelsStore(s => s.modelStatusBuckets)
  const providerStatus = useGatewayModelsStore(s => s.providerStatus)
  const loading = useGatewayModelsStore(s => s.loading)
  const error = useGatewayModelsStore(s => s.error)
  const lastFetchAt = useGatewayModelsStore(s => s.lastFetchAt)
  const load = useGatewayModelsStore(s => s.load)

  // Свежие данные при каждом открытии секции: стор заполняется при логине
  // и 60s-polling'ом (loadStatus — только buckets/провайдеры), поэтому без
  // этого список моделей мог показывать устаревшее/пустое состояние.
  useEffect(() => {
    if (user) load()
  }, [user, load])

  // Map по model id для быстрого lookup buckets. Вынесено выше early-return
  // чтобы не нарушать правила хуков.
  const bucketsByModel = useMemo(() => {
    const m: Record<string, UptimeBucket[]> = {}
    for (const b of modelStatusBuckets) m[b.model] = b.buckets
    return m
  }, [modelStatusBuckets])

  if (!user) {
    return (
      <div className="model-status-section">
        <h2 className="settings-section-title">Статус моделей</h2>
        <div className="model-status-guest">
          <AppIcon name="server" size="lg" />
          <p>Войдите в Syntee-Gateway, чтобы видеть статус моделей и провайдеров.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="model-status-section">
      <h2 className="settings-section-title">Статус моделей</h2>
      <div className="model-status-toolbar">
        <p className="model-status-section__subtitle">
          Актуальное состояние моделей и провайдеров Syntee-Gateway.
          {lastFetchAt > 0 && (
            <span className="model-status-section__updated">
              {' '}Обновлено: {new Date(lastFetchAt).toLocaleTimeString('ru')}
            </span>
          )}
        </p>
        <motion.button
          type="button"
          className="model-status-refresh"
          onClick={() => load()}
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

      {/* Ошибка загрузки: стор хранит её с момента последнего fetch,
          но раньше UI молчал — юзер видел пустую страницу без объяснений. */}
      {error && (
        <div className="model-status-error" role="alert">
          <AppIcon name="alertTriangle" size="sm" />
          <span>
            Не удалось загрузить данные: {error}
            {models.length > 0 && ' — показаны последние полученные данные.'}
          </span>
        </div>
      )}

      {/* ── Провайдеры ── */}
      {providerStatus.length > 0 && (
        <div className="model-status-block">
          <h3 className="model-status-block__title">Провайдеры</h3>
          <div className="model-status-providers">
            {providerStatus.map((p) => (
              <div key={p.provider_id} className="model-status-provider">
                <div className="model-status-provider__head">
                  <span
                    className={`model-status-dot model-status-dot--${normalizeStatus(p.status as any)}`}
                  />
                  <span className="model-status-provider__name">{p.name}</span>
                  <span className="model-status-provider__prefix">[{p.prefix}]</span>
                </div>
                <div className="model-status-provider__stats">
                  <span title="Активных ключей">
                    <AppIcon name="lock" size="xs" /> {p.active_keys}/{p.total_keys}
                  </span>
                  <span title="Запросов за час">
                    <AppIcon name="zap" size="xs" /> {p.requests_1hr}
                  </span>
                  <span title="Ошибок за час" className={p.error_count > 0 ? 'model-status-provider__errors' : ''}>
                    <AppIcon name="alertCircle" size="xs" /> {p.error_count}
                  </span>
                  <span title="Uptime">
                    <AppIcon name="check" size="xs" /> {p.uptime}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Модели ── */}
      <div className="model-status-block">
        <h3 className="model-status-block__title">
          Модели
          {models.length > 0 && (
            <span className="model-status-block__count">{models.length}</span>
          )}
        </h3>

        {models.length === 0 ? (
          <div className="model-status-empty">
            {loading
              ? 'Загрузка…'
              : error
                ? 'Модели не загрузились — подробности в сообщении об ошибке выше.'
                : 'Gateway вернул пустой список моделей для вашего аккаунта.'}
          </div>
        ) : (
          <div className="model-status-models">
            {models.map((m) => {
              const status = normalizeStatus(statusByModel[m.id])
              const buckets = bucketsByModel[m.id] ?? []
              return (
                <ModelRow key={m.id} model={m} status={status} buckets={buckets} />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** Строка модели — memoized чтобы при 60s polling ре-рендерились только
 *  изменившиеся строки, а не все 50-100+. */
const ModelRow = memo(function ModelRow({
  model, status, buckets,
}: {
  model: { id: string; display_name?: string; type?: string }
  status: string
  buckets: UptimeBucket[]
}) {
  return (
    <div className="model-status-model">
      <div className="model-status-model__head">
        <span
          className={`model-status-dot model-status-dot--${status}`}
          title={status}
        />
        <span className="model-status-model__name">
          {model.display_name || model.id}
        </span>
        {model.type === 'group' && (
          <span className="model-status-model__badge">group</span>
        )}
        <span className="model-status-model__id">{model.id}</span>
      </div>
      <UptimeBar buckets={buckets} />
    </div>
  )
}, (prev, next) =>
  prev.model === next.model &&
  prev.status === next.status &&
  prev.buckets === next.buckets
)

/** Горизонтальный бар uptime по часам. Memoized с content-comparison:
 *  buckets — массив до 12 ячеек, сравниваем по полям (дёшево), чтобы
 *  пропускать ре-рендер когда ref меняется но контент тот же (polling). */
const UptimeBar = memo(function UptimeBar({ buckets }: { buckets: UptimeBucket[] }) {
  if (buckets.length === 0) {
    return <div className="uptime-bar uptime-bar--empty">нет данных</div>
  }
  return (
    <div className="uptime-bar" title="Uptime по часам (12ч)">
      {buckets.map((b, i) => {
        const cls =
          b.requests === 0
            ? 'uptime-bar__cell--neutral'
            : b.errors === 0
              ? 'uptime-bar__cell--ok'
              : b.success / b.requests > 0.9
                ? 'uptime-bar__cell--ok'
                : b.success / b.requests > 0.5
                  ? 'uptime-bar__cell--warn'
                  : 'uptime-bar__cell--err'
        const pct = b.requests > 0 ? Math.round((b.success / b.requests) * 100) : 100
        return (
          <span
            key={i}
            className={`uptime-bar__cell ${cls}`}
            title={`${new Date(b.timestamp).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })} · ${b.requests} зап · uptime ${pct}%`}
          />
        )
      })}
    </div>
  )
}, (prev, next) => {
  if (prev.buckets.length !== next.buckets.length) return false
  for (let i = 0; i < prev.buckets.length; i++) {
    const a = prev.buckets[i], b = next.buckets[i]
    if (a.requests !== b.requests || a.errors !== b.errors || a.success !== b.success) return false
  }
  return true
})
