/**
 * Slash-команды.
 *
 * Две категории:
 *   1. **Builtin** — захардкожены в SLASH_COMMANDS ниже. Не имеют .md-файла,
 *      управляются кодом (clear/sys/compact/rewind/fork/help/snapshot/restore).
 *   2. **Custom** — загружаются из .md-файлов (commandLoader.ts):
 *        - resources/commands/      (builtin-пакетные, поставляются с приложением)
 *        - {userData}/commands/      (глобальные пользовательские)
 *        - {workdir}/.syntee/commands/ (проектные, коммитятся в репозиторий)
 *      Формат: YAML frontmatter + тело = шаблон systemPrompt (с $ARGS).
 *
 * Источник: 'builtin' | 'user' | 'project'. Builtin-пакетные команды из
 * resources/commands/ тоже помечаются source='builtin' (они вшиты в дистрибутив).
 */

export type SlashCommandSource = 'builtin' | 'user' | 'project'

export type SlashCommandMode = 'ask' | 'plan' | 'code'

/**
 * Описание одного аргумента slash-команды для пикера опций (enum).
 * Если у команды задано `arguments` с непустым `choices`, после выбора
 * команды открывается многоуровневый пикер: первый аргумент → второй → …
 * Аргумент без choices — свободный текст (подсказка через description).
 */
export interface CommandArgument {
  name: string
  description?: string
  /** Predefined опции для enum-пикера. Пустой/undefined — свободный текст. */
  choices?: string[]
  required?: boolean
  default?: string
}

export interface SlashCommand {
  name: string
  label: string
  description: string
  icon: string
  placeholder?: string
  /** Подсказка для аргумента (например "путь к файлу"). Показывается в меню. */
  argumentHint?: string
  /**
   * Структурированные аргументы команды для многоуровневого пикера опций.
   * Опционально — старые команды без этого поля работают как раньше
   * (свободный текст после `/name`). Для custom .md-команд парсится из
   * YAML-блока `arguments:` в frontmatter.
   */
  arguments?: CommandArgument[]
  systemPrompt: (args: string) => string
  /** Источник: builtin (в коде или вшитый .md), user (userData), project (.syntee/commands). */
  source?: SlashCommandSource
  /** Путь к .md-файлу для custom-команд. undefined для builtin в SLASH_COMMANDS. */
  filePath?: string
  /** Ограничение тулов на этот прогон (только для custom-команд с allowed-tools).
   *  Builtin-команды игнорируют это поле — их режим задаётся кодом. */
  allowedTools?: string[]
  /** Режим работы (для custom-команд). Builtin-команды управляют режимом сами. */
  mode?: SlashCommandMode
  /** id скилла для one-shot активации (для команд типа /review → skill:code-review).
   *  Скилл инъектируется в system prompt только на этот прогон, без записи в skillsState. */
  skill?: string
  /**
   * Persona override for this single message (per-message mode, Aider-style).
   * If set — this one `chat:send` runs in the named persona, WITHOUT
   * persisting the change to the chat's sticky persona (the UI badge does
   * not switch). Used by builtin `/debug`, `/review`, `/architect`, ... so
   * the user can say "answer this one as a debugger" without leaving their
   * current persona. The sticky switch is `/persona <name>` instead.
   */
  personaOverride?: import('./modes').PersonaId
  /** Маркер что это команда из .md-файла (а не из захардкоженного SLASH_COMMANDS). */
  custom?: boolean
  /** Команда плагина (registerCommand). ChatPage перехватывает её ДО агента
   *  и вызывает IPC plugins:executeCommand — systemPrompt не используется. */
  plugin?: { pluginId: string; name: string }
  /**
   * Сырой шаблон systemPrompt (тело .md-файла) — транспортируется через IPC
   * вместо самой функции (функции не клонируются structured clone).
   * Renderer восстанавливает systemPrompt через hydrateCommands().
   */
  promptTemplate?: string
  /** Шаблон содержит $ARGS (плейсхолдер аргумента). */
  hasArgsPlaceholder?: boolean
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'goal', label: '/goal', description: 'Новая цель; без аргументов — явно продолжить текущую', icon: 'target', placeholder: 'что должно быть достигнуто?', source: 'builtin', systemPrompt: () => '' },
  { name: 'goal-pause', label: '/goal-pause', description: 'Поставить цель на паузу', icon: 'pause', source: 'builtin', systemPrompt: () => '' },
  { name: 'goal-stop', label: '/goal-stop', description: 'Остановить цель и текущий запрос, сохранив результаты', icon: 'x', source: 'builtin', systemPrompt: () => '' },
  {
    name: 'image',
    label: '/image',
    description: 'Сгенерировать изображение',
    icon: 'image',
    placeholder: 'описание изображения...',
    source: 'builtin',
    arguments: [
      {
        name: 'style',
        description: 'Стиль изображения',
        choices: ['realistic', 'art', 'anime', 'pixel', '3d'],
        default: 'realistic',
      },
    ],
    systemPrompt: (args) =>
      `The user wants to generate an image. Description: "${args}". Use the generate_image tool. If the tool is not available, create a detailed prompt for Midjourney/DALL-E.`,
  },
  {
    name: 'web',
    label: '/web',
    description: 'Поиск в интернете',
    icon: 'globe',
    placeholder: 'поисковый запрос...',
    source: 'builtin',
    systemPrompt: (args) =>
      `The user wants to find information on the internet. Query: "${args}". Use the search_web tool to find current information and provide an answer based on the search results.`,
  },
  {
    name: 'setup',
    label: '/setup',
    description: 'Analyze project and recommend MCP/skills',
    icon: 'sparkles',
    placeholder: '(optional) focus, e.g. "only mcp" or "frontend"',
    argumentHint: 'optional focus',
    source: 'builtin',
    systemPrompt: (args) =>
      `You are the onboarding agent. Your task: analyze the current project, recommend relevant MCP servers and skills, present them to the user, ask for confirmation, then install the confirmed ones into the project (".mcp.json" and ".syntee/skills/").

User focus (optional): ${args || '(none — cover everything)'}

## Steps (STRICT order)

1. **Analyze.** Call the \`analyze_project\` tool with path "." (current workdir). You will get a markdown report: file structure, package.json (deps/scripts), requirements.txt/pyproject.toml/Cargo.toml/go.mod, README, git status, file statistics.

2. **Recommend.** Based on the analysis, pick relevant MCP servers and skills from your knowledge of the popular MCP ecosystem. Match by detected tech stack:
   - React/Next/Vue/Svelte/Vite frontend → context7 (docs), shadcn-ui (UI components)
   - Playwright / playwright.config.* → playwright
   - Python (pyproject/requirements/.py) → context7
   - Rust (Cargo.toml/.rs) → context7
   - Go (go.mod/.go) → context7
   - Docker (Dockerfile/docker-compose) → docker
   - Kubernetes (k8s/Chart.yaml/kubeconfig) → kubernetes
   - .github/workflows → github
   - @supabase/ → supabase
   - pg/prisma/drizzle/kysely → postgres
   - mysql/mysql2 → mysql
   - mongodb/mongoose → mongodb
   - redis/ioredis → redis
   - @sentry/ → sentry
   - figma/@figma/ → figma
   - Notion/Slack/Linear/Jira/Trello/ClickUp mentions in README → corresponding MCP
   - .git present → git + sequential-thinking (universal utilities)
   - Nothing matches → default to context7 + sequential-thinking
   Add 1-2 more MCP from your expertise if the project clearly needs them (e.g. sentry for monitoring, figma for design handoff, chrome-devtools for web debugging).
   Skills: only add if the project is a clear coding/workflow fit. For most projects MCP is enough — skip skills unless obviously useful.

3. **Dedup & check installed.** Remove duplicates by id. Read ".mcp.json" (if exists) via read_file — do not recommend MCP already listed in mcpServers. List ".syntee/skills" via list_directory — do not recommend already installed skills.

4. **Present.** Output a markdown table:
   | Type | Id | Category | Why | Required env/args |
   |-----|----|----------|-----|-------------------|
   | MCP | context7 | docs | React frontend | CONTEXT7_API_KEY (opt) |
   | Skill | claude-code-skills | coding | JS with tests | — |
   Below the table: 1-2 sentences on what this setup enables.

5. **Confirm (MANDATORY).** Explicitly ask:
   > Confirm install? Reply with a comma-separated list of ids, or "all", or "cancel".
   Do NOT proceed to install without an explicit answer. If the user names a subset — install only those. If "cancel" — acknowledge and stop.

6. **Install (only after confirmation).**
   **6.1 MCP servers** — write to ".mcp.json" (STRICTLY project scope, never global ~/.syntee/). Format (Claude Code compatible):
   \`\`\`json
   {
     "mcpServers": {
       "<id-kebab-case>": {
         "command": "<command>",
         "args": ["arg1", "arg2"],
         "env": { "KEY": "<KEY>" }
       }
     }
   }
   \`\`\`
   For each MCP, use the standard launch command for the package (e.g. on Windows: "cmd /c npx -y <package>"; on Linux/Mac: "npx -y <package>"). If the file already exists — use edit_file to add the key without removing existing servers. If a server has required env vars or positional args — do NOT invent values, use placeholders like "<API_KEY>" and tell the user to fill them in.
   **6.2 Skills** — install from GitHub repo:
   1. run_command: \`git clone --depth 1 <repo-url> .tmp-skill-install\`
   2. Find .md files with YAML frontmatter (\`---\\nname: ...\\ndescription: ...\\n---\`) via find_files
   3. Copy each via read_file + write_file to ".syntee/skills/" (create dir if missing). On name conflict — prefix with repo name.
   4. run_command: remove .tmp-skill-install ("Remove-Item -Recurse -Force .tmp-skill-install" on Windows; "rm -rf .tmp-skill-install" on Linux/Mac)
   **6.3 Skills activation**: skills dropped into .syntee/skills/ are auto-enabled for this project by the app — the user does NOT need to toggle them manually. They will be active on the next message.

7. **Report.** After install, output:
   - What was installed (id → type) and where
   - Which env vars need values (if any) and where: "Settings → Extensions → MCP → [server] → Edit env"
   - That MCP servers auto-connect in the background right after .mcp.json is saved (the app watches the file) — they will be available within a few seconds
   - That skills are auto-enabled for this project

## RULES
- NEVER install anything without explicit user confirmation (step 5).
- Scope is PROJECT ONLY (".mcp.json" and ".syntee/skills/" in current workdir). Never write to ~/.syntee/.
- If the project is NOT a git repo — skip git-dependent recommendations.
- If the analysis shows an empty/minimal project (no deps, 1-2 files) — recommend only context7 + sequential-thinking and say you'll add more once the project grows.
- If a required env var has no value — use a placeholder, do not skip the server.
- The server name (key in mcpServers) must be the standard id in kebab-case, do not invent your own.`,
  },
  {
    name: 'init',
    label: '/init',
    description: 'Сгенерировать файл инструкций проекта (AGENTS.md)',
    icon: 'sparkles',
    placeholder: '(optional) focus, e.g. "frontend" or "api"',
    argumentHint: 'optional focus',
    source: 'builtin',
    systemPrompt: (args) =>
      `You are the project initialization agent. Your task: analyze the current project and create a concise AGENTS.md file with project-specific instructions that help AI agents work effectively in this codebase.

User focus (optional): ${args || '(none — cover everything)'}

## Steps (STRICT order)

1. **Analyze.** Call the \`analyze_project\` tool with path "." (current workdir). Study: file structure, package.json (deps/scripts), README, git status, tech stack, frameworks, build/test commands.

2. **Check existing instructions.** Use \`read_file\` to check if any of these already exist in the workdir root:
   - AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules, .windsurfrules, .clinerules
   - .syntee/instructions.md
   - .github/copilot-instructions.md, copilot-instructions.md
   If AGENTS.md already exists — read it. You will UPDATE it, not overwrite blindly. Preserve user's manual additions. If another instruction file exists (e.g. CLAUDE.md) but AGENTS.md does not — create AGENTS.md as the universal standard.

3. **Generate AGENTS.md.** Write a concise AGENTS.md file to the workdir root. Include ONLY what an AI agent wouldn't infer from reading the code:
   - **Project overview** (1-2 sentences: what this project is)
   - **Build & run commands** (from package.json scripts / Makefile / etc.)
   - **Test command** (if found)
   - **Code style conventions** (if detectable: tabs vs spaces, naming, import order)
   - **Architecture notes** (key directories, entry points, patterns — only non-obvious ones)
   - **Important gotchas** (platform-specific, encoding, env vars, traps)
   - **Verification command** (lint/typecheck/build — whatever is available)

   RULES for the file:
   - Keep it UNDER 80 lines. Brevity is critical — every line eats context tokens on every message.
   - Do NOT include: obvious structure (package.json is readable), generic advice ("write clean code"), full file listings.
   - Do NOT duplicate what analyze_project already shows — focus on distilled, actionable guidance.
   - Use clear markdown headings. No fluff.
   - Write in English (it's read by the AI model on every message).

4. **Report.** After writing, output:
   - A brief summary of what you included (3-5 bullet points)
   - The path to the created/updated file
   - That the file will be auto-detected by the app on the next message (auto-discovery)
   - Suggest the user review and edit the file to fit their needs

## RULES
- ALWAYS write to AGENTS.md (the universal standard). If the user already has CLAUDE.md or .syntee/instructions.md — update that one instead, don't create a duplicate.
- NEVER create multiple instruction files. Pick one (prefer existing, default to AGENTS.md).
- If the project is empty (no deps, 1-2 files) — still create a minimal AGENTS.md with a placeholder overview.
- Do NOT install MCP servers or skills — that's /setup's job. /init only creates the instruction file.`,
  },
  {
    name: 'clear',
    label: '/clear',
    description: 'Очистить чат',
    icon: 'trash',
    source: 'builtin',
    systemPrompt: () => '',
  },
  {
    name: 'compact',
    label: '/compact',
    description: 'Сжать контекст чата',
    icon: 'layers',
    argumentHint: 'full | last',
    placeholder: 'режим сжатия...',
    source: 'builtin',
    arguments: [
      {
        name: 'mode',
        description: 'full — сжать старые сообщения, оставив недавние (по умолчанию). last — оставить только последнее сообщение + резюме',
        choices: ['full', 'last'],
        default: 'full',
      },
    ],
    systemPrompt: () => '',
  },
  {
    name: 'recap',
    label: '/recap',
    description: 'Краткое резюме чата',
    icon: 'fileText',
    placeholder: '',
    source: 'builtin',
    systemPrompt: () =>
      'The user wants a brief summary of the current conversation. Provide a clear summary in 3-5 bullet points: what was discussed, what decisions were made, what remains open.',
  },
  {
    name: 'memo',
    label: '/memo',
    description: 'Сохранить заметку в память',
    icon: 'brain',
    placeholder: 'текст заметки...',
    source: 'builtin',
    systemPrompt: (args) =>
      `The user wants to save a note: "${args}". Briefly confirm that the information has been saved to memory.`,
  },
  {
    name: 'sys',
    label: '/sys',
    description: 'Изменить системный промпт',
    icon: 'settings',
    placeholder: 'новый системный промпт...',
    source: 'builtin',
    systemPrompt: () => '',
  },
  {
    name: 'agent',
    label: '/agent',
    description: 'Режим мульти-агента',
    icon: 'cpu',
    placeholder: 'задача для распределения...',
    source: 'builtin',
    arguments: [
      {
        name: 'strategy',
        description: 'Стратегия оркестрации суб-агентов',
        choices: ['spawn', 'parallel', 'sequential'],
        default: 'spawn',
      },
    ],
    systemPrompt: (args) =>
      `The user wants to solve a task using sub-agents: "${args}".

You are working as an orchestrator.
1. Break the task into 2-5 independent subtasks.
2. Launch sub-agents via spawn_agent.
3. Wait for results and synthesize the overall answer.

Do not launch sub-agents unnecessarily and do not duplicate work between them.`,
  },
  {
    name: 'ask',
    label: '/ask',
    description: 'Спросить без правок (read-only)',
    icon: 'messageSquare',
    placeholder: 'вопрос...',
    source: 'builtin',
    // systemPrompt здесь pass-through — фрейминг задаётся buildAskInjection
    // в ai-worker.ts (как и в planning-режиме). Команда лишь сигнализирует
    // chat.ipc.ts, что это сообщение нужно выполнить в read-only режиме.
    systemPrompt: (args) => args,
  },

  // ─── Новые команды (реализованы в этом проходе) ────────────────────────

  {
    name: 'fork',
    label: '/fork',
    description: 'Дублировать чат с этого места',
    icon: 'gitFork',
    argumentHint: 'имя нового чата (опционально)',
    placeholder: 'имя форка...',
    source: 'builtin',
    // fork обрабатывается в ChatPage.tsx до отправки в агент — вызывает
    // IPC chat:fork, переключается на новый чат. systemPrompt не используется.
    systemPrompt: () => '',
  },
  {
    name: 'help',
    label: '/help',
    description: 'Список команд и горячих клавиш',
    icon: 'helpCircle',
    source: 'builtin',
    // help открывает модалку в renderer — не доходит до агента.
    systemPrompt: () => '',
  },
  {
    name: 'snapshot',
    label: '/snapshot',
    description: 'Сохранить именованный снапшот',
    icon: 'camera',
    argumentHint: 'имя снапшота',
    placeholder: 'имя снапшота...',
    source: 'builtin',
    // snapshot обрабатывается в ChatPage.tsx — вызывает IPC chat:snapshot:create.
    systemPrompt: () => '',
  },
  {
    name: 'restore',
    label: '/restore',
    description: 'Восстановить снапшот',
    icon: 'undo',
    argumentHint: 'имя или id снапшота (опционально)',
    placeholder: 'имя снапшота...',
    source: 'builtin',
    // restore обрабатывается в ChatPage.tsx — открывает пикер снапшотов.
    systemPrompt: () => '',
  },
  // ── Per-message persona commands (Aider-style /ask /code) ───────────────
  // Each runs ONE message in the named persona, WITHOUT switching the chat's
  // sticky persona. The user's next message goes back to the sticky persona.
  // The sticky switch is /persona <name> below.
  {
    name: 'classic',
    label: '/classic',
    description: 'Одно сообщение в классическом режиме (без персоны)',
    icon: 'circle',
    placeholder: 'сообщение...',
    argumentHint: 'текст сообщения',
    source: 'builtin',
    personaOverride: 'classic',
    systemPrompt: (a: string) => a,
  },
  {
    name: 'architect',
    label: '/architect',
    description: 'Одно сообщение в режиме Архитектора',
    icon: 'building',
    placeholder: 'сообщение...',
    argumentHint: 'текст сообщения',
    source: 'builtin',
    personaOverride: 'architect',
    systemPrompt: (a: string) => a,
  },
  {
    name: 'debug',
    label: '/debug',
    description: 'Одно сообщение в режиме Дебаггера',
    icon: 'bug',
    placeholder: 'опиши баг или ошибку...',
    argumentHint: 'текст сообщения',
    source: 'builtin',
    personaOverride: 'debugger',
    skill: 'debug-helper',
    systemPrompt: (a: string) => a,
  },
  {
    name: 'review',
    label: '/review',
    description: 'Одно сообщение в режиме Ревьюера',
    icon: 'check-square',
    placeholder: 'что ревьюить (файл/модуль/diff)...',
    argumentHint: 'текст сообщения',
    source: 'builtin',
    personaOverride: 'reviewer',
    skill: 'code-review',
    systemPrompt: (a: string) => a,
  },
  {
    name: 'refactor',
    label: '/refactor',
    description: 'Одно сообщение в режиме Рефакторщика',
    icon: 'shuffle',
    placeholder: 'что рефакторить...',
    argumentHint: 'текст сообщения',
    source: 'builtin',
    personaOverride: 'refactorer',
    skill: 'refactor',
    systemPrompt: (a: string) => a,
  },
  {
    name: 'test',
    label: '/test',
    description: 'Одно сообщение в режиме Тестописателя',
    icon: 'flask',
    placeholder: 'для чего написать тесты...',
    argumentHint: 'текст сообщения',
    source: 'builtin',
    personaOverride: 'test-writer',
    skill: 'test-generation',
    systemPrompt: (a: string) => a,
  },
  {
    name: 'mentor',
    label: '/mentor',
    description: 'Одно сообщение в режиме Ментора',
    icon: 'graduation',
    placeholder: 'что объяснить...',
    argumentHint: 'текст сообщения',
    source: 'builtin',
    personaOverride: 'mentor',
    systemPrompt: (a: string) => a,
  },
  // ── Sticky persona switch — persists until changed ──────────────────────
  // /persona (no arg) → opens picker (arguments[0].choices).
  // /persona architect → switches the chat's sticky persona.
  // Handled as a short-circuit in ChatPage.handleSend (like /clear) — does
  // NOT send a message to the agent; calls chat:setPersona + setPersona.
  {
    name: 'persona',
    label: '/persona',
    description: 'Переключить персону чата (sticky)',
    icon: 'users',
    argumentHint: 'classic | architect | debug | review | refactor | test | mentor',
    placeholder: 'выбери персону...',
    source: 'builtin',
    arguments: [
      {
        name: 'persona',
        description: 'Имя персоны',
        choices: ['classic', 'architect', 'debug', 'review', 'refactor', 'test', 'mentor'],
        required: true,
      },
    ],
    systemPrompt: () => '',
  },
]

/**
 * Парсит текст на { command, args }. Ищет среди builtin (SLASH_COMMANDS).
 * Для поиска по кастомным командам используйте parseSlashCommandWithCustom.
 */
export function parseSlashCommand(text: string): { command: SlashCommand; args: string } | null {
  if (!text.startsWith('/')) return null
  const spaceIdx = text.indexOf(' ')
  const name = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase()
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim()
  const command = SLASH_COMMANDS.find(c => c.name === name)
  if (!command) return null
  return { command, args }
}

/**
 * Парсит текст с учётом builtin + custom команд. Приоритет: builtin,
 * затем custom (по приоритету источников — project > user > builtin-pkg).
 */
export function parseSlashCommandWithCustom(
  text: string,
  customCommands: SlashCommand[],
): { command: SlashCommand; args: string } | null {
  if (!text.startsWith('/')) return null
  const spaceIdx = text.indexOf(' ')
  const name = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase()
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim()
  // Сначала builtin — они имеют приоритет (нельзя перекрыть /clear и т.д.).
  const builtin = SLASH_COMMANDS.find(c => c.name === name)
  if (builtin) return { command: builtin, args }
  const custom = customCommands.find(c => c.name === name)
  if (custom) return { command: custom, args }
  return null
}

/**
 * Фильтрует команды по префиксу для автокомплита. Принимает optional custom
 * список — если передан, фильтрует по объединённому списку (builtin + custom).
 */
export function filterCommands(query: string, customCommands: SlashCommand[] = []): SlashCommand[] {
  if (!query.startsWith('/')) return []
  const q = query.slice(1).toLowerCase()
  if (q.includes(' ')) return []
  const all = [...SLASH_COMMANDS, ...customCommands]
  // Dedup по name — builtin имеет приоритет (он первый в массиве).
  const seen = new Set<string>()
  const result: SlashCommand[] = []
  for (const cmd of all) {
    if (seen.has(cmd.name)) continue
    if (cmd.name.startsWith(q)) {
      seen.add(cmd.name)
      result.push(cmd)
    }
  }
  return result
}

/**
 * Гидратация команд после IPC: main отправляет команды БЕЗ функции
 * systemPrompt (функции не клонируются structured clone) — вместо неё
 * транспортируются promptTemplate + hasArgsPlaceholder. Здесь восстанавливаем
 * вызываемый systemPrompt. Команды с уже живой функцией (builtin) не трогаем.
 */
export function hydrateCommands(cmds: SlashCommand[]): SlashCommand[] {
  return cmds.map(c => {
    if (typeof c.systemPrompt === 'function') return c
    const template = c.promptTemplate ?? ''
    const hasArgs = c.hasArgsPlaceholder ?? false
    return {
      ...c,
      systemPrompt: (args: string) => {
        if (hasArgs) return template.replace(/\$ARGS/g, args || '')
        return args ? `${template}\n\nArgument: ${args}` : template
      },
    }
  })
}
