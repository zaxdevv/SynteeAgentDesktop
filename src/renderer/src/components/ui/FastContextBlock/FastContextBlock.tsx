import { useState, useEffect, useRef, memo } from 'react'
import { ChevronDown, Compass, FileCode, Clock, Check, Loader2, Sparkles, Database, FileSearch } from 'lucide-react'
import './FastContextBlock.css'

export interface FastContextFile {
  path: string
  lineRanges: string
  why: string
}

export interface FastContextResultData {
  files: FastContextFile[]
  summary: string
  ms: number
  indexedFilesCount: number
  fallback?: boolean
}

interface Props {
  result: FastContextResultData
  liveProgress?: { stage: string; detail?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }> }
  onOpenFile?: (path: string, lineRange?: string) => void
}

const STAGES = [
  { id: 'indexing', label: 'Индексация', icon: Database },
  { id: 'retrieving', label: 'Поиск', icon: FileSearch },
  { id: 'summarizing', label: 'Анализ LLM', icon: Sparkles },
  { id: 'done', label: 'Готово', icon: Check },
]

function stageIndex(stage: string): number {
  const i = STAGES.findIndex(s => s.id === stage)
  return i === -1 ? 0 : i
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  if (parts.length <= 3) return p
  return '…/' + parts.slice(-2).join('/')
}

const FastContextBlock = memo(function FastContextBlock({ result, liveProgress, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState(true)
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(new Set())
  const [showSummary, setShowSummary] = useState(true)

  const activeStage = liveProgress?.stage
  const activeIdx = activeStage ? stageIndex(activeStage) : 3
  const isLive = !!activeStage && activeStage !== 'done'

  // Сохраняем filesFound — они приходят во время retrieving, но должны
  // показываться и во время summarizing (иначе пропадают)
  const savedFilesRef = useRef<Array<{ path: string; score: number; why: string }>>([])
  if (isLive && liveProgress?.filesFound && liveProgress.filesFound.length > 0) {
    savedFilesRef.current = liveProgress.filesFound
  }
  if (!isLive) savedFilesRef.current = []
  const liveFiles = isLive ? savedFilesRef.current : []

  const toggleFile = (i: number) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const formatMs = (ms: number) => {
    if (ms < 1000) return `${ms}мс`
    return `${(ms / 1000).toFixed(1)}с`
  }

  const wasLiveRef = useRef(false)
  useEffect(() => {
    if (isLive) {
      wasLiveRef.current = true
      setExpanded(true)
    } else if (wasLiveRef.current && !isLive) {
      const t = setTimeout(() => setExpanded(false), 1500)
      return () => clearTimeout(t)
    }
  }, [isLive])

  return (
    <div className={`fcb-wrap${isLive ? ' fcb-wrap--live' : ''}`}>
      <div className="fcb-header" onClick={() => setExpanded(!expanded)}>
        <div className="fcb-header-left">
          <Compass size={14} className={`fcb-icon${isLive ? ' fcb-icon--spin' : ''}`} />
          <span className="fcb-title">Быстрый контекст проекта</span>
          {result.fallback && <span className="fcb-fallback-badge">fallback</span>}
        </div>
        <div className="fcb-header-right">
          {!isLive && (
            <span className="fcb-meta">
              <Clock size={11} />
              {formatMs(result.ms)} · {result.files.length} файлов
            </span>
          )}
          {!isLive && !expanded && result.files.length > 0 && (
            <span className="fcb-compact-files">
              {result.files.slice(0, 3).map(f => shortPath(f.path)).join(', ')}
              {result.files.length > 3 && ` +${result.files.length - 3}`}
            </span>
          )}
          <button className="fcb-chevron" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}>
            {expanded ? <ChevronDown size={14} /> : <ChevronDown size={14} style={{ transform: 'rotate(-90deg)' }} />}
          </button>
        </div>
      </div>

      {/* Body: CSS grid 0fr→1fr вместо framer-motion height:auto */}
      <div className={`fcb-body-wrap${expanded ? ' fcb-body-wrap--open' : ''}`}>
        <div className="fcb-body">
          {/* Stages timeline */}
          <div className="fcb-stages">
            {STAGES.map((stage, i) => {
              const StageIcon = stage.icon
              const isDone = !isLive || i < activeIdx
              const isActive = isLive && i === activeIdx
              return (
                <div key={stage.id} style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                  <div className={`fcb-stage ${isDone ? 'done' : ''} ${isActive ? 'active' : ''}`}>
                    <div className="fcb-stage-dot">
                      {isDone ? (
                        <Check size={10} className="fcb-stage-check" />
                      ) : isActive ? (
                        <Loader2 size={10} className="fcb-stage-icon--spin" />
                      ) : (
                        <StageIcon size={10} className="fcb-stage-icon" />
                      )}
                    </div>
                    <span className="fcb-stage-label">{stage.label}</span>
                    {isActive && liveProgress?.detail && (
                      <span className="fcb-stage-detail">{liveProgress.detail}</span>
                    )}
                    {isActive && liveProgress?.filesTotal != null && liveProgress.filesTotal > 0 && (
                      <span className="fcb-stage-progress">
                        {liveProgress.filesProcessed ?? 0}/{liveProgress.filesTotal}
                      </span>
                    )}
                  </div>
                  {i < STAGES.length - 1 && <span className="fcb-stage-arrow">›</span>}
                </div>
              )
            })}
          </div>

          {/* Progress bar — CSS opacity transition */}
          {isLive && (
            <div className="fcb-progress-bar">
              <div
                className="fcb-progress-fill"
                style={{ width: `${((activeIdx + 1) / STAGES.length) * 100}%` }}
              />
            </div>
          )}

          {/* Live file chips — CSS grid 0fr→1fr + CSS animation на chip'ах */}
          {isLive && liveFiles.length > 0 && (
            <div className="fcb-live-chips">
              <div className="fcb-live-chips-label">
                {activeStage === 'summarizing' ? 'LLM анализирует:' : 'Найденные файлы:'}
              </div>
              <div className="fcb-chips-row">
                {liveFiles.map((f, i) => (
                  <div
                    key={f.path}
                    className="fcb-chip fcb-chip--enter"
                    style={{ '--fcb-i': i } as React.CSSProperties}
                    title={f.path}
                  >
                    <FileCode size={10} />
                    <span>{shortPath(f.path)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Shimmer during summarizing — CSS opacity transition */}
          {isLive && activeStage === 'summarizing' && (
            <div className="fcb-shimmer-wrap">
              <div className="fcb-shimmer-line" />
              <div className="fcb-shimmer-line fcb-shimmer-line--short" />
              <div className="fcb-shimmer-line" />
            </div>
          )}

          {/* Summary — CSS opacity + grid для expand/collapse */}
          {result.summary && !isLive && (
            <div className="fcb-summary-wrap">
              <button
                className="fcb-summary-toggle"
                onClick={() => setShowSummary(!showSummary)}
              >
                <ChevronDown size={11} style={{ transform: showSummary ? '' : 'rotate(-90deg)', transition: 'transform 0.2s' }} />
                <span>Summary</span>
              </button>
              <div className={`fcb-summary-collapse${showSummary ? ' fcb-summary-collapse--open' : ''}`}>
                <p className="fcb-summary">{result.summary}</p>
              </div>
            </div>
          )}

          {/* Files list — CSS opacity transition + CSS entrance на rows */}
          {result.files.length > 0 && !isLive && (
            <div className="fcb-files">
              <div className="fcb-files-header">
                Найдено файлов: {result.files.length}
              </div>
              {result.files.map((file, i) => {
                const isExpandedFile = expandedFiles.has(i)
                return (
                  <div
                    key={i}
                    className="fcb-file-row fcb-file-row--enter"
                    style={{ '--fcb-i': i } as React.CSSProperties}
                  >
                    <div className="fcb-file-head" onClick={() => toggleFile(i)}>
                      <ChevronDown size={11} className={`fcb-file-chevron ${isExpandedFile ? '' : 'fcb-file-chevron--closed'}`} />
                      <FileCode size={12} className="fcb-file-icon" />
                      <button
                        className="fcb-file-path"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenFile?.(file.path, file.lineRanges)
                        }}
                        title={file.path}
                      >
                        {file.path}
                      </button>
                      {file.lineRanges && (
                        <span className="fcb-file-lines">L{file.lineRanges}</span>
                      )}
                    </div>
                    {isExpandedFile && file.why && (
                      <div className="fcb-file-why">{file.why}</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Empty state */}
          {!isLive && result.files.length === 0 && !result.fallback && (
            <div className="fcb-empty">
              Ничего не найдено по запросу. Возможно стоит уточнить или использовать read_file/search_code.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}, (prev, next) =>
  prev.result === next.result &&
  prev.liveProgress === next.liveProgress &&
  prev.onOpenFile === next.onOpenFile
)

export default FastContextBlock
