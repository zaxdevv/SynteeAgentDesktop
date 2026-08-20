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
// вызываем dispose() ДО того, как React начнёт разбирать компонент.
export default function SafeDiffEditor(props: React.ComponentProps<typeof DiffEditor>) {
  const editorRef = useRef<Parameters<NonNullable<React.ComponentProps<typeof DiffEditor>['onMount']>>[0] | null>(null)

  useEffect(() => {
    return () => {
      if (editorRef.current) {
        try { editorRef.current.dispose() } catch { /* already disposed */ }
        editorRef.current = null
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
