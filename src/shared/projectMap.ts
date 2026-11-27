/**
 * Project map — детерминированный граф кода проекта (файлы, символы, вызовы).
 * Строится из tree-sitter разбора (sidecar) + эвристического резолвинга связей.
 * Типы общие для core (store/builder), main (IPC) и renderer (UI).
 */

/** Тип узла графа. file — сам файл; остальные — символы внутри файла. */
export type CodeNodeKind =
  | 'file'
  | 'package'
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'field'
  | 'interface'
  | 'enum'
  | 'struct'
  | 'type'
  | 'module'
  | 'impl'
  | 'constructor'
  | 'macro'
  | 'definition'
  /** Секция markdown-документа (README/ADR/доки) — «где это описано». */
  | 'section'

/** Тип ребра. */
export type CodeEdgeType = 'contains' | 'imports' | 'calls' | 'references'

/**
 * Точность ребра:
 *  - resolved   — связь установлена однозначно (импорт → файл, вызов → определение)
 *  - heuristic  — эвристика (уникальное совпадение имени)
 *  - ambiguous  — несколько кандидатов, связь предположительная
 *  - external   — цель вне проекта (внешний пакет)
 */
export type CodeEdgePrecision = 'resolved' | 'heuristic' | 'ambiguous' | 'external'

export interface CodeMapNode {
  id: string
  projectId: string
  filePath: string
  name: string
  kind: CodeNodeKind
  parentName: string | null
  lineStart: number
  lineEnd: number
  signature: string
  exported: boolean
  /** Docstring/JSDoc/XML-doc/декораторы — контекст для семантических документов. */
  doc?: string | null
}

export interface CodeMapEdge {
  id: string
  projectId: string
  fromNode: string
  toNode: string
  type: CodeEdgeType
  precision: CodeEdgePrecision
  /** Файл, чей разбор породил ребро (для точечного удаления при реиндексации). */
  filePath: string
  line: number
}

export interface CodeMapFile {
  projectId: string
  path: string
  language: string | null
  hash: string
  mtime: number
  size: number
  parser: string | null
  truncated: boolean
  indexedAt: number
}

/**
 * Состояние карты проекта.
 *  - idle     — карты нет;
 *  - building — идёт сборка;
 *  - partial  — карта построена, но по НЕПОЛНОМУ инвентарю файлов (первичный скан
 *               не успел, упёрлись в лимит файлов или watcher мёртв). Граф рабочий
 *               и отвечает на запросы, но часть файлов может отсутствовать, а
 *               удаления в этом состоянии не применяются;
 *  - ready    — полная карта;
 *  - error    — сборка упала.
 */
export type CodeMapState = 'idle' | 'building' | 'partial' | 'ready' | 'error'

export interface CodeMapStatus {
  projectId: string
  state: CodeMapState
  totalFiles: number
  indexedFiles: number
  totalNodes: number
  totalEdges: number
  startedAt: number | null
  updatedAt: number
  error: string | null
}

export interface CodeMapGraph {
  nodes: CodeMapNode[]
  edges: CodeMapEdge[]
}

export interface CodeMapNeighbors {
  node: CodeMapNode | null
  callers: CodeMapNode[]
  callees: CodeMapNode[]
  callerCount: number
  calleeCount: number
}

/** Прогресс-событие для баннера/настроек (паттерн assistants.onSetupProgress). */
export interface CodeMapProgress {
  projectId: string
  /**
   * partial — сборка завершилась по неполному инвентарю файлов: терминальная
   * фаза (не «крутится вечно» и не «готова»), карта при этом рабочая.
   */
  phase: 'scanning' | 'parsing' | 'resolving' | 'semantic' | 'partial' | 'ready' | 'error'
  percent: number
  indexedFiles: number
  totalFiles: number
  message?: string
  error?: string
  /** Имя проекта — для компактной полоски активности. */
  projectName?: string
  /** Сколько проектов ещё ждут фоновой индексации (очередь менеджера). */
  pendingProjects?: number
  /** Точечное обновление после правки файла (не полная сборка). */
  incremental?: boolean
  /** Сколько файлов затронуто инкрементальным обновлением. */
  changedFiles?: number
  /** Прогресс семантического слоя (эмбеддинг документов). */
  semantic?: {
    state: CodeMapSemanticState
    indexedDocs: number
    totalDocs: number
  }
}

export interface GetGraphOptions {
  kinds?: CodeNodeKind[]
  edgeTypes?: CodeEdgeType[]
  /** Ограничить граф одним файлом (drill-down). */
  filePath?: string
  limit?: number
}

// ─── Семантический слой ──────────────────────────────────────────────────────

/** Режим последнего семантического поиска: e5 — векторы, lexical — слова. */
export type CodeMapSemanticMode = 'e5' | 'lexical' | 'none'

/**
 * Состояние семантического слоя проекта.
 *  - off      — документов нет (карта не собрана);
 *  - deferred — документы есть, но проект ещё не запрашивали: векторов нет,
 *               прогрев не запущен (E5 включается только явным запросом);
 *  - warming  — идёт эмбеддинг очереди;
 *  - ready    — все документы имеют актуальный вектор;
 *  - error    — sidecar/модель недоступны, поиск работает лексически.
 */
export type CodeMapSemanticState = 'off' | 'deferred' | 'warming' | 'ready' | 'error'

/** Документ символа/файла для эмбеддинга — выводится из узлов карты. */
export interface CodeMapDocInfo {
  nodeId: string
  filePath: string
  kind: CodeNodeKind
  /**
   * 0 — только lexical-поиск (текст хранится, вектор не считается: нет смысла
   *     эмбеддить символ без docstring и без экспорта или файл без экспортов);
   * 1 — публичный API (файлы с экспортами, exported-символы), эмбеддится первым;
   * 2 — внутренние символы с реальным docstring.
   */
  tier: 0 | 1 | 2
  text: string
  textHash: string
}

/** Хит семантического поиска: узел + каналы, по которым он найден. */
export interface CodeMapSemanticHit {
  node: CodeMapNode
  score: number
  matchedBy: 'semantic' | 'lexical' | 'both'
}

/** Итог семантического поиска. */
export interface CodeMapSemanticResult {
  mode: CodeMapSemanticMode
  totalDocs: number
  indexedDocs: number
  hits: CodeMapSemanticHit[]
}

/** Настройка скорости фоновой индексации. */
export interface ProjectMapSpeedSettings {
  /** auto — бюджет от железа (ядра/память) + уступка foreground; manual — уровень. */
  mode: 'auto' | 'manual'
  /** 0..100 для manual: 0 = эко (макс. паузы), 100 = быстро (без пауз). */
  level: number
}

export const DEFAULT_PROJECT_MAP_SPEED: ProjectMapSpeedSettings = { mode: 'auto', level: 50 }

/** Статус семантического слоя проекта (для IPC/настроек). */
export interface CodeMapSemanticStatus {
  state: CodeMapSemanticState
  mode: CodeMapSemanticMode
  totalDocs: number
  indexedDocs: number
  error: string | null
}

/** Строка статистики проекта для вкладки настроек. */
export interface ProjectMapProjectStats extends CodeMapStatus {
  name: string
  workdir: string
  /** Семантический слой: сколько документов проиндексировано. */
  semantic: CodeMapSemanticStatus
}

/** Что авто-режим выбрал от железа (для показа в настройках). */
export interface ProjectMapAutoInfo {
  cores: number
  memGB: number
  backgroundDelayMs: number
}

// ─── Человеческие подписи «неполной» карты ──────────────────────────────────

/**
 * Терминальные фазы прогресса: проход закончился (полностью, частично или
 * ошибкой). По ним UI прячет полоску активности и обновляет таблицу — иначе
 * `partial` висел бы вечным спиннером.
 */
export function isCodeMapPhaseTerminal(phase: CodeMapProgress['phase']): boolean {
  return phase === 'ready' || phase === 'partial' || phase === 'error'
}

/** Карта пригодна к запросам: полная или частичная (partial — рабочий граф). */
export function isCodeMapStateUsable(state: CodeMapState): boolean {
  return state === 'ready' || state === 'partial'
}

/**
 * Семантический слой ничего не считает прямо сейчас.
 * `deferred` (векторов нет, прогрев не запрашивали) и `error` (лексический
 * фолбэк) сами по себе никогда не станут `ready` — считать их «ещё работаю»
 * значит держать UI в ожидании вечно. Активна только `warming`.
 */
export function isCodeMapSemanticSettled(state: CodeMapSemanticState): boolean {
  return state !== 'warming'
}

/**
 * Пояснение к неполной карте — показываем вместо «готова»/спиннера.
 * Цифры покрытия выводим только когда indexed/total реально расходятся:
 * у partial билдер пишет в оба поля фактическое число файлов графа.
 */
export function codeMapPartialNote(
  stats?: { indexedFiles?: number; totalFiles?: number } | null,
): string {
  const indexed = stats?.indexedFiles ?? 0
  const total = stats?.totalFiles ?? 0
  const coverage = total > indexed ? ` (${indexed} из ${total} файлов)` : ''
  return `Карта неполная${coverage}: инвентарь файлов ещё не сошёлся, часть файлов может отсутствовать. Досчитается автоматически.`
}
