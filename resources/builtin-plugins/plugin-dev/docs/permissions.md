# Права (permissions)

Каждое право гейтит семейство host-API. Вызов API без права кидает `Permission denied: … требует "<perm>"`. Права показываются пользователю в consent-диалоге при первом включении. Неизвестные права лоадер молча вырезает — плагин упадёт при вызове, поэтому сверяй имена.

| Право | Что даёт |
|---|---|
| `net` | `net.fetch` (HTTP), `net.ws.*` (WebSocket), `shell.openExternal` |
| `fs:read` | `fs.readFile` / `fs.listDir` / `fs.stat` (любые пути) + `fs.watch` |
| `fs:write` | `fs.writeFile` / `mkdir` / `delete` / `rename` / `copy` / `writeFiles` **только внутри папки плагина** |
| `fs:write:any` | Запись/создание/удаление в **любых** путях (для генераторов проектов и т.п.) |
| `clipboard` | `clipboard.readText` / `writeText` |
| `notifications` | `notifications.show` (системные уведомления, кнопки-actions) |
| `ui` | `registerUi` / `registerPanel` / виджеты / модалки / `statusbar` / `sound.play` / `window.toast/dialog` / `fs.pickFile/pickDir/pickFiles/saveDialog` / markdown-рендереры / поиск / autocomplete / контекстное меню / input actions / темы / фоны / **кастомные теги сообщений** (`ui.registerMessageTag`) / **live-карточка прогресса** (`ui.beginProgress`) / **секции в настройках** (`registerSettingsSection`) / action-кнопки виджетов |
| `chat` | `chat.send` / `chat.reply` / **стриминг ответа** (`chat.beginReply` / `appendChunk` / `endReply`) |
| `chats:read` | `chats.list` / `chats.get` / **`chats.getMessages`** (пагинация) / `chats.getAttachments` / `chats.open` / **`chat.getActive`** |
| `chats:write` | `chats.create/rename/delete`, `chats.appendMessage/editMessage/deleteMessage` |
| `projects:read` | `projects.list` / `projects.current` |
| `projects:write` | `projects.create` |
| `memory` | `memory.search` / `memory.save` / `memory.chat.*` |
| `ai` | `ai.chat` (LLM хоста, вкл. vision, стриминг и **function calling** `tools`/`chatContext`), `ai.embed`, `ai.listModels`, `ai.generateImage` |
| `scheduler` | `scheduler.every` / `cron` / `at` |
| `shortcuts` | `registerShortcut` / `unregisterShortcut` (глобальные горячие клавиши) |
| `process:exec` | `process.exec` (shell-команды через хост, таймаут ≤ 120 с) |
| `overlay` | `overlay.show` / `hide` (окно поверх всего) |
| `tray` | `tray.setMenu` / `clearMenu` |
| `context` | `registerContextProvider` (динамический markdown в system prompt) и `registerPromptSection` / `unregisterPromptSection` (статическая секция промпта на время работы плагина) |
| `secrets` | `secrets.get/set/delete` (шифрованное хранилище, safeStorage) |
| `git` | `git.status/diff/log/commit/branches` |
| `mcp` | `mcp.listTools` / `mcp.call` (тулы MCP-серверов приложения) |
| `webhook` | `net.listen` / `net.close` (локальный HTTP-сервер) |
| `agent` | `agent.useTool` (host-туры), `agent.run` (субагент; пишущие тулы — дополнительно `fs:write:any`) |
| `hooks` | Подписка на события контента: `chat:message`, `chat:before-send`, `chat:completed`, `message:delta`, `tool:call`, `tool:result`, `prompt:before-build` (чтение/изменение переписки и промпта) + `prompt.get` (чтение финального system prompt) |
| `provider` | `provider.register` / `provider.unregister` — плагин как провайдер моделей (появляется в Настройках → Провайдеры; живёт, пока плагин запущен) |
| `settings:read` | `settings.get` — публичные настройки приложения (тема, платформа, версия, locale) — только чтение |
| `speech` | `speech.tts` (синтез речи → base64 MP3) / `speech.stt` (локальный Whisper: WAV → текст) |

## Таблица API → permission

| API | Право |
|---|---|
| `chat.send` / `chat.reply` / `chat.beginReply` / `appendChunk` / `endReply` | `chat` |
| `chat.getActive`, `chats.list/get/getMessages/getAttachments/open` | `chats:read` |
| `chats.create/rename/delete/appendMessage/editMessage/deleteMessage` | `chats:write` |
| `projects.list/current` | `projects:read` |
| `projects.create` | `projects:write` |
| `memory.search/save/chat.*` | `memory` |
| `ai.chat/embed/listModels/generateImage` | `ai` |
| `agent.useTool/run` | `agent` |
| `mcp.listTools/call` | `mcp` |
| `net.fetch`, `net.ws.*`, `shell.openExternal` | `net` |
| `net.listen/close` (webhook-сервер) | `webhook` |
| `git.status/diff/log/commit/branches` | `git` |
| `process.exec` | `process:exec` |
| `scheduler.every/cron/at` | `scheduler` |
| `registerShortcut` / `unregisterShortcut` | `shortcuts` |
| `tray.setMenu/clearMenu` | `tray` |
| `overlay.show/hide` | `overlay` |
| `fs.readFile/listDir/stat/watch` | `fs:read` |
| `fs.writeFile/mkdir/delete/rename/copy/writeFiles` (в папке плагина) | `fs:write` |
| запись в любых путях | `fs:write:any` |
| `clipboard.readText/writeText` | `clipboard` |
| `notifications.show` | `notifications` |
| `secrets.get/set/delete` | `secrets` |
| `prompt.get`; хуки `chat:*`, `message:delta`, `tool:*`, `prompt:before-build` | `hooks` |
| `registerContextProvider` / `registerPromptSection` | `context` |
| `registerUi/registerPanel/registerSettingsSection`, `ui.beginProgress`, `ui.registerMessageTag`, `ui.openModal`, виджеты, `fs.pickFile/pickDir/pickFiles/saveDialog`, … | `ui` |
| `provider.register/unregister` | `provider` |
| `settings.get` | `settings:read` |
| `speech.tts` / `speech.stt` | `speech` |

## Принципы

- **Минимум прав**: проси только то, что реально используешь — consent-диалог показывает весь список, `fs:write:any` и `process:exec` пугают пользователей.
- `fs:write` достаточно для своих данных (кэш, состояние) — пиши в `syntee.pluginDir`.
- `fs:write:any` — для плагинов-генераторов (создание проектов, файлов пользователя). Помни: запись вне песочницы — доверенная операция.
- Права проверяются в рантайме при каждом вызове — фильтр лоадера + проверка хоста.
