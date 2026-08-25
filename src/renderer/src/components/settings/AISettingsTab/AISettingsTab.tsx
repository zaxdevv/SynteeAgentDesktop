import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Provider, ModelAssignment, ModelParams, ModelRole, ModelCapability, ModelMeta } from '../../../../../shared/types'
import { BUILTIN_PROVIDERS_META } from '../../../../../shared/data/builtinModels'
import ModelPicker from '../../ui/ModelPicker/ModelPicker'
import AppIcon from '../../ui/AppIcon/AppIcon'
import BrandAvatar from '../../ui/BrandAvatar/BrandAvatar'
import { getBrandLogo } from '../../../utils/modelFormat'
import { useGatewayModelsStore } from '../../../store/gatewayModels.store'
import { whileHoverBtn, whileTapBtn, whileHoverSm, whileTapSm, whileHoverTiny, whileTapTiny, whileHoverWide, whileTapWide, springHover } from '../../../utils/motionPresets'
import './AISettingsTab.css'

const ROLE_META: Record<ModelRole, { label: string; desc: string; icon: string; filterCaps?: ModelCapability[] }> = {
  main:        { label: 'Основной чат',     desc: 'Для всех сообщений в чате',        icon: 'bot' },
  fast:        { label: 'Быстрые ответы',   desc: 'Автоназвания, короткие задачи',    icon: 'zap' },
  fastContext: { label: 'Быстрый контекст', desc: 'Tree-sitter retrieval + LLM сборка контекста по проекту', icon: 'compass', filterCaps: ['tools', 'code'] },
  vision:      { label: 'Vision / Картинки',desc: 'Анализ изображений и скриншотов',  icon: 'eye', filterCaps: ['vision'] },
  stt:         { label: 'Голос → Текст',    desc: 'Распознавание речи',               icon: 'mic',        filterCaps: ['stt'] },
  subagent:    { label: 'Суб-агенты',       desc: 'Модель для дочерних агентов',      icon: 'git-branch' },
  tts:         { label: 'Текст → Голос',    desc: 'Озвучивание ответов',              icon: 'volume',     filterCaps: ['tts'] },
  embedding:   { label: 'Embeddings',       desc: 'Векторный поиск и память',         icon: 'brain',      filterCaps: ['embedding'] },
  memory:      { label: 'Память',           desc: 'Анализ и сохранение воспоминаний', icon: 'database' },
  summary:     { label: 'Суммаризация',     desc: 'Авто-заголовки чатов',            icon: 'fileText' },
}

const BUILTIN_PROVIDER_IDS = Object.keys(BUILTIN_PROVIDERS_META)


export default function AISettingsTab() {
  const [tab, setTab] = useState<'providers' | 'models' | 'params'>('providers')
  const [providers, setProviders] = useState<Provider[]>([])
  const [allModels, setAllModels] = useState<ModelMeta[]>([])
  const [assignments, setAssignments] = useState<ModelAssignment[]>([])
  const [params, setParams] = useState<ModelParams>({ systemPrompt: '', streaming: true, anonymousUserAgent: false })
  const [configuring, setConfiguring] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Partial<Provider>>({})
  const [editKeys, setEditKeys] = useState<string[]>([''])
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'loading' | 'ok' | 'error'>>({})
  const [fetchStatus, setFetchStatus] = useState<Record<string, 'idle' | 'loading' | 'done'>>({})
  const [showAddCustom, setShowAddCustom] = useState(false)
  const [customForm, setCustomForm] = useState({ name: '', baseUrl: '', apiKey: '', modelsEndpoint: '' })
  const [imageModelId, setImageModelId] = useState('')
  const [imageProviderId, setImageProviderId] = useState('')
  const [newModelId, setNewModelId] = useState<Record<string, string>>({})
  const [modelsOpen, setModelsOpen] = useState<Record<string, boolean>>({})

  // ── Debounce для systemPrompt textarea ──────────────────────────────
  // Раньше updateParams({ systemPrompt }) звался на каждое нажатие → IPC
  // per keystroke + setParams → ре-рендер всего таба. Теперь локальный
  // draft отвечает мгновенно, IPC дебаунсится 400мс. Невидимо: тот же
  // результат, но без фризов при печати.
  const [systemPromptDraft, setSystemPromptDraft] = useState(params.systemPrompt)
  const systemPromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { setSystemPromptDraft(params.systemPrompt) }, [params.systemPrompt])

  useEffect(() => { load() }, [])

  // Перегружаем список моделей когда gateway-модели обновляются (после входа
  // или polling). Без этого ModelPicker не увидит новые модели.
  const gatewayLastFetch = useGatewayModelsStore(s => s.lastFetchAt)
  useEffect(() => {
    if (gatewayLastFetch > 0) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayLastFetch])

  const load = async () => {
    try {
      const [p, a, pm, imgS, models] = await Promise.all([
        window.syntee.providers.getAll() as Promise<Provider[]>,
        window.syntee.models.getAssignments() as Promise<ModelAssignment[]>,
        window.syntee.models.getParams() as Promise<ModelParams>,
        window.syntee.image.getSettings(),
        window.syntee.models.getAll() as Promise<ModelMeta[]>,
      ])
      setProviders(p)
      setAllModels(models)
      setAssignments(a)
      setParams(pm)
      setImageModelId(imgS.modelId || '')
      setImageProviderId(imgS.providerId || '')
    } catch (e) {
      console.error('[AISettingsTab] load error', e)
    }
  }

  const getProviderMeta = (id: string) => BUILTIN_PROVIDERS_META[id]

  // Анонимные провайдеры работают без API-ключа (шлют Bearer public).
  // Для них скрываем поле ключа и считаем «настроенным» без ввода.
  const isAnonymousProvider = (id: string) => id === 'opencode-free'

  // Провайдеры, требующие обязательного ввода OPENCODE_API_KEY в UI.
  const isKeyRequiredProvider = (id: string) => id === 'opencode' || id === 'opencode-go'

  const isConfigured = (id: string) => providers.find(p => p.id === id && p.enabled && (p.apiKey || p.anonymous))

  const startConfigure = (id: string) => {
    const existing = providers.find(p => p.id === id)
    const meta = BUILTIN_PROVIDERS_META[id]
    const anon = isAnonymousProvider(id)
    setEditForm({
      id,
      type: id as Provider['type'],
      name: meta?.name || id,
      baseUrl: existing?.baseUrl || meta?.baseUrl || '',
      apiKey: anon ? 'public' : (existing?.apiKey || ''),
      enabled: true,
      isCustom: false,
      anonymous: anon || undefined,
    })
    // Инициализируем список ключей: apiKeys если есть, иначе apiKey как первый.
    // Анонимные — один «public» (не редактируется, поле скрыто).
    const keys = anon
      ? ['public']
      : (existing?.apiKeys?.length
        ? existing.apiKeys
        : existing?.apiKey ? [existing.apiKey] : [''])
    setEditKeys(keys)
    setConfiguring(id)
    setTestStatus(s => ({ ...s, [id]: 'idle' }))
  }

  const saveProvider = async () => {
    if (!editForm.id) return
    const validKeys = editKeys.filter(k => k.trim())
    // OpenCode Zen / Go — ключ обязателен. Анонимные (opencode-free) проходят с 'public'.
    if (isKeyRequiredProvider(editForm.id) && validKeys.length === 0) return
    await window.syntee.providers.save({
      ...editForm,
      apiKey: editForm.anonymous ? 'public' : (validKeys[0] || ''),   // первый ключ — обратная совместимость
      apiKeys: editForm.anonymous ? ['public'] : validKeys,
      rrIndex: 0,                   // сбрасываем round-robin при сохранении
      enabled: true,
    } as Provider)
    await load()
    setConfiguring(null)
  }

  const deleteProvider = async (id: string) => {
    await window.syntee.providers.delete(id)
    await load()
  }

  const testKey = async (id: string) => {
    if (isKeyRequiredProvider(id) && !editKeys.some(k => k.trim())) return
    setTestStatus(s => ({ ...s, [id]: 'loading' }))
    await window.syntee.providers.save({ ...editForm, id, enabled: true } as Provider)
    const res = await window.syntee.providers.testKey(id) as { ok: boolean }
    setTestStatus(s => ({ ...s, [id]: res.ok ? 'ok' : 'error' }))
  }

  const fetchModels = async (id: string) => {
    setFetchStatus(s => ({ ...s, [id]: 'loading' }))
    try {
      const res = await window.syntee.providers.fetchModels(id) as { ok: boolean; error?: string; count?: number }
      if (res?.ok) {
        setFetchStatus(s => ({ ...s, [id]: `ok:${res.count ?? 0}` }))
      } else {
        setFetchStatus(s => ({ ...s, [id]: `error:${res?.error || 'Ошибка'}` }))
      }
    } catch (e) {
      setFetchStatus(s => ({ ...s, [id]: `error:${e instanceof Error ? e.message : 'Ошибка'}` }))
    }
    await load()
  }

  const setAssignment = async (role: ModelRole, modelId: string, pid: string) => {
    const a: ModelAssignment = { role, modelId, providerId: pid }
    await window.syntee.models.setAssignment(a)
    setAssignments(prev => {
      const next = [...prev.filter(x => x.role !== role), a]
      return next
    })
  }

  const updateParams = async (patch: Partial<ModelParams>) => {
    const next = { ...params, ...patch }
    setParams(next)
    await window.syntee.models.setParams(patch)
  }

  const addCustomProvider = async () => {
    if (!customForm.name || !customForm.baseUrl) return
    const id = `custom-${Date.now()}`
    await window.syntee.providers.save({
      id, type: 'custom', name: customForm.name,
      baseUrl: customForm.baseUrl, apiKey: customForm.apiKey,
      modelsEndpoint: customForm.modelsEndpoint || undefined,
      enabled: true, isCustom: true,
    } as Provider)
    setCustomForm({ name: '', baseUrl: '', apiKey: '', modelsEndpoint: '' })
    setShowAddCustom(false)
    await load()
    // Сразу тянем модели от нового провайдера
    await fetchModels(id)
  }

  return (
    <div className="ai-settings">
      {/* Заголовок раздела — раньше его не было, таб-бар «висел» в воздухе. */}
      <h2 className="settings-section-title">ИИ и Модели</h2>

      {/* Segmented control: pill-переключатель со скользящим индикатором
          вместо underline-табов. layoutId animates между сегментами. */}
      <div className="ai-seg" role="tablist" aria-label="Настройки ИИ">
        {(['providers', 'models', 'params'] as const).map(t => (
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

      {/* ── ПРОВАЙДЕРЫ ── */}
      {tab === 'providers' && (
        <div className="ai-providers">
          <div className="ai-providers-grid">
            {BUILTIN_PROVIDER_IDS.map((id, i) => {
              const meta = getProviderMeta(id)
              const configured = !!isConfigured(id)
              return (
                <motion.div
                  key={id}
                  className={`provider-card glass ${configured ? 'provider-card--active' : ''}`}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 28, delay: i * 0.035 }}
                  whileHover={{ scale: 1.02, transition: { type: 'spring', stiffness: 500, damping: 30 } }}
                >
                  <div className="provider-card-header">
                    <BrandAvatar
                      logo={getBrandLogo(id, '', '', undefined)}
                      fallbackColor={meta.color}
                      size={18}
                      className="provider-logo"
                    />
                    <span className="provider-name">{meta.name}</span>
                    <span className={`provider-status ${configured ? 'provider-status--ok' : ''}`}>
                      {configured ? (isAnonymousProvider(id) ? 'Аноним' : 'Настроен') : 'Не настроен'}
                    </span>
                  </div>

                  <AnimatePresence initial={false}>
                    {configuring === id && (
                      <motion.div
                        className="provider-form"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                        style={{ overflow: 'hidden' }}
                      >
                        {editForm.anonymous ? (
                          <div className="provider-anonymous-note">
                            <AppIcon name="check" size="xs" tone="success" />
                            <span>Анонимный доступ — без API-ключа. Доступны только free-модели (суффикс <code>-free</code>).</span>
                          </div>
                        ) : (
                          <>
                            <label className="provider-form-label">
                              API Keys
                              {editKeys.length > 1 && (
                                <span className="provider-form-rr-badge">round-robin · {editKeys.filter(k=>k.trim()).length} ключей</span>
                              )}
                            </label>
                            <div className="provider-keys-list">
                              {editKeys.map((key, ki) => (
                                <div key={ki} className="provider-key-row">
                                  <input
                                    className="provider-form-input provider-key-input"
                                    type="password"
                                    placeholder={ki === 0 ? 'sk-... (основной)' : `sk-... (ключ ${ki + 1})`}
                                    value={key}
                                    onChange={e => setEditKeys(ks => ks.map((k, i) => i === ki ? e.target.value : k))}
                                  />
                                  {editKeys.length > 1 && (
                                    <motion.button
                                      className="provider-key-remove"
                                      onClick={() => setEditKeys(ks => ks.filter((_, i) => i !== ki))}
                                      title="Удалить ключ"
                                      whileHover={whileHoverTiny}
                                      whileTap={whileTapTiny}
                                      transition={springHover}
                                    >×</motion.button>
                                  )}
                                </div>
                              ))}
                              <motion.button
                                className="provider-key-add"
                                onClick={() => setEditKeys(ks => [...ks, ''])}
                                whileHover={whileHoverBtn}
                                whileTap={whileTapBtn}
                                transition={springHover}
                              >
                                + Добавить ключ
                              </motion.button>
                            </div>
                          </>
                        )}
                        {id === 'ollama' && (
                          <>
                            <label className="provider-form-label">Base URL</label>
                            <input
                              className="provider-form-input"
                              value={editForm.baseUrl || ''}
                              onChange={e => setEditForm(f => ({ ...f, baseUrl: e.target.value }))}
                            />
                          </>
                        )}
                        <div className="provider-form-actions">
                          <motion.button
                            className="provider-btn provider-btn--test"
                            onClick={() => testKey(id)}
                            disabled={testStatus[id] === 'loading' || (isKeyRequiredProvider(id) && !editKeys.some(k => k.trim()))}
                            whileHover={whileHoverBtn}
                            whileTap={whileTapBtn}
                            transition={springHover}
                          >
                            {testStatus[id] === 'loading' ? (
                              <AppIcon name="loader" size="xs" animation="spin" />
                            ) : testStatus[id] === 'ok' ? (
                              <AppIcon name="check" size="xs" tone="success" />
                            ) : testStatus[id] === 'error' ? (
                              <AppIcon name="alertCircle" size="xs" tone="error" />
                            ) : (
                              <AppIcon name="zap" size="xs" />
                            )}
                            Проверить
                          </motion.button>
                          <motion.button
                            className="provider-btn provider-btn--save"
                            onClick={saveProvider}
                            disabled={isKeyRequiredProvider(id) && !editKeys.some(k => k.trim())}
                            title={isKeyRequiredProvider(id) && !editKeys.some(k => k.trim()) ? 'Введите API-ключ' : undefined}
                            whileHover={whileHoverBtn}
                            whileTap={whileTapBtn}
                            transition={springHover}
                          >
                            Сохранить
                          </motion.button>
                          <motion.button className="provider-btn provider-btn--cancel" onClick={() => setConfiguring(null)} whileHover={whileHoverBtn} whileTap={whileTapBtn} transition={springHover}>
                            Отмена
                          </motion.button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div className="provider-card-footer">
                    {configuring !== id && (
                      <motion.button className="provider-btn provider-btn--configure" onClick={() => startConfigure(id)} whileHover={whileHoverBtn} whileTap={whileTapBtn} transition={springHover}>
                        {configured ? 'Изменить' : 'Настроить'}
                      </motion.button>
                    )}
                    {configured && (
                      <motion.button
                        className="provider-btn provider-btn--fetch"
                        onClick={() => fetchModels(id)}
                        disabled={fetchStatus[id] === 'loading'}
                        whileHover={whileHoverBtn}
                        whileTap={whileTapBtn}
                        transition={springHover}
                      >
                        {fetchStatus[id] === 'loading' ? (
                          <AppIcon name="loader" size="xs" animation="spin" />
                        ) : (
                          <AppIcon name="refreshCw" size="xs" />
                        )}
                        Модели
                      </motion.button>
                    )}
                    {/* Статус последнего fetchModels */}
                    {fetchStatus[id] && fetchStatus[id] !== 'loading' && (
                      <span className={`provider-fetch-status ${fetchStatus[id].startsWith('ok') ? 'provider-fetch-status--ok' : 'provider-fetch-status--err'}`}>
                        {fetchStatus[id].startsWith('ok:')
                          ? `✓ ${fetchStatus[id].slice(3)} моделей`
                          : `✗ ${fetchStatus[id].startsWith('error:') ? fetchStatus[id].slice(6) : fetchStatus[id]}`}
                      </span>
                    )}
                    {configured && (
                      <motion.button className="provider-btn provider-btn--delete" onClick={() => deleteProvider(id)} whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
                        <AppIcon name="trash" size="xs" />
                      </motion.button>
                    )}
                  </div>
                </motion.div>
              )
            })}

            {/* Кастомные провайдеры */}
            {providers.filter(p => p.isCustom).map(p => {
              const providerModels = allModels.filter(m => m.providerId === p.id)
              return (
              <motion.div key={p.id} className="provider-card provider-card--custom glass">
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
                <div className="provider-url">{p.baseUrl}{p.modelsEndpoint || '/models'}</div>

                {/* Форма редактирования кастомного провайдера */}
                <AnimatePresence initial={false}>
                  {configuring === p.id && (
                    <motion.div
                      className="provider-form"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                      style={{ overflow: 'hidden' }}
                    >
                      <label className="provider-form-label">Название</label>
                      <input className="provider-form-input" value={editForm.name || ''}
                        onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
                      <label className="provider-form-label">Base URL</label>
                      <input className="provider-form-input" value={editForm.baseUrl || ''}
                        onChange={e => setEditForm(f => ({ ...f, baseUrl: e.target.value }))} />
                      <label className="provider-form-label">API Key</label>
                      <input className="provider-form-input" type="password" value={editForm.apiKey || ''}
                        onChange={e => setEditForm(f => ({ ...f, apiKey: e.target.value }))} />
                      <label className="provider-form-label">Models endpoint <span className="provider-form-hint">(по умолчанию /models)</span></label>
                      <input className="provider-form-input" placeholder="/v1/models" value={editForm.modelsEndpoint || ''}
                        onChange={e => setEditForm(f => ({ ...f, modelsEndpoint: e.target.value }))} />
                      <div className="provider-form-actions">
                        <motion.button className="provider-btn provider-btn--save" onClick={saveProvider}
                          whileHover={whileHoverBtn} whileTap={whileTapBtn} transition={springHover}>
                          Сохранить
                        </motion.button>
                        <motion.button className="provider-btn provider-btn--cancel" onClick={() => setConfiguring(null)}
                          whileHover={whileHoverBtn} whileTap={whileTapBtn} transition={springHover}>
                          Отмена
                        </motion.button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Ручное управление моделями — сворачиваемая секция */}
                <div className="provider-models-section">
                  <div className="provider-models-header" onClick={() => setModelsOpen(s => ({ ...s, [p.id]: !s[p.id] }))}>
                    <AppIcon name="chevronDown" size="xs" tone="muted" />
                    <span className="provider-form-label">Модели</span>
                    {providerModels.length > 0 && <span className="provider-models-count">{providerModels.length}</span>}
                  </div>
                  <AnimatePresence initial={false}>
                    {(modelsOpen[p.id] ?? true) && (
                      <motion.div
                        className="provider-models-body"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                        style={{ overflow: 'hidden' }}
                      >
                        {providerModels.length > 0 && (
                          <div className="provider-models-list">
                            {providerModels.map(m => (
                              <div key={m.id} className="provider-model-row">
                                <span className="provider-model-name">{m.name}</span>
                                <button className="provider-model-remove" title="Удалить модель"
                                  onClick={async () => {
                                    await window.syntee.models.deleteCustom(m.id, p.id)
                                    await load()
                                  }}>×</button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="provider-model-add">
                          <input
                            className="provider-form-input provider-model-add-input"
                            placeholder="ID модели (например gpt-4o)"
                            value={newModelId[p.id] || ''}
                            onChange={e => setNewModelId(s => ({ ...s, [p.id]: e.target.value }))}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                const mid = (newModelId[p.id] || '').trim()
                                if (mid) {
                                  window.syntee.models.saveCustom({
                                    id: mid, providerId: p.id, name: mid,
                                    contextWindow: 0, capabilities: [], description: '', speed: 'medium',
                                  } as ModelMeta)
                                  setNewModelId(s => ({ ...s, [p.id]: '' }))
                                  load()
                                }
                              }
                            }}
                          />
                          <motion.button
                            className="provider-btn provider-model-add-btn"
                            onClick={async () => {
                              const mid = (newModelId[p.id] || '').trim()
                              if (!mid) return
                              await window.syntee.models.saveCustom({
                                id: mid, providerId: p.id, name: mid,
                                contextWindow: 0, capabilities: [], description: '', speed: 'medium',
                              } as ModelMeta)
                              setNewModelId(s => ({ ...s, [p.id]: '' }))
                              await load()
                            }}
                            whileHover={whileHoverBtn} whileTap={whileTapBtn} transition={springHover}
                          >
                            <AppIcon name="plus" size="xs" /> Добавить
                          </motion.button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div className="provider-card-footer">
                  {configuring !== p.id && (
                    <motion.button className="provider-btn provider-btn--configure" onClick={() => { setEditForm(p); setConfiguring(p.id) }} whileHover={whileHoverBtn} whileTap={whileTapBtn} transition={springHover}>
                      Изменить
                    </motion.button>
                  )}
                  <motion.button className="provider-btn provider-btn--fetch" onClick={() => fetchModels(p.id)} disabled={fetchStatus[p.id] === 'loading'} whileHover={whileHoverBtn} whileTap={whileTapBtn} transition={springHover}>
                    {fetchStatus[p.id] === 'loading'
                      ? <AppIcon name="loader" size="xs" animation="spin" />
                      : <AppIcon name="refreshCw" size="xs" />}
                    Модели
                  </motion.button>
                  {fetchStatus[p.id] && fetchStatus[p.id] !== 'loading' && (
                    <span className={`provider-fetch-status ${fetchStatus[p.id].startsWith('ok') ? 'provider-fetch-status--ok' : 'provider-fetch-status--err'}`}>
                      {fetchStatus[p.id].startsWith('ok:')
                        ? `✓ ${fetchStatus[p.id].slice(3)} моделей`
                        : `✗ ${fetchStatus[p.id].startsWith('error:') ? fetchStatus[p.id].slice(6) : fetchStatus[p.id]}`}
                    </span>
                  )}
                  <motion.button className="provider-btn provider-btn--delete" onClick={() => deleteProvider(p.id)} whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
                    <AppIcon name="trash" size="xs" />
                  </motion.button>
                </div>
              </motion.div>
              )
            })}

            {/* Кнопка добавить кастомный */}
            <motion.div className="provider-card provider-card--add glass">
              {!showAddCustom ? (
                <motion.button className="provider-add-btn" onClick={() => setShowAddCustom(true)} whileHover={whileHoverWide} whileTap={whileTapWide} transition={springHover}>
                  <AppIcon name="plus" size="md" />
                  <span>Добавить свой</span>
                </motion.button>
              ) : (
                <div className="provider-form">
                  <label className="provider-form-label">Название</label>
                  <input className="provider-form-input" placeholder="My Provider" value={customForm.name} onChange={e => setCustomForm(f => ({ ...f, name: e.target.value }))} />
                  <label className="provider-form-label">Base URL</label>
                  <input className="provider-form-input" placeholder="https://api.example.com/v1" value={customForm.baseUrl} onChange={e => setCustomForm(f => ({ ...f, baseUrl: e.target.value }))} />
                  <label className="provider-form-label">API Key (если нужен)</label>
                  <input className="provider-form-input" type="password" value={customForm.apiKey} onChange={e => setCustomForm(f => ({ ...f, apiKey: e.target.value }))} />
                  <label className="provider-form-label">Models endpoint <span className="provider-form-hint">(по умолчанию /models)</span></label>
                  <input className="provider-form-input" placeholder="/v1/models" value={customForm.modelsEndpoint} onChange={e => setCustomForm(f => ({ ...f, modelsEndpoint: e.target.value }))} />
                  <div className="provider-form-actions">
                    <motion.button className="provider-btn provider-btn--save" onClick={addCustomProvider} whileHover={whileHoverBtn} whileTap={whileTapBtn} transition={springHover}>Добавить</motion.button>
                    <motion.button className="provider-btn provider-btn--cancel" onClick={() => setShowAddCustom(false)} whileHover={whileHoverBtn} whileTap={whileTapBtn} transition={springHover}>Отмена</motion.button>
                  </div>
                </div>
              )}
            </motion.div>
          </div>
        </div>
      )}

      {/* ── НАЗНАЧЕНИЯ МОДЕЛЕЙ ── */}
      {tab === 'models' && (
        <div className="ai-assignments">
          <p className="ai-assignments-hint">Назначьте модели для каждой роли. Модели берутся из настроенных провайдеров.</p>
          <div className="ai-assignments-grid">
            {(Object.keys(ROLE_META) as ModelRole[]).map((role, i) => {
              const meta = ROLE_META[role]
              const current = assignments.find(a => a.role === role)
              return (
                <motion.div
                  key={role}
                  className="assignment-row glass"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 28, delay: i * 0.04 }}
                  whileHover={{ scale: 1.01, transition: { type: 'spring', stiffness: 500, damping: 30 } }}
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
                      placeholder="Не выбрано"
                      sharedModels={allModels}
                      sharedProviders={providers}
                    />
                  </div>
                </motion.div>
              )
            })}
          </div>

          {/* ── Генерация изображений ── */}
          <motion.div
            className="assignment-row glass"
            style={{ marginTop: 12 }}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28, delay: Object.keys(ROLE_META).length * 0.04 }}
            whileHover={{ scale: 1.01, transition: { type: 'spring', stiffness: 500, damping: 30 } }}
          >
            <div className="assignment-info">
              <AppIcon name="image" size="sm" tone="accent" />
              <div>
                <div className="assignment-label">Генерация изображений</div>
                <div className="assignment-desc">Используется командой /image и tool generate_image</div>
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
          </motion.div>

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
              <motion.div className="ai-param-toggle-thumb" layout="position" transition={{ type: 'spring', stiffness: 500, damping: 30 }} />
            </motion.button>
          </div>

          <div className="ai-param-row ai-param-row--toggle">
            <label className="ai-param-label">
              Анонимный User-Agent
              <span className="ai-param-hint">Скрывать кастомный заголовок Syntee — SDK отправляет стандартный User-Agent как у обычной библиотеки OpenAI</span>
            </label>
            <motion.button
              className={`ai-param-toggle ${params.anonymousUserAgent ? 'ai-param-toggle--on' : ''}`}
              onClick={() => updateParams({ anonymousUserAgent: !params.anonymousUserAgent })}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <motion.div className="ai-param-toggle-thumb" layout="position" transition={{ type: 'spring', stiffness: 500, damping: 30 }} />
            </motion.button>
          </div>

          <div className="ai-param-row ai-param-row--full">
            <label className="ai-param-label">
              Дополнительная инструкция
              <span className="ai-param-hint">Дополнение к системному промпту для всех чатов. Не перезаписывает его, а добавляется отдельной секцией «Пользовательская инструкция».</span>
            </label>
            <textarea
              className="ai-param-textarea"
              rows={6}
              placeholder="Например: отвечай коротко, используй примеры кода..."
              value={systemPromptDraft}
              onChange={e => {
                const v = e.target.value
                setSystemPromptDraft(v)
                if (systemPromptTimerRef.current) clearTimeout(systemPromptTimerRef.current)
                systemPromptTimerRef.current = setTimeout(() => {
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
