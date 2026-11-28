import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import Logo from '../../components/ui/Logo/Logo'
import { useAuthStore } from '../../store/auth.store'
import { whileHoverWide, whileTapWide, springHover } from '../../utils/motionPresets'
import './LoginScreen.css'

interface LoginScreenProps {
  /** Вызывается когда юзер выбрал гостевой режим. */
  onContinueAsGuest?: () => void
}

/**
 * Экран входа через Syntee-Gateway.
 *
 * Показывается при первом запуске (вместо OnboardingPage) или когда юзер
 * вышел из аккаунта. Кнопка «Войти» открывает браузер на consent-странице
 * gateway; после разрешения сайт редиректит на synteehelper://auth/callback
 * и main-процесс обменивает код на JWT, после чего шлёт событие logged-in.
 *
 * Гостевой режим даёт доступ ко всему, кроме моделей gateway/профиля/биллинга.
 */
export default function LoginScreen({ onContinueAsGuest }: LoginScreenProps) {
  const reduceMotion = useReducedMotion()
  const [waiting, setWaiting] = useState(false)
  const { load, error, clearError } = useAuthStore()

  // Подписка на успешный вход (deep-link callback отработал в main).
  useEffect(() => {
    const off = window.syntee.auth.onLoggedIn(() => setWaiting(false))
    return () => { off() }
  }, [])

  // Фолбэк: polling токенов каждые 2с. Если deep-link callback отработал
  // в main (токены сохранены), но auth:logged-in event не дошёл до renderer
  // (например, second-instance event не сработал на Windows), мы всё равно
  // обнаружим токены и продолжим вход.
  useEffect(() => {
    if (!waiting) return
    const interval = setInterval(async () => {
      try {
        const isLoggedIn = await window.syntee.auth.isLoggedIn()
        if (isLoggedIn) {
          setWaiting(false)
          load()
        }
      } catch { /* ignore */ }
    }, 2000)
    return () => clearInterval(interval)
  }, [waiting, load])

  // Подписка на ошибку обмена кода.
  useEffect(() => {
    const off = window.syntee.auth.onLoginError((err) => {
      setWaiting(false)
      useAuthStore.setState({ error: err.message })
    })
    return () => { off() }
  }, [])

  // Таймаут ожидания: если deep-link callback не вернулся за 120с
  // (gateway не запущен, протокол сломан, second-instance не сработал) —
  // сбрасываем waiting и показываем понятную ошибку вместо вечного виса.
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => {
      setWaiting(false)
      useAuthStore.setState({
        error: 'Не дождались ответа от браузера за 2 минуты. Откройте Syntee Helper по запросу браузера или попробуйте войти ещё раз.',
      })
    }, 120_000)
    return () => clearTimeout(timer)
  }, [waiting])

  const handleLogin = async () => {
    clearError()
    setWaiting(true)
    try {
      await window.syntee.auth.login()
    } catch (err) {
      setWaiting(false)
      useAuthStore.setState({ error: err instanceof Error ? err.message : 'Не удалось открыть браузер' })
    }
  }

  const handleCancel = () => {
    setWaiting(false)
    clearError()
  }

  return (
    <div className="login-screen">
      <div className="login-screen__bg" />
      <div className="login-screen__content">
        <div className="login-screen__logo">
          <Logo size={56} />
        </div>

        <h1 className="login-screen__title">Syntee Helper</h1>
        <p className="login-screen__subtitle">
          Войдите через Syntee-Gateway, чтобы получить доступ к моделям, балансу и профилю
        </p>

        {error && (
          <div className="login-screen__error">
            <AppIcon name="alertCircle" size="sm" />
            <span>{error}</span>
          </div>
        )}

        <motion.button
          type="button"
          className="login-screen__btn login-screen__btn--primary"
          onClick={waiting ? handleCancel : handleLogin}
          disabled={false}
          whileHover={reduceMotion ? undefined : whileHoverWide}
          whileTap={reduceMotion ? undefined : whileTapWide}
          transition={springHover}
        >
          {waiting ? (
            <>
              <AppIcon name="loader" size="sm" animation="spin" />
              <span>Отмена ожидания…</span>
            </>
          ) : (
            <>
              <AppIcon name="globe" size="sm" />
              <span>Войти через Syntee</span>
            </>
          )}
        </motion.button>

        <motion.button
          type="button"
          className="login-screen__btn login-screen__btn--ghost"
          onClick={onContinueAsGuest}
          disabled={false}
          whileHover={reduceMotion ? undefined : whileHoverWide}
          whileTap={reduceMotion ? undefined : whileTapWide}
          transition={springHover}
        >
          <AppIcon name="user" size="sm" />
          <span>Продолжить как гость</span>
        </motion.button>

        <p className="login-screen__hint">
          Гостевой режим: свои провайдеры и локальные модели, без моделей gateway и биллинга.
        </p>
      </div>
    </div>
  )
}
