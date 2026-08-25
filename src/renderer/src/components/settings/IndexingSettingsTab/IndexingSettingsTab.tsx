import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useSettingsStore } from '../../../store/settings.store'
import { useChatStore } from '../../../store/chat.store'
import { DEFAULT_INDEXING_SETTINGS, DEFAULT_IGNORE_DIRS_LIST, type IndexingSettings } from '../../../../../core/context/fastContextSettings'
import Toggle from '../../ui/Toggle/Toggle'
import ResetButton from '../../ui/ResetButton/ResetButton'
import { SectionTitle, Group, Field, ConfirmButton } from '../SettingsPrimitives'
import { whileHoverWide, whileTapWide, springHover } from '../../../utils/motionPresets'
import './IndexingSettingsTab.css'

interface IndexStatus {
  fileCount: number
  lastUpdated: number | null
  watcherActive: boolean
  indexingInProgress: boolean
}

export default function IndexingSettingsTab() {
  const { get, set } = useSettingsStore()
  const saved = get<Partial<IndexingSettings>>('indexingSettings', {})
  const s: IndexingSettings = { ...DEFAULT_INDEXING_SETTINGS, ...saved }
  const activeProjectId = useChatStore(st => st.activeProjectId)

  const [status, setStatus] = useState<IndexStatus | null>(null)
  const [busy, setBusy] = useState<'reindex' | 'clear' | null>(null)
  const [ignoreText, setIgnoreText] = useState(s.ignoreDirs.join('\n'))

  const upd = (patch: Partial<IndexingSettings>) => {
    set('indexingSettings', { ...s, ...patch })
  }

  // Статус индекса активного проекта + live-обновление через onUpdated
  useEffect(() => {
    if (!activeProjectId) return
    const doRefresh = () => {
      window.syntee.fastContext.getStatus(activeProjectId).then(r => {
        setStatus({
          fileCount: r.fileCount,
          lastUpdated: r.lastUpdated,
          watcherActive: r.watcherActive,
          indexingInProgress: r.indexingInProgress,
        })
      }).catch(() => {})
    }
    doRefresh()
    const unsub = window.syntee.fastContext.onUpdated((pid: string) => {
      if (pid === activeProjectId) doRefresh()
    })
    return unsub
  }, [activeProjectId])

  const refreshStatus = () => {
    if (!activeProjectId) return
    window.syntee.fastContext.getStatus(activeProjectId).then(r => {
      setStatus({
        fileCount: r.fileCount,
        lastUpdated: r.lastUpdated,
        watcherActive: r.watcherActive,
        indexingInProgress: r.indexingInProgress,
      })
    }).catch(() => {})
  }

  const handleReindex = async () => {
    if (!activeProjectId || busy) return
    setBusy('reindex')
    try {
      await window.syntee.fastContext.reindex(activeProjectId)
      refreshStatus()
    } catch { /* ignore */ } finally {
      setBusy(null)
    }
  }

  const handleClear = async () => {
    if (!activeProjectId || busy) return
    setBusy('clear')
    try {
      await window.syntee.fastContext.clearIndex(activeProjectId)
      refreshStatus()
    } catch { /* ignore */ } finally {
      setBusy(null)
    }
  }

  const applyIgnoreDirs = () => {
    const dirs = ignoreText
      .split('\n')
      .map(d => d.trim())
      .filter(d => d.length > 0)
    upd({ ignoreDirs: dirs })
  }

  const resetIgnoreDirs = () => {
    setIgnoreText(DEFAULT_IGNORE_DIRS_LIST.join('\n'))
    upd({ ignoreDirs: DEFAULT_IGNORE_DIRS_LIST })
  }

  const lastUpdatedStr = status?.lastUpdated
    ? new Date(status.lastUpdated).toLocaleString()
    : '—'

  return (
    <div className="idx-tab">

      <SectionTitle description="Tree-sitter индекс символов проекта для быстрого поиска релевантных файлов">
        Индексация
      </SectionTitle>

      {/* ── Мастер-переключатель ── */}
      <Group
        id="idx-master"
        icon="cpu"
        title="Индексация проекта"
        right={
          <>
            <Toggle value={s.enabled} onChange={v => upd({ enabled: v })} />
            <ResetButton current={s.enabled} defaultValue={DEFAULT_INDEXING_SETTINGS.enabled} onReset={() => upd({ enabled: DEFAULT_INDEXING_SETTINGS.enabled })} />
          </>
        }
      >
        <p className="settings-card-intro">
          Tree-sitter индекс символов проекта для быстрого поиска релевантных файлов (get_fast_context).
          При отключении watcher не запускается и индекс не обновляется автоматически.
        </p>
        {activeProjectId && status && (
          <div className="idx-status-row" data-field-id="idx-status">
            <span className="idx-status-item">
              <span className="idx-status-label">Файлов в индексе</span>
              <span className="idx-status-val">{status.fileCount.toLocaleString()}</span>
            </span>
            <span className="idx-status-item">
              <span className="idx-status-label">Последнее обновление</span>
              <span className="idx-status-val">{lastUpdatedStr}</span>
            </span>
            <span className="idx-status-item">
              <span className="idx-status-label">Watcher</span>
              <span className={`idx-status-val ${status.watcherActive ? 'idx-status-ok' : 'idx-status-off'}`}>
                {status.watcherActive ? 'активен' : 'остановлен'}
              </span>
            </span>
          </div>
        )}
        {!activeProjectId && (
          <span className="ctx-hint">Откройте проект, чтобы увидеть статус индекса и запустить реиндекс.</span>
        )}
      </Group>

      {/* ── Neural embeddings ── */}
      <Group
        id="idx-neural"
        icon="brain"
        title="Neural embeddings"
        note="MiniLM"
        right={
          <>
            <Toggle value={s.neuralEmbeddings} onChange={v => upd({ neuralEmbeddings: v })} />
            <ResetButton current={s.neuralEmbeddings} defaultValue={DEFAULT_INDEXING_SETTINGS.neuralEmbeddings} onReset={() => upd({ neuralEmbeddings: DEFAULT_INDEXING_SETTINGS.neuralEmbeddings })} />
          </>
        }
      >
        <p className="settings-card-intro">
          Семантический поиск через ONNX/MiniLM (~22MB скачивание при первом включении).
          Даёт более точный поиск по смыслу, но потребляет больше CPU.
          По умолчанию выключено — используется быстрый TF-IDF.
        </p>
        {s.neuralEmbeddings && (
          <span className="ctx-hint">
            ⚠ Включение загрузит ONNX runtime и модель MiniLM при следующем get_fast_context.
            После изменения требуется реиндекс (кнопка ниже), чтобы пересчитать embeddings.
          </span>
        )}
      </Group>

      {/* ── Лимиты ── */}
      <Group id="idx-limits" icon="shield" title="Лимиты индексации">
        <p className="settings-card-intro">
          Контролируют объём индексируемых файлов. Меньше лимиты — быстрее индексация, но могут пропасть большие файлы.
        </p>
        <div className="ctx-fields">
          <div className="ctx-field" data-field-id="idx-maxFiles">
            <label>Макс. файлов в проекте</label>
            <div className="ctx-slider-row">
              <input type="range" min={1000} max={20000} step={500}
                value={s.maxFilesPerProject}
                onChange={e => upd({ maxFilesPerProject: +e.target.value })}
              />
              <span className="ctx-slider-val">{s.maxFilesPerProject.toLocaleString()}</span>
              <ResetButton current={s.maxFilesPerProject} defaultValue={DEFAULT_INDEXING_SETTINGS.maxFilesPerProject} onReset={() => upd({ maxFilesPerProject: DEFAULT_INDEXING_SETTINGS.maxFilesPerProject })} />
            </div>
            <span className="ctx-hint">Safety limit. Большие монорепо могут иметь &gt;5000 файлов. По умолчанию: 5000</span>
          </div>
          <div className="ctx-field" data-field-id="idx-maxFileSize">
            <label>Макс. размер файла (KB)</label>
            <div className="ctx-slider-row">
              <input type="range" min={100} max={5000} step={100}
                value={s.maxFileSizeKb}
                onChange={e => upd({ maxFileSizeKb: +e.target.value })}
              />
              <span className="ctx-slider-val">{s.maxFileSizeKb} KB</span>
              <ResetButton current={s.maxFileSizeKb} defaultValue={DEFAULT_INDEXING_SETTINGS.maxFileSizeKb} onReset={() => upd({ maxFileSizeKb: DEFAULT_INDEXING_SETTINGS.maxFileSizeKb })} />
            </div>
            <span className="ctx-hint">Файлы крупнее не индексируются (экономия CPU). По умолчанию: 1500 KB</span>
          </div>
        </div>
      </Group>

      {/* ── Watcher ── */}
      <Group id="idx-watcher" icon="eye" title="File Watcher">
        <p className="settings-card-intro">
          Фоновый мониторинг изменений файлов (chokidar). Debounce — как быстро реагировать на изменения.
        </p>
        <Field id="idx-watch" label="Фоновый watcher" description="Chokidar в main-процессе для мгновенного обновления индекса при сохранении файлов. OFF по умолчанию — на больших проектах (10к+ файлов) вешает UI.">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Toggle value={s.backgroundWatch} onChange={v => upd({ backgroundWatch: v })} />
            <ResetButton current={s.backgroundWatch} defaultValue={DEFAULT_INDEXING_SETTINGS.backgroundWatch} onReset={() => upd({ backgroundWatch: DEFAULT_INDEXING_SETTINGS.backgroundWatch })} />
          </div>
        </Field>
        <div className="ctx-fields">
          <div className="ctx-field" data-field-id="idx-debounce">
            <label>Debounce (ms)</label>
            <div className="ctx-slider-row">
              <input type="range" min={300} max={3000} step={100}
                value={s.watcherDebounceMs}
                onChange={e => upd({ watcherDebounceMs: +e.target.value })}
              />
              <span className="ctx-slider-val">{s.watcherDebounceMs} ms</span>
              <ResetButton current={s.watcherDebounceMs} defaultValue={DEFAULT_INDEXING_SETTINGS.watcherDebounceMs} onReset={() => upd({ watcherDebounceMs: DEFAULT_INDEXING_SETTINGS.watcherDebounceMs })} />
            </div>
            <span className="ctx-hint">Меньше = быстрее, но больше CPU на частых сохранениях. По умолчанию: 1000 ms</span>
          </div>
        </div>
        <Field id="idx-prewarm" label="Pre-warm при старте" description="Индексировать пустой индекс при открытии проекта. Иначе — лениво при первом get_fast_context.">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Toggle value={s.prewarmOnStart} onChange={v => upd({ prewarmOnStart: v })} />
            <ResetButton current={s.prewarmOnStart} defaultValue={DEFAULT_INDEXING_SETTINGS.prewarmOnStart} onReset={() => upd({ prewarmOnStart: DEFAULT_INDEXING_SETTINGS.prewarmOnStart })} />
          </div>
        </Field>
        <div className="ctx-fields">
          <div className="ctx-field" data-field-id="idx-prewarmDelay">
            <label>Задержка pre-warm (ms)</label>
            <div className="ctx-slider-row">
              <input type="range" min={0} max={120000} step={5000}
                value={s.prewarmDelayMs}
                onChange={e => upd({ prewarmDelayMs: +e.target.value })}
              />
              <span className="ctx-slider-val">{s.prewarmDelayMs} ms</span>
              <ResetButton current={s.prewarmDelayMs} defaultValue={DEFAULT_INDEXING_SETTINGS.prewarmDelayMs} onReset={() => upd({ prewarmDelayMs: DEFAULT_INDEXING_SETTINGS.prewarmDelayMs })} />
            </div>
            <span className="ctx-hint">Отложенный старт первичной индексации — даёт UI загрузиться без конкуренции за CPU. 0 = сразу. По умолчанию: 30000 ms</span>
          </div>
        </div>
      </Group>

      {/* ── Игнорируемые директории ── */}
      <Group id="idx-ignore" icon="filter" title="Игнорируемые директории">
        <p className="settings-card-intro">
          Директории (basename match), которые пропускаются при индексации.
          По одной в строке. Применяется при следующем реиндексе.
        </p>
        <div className="ctx-field" data-field-id="idx-ignoreDirs">
          <textarea
            className="idx-textarea"
            value={ignoreText}
            onChange={e => setIgnoreText(e.target.value)}
            onBlur={applyIgnoreDirs}
            rows={8}
            spellCheck={false}
          />
          <div className="idx-ignore-actions">
            <motion.button className="idx-btn idx-btn--ghost" onClick={resetIgnoreDirs} whileHover={whileHoverWide} whileTap={whileTapWide} transition={springHover}>Сбросить к дефолту</motion.button>
            <span className="ctx-hint">{ignoreText.split('\n').filter(d => d.trim()).length} директорий</span>
          </div>
        </div>
      </Group>

      {/* ── Действия ── */}
      {activeProjectId && (
        <Group id="idx-actions" icon="settings" title="Действия с индексом" note="danger zone">
          <p className="settings-card-intro">
            Применить новые настройки (лимиты, ignore-директории, neural embeddings) — реиндексируйте активный проект.
          </p>
          <div className="idx-actions" data-field-id="idx-actions">
            <motion.button
              className="idx-btn idx-btn--primary"
              onClick={handleReindex}
              disabled={busy !== null || status?.indexingInProgress}
              whileHover={whileHoverWide}
              whileTap={whileTapWide}
              transition={springHover}
            >
              {busy === 'reindex' || status?.indexingInProgress ? 'Индексация…' : 'Реиндексировать сейчас'}
            </motion.button>
            <ConfirmButton
              label="Очистить индекс"
              onConfirm={handleClear}
              className="idx-btn idx-btn--danger"
              disabled={busy !== null}
            />
          </div>
          <span className="ctx-hint">
            Изменение настроек (maxFileSize, ignoreDirs, neuralEmbeddings) не обновляет существующий индекс автоматически —
            нажмите «Реиндексировать».
          </span>
        </Group>
      )}

    </div>
  )
}
