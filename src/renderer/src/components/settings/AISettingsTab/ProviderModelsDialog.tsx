import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ModelMeta, Provider } from '../../../../../shared/types'
import DialogShell from './DialogShell'
import { GATEWAY_PROVIDER_ID, useGatewayModelsStore } from '../../../store/gatewayModels.store'

type Props = { provider: Provider; onClose: () => void; onChanged: () => Promise<void> }
export default function ProviderModelsDialog({ provider, onClose, onChanged }: Props) {
  const [models, setModels] = useState<ModelMeta[]>([]),
    [query, setQuery] = useState(''),
    [newId, setNewId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const hosted = provider.id === GATEWAY_PROVIDER_ID
  const hostedModels = useGatewayModelsStore(s => hosted ? s.models : undefined)
  const custom = provider.isCustom
  const filtered = useMemo(
    () =>
      models.filter(
        (m) =>
          m.name.toLowerCase().includes(query.toLowerCase()) ||
          m.id.toLowerCase().includes(query.toLowerCase())
      ),
    [models, query]
  )
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 42,
    overscan: 6
  })
  const load = useCallback(async () => {
    const all = (await window.syntee.models.getAll()) as ModelMeta[]
    setModels(all.filter((m) => m.providerId === provider.id))
  }, [provider.id])
  useEffect(() => {
    void load().catch((e) =>
      setError(e instanceof Error ? e.message : 'Не удалось загрузить модели')
    )
  }, [load, hostedModels])
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [query])
  const refreshModels = async () => {
    setBusy(true)
    setRefresh('Обновление…')
    setError('')
    try {
      let count: number
      if (hosted) {
        await useGatewayModelsStore.getState().load()
        const catalog = useGatewayModelsStore.getState()
        if (catalog.error) throw new Error(catalog.error)
        count = catalog.models.length
      } else {
        const result = (await window.syntee.providers.fetchModels(provider.id)) as {
          ok: boolean
          count?: number
          error?: string
        }
        if (!result?.ok) throw new Error(result?.error || 'Не удалось обновить модели')
        count = result.count ?? 0
      }
      await load()
      await onChanged()
      setRefresh(`Обновлено: ${count} моделей`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка обновления')
      setRefresh('')
    } finally {
      setBusy(false)
    }
  }
  const add = async () => {
    const id = newId.trim()
    if (!id || !custom || busy) return
    setBusy(true)
    setError('')
    try {
      await window.syntee.models.saveCustom({
        id,
        providerId: provider.id,
        name: id,
        contextWindow: 0,
        capabilities: [],
        description: '',
        speed: 'medium'
      } as ModelMeta)
      setNewId('')
      await load()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось добавить модель')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (model: ModelMeta) => {
    if (!custom) return
    setBusy(true)
    try {
      await window.syntee.models.deleteCustom(model.id, provider.id)
      await load()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось удалить модель')
    } finally {
      setBusy(false)
    }
  }
  return (
    <DialogShell title={`Модели · ${provider.name}`} onClose={onClose}>
      <div className="provider-dialog-content">
        <div className="provider-models-toolbar">
          <input
            className="provider-form-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск моделей"
          />
          <span>
            {filtered.length} / {models.length}
          </span>
          <button className="provider-btn" disabled={busy} onClick={refreshModels}>
            {busy ? 'Обновление…' : 'Обновить'}
          </button>
        </div>
        {refresh && <p className="provider-dialog-result">{refresh}</p>}
        {error && (
          <p className="provider-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="provider-models-virtual" ref={scrollRef}>
          {filtered.length ? (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const model = filtered[item.index]
                return (
                  <div
                    key={`${model.providerId}:${model.id}`}
                    className="provider-model-row"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      transform: `translateY(${item.start}px)`,
                      height: item.size,
                      width: '100%'
                    }}
                  >
                    <span className="provider-model-name">
                      {model.name} <small>{model.id}</small>
                    </span>
                    {custom && (
                      <button
                        className="provider-model-remove"
                        disabled={busy}
                        onClick={() => void remove(model)}
                        aria-label={`Удалить ${model.name}`}
                      >
                        ×
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="provider-dialog-empty">
              {models.length ? 'Совпадений не найдено.' : 'Моделей пока нет. Обновите список.'}
            </p>
          )}
        </div>
        {custom && (
          <div className="provider-model-add">
            <input
              className="provider-form-input"
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add()
              }}
              placeholder="ID новой модели"
            />
            <button
              className="provider-btn provider-btn--save"
              disabled={busy || !newId.trim()}
              onClick={() => void add()}
            >
              Добавить
            </button>
          </div>
        )}
        <button className="provider-btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </DialogShell>
  )
}
