// ── Search/web tool schemas ─────────────────────────────────────────────

export const SEARCH_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_code',
      description: 'Search code: regex or text in files via ripgrep. Smart-case by default (a lowercase pattern matches CamelCase; pass ignore_case=true to force insensitive, or use uppercase in the pattern for case-sensitive). path is OPTIONAL — defaults to the project root; pass a subfolder/file to narrow. Invalid regex is auto-retried as literal text (with a note). Respects .gitignore, searches hidden dot-directories (.vscode/.planning/...), excludes .git and secrets (.env/.pem/.key). Output legend: ">" marks a match line, "-" a context line, "..." a gap between separate matches; "(N matches, showing K)" means K of N matches in that file are displayed. If the header says "showing X of Y" — narrow file_glob/path or raise max_results; do NOT loop over pattern variants. For file NAMES use find_files; for "where is X / concepts" use get_fast_context.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or string. Example: "useState", "import.*axios", "class\\s+User". Special chars ( ) [ ] . $ are regex metachars — if you mean them literally, pass literal=true (or just pass them; an invalid regex is auto-searched literally).' },
          path: { type: 'string', description: 'Directory or file to search (absolute or relative to workdir). OPTIONAL — omit to search the whole project.' },
          file_glob: { type: 'string', description: 'File filter: "*.ts", "*.py", "*.{ts,tsx}"' },
          ignore_case: { type: 'boolean', description: 'Force case-insensitive. Default is smart-case (lowercase pattern = insensitive).' },
          literal: { type: 'boolean', description: 'Search pattern literally (no regex). Default false; auto-enabled if pattern is invalid regex.' },
          files_only: { type: 'boolean', description: 'Return only a list of matching files with per-file counts (no line content). Cheap broad overview before narrowing.' },
          max_results: { type: 'number', description: 'Max matches displayed (default 100). Per-file cap is ~10.' },
          max_chars: { type: 'number', description: 'Max chars in output (default 20000). Increase if truncated.' },
          context: { type: 'number', description: 'Context lines around a match (default 3).' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_web',
      description: 'Поиск в интернете через Tavily API. Используй для актуальной информации — новости, документация, ответы на вопросы.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Поисковый запрос' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'http_request',
      description: 'Прямой HTTP-запрос к API или веб-странице. GET/POST/PUT/DELETE/PATCH с заголовками и телом. Возвращает status, headers, body. Быстрее и надёжнее чем curl через run_command — нет проблем с экранированием. Используй для: API-вызовы, вебхуки, скачивание JSON/XML, проверка эндпоинтов. ВАЖНО: success=true означает что запрос выполнился, а не что HTTP-статус успешный — всегда проверяй Status в выводе (404/500 тоже success=true).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Полный URL (http:// или https://)' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'], description: 'HTTP-метод (по умолч. GET)' },
          headers: { type: 'object', description: 'Заголовки запроса. Например: {"Authorization": "Bearer ...", "Content-Type": "application/json"}', additionalProperties: { type: 'string' } },
          body: { type: 'string', description: 'Тело запроса (для POST/PUT/PATCH). JSON-строка, XML, plain text — что угодно.' },
          timeout: { type: 'number', description: 'Таймаут в секундах (по умолч. 30)' },
        },
        required: ['url'],
      },
    },
  },
] as const
