// ── System / analysis tools: analyze_project, get_diagnostics, get_system_info ──

export const SYSTEM_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'analyze_project',
      description: 'Full project analysis — file structure, dependencies, git status, statistics. Call at the start of working with an unfamiliar project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_diagnostics',
      description: 'Check the project for compilation and linting errors. Auto-detects the project language/stack (TypeScript, JavaScript, Python, Go, Rust, C#, Kotlin, Java, C/C++, Ruby, PHP, Lua, Swift, Dart, Elixir, Haskell, Scala, R, Nim, Zig, OCaml, Crystal, V, Clojure, Groovy, Perl, Objective-C, Erlang, Fortran, Julia, GraphQL, Protobuf, TOML, CMake, Bazel, JSON, YAML, Docker, Terraform, SQL, Markdown — 42 stacks total) and runs the appropriate type-checker and linter for each detected stack. Pass "files" to focus on specific files; project-level checkers may still check dependencies and report global configuration errors. Without "files", changed files (git diff) are prioritized, followed by other files (not necessarily pre-existing errors). Checks nested projects within bounded discovery. PARTIAL or skipped checks do not prove a clean project. Supports offset/limit pagination and a full report file when output is long. Call after code edits to verify nothing broke.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project directory (defaults to the chat working directory)' },
          files: { type: 'array', items: { type: 'string' }, description: 'Specific files to check. If omitted, checks the whole project.' },
          offset: { type: 'integer', minimum: 0, description: 'Starting diagnostic record for pagination.' },
          limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum diagnostic records to return.' },
          max_chars: { type: 'integer', minimum: 500, maximum: 20000, description: 'Maximum response characters.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_system_info',
      description: 'Получить информацию о системе (OS, память, uptime).',
      parameters: { type: 'object', properties: {} },
    },
  },
]
