import { useState, useMemo, memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
// PrismLight вместо полного Prism: регистрируем только нужные языки, а не
// все ~270 грамматик. Подсветка идентична, но бандл меньше и каждый вызов
// ре-токенизации кода (в т.ч. при стриминге) дешевле.
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import shell from 'react-syntax-highlighter/dist/esm/languages/prism/shell-session'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import html from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp'
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import diffLang from 'react-syntax-highlighter/dist/esm/languages/prism/diff'

SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('ts', typescript)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('js', javascript)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('py', python)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('sh', bash)
SyntaxHighlighter.registerLanguage('shell', shell)
SyntaxHighlighter.registerLanguage('console', shell)
SyntaxHighlighter.registerLanguage('sql', sql)
SyntaxHighlighter.registerLanguage('go', go)
SyntaxHighlighter.registerLanguage('rust', rust)
SyntaxHighlighter.registerLanguage('rs', rust)
SyntaxHighlighter.registerLanguage('yaml', yaml)
SyntaxHighlighter.registerLanguage('yml', yaml)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('md', markdown)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('html', html)
SyntaxHighlighter.registerLanguage('xml', html)
SyntaxHighlighter.registerLanguage('markup', html)
SyntaxHighlighter.registerLanguage('java', java)
SyntaxHighlighter.registerLanguage('c', c)
SyntaxHighlighter.registerLanguage('cpp', cpp)
SyntaxHighlighter.registerLanguage('c++', cpp)
SyntaxHighlighter.registerLanguage('csharp', csharp)
SyntaxHighlighter.registerLanguage('cs', csharp)
SyntaxHighlighter.registerLanguage('php', php)
SyntaxHighlighter.registerLanguage('ruby', ruby)
SyntaxHighlighter.registerLanguage('rb', ruby)
SyntaxHighlighter.registerLanguage('diff', diffLang)
import PlanCard from '../PlanCard/PlanCard'
import Logo from '../Logo/Logo'
import AttachmentChips from '../AttachmentChips/AttachmentChips'
import AttachmentProcessingBlock from '../AttachmentProcessingBlock/AttachmentProcessingBlock'
import type { Message, ToolOutputMode } from '../../../../../shared/types'
import { extractPlanSegments } from '../../../../../shared/planParser'
import AppIcon from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
import ToolChain from '../ToolChain/ToolChain'
import TodoChecklist from '../TodoChecklist/TodoChecklist'
import FastContextBlock, { type FastContextResultData } from '../FastContextBlock/FastContextBlock'
import AgentCard from '../AgentCard/AgentCard'
import MermaidBlock from './MermaidBlock'
import ThinkingBlock from '../ThinkingBlock/ThinkingBlock'
import { useUIStore, type AvatarStyle } from '../../../store/ui.store'
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
    initial: { opacity: 0, y: 32, filter: 'blur(6px)' },
    animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
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
  liveThinking?: { text: string; isLive: boolean; ms?: number }
  isStreaming?: boolean
  isWaiting?: boolean
  rateLimitSec?: number
  /** Проигрывать ли entrance-анимацию. true только при первом монтировании
   * сообщения; false при scroll-remount того же сообщения виртуализатором,
   * иначе анимация повторяется при каждом скролле → «интерфейс плывёт». */
  shouldAnimate?: boolean
}

const codeStyle = {
  ...oneDark,
  'pre[class*="language-"]': {
    ...((oneDark as Record<string, React.CSSProperties>)['pre[class*="language-"]'] || {}),
    margin: 0, padding: '14px 16px', background: '#0d0d0f',
    borderRadius: '0 0 8px 8px', fontSize: '13px', lineHeight: '1.6',
  },
  'code[class*="language-"]': {
    ...((oneDark as Record<string, React.CSSProperties>)['code[class*="language-"]'] || {}),
    background: 'transparent', fontSize: '13px',
  },
}

// Memoized code highlighter — не ре-хайлайтит блок при смене copiedBlock или стриминге
const CodeHighlighter = memo(function CodeHighlighter({ raw, lang }: { raw: string; lang: string }) {
  return (
    <SyntaxHighlighter
      style={codeStyle as Record<string, React.CSSProperties>}
      language={lang} PreTag="div"
      showLineNumbers={raw.split('\n').length > 4}
      lineNumberStyle={{ color: '#4a4a5a', fontSize: '11px', minWidth: '2.5em' }}
      wrapLongLines={false}
    >
      {raw}
    </SyntaxHighlighter>
  )
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
      onClick={() => {
        navigator.clipboard.writeText(raw)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? '✓ Скопировано' : 'Копировать'}
    </button>
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
    if (parseContentCache.size > 500) evictOldest(parseContentCache, 375)
    parseContentCache.set(key, segs)
  }
  return segs
}

function parseContent(raw: string, allowPlanCard = false): Array<{ type: 'md' | 'admonition' | 'plan'; content: string; kind?: string; title?: string; summary?: string; partial?: boolean }> {
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

// ── renderParsedSegments: рендер массива сегментов из parseContent ─────────
// Переиспользуется в 4 местах (основной рендер, iterations, liveTextAfter).
// Использует module-level mdComponents (стабилен). plan-сегменты рендерятся
// в PlanCard (live во время стрима — partial=true, после — с filePath).
function renderParsedSegments(
  segs: ReturnType<typeof parseContent>,
  remarkPlugins: readonly unknown[],
  rehypePlugins: readonly unknown[],
  planFilePath?: string,
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
          <ReactMarkdown remarkPlugins={remarkPlugins as never} rehypePlugins={rehypePlugins as never}>{s.content}</ReactMarkdown>
        </AdmonitionBlock>
      )
    }
    return (
      <ReactMarkdown
        key={`md-${i}`}
        remarkPlugins={remarkPlugins as never}
        rehypePlugins={rehypePlugins as never}
        components={mdComponents as never}
      >
        {s.content}
      </ReactMarkdown>
    )
  })
}

// ── Module-level mdComponents: единый стабильный объект для всех экземпляров
// MessageContent. Компоненты (CodeHighlighter/MermaidBlock/DiffBlock/CopyButton)
// module-level и не имеют instance-state → mdComponents можно поднять наверх.
// Это даёт две выгоды: (1) стабилен навсегда — не пересоздаётся, ре-парс не
// срабатывает при копировании; (2) позволяет кэшировать ReactNode-дерево
// ParsedContent по text безопасно (компоненты те же во всех экземплярах).
const mdComponents: Record<string, unknown> = {
  code({ className, children }: { className?: string; children?: React.ReactNode }) {
    const match = /language-(\w+)/.exec(className || '')
    const raw = String(children).replace(/\n$/, '')
    const isInline = !match && !raw.includes('\n')
    if (isInline) return <code className="inline-code">{children}</code>
    const lang = match?.[1] || 'text'
    if (lang === 'mermaid') return <MermaidBlock code={raw} />
    if (lang === 'diff') return <DiffBlock code={raw} />
    return (
      <div className="code-block">
        <div className="code-block-header">
          <span className="code-lang">{lang.toUpperCase()}</span>
          <CopyButton raw={raw} />
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
  a({ href, children }: { href?: string; children?: React.ReactNode }) { return <a href={href} className="md-link" target="_blank" rel="noreferrer">{children}</a> },
  hr() { return <hr className="md-hr" /> },
  p({ children }: { children?: React.ReactNode }) { return <p>{children}</p> },
}

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
  text, allowPlanCard, remarkPlugins, rehypePlugins, planFilePath,
}: {
  text: string
  allowPlanCard: boolean
  remarkPlugins: readonly unknown[]
  rehypePlugins: readonly unknown[]
  planFilePath?: string
}) {
  const segs = useMemo(() => parseContentCached(text, allowPlanCard), [text, allowPlanCard])
  // Ключ кэша: text + allowPlanCard + идентитеты плагинов (стабильные массивы
  // из useMemo). planFilePath влияет на PlanCard filePath → включаем.
  const cacheKey = text + '|' + (allowPlanCard ? '1' : '0')
    + '|' + (remarkPlugins === undefined ? '' : remarkPlugins.length)
    + '|' + (rehypePlugins === undefined ? '' : rehypePlugins.length)
    + '|' + (planFilePath ?? '')
  let node = parsedRenderCache.get(cacheKey)
  if (!node) {
    node = renderParsedSegments(segs, remarkPlugins, rehypePlugins, planFilePath)
    if (parsedRenderCache.size > 400) evictOldest(parsedRenderCache, 300)
    parsedRenderCache.set(cacheKey, node)
  }
  return <>{node}</>
}, (prev, next) =>
  prev.text === next.text &&
  prev.allowPlanCard === next.allowPlanCard &&
  prev.remarkPlugins === next.remarkPlugins &&
  prev.rehypePlugins === next.rehypePlugins &&
  prev.planFilePath === next.planFilePath
)

// ── AgentCardLive — живая карточка суб-агента в чате ─────────────────────
type AgentCardData = {
  id: string; status: string; model: string; steps: unknown[]
  summary: string; error?: string; createdAt: number; finishedAt?: number
}
// Module-level кэш: виртуализатор монтирует/демонтирует сообщения при
// скролле — без кэша каждый remount карточки дёргал IPC agent.get.
// Обновления приходят через agent:update (кэш актуализируется событием).
const agentCardCache = new Map<string, AgentCardData>()

function AgentCardLive({ agentId, task }: {
  agentId: string
  task: string
}) {
  const [agent, setAgent] = useState<AgentCardData | null>(() => agentCardCache.get(agentId) ?? null)

  useEffect(() => {
    // IPC только при cache-miss — scroll-remount не дёргает main повторно.
    if (!agentCardCache.has(agentId)) {
      window.syntee.agent.get(agentId).then((a: unknown) => {
        if (a) {
          if (agentCardCache.size > 200) evictOldest(agentCardCache, 150)
          agentCardCache.set(agentId, a as AgentCardData)
          setAgent(a as never)
        }
      })
    }
    const off = window.syntee.on('agent:update', (updated: { id: string } & Record<string, unknown>) => {
      if (updated.id === agentId) {
        agentCardCache.set(agentId, updated as AgentCardData)
        setAgent(updated as never)
      }
    })
    return () => off()
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
      }}
      onClick={() => {
        window.syntee.on('agent:focus', agentId as never)
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

function WaitingIndicator({ rateLimitSec, agentStatus, retry, lastError, filesChanged, commandsRun }: {
  rateLimitSec?: number
  agentStatus?: string | null
  retry?: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null
  lastError?: string | null
  filesChanged?: number
  commandsRun?: number
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
  // Приоритет: rate-limit (секундный таймер) > retry (структурированный
  // счётчик «повтор 3/5») > lastError (причина без счётчика) > agentStatus
  // (свободный текст) > generic фраза.
  let text: string
  let cls: string
  if (isRateLimit) {
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

/** Извлекает результат get_fast_context из steps итерации. */
function extractFastContextResult(steps: Array<{ type: string; toolName?: string; content?: string }>): FastContextResultData | null {
  for (const s of steps) {
    if (s.type === 'tool_result' && s.toolName === 'get_fast_context' && s.content) {
      try {
        const parsed = JSON.parse(s.content) as FastContextResultData
        if (parsed && Array.isArray(parsed.files)) return parsed
      } catch { /* skip */ }
    }
  }
  return null
}

// Мемоизированный тяжёлый контент сообщения
const MessageContent = memo(function MessageContent({
  content, isUser, searchQuery, toolOutputMode, toolSteps,
  onPin, onCopy, onReadAloud, onReply, onRewind, message, isPinned, createdAt,
  liveThinking, isStreaming, isWaiting, liveIters, liveTextAfter, rateLimitSec,
  userMarkdown = true, timeEl, agentStatus, toolProgress, retry, lastError,
}: {
  content: string; isUser: boolean; searchQuery?: string
  toolOutputMode: ToolOutputMode; toolSteps?: Message['toolSteps']
  onPin?: (id: string) => void; onCopy?: () => void
  onReadAloud?: () => void; onReply?: () => void
  onRewind?: () => void
  message: Message; isPinned: number; createdAt: number
  liveThinking?: { text: string; isLive: boolean; ms?: number }
  isStreaming?: boolean
  isWaiting?: boolean
  liveIters?: Array<{ textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }>
  liveTextAfter?: string
  rateLimitSec?: number
  userMarkdown?: boolean
  timeEl?: React.ReactNode
  agentStatus?: string | null
  retry?: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null
  lastError?: string | null
  toolProgress?: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
}) {
  const [showActions, setShowActions] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  // Если панель статистики не влезает сверху (сообщение в самом верху чата) —
  // показываем снизу от footer.
  const [statsBelow, setStatsBelow] = useState(false)
  // Координаты popup-действий когда bubble длиннее viewport: переключаемся в
  // position: fixed и держим popup в центре видимой части bubble (там, где
  // пользователь смотрит). null — обычное flex-центрирование (bubble влезает).
  const [actionsPos, setActionsPos] = useState<{ top: number; left: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const statsPanelRef = useRef<HTMLDivElement>(null)

  // Sticky-кламп popup-действий. CSS position: sticky не работает: motion.div
  // (.message-wrap) оставляет transform в inline-style после entrance-анимации
  // → sticky позиционируется относительно transformed ancestor (одна строка
  // чата), а не scroll-container'а (.chat-messages). Поэтому делаем через JS:
  // измеряем bubble при hover, если он длиннее/выше viewport — fixed'им popup
  // в центр видимой части. Пересчёт по scroll/resize.
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!showActions) { setActionsPos(null); return }
    const wrap = wrapRef.current
    if (!wrap) return
    const bubble = wrap.querySelector<HTMLElement>('.message-bubble')
    const popup = actionsRef.current
    if (!bubble || !popup) return

    const recompute = () => {
      const b = bubble.getBoundingClientRect()
      const vh = window.innerHeight
      // Bubble полностью в viewport — absolute-центрирование (top:50%/translateY) работает.
      if (b.top >= 0 && b.bottom <= vh) { setActionsPos(null); return }
      // Bubble полностью вне viewport — popup не нужен (скрыт через opacity).
      if (b.bottom < 0 || b.top > vh) { setActionsPos(null); return }
      // Частично виден — fixed в центр видимой части (через портал в body,
      // иначе transform на motion.div(.message-wrap) делает containing block
      // для fixed = этот wrap, и координаты двоятся → popup улетает сбоку).
      const visTop = Math.max(b.top, 0)
      const visBot = Math.min(b.bottom, vh)
      const centerY = (visTop + visBot) / 2
      const popupW = popup.offsetWidth || 32
      const popupH = popup.offsetHeight || 0
      // Клампим top в viewport: не даём popup уйти выше/ниже экрана.
      const top = Math.max(8, Math.min(centerY - popupH / 2, vh - popupH - 8))
      let left: number
      if (isUser) {
        // User: popup слева от bubble.
        left = b.left - popupW - 6
      } else {
        // Assistant: popup справа от bubble.
        left = b.right + 6
      }
      // Не даём уйти за правый/левый край экрана.
      left = Math.max(6, Math.min(left, window.innerWidth - popupW - 6))
      setActionsPos({ top, left })
    }
    // rAF-throttle: scroll-events на 144Гц идут очень часто; без throttle
    // recompute() звал getBoundingClientRect()+offsetWidth/Height (sync
    // reflow) на КАЖДОМ scroll-event → микро-фризы при скролле над пузырём
    // (в т.ч. над планом). С rAF — коалесинг множественных events в один
    // reflow за кадр (≤1 sync reflow/frame вместо ~N/сек).
    let rafId = 0
    let scheduled = false
    const scheduleRecompute = () => {
      if (scheduled) return
      scheduled = true
      rafId = requestAnimationFrame(() => { scheduled = false; recompute() })
    }
    recompute()
    // Слушаем scroll на ближайшем scroll-container (.chat-messages) и resize.
    const scroller = wrap.closest('.chat-messages') ?? window
    scroller.addEventListener('scroll', scheduleRecompute, true)
    window.addEventListener('resize', scheduleRecompute)
    return () => {
      cancelAnimationFrame(rafId)
      scroller.removeEventListener('scroll', scheduleRecompute, true)
      window.removeEventListener('resize', scheduleRecompute)
    }
  }, [showActions, isUser])

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
  useLayoutEffect(() => {
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

  const segments = useMemo(() =>
    isUser && !userMarkdown
      ? [{ type: 'plain' as const, content }]
      : isUser
        ? [{ type: 'md' as const, content }]
        : parseContentCached(content, allowPlanCard),
    [content, isUser, userMarkdown, allowPlanCard]
  )

  // Живой счётчик (§4.2): N файлов изменено · M команд выполнено
  const agentCounts = useMemo(() => {
    if (!toolSteps) return { filesChanged: 0, commandsRun: 0 }
    const filesChanged = toolSteps.filter(s =>
      s.type === 'tool_result' && s.success &&
      ['write_file', 'edit_file', 'multi_edit_file'].includes(s.toolName || '')
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
  const hasMath = useMemo(() => /\$/.test(content), [content])
  const streamingRemark = useMemo(() => [remarkGfm], [])
  const fullRemark = useMemo(() => hasMath ? [remarkGfm, remarkMath] : [remarkGfm], [hasMath])
  const emptyRehype = useMemo<readonly unknown[]>(() => [], [])
  const fullRehype = useMemo(() => hasMath ? [rehypeKatex] : emptyRehype, [hasMath, emptyRehype])
  const remarkPlugins = isStreaming ? streamingRemark : fullRemark
  const rehypePlugins = isStreaming ? emptyRehype : fullRehype

  const handleMouseEnter = useCallback(() => setShowActions(true), [])
  const handleMouseLeave = useCallback(() => setShowActions(false), [])

  return (
    <div
      ref={wrapRef}
      className="message-bubble-wrap"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
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

        {/* Чипы прикреплённых файлов/изображений — над текстом user-сообщения.
            Показываем только для user-роли и когда есть attachments. read-only
            — это уже отправленное сообщение, кнопка удаления скрыта. */}
        {isUser && message.attachments && message.attachments.length > 0 && (
          <AttachmentChips attachments={message.attachments} onRemove={() => {}} max={10} readOnly />
        )}

        {(message as Message & { replyTo?: { role: string; content: string } }).replyTo && (
          <div className="message-reply-quote">
            <span className="message-reply-role">
              {(message as Message & { replyTo?: { role: string; content: string } }).replyTo!.role === 'user' ? 'Вы' : 'Syntee'}
            </span>
            <span className="message-reply-text">
              {(message as Message & { replyTo?: { role: string; content: string } }).replyTo!.content.slice(0, 120)}
              {(message as Message & { replyTo?: { role: string; content: string } }).replyTo!.content.length > 120 ? '…' : ''}
            </span>
          </div>
        )}

        {!isUser && toolSteps && toolSteps.length > 0 && !liveIters?.length && !(message as Message & { iterations?: unknown[] }).iterations?.length && (
          <ToolChain steps={toolSteps} mode={toolOutputMode} isRunning={false} />
        )}

        {/* Финальный рендер итераций из БД — точно как live, каждая итерация отдельно */}
        {!isUser && !liveIters?.length && (() => {
          type Iter = { label?: string; textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }
          const iters = (message as Message & { iterations?: Iter[] }).iterations
          if (!iters?.length) return null
          return (
            <div className="message-iters">
              {iters.map((iter, i) => (
                <div key={i} className="message-iteration">
                  {iter.thinking && (
                    <ThinkingBlock text={iter.thinking} thinkingMs={iter.thinkingMs} />
                  )}
                  {iter.textBefore && (
                    <div className="message-content selectable">
                      <ParsedContent text={iter.textBefore} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} />
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
                </div>
              ))}
            </div>
          )
        })()}

        {/* Карточки суб-агентов */}
        {!isUser && toolSteps && !liveIters?.length && toolSteps
          .filter(s => s.type === 'tool_call' && s.toolName === 'spawn_agent')
          .map(s => {
            // Ищем соответствующий tool_result чтобы получить agentId
            const resultStep = toolSteps.find(r =>
              r.type === 'tool_result' && r.toolName === 'spawn_agent' &&
              r.timestamp >= s.timestamp
            )
            const agentIdMatch = resultStep?.content?.match(/\[AGENT:([^\]]+)\]/)
            const agentId = agentIdMatch?.[1]
            if (!agentId) return null
            return (
              <AgentCardLive
                key={agentId}
                agentId={agentId}
                task={(s.toolArgs?.task as string) ?? ''}
              />
            )
          })
        }

        {/* Сгенерированные изображения из tool steps — показываем прямо в чате */}
        {!isUser && toolSteps && !liveIters?.length && toolSteps
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
          ))
        }

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
          />
        )}

        {/* Индикатор ожидания — сразу при отправке и пока AI не начал писать */}
        {!isUser && (isStreaming || isWaiting) && !content && !liveThinking && !message.thinking && !liveIters?.length && (
                    <WaitingIndicator rateLimitSec={rateLimitSec} agentStatus={agentStatus} retry={retry} lastError={lastError} filesChanged={agentCounts.filesChanged} commandsRun={agentCounts.commandsRun} />
        )}

        {/* §4.3 — видимый чек-лист плана (todo list).
            Для сохранённого сообщения — message.todo (из БД).
            Для live-пузыря — liveTodo (пока стримится, до save). */}
        {!isUser && (() => {
          type TodoItem = { text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }
          const liveTodo = (message as Message & { liveTodo?: TodoItem[] }).liveTodo
          const todo = message.todo ?? liveTodo
          return todo && todo.length > 0 ? <TodoChecklist items={todo} /> : null
        })()}

        {/* AttachmentProcessingBlock — блок обработки вложений.
            Live: toolProgress['process_attachments'] — стрим идёт из
            processAttachmentsAndStream (main) ДО старта воркера и во время
            стриминга токенов. Показывает stages roadmap + прогресс-бар.
            Пока stage !== 'done' — активная обработка (spinner + shimmer).
            Когда stage === 'done' — обработка завершена, но стрим токенов
            может ещё идти — показываем roadmap "всё готово" (без file list).
            Persisted: message.attachmentResult (сохранено в БД на assistant-
            сообщении) — финальный список файлов с описаниями. */}
        {!isUser && (() => {
          const liveAp = toolProgress?.['process_attachments']
          if (liveAp) {
            return (
              <AttachmentProcessingBlock
                result={message.attachmentResult ?? { files: [], totalProcessed: 0, totalErrors: 0, totalImages: 0, ms: 0, hasErrors: false }}
                liveProgress={liveAp}
              />
            )
          }
          if (message.attachmentResult) {
            return <AttachmentProcessingBlock result={message.attachmentResult} />
          }
          return null
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
                      <ParsedContent text={iter.textBefore} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} />
                    </div>
                  )}
                  {/* Тулчейн итерации */}
                  {iter.steps.length > 0 && (
                    <ToolChain
                      steps={iter.steps}
                      mode={toolOutputMode}
                      isRunning={!!isStreaming && isLastIter && !lastStepIsResult}
                      toolProgress={toolProgress}
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
                  {/* Пульс после тулчейна пока AI думает (ждёт следующего токена) */}
                  {isStreaming && isLastIter && lastStepIsResult && !liveTextAfter && !liveThinking && (
          <WaitingIndicator rateLimitSec={rateLimitSec} agentStatus={agentStatus} retry={retry} lastError={lastError} filesChanged={agentCounts.filesChanged} commandsRun={agentCounts.commandsRun} />
                  )}
                </div>
              )
            })}
            {/* Live thinking — текущий стримящийся блок рассуждения,
                на позиции после последней итерации, перед текстом ответа */}
            {liveThinking && (liveThinking.text || liveThinking.isLive) && (
              <ThinkingBlock
                liveText={liveThinking.text}
                thinkingMs={liveThinking.ms}
                isLive={liveThinking.isLive}
              />
            )}
            {/* Текст ПОСЛЕ всех тулов (финальный ответ текущей итерации) */}
            {liveTextAfter && (
              <div className="message-content selectable">
                <ParsedContent text={liveTextAfter} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} />
              </div>
            )}
          </div>
        ) : (
          /* ── ОБЫЧНЫЙ РЕНДЕР (нет live итераций — обычный чат или финальное сообщение) ── */
          /* Если есть сохранённые iterations — content уже покрыт ими, не дублируем */
          (() => {
            type Iter = { label?: string; textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }
            const savedIters = (message as Message & { iterations?: Iter[] }).iterations
            if (!isUser && savedIters?.length) return null
            return (
              <div className="message-content selectable">
                {isUser && !userMarkdown ? (
                  <p>{content}</p>
                ) : isUser ? (
                  // User-сообщения: один md-сегмент, парсинг admonition/plan не нужен.
                  renderParsedSegments(segments as ReturnType<typeof parseContent>, remarkPlugins, rehypePlugins, message.planData?.filePath)
                ) : (
                  // Ассистентские сообщения — через ParsedContent с module-level
                  // кэшем: scroll-remount виртуализатора и hover (showActions)
                  // больше не ре-парсят markdown (0.3–0.5с фриз на большом сообщении).
                  <ParsedContent text={content} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} />
                )}
              </div>
            )
          })()
        )}

        {(() => {
          // Статистика ответа — только для assistant-сообщений с данными.
          const hasStats = !isUser && (
            message.durationMs != null || message.promptTokens != null ||
            message.completionTokens != null || message.toolCallsCount != null
          )
          const dur = message.durationMs
          const durStr = dur == null ? '' : dur < 1000 ? `${dur} мс` : `${(dur / 1000).toFixed(dur < 10000 ? 1 : 0)} с`
          return (
            <div className="message-footer">
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
                    {durStr && (
                      <div className="message-stats-row">
                        <AppIcon name="clock" size="xs" tone="muted" />
                        <span className="message-stats-label">Длительность</span>
                        <span className="message-stats-value">{durStr}</span>
                      </div>
                    )}
                    {message.promptTokens != null && (
                      <div className="message-stats-row">
                        <span className="message-stats-arrow message-stats-arrow--up">↑</span>
                        <span className="message-stats-label">Вход</span>
                        <span className="message-stats-value">{message.promptTokens.toLocaleString('ru')}</span>
                      </div>
                    )}
                    {message.completionTokens != null && (
                      <div className="message-stats-row">
                        <span className="message-stats-arrow message-stats-arrow--down">↓</span>
                        <span className="message-stats-label">Выход</span>
                        <span className="message-stats-value">{message.completionTokens.toLocaleString('ru')}</span>
                      </div>
                    )}
                    {!!message.cacheReadTokens && (
                      <div className="message-stats-row">
                        <span className="message-stats-arrow">≡</span>
                        <span className="message-stats-label">Кэш чтение</span>
                        <span className="message-stats-value">{message.cacheReadTokens.toLocaleString('ru')}</span>
                      </div>
                    )}
                    {!!message.cacheWriteTokens && (
                      <div className="message-stats-row">
                        <span className="message-stats-arrow">≡</span>
                        <span className="message-stats-label">Кэш запись</span>
                        <span className="message-stats-value">{message.cacheWriteTokens.toLocaleString('ru')}</span>
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
            </div>
          )
        })()}
      </div>

      {/* Popup-действия. В обычном режиме (bubble влезает в viewport) — absolute
          в wrap, центрирован по высоте bubble. Если bubble длиннее viewport —
          такая же копия рендерится через портал в body с position: fixed, чтобы
          держаться в центре видимой части. Портал необходим: motion.div
          (.message-wrap) оставляет transform → fixed без портала позиционируется
          относительно transformed ancestor и координаты двоятся. */}
      <div
        ref={actionsRef}
        className="message-actions"
        style={{
          opacity: showActions && !actionsPos ? 1 : 0,
          pointerEvents: showActions && !actionsPos ? 'all' : 'none',
          transition: 'opacity 0.12s',
        }}
      >
        <IconButton icon="copy" label="Копировать" className="msg-action-btn" onClick={onCopy} />
        <IconButton icon="pin" label="Закрепить" className="msg-action-btn" onClick={() => onPin?.(message.id)} />
        {onReply && <IconButton icon="reply" label="Ответить" className="msg-action-btn" onClick={onReply} />}
        {isUser && onRewind && <IconButton icon="rewind" label="Откатить к этому сообщению" className="msg-action-btn" onClick={onRewind} />}
        {!isUser && <IconButton icon="volume" label="Озвучить" className="msg-action-btn" onClick={onReadAloud} />}
      </div>
      {showActions && actionsPos && createPortal(
        <motion.div
          className="message-actions message-actions--fixed"
          style={{ position: 'fixed', top: actionsPos.top, left: actionsPos.left, opacity: 1, pointerEvents: 'all' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          <IconButton icon="copy" label="Копировать" className="msg-action-btn" onClick={onCopy} />
          <IconButton icon="pin" label="Закрепить" className="msg-action-btn" onClick={() => onPin?.(message.id)} />
          {onReply && <IconButton icon="reply" label="Ответить" className="msg-action-btn" onClick={onReply} />}
          {isUser && onRewind && <IconButton icon="rewind" label="Откатить к этому сообщению" className="msg-action-btn" onClick={onRewind} />}
          {!isUser && <IconButton icon="volume" label="Озвучить" className="msg-action-btn" onClick={onReadAloud} />}
        </motion.div>,
        document.body
      )}
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
  message, onPin, onCopy, onReadAloud, onReply, onRewind, toolOutputMode = 'normal', searchQuery, liveThinking, isStreaming, isWaiting, rateLimitSec, shouldAnimate = true,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content)
    onCopy?.(message.content)
  }, [message.content, onCopy])

  const handleReply = useCallback(() => {
    onReply?.(message)
  }, [message, onReply])

  const handleRewind = useCallback(() => {
    onRewind?.(message.id)
  }, [message.id, onRewind])

  const handleReadAloud = useCallback(() => {
    onReadAloud?.(message.content)
  }, [message.content, onReadAloud])

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

  // Время — always / hover / never
  const timeEl = showTime !== 'never' ? (
    <span className={`message-time ${showTime === 'hover' ? 'message-time--hover' : ''}`}>
      {new Date(message.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
    </span>
  ) : null

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

  return (
    <motion.div
      className={`message-wrap ${isUser ? 'message-wrap--user' : 'message-wrap--assistant'} ${searchQuery ? 'message-wrap--search-match' : ''}`}
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
            content={message.content}
            isUser={isUser}
            searchQuery={searchQuery}
            toolOutputMode={toolOutputMode}
            toolSteps={message.toolSteps}
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
            liveIters={(message as Message & { liveIters?: Array<{ textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }> }).liveIters}
            liveTextAfter={(message as Message & { liveTextAfter?: string }).liveTextAfter}
            rateLimitSec={rateLimitSec}
            userMarkdown={isUser ? userMarkdown : true}
            timeEl={timeEl}
            agentStatus={(message as Message & { agentStatus?: string }).agentStatus}
            retry={(message as Message & { retry?: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null }).retry}
            lastError={(message as Message & { lastError?: string | null }).lastError}
            toolProgress={(message as Message & { toolProgress?: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }> }).toolProgress}
          />
        </div>
      ) : (
      <MessageContent
        content={message.content}
        isUser={isUser}
        searchQuery={searchQuery}
        toolOutputMode={toolOutputMode}
        toolSteps={message.toolSteps}
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
        liveIters={(message as Message & { liveIters?: Array<{ textBefore: string; steps: import('../ToolChain/ToolChain').ToolStep[] }> }).liveIters}
        liveTextAfter={(message as Message & { liveTextAfter?: string }).liveTextAfter}
        rateLimitSec={rateLimitSec}
        userMarkdown={isUser ? userMarkdown : true}
        timeEl={timeEl}
        agentStatus={(message as Message & { agentStatus?: string }).agentStatus}
        retry={(message as Message & { retry?: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null }).retry}
        lastError={(message as Message & { lastError?: string | null }).lastError}
        toolProgress={(message as Message & { toolProgress?: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }> }).toolProgress}
      />
      )}
    </motion.div>
  )
})

export default MessageBubble

