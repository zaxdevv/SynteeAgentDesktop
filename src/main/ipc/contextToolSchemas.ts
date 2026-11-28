/**
 * Единый источник tool-схем для оценки контекста.
 *
 * Раньше `chat:send` считал по реальным схемам (`getToolSchemas(...)` с MCP и
 * плагинами), а `context:calculate` подставлял константу
 * `TOOL_SCHEMAS_OVERHEAD = 4200`. Одна и та же метрика считалась двумя разными
 * способами: кольцо показывало одно число сразу после отправки и другое после
 * переключения чата — «то норм, то накручено».
 *
 * Собираем тот же набор, что уходит в запрос. Все источники синхронные:
 * getActiveToolsForChat отдаёт только уже подключённые серверы/запущенные
 * плагины, подключение никогда не ожидается.
 */
import type Store from 'electron-store'
import { getToolSchemas } from '../../core/tools'
import { getAllProjects, getChatBrowserMode, getChatMode, getChatModes, getChatWorkdirContext } from '../../core/db'
import { getMcpManager } from '../../core/mcp/McpManager'
import { getPluginManager } from '../../core/plugins/pluginManager'
import { initialMcpSchemas } from '../../core/agent/deferredMcpTools'
import { getContextSettings, type ChatMessage } from '../../core/context/contextManager'
import { getToolSettings, isToolDisabled } from '../../shared/toolSettings'

export function buildContextToolSchemas(store: Store, chatId: string, history: ChatMessage[]): unknown[] {
  const modes = getChatModes(chatId)
  let mcpTools: unknown[] | undefined
  let pluginTools: unknown[] | undefined
  try {
    const { workdir } = getChatWorkdirContext(chatId) ?? {}
    const projectId = workdir ? getAllProjects().find(p => p.workdir === workdir)?.id : undefined
    mcpTools = getMcpManager().getActiveToolsForChat({ projectWorkdir: workdir, projectId, isIncognito: false })
    pluginTools = getPluginManager().getActiveToolsForChat({ projectWorkdir: workdir, projectId }) as unknown[]
  } catch { /* MCP/плагины недоступны — считаем без них, чат падать не должен */ }

  const schemas = getToolSchemas({
    customToolsEnabled: store.get('customToolsEnabled', false) === true,
    disabledTools: store.get('disabledTools', []) as string[],
    planningMode: modes.planningMode,
    askMode: modes.askMode,
    imageMode: modes.imageMode,
    browserMode: getChatBrowserMode(chatId),
    mode: getChatMode(chatId),
    mcpTools: mcpTools as never,
    pluginTools: pluginTools as never,
  })
  const settings = getContextSettings({ contextSettings: store.get('contextSettings') })
  const deferred = settings.deferredMcpTools && !isToolDisabled('discover_mcp_tools', getToolSettings(store))
  return initialMcpSchemas(schemas, history, deferred)
}
