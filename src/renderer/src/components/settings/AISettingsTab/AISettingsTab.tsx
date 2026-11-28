import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type {
  Provider,
  ModelAssignment,
  ModelParams,
  ModelRole,
  ModelCapability,
  ModelMeta,
  CodexAuthState
} from '../../../../../shared/types'
import { BUILTIN_PROVIDERS_META } from '../../../../../shared/data/builtinModels'
import ModelPicker from '../../ui/ModelPicker/ModelPicker'
import ReasoningSelector from '../../ui/ReasoningSelector/ReasoningSelector'
import AppIcon from '../../ui/AppIcon/AppIcon'
import BrandAvatar from '../../ui/BrandAvatar/BrandAvatar'
import { getBrandLogo } from '../../../utils/modelFormat'
import { GATEWAY_PROVIDER_ID, useGatewayModelsStore } from '../../../store/gatewayModels.store'
import { useAuthStore } from '../../../store/auth.store'
import { useNavStore } from '../../../store/nav.store'
import { useSettingsStore } from '../../../store/settings.store'
import {
  ORCHESTRATION_DEFAULTS_KEY,
  normalizeOrchestrationDefaults,
  type OrchestrationDefaults
} from '../../../utils/orchestration'
import {
  whileHoverWide,
  whileTapWide,
  whileHoverSm,
  whileTapSm,
  springHover
} from '../../../utils/motionPresets'
import ProviderEditorDialog from './ProviderEditorDialog'
import ProviderModelsDialog from './ProviderModelsDialog'
import './AISettingsTab.css'

type BaseModelRole = Exclude<ModelRole, `subagent:${string}`>

const SUBAGENT_MODEL_META = [
  { id: 'researcher', label: 'Исследователь', desc: 'Изучение кода и файлов без изменений' },
  {
    id: 'deep-researcher',
    label: 'Глубокий исследователь',
    desc: 'Исследование кода, поиск в интернете и документации'
  },
  { id: 'editor', label: 'Редактор', desc: 'Изменение файлов без запуска команд' },
  { id: 'implementer', label: 'Исполнитель', desc: 'Полная реализация: файлы, команды и тесты' },
  { id: 'reviewer', label: 'Ревьюер', desc: 'Проверка кода, поиск ошибок и рисков' }
] as const

const ROLE_META: Record<
  BaseModelRole,
  { label: string; desc: string; icon: string; filterCaps?: ModelCapability[] }
> = {
  main: { label: 'Основной чат', desc: 'Для всех сообщений в чате', icon: 'bot' },
  fast: { label: 'Быстрые ответы', desc: 'Автоназвания, короткие задачи', icon: 'zap' },
  vision: {
    label: 'Vision / Картинки',
    desc: 'Анализ изображений; metadata модели, не гарантия поддержки транспортом',
    icon: 'eye',
    filterCaps: ['vision']
  },
  video: {
    label: 'Видео',
    desc: 'Анализ входного видео; metadata модели, не гарантия поддержки транспортом',
    icon: 'camera',
    filterCaps: ['video']
  },
  audio: {
    label: 'Аудио-анализ',
    desc: 'Анализ входного аудио с текстовым ответом; metadata, не гарантия поддержки транспортом',
    icon: 'mic',
    filterCaps: ['audio_input']
  },
  stt: { label: 'Голос → Текст', desc: 'Распознавание речи', icon: 'mic', filterCaps: ['stt'] },
  subagent: { label: 'Суб-агенты', desc: 'Модель для дочерних агентов', icon: 'git-branch' },
  tts: { label: 'Текст → Голос', desc: 'Озвучивание ответов', icon: 'volume', filterCaps: ['tts'] },
  embedding: {
    label: 'Embeddings',
    desc: 'Векторный поиск и память',
    icon: 'brain',
    filterCaps: ['embedding']
  },
  memory: { label: 'Память', desc: 'Экстракция фактов, исходов и графа памяти', icon: 'database' },
  summary: { label: 'Суммаризация', desc: 'Авто-заголовки чатов', icon: 'fileText' }
}

const BUILTIN_PROVIDER_IDS = Object.keys(BUILTIN_PROVIDERS_META)

export default function AISettingsTab() {
  const [tab, setTab] = useState<'providers' | 'models' | 'params'>('providers')
  const [providers, setProviders] = useState<Provider[]>([])
  const [allModels, setAllModels] = useState<ModelMeta[]>([])
  const [assignments, setAssignments] = useState<ModelAssignment[]>([])
  const [subagentModelsOpen, setSubagentModelsOpen] = useState(false)
  const [params, setParams] = useState<ModelParams>({
    systemPrompt: '',
    streaming: true,
    anonymousUserAgent: false
  })
  const [configuring, setConfiguring] = useState<Provider | null>(null)
  const [modelsProvider, setModelsProvider] = useState<Provider | null>(null)
  const [providerQuery, setProviderQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState<'all' | 'connected' | 'builtin' | 'custom'>(
    'all'
  )
  const [imageModelId, setImageModelId] = useState('')
  const [imageProviderId, setImageProviderId] = useState('')
  // Дефолты one-turn оркестрации (/orchestrate): settings['orchestrationDefaults'].
  // Модель чата при этом не меняется — она остаётся координатором.
  const [orchDefaults, setOrchDefaults] = useState<OrchestrationDefaults>({})
  // ChatGPT-подписка авторизуется токеном, а не API-ключом, поэтому признак
  // «настроен» берём из реального статуса входа (codex:status).
  const [codexAuth, setCodexAuth] = useState<CodexAuthState | null>(null)

  // ── Debounce для systemPrompt textarea ──────────────────────────────
  // Раньше updateParams({ systemPrompt }) звался на каждое нажатие → IPC
  // per keystroke + setParams → ре-рендер всего таба. Теперь локальный
  // draft отвечает мгновенно, IPC дебаунсится 400мс. Невидимо: тот же
  // результат, но без фризов при печати.
  const [systemPromptDraft, setSystemPromptDraft] = useState(params.systemPrompt)
  const systemPromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (systemPromptTimerRef.current) clearTimeout(systemPromptTimerRef.current)
    }
  }, [])

  const load = async () => {
    try {
      const [p, a, pm, imgS, models, codexState, orchRaw] = await Promise.all([
        window.syntee.providers.getAll() as Promise<Provider[]>,
        window.syntee.models.getAssignments() as Promise<ModelAssignment[]>,
        window.syntee.models.getParams() as Promise<ModelParams>,
        window.syntee.image.getSettings(),
        window.syntee.models.getAll() as Promise<ModelMeta[]>,
        window.syntee.codex.status() as Promise<CodexAuthState>,
        window.syntee.settings.get(ORCHESTRATION_DEFAULTS_KEY)
      ])
      setProviders(p)
      setAllModels(models)
      setAssignments(a)
      setParams(pm)
      setCodexAuth(codexState)
      setOrchDefaults(normalizeOrchestrationDefaults(orchRaw))
      if (!systemPromptTimerRef.current) setSystemPromptDraft(pm.systemPrompt)
      setImageModelId(imgS.modelId || '')
      setImageProviderId(imgS.providerId || '')
    } catch (e) {
      console.error('[AISettingsTab] load error', e)
    }
  }

  /** Сохранить дефолты оркестрации (Settings → AI → Оркестрация).
   *  Пишем через settings-store: ChatPage читает тот же ключ и сразу видит
   *  новые дефолты без перезагрузки окна. */
  const saveOrchestrationDefaults = (patch: OrchestrationDefaults) => {
    const next: OrchestrationDefaults = { ...orchDefaults, ...patch }
    if (!next.executor) delete next.executor
    if (!next.reviewer) delete next.reviewer
    setOrchDefaults(next)
    void useSettingsStore.getState().set(ORCHESTRATION_DEFAULTS_KEY, next)
  }

  /** Effort (уровень мышления) дефолтной роли: пустая строка = дефолт модели. */
  const setExecutorReasoning = (v: string) => {
    const cur = orchDefaults.executor
    if (!cur) return
    saveOrchestrationDefaults({ executor: { ...cur, reasoningValue: v || undefined } })
  }
  const setReviewerReasoning = (v: string) => {
    const cur = orchDefaults.reviewer
    if (!cur) return
    saveOrchestrationDefaults({ reviewer: { ...cur, reasoningValue: v || undefined } })
  }

  // Refresh lists after gateway models have been updated.
  const gatewayModels = useGatewayModelsStore((s) => s.models)
  const gatewayConnected = useAuthStore((s) => !!s.user)
  const openSettings = useNavStore((s) => s.openSettings)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [gatewayModels])

  // Вход по ChatGPT-подписке мог случиться в другой вкладке/окне — держим
  // карточку в актуальном состоянии, а не только после ручного load().
  useEffect(() => {
    const off = window.syntee.codex.onAuthChanged(() => {
      const timer = window.setTimeout(() => { void load() }, 0)
      return () => window.clearTimeout(timer)
    })
    return () => { off() }
  }, [])

  const getProviderMeta = (id: string) => BUILTIN_PROVIDERS_META[id]

  const isCodexProvider = (id: string) =>
    id === 'openai-codex' || providers.find((p) => p.id === id)?.type === 'openai-codex'

  const isConfigured = (id: string) => {
    if (id === GATEWAY_PROVIDER_ID) return gatewayConnected
    const provider = providers.find((p) => p.id === id)
    // ChatGPT-подписка: API-ключа нет, настроенность = активный вход по OAuth
    // или импортированный логин Codex CLI.
    if (isCodexProvider(id)) return Boolean(provider?.enabled) && !!codexAuth?.connected
    return !!provider && provider.enabled &&
      !!(provider.apiKey || provider.anonymous || provider.isCustom || provider.type === 'ollama')
  }
  const statusLabel = (id: string, configured: boolean) => {
    if (id === GATEWAY_PROVIDER_ID) return configured ? 'Аккаунт подключён' : 'Требуется вход'
    if (!isCodexProvider(id)) return configured ? 'Настроен' : 'Не настроен'
    if (!codexAuth?.connected) return 'Не настроен'
    const plan = codexAuth.plan ? ` · ${codexAuth.plan.charAt(0).toUpperCase()}${codexAuth.plan.slice(1)}` : ''
    return `Подключено${plan}`
  }
  const matchesProvider = (id: string, name: string, custom: boolean) => {
    const query = providerQuery.trim().toLowerCase()
    return (
      `${name} ${id}`.toLowerCase().includes(query) &&
      (providerFilter === 'all' ||
        (providerFilter === 'connected'
          ? !!isConfigured(id)
          : providerFilter === 'custom'
            ? custom
            : !custom))
    )
  }
  const startConfigure = (id: string) => {
    const existing = providers.find((p) => p.id === id),
      meta = BUILTIN_PROVIDERS_META[id]
    setConfiguring(
      existing || {
        id,
        type: id as Provider['type'],
        name: meta?.name || id,
        baseUrl: meta?.baseUrl || '',
        apiKey: '',
        enabled: true,
        isCustom: false
      }
    )
  }
  const deleteProvider = async (id: string) => {
    await window.syntee.providers.delete(id)
    await load()
  }

  const setAssignment = async (role: ModelRole, modelId: string, pid: string) => {
    const a: ModelAssignment = { role, modelId, providerId: pid }
    await window.syntee.models.setAssignment(a)
    setAssignments((prev) => {
      const next = [...prev.filter((x) => x.role !== role), a]
      return next
    })
  }

  const updateParams = async (patch: Partial<ModelParams>) => {
    const next = { ...params, ...patch }
    setParams(next)
    await window.syntee.models.setParams(patch)
  }

  return (
    <div className="ai-settings">
      {/* Заголовок раздела — раньше его не было, таб-бар «висел» в воздухе. */}
      <h2 className="settings-section-title">ИИ и Модели</h2>

      {/* Segmented control: pill-переключатель со скользящим индикатором
          вместо underline-табов. layoutId animates между сегментами. */}
      <div className="ai-seg" role="tablist" aria-label="Настройки ИИ">
        {(['providers', 'models', 'params'] as const).map((t) => (
          <motion.button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`ai-seg-item ${tab === t ? 'ai-seg-item--active' : ''}`}
            onClick={() => setTab(t)}
            whileHover={whileHoverWide}
            whileTap={whileTapWide}
            transition={springHover}
          >
            {tab === t && (
              <motion.span
                layoutId="ai-seg-active"
                className="ai-seg-active-pill"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            )}
            <span className="ai-seg-item-label">
              {t === 'providers' ? 'Провайдеры' : t === 'models' ? 'Назначения' : 'Параметры'}
            </span>
          </motion.button>
        ))}
      </div>

      {tab === 'providers' && (
        <>
          <div className="provider-toolbar">
            <input
              className="provider-form-input"
              aria-label="Поиск провайдеров"
              placeholder="Поиск провайдера…"
              value={providerQuery}
              onChange={(e) => setProviderQuery(e.target.value)}
            />
            <button
              className="provider-btn provider-btn--save"
              onClick={() =>
                setConfiguring({
                  id: `custom-${Date.now()}`,
                  type: 'custom',
                  name: '',
                  baseUrl: '',
                  apiKey: '',
                  enabled: true,
                  isCustom: true
                })
              }
            >
              <AppIcon name="plus" size="xs" /> Добавить провайдера
            </button>
            <div className="provider-filters">
              {(['all', 'connected', 'builtin', 'custom'] as const).map((filter) => (
                <button
                  key={filter}
                  className="provider-btn"
                  aria-pressed={providerFilter === filter}
                  onClick={() => setProviderFilter(filter)}
                >
                  {filter === 'all'
                    ? 'Все'
                    : filter === 'connected'
                      ? 'Подключённые'
                      : filter === 'builtin'
                        ? 'Встроенные'
                        : 'Свои'}
                </button>
              ))}
            </div>
          </div>
          <div className="ai-providers">
            <div className="ai-providers-grid">
              {BUILTIN_PROVIDER_IDS.filter((id) =>
                matchesProvider(id, getProviderMeta(id).name, false)
              ).map((id) => {
                const meta = getProviderMeta(id),
                  configured = !!isConfigured(id),
                  hosted = id === GATEWAY_PROVIDER_ID
                return (
                  <div
                    key={id}
                    className={`provider-card ${configured ? 'provider-card--active' : ''}`}
                  >
                    <div className="provider-card-header">
                      <BrandAvatar
                        logo={getBrandLogo(id, '', '', undefined)}
                        fallbackColor={meta.color}
                        size={18}
                        className="provider-logo"
                      />
                      <span className="provider-name">{meta.name}</span>
                      <span
                        className={`provider-status ${configured ? 'provider-status--ok' : ''}`}
                      >
                        {statusLabel(id, configured)}
                      </span>
                    </div>
                    <div className="provider-card-footer">
                      {hosted ? (
                        <button className="provider-btn" onClick={() => openSettings('profile')}>
                          {configured ? 'Профиль' : 'Войти'}
                        </button>
                      ) : (
                        <button className="provider-btn" onClick={() => startConfigure(id)}>
                          {configured ? 'Изменить' : 'Настроить'}
                        </button>
                      )}
                      <button
                        className="provider-btn"
                        disabled={hosted && !configured}
                        onClick={() =>
                          setModelsProvider(
                            providers.find((p) => p.id === id) || {
                              id,
                              type: id as Provider['type'],
                              name: meta.name,
                              baseUrl: meta.baseUrl || '',
                              apiKey: '',
                              enabled: true,
                              isCustom: false
                            }
                          )
                        }
                      >
                        Модели
                      </button>
                      {configured && !hosted && (
                        <button
                          className="provider-btn provider-btn--delete"
                          onClick={() => void deleteProvider(id)}
                        >
                          Удалить
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              {providers
                .filter((p) => p.isCustom && matchesProvider(p.id, p.name, true))
                .map((p) => (
                  <div key={p.id} className="provider-card">
                    <div className="provider-card-header">
                      <BrandAvatar
                        logo={getBrandLogo(p.type, '', '', p.iconUrl)}
                        fallbackColor="#888"
                        size={18}
                        className="provider-logo"
                      />
                      <span className="provider-name">{p.name}</span>
                      <span className="provider-status provider-status--ok">Кастомный</span>
                    </div>
                    <div className="provider-url">
                      {p.baseUrl}
                      {p.modelsEndpoint || '/models'}
                    </div>
                    <div className="provider-card-footer">
                      <button className="provider-btn" onClick={() => setConfiguring(p)}>
                        Изменить
                      </button>
                      <button className="provider-btn" onClick={() => setModelsProvider(p)}>
                        Модели
                      </button>
                      <button
                        className="provider-btn provider-btn--delete"
                        onClick={() => void deleteProvider(p.id)}
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                ))}
              {!BUILTIN_PROVIDER_IDS.some((id) =>
                matchesProvider(id, getProviderMeta(id).name, false)
              ) &&
                !providers.some((p) => p.isCustom && matchesProvider(p.id, p.name, true)) && (
                  <p className="provider-dialog-empty">
                    Провайдеры не найдены. Измените поиск или добавьте свой.
                  </p>
                )}
            </div>
            {configuring && (
              <ProviderEditorDialog
                key={configuring.id}
                provider={configuring}
                onClose={() => setConfiguring(null)}
                onSaved={load}
              />
            )}
            {modelsProvider && (
              <ProviderModelsDialog
                key={modelsProvider.id}
                provider={modelsProvider}
                onClose={() => setModelsProvider(null)}
                onChanged={load}
              />
            )}
          </div>
        </>
      )}

      {/* ── НАЗНАЧЕНИЯ МОДЕЛЕЙ ── */}
      {tab === 'models' && (
        <div className="ai-assignments">
          <p className="ai-assignments-hint">
            Назначьте модели для каждой роли. Модели берутся из настроенных провайдеров.
          </p>
          <div className="ai-assignments-grid">
            {(Object.keys(ROLE_META) as BaseModelRole[]).map((role) => {
              const meta = ROLE_META[role]
              const current = assignments.find((a) => a.role === role)
              return (
                <div
                  key={role}
                  className={`assignment-row${role === 'subagent' ? ' assignment-row--subagent' : ''}`}
                >
                  <div className="assignment-info">
                    <AppIcon name={meta.icon as 'bot'} size="sm" tone="accent" />
                    <div>
                      <div className="assignment-label">{meta.label}</div>
                      <div className="assignment-desc">{meta.desc}</div>
                    </div>
                  </div>
                  <div className="assignment-picker">
                    <ModelPicker
                      value={current?.modelId || ''}
                      providerId={current?.providerId || ''}
                      onChange={(modelId, pid) => setAssignment(role, modelId, pid)}
                      filterCaps={meta.filterCaps}
                      filterRole={
                        role === 'vision' ||
                        role === 'video' ||
                        role === 'audio' ||
                        role === 'stt' ||
                        role === 'tts'
                          ? role
                          : undefined
                      }
                      placeholder="Не выбрано"
                      sharedModels={allModels}
                      sharedProviders={providers}
                    />
                  </div>
                  {role === 'subagent' && (
                    <div className="subagent-inline-settings">
                      <button
                        type="button"
                        className="subagent-inline-summary"
                        aria-expanded={subagentModelsOpen}
                        aria-controls="subagent-model-options"
                        onClick={() => setSubagentModelsOpen((open) => !open)}
                      >
                        <AppIcon name="settings" size="xs" tone="accent" />
                        <span className="subagent-inline-summary-label">
                          Модели по типам суб-агентов
                        </span>
                        <AppIcon name="chevronDown" size="xs" className="subagent-models-chevron" />
                      </button>
                      <AnimatePresence initial={false}>
                        {subagentModelsOpen && (
                          <motion.div
                            id="subagent-model-options"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                            style={{ overflow: 'hidden' }}
                          >
                            <div className="subagent-models-body">
                              <p className="ai-assignments-hint">
                                Если модель не выбрана отдельно, используется общая модель
                                суб-агентов.
                              </p>
                              {SUBAGENT_MODEL_META.map((meta) => {
                                const subRole: ModelRole = `subagent:${meta.id}`
                                const subCurrent = assignments.find((a) => a.role === subRole)
                                return (
                                  <div key={subRole} className="subagent-model-row">
                                    <div className="subagent-role-info">
                                      <div className="assignment-label">{meta.label}</div>
                                      <div className="assignment-desc">{meta.desc}</div>
                                    </div>
                                    <div className="assignment-picker">
                                      <ModelPicker
                                        value={subCurrent?.modelId || ''}
                                        providerId={subCurrent?.providerId || ''}
                                        onChange={(modelId, pid) =>
                                          setAssignment(subRole, modelId, pid)
                                        }
                                        placeholder="Общая модель суб-агентов"
                                        sharedModels={allModels}
                                        sharedProviders={providers}
                                      />
                                      {subCurrent?.modelId && (
                                        <button
                                          className="subagent-model-reset"
                                          onClick={() => setAssignment(subRole, '', '')}
                                        >
                                          Сбросить
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* ── Генерация изображений ── */}
          <div className="assignment-row" style={{ marginTop: 12 }}>
            <div className="assignment-info">
              <AppIcon name="image" size="sm" tone="accent" />
              <div>
                <div className="assignment-label">Генерация изображений</div>
                <div className="assignment-desc">
                  Используется командой /image и tool generate_image
                </div>
              </div>
            </div>
            <div className="assignment-picker">
              <ModelPicker
                value={imageModelId}
                providerId={imageProviderId}
                onChange={(modelId, pid) => {
                  setImageModelId(modelId)
                  setImageProviderId(pid)
                  window.syntee.image.setSettings({ modelId, providerId: pid })
                }}
                filterCaps={['image_gen'] as ModelCapability[]}
                placeholder="Не выбрано"
                sharedModels={allModels}
                sharedProviders={providers}
              />
            </div>
          </div>

          {/* ── Оркестрация (/orchestrate) — дефолты одного хода ── */}
          <div className="assignment-row assignment-row--orchestration" style={{ marginTop: 12 }}>
            <div className="assignment-info">
              <AppIcon name="layers" size="sm" tone="accent" />
              <div>
                <div className="assignment-label">Исполнитель (оркестрация)</div>
                <div className="assignment-desc">
                  Дефолт для /orchestrate — модель чата остаётся координатором. Не выбрано:
                  блок оркестрации откроется пустым, отправка без исполнителя заблокирована
                </div>
              </div>
            </div>
            <div className="assignment-picker" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ModelPicker
                value={orchDefaults.executor?.modelId || ''}
                providerId={orchDefaults.executor?.providerId || ''}
                onChange={(modelId, pid) =>
                  saveOrchestrationDefaults({
                    executor: modelId
                      ? {
                          modelId,
                          providerId: pid,
                          // Effort не переезжает на другую модель.
                          reasoningValue:
                            orchDefaults.executor?.modelId === modelId
                              ? orchDefaults.executor?.reasoningValue
                              : undefined
                        }
                      : undefined
                  })
                }
                placeholder="Не выбрано"
                sharedModels={allModels}
                sharedProviders={providers}
              />
              {orchDefaults.executor?.modelId && (
                <ReasoningSelector
                  modelId={orchDefaults.executor.modelId}
                  value={orchDefaults.executor.reasoningValue ?? ''}
                  onChange={setExecutorReasoning}
                />
              )}
            </div>
          </div>

          <div className="assignment-row">
            <div className="assignment-info">
              <AppIcon name="users" size="sm" tone="accent" />
              <div>
                <div className="assignment-label">Ревьюер (оркестрация)</div>
                <div className="assignment-desc">
                  Необязательно. Не выбрано — ревьюером работает модель чата
                </div>
              </div>
            </div>
            <div className="assignment-picker" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ModelPicker
                value={orchDefaults.reviewer?.modelId || ''}
                providerId={orchDefaults.reviewer?.providerId || ''}
                onChange={(modelId, pid) =>
                  saveOrchestrationDefaults({
                    reviewer: modelId
                      ? {
                          modelId,
                          providerId: pid,
                          reasoningValue:
                            orchDefaults.reviewer?.modelId === modelId
                              ? orchDefaults.reviewer?.reasoningValue
                              : undefined
                        }
                      : undefined
                  })
                }
                placeholder="Как модель чата"
                sharedModels={allModels}
                sharedProviders={providers}
              />
              {orchDefaults.reviewer?.modelId && (
                <ReasoningSelector
                  modelId={orchDefaults.reviewer.modelId}
                  value={orchDefaults.reviewer.reasoningValue ?? ''}
                  onChange={setReviewerReasoning}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── ПАРАМЕТРЫ ── */}
      {tab === 'params' && (
        <div className="ai-params">
          <div className="ai-param-row ai-param-row--toggle">
            <label className="ai-param-label">
              Стриминг
              <span className="ai-param-hint">Показывать ответ по мере генерации</span>
            </label>
            <motion.button
              className={`ai-param-toggle ${params.streaming ? 'ai-param-toggle--on' : ''}`}
              onClick={() => updateParams({ streaming: !params.streaming })}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <motion.div
                className="ai-param-toggle-thumb"
                layout="position"
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              />
            </motion.button>
          </div>

          <div className="ai-param-row ai-param-row--toggle">
            <label className="ai-param-label">
              Анонимный User-Agent
              <span className="ai-param-hint">
                Скрывать кастомный заголовок Syntee — SDK отправляет стандартный User-Agent как у
                обычной библиотеки OpenAI
              </span>
            </label>
            <motion.button
              className={`ai-param-toggle ${params.anonymousUserAgent ? 'ai-param-toggle--on' : ''}`}
              onClick={() => updateParams({ anonymousUserAgent: !params.anonymousUserAgent })}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <motion.div
                className="ai-param-toggle-thumb"
                layout="position"
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              />
            </motion.button>
          </div>

          <div className="ai-param-row ai-param-row--full">
            <label className="ai-param-label">
              Дополнительная инструкция
              <span className="ai-param-hint">
                Дополнение к системному промпту для всех чатов. Не перезаписывает его, а добавляется
                отдельной секцией «Пользовательская инструкция».
              </span>
            </label>
            <textarea
              className="ai-param-textarea"
              rows={6}
              placeholder="Например: отвечай коротко, используй примеры кода..."
              value={systemPromptDraft}
              onChange={(e) => {
                const v = e.target.value
                setSystemPromptDraft(v)
                if (systemPromptTimerRef.current) clearTimeout(systemPromptTimerRef.current)
                systemPromptTimerRef.current = setTimeout(() => {
                  systemPromptTimerRef.current = null
                  updateParams({ systemPrompt: v })
                }, 400)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
