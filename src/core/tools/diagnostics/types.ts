// ── Универсальные типы для системы диагностики ──

/**
 * Одна запись о проблеме (ошибка/предупреждение), найденная линтером или
 * type-checker'ом. Единый формат для всех провайдеров (tsc, eslint, ruff,
 * cargo, go vet, dotnet и т.д.).
 */
export interface DiagnosticEntry {
  file: string
  line: number
  col?: number
  severity: 'error' | 'warning'
  message: string
  /** Источник: 'tsc', 'eslint', 'ruff', 'mypy', 'cargo', 'go-vet' и т.д. */
  source: string
}

/**
 * Результат запуска одной диагностической команды. Отличает «команда не
 * найдена / timeout» (failed=true) от «найдены ошибки» (failed=false, exit!=0
 * — норма для tsc/eslint/ruff когда есть ошибки).
 */
export interface DiagRunResult {
  stdout: string
  stderr: string
  /** true — команда не запустилась (not installed, timeout, config missing).
   *  false — команда запустилась (возможно с exit!=0 из-за найденных ошибок). */
  failed: boolean
  failureReason: string
  /** Provider-confirmed count before any requested-file filtering. */
  parsedCount?: number
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  timedOut?: boolean
  rawStdout?: string
  rawStderr?: string
}

/**
 * Интерфейс провайдера диагностики для конкретного стека/языка.
 * Каждый провайдер:
 *  1. detect(dir) — проверяет, применим ли он к проекту (ищет файлы-маркеры)
 *  2. run(dir, files?) — запускает проверку, возвращает DiagnosticEntry[]
 */
export interface DiagnosticProvider {
  /** Имя стека: 'typescript', 'python', 'go', 'rust', ... */
  name: string
  /** Optional input-file capability for safe per-provider routing. */
  extensions?: string[]
  /** Проверяет — применим ли провайдер к проекту (ищет файлы-маркеры в корне) */
  detect(dir: string): boolean
  /** Запускает проверку. files? — конкретные файлы (если указаны), иначе весь проект. */
  run(dir: string, files?: string[]): Promise<ProviderRunResult>
}

export interface ProviderRunResult {
  entries: DiagnosticEntry[]
  /** Если команда не запустилась (not installed, timeout) — причина. */
  failed?: string
  /** Info-сообщение (skipped, fallback used, и т.д.) — не ошибка. */
  note?: string
}
