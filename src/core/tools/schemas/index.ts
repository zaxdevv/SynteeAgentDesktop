// ── Tool schemas barrel: combines all domain schemas + helpers ──────────

import type { McpToolRuntime, PluginToolRuntime } from '../../../shared/types'
import { isReadonlyPersona, getPersonaAllowedTools } from '../../../shared/modes'
import { READ_TOOL_SCHEMAS } from './read'
import { EDIT_TOOL_SCHEMAS } from './edit'
import { COMMAND_TOOL_SCHEMAS } from './command'
import { SEARCH_TOOL_SCHEMAS } from './search'
import { AGENT_TOOL_SCHEMAS } from './agent'
import { PLAN_TOOL_SCHEMAS } from './plan'
import { MEMORY_TOOL_SCHEMAS } from './memory'
import { EXTENSIONS_TOOL_SCHEMAS } from './extensions'
import { VISION_TOOL_SCHEMAS } from './vision'
import { DOTS_TOOL_SCHEMAS } from './dots'
import { CHAT_TOOL_SCHEMAS } from './chats'
import { BROWSER_TOOL_SCHEMAS, REQUEST_ACCESS_SCHEMA } from './browser'

export const TOOL_SCHEMAS = [
  ...EDIT_TOOL_SCHEMAS,
  ...COMMAND_TOOL_SCHEMAS,
  ...READ_TOOL_SCHEMAS,
  ...SEARCH_TOOL_SCHEMAS,
  ...AGENT_TOOL_SCHEMAS,
  ...PLAN_TOOL_SCHEMAS,
  ...MEMORY_TOOL_SCHEMAS,
  ...EXTENSIONS_TOOL_SCHEMAS,
  ...VISION_TOOL_SCHEMAS,
  ...DOTS_TOOL_SCHEMAS,
  ...CHAT_TOOL_SCHEMAS,
  ...BROWSER_TOOL_SCHEMAS,
  // Реестр — полный список для TOOL_BY_NAME; в конкретный тулсет чата
  // request_access попадает через names (когда browserMode ВЫКЛ).
  REQUEST_ACCESS_SCHEMA,
]

// Dynamic tool set — added by mode
const TOOL_BY_NAME = new Map<string, (typeof TOOL_SCHEMAS)[number]>(
  TOOL_SCHEMAS.map(schema => [schema.function.name, schema]),
)

function pickTools(names: string[]) {
  return names
    .map(name => TOOL_BY_NAME.get(name))
    .filter((schema): schema is NonNullable<typeof schema> => schema !== undefined)
}

export function getToolSchemas(options: {
  planningMode?: boolean
  askMode?: boolean
  webMode?: boolean
  imageMode?: boolean
  multiAgentMode?: boolean
  mode?: 'code' | 'work'  // deprecated — ignored; work mode removed
  /** Тумблер «Управление браузером»: browser_* тулы (navigate/snapshot/
   *  click/type/...). ВЫКЛ → в тулсете только request_access (универсальный
   *  тул запроса доступа); ВКЛ → 15 browser-тулов, request_access не нужен. */
  browserMode?: boolean
  /** Persona — single-select run mode. Read-only personas get the same
   *  restricted tool set as planning/ask (no edit/write/run). Full personas
   *  keep the full toolset. Orthogonal to planning/ask. */
  persona?: import('../../../shared/modes').PersonaId
  /** MCP tools — dynamically added to the set (only enabled ones). */
  mcpTools?: McpToolRuntime[]
  /** Plugin tools — dynamically added (only enabled + running plugins). */
  pluginTools?: PluginToolRuntime[]
} = {}) {
  const {
    planningMode = false,
    askMode = false,
    webMode = false,
    imageMode = false,
    multiAgentMode = false,
    browserMode = false,
    persona,
    mcpTools,
    pluginTools,
  } = options

  // Work mode removed — always a full Code tool set.
  // In planning mode — read-only + research: all research tools are available
  // (get_fast_context, analyze_project, search_code, read_file, ...), the
  // ask_user clarifying-question tool, but edits are FORBIDDEN (edit/write/
  // run_command/revert). The planner researches code → clarifies with the
  // user → writes the plan directly in the answer, wrapped in
  // <plan title="..." summary="...">…</plan>.
  //
  // askMode (read-only) — the same read-only tool set as planning, but
  // without requiring a <plan>. Used for "do not touch code" questions
  // (toggled in the plus-menu or one-shot via /ask <text>).
  // planning takes priority (stricter), but the tool set is identical —
  // the difference is only in the system injection.
  //
  // Persona allowlist: when a persona defines `allowedTools`, that list
  // OVERRIDES the binary readonly/full branching below. Only the listed
  // builtin tools are provided (plus all MCP tools, always allowed).
  // This lets architect (edits, no run_command), debugger (full + run),
  // reviewer (strict read-only research), mentor (read-only + ask_user) get
  // a non-standard mix tailored to their workflow.
  const personaAllowed = persona ? getPersonaAllowedTools(persona) : undefined

  const names: string[] = [
    'read_file',
    'read_files',
    'find_files',
    'search_code',
    'list_directory',
    'think',
    'update_working_memory',
    'update_todo',
    'ask_user',
    // Long-term memory: save_memory (write a fact) + recall_memory (find).
    // Always available — the model decides when to save/recall.
    'save_memory',
    'recall_memory',
    // Notes: manage project/chat notes (create/update/delete/list).
    'manage_notes',
    // Web search, page fetching, image search and sub-agents — always
    // available to the agent, the model decides when to use them.
    'search_web',
    'fetch_page',
    'search_images',
    // Image analysis (read-only research): the image is passed directly to
    // a vision-capable main model, or described by the auxiliary vision
    // model — the same routing as chat attachments.
    'analyze_image',
    'spawn_agent',
    'get_agent_status',
    'manage_chats',
    'list_extensions',
    'get_skill',
    // Универсальный тул запроса доступа к выключенным возможностям
    // (browser_control сейчас). Всегда в тулсете — модель знает, что можно
    // попросить. Когда browserMode ВКЛ — не добавляем (нечего запрашивать).
  ]

  if (!browserMode) {
    names.push('request_access')
  } else {
    // Управление браузером: 15 тулов (Playwright MCP-style).
    names.push(
      'browser_navigate',
      'browser_back',
      'browser_forward',
      'browser_reload',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_scroll',
      'browser_screenshot',
      'browser_tabs_list',
      'browser_tab_new',
      'browser_tab_select',
      'browser_tab_close',
      'browser_wait',
    )
  }

  if (personaAllowed) {
    // Fine-grained persona allowlist: use ONLY the persona's list (intersected
    // with builtin TOOL_SCHEMAS). MCP tools are appended later regardless.
    // generate_image is gated by imageMode even if the persona lists it.
    names.length = 0
    for (const t of personaAllowed) {
      if (t === 'generate_image') continue
      names.push(t)
    }
    // Ensure research tools are available if the persona is read-only-ish
    // (allowlists already include them explicitly — this is a safety net).
    if (!names.includes('get_diagnostics') && isReadonlyPersona(persona!)) {
      names.push('get_diagnostics', 'analyze_project', 'get_fast_context')
    }
  } else if (planningMode || askMode || (persona && isReadonlyPersona(persona))) {
    // Planning / Ask / read-only persona (legacy path): research tools, read-only checks, no edits.
    names.push('get_diagnostics')
    names.push('analyze_project')
    names.push('get_fast_context')
  } else {
    // Normal mode (or full persona without explicit allowlist): file edits + commands + verification.
    names.push('edit_file')
    names.push('write_file')
    names.push('run_command')
    names.push('get_diagnostics')
    names.push('analyze_project')
    names.push('get_fast_context')
    // Dots: управление always-on агентами — только в normal-режиме.
    // ask/planning/read-only и фоновые wake-раны Dot'ов (oneShotMode:'ask')
    // тул не получают: Dot не должен создавать других Dot'ов.
    names.push('manage_dots')
  }

  if (imageMode) {
    // generate_image only when imageMode is on AND the persona allows it
    // (allowlist personas that don't list it are denied; undefined/legacy
    // personas inherit the previous behavior — allowed in imageMode).
    if (!personaAllowed || personaAllowed.includes('generate_image')) {
      names.push('generate_image')
    }
  }
  // multiAgentMode/webMode are no longer needed for enabling — kept as
  // function parameters for compatibility with the calling code.
  void webMode
  void multiAgentMode

  const schemas = pickTools(names)

  // MCP tools — convert to OpenAI function schema and append.
  // Name: mcp__{serverName}__{toolName}, description from the MCP server.
  if (mcpTools && mcpTools.length > 0) {
    for (const tool of mcpTools) {
      schemas.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || `MCP tool ${tool.shortName} from server ${tool.serverName}`,
          parameters: tool.inputSchema && Object.keys(tool.inputSchema).length > 0
            ? tool.inputSchema
            : { type: 'object', properties: {} },
        },
      } as any)
    }
  }

  // Plugin tools — same conversion. Name: plugin__{pluginId}__{toolName}.
  if (pluginTools && pluginTools.length > 0) {
    for (const tool of pluginTools) {
      schemas.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || `Plugin tool ${tool.shortName} from plugin ${tool.pluginId}`,
          parameters: tool.inputSchema && Object.keys(tool.inputSchema).length > 0
            ? tool.inputSchema
            : { type: 'object', properties: {} },
        },
      } as any)
    }
  }

  return schemas
}

// ── Side-chat-only tool ────────────────────────────────────────────────
// This tool is available ONLY in the parallel side chat. It is not
// included in TOOL_SCHEMAS and is not given to regular chats via getToolSchemas.
// Lets the side agent request the main chat messages on demand
// (instead of passing the whole history in context — saves tokens).
export const GET_MAIN_CHAT_MESSAGES_SCHEMA = {
  type: 'function',
  function: {
    name: 'get_main_chat_messages',
    description: 'Get messages from the main chat (parallel to this side chat). Returns message text with role indicated. Use to find information in the main chat history.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of recent messages (default 15, max 50).',
        },
        search: {
          type: 'string',
          description: 'Substring to filter messages (case-insensitive). If given, returns only messages containing this substring.',
        },
      },
    },
  },
} as const
