import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Settings as SettingsIcon, SlidersHorizontal, Gauge, Bell, ScrollText, ArrowRight, FlaskConical, MessageSquare, Database } from 'lucide-react'
import Card from '@/components/ui/Card'
import Button from '@/components/ui/Button'
import Skeleton from '@/components/ui/Skeleton'
import EmptyState from '@/components/ui/EmptyState'
import NumberField from '@/components/ui/NumberField'
import Input from '@/components/ui/Input'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useToast } from '@/components/ui/Toaster'
import {
  useConfigQuery,
  useSetConfigMutation,
  useAuditStatusQuery,
  useToggleAuditMutation,
  useExportUsageMutation,
  useGlobalChatFlagQuery,
  useSetGlobalChatFlagMutation,
  useResponseCacheFlagQuery,
  useSetResponseCacheFlagMutation,
} from '@/hooks/useConfig'
import { useRateLimitsQuery, useCreateRateLimitMutation, useDeleteRateLimitMutation, useUpdateRateLimitMutation } from '@/hooks/useRateLimits'
import { useNotificationsQuery, useMarkNotificationMutation } from '@/hooks/useNotifications'
import { useNotificationConfigQuery, useSetNotificationConfigMutation } from '@/hooks/useConfig'
import PinSecurity from './PinSecurity'

export default function Settings() {
  const { t } = useTranslation()
  const configQ = useConfigQuery()
  const setConfigMut = useSetConfigMutation()
  const auditQ = useAuditStatusQuery()
  const toggleAuditMut = useToggleAuditMutation()
  const exportMut = useExportUsageMutation()
  const rateLimitsQ = useRateLimitsQuery()
  const createRateLimitMut = useCreateRateLimitMutation()
  const deleteRateLimitMut = useDeleteRateLimitMutation()
  const notifsQ = useNotificationsQuery(10, false)
  const markNotifMut = useMarkNotificationMutation()
  const notifConfigQ = useNotificationConfigQuery()
  const setNotifConfigMut = useSetNotificationConfigMutation()
  const globalChatQ = useGlobalChatFlagQuery()
  const setGlobalChatMut = useSetGlobalChatFlagMutation()
  const cacheFlagQ = useResponseCacheFlagQuery()
  const setCacheFlagMut = useSetResponseCacheFlagMutation()
  const toast = useToast()
  const { confirm, dialog: confirmDialog } = useConfirm()

  const [notifConfig, setNotifConfig] = useState({
    webhook_url: '',
    email: '',
    alert_error_rate: '10',
    alert_latency: '5000',
    alert_key_failures: '3',
  })

  const [thresholds, setThresholds] = useState({
    maxLatency: '5000',
    errorRate: '5',
    cooldown: '60',
    blockDuration: '600',
    maxKeysPer429: '6',
    maxAttempts: '12',
  })

  const configMap = new Map((configQ.data ?? []).map((c) => [c.key, c.value]))

  // Sync thresholds from server config once loaded
  useEffect(() => {
    if (!configQ.data) return
    const stored = configMap.get('thresholds') as Record<string, number | string> | undefined
    if (stored) {
      setThresholds({
        maxLatency: stored.maxLatency != null ? String(stored.maxLatency) : thresholds.maxLatency,
        errorRate: stored.errorRate != null ? String(stored.errorRate) : thresholds.errorRate,
        cooldown: stored.cooldown != null ? String(stored.cooldown) : thresholds.cooldown,
        blockDuration: stored.blockDuration != null ? String(stored.blockDuration) : thresholds.blockDuration,
        maxKeysPer429: stored.maxKeysPer429 != null ? String(stored.maxKeysPer429) : thresholds.maxKeysPer429,
        maxAttempts: stored.maxAttempts != null ? String(stored.maxAttempts) : thresholds.maxAttempts,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configQ.data])

  // Sync notification config from server once loaded
  useEffect(() => {
    if (!notifConfigQ.data) return
    const cfg = notifConfigQ.data
    setNotifConfig({
      webhook_url: cfg.webhook_url ?? '',
      email: cfg.email ?? '',
      alert_error_rate: cfg.alert_thresholds?.error_rate != null ? String(cfg.alert_thresholds.error_rate) : '10',
      alert_latency: cfg.alert_thresholds?.latency != null ? String(cfg.alert_thresholds.latency) : '5000',
      alert_key_failures: cfg.alert_thresholds?.key_failures != null ? String(cfg.alert_thresholds.key_failures) : '3',
    })
  }, [notifConfigQ.data])

  const handleSaveThresholds = () => {
    setConfigMut.mutate(
      {
        key: 'thresholds',
        value: {
          maxLatency: parseInt(thresholds.maxLatency) || 0,
          errorRate: parseFloat(thresholds.errorRate) || 0,
          cooldown: parseInt(thresholds.cooldown) || 0,
          blockDuration: parseInt(thresholds.blockDuration) || 0,
          maxKeysPer429: parseInt(thresholds.maxKeysPer429) || 0,
          maxAttempts: parseInt(thresholds.maxAttempts) || 0,
        },
      },
      {
        onSuccess: () => toast.success(t('toast.saved')),
        onError: () => toast.error(t('toast.saveFailed')),
      },
    )
  }

  const handleSaveNotifConfig = () => {
    setNotifConfigMut.mutate(
      {
        webhook_url: notifConfig.webhook_url || null,
        email: notifConfig.email || null,
        alert_thresholds: {
          error_rate: parseInt(notifConfig.alert_error_rate) || 10,
          latency: parseInt(notifConfig.alert_latency) || 5000,
          key_failures: parseInt(notifConfig.alert_key_failures) || 3,
        },
      },
      {
        onSuccess: () => toast.success(t('toast.saved')),
        onError: () => toast.error(t('toast.saveFailed')),
      },
    )
  }

  const [testingWebhook, setTestingWebhook] = useState(false)
  const handleTestWebhook = async () => {
    const url = notifConfig.webhook_url.trim()
    if (!url) {
      toast.warning(t('settings.webhookEmpty', 'Укажите URL вебхука'))
      return
    }
    setTestingWebhook(true)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Syntee Gateway · test webhook' }),
      })
      if (res.ok) toast.success(t('settings.webhookOk', 'Вебхук отвечает'))
      else toast.error(t('settings.webhookStatus', 'Вебхук ответил статусом {{status}}', { status: res.status }))
    } catch {
      toast.error(t('settings.webhookFail', 'Не удалось достучаться до вебхука'))
    } finally {
      setTestingWebhook(false)
    }
  }

  const handleExport = async (format: string) => {
    try {
      const result = await exportMut.mutateAsync({ format, hours: 24, limit: 1000 })
      if (format === 'csv' && typeof result === 'string') {
        const blob = new Blob([result], { type: 'text/csv' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'usage_export.csv'
        a.click()
        URL.revokeObjectURL(url)
        toast.success(t('settings.exportDone', 'Экспорт загружен'))
      }
    } catch {
      toast.error(t('settings.exportFailed', 'Не удалось экспортировать'))
    }
  }

  const requestDeleteRateLimit = async (id: string) => {
    const ok = await confirm({
      title: t('settings.deleteRateLimitTitle', 'Удалить лимит'),
      message: t('settings.deleteRateLimitMessage', 'Удалить этот лимит?'),
      confirmLabel: t('common.delete'),
    })
    if (!ok) return
    deleteRateLimitMut.mutate(id, {
      onSuccess: () => toast.success(t('toast.deleted')),
      onError: () => toast.error(t('toast.deleteFailed')),
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-white">{t('nav.settings')}</h1>
          <p className="text-xs text-text-muted">{t('settings.subtitle', 'Конфигурация шлюза и администрирование')}</p>
        </div>
      </div>

      <Card glass title={t('settings.thresholdsTitle', 'Пороги')} subtitle={t('settings.thresholdsSubtitle', 'Триггеры отказоустойчивости и фолбэка')} action={<SlidersHorizontal size={15} className="text-text-muted" />}>
        {configQ.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField label={t('settings.maxLatency', 'Макс. задержка (фолбэк)')} value={thresholds.maxLatency} suffix="ms" onChange={(v) => setThresholds((p) => ({ ...p, maxLatency: v }))} />
            <NumberField label={t('settings.errorRate', 'Порог ошибок')} value={thresholds.errorRate} suffix="%" onChange={(v) => setThresholds((p) => ({ ...p, errorRate: v }))} />
            <NumberField label={t('settings.cooldown', 'Длительность кулдауна')} value={thresholds.cooldown} suffix="s" onChange={(v) => setThresholds((p) => ({ ...p, cooldown: v }))} />
            <NumberField label={t('settings.blockDuration', 'Длительность блокировки')} value={thresholds.blockDuration} suffix="s" onChange={(v) => setThresholds((p) => ({ ...p, blockDuration: v }))} />
            <NumberField label={t('settings.maxKeysPer429', 'Макс. ключей на 429')} value={thresholds.maxKeysPer429} onChange={(v) => setThresholds((p) => ({ ...p, maxKeysPer429: v }))} />
            <NumberField label={t('settings.maxAttempts', 'Макс. всего попыток')} value={thresholds.maxAttempts} onChange={(v) => setThresholds((p) => ({ ...p, maxAttempts: v }))} />
          </div>
        )}
        <Button size="sm" className="mt-4" onClick={handleSaveThresholds} loading={setConfigMut.isPending}>{t('settings.saveThresholds', 'Сохранить пороги')}</Button>
      </Card>

      <Card glass title={t('settings.rateLimitsTitle', 'Лимиты')} subtitle={t('settings.rateLimitsSubtitle', 'RPM/TPM по областям')} action={<Gauge size={15} className="text-text-muted" />}>
        {rateLimitsQ.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !rateLimitsQ.data?.length ? (
          <EmptyState title={t('settings.noRateLimits', 'Нет лимитов')} message={t('settings.noRateLimitsMessage', 'Добавьте лимит для контроля трафика.')} />
        ) : (
          <div className="space-y-2">
            {rateLimitsQ.data.map((rl) => (
              <RateLimitRow key={rl.id} rl={rl} onDelete={() => requestDeleteRateLimit(rl.id)} />
            ))}
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => createRateLimitMut.mutate(
              { scope: 'global', rpm: 6000, tpm: 100000 },
              { onSuccess: () => toast.success(t('toast.created')), onError: () => toast.error(t('toast.createFailed')) },
            )}
            loading={createRateLimitMut.isPending}
          >
            {t('settings.addGlobal', 'Добавить глобальный лимит')}
          </Button>
        </div>
      </Card>

      <Card glass title={t('settings.notificationsTitle', 'Уведомления')} subtitle={t('settings.notificationsSubtitle', 'Последние оповещения')} action={<Bell size={15} className="text-text-muted" />}>
        {notifsQ.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !notifsQ.data?.length ? (
          <EmptyState title={t('settings.noNotifications', 'Нет уведомлений')} message={t('settings.noNotificationsMessage', 'Оповещения появятся здесь.')} />
        ) : (
          <div className="space-y-2">
            {notifsQ.data.map((n) => (
              <div key={n.id} className="flex items-start justify-between rounded-lg border border-white/8 bg-surface px-3 py-2.5">
                <div>
                  <div className="text-sm text-white">{n.message}</div>
                  <div className="mt-0.5 text-xs text-text-muted">
                    {n.type} · {n.severity} · {new Date(n.created_at).toLocaleString()}
                  </div>
                </div>
                {!n.is_read && (
                  <button
                    onClick={() => markNotifMut.mutate(
                      { id: n.id, isRead: true },
                      { onError: () => toast.error(t('settings.markFailed', 'Не удалось отметить')) },
                    )}
                    className="text-xs text-text-muted hover:text-white"
                  >
                    {t('notifications.markRead', 'Прочитано')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card glass title={t('settings.notifConfigTitle', 'Настройки уведомлений')} subtitle={t('settings.notifConfigSubtitle', 'Вебхук и email для оповещений')} action={<Bell size={15} className="text-text-muted" />}>
        {notifConfigQ.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <div className="space-y-4">
            <Input
              label={t('settings.webhookUrl', 'URL вебхука')}
              value={notifConfig.webhook_url}
              onChange={(e) => setNotifConfig((p) => ({ ...p, webhook_url: e.target.value }))}
              placeholder="https://hooks.slack.com/services/..."
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={handleTestWebhook} loading={testingWebhook}>
                <FlaskConical size={13} /> {t('settings.testWebhook', 'Тест вебхука')}
              </Button>
            </div>
            <Input
              label={t('settings.alertEmail', 'Email для оповещений')}
              value={notifConfig.email}
              onChange={(e) => setNotifConfig((p) => ({ ...p, email: e.target.value }))}
              placeholder="alerts@example.com"
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberField label={t('settings.alertErrorRate', 'Порог ошибок')} value={notifConfig.alert_error_rate} suffix="%" onChange={(v) => setNotifConfig((p) => ({ ...p, alert_error_rate: v }))} />
              <NumberField label={t('settings.alertLatency', 'Порог задержки')} value={notifConfig.alert_latency} suffix="ms" onChange={(v) => setNotifConfig((p) => ({ ...p, alert_latency: v }))} />
              <NumberField label={t('settings.alertKeyFailures', 'Сбои ключей')} value={notifConfig.alert_key_failures} onChange={(v) => setNotifConfig((p) => ({ ...p, alert_key_failures: v }))} />
            </div>
            <Button size="sm" onClick={handleSaveNotifConfig} loading={setNotifConfigMut.isPending}>
              {t('settings.saveNotif', 'Сохранить настройки уведомлений')}
            </Button>
          </div>
        )}
      </Card>

      <Card glass title={t('settings.globalChatTitle', 'Глобальный чат')} subtitle={t('settings.globalChatSubtitle', 'Включение/отключение канала Global Lounge для всех пользователей')} action={<MessageSquare size={15} className="text-text-muted" />}>
        {globalChatQ.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="flex items-center justify-between">
            <div className="text-sm text-text-muted">
              {t('settings.globalChatState', 'Канал')}{' '}
              <span className={globalChatQ.data?.enabled ? 'text-emerald-400' : 'text-red-400'}>
                {globalChatQ.data?.enabled ? t('settings.enabled', 'включён') : t('settings.disabled', 'выключен')}
              </span>
            </div>
            <Button
              size="sm"
              variant={globalChatQ.data?.enabled ? 'danger' : 'primary'}
              onClick={() => setGlobalChatMut.mutate(
                !globalChatQ.data?.enabled,
                { onSuccess: () => toast.success(t('toast.updated')), onError: () => toast.error(t('toast.updateFailed')) },
              )}
              loading={setGlobalChatMut.isPending}
            >
              {globalChatQ.data?.enabled ? t('settings.disable', 'Выключить') : t('settings.enable', 'Включить')}
            </Button>
          </div>
        )}
      </Card>

      <Card glass title={t('settings.cacheTitle', 'Кеширование ответов')} subtitle={t('settings.cacheSubtitle', 'Кеш одинаковых запросов в Redis со скидкой 50%')} action={<Database size={15} className="text-text-muted" />}>
        {cacheFlagQ.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="flex items-center justify-between">
            <div className="text-sm text-text-muted">
              {t('settings.cacheState', 'Кеширование')}{' '}
              <span className={cacheFlagQ.data?.enabled ? 'text-emerald-400' : 'text-red-400'}>
                {cacheFlagQ.data?.enabled ? t('settings.enabled', 'включено') : t('settings.disabled', 'выключено')}
              </span>
            </div>
            <Button
              size="sm"
              variant={cacheFlagQ.data?.enabled ? 'danger' : 'primary'}
              onClick={() => setCacheFlagMut.mutate(
                !cacheFlagQ.data?.enabled,
                { onSuccess: () => toast.success(t('toast.updated')), onError: () => toast.error(t('toast.updateFailed')) },
              )}
              loading={setCacheFlagMut.isPending}
            >
              {cacheFlagQ.data?.enabled ? t('settings.disable', 'Выключить') : t('settings.enable', 'Включить')}
            </Button>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card glass title={t('settings.auditTitle', 'Журнал аудита')} subtitle={t('settings.auditSubtitle', 'Административные действия')} action={<ScrollText size={15} className="text-text-muted" />}>
          <div className="flex items-center justify-between">
            <div className="text-sm text-text-muted">
              {t('settings.auditState', 'Журнал аудита')}{' '}
              <span className={auditQ.data?.enabled ? 'text-emerald-400' : 'text-red-400'}>
                {auditQ.data?.enabled ? t('settings.enabled', 'включён') : t('settings.disabled', 'выключен')}
              </span>
            </div>
            <Button
              size="sm"
              variant={auditQ.data?.enabled ? 'danger' : 'primary'}
              onClick={() => toggleAuditMut.mutate(
                !auditQ.data?.enabled,
                { onSuccess: () => toast.success(t('toast.updated')), onError: () => toast.error(t('toast.updateFailed')) },
              )}
              loading={toggleAuditMut.isPending}
            >
              {auditQ.data?.enabled ? t('settings.disable', 'Выключить') : t('settings.enable', 'Включить')}
            </Button>
          </div>
        </Card>

        <Card glass title={t('nav.export', 'Экспорт данных')} subtitle={t('settings.exportSubtitle', 'Скачивание данных')} action={<ArrowRight size={15} className="text-text-muted" />}>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => handleExport('csv')} loading={exportMut.isPending}>
                {t('settings.exportCsv', 'Экспорт usage (CSV)')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => handleExport('json')} loading={exportMut.isPending}>
                {t('settings.exportJson', 'Экспорт usage (JSON)')}
              </Button>
            </div>
            <Link
              to="/export"
              className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-white"
            >
              {t('settings.openExportPage', 'Перейти на страницу экспорта')} <ArrowRight size={12} />
            </Link>
            <div className="rounded-lg border border-white/8 bg-surface p-3">
              <div className="text-xs text-text-muted">{t('settings.configKeys', 'Ключи конфигурации')}</div>
              <div className="mt-1 text-sm text-white">{configMap.size} {t('settings.configKeysUnit', 'ключей')}</div>
              {configMap.size > 0 && (
                <div className="mt-2 space-y-1">
                  {Array.from(configMap.keys()).slice(0, 5).map((key) => (
                    <div key={key} className="text-xs text-text-muted">
                      <code className="text-white">{key}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* Admin PIN & trusted devices */}
      <div className="mt-6">
        <PinSecurity />
      </div>

      <div className="flex items-center gap-2 text-xs text-text-muted">
        <SettingsIcon size={13} />
        {t('settings.changesImmediate', 'Изменения применяются сразу после сохранения.')}
      </div>
      {confirmDialog}
    </div>
  )
}

function RateLimitRow({
  rl,
  onDelete,
}: {
  rl: { id: string; scope: string; scope_id?: string | null; rpm: number; tpm: number }
  onDelete: () => void
}) {
  const updateMut = useUpdateRateLimitMutation()
  const [rpm, setRpm] = useState(rl.rpm)
  const [tpm, setTpm] = useState(rl.tpm)

  useEffect(() => {
    setRpm(rl.rpm)
    setTpm(rl.tpm)
  }, [rl.rpm, rl.tpm])

  const commit = (nextRpm: number, nextTpm: number) => {
    if (nextRpm === rl.rpm && nextTpm === rl.tpm) return
    updateMut.mutate(
      { id: rl.id, patch: { rpm: nextRpm, tpm: nextTpm, scope: rl.scope, scope_id: rl.scope_id ?? undefined } },
      { onError: () => { setRpm(rl.rpm); setTpm(rl.tpm) } },
    )
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-white/8 bg-surface px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="text-sm text-white">{rl.scope}</span>
        {rl.scope_id && <span className="text-xs text-text-muted">{rl.scope_id.slice(0, 8)}</span>}
        <input
          type="number"
          value={rpm}
          onChange={(e) => setRpm(parseInt(e.target.value) || 0)}
          onBlur={() => commit(rpm, tpm)}
          className="h-7 w-16 rounded border border-white/10 bg-bg-base px-2 text-xs text-white focus:border-white/30 focus:outline-none"
          title="RPM"
        />
        <span className="text-xs text-text-muted">rpm</span>
        <input
          type="number"
          value={tpm}
          onChange={(e) => setTpm(parseInt(e.target.value) || 0)}
          onBlur={() => commit(rpm, tpm)}
          className="h-7 w-20 rounded border border-white/10 bg-bg-base px-2 text-xs text-white focus:border-white/30 focus:outline-none"
          title="TPM"
        />
        <span className="text-xs text-text-muted">tpm</span>
      </div>
      <button onClick={onDelete} className="text-text-muted hover:text-red-400">
        ×
      </button>
    </div>
  )
}
