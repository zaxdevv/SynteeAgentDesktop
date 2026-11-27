import * as path from 'path'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { getAllChats, getProjectById, getAllProjects, getChatModel, getChatSummary, getMessagesPage, getChatWorkdirContext } from '../../core/db'
import { stripAttachTokens } from '../../shared/attachmentMarkdown'
import { stripPlanTags } from '../../shared/planParser'
import { getToolSettings, isToolDisabled } from '../../shared/toolSettings'
import { mimeFromExt } from '../../shared/mentions'
import { ImageRequestBudget } from '../../shared/imageFormat'
import { normalizeImageForVision } from '../services/imageDownscale'
import { modelSupportsVisionByHeuristic } from '../../core/ai/visionSupport'
import { getMcpManager } from '../../core/mcp/McpManager'
import type { Attachment, AttachmentProcessingResult } from '../../shared/types'
import { previewAttachmentText } from '../../core/context/attachmentText'
import { compactStoredProjectScan } from '../../core/projectMap/projectScan'


  /**
   * Обработка вложений перед запуском агента:
   *  - Текстовые файлы инлайним в content (с лимитом 5МБ).
   *  - Картинки: vision-модель → direct pass (imageParts, без путей в
   *    content — модель видит пиксели сама). Text-only → только пути в
   *    content, модель сама вызывает analyze_image тул когда нужно.
   *  - Бинарные — только путь+имя+размер.
   *
   * Для vision direct pass эмитим agent:tool_progress с toolName
   * 'vision_recognition' — renderer показывает shimmer «Распознаю
   * изображения...» вместо обычного «Думаю...».
   *
   * Возвращает { content, result, imageParts } — augmented content,
   * структурированный результат (для БД) и imageParts для прямого пасса.
   */
export async function processAttachmentsAndStream(store: Store,
    win: BrowserWindow | null,
    chatId: string,
    msgId: string,
    content: string,
    attachments: Attachment[],
    contextWindow = 200_000,
  ): Promise<{ content: string; result: AttachmentProcessingResult | null; imageParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }> }> {
    if (attachments.length === 0) return { content, result: null, imageParts: [] }

    // require вместо await import для builtin: нативный import() не работает в V8-байткоде.
    // (относительные import() ниже rollup компилирует в require — они безопасны)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFile: fsReadFile, stat: fsStat, readdir: fsReaddir, mkdir: fsMkdir, writeFile: fsWriteFile } = require('fs/promises')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync, statSync, existsSync } = require('fs')
    const { isTextMime, isImageMime } = await import('../../shared/mentions')

    const startedAt = Date.now()

    const textBlocks: string[] = []
    let textBudget = Math.min(16_000, Math.max(256, Math.floor(contextWindow * 0.08)))
    const processedFiles: Array<{
      name: string
      kind: string
      status: 'text_inlined' | 'image_described' | 'binary_path' | 'error' | 'skipped'
      size?: number
      detail?: string
      description?: string
    }> = []
    let hasErrors = false

    // ── Vision capability check: если основная модель поддерживает vision,
    //    передаём картинки напрямую (без промежуточного описания через vision-модель).
    //    ВНИМАНИЕ: storeData из runChatSend НЕ доступен тут (processAttachmentsAndStream —
    //    сиблинг runChatSend, не вложенная функция). Используем store.get() напрямую.
    const modelAssignments = store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    let mainAssignment = modelAssignments?.find(a => a.role === 'main')
    // Per-chat модель: если у чата задана своя — она важнее глобального
    // назначения main (решает, видит ли модель картинки напрямую).
    try {
      const chatModel = getChatModel(chatId)
      if (chatModel) mainAssignment = { role: 'main', modelId: chatModel.modelId, providerId: chatModel.modelProvider }
    } catch { /* ok */ }

    // Эвристика vision-способности вынесена в src/core/ai/visionSupport.ts —
    // общий модуль: используется и здесь (вложения), и в тулe analyze_image
    // (core/tools/image.ts). Решение «модель видит сама / нужна вспомогательная
    // vision-модель» всегда принимается одинаково, в одном месте.
    let mainModelSupportsVision = false
    if (mainAssignment) {
      mainModelSupportsVision = modelSupportsVisionByHeuristic(mainAssignment.providerId, mainAssignment.modelId)
    }
    const imageParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }> = []


    // ── Phase 1: Первый проход — некартинки (последовательно, быстрый I/O) ──
    // Картинки собираем в imageAtts для параллельной обработки во втором проходе.
    const imageAtts: Array<{ att: Attachment; index: number }> = []

    for (const att of attachments) {
      // ── Ссылка на чат (@пикер): инлайним титул + summary + последние
      //    сообщения — модель понимает, на какой чат ссылается юзер
      //    («@чат про рефакторинг — что там решили?»). ──
      if (att.kind === 'chat') {
        if (!att.chatId) {
          processedFiles.push({ name: att.name, kind: att.kind, status: 'skipped', detail: 'Чат без ID (ссылка битая)' })
          continue
        }
        try {
          const chat = getAllChats().find(c => c.id === att.chatId)
          if (!chat) throw new Error('Чат не найден (удалён?)')
          const parts: string[] = [`Чат «${chat.title}» (${chat.messageCount ?? '?'} сообщений, обновлён ${new Date(chat.updatedAt).toLocaleString('ru')})`]
          const summary = getChatSummary(att.chatId)
          if (summary) parts.push(`Краткое содержание чата:\n${summary.slice(0, 2000)}${summary.length > 2000 ? '\n…(обрезано)' : ''}`)
          // Последние сообщения: getMessagesPage без курсора = новейшие N в ASC.
          // Берём с запасом (system-сообщения отфильтруются), slice(-6) — итог.
          const msgs = getMessagesPage(att.chatId, 12).messages.filter(m => m.role !== 'system').slice(-6)
          if (msgs.length > 0) {
            const dialog = msgs.map(m => {
              const who = m.role === 'user' ? 'Пользователь' : 'Ассистент'
              const clean = stripAttachTokens(stripPlanTags(m.content)).trim()
              return `${who}: ${clean.slice(0, 600)}${clean.length > 600 ? '…' : ''}`
            }).join('\n\n')
            parts.push(`Последние сообщения (${msgs.length}):\n${dialog}`)
          }
          textBlocks.push(`─── Чат: ${chat.title} ───\n${parts.join('\n\n')}\n─── Конец чата: ${chat.title} ───`)
          processedFiles.push({
            name: att.name,
            kind: att.kind,
            status: 'text_inlined',
            detail: `Чат: summary + ${Math.min(6, Math.max(0, (chat.messageCount ?? 0)))} последних сообщений инлайнено`,
          })
        } catch (e) {
          hasErrors = true
          const errMsg = (e as Error).message
          textBlocks.push(`[Ссылка на чат «${att.name}» недоступна: ${errMsg}]`)
          processedFiles.push({ name: att.name, kind: att.kind, status: 'error', detail: errMsg })
        }
        continue
      }

      // ── Ссылка на проект (@пикер): инлайним имя + workdir + projectContext
      //    (результат analyzeProject, сохранённый при создании) — модель
      //    получает контекст проекта без повторного анализа. ──
      if (att.kind === 'project') {
        if (!att.projectId) {
          processedFiles.push({ name: att.name, kind: att.kind, status: 'skipped', detail: 'Проект без ID (ссылка битая)' })
          continue
        }
        try {
          const proj = getProjectById(att.projectId)
          if (!proj) throw new Error('Проект не найден (удалён?)')
          const parts: string[] = [`Проект «${proj.name}»\nРабочая директория: ${proj.workdir}`]
          const projectContext = compactStoredProjectScan(proj.projectContext, proj.workdir)
          if (projectContext) {
            parts.push(`Контекст проекта (анализ при создании):\n${projectContext.slice(0, 4000)}${projectContext.length > 4000 ? '\n…(обрезано)' : ''}`)
          }
          if (proj.verificationCommand) parts.push(`Команда проверки: ${proj.verificationCommand}`)
          textBlocks.push(`─── Проект: ${proj.name} ───\n${parts.join('\n\n')}\n─── Конец проекта: ${proj.name} ───`)
          processedFiles.push({
            name: att.name,
            kind: att.kind,
            status: 'text_inlined',
            detail: `Проект: workdir${projectContext ? ' + контекст' : ''} инлайнено`,
          })
        } catch (e) {
          hasErrors = true
          const errMsg = (e as Error).message
          textBlocks.push(`[Ссылка на проект «${att.name}» недоступна: ${errMsg}]`)
          processedFiles.push({ name: att.name, kind: att.kind, status: 'error', detail: errMsg })
        }
        continue
      }

      // ── MCP-сервер, прикреплённый к сообщению (чип kind='mcp'): модель
      //    получает имя сервера и список его инструментов в контексте этого
      //    запроса (сервер включён, тулы уже в тулсете рана). ──
      if (att.kind === 'mcp') {
        let toolNames: string[] = []
        try {
          const { workdir: mcpWorkdir } = getChatWorkdirContext(chatId)
          const mcpProjectId = mcpWorkdir ? getAllProjects().find(p => p.workdir === mcpWorkdir)?.id : undefined
          toolNames = getMcpManager().getActiveToolsForChat({
            projectWorkdir: mcpWorkdir,
            projectId: mcpProjectId,
            isIncognito: false,
          })
            .filter(t => t.serverId === att.mcpServerId)
            .map(t => t.shortName)
        } catch { /* сервер ещё подключается — блок без списка тулов */ }
        const lines = [`MCP-сервер «${att.name}» прикреплён к этому запросу.`]
        lines.push(toolNames.length > 0
          ? `Инструменты сервера: ${toolNames.join(', ')}.`
          : 'Его инструменты доступны как mcp__<server>__<tool>, когда сервер подключён.')
        lines.push('Используй его инструменты, когда они уместны для задачи; остальное — обычным набором.')
        textBlocks.push(`─── ${lines.join('\n')} ───`)
        processedFiles.push({
          name: att.name,
          kind: att.kind,
          status: 'text_inlined',
          detail: toolNames.length > 0 ? `MCP: ${toolNames.length} тулов` : 'MCP-сервер',
        })
        continue
      }

      if (att.kind === 'skill' || att.kind === 'command' || !att.path) {
        processedFiles.push({
          name: att.name,
          kind: att.kind,
          status: 'skipped',
          detail: att.kind === 'skill' ? 'Скилл (обрабатывается отдельно)'
            : att.kind === 'command' ? 'Команда (обрабатывается отдельно)'
            : 'Без пути к файлу',
        })
        continue
      }

      try {
        const st = await fsStat(att.path)
        if (st.isDirectory()) {
          // Листинг содержимого: агент видит, что внутри, и может читать
          // файлы по пути (read_file) без дополнительных запросов к юзеру.
          let listing = ''
          let total = 0
          const dirPath = String(att.path ?? '')
          try {
            const entries = await fsReaddir(dirPath, { withFileTypes: true })
            const visible = entries.filter((e: { name: string }) =>
              !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'out')
            total = visible.length
            const shown = visible.slice(0, 100)
            const { statSync, join: pathJoin } = require('path') as typeof import('path') & { statSync: (p: string) => { size: number } }
            const lines = shown.map((e: { name: string; isDirectory: () => boolean }) => {
              if (e.isDirectory()) return `- ${e.name}/`
              try {
                const sz = statSync(pathJoin(dirPath, e.name)).size
                return `- ${e.name} (${(sz / 1024).toFixed(1)} KB)`
              } catch { return `- ${e.name}` }
            })
            listing = lines.length > 0
              ? `\n${lines.join('\n')}${total > 100 ? `\n…и ещё ${total - 100} записей` : ''}`
              : '\n(пусто)'
          } catch { /* нет доступа — просто путь */ }
          textBlocks.push(`[Директория: ${att.name}] (путь: ${att.path}, записей: ${total})${listing}\nЧитай нужные файлы из директории по полному пути.`)
          processedFiles.push({ name: att.name, kind: att.kind, status: 'binary_path', size: 0, detail: `Директория (${total} записей, листинг в контексте)` })
        } else if (att.kind === 'image' || isImageMime(att.mime)) {
          // Картинку откладываем для параллельной обработки во втором проходе.
          const idx = processedFiles.length
          imageAtts.push({ att, index: idx })
          processedFiles.push({ name: att.name, kind: att.kind, status: 'image_described', size: st.size, description: '' })
        } else if (att.kind === 'video' || att.kind === 'audio' || /^(video|audio)\//.test(att.mime || mimeFromExt(att.path))) {
          const mediaKind = att.kind === 'video' || (att.mime || mimeFromExt(att.path)).startsWith('video/') ? 'video' : 'audio'
          const toolName = mediaKind === 'video' ? 'analyze_video' : 'analyze_audio'
          const disabled = isToolDisabled(toolName, getToolSettings(store))
          const detail = disabled
            ? `${toolName} выключен в настройках — содержимое не проанализировано.`
            : `Используй ${toolName} с этим локальным путём и вопросом пользователя; содержимое ещё не проанализировано. Нужна назначенная модель и поддерживаемый транспорт.`
          textBlocks.push(`[Прикреплён ${mediaKind === 'video' ? 'видеофайл' : 'аудиофайл'}: ${att.name}] (${(st.size / 1024).toFixed(1)} KB, путь: ${att.path})\n${detail}`)
          processedFiles.push({ name: att.name, kind: mediaKind, status: 'binary_path', size: st.size, detail })
        } else {
          // Текстовый или бинарный файл
          const mime = att.mime || ''
          if (isTextMime(mime) && st.size <= 5 * 1024 * 1024) {
            if (textBudget < 256) {
              textBlocks.push(`[Файл: ${att.name}; путь: ${att.path}. Лимит превью вложений исчерпан. Читай нужные участки через read_file/search_code.]`)
              processedFiles.push({ name: att.name, kind: att.kind, status: 'binary_path', size: st.size, detail: 'Лимит превью — полный файл доступен по пути' })
              continue
            }
            const fileContent = await fsReadFile(att.path, 'utf-8')
            const preview = await previewAttachmentText(fileContent, Math.min(8_000, textBudget) - 64)
            textBudget -= preview.tokens + 64
            textBlocks.push(`─── Файл: ${att.relPath || att.name}; полный путь: ${att.path} ───\n${preview.text}\n─── Конец ${preview.truncated ? 'превью' : 'файла'}: ${att.relPath || att.name} ───`)
            processedFiles.push({
              name: att.name,
              kind: att.kind,
              status: 'text_inlined',
              size: st.size,
              detail: preview.truncated
                ? `${(st.size / 1024).toFixed(1)} KB — превью, ~${preview.tokens} токенов; полный файл доступен по пути`
                : `${(st.size / 1024).toFixed(1)} KB — содержимое инлайнено`,
            })
          } else {
            textBlocks.push(`[Прикреплён файл: ${att.name}] (${(st.size / 1024).toFixed(1)} KB, путь: ${att.path})`)
            processedFiles.push({
              name: att.name,
              kind: att.kind,
              status: 'binary_path',
              size: st.size,
              detail: `${(st.size / 1024).toFixed(1)} KB — только путь`,
            })
          }
        }
      } catch (e) {
        hasErrors = true
        const errMsg = (e as Error).message
        textBlocks.push(`[Файл недоступен: ${att.name} — ${errMsg}]`)
        processedFiles.push({ name: att.name, kind: att.kind, status: 'error', detail: errMsg })
      }
    }

    // ── Phase 2: Обработка картинок ──
    // Если основная модель поддерживает vision — direct pass (без vision-модели).
    if (imageAtts.length > 0 && mainModelSupportsVision) {
      // Бюджет пикселей на сообщение: провайдеры считают лимиты на ВЕСЬ запрос
      // (≤2000 px на картинку, когда их несколько; ≤5 МБ base64 на картинку).
      // Раньше файл читался целиком без проверок: бинарь с именем *.png или
      // 4K-скриншот уходили в контекст как base64 и роняли запрос 400/413.
      const imageBudget = new ImageRequestBudget()
      for (const { att } of imageAtts) {
        const attIdx = imageAtts.findIndex(x => x.att === att)
        try {
          if (!att.path) throw new Error('attachment has no file path')
          const st = statSync(att.path)
          if (!st.isFile()) throw new Error('not a regular file')
          const raw = readFileSync(att.path)
          // Проверяем реальные байты и при необходимости УМЕНЬШАЕМ изображение
          // (Electron nativeImage, main-процесс) — вместо отказа делаем кадр,
          // который провайдер реально примет.
          const normalized = normalizeImageForVision(raw)
          if (!normalized.ok) throw new Error(normalized.error)
          const { bytes, mime, width, height, downscaled } = normalized.image
          const base64 = bytes.toString('base64')
          const payloadInfo = { base64Bytes: base64.length, width, height }
          const reason = imageBudget.reject(payloadInfo)
          if (reason) throw new Error(reason)
          imageBudget.accept(payloadInfo)
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' },
          })
          if (attIdx >= 0) {
            processedFiles[attIdx] = {
              ...processedFiles[attIdx],
              status: 'image_described',
              description: downscaled
                ? 'Передано напрямую в основную модель (уменьшено до лимитов vision)'
                : 'Передано напрямую в основную модель (vision)',
            }
          }
        } catch (e) {
          const errMsg = (e as Error).message
          textBlocks.push(`[Ошибка чтения изображения: ${att.name} — ${errMsg}]`)
          if (attIdx >= 0) {
            processedFiles[attIdx] = { ...processedFiles[attIdx], status: 'error', detail: errMsg }
          }
          hasErrors = true
        }
      }
      // Эмитим vision_recognition — для shimmer-индикатора «Распознаю изображения...»
      // (вместо убранного блока AttachmentProcessingBlock). Промоутит streamMsgId.
      if (imageParts.length > 0) {
        win?.webContents.send('agent:tool_progress', {
          msgId, chatId,
          toolName: 'vision_recognition',
          stage: 'analyzing',
          detail: `Распознаю ${imageParts.length} ${imageParts.length === 1 ? 'изображение' : 'изображений'}...`,
          ts: Date.now(),
        })
      }
      // Пути НЕ добавляем — модель уже видит пиксели через imageParts,
      // пути только сбивают её и заставляют вызывать analyze_image тул.
    } else if (imageAtts.length > 0) {
      // Text-only модель: НЕ делаем upfront-анализ через vision-модель.
      // Просто передаём пути картинок — модель сама вызовет analyze_image
      // тул с нужными параметрами (вопрос, фокус) когда ей понадобится.
      // Путь ведём на НОРМАЛИЗОВАННУЮ копию (≤2000 px, ≤ лимита байт): иначе
      // analyze_image упёрся бы в «image is too large» на 4K-скриншоте, а
      // исходник в workdir мог бы вообще не копироваться в draft-attachments.
      const visionDir = path.join(app.getPath('userData'), 'draft-attachments', chatId)
      const pathLines: string[] = []
      for (const { att, index } of imageAtts) {
        let modelPath = att.path
        try {
          if (att.path && existsSync(att.path)) {
            const normalized = normalizeImageForVision(readFileSync(att.path))
            if (!normalized.ok) {
              pathLines.push(`- ${att.name}: НЕ изображение (${normalized.error})`)
              processedFiles[index] = { ...processedFiles[index], status: 'error', detail: normalized.error }
              hasErrors = true
              continue
            }
            if (normalized.image.downscaled) {
              await fsMkdir(visionDir, { recursive: true })
              modelPath = path.join(visionDir, `vision-${pathHash(att.path)}${normalized.image.ext}`)
              await fsWriteFile(modelPath, normalized.image.bytes)
            }
          }
        } catch { /* оставляем исходный путь: analyze_image сообщит причину сам */ }
        pathLines.push(`- ${att.name}: ${modelPath}`)
        processedFiles[index] = {
          ...processedFiles[index],
          status: 'image_described',
          description: 'Путь передан модели — analyze_image по требованию',
        }
      }
      textBlocks.push(`[Прикреплённые изображения (доступны через analyze_image):]\n${pathLines.join('\n')}`)
    }

    // Собираем augmented content.
    // Если пользователь отправил ТОЛЬКО вложение (без текста) — content пустой,
    // и модель получала бы голый блок «[Прикреплённые изображения...]» без
    // задачи → часто отвечала «не вижу вложения». Подставляем дефолтную
    // инструкцию, чтобы у модели был явный повод обработать вложение
    // (analyze_image для картинок / ответ по содержимому файла).
    const baseContent = content.trim()
      ? content
      : 'Проанализируй прикреплённые вложения: опиши содержимое и дай ответ.'
    const augmentedContent = textBlocks.length > 0
      ? `${baseContent}\n\n${textBlocks.join('\n\n')}`
      : baseContent

    // Структурированный результат для сохранения в message
    const result: AttachmentProcessingResult = {
      files: processedFiles,
      totalProcessed: processedFiles.filter(f => f.status !== 'skipped' && f.status !== 'error').length,
      totalErrors: processedFiles.filter(f => f.status === 'error').length,
      totalImages: processedFiles.filter(f => f.status === 'image_described').length,
      ms: Date.now() - startedAt,
      hasErrors,
    }

    return { content: augmentedContent, result, imageParts }
  }

  /**
 * Короткий стабильный хэш пути: имя нормализованной копии вложения
 * переиспользуется между отправками, а не плодит дубликаты.
 */
export function pathHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}
