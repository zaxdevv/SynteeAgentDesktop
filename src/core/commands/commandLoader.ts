/**
 * Загрузчик кастомных slash-команд — markdown-файлов с расширенным YAML frontmatter.
 *
 * Источники (приоритет возрастает — проектные перекрывают пользовательские
 * перекрывают builtin-пакетные при совпадении name):
 *   1. builtin  — resources/commands/ (вшиты в дистрибутив, source='builtin')
 *   2. user     — {userData}/commands/ (source='user')
 *   3. project  — {workdir}/.syntee/commands/ (source='project', коммитится в репозиторий)
 *
 * Формат файла:
 *   ---
 *   name: review                       # имя команды (без /)
 *   description: Режим код-ревьюера     # короткое описание для меню
 *   icon: eye                          # имя иконки из AppIcon (опционально)
 *   argument-hint: файл или модуль     # подсказка аргумента (опционально)
 *   placeholder: что ревьюить...       # placeholder инпута (опционально)
 *   mode: ask                          # 'ask' | 'plan' | 'code' (опционально, default='code')
 *   skill: code-review                 # id скилла для one-shot активации (опционально)
 *   allowed-tools: read_file, search_code, think   # список тулов (опционально, comma-separated)
 *   ---
 *   Тело файла — шаблон systemPrompt. $ARGS подставляется аргументом команды.
 *   Если $ARGS нет — аргумент просто дописывается в конец.
 *
 * Парсер frontmatter минимален (как в skillLoader): плоский key: value, без
 * вложенностей/массивов. allowed-tools — comma-separated строка, не YAML-массив.
 */

import { existsSync, statSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { SlashCommand, SlashCommandSource, SlashCommandMode, CommandArgument } from '../../shared/slashCommands'

interface ParsedFrontmatter {
  name?: string
  description?: string
  icon?: string
  argumentHint?: string
  placeholder?: string
  mode?: SlashCommandMode
  skill?: string
  allowedTools?: string[]
  arguments?: CommandArgument[]
  raw: Record<string, string>
}

/** Минимальный YAML-парсер для плоских key: value. Поддерживает kebab-case. */
function parseFlatYaml(text: string): ParsedFrontmatter {
  const raw: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) continue
    let val = m[2].trim()
    // Снимаем кавычки
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    raw[m[1]] = val
  }
  // Нормализуем kebab-case → camelCase для известных полей
  return {
    name: raw.name,
    description: raw.description,
    icon: raw.icon,
    argumentHint: raw['argument-hint'],
    placeholder: raw.placeholder,
    mode: (raw.mode as SlashCommandMode | undefined) ?? undefined,
    skill: raw.skill,
    allowedTools: raw['allowed-tools']
      ? raw['allowed-tools'].split(',').map(s => s.trim()).filter(Boolean)
      : undefined,
    arguments: parseArgumentsBlock(text),
    raw,
  }
}

/**
 * Парсер блока `arguments:` из frontmatter. Поддерживает минимальный
 * YAML-массив объектов с отступами:
 *
 *   arguments:
 *     - name: mode
 *       description: Режим выполнения
 *       choices: ask, plan, code
 *       default: ask
 *       required: true
 *     - name: target
 *       choices: frontend, backend
 *
 * Под-поля (description/choices/default/required) привязываются к
 * текущему аргументу. choices — comma-separated строка (как allowed-tools).
 * Возвращает undefined если блока нет или он пуст.
 */
function parseArgumentsBlock(fmText: string): CommandArgument[] | undefined {
  const lines = fmText.split(/\r?\n/)
  let i = 0
  // Ищем строку `arguments:` на верхнем уровне (без отступа, без значения).
  for (; i < lines.length; i++) {
    if (/^arguments\s*:\s*$/.test(lines[i])) { i++; break }
  }
  if (i >= lines.length) return undefined
  const args: CommandArgument[] = []
  let cur: CommandArgument | null = null
  for (; i < lines.length; i++) {
    const line = lines[i]
    // Конец блока — строка без отступа и непустая (новый топ-уровень ключ).
    if (line.length > 0 && !/^\s/.test(line)) break
    // Пропуск пустых строк внутри блока.
    if (!line.trim()) continue
    // Новый аргумент: `- name: value`
    const itemMatch = line.match(/^\s+-\s+name\s*:\s*(.*)$/)
    if (itemMatch) {
      if (cur) args.push(cur)
      cur = { name: unquote(itemMatch[1].trim()) }
      continue
    }
    if (!cur) continue
    // Под-поле текущего аргумента.
    const fieldMatch = line.match(/^\s+(description|choices|default|required)\s*:\s*(.*)$/)
    if (!fieldMatch) continue
    const key = fieldMatch[1]
    const val = fieldMatch[2].trim()
    if (key === 'choices') {
      cur.choices = val ? val.split(',').map(s => unquote(s.trim())).filter(Boolean) : []
    } else if (key === 'required') {
      cur.required = val === 'true' || val === 'yes' || val === '1'
    } else if (key === 'default') {
      cur.default = unquote(val) || undefined
    } else if (key === 'description') {
      cur.description = unquote(val) || undefined
    }
  }
  if (cur) args.push(cur)
  return args.length > 0 ? args : undefined
}

/** Снимает окружающие кавычки (одинарные/двойные). */
function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

/**
 * Разбирает .md-файл команды: frontmatter + тело-шаблон systemPrompt.
 * Шаблон может содержать $ARGS — подставляется аргументом команды.
 * Если $ARGS нет — аргумент дописывается в конец через пробел.
 */
function parseCommandFile(filePath: string, source: SlashCommandSource): SlashCommand | null {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }

  const basename = filePath.split(/[\\/]/).pop() ?? filePath
  const nameNoExt = basename.replace(/\.md$/i, '')

  let name = nameNoExt
  let description = ''
  let icon = 'command'
  let argumentHint: string | undefined
  let placeholder: string | undefined
  let mode: SlashCommandMode | undefined
  let skill: string | undefined
  let allowedTools: string[] | undefined
  let cmdArguments: CommandArgument[] | undefined
  let template = content

  // frontmatter: файл начинается с --- на первой строке
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (fmMatch) {
    const fm = parseFlatYaml(fmMatch[1])
    if (fm.name) name = fm.name
    description = fm.description ?? ''
    if (fm.icon) icon = fm.icon
    argumentHint = fm.argumentHint
    placeholder = fm.placeholder
    mode = fm.mode
    skill = fm.skill
    allowedTools = fm.allowedTools
    cmdArguments = fm.arguments
    template = fmMatch[2] ?? ''
  } else {
    // Без frontmatter: первая непустая строка = описание
    const lines = content.split(/\r?\n/)
    for (const ln of lines) {
      const t = ln.trim()
      if (t) { description = t; break }
    }
  }

  template = template.trim()
  if (!template) return null

  // Валидация имени: только [a-z0-9_-], lowercase
  const validName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  if (!validName) return null

  // Строим systemPrompt-генератор из шаблона.
  // Если шаблон содержит $ARGS — подставляем. Иначе — дописываем args в конец.
  const hasArgsPlaceholder = template.includes('$ARGS')
  const systemPrompt = (args: string) => {
    if (hasArgsPlaceholder) {
      return template.replace(/\$ARGS/g, args || '')
    }
    return args ? `${template}\n\nArgument: ${args}` : template
  }

  return {
    name: validName,
    label: `/${validName}`,
    description: description || validName,
    icon,
    argumentHint,
    placeholder,
    systemPrompt,
    source,
    filePath,
    allowedTools,
    mode,
    skill,
    arguments: cmdArguments,
    custom: true,
  }
}

/** Сканирует папку и возвращает команды из всех .md файлов (не рекурсивно). */
function scanDir(dir: string, source: SlashCommandSource): SlashCommand[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const cmds: SlashCommand[] = []
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.md')) continue
    const full = join(dir, entry)
    try {
      if (!statSync(full).isFile()) continue
    } catch { continue }
    const cmd = parseCommandFile(full, source)
    if (cmd) cmds.push(cmd)
  }
  return cmds
}

/**
 * Загружает ВСЕ кастомные команды из всех источников.
 *
 * @param projectWorkdir — workdir текущего проекта (для проектных команд).
 *   Если undefined — проектные команды не загружаются.
 * @param builtinDir — переопределять только в тестах.
 */
export function loadAllCommands(projectWorkdir?: string, builtinDir?: string): SlashCommand[] {
  const out: SlashCommand[] = []

  // 1. builtin — вшитые команды. В packed-приложении лежат в resources/commands.
  let builtinPath = builtinDir
  if (!builtinPath) {
    try {
      builtinPath = join(process.resourcesPath ?? '', 'commands')
    } catch {
      builtinPath = ''
    }
  }
  if (builtinPath && existsSync(builtinPath)) {
    out.push(...scanDir(builtinPath, 'builtin'))
  }

  // 2. user — глобальная папка пользователя.
  let userDir = ''
  try {
    userDir = join(app.getPath('userData'), 'commands')
  } catch { /* app может быть недоступен в тестах */ }
  if (userDir) {
    out.push(...scanDir(userDir, 'user'))
  }

  // 3. project — .syntee/commands/ в workdir.
  if (projectWorkdir) {
    const projectDir = join(projectWorkdir, '.syntee', 'commands')
    out.push(...scanDir(projectDir, 'project'))
  }

  // Dedup по name: при совпадении оставляем с более высоким приоритетом
  // (project > user > builtin). Массив уже в порядке возрастания приоритета,
  // поэтому идём с конца, перезаписывая.
  const byName = new Map<string, SlashCommand>()
  for (const cmd of out) {
    byName.set(cmd.name, cmd)
  }
  return Array.from(byName.values())
}
