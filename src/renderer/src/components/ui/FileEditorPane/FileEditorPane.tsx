import { useEffect, useRef, useCallback } from 'react'
import Editor, { type OnMount, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import FileIcon from '../FileIcon/FileIcon'
import SafeDiffEditor from '../SafeDiffEditor/SafeDiffEditor'
import { getLanguage } from '../CodePreview/CodePreview'
import { useFileTabsStore, type FileTab } from '../../../store/fileTabs.store'
import { useSettingsStore } from '../../../store/settings.store'
import { useToast } from '../Toast/Toast'
import './FileEditorPane.css'

// ── Reveal на строку (клик по src/foo.ts:42 в сообщении) ────────────────
// Скроллит к строке, ставит туда каретку и подсвечивает диапазон (:42-58).
// Один декорейшен-коллекшен на таб — старая подсветка снимается автоматически.
let revealDecorations: { editor: unknown; decorations: { dispose(): void } } | null = null

function applyReveal(
  editor: import('monaco-editor').editor.IStandaloneCodeEditor,
  line: number,
  lineEnd?: number,
): void {
  const end = lineEnd && lineEnd > line ? lineEnd : line
  try {
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: 1 })
    editor.focus()
  } catch { /* редактор ещё монтируется */ }
  try {
    revealDecorations?.decorations.dispose()
    revealDecorations = {
      editor,
      decorations: editor.createDecorationsCollection([
        {
          range: new monaco.Range(line, 1, end, 1),
          options: {
            isWholeLine: true,
            className: 'reveal-line-highlight',
            overviewRuler: {
              color: '#7c9eff',
              position: monaco.editor.OverviewRulerLane.Center,
            },
          },
        },
      ]),
    }
  } catch { /* декорации не критичны */ }
}

// ── Офлайн Monaco: @monaco-editor/react по умолчанию грузит Monaco с CDN
// (jsdelivr). В Electron (офлайн) это не работает. Конфигурируем loader
// использовать локальный bundled monaco-editor (через vite-plugin-monaco-editor).
// Вызывается один раз при первом импорте модуля.
loader.config({ monaco })

// ── FileEditorPane — зона просмотра/редактирования файла в основной области ─
// Использует Monaco Editor (как в VSCode). Поддерживает:
// - Просмотр с подсветкой синтаксиса
// - Редактирование (dirty indicator — точка на табе)
// - Ctrl+S — сохранение (через fs:writeFile IPC)
// - Автосохранение (опционально, через settings)
// - Live-обновление при изменении файла агентом (если нет локальных правок)
// - Баннер конфликта (агент изменил файл при наличии несохранённых правок)

interface FileEditorPaneProps {
  tab: FileTab
  treeOpen?: boolean
  onToggleTree?: () => void
}

export default function FileEditorPane({ tab, treeOpen, onToggleTree }: FileEditorPaneProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const saveFile = useFileTabsStore(s => s.saveFile)
  const refreshTab = useFileTabsStore(s => s.refreshTab)
  const updateContent = useFileTabsStore(s => s.updateContent)
  const closeFileTab = useFileTabsStore(s => s.closeFileTab)
  const toggleDiffMode = useFileTabsStore(s => s.toggleDiffMode)
  const addToast = useToast(s => s.add)

  // Автосохранение: проверяем настройку
  const autosaveEnabled = useSettingsStore(s => s.get<boolean>('autosaveFiles', false))

  // Ctrl+S — сохранение (глобальный хендлер, перехватываем браузерный save dialog)
  const handleSave = useCallback(async () => {
    if (!tab.dirty) return
    const ok = await saveFile(tab.id)
    if (ok) {
      addToast('Сохранено', 'success')
    } else {
      addToast('Ошибка сохранения', 'error')
    }
  }, [tab.id, tab.dirty, saveFile, addToast])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        e.stopPropagation()
        handleSave()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleSave])

  // Автосохранение (debounce 1.5 сек после последнего ввода)
  useEffect(() => {
    if (!autosaveEnabled || !tab.dirty || tab.loading || tab.conflict) return
    const timer = setTimeout(() => {
      saveFile(tab.id)
    }, 1500)
    return () => clearTimeout(timer)
  }, [tab.content, tab.dirty, tab.loading, tab.conflict, autosaveEnabled, saveFile, tab.id])

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor

    // Ctrl+S внутри Monaco (дополнительный хендлер — Monaco перехватывает Ctrl+S)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleSave()
    })
  }

  // Reveal на строку: после загрузки контента (или сразу, если уже загружен)
  // и при повторном клике по пути с :строкой в уже открытом табе.
  const consumeReveal = useFileTabsStore(s => s.consumeReveal)
  useEffect(() => {
    if (tab.loading || tab.error || tab.isBinary || !tab.revealLine) return
    const editor = editorRef.current
    if (!editor) return
    applyReveal(editor, tab.revealLine, tab.revealLineEnd)
    consumeReveal(tab.id)
  }, [tab.id, tab.loading, tab.error, tab.isBinary, tab.revealLine, tab.revealLineEnd, consumeReveal])

  const handleEditorChange = (value: string | undefined) => {
    if (value === undefined) return
    // Не обновляем если контент пришёл из загрузки (loading state)
    if (tab.loading) return
    updateContent(tab.id, value)
  }

  const handleRefresh = () => {
    refreshTab(tab.id)
  }

  const handleClose = () => {
    closeFileTab(tab.id)
  }

  const lang = getLanguage(tab.relPath)

  return (
    <div className="file-editor-pane">
      {/* Шапка с путём и кнопками */}
      <div className="file-editor-pane__header">
        <div className="file-editor-pane__path-info">
          <FileIcon name={tab.name} size={16} />
          <span className="file-editor-pane__path" title={tab.relPath}>{tab.relPath}</span>
          {tab.dirty && <span className="file-editor-pane__dirty-dot" title="Несохранённые изменения" />}
          {tab.size > 0 && (
            <span className="file-editor-pane__size">{(tab.size / 1024).toFixed(1)} KB</span>
          )}
        </div>
        <div className="file-editor-pane__actions">
          {onToggleTree && (
            <button
              className={`file-editor-pane__btn ${treeOpen ? 'file-editor-pane__btn--active' : ''}`}
              onClick={onToggleTree}
              title={treeOpen ? 'Скрыть дерево' : 'Показать дерево файлов'}
            >
              <AppIcon name="folder" size="xs" />
            </button>
          )}
          <button
            className={`file-editor-pane__btn ${tab.diffMode ? 'file-editor-pane__btn--active' : ''}`}
            onClick={() => toggleDiffMode(tab.id)}
            disabled={tab.loading || tab.isBinary}
            title={tab.diffMode ? 'Показать файл' : 'Открыть изменения (diff)'}
          >
            <AppIcon name="git" size="xs" />
          </button>
          <button
            className="file-editor-pane__btn"
            onClick={handleSave}
            disabled={!tab.dirty || tab.loading}
            title="Сохранить (Ctrl+S)"
          >
            <AppIcon name="save" size="xs" />
          </button>
          <button
            className="file-editor-pane__btn"
            onClick={handleRefresh}
            disabled={tab.loading}
            title="Обновить с диска"
          >
            <AppIcon name="refreshCw" size="xs" />
          </button>
          <button
            className="file-editor-pane__btn file-editor-pane__btn--close"
            onClick={handleClose}
            title="Закрыть файл"
          >
            <AppIcon name="x" size="xs" />
          </button>
        </div>
      </div>

      {/* Баннер конфликта */}
      <AnimatePresence>
        {tab.conflict && (
          <motion.div
            className="file-editor-pane__conflict"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <AppIcon name="alertTriangle" size="xs" tone="warning" />
            <span>Файл изменён внешне. Перезагрузить?</span>
            <button onClick={handleRefresh} className="file-editor-pane__conflict-btn">
              Перезагрузить
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Тело редактора */}
      <div className="file-editor-pane__body">
        {tab.loading ? (
          <div className="file-editor-pane__loading">
            <AppIcon name="loader" size="md" animation="spin" />
            <span>Загрузка…</span>
          </div>
        ) : tab.error ? (
          <div className="file-editor-pane__error">
            <AppIcon name="x" size="lg" tone="danger" />
            <p>{tab.error}</p>
          </div>
        ) : tab.isBinary ? (
          <div className="file-editor-pane__binary">
            <AppIcon name="fileText" size="lg" tone="muted" />
            <p>Бинарный файл — редактирование недоступно</p>
            {tab.path && (
              <button
                className="file-editor-pane__btn file-editor-pane__btn--external"
                onClick={() => window.syntee.shell.openPath(tab.path)}
              >
                Открыть в системе
              </button>
            )}
          </div>
        ) : tab.diffMode ? (
          <SafeDiffEditor
            key={tab.id}
            original={tab.diffOriginal}
            modified={tab.content}
            language={lang}
            theme="vs-dark"
            loading={<div className="file-editor-pane__loading"><AppIcon name="loader" size="md" animation="spin" /></div>}
            options={{
              readOnly: true,
              fontSize: 13,
              minimap: { enabled: false },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              tabSize: 2,
              lineNumbers: 'on',
              renderSideBySide: true,
              padding: { top: 8, bottom: 8 },
              scrollbar: {
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10,
              },
            }}
          />
        ) : tab.truncated ? (
          <div className="file-editor-pane__truncated">
            <div className="file-editor-pane__truncated-banner">
              <AppIcon name="alertTriangle" size="xs" tone="warning" />
              <span>{tab.truncatedReason ?? 'Файл обрезан — показана только часть содержимого'}</span>
            </div>
            <Editor
              value={tab.content}
              language={lang}
              onMount={handleEditorMount}
              onChange={handleEditorChange}
              theme="vs-dark"
              loading={<div className="file-editor-pane__loading"><AppIcon name="loader" size="md" animation="spin" /></div>}
              options={{
                fontSize: 13,
                minimap: { enabled: false },
                automaticLayout: true,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                tabSize: 2,
                readOnly: true,
                lineNumbers: 'on',
                renderWhitespace: 'selection',
                smoothScrolling: true,
              }}
            />
          </div>
        ) : (
          <Editor
            value={tab.content}
            language={lang}
            onMount={handleEditorMount}
            onChange={handleEditorChange}
            theme="vs-dark"
            loading={<div className="file-editor-pane__loading"><AppIcon name="loader" size="md" animation="spin" /></div>}
            options={{
              fontSize: 13,
              minimap: { enabled: true },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              tabSize: 2,
              lineNumbers: 'on',
              renderWhitespace: 'selection',
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              bracketPairColorization: { enabled: true },
              guides: { bracketPairs: true, indentation: true },
              padding: { top: 8, bottom: 8 },
              scrollbar: {
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10,
              },
            }}
          />
        )}
      </div>
    </div>
  )
}
