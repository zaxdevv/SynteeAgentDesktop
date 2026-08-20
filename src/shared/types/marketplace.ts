// ── Marketplace (каталог MCP-серверов и Skills) ──────────────────────────

/** Требование к переменной окружения MCP-сервера (из registry). */
export interface McpEnvVarRequirement {
  name: string
  description: string
  isRequired: boolean
  isSecret: boolean
}

/** Требование к HTTP-заголовку удалённого MCP-сервера. */
export interface McpHeaderRequirement {
  name: string
  description: string
  isRequired: boolean
  isSecret: boolean
  value?: string
}

/** Вариант установки через удалённый транспорт (sse / streamable-http). */
export interface McpRemoteOption {
  type: 'sse' | 'streamable-http'
  url: string
  headers?: McpHeaderRequirement[]
}

/** Вариант установки через локальный пакет (stdio). */
export interface McpPackageOption {
  registryType: 'npm' | 'pypi' | 'oci'
  identifier: string
  version: string
  /** Подсказка исполняемой среды: 'npx' | 'uvx' | 'docker'. */
  runtimeHint?: string
  packageArguments?: string[]
  environmentVariables?: McpEnvVarRequirement[]
  /** Позиционные параметры для GUI (пути, строки подключения и т.д.). */
  positionalArgs?: Array<{
    label: string
    placeholder: string
    defaultValue?: string
    isRequired?: boolean
  }>
}

/** Элемент каталога MCP Registry для маркетплейса. */
export interface MarketplaceMcpServer {
  id: string
  title: string
  description: string
  version: string
  repositoryUrl?: string
  websiteUrl?: string
  iconUrl?: string
  remotes: McpRemoteOption[]
  packages: McpPackageOption[]
}

/** Элемент каталога Skills (GitHub-репозиторий) для маркетплейса. */
export interface MarketplaceSkill {
  id: string
  name: string
  fullName: string
  description: string
  htmlUrl: string
  stars: number
  language: string | null
  topics: string[]
  license: string | null
  updatedAt: string
}
