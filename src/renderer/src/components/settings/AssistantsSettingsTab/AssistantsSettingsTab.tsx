import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import Toggle from '../../ui/Toggle/Toggle'
import Select from '../../ui/Select/Select'
import Stepper from '../../ui/Stepper/Stepper'
import AppIcon, { type IconName } from '../../ui/AppIcon/AppIcon'
import { SectionTitle, Group, Field } from '../SettingsPrimitives'
import { useToast } from '../../ui/Toast/Toast'
import type { AssistantsSettings, AssistantLogEntry, AgentStatsMap, AssistantHardwareAssessment, AssistantRuntimeStatus } from '../../../../../shared/assistants'
import { ASSISTANT_MODEL_OPTIONS, DEFAULT_ASSISTANTS_SETTINGS } from '../../../../../shared/assistants'
import './AssistantsSettingsTab.css'

type SetupPhase = { phase: string; percent: number }

const PHASE_LABELS: Record<string, string> = {
  binary: 'Загрузка движка…',
  model: 'Загрузка модели…',
  starting: 'Запуск модели…',
}

type AgentKey = 'watcherEnabled' | 'janitorEnabled' | 'briefingEnabled' | 'navigatorEnabled' | 'archivistEnabled'

interface AgentDef {
  key: AgentKey
  name: string
  icon: IconName
  color: string
  short: string
  detail: string
  localModel: boolean
}

const AGENTS: AgentDef[] = [
  {
    key: 'watcherEnabled', name: 'Watcher', icon: 'sparkles', color: '#818cf8',
    short: 'Находит подсказки для текущей задачи.',
    detail: 'Берёт подсказки из памяти проекта и скиллов. При повторах переиспользует недавнюю оценку подходящих инструментов.',
    localModel: true,
  },
  {
    key: 'janitorEnabled', name: 'Janitor', icon: 'filter', color: '#4ade80',
    short: 'Сворачивает повторы и старые результаты.',
    detail: 'Учитывает заполненность окна контекста и сохраняет оригиналы в архиве. Агент может запросить их снова.',
    localModel: false,
  },
  {
    key: 'briefingEnabled', name: 'Briefing', icon: 'brain', color: '#38bdf8',
    short: 'Собирает краткую сводку проекта к старту задачи.',
    detail: 'Показывает последние изменения, прежнюю задачу и закреплённые правила перед первым ходом.',
    localModel: false,
  },
  {
    key: 'navigatorEnabled', name: 'Navigator', icon: 'compass', color: '#a78bfa',
    short: 'Сверяет действия с целью и правилами.',
    detail: 'Проверяет недавние шаги и напоминает о цели при подтверждённом отклонении. После уточнения задачи старые оценки отбрасываются.',
    localModel: true,
  },
  {
    key: 'archivistEnabled', name: 'Archivist', icon: 'archive', color: '#34d399',
    short: 'Сохраняет полезные факты по итогам задачи.',
    detail: 'Извлекает факты с источниками и проверяет дубли перед записью в память проекта.',
    localModel: true,
  },
]

const MODEL_OPTIONS = [
  { value: 'auto', label: 'Авто по ПК' },
  ...ASSISTANT_MODEL_OPTIONS.map(({ value, label, download }) => ({ value, label: `${label} · ${download}` })),
]

const TIER_LABELS: Record<AssistantHardwareAssessment['tier'], string> = {
  unsupported: 'Локальная модель недоступна',
  limited: 'Бережный профиль',
  balanced: 'Сбалансированный профиль',
  performance: 'Расширенный профиль',
}

const memoryFormat = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 })
const contextLabel = (size: number) => `${Math.round(size / 1024)}K токенов`

export default function AssistantsSettingsTab() {
  const addToast = useToast(s => s.add)
  const reduceMotion = useReducedMotion()
  const [s, setS] = useState<AssistantsSettings>(DEFAULT_ASSISTANTS_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [status, setStatus] = useState<AssistantRuntimeStatus | null>(null)
  const [hardware, setHardware] = useState<AssistantHardwareAssessment | null>(null)
  const [checking, setChecking] = useState(true)
  const [setup, setSetup] = useState<SetupPhase | null>(null)
  const [log, setLog] = useState<AssistantLogEntry[]>([])
  const [stats, setStats] = useState<AgentStatsMap>({})
  const [info, setInfo] = useState<AgentDef | null>(null)
  const infoTrigger = useRef<HTMLButtonElement | null>(null)
  const infoClose = useRef<HTMLButtonElement | null>(null)

  const refreshRuntime = useCallback(() => {
    window.syntee.assistants.getStatus().then(setStatus).catch(() => {})
    window.syntee.assistants.getLog(undefined, 50).then(setLog).catch(() => {})
    window.syntee.assistants.getStats().then(setStats).catch(() => {})
  }, [])

  const checkHardware = useCallback(async () => {
    setChecking(true)
    try {
      setHardware(await window.syntee.assistants.getHardware())
    } catch {
      setHardware(null)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    window.syntee.assistants.getSettings().then(settings => {
      setS(settings)
      setLoaded(true)
    }).catch(() => addToast('Не удалось загрузить настройки мини-агентов', 'error'))
    void checkHardware()
    refreshRuntime()
    const unsubscribe = window.syntee.assistants.onSetupProgress(progress => {
      if (progress.phase === 'ready' || progress.phase === 'error') {
        setSetup(null)
        refreshRuntime()
      } else {
        setSetup(progress)
      }
    })
    const interval = setInterval(() => { if (!document.hidden) refreshRuntime() }, 12_000)
    return () => { unsubscribe(); clearInterval(interval) }
  }, [checkHardware, refreshRuntime, addToast])

  const upd = async (patch: Partial<AssistantsSettings>) => {
    if (!loaded || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      setS(await window.syntee.assistants.updateSettings(patch))
      refreshRuntime()
    } catch {
      addToast('Не удалось сохранить настройки', 'error')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const start = async () => {
    setSetup({ phase: 'starting', percent: 0 })
    try {
      const result = await window.syntee.assistants.setup()
      if (!result.ok) addToast(result.error ?? 'Не удалось запустить модель', 'error')
    } catch {
      addToast('Не удалось запустить модель', 'error')
    } finally {
      setSetup(null)
      refreshRuntime()
    }
  }

  const recommendation = hardware?.recommendation
  const recommendedModel = ASSISTANT_MODEL_OPTIONS.find(model => model.value === recommendation?.modelSize)
  const activeModel = ASSISTANT_MODEL_OPTIONS.find(model => model.value === status?.modelSize)
  const modelDescription = s.modelSize === 'auto'
    ? recommendedModel?.use
    : ASSISTANT_MODEL_OPTIONS.find(model => model.value === s.modelSize)?.use
  const profileApplied = recommendation && s.modelSize === recommendation.modelSize
    && s.ctxSize === recommendation.ctxSize && s.device === recommendation.device
  const locked = !loaded || saving
  const modelLocked = locked || !s.enabled || setup !== null
  const isReady = status?.serverState === 'ready'

  useEffect(() => {
    if (!info) return
    const trigger = infoTrigger.current
    infoClose.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInfo(null)
      if (e.key === 'Tab') {
        e.preventDefault()
        infoClose.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      trigger?.focus()
    }
  }, [info])

  return (
    <div className="assistants-tab">
      <SectionTitle description="Подсказки, память и сжатие контекста во время работы агента.">
        Мини-агенты
      </SectionTitle>

      <section className="assistants-hardware" aria-label="Оценка ПК" aria-busy={checking}>
        <span className="assistants-hardware-icon"><AppIcon name="cpu" size="sm" /></span>
        <div className="assistants-hardware-copy" aria-live="polite">
          <strong>{hardware ? TIER_LABELS[hardware.tier] : 'Оценка ПК'}</strong>
          {hardware ? (
            <>
              <p>{hardware.logicalCpus} потоков CPU · {memoryFormat.format(hardware.totalMemoryGiB)} ГиБ RAM
                {hardware.availableMemoryGiB !== null && ` · доступно ${memoryFormat.format(hardware.availableMemoryGiB)} ГиБ`}</p>
              {recommendation ? (
                <p>{recommendedModel?.label} · {contextLabel(recommendation.ctxSize)} · CPU, до {recommendation.threads} потоков</p>
              ) : (
                <p>{hardware.runtimeSupported ? 'Мало памяти для локальной модели.' : 'Для этой платформы нет совместимого движка.'} Janitor и Briefing доступны.</p>
              )}
            </>
          ) : <p>{checking ? 'Проверяем память и процессор…' : 'Оценка ПК недоступна.'}</p>}
        </div>
        <div className="assistants-hardware-actions">
          {recommendation && (
            <button type="button" className="settings-btn assistants-hardware-apply" disabled={locked || checking || setup !== null || !!profileApplied}
              onClick={() => upd({ modelSize: recommendation.modelSize, ctxSize: recommendation.ctxSize, device: recommendation.device })}>
              {profileApplied ? 'Профиль применён' : 'Применить профиль'}
            </button>
          )}
          <button type="button" className="settings-btn assistants-hardware-refresh" onClick={checkHardware} disabled={checking}
            title="Обновить оценку ПК" aria-label="Обновить оценку ПК"><AppIcon name="refreshCw" size="sm" /></button>
        </div>
      </section>

      {setup && (
        <div className="assistants-setup" role="status">
          <div className="assistants-setup-spinner" aria-hidden="true" />
          <div className="assistants-setup-info">
            <strong>{PHASE_LABELS[setup.phase] ?? 'Настройка…'}</strong>
            <div className="assistants-progress" role="progressbar" aria-label="Настройка модели" aria-valuenow={setup.percent}>
              <div style={{ width: `${setup.percent}%` }} />
            </div>
          </div>
        </div>
      )}

      {isReady && !setup && s.enabled && status && (
        <div className="assistants-ready">
          <span className="assistants-dot assistants-dot--ready" />
          <span>Модель работает · {activeModel?.label ?? status.modelSize} · {status.activeDevice === 'gpu' ? 'GPU (Vulkan)' : 'CPU'}{status.active > 0 ? ` · в работе ${status.active}` : ''}{status.queueLength > 0 ? ` · в очереди ${status.queueLength}` : ''}</span>
        </div>
      )}

      {!isReady && !setup && loaded && s.enabled && status && (
        <div className="assistants-ready assistants-ready--off">
          <span className="assistants-dot assistants-dot--stopped" />
          <span>{status.idleUnloaded ? 'Модель выгружена до следующего запроса' : status.lastError || 'Локальная модель остановлена'}</span>
          {recommendation && (
            <button type="button" className="settings-btn assistants-start-button" onClick={start} disabled={locked}>
              {status.modelDownloaded ? 'Запустить' : 'Скачать и запустить'}
            </button>
          )}
        </div>
      )}

      <Group id="assistants-basic" icon="settings" title="Запуск"
        right={<Toggle value={s.enabled} onChange={v => upd({ enabled: v })} disabled={locked} aria-label="Мини-агенты" />}>
        <Field label="Модель" description={modelDescription}>
          <Select
            value={s.modelSize}
            onChange={v => upd({ modelSize: v as AssistantsSettings['modelSize'] })}
            options={MODEL_OPTIONS}
            disabled={modelLocked}
          />
        </Field>
        <Field
          label="Контекст модели"
          description={status?.ctxSize ? `Сейчас ${contextLabel(status.ctxSize)} на все слоты.` : 'Длиннее контекст — больше расход памяти.'}
        >
          <Select
            value={String(s.ctxSize)}
            onChange={v => upd({ ctxSize: (v === 'auto' ? 'auto' : Number(v)) as AssistantsSettings['ctxSize'] })}
            options={[
              { value: 'auto', label: 'Авто по ПК' },
              { value: '4096', label: '4K токенов' },
              { value: '8192', label: '8K токенов' },
              { value: '16384', label: '16K токенов' },
              { value: '24576', label: '24K токенов' },
              { value: '32768', label: '32K токенов' },
            ]}
            disabled={modelLocked}
          />
        </Field>

        <Field
          id="assistants-device"
          label="Устройство"
          description="Vulkan использует видеокарту. При сбое модель запустится на CPU."
        >
          <Select
            value={s.device ?? 'auto'}
            onChange={v => upd({ device: v as AssistantsSettings['device'] })}
            options={[
              { value: 'auto', label: 'Авто по ПК' },
              { value: 'cpu', label: 'Только CPU' },
              { value: 'gpu', label: 'GPU (Vulkan)' },
            ]}
            disabled={modelLocked}
          />
        </Field>
      </Group>

      <Group id="assistants-agents" icon="bot" title="Мини-агенты">
        {AGENTS.map(a => {
          const st = stats[a.key.replace('Enabled', '')]
          return (
            <div className="ma-row" key={a.key}>
              <div className="ma-row-main">
                <div className="ma-row-head">
                  <span className="ma-row-icon" style={{ color: a.color, background: `${a.color}1a` }}><AppIcon name={a.icon} size="xs" /></span>
                  <span className="ma-row-name">{a.name}</span>
                  <button type="button" className="ma-info-btn" onClick={e => { infoTrigger.current = e.currentTarget; setInfo(a) }} aria-label={`Подробнее о ${a.name}`}>
                    <AppIcon name="info" size="xs" />
                  </button>
                </div>
                <p className="ma-row-desc">{a.short}</p>
                {st && (st.fired > 0 || st.skipped > 0) && (
                  <p className="ma-stats">
                    сработал {st.fired} · пропусков {st.skipped}
                    {st.saved > 0 && ` · ≈ −${st.saved >= 1000 ? `${(st.saved / 1000).toFixed(1)}k` : st.saved} токенов`}
                  </p>
                )}
              </div>
              <Toggle value={s[a.key]} onChange={v => upd({ [a.key]: v })} disabled={locked || !s.enabled} aria-label={a.name} />
            </div>
          )
        })}
      </Group>

      <Group id="assistants-advanced" icon="settings" title="Параметры контекста">
        <Field label="Бюджет подсказки" description="Токенов на одну подсказку Watcher.">
          <Stepper value={s.hintBudgetTokens} onChange={v => upd({ hintBudgetTokens: v })} min={100} max={1000} step={50} disabled={locked} />
        </Field>
        <Field label="Пауза между подсказками" description="Минимум ходов.">
          <Stepper value={s.hintCooldownRounds} onChange={v => upd({ hintCooldownRounds: v })} min={1} max={5} step={1} disabled={locked} />
        </Field>
        <Field label="Интервал проверки Janitor" description="Ходов между проверками контекста.">
          <Stepper value={s.janitorScanInterval} onChange={v => upd({ janitorScanInterval: v })} min={2} max={20} step={1} disabled={locked} />
        </Field>
        <Field label="Защищённый хвост Janitor" description="Последние ходы, которые Janitor сохраняет целиком.">
          <Stepper value={s.janitorTailSteps} onChange={v => upd({ janitorTailSteps: v })} min={3} max={30} step={1} disabled={locked} />
        </Field>
        <Field label="Минимальная экономия Janitor" description="Токенов для применения сжатия.">
          <Stepper value={s.janitorMinSavingsTokens} onChange={v => upd({ janitorMinSavingsTokens: v })} min={0} max={2000} step={50} disabled={locked} />
        </Field>
        <Field label="Релевантность подсказок" description="Порог совпадения с памятью в процентах.">
          <Stepper value={Math.round(s.relevanceThreshold * 100)} onChange={v => upd({ relevanceThreshold: v / 100 })} min={30} max={95} step={5} disabled={locked} />
        </Field>
        <Field label="Искать в памяти">
          <Toggle value={s.sources.memory} onChange={v => upd({ sources: { ...s.sources, memory: v } })} disabled={locked} aria-label="Искать в памяти" />
        </Field>
        <Field label="Искать в скиллах">
          <Toggle value={s.sources.skills} onChange={v => upd({ sources: { ...s.sources, skills: v } })} disabled={locked} aria-label="Искать в скиллах" />
        </Field>
      </Group>

      <Group id="assistants-log" icon="chart" title="Журнал">
        {log.length === 0 && <p className="assistants-log-empty">Событий пока нет</p>}
        {log.length > 0 && (
          <div className="assistants-log">
            {log.slice().reverse().map((e, i) => (
              <div key={i} className={`assistants-log-entry assistants-log-entry--${e.role}`}>
                <span className="assistants-log-time">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className="assistants-log-role">{e.role}</span>
                <span className="assistants-log-kind">{e.kind}</span>
                <span className="assistants-log-detail">{e.detail}</span>
                {e.tokensSaved != null && <span className="assistants-log-saved">−{e.tokensSaved} ток.</span>}
              </div>
            ))}
          </div>
        )}
      </Group>

      {createPortal(
        <AnimatePresence>
          {info && (
          <motion.div className="ma-modal-overlay" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.15 }} onClick={() => setInfo(null)}>
            <div className="ma-modal" role="dialog" aria-modal="true" aria-labelledby="assistant-info-title" onClick={e => e.stopPropagation()}>
              <div className="ma-modal-head">
                <span className="ma-row-icon ma-modal-icon" style={{ color: info.color, background: `${info.color}1a` }}><AppIcon name={info.icon} size="sm" /></span>
                <div>
                  <h3 id="assistant-info-title">{info.name}</h3>
                </div>
                <button type="button" className="ma-modal-close" ref={infoClose} onClick={() => setInfo(null)} aria-label="Закрыть"><AppIcon name="x" size="sm" /></button>
              </div>
              <div className="ma-modal-body">
                <p>{info.detail}</p>
                <div className="ma-modal-llm"><AppIcon name="brain" size="xs" />{info.localModel ? 'Использует локальную модель' : 'Работает без локальной модели'}</div>
              </div>
            </div>
          </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}
