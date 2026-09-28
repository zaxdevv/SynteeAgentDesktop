import * as React from 'react'
import { useState, useMemo, memo, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { copyToClipboard } from '@renderer/utils/clipboard'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { PluginUiWidgetPayload } from '@shared/types/plugin'
import { formatTokens, formatTokensFull, formatDuration } from '@shared/format'
import { normalizeMathDelimiters, containsMathMarkers } from '@shared/mathNormalize'
import PluginIframe from '../PluginSlot/PluginIframe'
import { collectMarkdownRenderers, collectMessageContextMenu, collectMessageTags, getPluginsExt } from '../../../utils/pluginExtApi'
import { useExtensionsStore } from '../../../store/extensions.store'
import { usePluginPanelStore } from '../../../store/pluginPanel.store'
// ── Быстрый рендер код-блоков через HTML-строку ──────────────────────────
// Заменяет react-syntax-highlighter (React-дерево из тысяч <span>) на
// refractor → HAST → HTML-строка → dangerouslySetInnerHTML.
// Браузер парсит HTML на C++ уровне — в 5-10× быстрее создания React-элементов.
// Стили oneDark применяются как inline-стили — визуально пиксель-в-пиксель.
// Языки регистрируются через refractor (тот же инстанс, что использовался
// внутри react-syntax-highlighter PrismLight).
import refractor from 'refractor/core'
import { highlightCodeToHtml } from '../../../utils/codeHighlightHTML'

// Регистрируем только нужные языки (~23 вместо ~270 в полном Prism).
import tsx from 'refractor/lang/tsx'
import typescript from 'refractor/lang/typescript'
import javascript from 'refractor/lang/javascript'
import jsx from 'refractor/lang/jsx'
import python from 'refractor/lang/python'
import json from 'refractor/lang/json'
import bash from 'refractor/lang/bash'
import shell from 'refractor/lang/shell-session'
import sql from 'refractor/lang/sql'
import go from 'refractor/lang/go'
import rust from 'refractor/lang/rust'
import yaml from 'refractor/lang/yaml'
import markdownLang from 'refractor/lang/markdown'
import cssLang from 'refractor/lang/css'
import markup from 'refractor/lang/markup'
import java from 'refractor/lang/java'
import cLang from 'refractor/lang/c'
import cpp from 'refractor/lang/cpp'
import csharp from 'refractor/lang/csharp'
import php from 'refractor/lang/php'
import ruby from 'refractor/lang/ruby'
import diffLang from 'refractor/lang/diff'

refractor.register(tsx)
refractor.register(typescript)
refractor.register(javascript)
refractor.register(jsx)
refractor.register(python)
refractor.register(json)
refractor.register(bash)
refractor.register(shell)
refractor.register(sql)
refractor.register(go)
refractor.register(rust)
refractor.register(yaml)
refractor.register(markdownLang)
refractor.register(cssLang)
refractor.register(markup)
refractor.register(java)
refractor.register(cLang)
refractor.register(cpp)
refractor.register(csharp)
refractor.register(php)
refractor.register(ruby)
refractor.register(diffLang)

// Алиасы языков (как в react-syntax-highlighter registerLanguage)
refractor.alias('typescript', ['ts'])
refractor.alias('javascript', ['js'])
refractor.alias('python', ['py'])
refractor.alias('bash', ['sh'])
refractor.alias('shell-session', ['shell', 'console'])
refractor.alias('rust', ['rs'])
refractor.alias('yaml', ['yml'])
refractor.alias('markdown', ['md'])
refractor.alias('markup', ['html', 'xml'])
refractor.alias('cpp', ['c++'])
refractor.alias('csharp', ['cs'])
refractor.alias('ruby', ['rb'])
import PlanCard from '../PlanCard/PlanCard'
import Logo from '../Logo/Logo'
import AttachmentPreviewModal from '../AttachmentPreviewModal/AttachmentPreviewModal'
import type { Message, ToolOutputMode, Attachment } from '../../../../../shared/types'
import { extractPlanSegments } from '../../../../../shared/planParser'
import AppIcon from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
import ToolChain from '../ToolChain/ToolChain'
import TodoChecklist from '../TodoChecklist/TodoChecklist'
import FastContextBlock, { type FastContextResultData } from '../FastContextBlock/FastContextBlock'
import AgentCard, { type AgentCardData } from '../AgentCard/AgentCard'
import MermaidBlock from './MermaidBlock'
import ChartBlock from './ChartBlock'
import ThinkingBlock from '../ThinkingBlock/ThinkingBlock'
import { useUIStore, type AvatarStyle } from '../../../store/ui.store'
import { useChatStore } from '../../../store/chat.store'
import { tabActions } from '../../../store/tabs.store'
import { remarkFilePaths, PATH_RE, isValidPathMatch } from '../../../utils/remarkFilePaths'
import { openFilePath } from '../../../utils/openFilePath'
import FilePathLink from '../FilePathLink/FilePathLink'
import {
  attachmentsToMarkdown,
  splitByAttachTokens,
  hasAttachTokens,
  replaceAttachTokensWithLinks,
  stripAttachTokens,
} from '../../../../../shared/attachmentMarkdown'
import '../InlineAttachmentRenderer/InlineAttachmentRenderer.css'
import 'katex/dist/katex.min.css'
import './MessageBubble.css'
import { SystemDivider } from './SystemDivider'

// Варианты анимации сообщений
export const MSG_ANIM_VARIANTS: Record<string, {
  initial: object; animate: object; transition: object; label: string; desc: string
}> = {
  slide: {
    label: 'Слайд', desc: 'Снизу вверх',
    initial: { opacity: 0, y: 18 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.2, ease: 'easeOut' },
  },
  fade: {
    label: 'Плавно', desc: 'Плавное появление',
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: 0.3, ease: 'easeOut' },
  },
  pop: {
    label: 'Поп', desc: 'Пружинный эффект',
    initial: { opacity: 0, scale: 0.88 },
    animate: { opacity: 1, scale: 1 },
    transition: { type: 'spring', stiffness: 420, damping: 26 },
  },
  swing: {
    label: 'Качели', desc: 'С боку',
    initial: { opacity: 0, x: -24, rotate: -3 },
    animate: { opacity: 1, x: 0, rotate: 0 },
    transition: { type: 'spring', stiffness: 380, damping: 28 },
  },
  rise: {
    label: 'Подъём', desc: 'Снизу с блюром',
    initial: { opacity: 0, y: 32 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
  },
  none: {
    label: 'Нет', desc: 'Без анимации',
    initial: {},
    animate: {},
    transition: { duration: 0 },
  },
}

interface MessageBubbleProps {
  message: Message
  onPin?: (id: string) => void
  onCopy?: (content: string) => void
  onReadAloud?: (content: string) => void
  onReply?: (message: Message) => void
  onRewind?: (userMessageId: string) => void
  toolOutputMode?: ToolOutputMode
  searchQuery?: string
  liveThinking?: { text?: string; isLive: boolean; ms?: number; storeChatId?: string }
  isStreaming?: boolean
  isWaiting?: boolean
  rateLimitSec?: number
  /** Проигрывать ли entrance-анимацию. true только при первом монтировании
   * сообщения; false при scroll-remount того же сообщения виртуализатором,
   * иначе анимация повторяется при каждом скролле → «интерфейс плывёт». */
  shouldAnimate?: boolean
  /** Рабочая директория чата — для кликабельных путей в сообщениях.
   *  Относительные пути резолвятся от workdir. undefined = пути не кликабельны. */
  workdir?: string
  /** Доступен ли редактор чата (false — инкогнито-чаты, live-пузыри). */
  editorAvailable?: boolean
}

// Memoized code highlighter — рендерит HTML-строку через dangerouslySetInnerHTML.
// refractor.highlight() вызывается один раз, результат кэшируется в codeHighlightHTML.
// При scroll-remount виртуализатора берём готовый HTML из кэша — нулевая стоимость.
// Стиль на <pre> (внешний контейнер) — как раньше был на <div> внутри SyntaxHighlighter.
const PRE_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '14px 16px',
  background: '#0d0d0f',
  borderRadius: '0 0 8px 8px',
  fontSize: '13px',
  lineHeight: '20.8px',
  display: 'flex',
  alignItems: 'flex-start',
  overflow: 'auto',
}

const CodeHighlighter = memo(function CodeHighlighter({ raw, lang }: { raw: string; lang: string }) {
  const html = useMemo(() => highlightCodeToHtml(raw, lang), [raw, lang])
  return <pre style={PRE_STYLE} dangerouslySetInnerHTML={{ __html: html }} />
}, (prev, next) => prev.raw === next.raw && prev.lang === next.lang)

// Кнопка копирования код-блока — владеет своим copied-состоянием локально.
// Раньше copiedBlock жил в MessageContent и при каждом клике пересоздавал
// mdComponents → ре-парс ВСЕХ ReactMarkdown-сегментов в сообщении. Теперь
// mdComponents стабилен (useMemo []), копирование не триггерит ре-парс.
const CopyButton = memo(function CopyButton({ raw }: { raw: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={`code-copy-btn ${copied ? 'code-copy-btn--copied' : ''}`}
      onClick={async () => {
        const ok = await copyToClipboard(raw)
        if (!ok) return
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? '✓ Скопировано' : 'Копировать'}
    </button>
  )
})

// ── Редактор чата: textarea для inline-правки текста сообщения ───────────
// Авто-рост по контенту. Значение управляется снаружи (draft в chat.store) —
// пишется в БД только при «Применить и закрыть» (applyEditorDrafts в ChatPage).
const EditorTextarea = memo(function EditorTextarea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // Авто-рост: сброс высоты → scrollHeight. На каждый change value.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 600)}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      className="message-editor-textarea"
      value={value}
      onChange={e => onChange(e.target.value)}
      spellCheck={false}
      // Не даём Escape закрывать модалки/меню пока фокус в редакторе.
      onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation() }}
    />
  )
})

// Diff рендерер
const DiffBlock = memo(function DiffBlock({ code }: { code: string }) {
  return (
    <div className="diff-block">
      {code.split('\n').map((line, i) => {
        const cls = line.startsWith('+') ? 'diff-add'
          : line.startsWith('-') ? 'diff-del'
          : line.startsWith('@@') ? 'diff-hunk'
          : 'diff-ctx'
        return <div key={i} className={`diff-line ${cls}`}><span className="diff-line-content">{line || '\u00A0'}</span></div>
      })}
    </div>
  )
})

// ── Кастомный рендерер кодоблока от плагина (registerMarkdownRenderer) ──
// ```language в сообщении, где language совпал с плагинным рендерером
// (регистронезависимо), рендерится iframe-панелью плагина — как mermaid.
// Код передаётся в iframe через widgetData при загрузке.
function PluginMarkdownBlock({ pluginId, entry, height, raw, lang }: {
  pluginId: string
  entry: string
  height: number
  raw: string
  lang: string
}) {
  return (
    <div className="plugin-md-renderer" style={{ height }}>
      <div className="plugin-md-renderer-header">
        <span className="code-lang">{lang.toUpperCase()}</span>
        <span className="plugin-md-renderer-badge" title={`Рендерер плагина ${pluginId}`}>plugin</span>
      </div>
      <PluginIframe
        pluginId={pluginId}
        entry={entry}
        widgetData={{ code: raw, language: lang }}
        className="plugin-md-renderer-frame"
      />
    </div>
  )
}

/** Поиск плагинного markdown-рендерера по language кодоблока. */
function findPluginMdRenderer(lang: string) {
  const l = lang.toLowerCase()
  return collectMarkdownRenderers().find(r => r.language.toLowerCase() === l) ?? null
}

// Admonition блок
const ADMONITION_META: Record<string, { icon: string; label: string; cls: string }> = {
  note:    { icon: '📝', label: 'Заметка',    cls: 'adm--note' },
  info:    { icon: 'ℹ️',  label: 'Инфо',       cls: 'adm--info' },
  tip:     { icon: '💡', label: 'Совет',      cls: 'adm--tip' },
  warning: { icon: '⚠️', label: 'Внимание',   cls: 'adm--warning' },
  danger:  { icon: '🚨', label: 'Опасность',  cls: 'adm--danger' },
}

const AdmonitionBlock = memo(function AdmonitionBlock({ kind, title, children }: { kind: string; title?: string; children: React.ReactNode }) {
  const meta = ADMONITION_META[kind] || ADMONITION_META.note
  return (
    <div className={`adm ${meta.cls}`}>
      <div className="adm-header">
        <span className="adm-icon">{meta.icon}</span>
        <span className="adm-title">{title || meta.label}</span>
      </div>
      <div className="adm-body">{children}</div>
    </div>
  )
})

// Парсим admonitions + <plan>-блоки — вынесено и мемоизировано снаружи
// Возвращает сегменты: md (обычный markdown), admonition (:::note…:::),
// plan (<plan title="…" summary="…" — рендерится в PlanCard).
// allowPlanCard: если false — <plan>-теги НЕ парсятся, остаются как текст.
// Это защищает от рендеринга <plan> вне режима планирования (модель может
// ошибочно написать тег, но он не должен стать PlanCard).
// Module-level кэш segments из parseContent. parseContent делает строковое
// разбиение (admonitions/plan) — не тяжёлое, но при scroll-mount большого
// сообщения каждый раз пересоздаёт массивы. Кэш переиспользуется跨 mounts
// виртуализатора. Ключ — text+allowPlanCard (строки, иммутабельные).
// Мягкий эвикшн кэшей: при переполнении удаляем старейшие записи до `keep`
// (Map упорядочен по вставке). Раньше делали .clear() — это вызывало
// одномоментный ре-парс всех видимых сообщений посреди скролла (фриз).
function evictOldest<T>(map: Map<string, T>, keep: number) {
  let toDelete = map.size - keep
  for (const key of map.keys()) {
    if (toDelete <= 0) break
    map.delete(key)
    toDelete--
  }
}

const parseContentCache = new Map<string, ReturnType<typeof parseContent>>()
function parseContentCached(raw: string, allowPlanCard = false): ReturnType<typeof parseContent> {
  const key = allowPlanCard ? '1' + raw : '0' + raw
  let segs = parseContentCache.get(key)
  if (!segs) {
    segs = parseContent(raw, allowPlanCard)
    // Ограничиваем размер кэша, чтобы не текло по памяти на длинных чатах.
    if (parseContentCache.size > 200) evictOldest(parseContentCache, 150)
    parseContentCache.set(key, segs)
  }
  return segs
}

function parseContent(raw: string, allowPlanCard = false): Array<{ type: 'md' | 'admonition' | 'plan'; content: string; kind?: string; title?: string; summary?: string; partial?: boolean }> {
  // 0. Нормализация LaTeX-разделителей математики: \(...\), \[...\] и голые
  //    \begin{env} → $ / $$ (remark-math понимает только доллары). Кэш
  //    parseContentCache ключуется по сырому тексту — нормализованный вывод
  //    консистентен. Код-блоки и инлайн-код не затрагиваются.
  raw = normalizeMathDelimiters(raw)
  // 1. Если PlanCard не разрешён — пропускаем <plan>-парсинг, весь текст как md.
  if (!allowPlanCard) {
    // Просто разбиваем на md + admonition, без plan-сегментов.
    const result: Array<{ type: 'md' | 'admonition' | 'plan'; content: string; kind?: string; title?: string; summary?: string; partial?: boolean }> = []
    const lines = raw.split('\n')
    let i = 0
    let mdBuf: string[] = []
    const ADM_RE = /^:::(note|tip|warning|danger|info)(?:\s+(.+))?$/i
    const flushMd = () => {
      if (mdBuf.length) {
        result.push({ type: 'md', content: mdBuf.join('\n') })
        mdBuf = []
      }
    }
    while (i < lines.length) {
      const m = ADM_RE.exec(lines[i].trim())
      if (m) {
        flushMd()
        const kind = m[1].toLowerCase()
        const title = m[2]
        const body: string[] = []
        i++
        while (i < lines.length && lines[i].trim() !== ':::') { body.push(lines[i]); i++ }
        result.push({ type: 'admonition', content: body.join('\n'), kind, title })
      } else {
        mdBuf.push(lines[i])
      }
      i++
    }
    flushMd()
    return result
  }

  // 2. PlanCard разрешён — парсим <plan>-теги через shared-парсер.
  // PlanCard монтируется сразу когда открылся <plan ...> (partial=true),
  // и растёт вместе со стримом. Когда </plan> пришёл — partial=false,
  // появляются кнопки действий (копировать/открыть файл). Раньше partial
  // даунгрейдился в обычный markdown, но карточка уже умеет стримиться
  // (CSS pulse-рамка, индикатор «пишу план…»), так что даунгрейд не нужен.
  const { segments: planSegs } = extractPlanSegments(raw)

  // 2. Каждый text-сегмент дополнительно разбиваем на md + admonition.
  const result: Array<{ type: 'md' | 'admonition' | 'plan'; content: string; kind?: string; title?: string; summary?: string; partial?: boolean }> = []
  for (const seg of planSegs) {
    if (seg.type === 'plan') {
      result.push({
        type: 'plan',
        content: seg.content,
        title: seg.title,
        summary: seg.summary,
        partial: seg.partial,
      })
      continue
    }
    // text → разбиваем на admonitions
    const lines = seg.content.split('\n')
    let i = 0
    let mdBuf: string[] = []
    const ADM_RE = /^:::(note|tip|warning|danger|info)(?:\s+(.+))?$/i
    const flushMd = () => {
      if (mdBuf.length) {
        result.push({ type: 'md', content: mdBuf.join('\n') })
        mdBuf = []
      }
    }
    while (i < lines.length) {
      const m = ADM_RE.exec(lines[i].trim())
      if (m) {
        flushMd()
        const kind = m[1].toLowerCase()
        const title = m[2]
        const body: string[] = []
        i++
        while (i < lines.length && lines[i].trim() !== ':::') { body.push(lines[i]); i++ }
        result.push({ type: 'admonition', content: body.join('\n'), kind, title })
      } else {
        mdBuf.push(lines[i])
      }
      i++
    }
    flushMd()
  }
  return result
}

// ── safeUrlTransform: пропускаем внутренние схемы через санитайзер ──────
// Дефолтный defaultUrlTransform react-markdown вырезает неизвестные протоколы
// (file-path://, file://) → href=''. Клик по ссылке с пустым href вёл на
// текущую страницу приложения → setWindowOpenHandler → shell.openExternal(URL
// самого приложения) → открывалась ВТОРАЯ копия приложения («перезапуск»).
// Отсюда же «кривая подсветка»: путь получал класс md-link вместо
// file-path-link. Наши схемы пропускаем как есть, остальное — штатный санитайзер.
const safeUrlTransform = (url: string): string =>
  url.startsWith('file-path://') || url.startsWith('file://')
    ? url
    : defaultUrlTransform(url)

// ── Инлайн-виджет плагина ────────────────────────────────────────────────
// Тул плагина может вернуть JSON-маркер вместо текста:
// {"__plugin_ui__":true,"pluginId":"...","entry":"ui/chart.html","data":...,"height":260}
// → рендерим iframe-карточку (PluginIframe) вместо markdown.
function tryParsePluginWidget(content: string): PluginUiWidgetPayload | null {
  const t = content.trim()
  if (!t.startsWith('{"__plugin_ui__"')) return null
  try {
    const obj = JSON.parse(t) as PluginUiWidgetPayload
    if (!obj || obj.__plugin_ui__ !== true) return null
    if (typeof obj.pluginId !== 'string') return null
    // kind='diff' — нативный diff-виджет без iframe: entry не обязателен.
    // kind='badge' — инлайн-бейдж (пилюля): нужен text, entry не нужен.
    const kind = obj.kind ?? 'iframe'
    if (kind === 'iframe' && typeof obj.entry !== 'string') return null
    if (kind === 'diff' && typeof obj.diff !== 'string') return null
    if (kind === 'badge' && typeof obj.text !== 'string') return null
    return obj
  } catch {
    return null
  }
}

/** Инлайн-бейдж плагина (kind='badge'): компактная пилюля в сообщении —
 *  статус/результат без отдельного iframe-виджета. */
function PluginBadgeWidget({ widget }: { widget: PluginUiWidgetPayload }) {
  return (
    <span
      className="plugin-inline-badge"
      style={widget.color ? { borderColor: widget.color, color: widget.color } : undefined}
      title={widget.pluginId}
    >
      {widget.text}
    </span>
  )
}

function PluginDiffWidget({ widget }: { widget: PluginUiWidgetPayload }) {
  // Нативный diff-виджет: title/language сверху, unified diff построчно
  // (те же классы, что у DiffBlock кодоблока в markdown).
  const diffText = widget.diff ?? ''
  return (
    <div className="plugin-inline-widget plugin-diff-widget">
      {(widget.title || widget.language) && (
        <div className="plugin-diff-widget-header">
          {widget.title && <span className="plugin-diff-widget-title">{widget.title}</span>}
          {widget.language && <span className="plugin-diff-widget-lang">{widget.language}</span>}
        </div>
      )}
      <div className="plugin-diff-widget-body diff-block">
        {diffText.split('\n').map((line, i) => {
          const cls = line.startsWith('+') ? 'diff-add'
            : line.startsWith('-') ? 'diff-del'
            : line.startsWith('@@') ? 'diff-hunk'
            : 'diff-ctx'
          return (
            <div key={i} className={`diff-line ${cls}`}>
              <span className="diff-line-content">{line || '\u00A0'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PluginInlineWidget({ widget }: { widget: PluginUiWidgetPayload }) {
  const openPluginPanel = usePluginPanelStore(s => s.openPanel)
  const kind = widget.kind ?? 'iframe'
  // kind='diff' — нативный diff-виджет хоста (iframe не грузим).
  if (kind === 'diff') return <PluginDiffWidget widget={widget} />
  // kind='badge' — инлайн-пилюля (декорация сообщения без iframe).
  if (kind === 'badge') return <PluginBadgeWidget widget={widget} />
  const height = typeof widget.height === 'number' ? widget.height : 260
  // Action-кнопки виджета: command → слэш-команда плагина,
  // panel → открыть панель плагина (registerPanel).
  const widgetActions = widget.actions ?? []
  const runAction = (a: { label: string; command?: string; panel?: string }) => {
    if (a.command) {
      const ext = getPluginsExt()
      if (ext.notificationAction) {
        void ext.notificationAction({ pluginId: widget.pluginId, command: a.command }).catch(() => {})
      }
      return
    }
    if (a.panel) openPluginPanel(widget.pluginId, a.label)
  }
  return (
    <div className="plugin-inline-widget">
      <div className="plugin-inline-widget-frame-wrap" style={{ height }}>
        <PluginIframe
          pluginId={widget.pluginId}
          entry={widget.entry}
          widgetData={widget.data}
          className="plugin-inline-widget-frame"
        />
      </div>
      {widgetActions.length > 0 && (
        <div className="plugin-widget-actions">
          {widgetActions.map((a, i) => (
            <button
              key={`${a.label}-${i}`}
              type="button"
              className="plugin-widget-action-btn"
              onClick={() => runAction(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Контекстные пункты плагинов для сообщения (registerContextMenu) ─────
// Кнопка «⋯» появляется в message-actions рядом с copy/pin/reply, если хоть
// один запущенный плагин зарегистрировал пункты scope:'message'. При открытии
// подмешиваются пункты scope:'selection' (если в документе есть выделение).
// Пункты с button:true рендерятся ОТДЕЛЬНЫМИ кнопками в ряду действий
// (PluginMessageButtons ниже), а в меню «⋯» не попадают.
function PluginMessageCtxMenu({ message }: { message: Message }) {
  const pluginsList = useExtensionsStore(s => s.plugins)
  const chatId = message.chatId || useChatStore.getState().currentChatId || ''
  const items = useMemo(() => collectMessageContextMenu(), [pluginsList])
  // button-пункты рендерятся отдельными кнопками (PluginMessageButtons) —
  // в меню «⋯» попадают только обычные пункты.
  const messageItems = useMemo(() => items.filter(i => i.scope === 'message' && !i.button), [items])
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null)
  const [visibleItems, setVisibleItems] = useState<typeof items>([])

  // Закрытие: клик вне меню/кнопки или Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      if (btnRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (messageItems.length === 0) return null

  const toggleMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    const selection = (window.getSelection()?.toString() ?? '').trim()
    const selItems = selection ? items.filter(i => i.scope === 'selection') : []
    const shown = [...messageItems, ...selItems]
    setVisibleItems(shown)
    // Оценка высоты — чтобы открывать вверх у нижнего края окна.
    const estH = shown.length * 34 + 16
    const up = rect.bottom + 8 + estH > window.innerHeight
    setPos({ x: Math.max(8, Math.min(rect.right, window.innerWidth - 220)), y: up ? rect.top - 8 : rect.bottom + 8, up })
    setOpen(v => !v)
  }

  const runItem = (pluginId: string, item: { id: string; label: string; sub?: string; icon?: string }, selection: string) => {
    setOpen(false)
    const ext = getPluginsExt()
    if (!ext.contextMenuClick) return
    void ext.contextMenuClick({
      pluginId,
      itemId: item.id,
      payload: { messageId: message.id, chatId, content: message.content ?? '', selection: selection || undefined },
    }).catch(() => {})
  }

  return (
    <>
      <motion.button
        type="button"
        className={`icon-button msg-action-btn plugin-msg-menu-btn${open ? ' plugin-msg-menu-btn--open' : ''}`}
        ref={btnRef}
        onClick={toggleMenu}
        title="Действия плагинов"
        aria-label="Действия плагинов"
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.92 }}
      >
        <AppIcon name="moreHorizontal" size="sm" />
      </motion.button>
      {open && pos && visibleItems.length > 0 && createPortal(
        <motion.div
          ref={menuRef}
          className="plugin-msg-menu"
          style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 9990 }}
          initial={{ opacity: 0, scale: 0.96, y: pos.up ? 4 : -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          {visibleItems.map((it) => {
            const sel = (window.getSelection()?.toString() ?? '').trim()
            const isSelection = it.scope === 'selection'
            return (
              <button
                key={`${it.pluginId}-${it.id}`}
                type="button"
                className="plugin-msg-menu-item"
                onMouseDown={(e) => { e.preventDefault(); runItem(it.pluginId, { id: it.id, label: it.label, icon: it.icon }, isSelection ? sel : '') }}
              >
                <AppIcon name={(it.icon as Parameters<typeof AppIcon>[0]['name']) || 'moreHorizontal'} size="sm" tone="muted" />
                <span>{it.label}</span>
              </button>
            )
          })}
        </motion.div>,
        document.body,
      )}
    </>
  )
}

// ── Кнопки-декорации сообщений от плагинов (registerContextMenu button) ──
// Пункты с button:true — отдельные кнопки в ряду действий сообщения
// (copy/pin/reply), не в меню «⋯». Клик — тот же callHandler 'menu'.
function PluginMessageButtons({ message }: { message: Message }) {
  const pluginsList = useExtensionsStore(s => s.plugins)
  const chatId = message.chatId || useChatStore.getState().currentChatId || ''
  const buttons = useMemo(
    () => collectMessageContextMenu().filter(i => i.button && i.scope === 'message'),
    [pluginsList],
  )

  if (buttons.length === 0) return null

  const runItem = (pluginId: string, itemId: string) => {
    const ext = getPluginsExt()
    if (!ext.contextMenuClick) return
    void ext.contextMenuClick({
      pluginId,
      itemId,
      payload: { messageId: message.id, chatId, content: message.content ?? '' },
    }).catch(() => {})
  }

  return (
    <>
      {buttons.map(it => (
        <motion.button
          key={`${it.pluginId}-${it.id}`}
          type="button"
          className="icon-button msg-action-btn plugin-msg-action-btn"
          title={it.label}
          aria-label={it.label}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.92 }}
          onClick={() => runItem(it.pluginId, it.id)}
        >
          <AppIcon name={(it.icon as Parameters<typeof AppIcon>[0]['name']) || 'puzzle'} size="sm" />
        </motion.button>
      ))}
    </>
  )
}

// ── Кастомные теги сообщений плагинов (registerMessageTag) ───────────────
// Парный тег <tag attr="...">inner</tag> или самозакрытый <tag attr="..."/>
// рендерится iframe-виджетом плагина вместо markdown. Незарегистрированный
// тег остаётся обычным текстом (в markdown это выглядит как raw HTML —
// react-markdown выводит его как есть, т.к. rehype-raw не подключён, значит
// текст просто не пропадает).
function parseAttrs(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrStr))) {
    out[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return out
}

function PluginTagWidget({ pluginId, entry, height, attrs, inner }: {
  pluginId: string
  entry: string
  height: number
  attrs: Record<string, string>
  inner: string
}) {
  return (
    <div className="plugin-message-tag" style={{ height }}>
      <PluginIframe
        pluginId={pluginId}
        entry={entry}
        widgetData={{ attrs, inner }}
        className="plugin-message-tag-frame"
      />
    </div>
  )
}

interface PluginTagMatch {
  pluginId: string
  entry: string
  height?: number
  attrs: Record<string, string>
  inner: string
  start: number
  end: number
}

/** Просканировать текст на зарегистрированные теги плагинов. Пусто — нет. */
function scanPluginTags(content: string): PluginTagMatch[] {
  const tags = collectMessageTags()
  if (tags.length === 0) return []
  const byTag = new Map<string, { pluginId: string; entry: string; height?: number }>()
  for (const t of tags) {
    if (t.tag && !byTag.has(t.tag)) byTag.set(t.tag, { pluginId: t.pluginId, entry: t.entry, height: t.height })
  }
  if (byTag.size === 0) return []
  const names = [...byTag.keys()].map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(
    `<(${names})((?:\\s+[a-zA-Z_][\\w-]*(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+))?)*)\\s*(?:/>|>([\\s\\S]*?)<\\/\\1\\s*>)`,
    'g',
  )
  const out: PluginTagMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) {
    const meta = byTag.get(m[1])
    if (!meta) continue
    out.push({
      pluginId: meta.pluginId,
      entry: meta.entry,
      height: meta.height,
      attrs: parseAttrs(m[2] || ''),
      inner: m[3] ?? '',
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── renderParsedSegments: рендер массива сегментов из parseContent ─────────
// Переиспользуется в 4 местах (основной рендер, iterations, liveTextAfter).
// Принимает per-instance mdComponents (с доступом к workdir для кликабельных путей).
// plan-сегменты рендерятся в PlanCard (live во время стрима — partial=true, после — с filePath).
function renderParsedSegments(
  segs: ReturnType<typeof parseContent>,
  remarkPlugins: readonly unknown[],
  rehypePlugins: readonly unknown[],
  planFilePath?: string,
  mdComponents?: Record<string, unknown>,
): React.ReactNode {
  return segs.map((s, i) => {
    if (s.type === 'plan') {
      return (
        <PlanCard
          key={`plan-${i}`}
          title={s.title || 'План'}
          summary={s.summary || ''}
          content={s.content}
          filePath={s.partial ? undefined : planFilePath}
          partial={s.partial}
        />
      )
    }
    if (s.type === 'admonition') {
      return (
        <AdmonitionBlock key={`adm-${i}`} kind={s.kind!} title={s.title}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins as never}
            rehypePlugins={rehypePlugins as never}
            components={mdComponents as never}
            urlTransform={safeUrlTransform}
          >
            {s.content}
          </ReactMarkdown>
        </AdmonitionBlock>
      )
    }
    // Инлайн-виджет плагина: если md-сегмент целиком — JSON-маркер виджета,
    // рендерим PluginIframe вместо markdown.
    const widget = tryParsePluginWidget(s.content)
    if (widget) {
      return <PluginInlineWidget key={`widget-${i}`} widget={widget} />
    }
    // Кастомные теги плагинов (registerMessageTag): разбиваем md-сегмент на
    // под-части — markdown-текст через обычный ReactMarkdown, теги — виджеты.
    const tagMatches = scanPluginTags(s.content)
    if (tagMatches.length > 0) {
      const parts: React.ReactNode[] = []
      let cursor = 0
      tagMatches.forEach((m, ti) => {
        const before = s.content.slice(cursor, m.start)
        if (before.trim()) {
          parts.push(
            <ReactMarkdown
              key={`md-${i}-${ti}`}
              remarkPlugins={remarkPlugins as never}
              rehypePlugins={rehypePlugins as never}
              components={mdComponents as never}
              urlTransform={safeUrlTransform}
            >
              {before}
            </ReactMarkdown>,
          )
        }
        parts.push(
          <PluginTagWidget
            key={`tag-${i}-${ti}`}
            pluginId={m.pluginId}
            entry={m.entry}
            height={typeof m.height === 'number' ? m.height : 260}
            attrs={m.attrs}
            inner={m.inner}
          />,
        )
        cursor = m.end
      })
      const tail = s.content.slice(cursor)
      if (tail.trim()) {
        parts.push(
          <ReactMarkdown
            key={`md-${i}-tail`}
            remarkPlugins={remarkPlugins as never}
            rehypePlugins={rehypePlugins as never}
            components={mdComponents as never}
            urlTransform={safeUrlTransform}
          >
            {tail}
          </ReactMarkdown>,
        )
      }
      return <React.Fragment key={`md-tags-${i}`}>{parts}</React.Fragment>
    }
    return (
      <ReactMarkdown
        key={`md-${i}`}
        remarkPlugins={remarkPlugins as never}
        rehypePlugins={rehypePlugins as never}
        components={mdComponents as never}
        urlTransform={safeUrlTransform}
      >
        {s.content}
      </ReactMarkdown>
    )
  })
}

// ── createMdComponents: per-instance mdComponents с доступом к workdir ───
// Раньше был module-level (стабилен, кэшируемый). Теперь — функция, т.к.
// нужен workdir для кликабельных путей и onOpenFile для code-блоков.
// Кэш parsedRenderCache ключуется по text+workdir — при смене workdir
// кэш-промах, но evictOldest ограничивает рост.
function createMdComponents(opts: { workdir?: string; onOpenFile?: (path: string) => void; onPreviewAttachment?: (a: Attachment | null) => void }): Record<string, unknown> {
  const { workdir, onOpenFile, onPreviewAttachment } = opts

  // Обработчик клика на путь файла (code-блоки, заголовки с путём).
  // openFilePath сам резолвит от workdir, парсит суффикс :42-58 и решает
  // по stat: файл в проекте → правая панель, папка/вне проекта → Проводник.
  const handlePathClick = (e: React.MouseEvent, rawPath: string) => {
    e.preventDefault()
    e.stopPropagation()
    void openFilePath(rawPath, workdir)
  }

  // Обработчик клика на ссылку — если это file:// путь, открываем в панели
  const handleLinkClick = (e: React.MouseEvent, href: string) => {
    // file:// путь → открываем через общий флоу (панель/Проводник).
    // preventDefault ДО проверки onOpenFile: иначе при отсутствии колбэка
    // происходила бы дефолтная навигация (открытие второй копии приложения).
    if (href.startsWith('file://')) {
      e.preventDefault()
      // file:///C:/path → C:/path ; file://C:\path → C:\path
      const fp = decodeURIComponent(href.replace(/^file:\/\/\/?/, ''))
      void openFilePath(fp, workdir)
      return
    }
    // Относительный путь без протокола (редко, но возможно)
    if (workdir && !href.startsWith('http') && !href.startsWith('mailto') && /\.\w{1,10}$/.test(href)) {
      e.preventDefault()
      void openFilePath(href, workdir)
      return
    }
    // Иначе — обычная ссылка, браузер откроет
  }

  return {
    code({ className, children }: { className?: string; children?: React.ReactNode }) {
      const match = /language-(\w+)/.exec(className || '')
      const raw = String(children).replace(/\n$/, '')
      const isInline = !match && !raw.includes('\n')
      if (isInline) return <code className="inline-code">{children}</code>
      const lang = match?.[1] || 'text'
      if (lang === 'mermaid') return <MermaidBlock code={raw} />
      if (lang === 'chart') return <ChartBlock code={raw} />
      if (lang === 'diff') return <DiffBlock code={raw} />
      // Кастомный рендерер кодоблока от плагина (registerMarkdownRenderer):
      // если плагин зарегистрировал рендерер для этого языка — грузим его
      // iframe с кодом в widgetData; иначе — обычный код-блок.
      const pluginMd = findPluginMdRenderer(lang)
      if (pluginMd) {
        return (
          <PluginMarkdownBlock
            pluginId={pluginMd.pluginId}
            entry={pluginMd.entry}
            height={pluginMd.height ?? 300}
            raw={raw}
            lang={lang}
          />
        )
      }

      // Парсим info-string на наличие пути: ```ts src/foo.ts
      // info-string — это className после language-, может содержать путь
      const fullInfo = className || ''
      const pathMatch = /\blanguage-(\w+)\s+(.+)/.exec(fullInfo)
      const codePath = pathMatch?.[2]?.trim()

      return (
        <div className="code-block">
          <div
            className={`code-block-header${codePath && onOpenFile ? ' code-block-header--clickable' : ''}`}
            onClick={codePath && onOpenFile ? (e) => handlePathClick(e, codePath) : undefined}
          >
            <span className="code-lang">{lang.toUpperCase()}{codePath ? ` · ${codePath}` : ''}</span>
            <div className="code-block-header-actions">
              {codePath && onOpenFile && (
                <button
                  className="code-block-open-file-btn"
                  onClick={(e) => handlePathClick(e, codePath)}
                  title="Открыть в редакторе"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </button>
              )}
              <CopyButton raw={raw} />
            </div>
          </div>
          <CodeHighlighter raw={raw} lang={lang} />
        </div>
      )
    },
    table({ children }: { children?: React.ReactNode }) { return <div className="md-table-wrap"><table className="md-table">{children}</table></div> },
    thead({ children }: { children?: React.ReactNode }) { return <thead className="md-thead">{children}</thead> },
    tr({ children }: { children?: React.ReactNode }) { return <tr className="md-tr">{children}</tr> },
    th({ children }: { children?: React.ReactNode }) { return <th className="md-th">{children}</th> },
    td({ children }: { children?: React.ReactNode }) { return <td className="md-td">{children}</td> },
    blockquote({ children }: { children?: React.ReactNode }) { return <blockquote className="md-blockquote">{children}</blockquote> },
    a({ href, children }: { href?: string; children?: React.ReactNode }) {
      // file-path:// — кликабельный путь файла из remarkFilePaths плагина.
      // FilePathLink: чип с иконкой, статусом существования, peek-превью,
      // контекстным меню; клик → панель/Проводник (openFilePath).
      if (href?.startsWith('file-path://')) {
        const rawPath = decodeURIComponent(href.replace(/^file-path:\/\//, ''))
        return <FilePathLink raw={rawPath} workdir={workdir} />
      }
      // file:// — путь к файлу на диске, открываем в правой панели
      if (href?.startsWith('file://')) {
        return (
          <a
            href={href}
            className="md-link"
            onClick={(e) => handleLinkClick(e, href)}
          >
            {children}
          </a>
        )
      }
      // Пустой href (санитайзер вырезал протокол) — НЕ кликабельная ссылка:
      // href='' означал бы переход на текущую страницу приложения.
      if (!href) {
        return <span className="md-link">{children}</span>
      }
      // Обычная ссылка — открываем в браузере. title показывает полный URL
      // (полезно для [текст](url) — куда реально ведёт).
      return (
        <a
          href={href}
          className="md-link"
          target="_blank"
          rel="noreferrer"
          title={href}
          onClick={(e) => handleLinkClick(e, href)}
        >
          {children}
        </a>
      )
    },
    hr() { return <hr className="md-hr" /> },
    p({ children }: { children?: React.ReactNode }) {
      return <p>{children}</p>
    },
    img({ src, alt }: { src?: string; alt?: string }) {
      if (!src) return null
      return <ChatImage src={src} alt={alt || ''} onPreviewAttachment={onPreviewAttachment} />
    },
  }
}

// ── ChatImage: красивый рендер картинок в чате ──
// Скелетон пока грузится → клик открывает AttachmentPreviewModal (zoom/pan) →
// hover показывает кнопки: копировать URL, копировать markdown, открыть в браузере.
let chatImgCounter = 0
const ChatImage = memo(function ChatImage({ src, alt, onPreviewAttachment }: {
  src: string
  alt: string
  onPreviewAttachment?: (a: Attachment | null) => void
}) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState<'url' | 'md' | null>(null)

  // Синтетический Attachment для AttachmentPreviewModal
  const handleOpenPreview = useCallback(() => {
    if (!onPreviewAttachment) {
      // Fallback — открыть в браузере
      window.open(src, '_blank')
      return
    }
    // Извлекаем имя файла из URL
    let name = alt || 'image'
    try {
      const u = new URL(src)
      const basename = u.pathname.split('/').pop()
      if (basename && /\.\w{1,5}$/.test(basename)) name = basename
    } catch { /* not a URL, use alt */ }
    onPreviewAttachment({
      id: `chat-img-${++chatImgCounter}`,
      kind: 'image',
      name,
      dataUrl: src,
      source: 'paste' as const,
      attachedAt: Date.now(),
    })
  }, [src, alt, onPreviewAttachment])

  const handleCopyUrl = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    void copyToClipboard(src).then((ok) => {
      if (ok) {
        setCopied('url')
        setTimeout(() => setCopied(null), 1500)
      }
    })
  }, [src])

  const handleCopyMd = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const md = `![${alt || 'image'}](${src})`
    void copyToClipboard(md).then((ok) => {
      if (ok) {
        setCopied('md')
        setTimeout(() => setCopied(null), 1500)
      }
    })
  }, [src, alt])

  const handleOpenExternal = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    window.open(src, '_blank')
  }, [src])

  if (error) {
    return (
      <div className="chat-img-error" title={`URL: ${src}`}>
        <svg className="chat-img-error-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
          <line x1="3" y1="14" x2="8" y2="14" />
        </svg>
        <span className="chat-img-error-text">
          {alt || 'Изображение не загрузилось'}
        </span>
        <button
          className="chat-img-error-btn"
          onClick={(e) => { e.stopPropagation(); window.open(src, '_blank') }}
          title="Открыть в браузере"
        >
          Открыть
        </button>
      </div>
    )
  }

  return (
    <figure className="chat-img-figure">
      <div className="chat-img-container" onClick={handleOpenPreview}>
        {/* Skeleton пока не загружено */}
        {!loaded && <div className="chat-img-skeleton" />}
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className={`chat-img${loaded ? ' chat-img--loaded' : ''}`}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          draggable={false}
        />
        {/* Hover actions — top-right */}
        {loaded && (
          <div className="chat-img-actions" onClick={(e) => e.stopPropagation()}>
            <button className="chat-img-action-btn" onClick={handleOpenPreview} title="Открыть в просмотре">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6"/><path d="M10 14L21 3"/>
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              </svg>
            </button>
            <button className="chat-img-action-btn" onClick={handleCopyUrl} title="Копировать URL">
              {copied === 'url' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              )}
            </button>
            <button className="chat-img-action-btn" onClick={handleCopyMd} title="Копировать markdown">
              {copied === 'md' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>
                </svg>
              )}
            </button>
            <button className="chat-img-action-btn" onClick={handleOpenExternal} title="Открыть в браузере">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
            </button>
          </div>
        )}
      </div>
      {alt && <figcaption className="chat-img-caption">{alt}</figcaption>}
    </figure>
  )
}, (prev, next) => prev.src === next.src && prev.alt === next.alt && prev.onPreviewAttachment === next.onPreviewAttachment)

// ── Module-level кэш отрендеренного ReactNode-дерева по text.
// Виртуализатор монтирует/демонтирует MessageBubble при скролле; ParsedContent
// memo per-instance теряется при unmount → ReactMarkdown заново парсит весь
// markdown (remark→mdast→hast→JSX). Для большого сообщения это 0.3–0.5с фриз
// на КАЖДОМ scroll-remount. Кэш хранит готовое React-дерево; при remount
// берём из кэша — ре-парс пропускается. Безопасно: mdComponents module-level
// стабилен, компоненты (CodeHighlighter/MermaidBlock/CopyButton) те же.
// Ключ: text + allowPlanCard + набор плагинов (стрим/не-стрим/math/нет-math).
const parsedRenderCache = new Map<string, React.ReactNode>()

// ── ParsedContent: мемоизированный рендер parseContent ──────────────────
// Раньше parseContent(...) звался инлайн при каждом флеше стрима (20×/сек),
// ре-парся markdown AST + KaTeX каждый раз. Теперь каждый экземпляр
// мемоизирует парс на [text, allowPlanCard] — ре-парс только если текст
// реально изменился. Невидимо: вывод идентичный.
const ParsedContent = memo(function ParsedContent({
  text, allowPlanCard, remarkPlugins, rehypePlugins, planFilePath, isStreaming, mdComponents, workdir,
}: {
  text: string
  allowPlanCard: boolean
  remarkPlugins: readonly unknown[]
  rehypePlugins: readonly unknown[]
  planFilePath?: string
  isStreaming?: boolean
  mdComponents?: Record<string, unknown>
  workdir?: string
}) {
  const segs = useMemo(() => parseContentCached(text, allowPlanCard), [text, allowPlanCard])
  const wdKey = workdir ?? ''

  // ── Инкрементальный рендер во время стриминга ──
  // Во время стрима text растёт каждые 50мс. Кэш parsedRenderCache ключуется
  // по всему тексту → MISS на каждом флеше → O(n) ре-парс.
  //
  // Оптимизация: разбиваем text на стабильный префикс + активный хвост.
  // Стабильный префикс = всё до последней границы блока (\n\n, ```, :::).
  // Префикс кэшируется в parsedRenderCache → hit на каждом флеше.
  // Хвост парсится ReactMarkdown → O(|хвост|) вместо O(n).
  // Полный markdown (таблицы, списки, bold, код) сохраняется во время стрима.
  if (isStreaming && text) {
    // Ищем последнюю границу блока — после неё текст может быть неполным
    const lastFence = text.lastIndexOf('```')
    const lastPara = text.lastIndexOf('\n\n')
    const lastAdm = text.lastIndexOf('\n:::')
    // Если код-блок ОТКРЫТ (нечётное количество ```), последний ``` —
    // открывающий fence. Границы \n\n/::: ВНУТРИ блока (после lastFence)
    // разрывают блок на prefix/tail → ReactMarkdown рендерит половину
    // кода как текст. Не используем их — splitAt = lastFence.
    const fenceCount = (text.match(/```/g) || []).length
    const splitAt = (fenceCount % 2 === 1 && lastFence >= 0)
      ? lastFence
      : Math.max(lastFence, lastPara, lastAdm)
    if (splitAt > 100 && splitAt < text.length - 1) {
      // Есть стабильный префикс — кэшируем его, хвост парсим отдельно
      const prefix = text.slice(0, splitAt)
      const tail = text.slice(splitAt)
      const prefixKey = prefix + '|stream|' + (allowPlanCard ? '1' : '0')
        + '|' + (remarkPlugins === undefined ? '' : remarkPlugins.length)
        + '|' + (rehypePlugins === undefined ? '' : rehypePlugins.length)
        + '|' + wdKey
      let prefixNode = parsedRenderCache.get(prefixKey)
      if (!prefixNode) {
        const prefixSegs = parseContentCached(prefix, allowPlanCard)
        prefixNode = renderParsedSegments(prefixSegs, remarkPlugins, rehypePlugins, planFilePath, mdComponents)
        if (parsedRenderCache.size > 150) evictOldest(parsedRenderCache, 100)
        parsedRenderCache.set(prefixKey, prefixNode)
      }
      // Хвост — короткий, парсим ReactMarkdown каждый флеш (дёшево)
      const tailSegs = parseContentCached(tail, allowPlanCard)
      const tailNode = renderParsedSegments(tailSegs, remarkPlugins, rehypePlugins, planFilePath, mdComponents)
      return <>{prefixNode}{tailNode}</>
    }
    // Нет стабильного префикса (начало ответа) — парсим весь text через ReactMarkdown.
    // remarkGfm (без KaTeX) — дёшево, полный markdown сохраняется.
    const cacheKey = text + '|stream|' + (allowPlanCard ? '1' : '0')
      + '|' + (remarkPlugins === undefined ? '' : remarkPlugins.length)
      + '|' + (rehypePlugins === undefined ? '' : rehypePlugins.length)
      + '|' + wdKey
    let node = parsedRenderCache.get(cacheKey)
    if (!node) {
      node = renderParsedSegments(segs, remarkPlugins, rehypePlugins, planFilePath, mdComponents)
      if (parsedRenderCache.size > 150) evictOldest(parsedRenderCache, 100)
      parsedRenderCache.set(cacheKey, node)
    }
    return <>{node}</>
  }

  // Финальный рендер (isStreaming=false) — полный парс с кэшированием
  const cacheKey = text + '|' + (allowPlanCard ? '1' : '0')
    + '|' + (remarkPlugins === undefined ? '' : remarkPlugins.length)
    + '|' + (rehypePlugins === undefined ? '' : rehypePlugins.length)
    + '|' + (planFilePath ?? '')
    + '|' + wdKey
  let node = parsedRenderCache.get(cacheKey)
  if (!node) {
    node = renderParsedSegments(segs, remarkPlugins, rehypePlugins, planFilePath, mdComponents)
    if (parsedRenderCache.size > 150) evictOldest(parsedRenderCache, 100)
    parsedRenderCache.set(cacheKey, node)
  }
  return <>{node}</>
}, (prev, next) =>
  prev.text === next.text &&
  prev.allowPlanCard === next.allowPlanCard &&
  prev.remarkPlugins === next.remarkPlugins &&
  prev.rehypePlugins === next.rehypePlugins &&
  prev.planFilePath === next.planFilePath &&
  prev.isStreaming === next.isStreaming &&
  prev.workdir === next.workdir
)

// ── AgentCardLive — живая карточка суб-агента в чате ─────────────────────
// Module-level кэш: виртуализатор монтирует/демонтирует сообщения при
// скролле — без кэша каждый remount карточки дёргал IPC agent.get.
// Обновления приходят через agent:update (кэш актуализируется событием).
const agentCardCache = new Map<string, AgentCardData>()

// Module-level agent:update listener — ОБНОВЛЯЕТ кэш даже когда ни один
// AgentCardLive не смонтирован (виртуализация скролла размонтирует компоненты,
// снимая их слушатели). Без этого финальный agent:update (done/cancelled)
// прилетает без слушателя → кэш залипает в 'running' → карточка вечно "выполняется".
let _agentCacheListenerInstalled = false
if (!_agentCacheListenerInstalled) {
  _agentCacheListenerInstalled = true
  window.syntee.on('agent:update', (updated: { id: string } & Record<string, unknown>) => {
    const normalized = normalizeAgent(updated)
    agentCardCache.set(updated.id, normalized)
    // Cap: agentCardCache — module-level Map, растёт бесконечно (все суб-агенты
    // за сессию). Ограничиваем 100 записями — UI достаёт старые из БД по IPC.
    if (agentCardCache.size > 100) {
      const firstKey = agentCardCache.keys().next().value
      if (firstKey) agentCardCache.delete(firstKey)
    }
  })
}

/**
 * Нормализует сырой AgentRecord из IPC (у него нет stepsCount/currentStep —
 * это computed-поля для UI) в AgentCardData, ожидаемую карточкой. Без этого
 * кэш хранил бы «частичные» объекты, и TS-касты в обработчиках были бы лживы.
 */
function normalizeAgent(raw: Record<string, unknown> & { id: string }): AgentCardData {
  const steps = (raw.steps as AgentCardData['steps']) ?? []
  const lastToolCall = steps?.filter(s => s.type === 'tool_call').slice(-1)[0]
  const status = (raw.status as AgentCardData['status']) ?? 'pending'
  return {
    id: raw.id,
    task: (raw.task as string) ?? '',
    status,
    model: (raw.model as string) ?? '…',
    stepsCount: steps?.length ?? 0,
    currentStep: status === 'running' ? lastToolCall?.toolName : undefined,
    summary: raw.summary as string | undefined,
    error: raw.error as string | undefined,
    createdAt: (raw.createdAt as number) ?? Date.now(),
    finishedAt: raw.finishedAt as number | undefined,
    role: raw.role as string | undefined,
    steps,
  }
}

function AgentCardLive({ agentId, task }: {
  agentId: string
  task: string
}) {
  const [agent, setAgent] = useState<AgentCardData | null>(() => agentCardCache.get(agentId) ?? null)

  useEffect(() => {
    // IPC при cache-miss ИЛИ если кэш stale (статус non-terminal — агент
    // мог завершиться пока компонент был размонтирован виртуализатором).
    const cached = agentCardCache.get(agentId)
    const needsRefresh = !cached || cached.status === 'pending' || cached.status === 'running'
    if (needsRefresh) {
      window.syntee.agent.get(agentId).then((a: unknown) => {
        if (a) {
          if (agentCardCache.size > 200) evictOldest(agentCardCache, 150)
          const normalized = normalizeAgent(a as Record<string, unknown> & { id: string })
          agentCardCache.set(agentId, normalized)
          setAgent(normalized)
        }
      })
    }
    const off = window.syntee.on('agent:update', (updated: { id: string } & Record<string, unknown>) => {
      if (updated.id === agentId) {
        const normalized = normalizeAgent(updated)
        agentCardCache.set(agentId, normalized)
        setAgent(normalized)
      }
    })
    // agent:spawn — main эмитит сразу при регистрации записи (status='pending'),
    // ДО первого step. Без этого карточка рисует 'pending' + '…' пока не придёт
    // первый agent:update с реальной моделью.
    const offSpawn = window.syntee.on('agent:spawn', (e: { agentId: string; model?: string; role?: string; task: string; ts: number }) => {
      if (e.agentId !== agentId) return
      if (!agentCardCache.has(agentId) || !agentCardCache.get(agentId)?.model) {
        const initial: AgentCardData = {
          id: agentId, task: e.task, status: 'pending',
          model: e.model ?? '…', stepsCount: 0,
          createdAt: e.ts, role: e.role, steps: [],
        }
        agentCardCache.set(agentId, initial)
        setAgent(initial)
      }
    })
    return () => { off(); offSpawn() }
  }, [agentId])

  const status = (agent?.status ?? 'pending') as 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  const currentTool = (agent?.steps as Array<{ type: string; toolName?: string }> | undefined)
    ?.filter(s => s.type === 'tool_call').slice(-1)[0]?.toolName

  return (
    <AgentCard
      agent={{
        id: agentId,
        task,
        status,
        model: agent?.model ?? '…',
        stepsCount: agent?.steps?.length ?? 0,
        currentStep: status === 'running' && currentTool ? currentTool : undefined,
        summary: agent?.summary,
        error: agent?.error,
        createdAt: agent?.createdAt ?? Date.now(),
        finishedAt: agent?.finishedAt,
        role: agent?.role,
        steps: agent?.steps as Array<{ type: string; toolName?: string; toolArgs?: Record<string, unknown>; content: string; success?: boolean; timestamp: number }> | undefined,
      }}
      live={status === 'pending' || status === 'running'}
      onClick={() => {
        // Открываем правую панель и фокусируем конкретного агента.
        // RightPanelHost слушает CustomEvent 'open-agent-panel' и прокидывает
        // agentId в AgentPanel.focusAgentId → setSelected(agent.id).
        window.dispatchEvent(new CustomEvent('open-agent-panel', { detail: { agentId } }))
      }}
    />
  )
}

// Shimmer-индикатор ожидания AI (думает / rate limit)
const WAITING_PHRASES = [
  'Думаю...',
  'Анализирую...',
  'Составляю ответ...',
  'Обрабатываю...',
  'Формулирую...',
]

function WaitingIndicator({ rateLimitSec, agentStatus, retry, lastError, filesChanged, commandsRun, toolProgress }: {
  rateLimitSec?: number
  agentStatus?: string | null
  retry?: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null
  lastError?: string | null
  filesChanged?: number
  commandsRun?: number
  toolProgress?: Record<string, { stage: string; detail?: string; ts: number }>
}) {
  const [phraseIdx, setPhraseIdx] = useState(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    // При ретрае/ошибке/rate-limit морозим ротацию фраз — пользователь видит
    // причину вместо generic «Думаю…». Раньше статус ретрая затирался
    // следующим onStatus, и индикатор молчал о происходящем.
    if (agentStatus || rateLimitSec || retry || lastError) return
    const interval = setInterval(() => {
      setVisible(false)
      setTimeout(() => {
        setPhraseIdx(i => (i + 1) % WAITING_PHRASES.length)
        setVisible(true)
      }, 300)
    }, 2500)
    return () => clearInterval(interval)
  }, [agentStatus, rateLimitSec, retry, lastError])

  const isRateLimit = rateLimitSec && rateLimitSec > 0
  // Приоритет: vision_recognition (распознание изображений) > rate-limit >
  // retry > lastError > agentStatus > generic фраза.
  const visionProg = toolProgress?.['vision_recognition']
  let text: string
  let cls: string
  if (visionProg && visionProg.stage === 'analyzing') {
    text = visionProg.detail ?? 'Распознаю изображения...'
    cls = ' msg-waiting-shimmer--status'
  } else if (isRateLimit) {
    text = `Rate limit — жду ${rateLimitSec}с...`
    cls = ' msg-waiting-shimmer--rl'
  } else if (retry) {
    const max = retry.maxAttempts ? `/${retry.maxAttempts}` : ''
    text = retry.reason === 'rate_limit'
      ? `Лимит запросов · повтор ${retry.attempt}${max}${retry.waitSec ? ` через ${retry.waitSec}с` : ''}`
      : `Ошибка сети · повтор ${retry.attempt}${max}`
    cls = ' msg-waiting-shimmer--status'
  } else if (lastError) {
    text = lastError
    cls = ' msg-waiting-shimmer--status'
  } else if (agentStatus) {
    text = agentStatus
    cls = ' msg-waiting-shimmer--status'
  } else {
    text = WAITING_PHRASES[phraseIdx]
    cls = ''
  }

  // Живой счётчик (§4.2): N файлов изменено · M команд выполнено
  const counterParts: string[] = []
  if (filesChanged && filesChanged > 0) counterParts.push(`${filesChanged} ${plural(filesChanged, 'файл', 'файла', 'файлов')}`)
  if (commandsRun && commandsRun > 0) counterParts.push(`${commandsRun} ${plural(commandsRun, 'команда', 'команды', 'команд')}`)
  const counter = counterParts.length > 0 ? counterParts.join(' · ') : null

  return (
    <span className="msg-waiting-wrap">
      <span
        className={`msg-waiting-shimmer${cls}`}
        style={{ opacity: visible ? 1 : 0, transition: 'opacity 0.3s ease' }}
      >
        {text}
      </span>
      {counter && <span className="msg-waiting-counter">{counter}</span>}
    </span>
  )
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

/** Извлекает результат get_fast_context из steps итерации.
 *  Мемоизирован по content-строке: JSON.parse выполняется только при первом
 *  вызове с данным content, повторные вызовы берут результат из кэша.
 *  Раньше JSON.parse звался на каждом рендере MessageContent (внутри IIFE
 *  в liveIters.map и savedIters.map) — лишний CPU на каждый tool step. */
const _fcResultCache = new Map<string, FastContextResultData>()
function extractFastContextResult(steps: Array<{ type: string; toolName?: string; content?: string }>): FastContextResultData | null {
  for (const s of steps) {
    if (s.type === 'tool_result' && s.toolName === 'get_fast_context' && s.content) {
      const cached = _fcResultCache.get(s.content)
      if (cached) return cached
      try {
        const parsed = JSON.parse(s.content) as FastContextResultData
        if (parsed && Array.isArray(parsed.files)) {
          if (_fcResultCache.size > 200) _fcResultCache.clear()
          _fcResultCache.set(s.content, parsed)
          return parsed
        }
      } catch { /* skip */ }
    }
  }
  return null
}

// ── renderClickablePlainText: кликабельные пути в plain-text user-сообщениях ─
// Для user-сообщений без markdown (userMarkdown=false) — парсим пути в тексте
// и делаем их кликабельными. Также обрабатывает inline-вложения через токены.
// ── renderAttachChip: React-чип вложения (для токенов в user-сообщениях) ──
// Для chat/project клик — НЕ превью, а навигация: чат → tabActions.selectChat
// (глобальный мост ChatPage), проект → самый свежий чат проекта.
function handleEntityChipClick(att: Attachment): void {
  if (att.kind === 'chat' && att.chatId) {
    tabActions.selectChat?.(att.chatId)
    return
  }
  if (att.kind === 'project' && att.projectId) {
    const chat = useChatStore.getState().chats
      .filter(c => c.projectId === att.projectId && !c.isArchived)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (chat) tabActions.selectChat?.(chat.id)
  }
}

function renderAttachChip(
  att: Attachment | undefined,
  onPreviewAttachment?: (a: Attachment) => void,
): React.ReactNode {
  if (!att) return null
  const isEntity = att.kind === 'chat' || att.kind === 'project'
  const clickable = isEntity || !!onPreviewAttachment
  const title = att.kind === 'chat'
    ? `Чат: ${att.name}${att.snippet ? `\n${att.snippet}` : ''}`
    : att.kind === 'project'
    ? `Проект: ${att.name}${att.snippet ? `\n${att.snippet}` : ''}`
    : att.relPath || att.path || att.name
  return (
    <span
      className={`inline-attach inline-attach--${att.kind}${clickable ? ' inline-attach--clickable' : ''}`}
      onClick={clickable ? (e) => {
        e.stopPropagation()
        if (isEntity) handleEntityChipClick(att)
        else onPreviewAttachment?.(att)
      } : undefined}
      title={title}
    >
      {att.kind === 'image' && att.dataUrl && <img src={att.dataUrl} alt={att.name} className="inline-attach-thumb" />}
      {att.kind === 'image' && !att.dataUrl && att.path && <img src={`file://${att.path}`} alt={att.name} className="inline-attach-thumb" />}
      {att.kind !== 'image' && (
        <span className="inline-attach-icon">
          {att.kind === 'chat' ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          ) : att.kind === 'project' ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          )}
        </span>
      )}
      <span className="inline-attach-name">{att.name}</span>
    </span>
  )
}

function renderClickablePlainText(
  text: string,
  workdir?: string,
  _onOpenFile?: (path: string) => void,
): React.ReactNode {
  if (!text.includes('/') && !text.includes('\\')) {
    return text
  }
  // Regex для путей — тот же PATH_RE что в remarkFilePaths (lookbehind +
  // кириллица + папки + суффиксы :42-58), чтобы подсветка в plain-text
  // и markdown не разъезжалась. FilePathLink сам обрабатывает клик.
  const re = new RegExp(PATH_RE.source, 'g')
  const parts: React.ReactNode[] = []
  let lastIdx = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    const full = m[1]
    // Папка-«проза» (and/or) — пропускаем
    if (!isValidPathMatch(full)) continue
    const pathStart = m.index + (m[0].length - m[1].length)
    if (pathStart > lastIdx) {
      parts.push(text.slice(lastIdx, pathStart))
    }
    parts.push(<FilePathLink key={`fp-${key++}`} raw={full} workdir={workdir} />)
    lastIdx = pathStart + full.length
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx))
  }
  return <>{parts}</>
}

// Мемоизированный тяжёлый контент сообщения
const MessageContent = memo(function MessageContent({
  content, isUser, searchQuery, toolOutputMode, toolSteps,
  onPin, onCopy, onReadAloud, onReply, onRewind, message, isPinned, createdAt,
  liveThinking, isStreaming, isWaiting, liveIters, liveTodo, liveTextAfter, rateLimitSec,
  userMarkdown = true, timeEl, agentStatus, toolProgress, retry, lastError,
  spawnedAgents,
  onPreviewAttachment,
  workdir,
  editorAvailable = true,
}: {
  content: string; isUser: boolean; searchQuery?: string
  toolOutputMode: ToolOutputMode; toolSteps?: Message['toolSteps']
  onPin?: (id: string) => void; onCopy?: () => void
  onReadAloud?: () => void; onReply?: (message: Message) => void
  onRewind?: () => void
  message: Message; isPinned: number; createdAt: number
  liveThinking?: { text?: string; isLive: boolean; ms?: number; storeChatId?: string }
  isStreaming?: boolean
  isWaiting?: boolean
  liveIters?: Array<{ textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }>
  liveTodo?: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
  liveTextAfter?: string
  rateLimitSec?: number
  userMarkdown?: boolean
  timeEl?: React.ReactNode
  agentStatus?: string | null
  retry?: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null
  lastError?: string | null
  toolProgress?: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
  spawnedAgents?: Array<{ agentId: string; callId?: string; task: string; msgId: string; model?: string; ts: number }>
  onPreviewAttachment?: (a: Attachment | null) => void
  workdir?: string
  /** Доступен ли редактор чата для этого сообщения (false в инкогнито). */
  editorAvailable?: boolean
}) {
  const [statsOpen, setStatsOpen] = useState(false)
  // Если панель статистики не влезает сверху (сообщение в самом верху чата) —
  // показываем снизу от footer.
  const [statsBelow, setStatsBelow] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const statsPanelRef = useRef<HTMLDivElement>(null)

  // Закрытие панели статистики по клику вне неё.
  useEffect(() => {
    if (!statsOpen) return
    const onDown = (e: MouseEvent) => {
      const panel = statsPanelRef.current
      if (panel && !panel.contains(e.target as Node)) setStatsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [statsOpen])

  // Кламп панели статистики: если при открытии её верх уходит выше viewport
  // (сообщение в самом верху чата), переключаем на показ снизу от footer.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!statsOpen) { setStatsBelow(false); return }
    const panel = statsPanelRef.current
    if (!panel) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatsBelow(panel.getBoundingClientRect().top < 8)
  }, [statsOpen])

  // PlanCard разрешён только если: (1) план уже сохранён для этого сообщения
  // (message.planData), ИЛИ (2) это live-bubble в режиме планирования.
  // Вне режима планирования <plan>-теги рендерятся как обычный текст.
  const allowPlanCard = !!message.planData || !!(message as Message & { livePlanningMode?: boolean }).livePlanningMode

  // ── Редактор чата: режим + черновик этого сообщения ────────────────────
  // Режим привязан к chatId (editorChatId) — не «утекает» в сплит-чат.
  // Селекторы узкие: вне режима editorDraft всегда undefined → memo
  // MessageContent не пробивается (0 ре-рендеров). Live-пузырь не редактируется.
  const isLiveBubble = message.id === 'live-streaming-bubble' || message.id === 'split-live-streaming-bubble'
  const editorMode = useChatStore(s => !!s.editorChatId && s.editorChatId === message.chatId)
  const editorDraft = useChatStore(s => (s.editorChatId === message.chatId && !isLiveBubble ? s.editorDrafts[message.id] : undefined))
  const enterEditorMode = useChatStore(s => s.enterEditorMode)
  const updateEditorDraft = useChatStore(s => s.updateEditorDraft)
  const clearEditorDraft = useChatStore(s => s.clearEditorDraft)
  const patchMessage = useChatStore(s => s.patchMessage)
  const editorActive = editorMode && !isLiveBubble && editorAvailable
  // Эффективное «скрыто из контекста»: черновик перекрывает БД-значение.
  const hiddenNow = editorDraft?.hidden !== undefined ? editorDraft.hidden : !!message.hiddenFromContext
  const hasDraft = editorDraft !== undefined

  // ── Мемоизированные карточки spawn_agent (fallback для старых сообщений без iterations) ──
  // Раньше .filter().map() с вложенным .find() выполнялись на КАЖДОМ рендере.
  // Для цепочек 50+ шагов это 2500+ сравнений за рендер. Теперь useMemo.
  // Persisted-итерации рендерят карточки inline (они не ре-рендерятся часто —
  // только при scroll-mount виртуализатором).
  const spawnAgentCards = useMemo(() => {
    if (isUser || !toolSteps || liveIters?.length) return []
    if ((message as Message & { iterations?: unknown[] }).iterations?.length) return []
    const cards: Array<{ agentId: string; task: string }> = []
    for (const s of toolSteps) {
      if (s.type !== 'tool_call' || s.toolName !== 'spawn_agent') continue
      const resultStep = toolSteps.find(r =>
        r.type === 'tool_result' && r.toolName === 'spawn_agent' &&
        r.timestamp >= s.timestamp
      )
      const agentIdMatch = resultStep?.content?.match(/\[AGENT:([^\]]+)\]/)
      const agentId = agentIdMatch?.[1]
      if (agentId) cards.push({ agentId, task: (s.toolArgs?.task as string) ?? '' })
    }
    return cards
  }, [isUser, toolSteps, liveIters, message])

  // Изображения из tool steps
  const toolImages = useMemo(() => {
    if (isUser || !toolSteps || liveIters?.length) return []
    if ((message as Message & { iterations?: unknown[] }).iterations?.length) return []
    return toolSteps.filter(s => s.type === 'tool_result' && s.imageUrl)
  }, [isUser, toolSteps, liveIters, message])

  // Живой счётчик (§4.2): N файлов изменено · M команд выполнено
  const agentCounts = useMemo(() => {
    if (!toolSteps) return { filesChanged: 0, commandsRun: 0 }
    const filesChanged = toolSteps.filter(s =>
      s.type === 'tool_result' && s.success &&
      ['write_file', 'edit_file'].includes(s.toolName || '')
    ).length
    const commandsRun = toolSteps.filter(s =>
      s.type === 'tool_call' && s.toolName === 'run_command'
    ).length
    return { filesChanged, commandsRun }
  }, [toolSteps])

  // Две стабильные пары плагинов. Во время стриминга используем лёгкий набор
  // БЕЗ remark-math/rehype-katex: KaTeX ре-парсит все math-узлы на каждом
  // токене (O(n²) по длине ответа) — это главный источник «фризит пока
  // печатает». remarkGfm (таблицы/списки/код) дёшево ре-парсится каждый токен.
  // Когда стрим закончен (isStreaming=false) — полный набор, финальный вид
  // идентичен (math появится в момент окончания стрима, незаметно).
  // Доп. оптимия для скролла: даже в не-стриминге (история) большинство
  // сообщений не содержат математики → пропускаем remark-math/rehype-katex
  // целиком. Каждый scroll-mount виртуализатора ре-парсит markdown; без
  // KaTeX-прохода это заметно дешевле → меньше фризов при быстром скролле.
  // Детект математики — по СЫРОМУ тексту (нормализация внутри parseContent
  // превращает \( / \[ / \begin{env} в $, но здесь мы видим исходник):
  // иначе \(...\)-формулы не подключили бы remark-math и рендерились бы текстом.
  const hasMath = useMemo(() => containsMathMarkers(content), [content])
  // remarkFilePaths — и в стриминге: regex-проход по text-нодам дёшев,
  // FilePathLink мемоизирован (props raw/workdir стабильны между флешами),
  // stat-проверки дедуплицированы кэшем pathStatus (один IPC на уникальный
  // путь за сессию). Частичный путь во время печати → missing → простой
  // текст; допечатался → чип. Прогрессивное улучшение без шторма ре-рендеров.
  const streamingRemark = useMemo(() => [remarkGfm, remarkFilePaths], [])
  const fullRemark = useMemo(() => hasMath ? [remarkGfm, remarkMath, remarkFilePaths] : [remarkGfm, remarkFilePaths], [hasMath])
  const emptyRehype = useMemo<readonly unknown[]>(() => [], [])
  const fullRehype = useMemo(() => hasMath
    ? [[rehypeKatex, { errorColor: 'var(--danger, #e5484d)' }]]
    : emptyRehype, [hasMath, emptyRehype])
  const remarkPlugins = isStreaming ? streamingRemark : fullRemark
  const rehypePlugins = isStreaming ? emptyRehype : fullRehype

  // ── Per-instance mdComponents с кликабельными путями ──
  // workdir нужен для резолва относительных путей → правая панель.
  // remarkFilePaths работает и в стриминге (см. streamingRemark выше).
  // Сам open-флоу (stat → файл/папка/Проводник + reveal на строку) — в
  // openFilePath, колбэк здесь только как маркер «клики разрешены»
  // (условие в code-блоках) и для внешних потребителей.
  const onOpenFile = useCallback((fp: string) => {
    void openFilePath(fp, workdir)
  }, [workdir])

  const mdComponents = useMemo(
    () => createMdComponents({ workdir, onOpenFile, onPreviewAttachment }),
    [workdir, onOpenFile, onPreviewAttachment],
  )

  return (
    <div
      ref={wrapRef}
      className="message-bubble-wrap"
    >
      <div className={`message-bubble ${isUser ? 'message-bubble--user glass' : 'message-bubble--assistant'}`}>
        {isPinned === 1 && (
          <div className="message-pinned-badge">
            <AppIcon name="pin" size="sm" tone="accent" /><span>Закреплено</span>
          </div>
        )}

        {/* Пилюлька слеш-команды */}
        {isUser && message.slashCommand && (
          <div className="message-slash-pill">
            <span className="message-slash-pill-icon">/</span>
            <span className="message-slash-pill-name">{message.slashCommand.name}</span>
            {message.slashCommand.args && (
              <span className="message-slash-pill-args">{message.slashCommand.args}</span>
            )}
          </div>
        )}

        {!isUser && toolSteps && toolSteps.length > 0 && !liveIters?.length && !(message as Message & { iterations?: unknown[] }).iterations?.length && (
          <ToolChain steps={toolSteps} mode={toolOutputMode} isRunning={false} />
        )}

        {/* Финальный рендер итераций из БД — точно как live, каждая итерация отдельно.
            В режиме редактора текстовые сегменты (textBefore) превращаются
            в textarea — тулы остаются на месте между ними, правится только текст. */}
        {!isUser && !liveIters?.length && (() => {
          type Iter = { label?: string; textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }
          const iters = (message as Message & { iterations?: Iter[] }).iterations
          if (!iters?.length) return null
          // Текущие значения сегментов в редакторе: черновик перекрывает БД.
          const draftTexts = editorActive ? (editorDraft?.iterTexts ?? []) : []
          const setIterText = (i: number, v: string) => {
            const next = iters.map((it, idx) => draftTexts[idx] ?? it.textBefore ?? '')
            next[i] = v
            updateEditorDraft(message.id, { iterTexts: next })
          }
          return (
            <div className="message-iters">
              {iters.map((iter, i) => (
                <div key={i} className={`message-iteration${editorActive ? ' message-iteration--editing' : ''}`}>
                  {iter.thinking && (
                    <ThinkingBlock text={iter.thinking} thinkingMs={iter.thinkingMs} />
                  )}
                  {editorActive ? (
                    (iter.textBefore || draftTexts[i] !== undefined) && (
                      <div className="message-content message-content--editing">
                        <EditorTextarea
                          value={draftTexts[i] ?? iter.textBefore}
                          onChange={v => setIterText(i, v)}
                        />
                      </div>
                    )
                  ) : iter.textBefore && (
                    <div className="message-content selectable">
                      <ParsedContent text={iter.textBefore} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} mdComponents={mdComponents} workdir={workdir} />
                    </div>
                  )}
                  {iter.steps.length > 0 && (
                    <ToolChain steps={iter.steps} mode={toolOutputMode} isRunning={false} />
                  )}
                  {iter.steps.some(s => s.toolName === 'get_fast_context') && (() => {
                    const fcSaved = extractFastContextResult(iter.steps)
                    if (fcSaved) return <FastContextBlock result={fcSaved} />
                    return null
                  })()}
                  {/* Карточки саб-агентов для persisted-итерации — по одной на
                      каждый spawn_agent-вызов. agentId извлекается regex'ом из
                      парного tool_result (матчинг по callId, fallback —
                      ближайший результат после вызова). */}
                  {iter.steps
                    .filter(s => s.type === 'tool_call' && s.toolName === 'spawn_agent')
                    .map(callStep => {
                      const resultStep = iter.steps.find(r =>
                        r.type === 'tool_result' && r.toolName === 'spawn_agent' &&
                        (callStep.callId ? r.callId === callStep.callId : r.timestamp >= callStep.timestamp)
                      )
                      const agentIdMatch = resultStep?.content?.match(/\[AGENT:([^\]]+)\]/)
                      const agentId = agentIdMatch?.[1]
                      if (!agentId) return null
                      return (
                        <AgentCardLive
                          key={agentId}
                          agentId={agentId}
                          task={(callStep.toolArgs?.task as string) ?? ''}
                        />
                      )
                    })}
                  {/* Сгенерированные изображения внутри persisted-итерации */}
                  {iter.steps
                    .filter(s => s.type === 'tool_result' && s.imageUrl)
                    .map(s => (
                      <div key={s.id} className="message-image-wrap">
                        <img
                          src={`file://${s.imageUrl}`}
                          alt="Сгенерированное изображение"
                          className="message-image"
                          loading="lazy"
                          decoding="async"
                          onClick={() => window.open(`file://${s.imageUrl}`, '_blank')}
                        />
                      </div>
                    ))}
                </div>
              ))}
            </div>
          )
        })()}

        {/* Карточки саб-агентов — мемоизированные (spawnAgentCards) */}
        {!isUser && !liveIters?.length && spawnAgentCards.length > 0 && spawnAgentCards.map(card => (
          <AgentCardLive
            key={card.agentId}
            agentId={card.agentId}
            task={card.task}
          />
        ))}

        {/* Сгенерированные изображения из tool steps — мемоизированные */}
        {!isUser && !liveIters?.length && toolImages.map(s => (
          <div key={s.id} className="message-image-wrap">
            <img
              src={`file://${s.imageUrl}`}
              alt="Сгенерированное изображение"
              className="message-image"
              loading="lazy"
              decoding="async"
              onClick={() => window.open(`file://${s.imageUrl}`, '_blank')}
            />
          </div>
        ))}

        {/* Сгенерированное изображение */}
        {message.imageUrl && (
          <div className="message-image-wrap">
            <img
              src={message.imageUrl}
              alt="Generated"
              className="message-image"
              loading="lazy"
              decoding="async"
              onClick={() => window.open(message.imageUrl, '_blank')}
            />
          </div>
        )}

        {/* Thinking block — только для обычного чата (без итераций).
            В agent mode thinking рендерится внутри итераций и как liveThinking.
            Проверяем !iterations?.length чтобы не дублировать последний reasoning-блок,
            который уже отрендерен внутри итераций выше. */}
        {!isUser && !liveIters?.length && !(message as Message & { iterations?: unknown[] }).iterations?.length && (message.thinking || liveThinking) && (
          <ThinkingBlock
            text={message.thinking}
            liveText={liveThinking?.text}
            thinkingMs={message.thinkingMs ?? liveThinking?.ms}
            isLive={liveThinking?.isLive}
            storeChatId={liveThinking?.storeChatId}
          />
        )}

        {/* Индикатор ожидания — сразу при отправке и пока AI не начал писать */}
        {!isUser && (isStreaming || isWaiting) && !content && !liveThinking && !message.thinking && !liveIters?.length && (
                    <WaitingIndicator rateLimitSec={rateLimitSec} agentStatus={agentStatus} retry={retry} lastError={lastError} filesChanged={agentCounts.filesChanged} commandsRun={agentCounts.commandsRun} toolProgress={toolProgress} />
        )}

        {/* §4.3 — видимый чек-лист плана (todo list).
            Для сохранённого сообщения — message.todo (из БД).
            Для live-пузыря — liveTodo (пока стримится, до save). */}
        {!isUser && (() => {
          const todo = message.todo ?? liveTodo
          return todo && todo.length > 0 ? <TodoChecklist items={todo} /> : null
        })()}

        {/* ── ИТЕРАЦИОННЫЙ РЕНДЕР (live агент: textBefore → toolchain → textAfter) ── */}
        {!isUser && liveIters && liveIters.length > 0 ? (
          <div className="message-segments">
            {liveIters.map((iter, ii) => {
              const isLastIter = ii === liveIters.length - 1
              const lastStepIsResult = iter.steps[iter.steps.length - 1]?.type === 'tool_result'
              return (
                <div key={ii} className="message-segment">
                  {/* Thinking блок этой итерации — на своей позиции */}
                  {iter.thinking && (
                    <ThinkingBlock text={iter.thinking} thinkingMs={iter.thinkingMs} />
                  )}
                  {/* Текст ДО тулчейна */}
                  {iter.textBefore && (
                    <div className="message-content selectable">
                      <ParsedContent text={iter.textBefore} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} mdComponents={mdComponents} workdir={workdir} />
                    </div>
                  )}
                  {/* Тулчейн итерации */}
                  {iter.steps.length > 0 && (
                    <ToolChain
                      steps={iter.steps}
                      mode={toolOutputMode}
                      isRunning={!!isStreaming && isLastIter && !lastStepIsResult}
                      toolProgress={isLastIter ? toolProgress : undefined}
                    />
                  )}
                  {/* Fast Context блок — после toolchain, внутри итерации.
                      Позиция стабильна: стримящийся текст идёт ниже. */}
                  {iter.steps.some(s => s.toolName === 'get_fast_context') && (() => {
                    const fcLive = isStreaming && isLastIter ? toolProgress?.['get_fast_context'] : undefined
                    const isFcLive = fcLive && fcLive.stage !== 'done'
                    if (isFcLive) {
                      return <FastContextBlock result={{ files: [], summary: '', ms: 0, indexedFilesCount: 0 }} liveProgress={fcLive} />
                    }
                    const fcSaved = extractFastContextResult(iter.steps)
                    if (fcSaved) return <FastContextBlock result={fcSaved} />
                    return null
                  })()}
                  {/* Live-карточки саб-агентов — после toolchain, внутри итерации
                      (на той же позиции, что и FastContextBlock). Появляются
                      СРАЗУ при вызове spawn_agent: main эмитит agent:spawn ДО
                      запуска worker'а, renderer матчит по callId (или task как
                      fallback) с live-шагом tool_call spawn_agent. По одной
                      карточке на каждый spawn_agent-вызов (параллельные агенты).
                      При done карточка обновляется через agent:update. */}
                  {iter.steps
                    .filter(s => s.type === 'tool_call' && s.toolName === 'spawn_agent')
                    .map(callStep => {
                      const taskArg = callStep.toolArgs?.task as string | undefined
                      // Матчинг по callId (точный), fallback — по task
                      const spawned = spawnedAgents?.find(a => a.callId && a.callId === callStep.callId)
                        ?? spawnedAgents?.find(a => taskArg && a.task === taskArg)
                      if (!spawned) return null
                      return (
                        <AgentCardLive
                          key={spawned.agentId}
                          agentId={spawned.agentId}
                          task={taskArg ?? spawned.task}
                        />
                      )
                    })}
                  {/* Сгенерированные изображения внутри live-итерации */}
                  {iter.steps
                    .filter(s => s.type === 'tool_result' && s.imageUrl)
                    .map(s => (
                      <div key={s.id} className="message-image-wrap">
                        <img
                          src={`file://${s.imageUrl}`}
                          alt="Сгенерированное изображение"
                          className="message-image"
                          loading="lazy"
                          decoding="async"
                          onClick={() => window.open(`file://${s.imageUrl}`, '_blank')}
                        />
                      </div>
                    ))}
                  {/* Пульс после тулчейна пока AI думает (ждёт следующего токена) */}
                  {isStreaming && isLastIter && lastStepIsResult && !liveTextAfter && !liveThinking && (
          <WaitingIndicator rateLimitSec={rateLimitSec} agentStatus={agentStatus} retry={retry} lastError={lastError} filesChanged={agentCounts.filesChanged} commandsRun={agentCounts.commandsRun} />
                  )}
                </div>
              )
            })}
            {/* Live thinking — текущий стримящийся блок рассуждения,
                на позиции после последней итерации, перед текстом ответа.
                Условие: isLive (стрим идёт) или ms задан (thinking завершён,
                текст ещё в store до save). text убран из liveThinking —
                ThinkingBlock читает его из store через storeChatId. */}
            {liveThinking && (liveThinking.isLive || liveThinking.ms !== undefined) && (
              <ThinkingBlock
                liveText={liveThinking?.text}
                thinkingMs={liveThinking.ms}
                isLive={liveThinking.isLive}
                storeChatId={liveThinking.storeChatId}
              />
            )}
            {/* Текст ПОСЛЕ всех тулов (финальный ответ текущей итерации) */}
            {liveTextAfter && (
              <div className="message-content selectable">
                <ParsedContent text={liveTextAfter} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} isStreaming={isStreaming} mdComponents={mdComponents} workdir={workdir} />
              </div>
            )}
          </div>
        ) : (
          /* ── ОБЫЧНЫЙ РЕНДЕР (нет live итераций — обычный чат или финальное сообщение) ── */
          /* Если есть сохранённые iterations — content уже покрыт ими, не дублируем */
          (() => {
            type Iter = { label?: string; textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }
            const savedIters = (message as Message & { iterations?: Iter[] }).iterations
            // ── Реплай-цитаты: inline-чипы В ПОТОКЕ ТЕКСТА (как вложения) ──
            // Не отдельный блок над контентом — первые элементы текста,
            // теми же классами .inline-attach. title — полный текст исходника.
            const replyChips = isUser && message.replyTo?.length ? message.replyTo.map(r => {
              const quoteText = stripAttachTokens(r.content || '')
              const full = quoteText || (r.attachmentsCount ? `Сообщение с вложением (${r.attachmentsCount} файл.)` : 'Сообщение без текста')
              return (
                <span key={r.id} className="inline-attach inline-attach--reply" title={`Ответ на ${r.role === 'user' ? 'ваше сообщение' : 'сообщение Syntee'}:\n${full.slice(0, 500)}${full.length > 500 ? '…' : ''}`}>
                  <span className="inline-attach-icon">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 14 4 9 9 4" />
                      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                    </svg>
                  </span>
                  <span className="inline-attach-name">
                    <span className="inline-attach-reply-role">{r.role === 'user' ? 'Вы' : 'Syntee'}</span>
                    <span className="inline-attach-reply-sep"> · </span>
                    {quoteText.slice(0, 80) || (r.attachmentsCount ? `вложение ×${r.attachmentsCount}` : '')}
                    {quoteText.length > 80 ? '…' : ''}
                  </span>
                </span>
              )
            }) : null
            // ── Редактор чата: текст сообщения → textarea с черновиком ──
            // Для сообщений с iterations текст правится ПОСЕГМЕНТНО в блоке
            // рендера итераций выше (textarea на каждом textBefore) — здесь
            // отдельный textarea для content не нужен (content в UI не
            // рендерится при наличии итераций, пересобирается при apply).
            if (editorActive) {
              if (!isUser && savedIters?.length) return null
              return (
                <div className="message-content message-content--editing">
                  <EditorTextarea
                    value={editorDraft?.content ?? content}
                    onChange={v => updateEditorDraft(message.id, { content: v })}
                  />
                </div>
              )
            }
            if (!isUser && savedIters?.length) return null
            // ── User-сообщения с inline-токенами вложений [[attach:id]] ──
            // Чипы восстанавливаются НА СВОИХ МЕСТАХ в потоке текста (как в
            // инпут-баре). Markdown при наличии токенов игнорируем — чипы
            // важнее. Старый формат (attachments без токенов) — ветки ниже.
            if (isUser && hasAttachTokens(content)) {
              const attMap = new Map((message.attachments ?? []).map(a => [a.id, a] as const))
              return (
                <div className="message-content selectable">
                  <p style={{ whiteSpace: 'pre-wrap' }}>
                    {replyChips}
                    {splitByAttachTokens(content).map((seg, i) =>
                      seg.type === 'text' ? (
                        <React.Fragment key={i}>{renderClickablePlainText(seg.text, workdir, onOpenFile)}</React.Fragment>
                      ) : (
                        <React.Fragment key={i}>{renderAttachChip(attMap.get(seg.id), onPreviewAttachment)}</React.Fragment>
                      ),
                    )}
                  </p>
                </div>
              )
            }
            return (
              <div className="message-content selectable">
                {isUser && !userMarkdown ? (
                  <p style={{ whiteSpace: 'pre-wrap' }}>{replyChips}{renderClickablePlainText(content, workdir, onOpenFile)}</p>
                ) : isUser ? (
                  // User-сообщения с markdown: через ParsedContent (с кэшем)
                  // вместо прямого renderParsedSegments — консистентно с
                  // ассистентскими сообщениями и надёжнее.
                  <ParsedContent text={content} allowPlanCard={false} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} mdComponents={mdComponents} workdir={workdir} />
                ) : (
                  // Ассистентские сообщения — через ParsedContent с module-level
                  // кэшем: scroll-remount виртуализатора и hover (showActions)
                  // больше не ре-парсят markdown (0.3–0.5с фриз на большом сообщении).
                  // isStreaming: для live-пузыря без итераций — лёгкий рендер
                  // во время стрима, полный парс при done.
                  <ParsedContent text={content} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} isStreaming={isStreaming} mdComponents={mdComponents} workdir={workdir} />
                )}
              </div>
            )
          })()
        )}

        {/* Inline-вложения user-сообщения — ПОСЛЕ текста. ТОЛЬКО для старого
            формата (attachments без токенов в content): новые сообщения
            рендерят чипы на своих местах внутри текста (ветка выше).
            renderAttachChip — общий рендер: файлы → превью, chat/project →
            навигация (tabActions.selectChat). */}
        {isUser && message.attachments && message.attachments.length > 0 && !hasAttachTokens(content) && (
          <div className="message-inline-attachments">
            {message.attachments.map(att => (
              <React.Fragment key={att.id}>{renderAttachChip(att, onPreviewAttachment)}</React.Fragment>
            ))}
          </div>
        )}

        {/* Footer: кнопки действий + время + панель статистики */}
        <div className="message-footer">
          <div className="message-actions">
            {editorActive ? (
              <>
                {/* ── Контролы редактора чата ── */}
                <IconButton
                  icon={hiddenNow ? 'eye' : 'eyeOff'}
                  label={hiddenNow ? 'Вернуть в контекст' : 'Скрыть из контекста'}
                  className="msg-action-btn"
                  active={hiddenNow}
                  onClick={() => updateEditorDraft(message.id, { hidden: !hiddenNow })}
                />
                <IconButton
                  icon="trash"
                  label="Удалить навсегда"
                  className="msg-action-btn"
                  danger
                  onClick={() => updateEditorDraft(message.id, { deleted: true })}
                />
                {hasDraft && (
                  <IconButton
                    icon="rewind"
                    label="Отменить правки этого сообщения"
                    className="msg-action-btn"
                    onClick={() => clearEditorDraft(message.id)}
                  />
                )}
              </>
            ) : (
              <>
                <IconButton icon="copy" label="Копировать" className="msg-action-btn" onClick={onCopy} />
                <IconButton icon="pin" label="Закрепить" className="msg-action-btn" onClick={() => onPin?.(message.id)} />
                {onReply && <IconButton icon="reply" label="Ответить" className="msg-action-btn" onClick={onReply} />}
                {isUser && onRewind && <IconButton icon="rewind" label="Откатить к этому сообщению" className="msg-action-btn" onClick={onRewind} />}
                {!isUser && <IconButton icon="volume" label="Озвучить" className="msg-action-btn" onClick={onReadAloud} />}
                {/* Редактор чата: карандаш открывает режим inline-правки */}
                {editorAvailable && !isLiveBubble && (
                  <IconButton icon="edit" label="Редактировать сообщения чата" className="msg-action-btn" onClick={() => enterEditorMode(message.chatId)} />
                )}
                {/* Пункты контекстного меню от плагинов (registerContextMenu) */}
                <PluginMessageCtxMenu message={message} />
                {/* Кнопки-декорации от плагинов (registerContextMenu button) */}
                <PluginMessageButtons message={message} />
              </>
            )}
          </div>
          {(() => {
            const hasStats = !isUser && (
              message.durationMs != null || message.promptTokens != null ||
              message.completionTokens != null || message.toolCallsCount != null ||
              message.finishReason != null
            )
            const dur = message.durationMs
            const durStr = dur == null ? '' : formatDuration(dur)
            const fmtMs = (ms?: number) => (ms == null ? '' : formatDuration(ms))
            const totalTokens = (message.promptTokens ?? 0) + (message.completionTokens ?? 0)
            // Скорость генерации — из ЧИСТОГО времени стриминга (streamingMs,
            // без пауз на тулы и обработку промпта). Fallback на durationMs —
            // старые сообщения без streamingMs. Гард 500мс: на коротких
            // ответах стриминг слишком мал для осмысленной скорости.
            const speedBaseMs = (message.streamingMs != null && message.streamingMs >= 500)
              ? message.streamingMs
              : ((dur != null && dur >= 1000) ? dur : null)
            const speed = speedBaseMs != null && message.completionTokens != null
              ? message.completionTokens / (speedBaseMs / 1000)
              : null
            const finishLabel = message.finishReason === 'stopped'
              ? 'Остановлено вручную'
              : message.finishReason === 'error' ? 'Оборвано (ошибка)' : null
            const itersCount = (message as { iterations?: unknown[] }).iterations?.length ?? 0
            return (
              <>
                {hasStats && (
                  <button
                    type="button"
                    className={`message-stats-btn${statsOpen ? ' message-stats-btn--active' : ''}`}
                    onClick={() => setStatsOpen(v => !v)}
                    title="Статистика ответа"
                    aria-label="Статистика ответа"
                    aria-expanded={statsOpen}
                  >
                    <AppIcon name="info" size="xs" tone={statsOpen ? 'accent' : 'muted'} />
                  </button>
                )}
                {/* Бейдж «как завершился turn» — видно сразу в футере, без
                    разворачивания панели: ⏹ остановлено / ⚠ оборвано ошибкой. */}
                {!isUser && finishLabel && (
                  <span
                    className={`message-finish-badge message-finish-badge--${message.finishReason}`}
                    title={finishLabel}
                  >
                    {message.finishReason === 'stopped' ? '⏹ остановлено' : '⚠ оборвано'}
                  </span>
                )}
                {/* Скрыто из AI-контекста: бейдж с кликом «вернуть» (вне режима
                    редактора — мгновенная запись в БД + патч локального стора). */}
                {!editorActive && hiddenNow && (
                  <button
                    type="button"
                    className="message-hidden-badge"
                    title="AI это сообщение не видит. Клик — вернуть в контекст"
                    onClick={() => {
                      void window.syntee.chat.setMessageHidden(message.id, false)
                      patchMessage(message.id, { hiddenFromContext: 0 })
                    }}
                  >
                    <AppIcon name="eyeOff" size="xs" tone="muted" />
                    скрыто из контекста
                  </button>
                )}
                {timeEl}
                <AnimatePresence>
                  {statsOpen && hasStats && (
                    <motion.div
                      ref={statsPanelRef}
                      className={`message-stats-panel${statsBelow ? ' message-stats-panel--below' : ''}`}
                      initial={{ opacity: 0, y: 6, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 6, scale: 0.97 }}
                      transition={{ duration: 0.16, ease: 'easeOut' }}
                    >
                    {finishLabel && (
                      <div className={`message-stats-row message-stats-row--finish message-stats-row--finish-${message.finishReason}`}>
                        <AppIcon name={message.finishReason === 'stopped' ? 'pause' : 'alertTriangle'} size="xs" tone={message.finishReason === 'stopped' ? 'muted' : 'warning'} />
                        <span className="message-stats-label">Статус</span>
                        <span className="message-stats-value">{finishLabel}</span>
                      </div>
                    )}
                    {message.model && message.model !== 'error' && (
                      <div className="message-stats-row">
                        <AppIcon name="cpu" size="xs" tone="muted" />
                        <span className="message-stats-label">Модель</span>
                        <span className="message-stats-value">{message.model}</span>
                      </div>
                    )}
                    {durStr && (
                      <div className="message-stats-row" title={`Точно: ${formatTokensFull(Math.round((dur ?? 0) / 100) / 10)} с`}>
                        <AppIcon name="clock" size="xs" tone="muted" />
                        <span className="message-stats-label">Длительность</span>
                        <span className="message-stats-value">{durStr}</span>
                      </div>
                    )}
                    {message.promptTokens != null && (
                      <div className="message-stats-row" title={`Точно: ${formatTokensFull(message.promptTokens)} токенов`}>
                        <span className="message-stats-arrow message-stats-arrow--up">↑</span>
                        <span className="message-stats-label">Вход</span>
                        <span className="message-stats-value">{formatTokens(message.promptTokens)}</span>
                      </div>
                    )}
                    {message.completionTokens != null && (
                      <div className="message-stats-row" title={`Точно: ${formatTokensFull(message.completionTokens)} токенов`}>
                        <span className="message-stats-arrow message-stats-arrow--down">↓</span>
                        <span className="message-stats-label">Выход</span>
                        <span className="message-stats-value">{formatTokens(message.completionTokens)}</span>
                      </div>
                    )}
                    {totalTokens > 0 && (
                      <div className="message-stats-row" title={`Точно: ${formatTokensFull(totalTokens)} токенов`}>
                        <AppIcon name="layers" size="xs" tone="muted" />
                        <span className="message-stats-label">Всего</span>
                        <span className="message-stats-value">{formatTokens(totalTokens)}</span>
                      </div>
                    )}
                    {!!message.cacheReadTokens && (
                      <div className="message-stats-row" title={`Точно: ${formatTokensFull(message.cacheReadTokens)} токенов`}>
                        <span className="message-stats-arrow">≡</span>
                        <span className="message-stats-label">Кэш чтение</span>
                        <span className="message-stats-value">{formatTokens(message.cacheReadTokens)}</span>
                      </div>
                    )}
                    {!!message.cacheWriteTokens && (
                      <div className="message-stats-row" title={`Точно: ${formatTokensFull(message.cacheWriteTokens)} токенов`}>
                        <span className="message-stats-arrow">≡</span>
                        <span className="message-stats-label">Кэш запись</span>
                        <span className="message-stats-value">{formatTokens(message.cacheWriteTokens)}</span>
                      </div>
                    )}
                    {speed != null && speed > 0 && (
                      <div className="message-stats-row" title={`Точно: ${formatTokensFull(Math.round(speed))} токенов/с — по чистому времени генерации (${formatDuration(speedBaseMs ?? 0)})`}>
                        <AppIcon name="zap" size="xs" tone="muted" />
                        <span className="message-stats-label">Скорость</span>
                        <span className="message-stats-value">{speed >= 100 ? Math.round(speed) : speed.toFixed(1)} ток/с</span>
                      </div>
                    )}
                    {message.thinkingMs != null && message.thinkingMs > 0 && (
                      <div className="message-stats-row">
                        <AppIcon name="brain" size="xs" tone="muted" />
                        <span className="message-stats-label">Размышления</span>
                        <span className="message-stats-value">{fmtMs(message.thinkingMs)}</span>
                      </div>
                    )}
                    {itersCount > 1 && (
                      <div className="message-stats-row">
                        <AppIcon name="listChecks" size="xs" tone="muted" />
                        <span className="message-stats-label">Итерации</span>
                        <span className="message-stats-value">{itersCount}</span>
                      </div>
                    )}
                    {message.toolCallsCount != null && (
                      <div className="message-stats-row">
                        <AppIcon name="wrench" size="xs" tone="muted" />
                        <span className="message-stats-label">Вызовы тулов</span>
                        <span className="message-stats-value">{message.toolCallsCount}</span>
                      </div>
                    )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )
          })()}
        </div>
      </div>
    </div>
  )
})

// Аватар ассистента — несколько стилей
function AssistantAvatar({ style }: { style: AvatarStyle }) {
  if (style === 'none') return null
  if (style === 'circle') return (
    <div className="message-avatar message-avatar--circle"
      style={{
        width: 10, height: 10, borderRadius: '50%',
        background: 'var(--accent-bg)', opacity: 0.7,
      }}
    />
  )
  if (style === 'letter') return (
    <div className="message-avatar message-avatar--letter">S</div>
  )
  if (style === 'emoji') return (
    <div className="message-avatar message-avatar--emoji">🤖</div>
  )
  // hex (default)
  return (
    <div className="message-avatar">
      <Logo size={18} />
    </div>
  )
}


const MessageBubble = memo(function MessageBubble({
  message, onPin, onCopy, onReadAloud, onReply, onRewind, toolOutputMode = 'normal', searchQuery, liveThinking, isStreaming, isWaiting, rateLimitSec, shouldAnimate = true, workdir, editorAvailable = true,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'

  // ── Редактор чата: черновик этого сообщения (для корневых модификаторов) ──
  // deleted — сообщение схлопывается в полоску «будет удалено»; hidden —
  // затемнение + пунктир. Вне режима редактора — всегда undefined (stable).
  const editorDraft = useChatStore(s => (s.editorChatId === message.chatId ? s.editorDrafts[message.id] : undefined))
  const clearEditorDraft = useChatStore(s => s.clearEditorDraft)
  const editorDeleted = !!editorDraft?.deleted
  const contextHidden = editorDraft?.hidden !== undefined ? editorDraft.hidden : !!message.hiddenFromContext
  // Есть несохранённые правки (кроме удаления) → акцентная подсветка пузыря.
  const editorDraftDirty = !!editorDraft && !editorDraft.deleted

  // ── Live-текст из store: только для live-пузыря ──────────────────────
  // ChatPage больше не кладёт streamingText в displayMessages → memo
  // стабилен между 50мс-флашами → виртуализатор не инвалидирует кэш.
  // MessageBubble сам подписывается на live.text по message.chatId.
  // Для не-live: селектор возвращает undefined → '' → stable → 0 ре-рендеров.
  // Для live: селектор возвращает live.text → меняется 20×/сек →
  // MessageBubble ре-рендерится (только live-пузырь, остальные не затронуты).
  // Условие isLiveBubble (без isStreaming): после завершения стрима
  // live.text ещё не сброшен → текст виден до прихода реального сообщения.
  const isLiveBubble = message.id === 'live-streaming-bubble' || message.id === 'split-live-streaming-bubble'
  const liveText = useChatStore(s =>
    isLiveBubble && message.chatId
      ? s.liveByChat[message.chatId]?.text
      : undefined
  ) ?? ''
  // ── Live-state from store: only for live-bubble ─────────────────────
  // Раньше эти поля паковались в live-bubble объект через displayMessages
  // → displayMessages ре-вычислялся на каждый tool step / progress event →
  // виртуализатор инвалидировал кэш, другие ряды затрагивались. Теперь
  // MessageBubble сам подписывается на нужные поля store (как уже делал для
  // live.text). displayMessages стабилен между tool-событиями.
  const liveItersFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.iters : undefined
  )
  const liveTodoFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.todo : undefined
  )
  const agentStatusFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.agentStatus : undefined
  )
  const toolProgressFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.toolProgress : undefined
  )
  const spawnedAgentsFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.spawnedAgents : undefined
  )
  const retryFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.retry : undefined
  )
  const lastErrorFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.lastError : undefined
  )
  const liveStepsFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.steps : undefined
  )
  const effectiveContent = isLiveBubble ? (liveText || message.content) : message.content
  const effectiveLiveTextAfter = isLiveBubble
    ? liveText
    : (message as Message & { liveTextAfter?: string }).liveTextAfter

  // Превью вложения (модалка-лайтбокс)
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null)

  const handleCopy = useCallback(async () => {
    // Токены вложений → Markdown-ссылки НА СВОИХ МЕСТАХ в тексте
    let textToCopy = message.attachments?.length
      ? replaceAttachTokensWithLinks(effectiveContent, message.attachments)
      : effectiveContent
    if (message.attachments?.length) {
      // Старый формат: вложения без токенов в тексте — ссылками в конец
      const tokenIds = new Set(
        splitByAttachTokens(effectiveContent).filter(s => s.type === 'attach').map(s => s.id),
      )
      const legacy = message.attachments.filter(a => !tokenIds.has(a.id))
      if (legacy.length) {
        const md = attachmentsToMarkdown(legacy)
        if (md) textToCopy = textToCopy + '\n\n' + md
      }
    }
    const ok = await copyToClipboard(textToCopy)
    if (ok) onCopy?.(textToCopy)
  }, [effectiveContent, message.attachments, onCopy])

  const handleReply = useCallback(() => {
    onReply?.(message)
  }, [message, onReply])

  const handleRewind = useCallback(() => {
    onRewind?.(message.id)
  }, [message.id, onRewind])

  const handleReadAloud = useCallback(() => {
    onReadAloud?.(effectiveContent)
  }, [effectiveContent, onReadAloud])

  // Узкие селекторы вместо useUIStore() — иначе каждый пузырь ре-рендерится
  // при любом UI-изменении (agentPanelWidth, glassBlur, accentColor и т.д.).
  const msgAnim = useUIStore(s => s.msgAnim)
  const avatarStyle = useUIStore(s => s.avatarStyle)
  const showTime = useUIStore(s => s.showTime)
  const userMarkdown = useUIStore(s => s.userMarkdown)
  const anim = MSG_ANIM_VARIANTS[msgAnim] ?? MSG_ANIM_VARIANTS.slide

  // Очистка остаточного inline transform после entrance-анимации framer-motion.
  // framer-motion оставляет transform в inline-style (напр. translateX(0px))
  // даже после завершения entrance-анимации → .message-wrap промоутится в
  // постоянный GPU-композитный слой с текстурой размером с содержимое. Для
  // сообщения с развёрнутым PlanCard этот слой огромный (markdown 1500-3000px)
  // → compositor пересчитывает его каждый кадр скролла → просадки FPS. Очистка
  // transform:none схлопывает слой. Анимация появления не страдает: entrance
  // проигрывается до onAnimationComplete, после — transform не нужен.
  // Для scroll-remount (initial={false}, анимации нет) чистим сразу в rAF.
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (shouldAnimate) return
    const el = wrapRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => { el.style.transform = 'none' })
    return () => cancelAnimationFrame(raf)
  }, [shouldAnimate])
  const handleAnimComplete = useCallback(() => {
    const el = wrapRef.current
    if (el) el.style.transform = 'none'
  }, [])

  // Время — always / hover / never.
  // useMemo: timeEl стабилен между ре-рендерами (deps — showTime и
  // createdAt, оба стабильны для не-live) → MessageContent memo
  // не пробивается новым timeEl-референсом при скролл-ре-рендерах.
  const timeEl = useMemo(() => showTime !== 'never' ? (
    <span className={`message-time ${showTime === 'hover' ? 'message-time--hover' : ''}`}>
      {new Date(message.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
    </span>
  ) : null, [showTime, message.createdAt])

  // System-сообщения (откаты, сжатие контекста, системные уведомления)
  // рендерим как стилизованную разделительную полосу поперёк чата — не
  // как пузырь.
  if (message.role === 'system') {
    const isRewind = message.slashCommand?.name === 'rewind'
    const isCompact = message.slashCommand?.name === 'compact' && message.slashCommand?.args !== 'pending'
    const isCompacting = message.slashCommand?.name === 'compact' && message.slashCommand?.args === 'pending'
    // liveSummary — стримящееся резюме при manual /compact (токены приходят
    // через chat:compact-stream). Только у синтетического compacting-индикатора.
    const liveSummary = (message as Message & { compactLiveSummary?: string }).compactLiveSummary
    return <SystemDivider message={message} isRewind={isRewind} isCompact={isCompact} isCompacting={isCompacting} timeEl={timeEl} liveSummary={liveSummary} />
  }

  // ── Редактор чата: помеченное к удалению сообщение схлопывается в полоску.
  // Реальное удаление — при «Применить и закрыть» (applyEditorDrafts).
  if (editorDeleted) {
    return (
      <div className="message-wrap message-wrap--editor-deleted">
        <div className="message-editor-deleted-strip">
          <AppIcon name="trash" size="xs" tone="muted" />
          <span>Сообщение будет удалено</span>
          <button type="button" className="message-editor-restore-btn" onClick={() => clearEditorDraft(message.id)}>
            Вернуть
          </button>
        </div>
      </div>
    )
  }

  return (
    <motion.div
      className={`message-wrap ${isUser ? 'message-wrap--user' : 'message-wrap--assistant'} ${searchQuery ? 'message-wrap--search-match' : ''} ${contextHidden ? 'message-wrap--context-hidden' : ''} ${editorDraftDirty ? 'message-wrap--editor-draft' : ''}`}
      ref={wrapRef}
      // shouldAnimate=false → initial={false}: framer-motion сразу рисует в
      // финальном состоянии без проигрывания entrance. При scroll-remount того
      // же сообщения анимация не повторяется (убирает «плывущий» скролл).
      initial={shouldAnimate ? anim.initial : false}
      animate={anim.animate}
      transition={anim.transition}
      onAnimationComplete={handleAnimComplete}
    >
      {!isUser && <AssistantAvatar style={avatarStyle} />}

      {message.planData ? (
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <MessageContent
            content={effectiveContent}
            isUser={isUser}
            searchQuery={searchQuery}
            toolOutputMode={toolOutputMode}
            toolSteps={isLiveBubble ? (liveStepsFromStore as Message['toolSteps']) : message.toolSteps}
            onPin={onPin}
            onCopy={handleCopy}
            onReadAloud={handleReadAloud}
            onReply={handleReply}
            onRewind={handleRewind}
            message={message}
            isPinned={message.isPinned as number}
            createdAt={message.createdAt}
            liveThinking={liveThinking}
            isStreaming={isStreaming}
            isWaiting={isWaiting}
            liveIters={liveItersFromStore}
            liveTodo={liveTodoFromStore}
            liveTextAfter={effectiveLiveTextAfter}
            rateLimitSec={rateLimitSec}
            userMarkdown={isUser ? userMarkdown : true}
            timeEl={timeEl}
            agentStatus={agentStatusFromStore}
            retry={retryFromStore}
            lastError={lastErrorFromStore}
            toolProgress={toolProgressFromStore}
            spawnedAgents={spawnedAgentsFromStore}
            onPreviewAttachment={setPreviewAttachment}
            workdir={workdir}
            editorAvailable={editorAvailable}
          />
        </div>
      ) : (
      <MessageContent
        content={effectiveContent}
        isUser={isUser}
        searchQuery={searchQuery}
        toolOutputMode={toolOutputMode}
        toolSteps={isLiveBubble ? (liveStepsFromStore as Message['toolSteps']) : message.toolSteps}
        onPin={onPin}
        onCopy={handleCopy}
        onReadAloud={handleReadAloud}
        onReply={handleReply}
        onRewind={handleRewind}
        message={message}
        isPinned={message.isPinned as number}
        createdAt={message.createdAt}
        liveThinking={liveThinking}
        isStreaming={isStreaming}
        isWaiting={isWaiting}
        liveIters={liveItersFromStore}
        liveTodo={liveTodoFromStore}
        liveTextAfter={effectiveLiveTextAfter}
        rateLimitSec={rateLimitSec}
        userMarkdown={isUser ? userMarkdown : true}
        timeEl={timeEl}
        agentStatus={agentStatusFromStore}
        retry={retryFromStore}
        lastError={lastErrorFromStore}
        toolProgress={toolProgressFromStore}
        spawnedAgents={spawnedAgentsFromStore}
        onPreviewAttachment={setPreviewAttachment}
        workdir={workdir}
        editorAvailable={editorAvailable}
      />
      )}

      {/* Модалка превью вложения — лайтбокс для картинок, CodePreview для файлов.
          key={id} — перемонтирует компонент при смене вложения, сбрасывая zoom/pan. */}
      <AttachmentPreviewModal
        key={previewAttachment?.id ?? 'none'}
        attachment={previewAttachment}
        onClose={() => setPreviewAttachment(null)}
      />
    </motion.div>
  )
})

export default MessageBubble

