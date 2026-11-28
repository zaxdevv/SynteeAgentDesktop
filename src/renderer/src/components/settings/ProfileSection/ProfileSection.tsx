import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import AppIcon from '../../ui/AppIcon/AppIcon'
import { copyToClipboard } from '@renderer/utils/clipboard'
import Identicon from '../../ui/Identicon/Identicon'
import { useAuthStore, type GatewayUser } from '../../../store/auth.store'
import { useBillingStore } from '../../../store/billing.store'
import { useToast } from '../../ui/Toast/Toast'
import { whileHoverWide, whileTapWide, springHover, whileHoverSm, whileTapSm, whileHoverTiny, whileTapTiny } from '../../../utils/motionPresets'
import './ProfileSection.css'

interface ApiKey {
  id: string
  name: string
  key_prefix: string
  is_active: boolean
  rpm_limit: number | null
  tpm_limit: number | null
  last_used_at: string | null
  created_at: string
}

interface ApiKeyCreated extends ApiKey {
  raw_key: string
}

/**
 * Секция «Профиль» в настройках.
 *
 * Показывает: аватар + имя + email (редактируемые), смену пароля,
 * управление API-ключами sk-syntee-*, баланс, тарифный план, лимиты, usage.
 * Для гостей — приглашение войти.
 */
export default function ProfileSection() {
  const user = useAuthStore(s => s.user)
  const load = useAuthStore(s => s.load)
  const billingLoad = useBillingStore(s => s.load)
  const billingLoadTransactions = useBillingStore(s => s.loadTransactions)
  const billingLoadUsage = useBillingStore(s => s.loadUsage)

  // Загружаем биллинг при открытии профиля.
  useEffect(() => {
    if (user) {
      billingLoad()
      billingLoadTransactions(20)
      billingLoadUsage(24)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  if (!user) {
    return <GuestProfile />
  }

  return (
    <div className="profile-section">
      <SectionTitle>Профиль</SectionTitle>
      <p className="profile-section__subtitle">
        Управляйте аккаунтом Syntee-Gateway: профиль, баланс, тариф и использование.
      </p>

      <ProfileHeader user={user} />
      <BillingSection />
      <ProfileForm user={user} onUpdated={load} />
      <PasswordForm />
      <ApiKeysSection />
    </div>
  )
}

function GuestProfile() {
  const [waiting, setWaiting] = useState(false)
  const { add: toast } = useToast()

  // Подписка на успешный вход (deep-link callback отработал в main).
  useEffect(() => {
    const off = window.syntee.auth.onLoggedIn(() => setWaiting(false))
    return () => { off() }
  }, [])

  // Подписка на ошибку обмена кода.
  useEffect(() => {
    const off = window.syntee.auth.onLoginError((err) => {
      setWaiting(false)
      toast(err.message || 'Ошибка авторизации', 'error')
    })
    return () => { off() }
  }, [toast])

  // Таймаут: если deep-link не вернулся за 120с — сбрасываем.
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => {
      setWaiting(false)
      toast('Не дождались ответа от браузера за 2 минуты. Проверьте, что Syntee-Gateway запущен.', 'error')
    }, 120_000)
    return () => clearTimeout(timer)
  }, [waiting, toast])

  const handleLogin = async () => {
    setWaiting(true)
    try {
      await window.syntee.auth.login()
    } catch (err) {
      setWaiting(false)
      toast(err instanceof Error ? err.message : 'Не удалось открыть браузер', 'error')
    }
  }

  const handleCancel = () => {
    setWaiting(false)
  }

  return (
    <div className="profile-section">
      <SectionTitle>Профиль</SectionTitle>
      <div className="profile-guest">
        <div className="profile-guest__icon">
          <AppIcon name="user" size="lg" />
        </div>
        <h3>Вы вошли как гость</h3>
        <p>
          Войдите через Syntee-Gateway, чтобы получить доступ к моделям, балансу,
          тарифам и синхронизации профиля.
        </p>
        <motion.button
          type="button"
          className="profile-btn profile-btn--primary"
          onClick={waiting ? handleCancel : handleLogin}
          whileHover={whileHoverWide}
          whileTap={whileTapWide}
          transition={springHover}
        >
          {waiting ? (
            <>
              <AppIcon name="loader" size="sm" animation="spin" />
              Отмена ожидания…
            </>
          ) : (
            <>
              <AppIcon name="globe" size="sm" />
              Войти через Syntee
            </>
          )}
        </motion.button>
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="settings-section-title">{children}</h2>
}

function ProfileHeader({ user }: { user: GatewayUser }) {
  const handle = user.username ? `@${user.username}` : user.email.split('@')[0]
  const displayName = user.display_name || handle
  return (
    <div className="profile-header">
      <Identicon
        seed={user.id || user.email}
        src={user.avatar_url}
        size={72}
        alt={displayName}
      />
      <div className="profile-header__info">
        <div className="profile-header__name">{displayName}</div>
        <div className="profile-header__email">{handle}</div>
        <div className="profile-header__role">
          {user.role === 'user' ? 'Пользователь' : user.role}
        </div>
      </div>
    </div>
  )
}

function ProfileForm({ user, onUpdated }: { user: GatewayUser; onUpdated: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState(user.display_name || '')
  const [avatarUrl, setAvatarUrl] = useState(user.avatar_url || '')
  const [saving, setSaving] = useState(false)
  const { add: toast } = useToast()

  // Username claim state — only relevant while the account still holds an
  // auto-generated placeholder handle (username_is_auto === true).
  const isAuto = !!user.username_is_auto
  const [draftUsername, setDraftUsername] = useState('')
  const [claimTaken, setClaimTaken] = useState(false)
  const [claimChecking, setClaimChecking] = useState(false)
  const [claimSaving, setClaimSaving] = useState(false)

  // Если юзер обновился извне (например, после load) — синхронизируем поля.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDisplayName(user.display_name || '')
    setAvatarUrl(user.avatar_url || '')
  }, [user.display_name, user.avatar_url])

  const dirty = displayName !== (user.display_name || '') || avatarUrl !== (user.avatar_url || '')

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.syntee.profile.update({
        display_name: displayName.trim() || null,
        avatar_url: avatarUrl.trim() || null,
      })
      await onUpdated()
      toast('Профиль обновлён', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось сохранить', 'error')
    } finally {
      setSaving(false)
    }
  }

  const usernameErr = (() => {
    const u = draftUsername.trim().toLowerCase().replace(/^@/, '')
    if (!u) return isAuto ? '' : ''
    if (u.length < 3 || u.length > 32) return '3–32 символа'
    if (!/^[a-z0-9_]+$/.test(u)) return 'Только a-z, 0-9 и _'
    if (/^username\d+$/.test(u)) return 'Зарезервировано системой'
    return ''
  })()
  const usernameValid = !usernameErr && !claimTaken && draftUsername.trim().length > 0

  const checkClaim = async () => {
    if (usernameErr) return
    setClaimChecking(true)
    try {
      const res = await window.syntee.profile.checkUsername(draftUsername.trim().replace(/^@/, ''))
      setClaimTaken(!res.available)
    } catch {
      /* сервер перепроверит при отправке */
    } finally {
      setClaimChecking(false)
    }
  }

  const handleClaim = async () => {
    if (!usernameValid) return
    setClaimSaving(true)
    try {
      await window.syntee.profile.update({ username: draftUsername.trim().toLowerCase().replace(/^@/, '') })
      await onUpdated()
      setDraftUsername('')
      setClaimTaken(false)
      toast('Логин забронирован', 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Не удалось забронировать логин'
      toast(msg, 'error')
    } finally {
      setClaimSaving(false)
    }
  }

  return (
    <div className="profile-form">
      <h3 className="profile-form__title">Основное</h3>

      <label className="profile-field">
        <span className="profile-field__label">Логин (username)</span>
        {isAuto ? (
          <>
            <input
              type="text"
              className="profile-field__input"
              value={draftUsername}
              onChange={(e) => { setDraftUsername(e.target.value); setClaimTaken(false) }}
              onBlur={checkClaim}
              placeholder={user.username ?? 'выберите_логин'}
            />
            <span className="profile-field__hint">
              {claimChecking ? 'Проверка…' :
                usernameErr ? usernameErr :
                claimTaken ? 'Этот логин уже занят' :
                '3–32 символа: a-z, 0-9, _. Задаётся один раз, затем неизменен.'}
            </span>
            <motion.button
              type="button"
              className="profile-btn profile-btn--primary"
              onClick={handleClaim}
              disabled={!usernameValid || claimSaving}
              style={{ marginTop: 8 }}
              whileHover={whileHoverWide}
              whileTap={whileTapWide}
              transition={springHover}
            >
              {claimSaving ? (
                <>
                  <AppIcon name="loader" size="sm" animation="spin" />
                  Бронирование…
                </>
              ) : (
                <>Забронировать логин</>
              )}
            </motion.button>
          </>
        ) : (
          <>
            <input
              type="text"
              className="profile-field__input"
              value={user.username ? `@${user.username}` : ''}
              readOnly
            />
            <span className="profile-field__hint">Логин постоянный и не может быть изменён.</span>
          </>
        )}
      </label>

      <label className="profile-field">
        <span className="profile-field__label">Отображаемое имя</span>
        <input
          type="text"
          className="profile-field__input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Как вас называть"
          maxLength={80}
        />
      </label>

      <label className="profile-field">
        <span className="profile-field__label">URL аватара</span>
        <input
          type="url"
          className="profile-field__input"
          value={avatarUrl}
          onChange={(e) => setAvatarUrl(e.target.value)}
          placeholder="https://..."
        />
        <span className="profile-field__hint">
          Оставьте пустым для сгенерированного идентикона
        </span>
      </label>

      <div className="profile-field__row">
        <label className="profile-field profile-field--readonly">
          <span className="profile-field__label">Email</span>
          <input
            type="email"
            className="profile-field__input"
            value={user.email}
            readOnly
          />
        </label>
      </div>

      <motion.button
        type="button"
        className="profile-btn profile-btn--primary"
        onClick={handleSave}
        disabled={!dirty || saving}
        whileHover={whileHoverWide}
        whileTap={whileTapWide}
        transition={springHover}
      >
        {saving ? (
          <>
            <AppIcon name="loader" size="sm" animation="spin" />
            Сохранение…
          </>
        ) : (
          <>Сохранить</>
        )}
      </motion.button>
    </div>
  )
}

function PasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { add: toast } = useToast()

  const handleSave = async () => {
    setError(null)
    if (next !== confirm) {
      setError('Пароли не совпадают')
      return
    }
    if (next.length < 6) {
      setError('Минимум 6 символов')
      return
    }
    setSaving(true)
    try {
      await window.syntee.profile.changePassword(current, next)
      setCurrent(''); setNext(''); setConfirm('')
      toast('Пароль изменён', 'success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сменить пароль')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="profile-form">
      <h3 className="profile-form__title">Смена пароля</h3>

      <label className="profile-field">
        <span className="profile-field__label">Текущий пароль</span>
        <input
          type="password"
          className="profile-field__input"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
      </label>
      <label className="profile-field">
        <span className="profile-field__label">Новый пароль</span>
        <input
          type="password"
          className="profile-field__input"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      <label className="profile-field">
        <span className="profile-field__label">Подтвердите новый пароль</span>
        <input
          type="password"
          className="profile-field__input"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </label>

      {error && <div className="profile-error">{error}</div>}

      <motion.button
        type="button"
        className="profile-btn"
        onClick={handleSave}
        disabled={!current || !next || saving}
        whileHover={whileHoverWide}
        whileTap={whileTapWide}
        transition={springHover}
      >
        {saving ? 'Сохранение…' : 'Сменить пароль'}
      </motion.button>
    </div>
  )
}

function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [newKeyName, setNewKeyName] = useState('')
  const [creating, setCreating] = useState(false)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const { add: toast } = useToast()

  const refresh = useCallback(async () => {
    try {
      const list = await window.syntee.profile.listApiKeys() as ApiKey[]
      setKeys(list)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось загрузить ключи', 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { refresh() }, [refresh])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const created = await window.syntee.profile.createApiKey(
        newKeyName.trim() || 'SynteeHelper',
      ) as ApiKeyCreated
      setRevealedKey(created.raw_key)
      setCopied(false)
      setNewKeyName('')
      await refresh()
      toast('Ключ создан', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось создать ключ', 'error')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить ключ? Это действие необратимо.')) return
    try {
      await window.syntee.profile.deleteApiKey(id)
      await refresh()
      toast('Ключ удалён', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось удалить', 'error')
    }
  }

  const handleCopy = async (key: string) => {
    const ok = await copyToClipboard(key)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      toast('Не удалось скопировать', 'error')
    }
  }

  return (
    <div className="profile-form">
      <h3 className="profile-form__title">API-ключи</h3>
      <p className="profile-form__hint">
        Ключи <code>sk-syntee-*</code> используются для авторизации запросов к
        Syntee-Gateway из внешних скриптов и других приложений.
      </p>

      <div className="profile-apikeys-create">
        <input
          type="text"
          className="profile-field__input"
          value={newKeyName}
          onChange={(e) => setNewKeyName(e.target.value)}
          placeholder="Название ключа (например, Skript)"
        />
        <motion.button
          type="button"
          className="profile-btn"
          onClick={handleCreate}
          disabled={creating}
          whileHover={whileHoverWide}
          whileTap={whileTapWide}
          transition={springHover}
        >
          {creating ? 'Создание…' : 'Создать ключ'}
        </motion.button>
      </div>

      {revealedKey && (
        <div className="profile-apikey-revealed">
          <div className="profile-apikey-revealed__head">
            <AppIcon name="alertCircle" size="sm" />
            <span>Ключ показан один раз — скопируйте сейчас</span>
          </div>
          <code className="profile-apikey-revealed__key">{revealedKey}</code>
          <div className="profile-apikey-revealed__actions">
            <motion.button
              type="button"
              className="profile-btn profile-btn--primary"
              onClick={() => handleCopy(revealedKey)}
              whileHover={whileHoverWide}
              whileTap={whileTapWide}
              transition={springHover}
            >
              <AppIcon name={copied ? 'check' : 'copy'} size="sm" />
              {copied ? 'Скопировано' : 'Копировать'}
            </motion.button>
            <motion.button
              type="button"
              className="profile-btn"
              onClick={() => setRevealedKey(null)}
              whileHover={whileHoverWide}
              whileTap={whileTapWide}
              transition={springHover}
            >
              Закрыть
            </motion.button>
          </div>
        </div>
      )}

      <div className="profile-apikeys-list">
        {loading ? (
          <div className="profile-apikeys-empty">Загрузка…</div>
        ) : keys.length === 0 ? (
          <div className="profile-apikeys-empty">Нет API-ключей</div>
        ) : (
          keys.map((k) => (
            <div key={k.id} className="profile-apikey">
              <div className="profile-apikey__info">
                <div className="profile-apikey__name">{k.name}</div>
                <div className="profile-apikey__prefix">{k.key_prefix}…</div>
                <div className="profile-apikey__meta">
                  {k.last_used_at
                    ? `использован ${new Date(k.last_used_at).toLocaleDateString('ru')}`
                    : 'не использовался'}
                </div>
              </div>
              <motion.button
                type="button"
                className="profile-apikey__delete"
                onClick={() => handleDelete(k.id)}
                title="Удалить"
                whileHover={whileHoverTiny}
                whileTap={whileTapTiny}
                transition={springHover}
              >
                <AppIcon name="trash" size="sm" />
              </motion.button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── Биллинг: баланс, тариф, лимиты, usage ─────────────────────────────────

function BillingSection() {
  const balance = useBillingStore(s => s.balance)
  const planUsage = useBillingStore(s => s.planUsage)
  const summary = useBillingStore(s => s.summary)
  const transactions = useBillingStore(s => s.transactions)
  const timeseries = useBillingStore(s => s.timeseries)
  const breakdown = useBillingStore(s => s.breakdown)
  const loading = useBillingStore(s => s.loading)
  const load = useBillingStore(s => s.load)
  const loadTransactions = useBillingStore(s => s.loadTransactions)
  const loadUsage = useBillingStore(s => s.loadUsage)

  const handleRefresh = () => {
    load()
    loadTransactions(20)
    loadUsage(24)
  }

  const handleTopup = () => {
    window.syntee.billing.openTopup()
  }

  if (loading && !balance && !planUsage) {
    return (
      <div className="profile-form">
        <div className="profile-apikeys-empty">Загрузка биллинга…</div>
      </div>
    )
  }

  return (
    <>
      {/* Баланс + тариф */}
      <div className="profile-form">
        <div className="billing-header">
          <h3 className="profile-form__title">Баланс и тариф</h3>
          <motion.button
            type="button"
            className="profile-btn profile-btn--ghost"
            onClick={handleRefresh}
            disabled={loading}
            title="Обновить"
            whileHover={whileHoverTiny}
            whileTap={whileTapTiny}
            transition={springHover}
          >
            {loading ? (
              <AppIcon name="loader" size="sm" animation="spin" />
            ) : (
              <AppIcon name="refreshCw" size="sm" />
            )}
          </motion.button>
        </div>

        <div className="billing-grid">
          {/* Баланс */}
          <div className="billing-card">
            <div className="billing-card__label">Баланс</div>
            <div className="billing-card__value">
              {balance ? `$${balance.balance.toFixed(4)}` : '—'}
            </div>
            {balance && balance.held > 0 && (
              <div className="billing-card__sub">
                в холде: ${balance.held.toFixed(4)}
              </div>
            )}
            <motion.button
              type="button"
              className="profile-btn profile-btn--primary billing-topup-btn"
              onClick={handleTopup}
              whileHover={whileHoverWide}
              whileTap={whileTapWide}
              transition={springHover}
            >
              <AppIcon name="plus" size="sm" />
              Пополнить
            </motion.button>
          </div>

          {/* Тариф */}
          <div className="billing-card">
            <div className="billing-card__label">Тариф</div>
            <div className="billing-card__value">
              {planUsage?.plan.name ?? 'Free'}
            </div>
            <div className="billing-card__sub">
              {planUsage?.plan.price_rub
                ? `${planUsage.plan.price_rub} ₽/мес`
                : 'Бесплатный'}
            </div>
          </div>
        </div>

        {/* Лимиты стоимости */}
        {planUsage && planUsage.usage.five_hour.limit > 0 && (
          <LimitBar
            label="5 часов"
            used={planUsage.usage.five_hour.used}
            total={planUsage.usage.five_hour.limit}
            resetAt={planUsage.usage.five_hour.reset_at}
          />
        )}
        {planUsage && planUsage.usage.weekly.limit > 0 && (
          <LimitBar
            label="Неделя"
            used={planUsage.usage.weekly.used}
            total={planUsage.usage.weekly.limit}
            resetAt={planUsage.usage.weekly.reset_at}
          />
        )}
        {planUsage && planUsage.usage.monthly.limit > 0 && (
          <LimitBar
            label="Месяц"
            used={planUsage.usage.monthly.used}
            total={planUsage.usage.monthly.limit}
            resetAt={planUsage.usage.monthly.reset_at}
          />
        )}
      </div>

      {/* Usage summary */}
      {summary && (
        <div className="profile-form">
          <h3 className="profile-form__title">За 24 часа</h3>
          <div className="billing-summary">
            <div className="billing-summary-item">
              <div className="billing-summary-item__value">{summary.total_requests}</div>
              <div className="billing-summary-item__label">запросов</div>
            </div>
            <div className="billing-summary-item">
              <div className="billing-summary-item__value">
                {formatTokens(summary.total_input_tokens + summary.total_output_tokens)}
              </div>
              <div className="billing-summary-item__label">токенов</div>
            </div>
            <div className="billing-summary-item">
              <div className="billing-summary-item__value">
                ${summary.total_cost.toFixed(4)}
              </div>
              <div className="billing-summary-item__label">потрачено</div>
            </div>
          </div>

          {/* График по часам (простые CSS-бары) */}
          {timeseries.length > 0 && (
            <div className="billing-chart">
              <div className="billing-chart__title">Запросы по часам</div>
              <div className="billing-chart__bars">
                {(() => {
                  const max = Math.max(...timeseries.map(x => x.requests), 1)
                  return timeseries.map((p, i) => {
                  const h = Math.max(2, (p.requests / max) * 60)
                  return (
                    <div
                      key={i}
                      className="billing-chart__bar"
                      style={{ height: `${h}px` }}
                      title={`${new Date(p.timestamp).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })} · ${p.requests} зап · $${p.cost.toFixed(4)}`}
                    />
                  )
                  })
                })()}
              </div>
            </div>
          )}

          {/* Breakdown по моделям */}
          {breakdown.length > 0 && (
            <div className="billing-breakdown">
              <div className="billing-chart__title">По моделям</div>
              {breakdown.slice(0, 5).map((b) => (
                <div key={b.key} className="billing-breakdown-row">
                  <span className="billing-breakdown-row__name">{b.key}</span>
                  <span className="billing-breakdown-row__reqs">{b.requests} зап</span>
                  <span className="billing-breakdown-row__tokens">{formatTokens(b.tokens)} tok</span>
                  <span className="billing-breakdown-row__cost">${b.cost.toFixed(4)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Транзакции */}
      {transactions.length > 0 && (
        <div className="profile-form">
          <h3 className="profile-form__title">Последние транзакции</h3>
          <div className="billing-transactions">
            {transactions.slice(0, 10).map((t) => (
              <div key={t.id} className="billing-tx">
                <div className="billing-tx__info">
                  <span className={`billing-tx__type billing-tx__type--${t.type}`}>
                    {TX_LABELS[t.type] ?? t.type}
                  </span>
                  <span className="billing-tx__date">
                    {new Date(t.created_at).toLocaleString('ru', {
                      day: 'numeric', month: 'short',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </div>
                <div className="billing-tx__amount">
                  {t.amount >= 0 ? '+' : ''}{t.amount.toFixed(4)}
                  {t.input_tokens != null && t.input_tokens > 0 && (
                    <span className="billing-tx__tokens">
                      {' '} · {formatTokens(t.input_tokens + (t.output_tokens ?? 0))} tok
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

const TX_LABELS: Record<string, string> = {
  topup: 'Пополнение',
  spend: 'Списание',
  refund: 'Возврат',
  hold: 'Холд',
  hold_release: 'Снятие холда',
  deduct: 'Списание',
}

function LimitBar({
  label, used, total, resetAt,
}: { label: string; used: number; total: number; resetAt: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  const remaining = Math.max(0, total - used)
  const resetLabel = resetAt
    ? `сброс ${new Date(resetAt).toLocaleString('ru', { hour: '2-digit', minute: '2-digit' })}`
    : ''
  const isCritical = pct >= 90
  const isWarning = pct >= 70 && pct < 90

  return (
    <div className="billing-limit">
      <div className="billing-limit__head">
        <span className="billing-limit__label">{label}</span>
        <span className="billing-limit__nums">
          {formatCost(used)} / {formatCost(total)}
        </span>
      </div>
      <div className="billing-limit__bar">
        <div
          className={`billing-limit__fill ${
            isCritical ? 'billing-limit__fill--critical' :
            isWarning ? 'billing-limit__fill--warning' : ''
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="billing-limit__foot">
        <span>осталось {formatCost(remaining)}</span>
        {resetLabel && <span className="billing-limit__reset">{resetLabel}</span>}
      </div>
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatCost(n: number): string {
  if (n < 0.01) return `${n.toFixed(4)}`
  return `${n.toFixed(2)}`
}
