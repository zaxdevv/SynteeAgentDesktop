import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useSettingsStore } from '../../../store/settings.store'
import { useChatStore } from '../../../store/chat.store'
import { DEFAULT_INDEXING_SETTINGS, DEFAULT_IGNORE_DIRS_LIST, type IndexingSettings } from '../../../../../core/context/fastContextSettings'
import Toggle from '../../ui/Toggle/Toggle'
import ResetButton from '../../ui/ResetButton/ResetButton'
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

      {/* ── Мастер-переключатель ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>Индексация проекта</h3>
            <p className="ctx-section__desc">
              Tree-sitter индекс символов проекта для быстрого поиска релевантных файлов (get_fast_context).
              При отключении watcher не запускается и индекс не обновляется автоматически.
            </p>
          </div>
          <div className="ctx-section__head-actions">
            <Toggle value={s.enabled} onChange={v => upd({ enabled: v })} />
            <ResetButton current={s.enabled} defaultValue={DEFAULT_INDEXING_SETTINGS.enabled} onReset={() => upd({ enabled: DEFAULT_INDEXING_SETTINGS.enabled })} />
          </div>
        </div>
        {activeProjectId && status && (
          <div className="idx-status-row">
            <span className="idx-status-item">
              <span className="idx-status-label">Файлов в индексе:</span>
              <span className="idx-status-val">{status.fileCount.toLocaleString()}</span>
            </span>
            <span className="idx-status-item">
              <span className="idx-status-label">Последнее обновление:</span>
              <span className="idx-status-val">{lastUpdatedStr}</span>
            </span>
            <span className="idx-status-item">
              <span className="idx-status-label">Watcher:</span>
              <span className={`idx-status-val ${status.watcherActive ? 'idx-status-ok' : 'idx-status-off'}`}>
                {status.watcherActive ? 'активен' : 'остановлен'}
              </span>
            </span>
          </div>
        )}
        {!activeProjectId && (
          <span className="ctx-hint">Откройте проект, чтобы увидеть статус индекса и запустить реиндекс.</span>
        )}
      </section>

      {/* ── Neural embeddings ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>Neural embeddings (MiniLM)</h3>
            <p className="ctx-section__desc">
              Семантический поиск через ONNX/MiniLM (~22MB скачивание при первом включении).
              Даёт более точный поиск по смыслу, но потребляет больше CPU.
              По умолчанию выключено — используется быстрый TF-IDF.
            </p>
          </div>
          <div className="ctx-section__head-actions">
            <Toggle value={s.neuralEmbeddings} onChange={v => upd({ neuralEmbeddings: v })} />
            <ResetButton current={s.neuralEmbeddings} defaultValue={DEFAULT_INDEXING_SETTINGS.neuralEmbeddings} onReset={() => upd({ neuralEmbeddings: DEFAULT_INDEXING_SETTINGS.neuralEmbeddings })} />
          </div>
        </div>
        {s.neuralEmbeddings && (
          <span className="ctx-hint">
            ⚠ Включение загрузит ONNX runtime и модель MiniLM при следующем get_fast_context.
            После изменения требуется реиндекс (кнопка ниже), чтобы пересчитать embeddings.
          </span>
        )}
      </section>

      {/* ── Лимиты ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>Лимиты индексации</h3>
            <p className="ctx-section__desc">
              Контролируют объём индексируемых файлов. Меньше лимиты — быстрее индексация, но могут пропасть большие файлы.
            </p>
          </div>
        </div>
        <div className="ctx-fields">
          <div className="ctx-field">
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
          <div className="ctx-field">
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
      </section>

      {/* ── Watcher ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>File Watcher</h3>
            <p className="ctx-section__desc">
              Фоновый мониторинг изменений файлов (chokidar). Debounce — как быстро реагировать на изменения.
            </p>
          </div>
        </div>
        <div className="ctx-fields">
          <div className="ctx-section__head" style={{ marginTop: 0 }}>
            <div>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Фоновый watcher (live-детект изменений)</label>
              <p className="ctx-section__desc">
                Chokidar в main-процессе для мгновенного обновления индекса при сохранении файлов.
                OFF по умолчанию — на больших проектах (10к+ файлов) вешает UI. Без него индекс
                наполняется pre-warm и по требованию get_fast_context (в worker thread, не блокирует UI).
              </p>
            </div>
            <div className="ctx-section__head-actions">
              <Toggle value={s.backgroundWatch} onChange={v => upd({ backgroundWatch: v })} />
              <ResetButton current={s.backgroundWatch} defaultValue={DEFAULT_INDEXING_SETTINGS.backgroundWatch} onReset={() => upd({ backgroundWatch: DEFAULT_INDEXING_SETTINGS.backgroundWatch })} />
            </div>
          </div>
          <div className="ctx-field">
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
          <div className="ctx-section__head" style={{ marginTop: 4 }}>
            <div>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Pre-warm при старте</label>
              <p className="ctx-section__desc">Индексировать пустой индекс при открытии проекта. Иначе — лениво при первом get_fast_context.</p>
            </div>
            <div className="ctx-section__head-actions">
              <Toggle value={s.prewarmOnStart} onChange={v => upd({ prewarmOnStart: v })} />
              <ResetButton current={s.prewarmOnStart} defaultValue={DEFAULT_INDEXING_SETTINGS.prewarmOnStart} onReset={() => upd({ prewarmOnStart: DEFAULT_INDEXING_SETTINGS.prewarmOnStart })} />
            </div>
          </div>
          <div className="ctx-field">
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
      </section>

      {/* ── Игнорируемые директории ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>Игнорируемые директории</h3>
            <p className="ctx-section__desc">
              Директории (basename match), которые пропускаются при индексации.
              По одной в строке. Применяется при следующем реиндексе.
            </p>
          </div>
        </div>
        <div className="ctx-field">
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
      </section>

      {/* ── Действия ── */}
      {activeProjectId && (
        <section className="ctx-section">
          <div className="ctx-section__head">
            <div>
              <h3>Действия с индексом</h3>
              <p className="ctx-section__desc">
                Применить новые настройки (лимиты, ignore-директории, neural embeddings) — реиндексируйте активный проект.
              </p>
            </div>
          </div>
          <div className="idx-actions">
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
            <motion.button
              className="idx-btn idx-btn--danger"
              onClick={handleClear}
              disabled={busy !== null}
              whileHover={whileHoverWide}
              whileTap={whileTapWide}
              transition={springHover}
            >
              {busy === 'clear' ? 'Очистка…' : 'Очистить индекс'}
            </motion.button>
          </div>
          <span className="ctx-hint">
            Изменение настроек (maxFileSize, ignoreDirs, neuralEmbeddings) не обновляет существующий индекс автоматически —
            нажмите «Реиндексировать».
          </span>
        </section>
      )}

    </div>
  )
}
