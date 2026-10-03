// ── DotsPage: always-on фоновые агенты (аналог OpenAI Dots) ──────────────
// Слева — ЛЕНТА Dot'ов (карточки-превью как в мессенджере, группировка
// «Работают / Спят / Выключены»), справа — чат выбранного Dot'а.
// Визард — простая условная отрисовка (без AnimatePresence: fixed-оверлей
// + exit-анимации страницы конфликтуют, оставляем mount-анимацию).
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon, { type IconName, type IconTone } from '../../components/ui/AppIcon/AppIcon'
import ModelSelector from '../../components/ui/ModelSelector/ModelSelector'
import { useToast } from '../../components/ui/Toast/Toast'
import { useDotsStore, pluralDots, type DotTemplate } from '../../store/dots.store'
import type { Dot } from '../../../../shared/types'
import { DotBlob } from './DotBlob'
import { DotCard } from './DotCard'
import { DotChat } from './DotChat'
import { DotWizard } from './DotWizard'
import './DotsPage.css'

/** Шаблоны пустого состояния: клик → визард с предзаполненной задачей
 *  и подходящим триггером (путь «нулевое → рабочий дот» = 2 клика). */
const DOT_TEMPLATES: Array<DotTemplate & { label: string }> = [
  {
    label: 'Дайджест новостей',
    name: 'Дайджест',
    icon: 'globe',
    purpose: 'Собери короткий дайджест главных новостей технологий и AI за прошедший период. 5–7 пунктов, каждый — 1–2 предложения с ссылкой на источник. Если ничего значимого не произошло — промолчи.',
    scheduleKind: 'interval',
    scheduleValue: '21600',
  },
  {
    label: 'Следить за ценой',
    name: 'Наблюдатель за ценой',
    icon: 'dollar',
    purpose: 'Проверь цену на [товар] в [магазине]. Если она упала ниже [цели] или изменилась больше чем на 5% — сообщи новую цену и ссылку. Иначе промолчи.',
    scheduleKind: 'interval',
    scheduleValue: '3600',
  },
  {
    label: 'Страж папки',
    name: 'Страж папки',
    icon: 'folder',
    purpose: 'Проверь изменения в наблюдаемой папке: новые файлы, удаления, крупные правки. Сообщи краткий список изменений. Если изменения тривиальные (временные файлы, кэш) — промолчи.',
    scheduleKind: 'none',
  },
  {
    label: 'Напоминания',
    name: 'Помощник',
    icon: 'bell',
    purpose: 'Напоминай мне о [дело] каждый день. Кратко, одной строкой, с дедлайном если он близко.',
    scheduleKind: 'cron',
    scheduleValue: '0 9 * * *',
  },
]

export default function DotsPage() {
  const { add: toast } = useToast()
  const dots = useDotsStore(s => s.dots)
  const loaded = useDotsStore(s => s.loaded)
  const selectedDotId = useDotsStore(s => s.selectedDotId)
  const runsByDot = useDotsStore(s => s.runsByDot)
  const settings = useDotsStore(s => s.settings)
  const wizard = useDotsStore(s => s.wizard)
  const unreadByDot = useDotsStore(s => s.unreadByDot)
  const { selectDot, loadRuns, setSettings, setWizard } = useDotsStore.getState()

  const [showSettings, setShowSettings] = useState(false)
  // Поиск по ленте Dot'ов (имя + задача). Фильтрует ТОЛЬКО список —
  // сводка в шапке всегда считается по всем Dot'ам.
  const [query, setQuery] = useState('')
  // Минутный тикер: «через 5 мин»/«3 мин назад» на карточках тикают,
  // а не замирают до следующего DOTS_STATE-события.
  const [, setTick] = useState(0)
  const settingsRef = useRef<HTMLDivElement>(null)
  const settingsBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const t = setInterval(() => setTick(v => v + 1), 30_000)
    return () => { clearInterval(t) }
  }, [])

  // Поповер настроек: закрытие по клику мимо и по Esc (раньше не закрывался).
  useEffect(() => {
    if (!showSettings) return
    const onDown = (e: MouseEvent) => {
      const el = settingsRef.current
      const btn = settingsBtnRef.current
      if (el && !el.contains(e.target as Node) && btn && !btn.contains(e.target as Node)) {
        setShowSettings(false)
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowSettings(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [showSettings])

  // Первичная загрузка (push-события DOTS_* слушает App.tsx глобально —
  // бейдж в TitleBar живёт и при закрытой странице; здесь только рефреш
  // данных и настроек при открытии страницы).
  useEffect(() => {
    window.syntee.dots.list().then(d => {
      useDotsStore.setState({ dots: d, loaded: true })
    }).catch(() => {
      useDotsStore.setState({ loaded: true })
    })
    window.syntee.dots.getSettings().then(s => {
      useDotsStore.setState({ settings: s })
    }).catch(() => {})
  }, [])

  // История ранов выбранного Dot'а
  useEffect(() => {
    if (selectedDotId) void loadRuns(selectedDotId)
  }, [selectedDotId, loadRuns, dots])

  const selectedDot: Dot | null = useMemo(
    () => dots.find(d => d.id === selectedDotId) ?? null,
    [dots, selectedDotId],
  )
  const wizardDot: Dot | null = useMemo(
    () => wizard.dotId ? dots.find(d => d.id === wizard.dotId) ?? null : null,
    [dots, wizard.dotId],
  )

  // Поиск: фильтруем ленту по имени и задаче. Сводка в шапке — по всем Dot'ам.
  const filteredDots = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return dots
    return dots.filter(d =>
      d.name.toLowerCase().includes(q) || (d.purpose ?? '').toLowerCase().includes(q),
    )
  }, [dots, query])

  // Группировка: Работают → Спят → Выключены; внутри — по свежести отчёта.
  const groups = useMemo(() => {
    const running: Dot[] = []
    const sleeping: Dot[] = []
    const disabled: Dot[] = []
    for (const d of filteredDots) {
      if (d.state.status === 'running') running.push(d)
      else if (!d.enabled || d.state.status === 'disabled') disabled.push(d)
      else sleeping.push(d)
    }
    const byFresh = (a: Dot, b: Dot) =>
      (b.state.lastReport?.at ?? b.state.lastRunAt ?? 0) - (a.state.lastReport?.at ?? a.state.lastRunAt ?? 0)
    running.sort(byFresh)
    sleeping.sort(byFresh)
    return [
      { key: 'running', title: 'Работают', dots: running },
      { key: 'sleeping', title: 'Спят', dots: sleeping },
      { key: 'disabled', title: 'Выключены', dots: disabled },
    ].filter(g => g.dots.length > 0)
  }, [filteredDots])

  const runningCount = dots.filter(d => d.state.status === 'running').length
  const sleepingCount = dots.filter(d => d.enabled && d.state.status !== 'running').length
  const errorCount = dots.filter(d => d.state.status === 'error').length
  const unreadTotal = Object.values(unreadByDot).reduce((n, v) => n + v, 0)

  /** Мини-статчипы шапки: кто работает / кто спит / кто требует внимания.
   *  Показываются только когда счётчик > 0 — шапка не пухнет от нулей. */
  const statChips = useMemo(() => {
    const out: Array<{
      key: string
      icon: IconName
      tone: IconTone
      value: number
      label: string
      title: string
      live?: boolean
    }> = []
    if (runningCount > 0) {
      out.push({
        key: 'run', icon: 'activity', tone: 'accent', value: runningCount, live: true,
        label: runningCount === 1 ? 'работает' : 'работают',
        title: `${pluralDots(runningCount)} работают прямо сейчас`,
      })
    }
    if (sleepingCount > 0) {
      out.push({
        key: 'sleep', icon: 'clock', tone: 'muted', value: sleepingCount,
        label: 'спят',
        title: `${pluralDots(sleepingCount)} спят и ждут триггера`,
      })
    }
    if (errorCount > 0) {
      out.push({
        key: 'err', icon: 'alertCircle', tone: 'danger', value: errorCount,
        label: errorCount === 1 ? 'с ошибкой' : 'с ошибками',
        title: `${errorCount} пробуждений завершились с ошибкой`,
      })
    }
    if (unreadTotal > 0) {
      out.push({
        key: 'unread', icon: 'messageCircle', tone: 'accent', value: unreadTotal,
        label: 'новых',
        title: `${unreadTotal} новых отчётов`,
      })
    }
    return out
  }, [runningCount, sleepingCount, errorCount, unreadTotal])

  const handleWake = (dot: Dot) => {
    window.syntee.dots.runNow(dot.id).then(res => {
      if (res?.ok) {
        toast('Dot разбужен — смотри чат', 'info')
      } else {
        // Честная причина пропуска вместо «разбужен» из ничего.
        const reason = res?.reason === 'busy'
          ? 'Dot уже работает'
          : res?.reason === 'disabled'
            ? 'Dot выключен — включи его тумблером'
            : res?.reason === 'globally_disabled'
              ? 'Dots на паузе в настройках'
              : 'Не удалось разбудить Dot’а'
        toast(reason, 'error')
      }
    }).catch(() => { toast('Не удалось разбудить Dot’а', 'error') })
  }

  const handleToggle = (dot: Dot) => {
    window.syntee.dots.update(dot.id, { enabled: !dot.enabled }).then(res => {
      if (res?.ok) {
        toast(dot.enabled ? `Dot «${dot.name}» выключен` : `Dot «${dot.name}» включен`, 'info')
      } else {
        toast(res?.error ?? 'Не удалось переключить Dot’а', 'error')
      }
    }).catch(() => {})
  }

  const handleDelete = (dot: Dot) => {
    window.syntee.dots.delete(dot.id).then(() => {
      if (selectedDotId === dot.id) selectDot(null)
      toast(`Dot «${dot.name}» удалён`, 'info')
    }).catch(() => {})
  }

  return (
    <div className="dots-page">
      {/* Шапка: живая сводка вместо сухого счётчика.
          .dots-header-zone — relative-обёртка, чтобы поповер настроек
          прилипал к низу шапки (top:100%) независимо от её высоты. */}
      <div className="dots-header-zone">
      <div className="dots-header">
        <div className="dots-header-icon">
          <AppIcon name="orbit" size="md" />
        </div>
        <div className="dots-header-text">
          <div className="dots-header-title">Dots</div>
          {dots.length === 0 ? (
            <div className="dots-header-sub">
              <span className="dots-header-hint">всегда-живущие агенты</span>
            </div>
          ) : (
            <motion.div
              className="dots-header-sub dots-stat-chips"
              initial="hidden"
              animate="visible"
              variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.05, delayChildren: 0.03 } } }}
            >
              {statChips.map(c => (
                <motion.span
                  key={c.key}
                  className={`dots-stat-chip dots-stat-chip--${c.tone}`}
                  title={c.title}
                  variants={{
                    hidden: { opacity: 0, y: -4, scale: 0.94 },
                    visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] } },
                  }}
                >
                  {c.live
                    ? <span className="dots-header-live-dot" />
                    : <AppIcon name={c.icon} size="xs" tone={c.tone} />}
                  <span className="dots-stat-chip-num">{c.value}</span>
                  <span className="dots-stat-chip-label">{c.label}</span>
                </motion.span>
              ))}
            </motion.div>
          )}
        </div>
        <div className="dots-header-spacer" />
        <button
          ref={settingsBtnRef}
          type="button"
          className={`dots-header-btn${showSettings ? ' dots-header-btn--active' : ''}`}
          onClick={() => setShowSettings(v => !v)}
        >
          <AppIcon name="settings" size="xs" /> Настройки
        </button>
        <button
          type="button"
          className="dots-header-btn dots-header-btn--primary"
          onClick={() => setWizard(true)}
        >
          <AppIcon name="plus" size="xs" /> Создать
        </button>
      </div>

      {/* Настройки Dots (поповер: клик мимо / Esc — закрыть) */}
      <AnimatePresence>
        {showSettings && settings && (
          <motion.div
            className="dots-settings"
            ref={settingsRef}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
          >
          <div className="dots-settings-row">
            <div>
              <div className="dots-settings-label">Dots включены</div>
              <div className="dots-settings-hint">Главный тумблер: пауза для всех триггеров</div>
            </div>
            <button
              type="button"
              className={`dots-toggle${settings.enabled ? ' dots-toggle--on' : ''}`}
              onClick={() => void setSettings({ enabled: !settings.enabled })}
            />
          </div>
          <div className="dots-settings-row">
            <div>
              <div className="dots-settings-label">Уведомления</div>
              <div className="dots-settings-hint">Трей/overlay, когда Dot просыпается с отчётом</div>
            </div>
            <button
              type="button"
              className={`dots-toggle${settings.notify ? ' dots-toggle--on' : ''}`}
              onClick={() => void setSettings({ notify: !settings.notify })}
            />
          </div>
          <div>
            <div className="dots-settings-label" style={{ marginBottom: 6 }}>Модель по умолчанию</div>
            <ModelSelector
              modelId={settings.modelId ?? ''}
              providerId={settings.modelProvider ?? undefined}
              onChange={(modelId, providerId) => void setSettings({ modelId, modelProvider: providerId })}
            />
            <div className="dots-settings-hint" style={{ marginTop: 6 }}>
              Применяется к НОВЫМ Dot’ам без своей модели. Пусто = назначение main.
            </div>
          </div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>

      {/* Тело: список + чат */}
      <div className="dots-body">
        {/* Левая колонка — «мессенджерный» сайдбар: поиск + лента Dot'ов */}
        <div className="dots-sidebar">
          {/* Поиск показываем только когда есть что искать */}
          {dots.length > 0 && (
            <div className="dots-search">
              <AppIcon name="search" size="xs" className="dots-search-icon" />
              <input
                className="dots-search-input"
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Поиск Dot’ов…"
                spellCheck={false}
                aria-label="Поиск Dot’ов"
              />
              {query && (
                <button
                  type="button"
                  className="dots-search-clear"
                  title="Очистить"
                  onClick={() => setQuery('')}
                >
                  <AppIcon name="x" size="xs" />
                </button>
              )}
            </div>
          )}

          <div className="dots-list">
            {/* Skeleton при загрузке */}
            {!loaded && [0, 1, 2].map(i => (
              <div key={`sk-${i}`} className="dot-card-skeleton">
                <div className="dot-card-skeleton-avatar" />
                <div className="dot-card-skeleton-lines">
                  <div className="dot-card-skeleton-line" style={{ width: '62%' }} />
                  <div className="dot-card-skeleton-line" style={{ width: '88%' }} />
                  <div className="dot-card-skeleton-line" style={{ width: '40%' }} />
                </div>
              </div>
            ))}

            {loaded && dots.length === 0 && (
              <div className="dots-list-empty">
                <DotBlob color="#7c6cff" icon="bot" status="sleeping" size={56} />
                <div className="dots-list-empty-title">Пока пусто</div>
                <div className="dots-list-empty-text">
                  Создай Dot’а с нуля — или начни с готового шаблона:
                </div>
                <div className="dots-templates">
                  {DOT_TEMPLATES.map(t => (
                    <button
                      key={t.label}
                      type="button"
                      className="dots-template"
                      onClick={() => setWizard(true, undefined, t)}
                    >
                      <AppIcon name={(t.icon ?? 'bot') as 'bot'} size="xs" />
                      <span>{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Есть Dot'ы, но поиск ничего не нашёл */}
            {loaded && dots.length > 0 && filteredDots.length === 0 && (
              <div className="dots-list-nores">
                <AppIcon name="search" size="lg" className="dots-list-nores-icon" />
                <div className="dots-list-nores-title">Ничего не найдено</div>
                <div className="dots-list-nores-text">Попробуй другое имя или задачу</div>
              </div>
            )}

            {groups.map(g => (
              <motion.div
                key={g.key}
                layout
                className="dots-group"
                exit={{ opacity: 0, y: -6, transition: { duration: 0.15, ease: 'easeOut' } }}
              >
                <div className="dots-group-title">
                  {g.title}
                  <span className="dots-group-count">{g.dots.length}</span>
                </div>
                <AnimatePresence>
                  {g.dots.map((dot, i) => (
                    <DotCard
                      key={dot.id}
                      dot={dot}
                      index={i}
                      selected={dot.id === selectedDotId}
                      unread={unreadByDot[dot.id] ?? 0}
                      onSelect={() => selectDot(dot.id)}
                      onWake={() => handleWake(dot)}
                      onToggle={() => handleToggle(dot)}
                      onEdit={() => setWizard(true, dot.id)}
                      onDelete={() => handleDelete(dot)}
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Правая панель: чат выбранного Dot'а ↔ пустое состояние.
            mode="wait" — панели не наслаиваются в flex-строке; exit — только
            числовые значения + tween (spring/pointerEvents в exit ломают выход). */}
        <AnimatePresence mode="wait" initial={false}>
          {selectedDot ? (
            <motion.div
              key={selectedDot.chatId}
              className="dots-panel"
              initial={{ opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0, transition: { duration: 0.18, ease: 'easeOut' } }}
              exit={{ opacity: 0, x: -10, transition: { duration: 0.1, ease: 'easeOut' } }}
            >
              <DotChat
                dot={selectedDot}
                runs={runsByDot[selectedDot.id] ?? []}
                onWake={() => handleWake(selectedDot)}
              />
            </motion.div>
          ) : (
            <motion.div
              key="dots-empty-panel"
              className="dots-panel"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.16, ease: 'easeOut' } }}
              exit={{ opacity: 0, transition: { duration: 0.1, ease: 'easeOut' } }}
            >
              <div className="dots-empty">
                <motion.div
                  className="dots-empty-blob"
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <DotBlob color="#7c6cff" icon="orbit" status="sleeping" size={96} />
                </motion.div>
                <div className="dots-empty-title">Твои Dot’ы ждут задач</div>
                <div className="dots-empty-text">
                  Dot — это агент, который живёт в фоне: просыпается по расписанию,
                  следит за тем, что важно тебе, и сам пишет, когда есть новости.
                  Если новостей нет — молчит.
                </div>
                <div className="dots-templates dots-templates--center">
                  {DOT_TEMPLATES.map(t => (
                    <button
                      key={t.label}
                      type="button"
                      className="dots-template"
                      onClick={() => setWizard(true, undefined, t)}
                    >
                      <AppIcon name={(t.icon ?? 'bot') as 'bot'} size="xs" />
                      <span>{t.label}</span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="dots-header-btn dots-header-btn--primary"
                  onClick={() => setWizard(true)}
                >
                  <AppIcon name="plus" size="xs" /> Создать с нуля
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Визард — простая условная отрисовка (см. комментарий в шапке файла) */}
      {wizard.open && (
        <DotWizard
          dot={wizardDot}
          template={wizard.template}
          onClose={() => setWizard(false)}
        />
      )}
    </div>
  )
}
