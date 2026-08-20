// ── Read/research tool schemas ──────────────────────────────────────────

export const READ_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Читает файл. Без offset — первые 400 строк. С offset/limit — точный диапазон строк. Всегда показывает [total_lines] и подсказку с готовым offset если файл обрезан. Если повторно вызвать без offset на уже прочитанном файле — автоматически вернёт следующий непрочитанный чанк (auto-advance). Параметр full=true читает чанками по ~5000 символов — удобно для полного чтения больших файлов без ручного управления offset.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу (абсолютный или относительный от workdir)' },
          offset: { type: 'number', description: 'Начальная строка (1-indexed). Для чтения по частям.' },
          limit: { type: 'number', description: 'Кол-во строк (по умолч. 400). Увеличь до 500-800 если нужно больше за один вызов.' },
          full: { type: 'boolean', description: 'Read the entire file in chunks of ~5000 characters. Each repeated call without offset returns the next chunk automatically. Use for files you need to fully understand. Mutually exclusive with offset/limit.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_files',
      description: 'Read multiple files at once (up to 10). Each file is truncated to 250 lines; to read a large file fully use read_file with offset/limit. Use this instead of read_file when you need to look at several files of the project at once.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of absolute paths to files (up to 10)',
          },
        },
        required: ['paths'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: 'Show a folder contents as a tree. recursive=true traverses nested folders (depth default 3). Ignores node_modules/dist/.git.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the folder' },
          recursive: { type: 'boolean', description: 'Recursive traversal (default false)' },
          depth: { type: 'number', description: 'Recursion depth (default 3)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_fast_context',
      description: 'Fast project context: finds relevant files and line ranges by query via tree-sitter symbol index + fast LLM. Use as the FIRST step for any code task to instantly understand which files/functions/classes relate to the query — saves the main model tokens on search. Covers 80% of "where is X implemented" cases in ~1-3s. Result: a list of files with line ranges and a brief summary. Does not replace read_file for details — use it after to read the found files.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to find: a feature, function/class name, file, concept. Example: "where is the OAuth flow implemented", "User data model", "payment processing"' },
          maxFiles: { type: 'number', description: 'Max files to return (default 50)' },
          maxTokens: { type: 'number', description: 'Repo-map slice token budget (default 8000)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_files',
      description: 'Find files by name or regex pattern. Use when you need to find a file by name: "where is ChatPage.tsx?", "find all *.config.ts". Ignores node_modules/dist/.git.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'File name, glob (*.tsx) or regex. Example: "ChatPage.tsx", "*.config.ts", "index\\.(ts|tsx)"' },
          path: { type: 'string', description: 'Directory to search in' },
          max_results: { type: 'number', description: 'Max results (default 50)' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
] as const
