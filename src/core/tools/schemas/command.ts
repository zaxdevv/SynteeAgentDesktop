// ── Command/system tool schemas ──────────────────────────────────────────

export const COMMAND_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'Run a command in the terminal. Windows: PowerShell by default (ls/cat/rm/Get-Process/$env:PATH etc.), cmd — via shell:"cmd". Linux/Mac: bash. Specify cwd for projects, timeout for long operations.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command' },
          cwd: { type: 'string', description: 'Working directory' },
          shell: { type: 'string', enum: ['powershell', 'cmd'], description: 'Shell (Windows only, default powershell)' },
          timeout: { type: 'number', description: 'Timeout in seconds (default 60)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_diagnostics',
      description: 'Check the project for compilation and linting errors. Auto-detects the project language/stack (TypeScript, JavaScript, Python, Go, Rust, C#, Kotlin, Java, C/C++, Ruby, PHP, Lua, Swift, Dart, Elixir, Haskell, Scala, R, Nim, Zig, OCaml, Crystal, V, Clojure, Groovy, Perl, Objective-C, Erlang, Fortran, Julia, GraphQL, Protobuf, TOML, CMake, Bazel, JSON, YAML, Docker, Terraform, SQL, Markdown — 42 stacks total) and runs the appropriate type-checker and linter for each detected stack. Pass "files" to check ONLY specific files. Without "files", errors are sorted: changed files (git diff) first, then pre-existing. Call after code edits to verify nothing broke. Returns a list of errors with file:line.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project directory (defaults to the chat working directory)' },
          files: { type: 'array', items: { type: 'string' }, description: 'Specific files to check. If omitted, checks the whole project.' },
        },
      },
    },
  },
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
      name: 'get_system_info',
      description: 'Получить информацию о системе (OS, память, uptime).',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const
