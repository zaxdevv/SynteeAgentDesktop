import { useEffect, useRef } from 'react'
import { DiffEditor, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'

// Офлайн Monaco (повторный вызов loader.config безопасен)
loader.config({ monaco })

// ── SafeDiffEditor — обёртка над Monaco DiffEditor ───────────────────────
// @monaco-editor/react DiffEditor имеет race condition: при unmount React
// диспозит TextModels раньше, чем DiffEditorWidget успевает их сбросить
// → "TextModel got disposed before DiffEditorWidget model got reset".
// Фикс: через onMount перехватываем editor, в cleanup effect вручную
// снимаем модели и диспозит виджет ДО того, как React начнёт разбирать
// компонент. Тяжёлый teardown (dispose виджета: две view, декорации, DOM)
// отложен на requestAnimationFrame — закрытие git-вкладки/диффа больше
// не блокирует кадр синхронно; setModel(null) синхронно сохраняет фикс
// race (виджет больше не ссылается на модели).
export default function SafeDiffEditor(props: React.ComponentProps<typeof DiffEditor>) {
  const editorRef = useRef<Parameters<NonNullable<React.ComponentProps<typeof DiffEditor>['onMount']>>[0] | null>(null)

  useEffect(() => {
    return () => {
      const ed = editorRef.current
      editorRef.current = null
      if (ed) {
        try { ed.setModel(null) } catch { /* already disposed */ }
        requestAnimationFrame(() => {
          try { ed.dispose() } catch { /* already disposed */ }
        })
      }
    }
  }, [])

  return (
    <DiffEditor
      {...props}
      onMount={(editor, monaco) => {
        editorRef.current = editor
        props.onMount?.(editor, monaco)
      }}
    />
  )
}
