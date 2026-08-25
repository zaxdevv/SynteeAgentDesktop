/**
 * Personas — single-select run modes for the chat input.
 *
 * Unlike the three legacy toggles (planning/image/ask) which are independent
 * per-chat booleans, a persona is a single radio choice. 'classic' is the
 * default (no badge, no injection — identical to the pre-persona behavior).
 * Other personas inject a mode-specific instruction block into the system
 * prompt and may restrict the tool set (read-only personas) or wrap a skill
 * (debugger/reviewer/refactorer/test-writer reuse existing builtin skills).
 *
 * The legacy planning/image/ask toggles are intentionally LEFT AS-IS and
 * remain orthogonal to personas — they are not merged here.
 *
 * Names are English-first (nameEn) with a Russian variant (nameRu) selected
 * by the dormant `language` setting in the renderer. All prompt content is
 * English for model reliability (see buildSystemPrompt.ts).
 */

export type PersonaId =
  | 'classic'
  | 'architect'
  | 'debugger'
  | 'reviewer'
  | 'refactorer'
  | 'test-writer'
  | 'mentor'

export type PersonaToolsProfile = 'full' | 'readonly'

export interface Persona {
  id: PersonaId
  /** English display name (badge + menu). */
  nameEn: string
  /** Russian display name, shown when settings.language === 'ru'. */
  nameRu: string
  /** English short description (menu subtitle). */
  descEn: string
  /** Russian short description. */
  descRu: string
  /** Badge / accent color (hex). 'classic' has none (no badge rendered). */
  color: string
  /** Inner SVG markup (paths) rendered inside a 24×24 viewBox. */
  iconSvg: string
  /** 'readonly' personas get the same tool restriction as planning/ask. */
  toolsProfile: PersonaToolsProfile
  /**
   * Fine-grained tool allowlist for this persona. If set — OVERRIDES the
   * binary toolsProfile branching in getToolSchemas: only the listed builtin
   * tools are available (plus all MCP tools, which are always allowed).
   * undefined = legacy behavior (full set for 'full', restricted set for
   * 'readonly'). Use this to give a persona a non-standard mix, e.g.
   * architect gets edits but not run_command, debugger gets run_command,
   * mentor is strict read-only with ask_user.
   *
   * Tool names are the builtin ones (see schemas.ts): read_file, read_files,
   * find_files, search_code, list_directory, think, update_working_memory,
   * update_todo, ask_user, save_memory, recall_memory, search_web,
   * fetch_page, search_images, analyze_image, spawn_agent, get_agent_status,
   * list_extensions, get_skill, edit_file, write_file, run_command,
   * get_diagnostics, analyze_project, get_fast_context, generate_image.
   */
  allowedTools?: string[]
  /** Optional builtin skill name whose instructions are injected for this
   *  persona (resolved in main via SkillManager). When set, the persona
   *  injection reuses the one-shot skill mechanism. */
  skillId?: string
}

/**
 * Tool allowlists for personas. See `allowedTools` field on `Persona`.
 *
 * BASE — tools available to every persona (research + memory + ask_user +
 * spawn_agent + skills). Always present unless the persona defines a
 * stricter custom list.
 * RESEARCH — read-only additions (no edits, no commands): diagnostics,
 * project analysis, fast context. Used by reviewer/mentor.
 * EDIT_FULL — full editing set: edit/write/run + research. Used by
 * debugger/refactorer/test-writer via `undefined` (inherit full), but listed
 * here for reference and for personas with non-standard mixes (architect).
 */
const TOOLS_BASE = [
  'read_file', 'read_files', 'find_files', 'search_code', 'list_directory',
  'think', 'update_working_memory', 'update_todo', 'ask_user',
  'save_memory', 'recall_memory', 'search_web', 'fetch_page', 'search_images',
  'analyze_image',
  'spawn_agent', 'get_agent_status', 'list_extensions', 'get_skill',
] as const

const TOOLS_RESEARCH = [
  'get_diagnostics', 'analyze_project', 'get_fast_context',
] as const

const TOOLS_EDIT_NO_RUN = [
  'edit_file', 'write_file',
] as const

/** Architect: edits for scaffolding, but no run_command (architect designs,
 *  doesn't execute code). Research tools to understand structure. */
const ALLOWED_ARCHITECT = [...TOOLS_BASE, ...TOOLS_EDIT_NO_RUN, ...TOOLS_RESEARCH]
/** Reviewer: strict read-only research — report issues without edits. */
const ALLOWED_REVIEWER = [...TOOLS_BASE, ...TOOLS_RESEARCH]
/** Mentor: strict read-only — explain and teach, no edits/commands.
 *  ask_user (in BASE) for Socratic clarification. */
const ALLOWED_MENTOR = [...TOOLS_BASE, ...TOOLS_RESEARCH]

/** Inner SVG for each persona (lucide-style 24×24, stroke=currentColor). */
const ICONS = {
  architect:
    '<path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 12v.01"/><path d="M9 15v.01"/><path d="M9 18v.01"/>',
  debugger:
    '<path d="M12 3a6 6 0 0 0-4 10.5c.5.5 1 1.5 1 2.5h6c0-1 .5-2 1-2.5A6 6 0 0 0 12 3z"/><path d="M9 21h6"/><path d="M10 16v5"/><path d="M14 16v5"/>',
  reviewer:
    '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  refactorer:
    '<path d="M4 4l6 6"/><path d="M20 4l-6 6"/><path d="M4 20l6-6"/><path d="M20 20l-6-6"/>',
  testWriter:
    '<path d="M9 2h6l1 3h4v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5h4z"/><path d="M9 13l2 2 4-4"/>',
  mentor:
    '<path d="M12 14l9-5-9-5-9 5 9 5z"/><path d="M12 14v7"/><path d="M5 11v4l7 4 7-4v-4"/>',
} as const

export const PERSONAS: Persona[] = [
  {
    id: 'classic',
    nameEn: 'Classic',
    nameRu: 'Классический',
    descEn: 'Default coding agent — full toolset, no mode injection',
    descRu: 'Обычный режим — полный набор инструментов, без специализации',
    color: '',
    iconSvg: '',
    toolsProfile: 'full',
  },
  {
    id: 'architect',
    nameEn: 'Architect',
    nameRu: 'Архитектор',
    descEn: 'High-level design and structure, may scaffold files',
    descRu: 'Дизайн структуры проекта, может создавать каркас файлов',
    color: '#7c8cff',
    iconSvg: ICONS.architect,
    toolsProfile: 'full',
    allowedTools: [...ALLOWED_ARCHITECT],
  },
  {
    id: 'debugger',
    nameEn: 'Debugger',
    nameRu: 'Дебаггер',
    descEn: 'Focus on finding and fixing bugs',
    descRu: 'Фокус на поиске и исправлении багов',
    color: '#f59e0b',
    iconSvg: ICONS.debugger,
    toolsProfile: 'full',
    skillId: 'debug-helper',
  },
  {
    id: 'reviewer',
    nameEn: 'Reviewer',
    nameRu: 'Ревьюер',
    descEn: 'Code review — read-only, reports issues without edits',
    descRu: 'Код-ревью — только чтение, отчёт без правок',
    color: '#a78bfa',
    iconSvg: ICONS.reviewer,
    toolsProfile: 'readonly',
    skillId: 'code-review',
    allowedTools: [...ALLOWED_REVIEWER],
  },
  {
    id: 'refactorer',
    nameEn: 'Refactorer',
    nameRu: 'Рефакторщик',
    descEn: 'Safe refactoring preserving behavior',
    descRu: 'Безопасный рефакторинг с сохранением поведения',
    color: '#22d3ee',
    iconSvg: ICONS.refactorer,
    toolsProfile: 'full',
    skillId: 'refactor',
  },
  {
    id: 'test-writer',
    nameEn: 'Test Writer',
    nameRu: 'Тестописатель',
    descEn: 'Generate and extend test suites',
    descRu: 'Генерация и расширение тестов',
    color: '#2dd4bf',
    iconSvg: ICONS.testWriter,
    toolsProfile: 'full',
    skillId: 'test-generation',
  },
  {
    id: 'mentor',
    nameEn: 'Mentor',
    nameRu: 'Ментор',
    descEn: 'Explain code and teach concepts — read-only',
    descRu: 'Объяснение кода и обучение — только чтение',
    color: '#34d399',
    iconSvg: ICONS.mentor,
    toolsProfile: 'readonly',
    allowedTools: [...ALLOWED_MENTOR],
  },
]

export const DEFAULT_PERSONA: PersonaId = 'classic'

const PERSONA_MAP: Record<PersonaId, Persona> = PERSONAS.reduce(
  (acc, p) => { acc[p.id] = p; return acc },
  {} as Record<PersonaId, Persona>,
)

export function getPersona(id: PersonaId): Persona {
  return PERSONA_MAP[id] ?? PERSONA_MAP.classic
}

export function isReadonlyPersona(id: PersonaId): boolean {
  return getPersona(id).toolsProfile === 'readonly'
}

/**
 * Returns the fine-grained tool allowlist for a persona, or undefined if
 * the persona inherits the default set (full for 'full' profile, restricted
 * for 'readonly' profile). When undefined, the caller falls back to the
 * binary toolsProfile branching. When defined, the caller MUST filter the
 * builtin tool schemas to this list (MCP tools are always allowed in
 * addition).
 */
export function getPersonaAllowedTools(id: PersonaId): string[] | undefined {
  return getPersona(id).allowedTools
}

/** True if the id is a valid persona (defensive — stored as TEXT in DB). */
export function isValidPersona(id: string | undefined | null): id is PersonaId {
  return !!id && id in PERSONA_MAP
}
