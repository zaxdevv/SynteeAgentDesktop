import { useState } from 'react'
import type { Provider } from '../../../../../shared/types'
import DialogShell from './DialogShell'

type Props = { provider: Provider; onClose: () => void; onSaved: () => Promise<void> }
const requiredKey = (id: string) => id === 'opencode' || id === 'opencode-go'

export default function ProviderEditorDialog({ provider, onClose, onSaved }: Props) {
  const anonymous = provider.id === 'opencode-free'
  const [name, setName] = useState(provider.name)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [keys, setKeys] = useState<string[]>(
    provider.anonymous
      ? ['public']
      : provider.apiKeys?.length
        ? [...provider.apiKeys]
        : [provider.apiKey || '']
  )
  const anonymousMode = !!provider.anonymous || anonymous
  const [operation, setOperation] = useState<'save' | 'test' | null>(null)
  const [modelsEndpoint, setModelsEndpoint] = useState(provider.modelsEndpoint || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [testResult, setTestResult] = useState('')
  const validKeys = keys.map((k) => k.trim()).filter(Boolean)
  const validate = () => {
    if (!name.trim()) return 'Введите название провайдера.'
    try {
      if (!baseUrl.trim() || !['http:', 'https:'].includes(new URL(baseUrl).protocol))
        return 'Введите корректный Base URL.'
    } catch {
      return 'Введите корректный Base URL.'
    }
    if (!anonymousMode && requiredKey(provider.id) && !validKeys.length)
      return 'Для OpenCode требуется API-ключ.'
    return ''
  }
  const draft = (): Provider => ({
    ...provider,
    name: name.trim(),
    baseUrl: baseUrl.trim(),
    apiKey: anonymousMode ? 'public' : validKeys[0] || '',
    apiKeys: anonymousMode ? ['public'] : validKeys,
    rrIndex: 0,
    anonymous: anonymousMode || undefined,
    modelsEndpoint: modelsEndpoint.trim() || undefined,
    enabled: true
  })
  const save = async () => {
    const issue = validate()
    setError(issue)
    if (issue) return
    setBusy(true)
    setOperation('save')
    try {
      await window.syntee.providers.save(draft())
      await onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить провайдера.')
    } finally {
      setBusy(false)
    }
  }
  const test = async () => {
    const issue = validate()
    setError(issue)
    if (issue) return
    setBusy(true)
    setOperation('test')
    setTestResult('')
    try {
      const result = (await window.syntee.providers.testKey(provider.id, draft())) as {
        ok: boolean
        error?: string
        message?: string
      }
      setTestResult(
        result.ok
          ? 'Подключение успешно.'
          : result.error || result.message || 'Проверка не пройдена.'
      )
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : 'Ошибка проверки.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <DialogShell
      title={`${provider.isCustom ? 'Провайдер' : 'Настройка'}: ${provider.name}`}
      onClose={onClose}
    >
      <div className="provider-dialog-content">
        <label className="provider-form-label">
          Название
          <input
            className="provider-form-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="provider-form-label">
          Base URL
          <input
            className="provider-form-input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </label>
        {provider.id === 'ollama' && (
          <p className="provider-dialog-hint">URL локального сервера Ollama.</p>
        )}
        {provider.isCustom && (
          <label className="provider-form-label">
            Models endpoint
            <input
              className="provider-form-input"
              value={modelsEndpoint}
              onChange={(e) => setModelsEndpoint(e.target.value)}
              placeholder="/v1/models (по умолчанию /models)"
            />
          </label>
        )}
        {!anonymous && (
          <>
            <span className="provider-form-label">
              API keys{' '}
              {keys.length > 1 && (
                <span className="provider-form-rr-badge">
                  round-robin · {validKeys.length} ключей
                </span>
              )}
            </span>
            <div className="provider-keys-list">
              {keys.map((key, i) => (
                <div className="provider-key-row" key={i}>
                  <input
                    className="provider-form-input provider-key-input"
                    type="password"
                    value={key}
                    placeholder={`API key ${i + 1}`}
                    onChange={(e) =>
                      setKeys((old) => old.map((v, n) => (n === i ? e.target.value : v)))
                    }
                  />
                  {keys.length > 1 && (
                    <button
                      type="button"
                      className="provider-key-remove"
                      onClick={() => setKeys((old) => old.filter((_, n) => n !== i))}
                      aria-label="Удалить ключ"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="provider-key-add"
                onClick={() => setKeys((old) => [...old, ''])}
              >
                + Добавить ключ
              </button>
            </div>
          </>
        )}
        {anonymous && (
          <p className="provider-dialog-hint">
            Анонимный доступ без API-ключа. Доступны free-модели.
          </p>
        )}
        {error && (
          <p className="provider-dialog-error" role="alert">
            {error}
          </p>
        )}
        {testResult && (
          <p className="provider-dialog-result" role="status">
            {testResult}
          </p>
        )}
        <footer className="provider-form-actions">
          <button className="provider-btn" disabled={busy} onClick={test}>
            {busy && operation === 'test' ? 'Проверка…' : 'Проверить подключение'}
          </button>
          <button className="provider-btn provider-btn--save" disabled={busy} onClick={save}>
            {busy && operation === 'save' ? 'Сохранение…' : 'Сохранить'}
          </button>
          <button className="provider-btn" disabled={busy} onClick={onClose}>
            Отмена
          </button>
        </footer>
      </div>
    </DialogShell>
  )
}
