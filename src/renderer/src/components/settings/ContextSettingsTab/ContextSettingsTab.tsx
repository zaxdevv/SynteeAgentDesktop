import { useState, useEffect } from 'react'
import { useSettingsStore } from '../../../store/settings.store'
import { DEFAULT_CONTEXT_SETTINGS, type ContextSettings } from '../../../../../core/context/contextManager'
import Toggle from '../../ui/Toggle/Toggle'
import ResetButton from '../../ui/ResetButton/ResetButton'
import { SectionTitle, Group, Field } from '../SettingsPrimitives'
import './ContextSettingsTab.css'

export default function ContextSettingsTab() {
  const { get, set } = useSettingsStore()
  const saved = get<Partial<ContextSettings>>('contextSettings', {})
  const s: ContextSettings = { ...DEFAULT_CONTEXT_SETTINGS, ...saved }

  const upd = (patch: Partial<ContextSettings>) => {
    set('contextSettings', { ...s, ...patch })
  }

  // Агентные настройки — через agent.getSettings/setSettings
  const [agentS, setAgentS] = useState<{
    readFileCache: boolean
  }>({
    readFileCache: true,
  })

  useEffect(() => {
    window.syntee.agent.getSettings().then((r: Record<string, unknown>) => {
      setAgentS({
        readFileCache: r.readFileCache !== false,
      })
    }).catch(() => {})
  }, [])

  const setAgentSetting = (key: string, value: unknown) => {
    setAgentS(prev => ({ ...prev, [key]: value }))
    window.syntee.agent.setSettings({ [key]: value }).catch(() => {})
  }

  return (
    <div className="ctx-tab">

      <SectionTitle description="Обрезка тулов, сжатие истории и подсчёт контекста">
        Контекст
      </SectionTitle>

      {/* ── Tool truncation ── */}
      <Group
        id="ctx-truncation"
        icon="filter"
        title="Обрезка тулов"
        right={
          <>
            <Toggle value={s.toolTruncEnabled} onChange={v => upd({ toolTruncEnabled: v })} />
            <ResetButton current={s.toolTruncEnabled} defaultValue={DEFAULT_CONTEXT_SETTINGS.toolTruncEnabled} onReset={() => upd({ toolTruncEnabled: DEFAULT_CONTEXT_SETTINGS.toolTruncEnabled })} />
          </>
        }
      >
        <p className="settings-card-intro">
          Большие ответы тулов (read_file, run_command, search_code и др.) обрезаются до указанного лимита.
          Показывается начало и конец, середина сжимается.
        </p>
        <div className={`ctx-fields${!s.toolTruncEnabled ? ' ctx-field--disabled' : ''}`}>
          <div className="ctx-field" data-field-id="ctx-toolMaxChars">
            <label>Макс. символов на тул-результат</label>
            <div className="ctx-slider-row">
              <input type="range" min={500} max={16000} step={500}
                value={s.toolMaxChars}
                disabled={!s.toolTruncEnabled}
                onChange={e => upd({ toolMaxChars: +e.target.value })}
              />
              <span className="ctx-slider-val">{s.toolMaxChars.toLocaleString()}</span>
              <ResetButton current={s.toolMaxChars} defaultValue={DEFAULT_CONTEXT_SETTINGS.toolMaxChars} onReset={() => upd({ toolMaxChars: DEFAULT_CONTEXT_SETTINGS.toolMaxChars })} />
            </div>
            <span className="ctx-hint">Рекомендуется 3000–6000. По умолчанию: 6000</span>
          </div>
        </div>
      </Group>

      {/* ── Rolling window ── */}
      <Group
        id="ctx-rolling"
        icon="history"
        title="Сжатие истории"
        note="rolling window"
        right={
          <>
            <Toggle value={s.rollingEnabled} onChange={v => upd({ rollingEnabled: v })} />
            <ResetButton current={s.rollingEnabled} defaultValue={DEFAULT_CONTEXT_SETTINGS.rollingEnabled} onReset={() => upd({ rollingEnabled: DEFAULT_CONTEXT_SETTINGS.rollingEnabled })} />
          </>
        }
      >
        <p className="settings-card-intro">
          Когда история чата заполняет контекст выше порога — старые сообщения сжимаются в резюме.
          Первые и последние сообщения всегда сохраняются полностью.
          Лимит токенов берётся автоматически от активной модели провайдера.
        </p>
        <div className={`ctx-fields${!s.rollingEnabled ? ' ctx-field--disabled' : ''}`}>
          <div className="ctx-field" data-field-id="ctx-rollingTriggerPct">
            <label>Триггер сжатия (%)</label>
            <div className="ctx-slider-row">
              <input type="range" min={50} max={95} step={5}
                value={s.rollingTriggerPct}
                disabled={!s.rollingEnabled}
                onChange={e => upd({ rollingTriggerPct: +e.target.value })}
              />
              <span className="ctx-slider-val">{s.rollingTriggerPct}%</span>
              <ResetButton current={s.rollingTriggerPct} defaultValue={DEFAULT_CONTEXT_SETTINGS.rollingTriggerPct} onReset={() => upd({ rollingTriggerPct: DEFAULT_CONTEXT_SETTINGS.rollingTriggerPct })} />
            </div>
            <span className="ctx-hint">При заполнении на этот % — запустится сжатие. По умолчанию: 85%</span>
          </div>
          <div className="ctx-row2">
            <div className="ctx-field" data-field-id="ctx-rollingKeepFirst">
              <label>Сохранять первых сообщений</label>
              <div className="ctx-slider-row">
                <input type="range" min={1} max={6} step={1}
                  value={s.rollingKeepFirst}
                  disabled={!s.rollingEnabled}
                  onChange={e => upd({ rollingKeepFirst: +e.target.value })}
                />
                <span className="ctx-slider-val">{s.rollingKeepFirst}</span>
                <ResetButton current={s.rollingKeepFirst} defaultValue={DEFAULT_CONTEXT_SETTINGS.rollingKeepFirst} onReset={() => upd({ rollingKeepFirst: DEFAULT_CONTEXT_SETTINGS.rollingKeepFirst })} />
              </div>
              <span className="ctx-hint">По умолчанию: 2</span>
            </div>
            <div className="ctx-field" data-field-id="ctx-rollingKeepLast">
              <label>Сохранять последних сообщений</label>
              <div className="ctx-slider-row">
                <input type="range" min={4} max={30} step={2}
                  value={s.rollingKeepLast}
                  disabled={!s.rollingEnabled}
                  onChange={e => upd({ rollingKeepLast: +e.target.value })}
                />
                <span className="ctx-slider-val">{s.rollingKeepLast}</span>
                <ResetButton current={s.rollingKeepLast} defaultValue={DEFAULT_CONTEXT_SETTINGS.rollingKeepLast} onReset={() => upd({ rollingKeepLast: DEFAULT_CONTEXT_SETTINGS.rollingKeepLast })} />
              </div>
              <span className="ctx-hint">По умолчанию: 20</span>
            </div>
          </div>
        </div>
      </Group>

      {/* ── Token counter ── */}
      <Group
        id="ctx-token-counter"
        icon="calculator"
        title="Счётчик токенов"
        right={
          <>
            <Toggle value={s.tokenCounterEnabled} onChange={v => upd({ tokenCounterEnabled: v })} />
            <ResetButton current={s.tokenCounterEnabled} defaultValue={DEFAULT_CONTEXT_SETTINGS.tokenCounterEnabled} onReset={() => upd({ tokenCounterEnabled: DEFAULT_CONTEXT_SETTINGS.tokenCounterEnabled })} />
          </>
        }
      >
        <p className="settings-card-intro">
          Управляет подсчётом и отображением использования контекста в кольце у поля ввода.
          Кольцо всегда видимо: жёлтый — предупреждение (60–85%), красный — критично (&gt;85%).
          Приоритет — реальные данные от провайдера, fallback — оценка tiktoken.
        </p>
      </Group>

      {/* ── Рабочая память ── */}
      <Group id="ctx-working-memory" icon="clipboard" title="Рабочая память агента">
        <p className="settings-card-intro">
          Агент автоматически запоминает что делал в этом чате — изменённые файлы, принятые решения,
          текущее состояние проекта. Память сохраняется между сообщениями и включается в system prompt.
          Агент сам обновляет её через инструмент <code>update_working_memory</code> в конце сессии.
        </p>
        <div className="ctx-fields">
          <span className="ctx-hint">💡 Подсказка: напиши агенту «запомни что ты сделал» — он обновит рабочую память вручную.</span>
        </div>
      </Group>

      {/* ── Diff журнал + File Map ── */}
      <Group id="ctx-edits" icon="filePen" title="Контекст правок">
        <p className="settings-card-intro">
          Diff журнал и карта файлов — агент помнит что менял и что читал между запросами.
        </p>
        <Field id="ctx-diffJournal" label="Diff журнал правок" description="Сохранять изменённые строки при edit_file/write_file">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Toggle value={s.diffJournalEnabled} onChange={v => upd({ diffJournalEnabled: v })} />
            <ResetButton current={s.diffJournalEnabled} defaultValue={DEFAULT_CONTEXT_SETTINGS.diffJournalEnabled} onReset={() => upd({ diffJournalEnabled: DEFAULT_CONTEXT_SETTINGS.diffJournalEnabled })} />
          </div>
        </Field>
        <Field id="ctx-fileMap" label="File Map" description="Карта файлов с содержимым — AI знает что уже читал">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Toggle value={s.fileMapEnabled} onChange={v => upd({ fileMapEnabled: v })} />
            <ResetButton current={s.fileMapEnabled} defaultValue={DEFAULT_CONTEXT_SETTINGS.fileMapEnabled} onReset={() => upd({ fileMapEnabled: DEFAULT_CONTEXT_SETTINGS.fileMapEnabled })} />
          </div>
        </Field>
        <Field id="ctx-readFileCache" label="Кэш файлов внутри запроса" description="Не читать один файл повторно в рамках одного запроса. Кэш переживает несколько сообщений чата и инвалидируется при изменении файла на диске.">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Toggle
              value={agentS.readFileCache as boolean ?? true}
              onChange={v => setAgentSetting('readFileCache', v)}
            />
            <ResetButton current={agentS.readFileCache} defaultValue={true} onReset={() => setAgentSetting('readFileCache', true)} />
          </div>
        </Field>
      </Group>

    </div>
  )
}
