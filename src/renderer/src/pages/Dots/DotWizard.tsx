// ── DotWizard: создание/редактирование Dot'а ─────────────────────────────
// Задача-в-фокусе + ТРИГГЕРЫ на первом экране (расписание — суть Dot'а,
// не «продвинутая» настройка: дот без будильника = мёртвый дот).
// Внешность (имя/иконка/цвет) и правила — в сворачиваемом блоке ниже.
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import ModelSelector from '../../components/ui/ModelSelector/ModelSelector'
import { useToast } from '../../components/ui/Toast/Toast'
import { DOT_ICON_PRESETS, DOT_COLOR_PRESETS, type Dot, type DotConfig } from '../../../../shared/types'
import type { DotTemplate } from '../../store/dots.store'
import { DotBlob } from './DotBlob'

interface WizardState {
  name: string
  icon: string
  color: string
  purpose: string
  rules: string
  scheduleKind: 'none' | 'cron' | 'interval'
  scheduleValue: string
  watchPaths: string
  webhookEnabled: boolean
  modelId: string | null
  modelProvider: string | null
}

const INITIAL: WizardState = {
  name: '',
  icon: 'eye',
  color: '#7c6cff',
  purpose: '',
  rules: '',
  scheduleKind: 'none',
  scheduleValue: '3600',
  watchPaths: '',
  webhookEnabled: false,
  modelId: null,
  modelProvider: null,
}

/** Опции интервала (сек). 60с — осознанно: минимум DotManager/manage_dots
 *  и удобно для быстрых тестов; UI раньше начинался с 5 мин. */
const INTERVAL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '60', label: 'каждую минуту' },
  { value: '300', label: 'каждые 5 минут' },
  { value: '900', label: 'каждые 15 минут' },
  { value: '3600', label: 'каждый час' },
  { value: '10800', label: 'каждые 3 часа' },
  { value: '21600', label: 'каждые 6 часов' },
  { value: '43200', label: 'каждые 12 часов' },
  { value: '86400', label: 'раз в день' },
]

/** Человекочитаемый интервал для значений вне пресетов (Dot, созданный
 *  агентом через manage_dots, может иметь любой интервал ≥ 60с). */
function fmtIntervalValue(secStr: string): string {
  const sec = Number(secStr)
  if (!Number.isFinite(sec) || sec < 60) return `каждые ${secStr} с`
  if (sec < 3600) {
    const min = Math.round(sec / 60)
    return `каждые ${min} мин`
  }
  const h = sec / 3600
  return `каждые ${Number.isInteger(h) ? h : h.toFixed(1)} ч`
}

/** Примеры-подсказки для поля задачи: клик вставляет текст в поле. */
const TASK_EXAMPLES = [
  { label: 'цена', text: 'Проверяй цену на [товар] в [магазине]. Если упала ниже [цели] — сообщи. Иначе молчи.' },
  { label: 'дайджест', text: 'Собери короткий дайджест главных новостей за день: 5–7 пунктов по 1–2 предложения. Если ничего значимого — промолчи.' },
  { label: 'папка', text: 'Следи за изменениями в наблюдаемой папке. Сообщай о новых и удалённых файлах. Тривиальные изменения (кэш, временные файлы) игнорируй.' },
]

/** Варианты триггера — сегмент-чипы (первый экран визарда). */
const TRIGGER_CHIPS: Array<{ kind: 'schedule' | 'manual'; icon: string; label: string }> = [
  { kind: 'schedule', icon: 'clock', label: 'Расписание' },
  { kind: 'manual', icon: 'zap', label: 'Вручную' },
]

export function DotWizard({
  dot,
  template,
  onClose,
}: {
  dot?: Dot | null
  /** Предзаполнение из шаблона пустого состояния. */
  template?: DotTemplate | null
  onClose: () => void
}) {
  const { add: toast } = useToast()
  const [st, setSt] = useState<WizardState>(() => {
    if (dot) {
      return {
        name: dot.name,
        icon: dot.icon,
        color: dot.color,
        purpose: dot.purpose,
        rules: dot.rules ?? '',
        scheduleKind: dot.schedule?.kind ?? 'none',
        scheduleValue: dot.schedule?.value ?? '3600',
        watchPaths: (dot.watchPaths ?? []).join('\n'),
        webhookEnabled: !!dot.webhookEnabled,
        modelId: dot.modelId ?? null,
        modelProvider: dot.modelProvider ?? null,
      }
    }
    // Шаблон: задача + триггер + внешность предзаполнены.
    if (template) {
      return {
        ...INITIAL,
        name: template.name ?? '',
        icon: template.icon ?? 'eye',
        purpose: template.purpose,
        scheduleKind: template.scheduleKind ?? 'none',
        scheduleValue: template.scheduleValue ?? '3600',
      }
    }
    return INITIAL
  })
  const [advanced, setAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const set = (patch: Partial<WizardState>) => setSt(s => ({ ...s, ...patch }))

  // Guard от случайной потери данных: клик по оверлею закрывает только
  // «чистую» форму (ничего не введено при создании / не изменено при
  // правке). Esc закрывает всегда — это осознанное действие.
  const pristine = dot
    ? (st.name === dot.name && st.purpose === dot.purpose && st.rules === (dot.rules ?? '')
      && st.icon === dot.icon && st.color === dot.color
      && st.scheduleKind === (dot.schedule?.kind ?? 'none')
      && st.scheduleValue === (dot.schedule?.value ?? '3600')
      && st.watchPaths === (dot.watchPaths ?? []).join('\n')
      && st.webhookEnabled === !!dot.webhookEnabled)
    : (!st.name.trim() && !st.purpose.trim() && !st.rules.trim()
      && st.scheduleKind === 'none' && !st.watchPaths.trim() && !st.webhookEnabled)

  // Esc — закрыть. Фокус в имя — только при создании (не воруем фокус при правке).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    if (!dot && !template) nameInputRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, dot, template])

  const validate = (): string => {
    if (!st.name.trim()) return 'Придумай имя Dot’у'
    if (!st.purpose.trim()) return 'Опиши задачу — это мозг Dot’а'
    if (st.scheduleKind === 'cron') {
      const f = st.scheduleValue.trim().split(/\s+/)
      if (f.length !== 5) return 'Cron — 5 полей: «мин час день месяц день_недели», напр. «0 9 * * *»'
    }
    if (st.scheduleKind === 'interval') {
      const sec = Number(st.scheduleValue)
      if (!Number.isFinite(sec) || sec < 60) return 'Интервал — минимум 60 секунд'
    }
    if (st.watchPaths.trim() && st.watchPaths.trim().split('\n').some(p => !p.trim())) {
      return 'Пустая строка в путях наблюдения'
    }
    return ''
  }

  const save = async () => {
    const err = validate()
    if (err) { setError(err); return }
    setError('')
    setSaving(true)
    try {
      const input = {
        name: st.name.trim(),
        icon: st.icon,
        color: st.color,
        purpose: st.purpose.trim(),
        rules: st.rules.trim() || undefined,
        schedule: st.scheduleKind !== 'none'
          ? { kind: st.scheduleKind as 'cron' | 'interval', value: st.scheduleValue.trim() }
          : undefined,
        watchPaths: st.watchPaths.trim()
          ? st.watchPaths.split('\n').map(p => p.trim()).filter(Boolean)
          : undefined,
        webhookEnabled: st.webhookEnabled,
        modelId: st.modelId,
        modelProvider: st.modelProvider,
      }
      const res = dot
        ? await window.syntee.dots.update(dot.id, input as Partial<DotConfig>)
        : await window.syntee.dots.create(input)
      if (!res.ok) {
        setError(res.error ?? 'Не удалось сохранить')
        return
      }
      toast(dot ? 'Dot обновлён' : `Dot «${st.name.trim()}» создан`, 'success')
      onClose()
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dot-wizard-overlay" onMouseDown={e => { if (e.target === e.currentTarget && pristine) onClose() }}>
      <motion.div
        className="dot-wizard"
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      >
        <div>
          <div className="dot-wizard-title">{dot ? 'Настройка Dot’а' : 'Новый Dot'}</div>
          <div className="dot-wizard-sub">
            Dot — всегда-живущий агент: спит в фоне, просыпается по триггеру, работает в read-only режиме и сам решает — сообщить или промолчать.
          </div>
        </div>

        {/* Задача — главный фокус визарда */}
        <div className="dot-wizard-field">
          <span className="dot-wizard-label">Задача</span>
          <textarea
            className={`dot-wizard-textarea dot-wizard-textarea--task${error && !st.purpose.trim() ? ' dot-wizard-input--invalid' : ''}`}
            value={st.purpose}
            onChange={e => set({ purpose: e.target.value })}
            placeholder="Опиши одним абзацем, что Dot должен делать при каждом пробуждении. Например: «Проверяй цену на RTX 5090 в DNS. Если упадёт ниже 150 000 ₽ — сообщи. Иначе молчи»."
            maxLength={2000}
          />
          {/* Примеры-подсказки: клик вставляет текст в поле */}
          <div className="dot-wizard-examples">
            <span className="dot-wizard-examples-label">примеры:</span>
            {TASK_EXAMPLES.map(ex => (
              <button
                key={ex.label}
                type="button"
                className="dot-wizard-example-chip"
                onClick={() => set({ purpose: ex.text })}
              >
                {ex.label}
              </button>
            ))}
          </div>
          <span className="dot-wizard-hint">
            Это попадает в системный промпт каждого пробуждения. Пиши конкретно: что проверять и что считать «изменением».
          </span>
        </div>

        {/* Триггеры — на первом экране: расписание = суть Dot'а */}
        <div className="dot-wizard-field">
          <span className="dot-wizard-label">Когда будить</span>
          <div className="dot-wizard-chips">
            {TRIGGER_CHIPS.map(c => {
              const active = c.kind === 'schedule'
                ? st.scheduleKind !== 'none'
                : st.scheduleKind === 'none' && !st.watchPaths.trim() && !st.webhookEnabled
              return (
                <button
                  key={c.kind}
                  type="button"
                  className={`dot-wizard-chip${active ? ' dot-wizard-chip--active' : ''}`}
                  style={active ? { borderColor: st.color, color: st.color } : undefined}
                  onClick={() => set({ scheduleKind: c.kind === 'schedule' ? 'interval' : 'none' })}
                >
                  <AppIcon name={c.icon as IconName} size="xs" />
                  <span>{c.label}</span>
                </button>
              )
            })}
            <button
              type="button"
              className={`dot-wizard-chip${st.watchPaths.trim() ? ' dot-wizard-chip--active' : ''}`}
              style={st.watchPaths.trim() ? { borderColor: st.color, color: st.color } : undefined}
              onClick={() => setAdvanced(true)}
              title="Изменения файлов будят Dot'а (настройки — ниже в блоке)"
            >
              <AppIcon name="folder" size="xs" />
              <span>Файлы</span>
            </button>
            <button
              type="button"
              className={`dot-wizard-chip${st.webhookEnabled ? ' dot-wizard-chip--active' : ''}`}
              style={st.webhookEnabled ? { borderColor: st.color, color: st.color } : undefined}
              onClick={() => set({ webhookEnabled: !st.webhookEnabled })}
              title="POST-запрос на локальный URL будит Dot'а"
            >
              <AppIcon name="link" size="xs" />
              <span>Webhook</span>
            </button>
          </div>

          {/* Инлайн-настройка выбранного триггера */}
          {st.scheduleKind === 'interval' && (
            <motion.div
              key="trigger-interval"
              className="dot-wizard-trigger-config"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
            >
              <select
                className="dot-wizard-input"
                value={st.scheduleValue}
                onChange={e => set({ scheduleValue: e.target.value })}
              >
                {/* Значение вне пресетов (создано агентом) — показываем
                    отдельной опцией, иначе селект пустой. */}
                {!INTERVAL_OPTIONS.some(o => o.value === st.scheduleValue) && (
                  <option value={st.scheduleValue}>{fmtIntervalValue(st.scheduleValue)}</option>
                )}
                {INTERVAL_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <button
                type="button"
                className="dot-wizard-cron-switch"
                onClick={() => set({ scheduleKind: 'cron', scheduleValue: '0 9 * * *' })}
              >
                нужно точное время? → cron
              </button>
            </motion.div>
          )}
          {st.scheduleKind === 'cron' && (
            <motion.div
              key="trigger-cron"
              className="dot-wizard-trigger-config"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
            >
              <input
                className="dot-wizard-input"
                value={st.scheduleValue}
                onChange={e => set({ scheduleValue: e.target.value })}
                placeholder="0 9 * * * (каждый день в 9:00)"
              />
              <button
                type="button"
                className="dot-wizard-cron-switch"
                onClick={() => set({ scheduleKind: 'interval', scheduleValue: '3600' })}
              >
                ← интервал
              </button>
              <span className="dot-wizard-hint">5 полей: минута час день месяц день-недели. «0 9 * * 1-5» = будни в 9:00.</span>
            </motion.div>
          )}
          {st.webhookEnabled && (
            <motion.div
              key="trigger-webhook"
              className="dot-wizard-trigger-config"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
            >
              <span className="dot-wizard-hint">
                {'URL появится в чате Dot’а после сохранения (кнопка-ссылка в шапке).'}
              </span>
            </motion.div>
          )}
        </div>

        {/* Внешность и правила — сворачиваемый блок */}
        <button
          type="button"
          className="dot-wizard-advanced-toggle"
          onClick={() => setAdvanced(v => !v)}
        >
          <AppIcon name={advanced ? 'chevronDown' : 'chevronRight'} size="xs" />
          <span>Внешность, файлы и правила</span>
          <span className="dot-wizard-advanced-summary">
            {[
              st.name.trim() || null,
              st.watchPaths.trim() ? `${st.watchPaths.trim().split('\n').filter(Boolean).length} путь(ей)` : null,
              st.rules.trim() ? 'правила' : null,
            ].filter(Boolean).join(' · ') || 'имя, иконка, цвет'}
          </span>
        </button>

        {/* Сворачиваемый блок — CSS-аккордеон (grid-template-rows 0fr→1fr).
            Анимация высоты без JS-замеров framer-motion: контент НИКОГДА не
            клиппится (1fr всегда подстраивается под содержимое — даже когда
            textarea растёт), работает в обе стороны, и модалка скроллится. */}
        <div className={`dot-wizard-advanced-wrap${advanced ? ' dot-wizard-advanced-wrap--open' : ''}`}>
          <div className="dot-wizard-advanced">
            {/* Имя + превью капли */}
            <div className="dot-wizard-field">
              <span className="dot-wizard-label">Имя</span>
              <div className="dot-wizard-row" style={{ alignItems: 'center' }}>
                <DotBlob color={st.color} icon={st.icon} size={44} />
                <input
                  ref={nameInputRef}
                  className={`dot-wizard-input${error && !st.name.trim() ? ' dot-wizard-input--invalid' : ''}`}
                  value={st.name}
                  onChange={e => set({ name: e.target.value })}
                  placeholder="Наблюдатель за ценами"
                  maxLength={40}
                />
              </div>
            </div>

            {/* Иконка + цвет */}
            <div className="dot-wizard-row">
              <div className="dot-wizard-field">
                <span className="dot-wizard-label">Иконка</span>
                <div className="dot-wizard-icons">
                  {DOT_ICON_PRESETS.map(ic => (
                    <button
                      key={ic}
                      type="button"
                      className={`dot-wizard-icon-btn${st.icon === ic ? ' dot-wizard-icon-btn--active' : ''}`}
                      style={st.icon === ic ? { borderColor: st.color, color: st.color } : undefined}
                      onClick={() => set({ icon: ic })}
                    >
                      <AppIcon name={ic as IconName} size="sm" />
                    </button>
                  ))}
                </div>
              </div>
              <div className="dot-wizard-field">
                <span className="dot-wizard-label">Цвет</span>
                <div className="dot-wizard-colors">
                  {DOT_COLOR_PRESETS.map(c => (
                    <button
                      key={c}
                      type="button"
                      className={`dot-wizard-color${st.color === c ? ' dot-wizard-color--active' : ''}`}
                      style={{ background: c }}
                      onClick={() => set({ color: c })}
                    />
                  ))}
                </div>
              </div>
            </div>

            {/* Модель — видна сразу; подпись и селектор в одну строку */}
            <div className="dot-wizard-field">
              <div className="dot-wizard-model-row">
                <span className="dot-wizard-label">Модель</span>
                <ModelSelector
                  modelId={st.modelId ?? ''}
                  providerId={st.modelProvider ?? undefined}
                  onChange={(modelId, providerId) => void set({ modelId, modelProvider: providerId })}
                />
              </div>
              <span className="dot-wizard-hint">
                Пусто = глобальная модель Dots (или main). Фоновые проверки не требуют топ-модели.
              </span>
            </div>

            {/* Наблюдение за файлами */}
            <div className="dot-wizard-field">
              <span className="dot-wizard-label">Наблюдение за файлами/папками</span>
              <textarea
                className="dot-wizard-textarea"
                style={{ minHeight: 52 }}
                value={st.watchPaths}
                onChange={e => set({ watchPaths: e.target.value })}
                placeholder={'C:\\Projects\\notes\nD:\\Downloads'}
              />
              <span className="dot-wizard-hint">По одному пути на строку. Изменения будят Dot’а (с дебаунсом 3с).</span>
            </div>

            {/* Правила */}
            <div className="dot-wizard-field">
              <span className="dot-wizard-label">Правила-границы</span>
              <textarea
                className="dot-wizard-textarea"
                style={{ minHeight: 52 }}
                value={st.rules}
                onChange={e => set({ rules: e.target.value })}
                placeholder="Не сообщай об изменениях меньше 5%. Не пиши длиннее трёх абзацев."
                maxLength={2000}
              />
            </div>
          </div>
        </div>

        {error && <div className="dot-wizard-error">{error}</div>}

        <div className="dot-wizard-footer">
          <button type="button" className="dots-header-btn" onClick={onClose}>Отмена</button>
          <button
            type="button"
            className="dots-header-btn dots-header-btn--primary"
            onClick={() => void save()}
            disabled={saving}
          >
            <AppIcon name={saving ? 'loader' : 'check'} size="xs" animation={saving ? 'spin' : 'none'} />
            {saving ? 'Сохранение…' : dot ? 'Сохранить' : 'Создать Dot’а'}
          </button>
        </div>
      </motion.div>
    </div>
  )
}
