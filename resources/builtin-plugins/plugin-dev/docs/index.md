# Плагины SynteeHelper — обзор и быстрый старт

Плагин — папка с `plugin.json` (манифест) + entry-кодом + опционально UI (HTML в iframe) и доками. Код плагина исполняется в **изолированном utilityProcess** (отдельный процесс внутри приложения). **Рантайм — Node.js (по умолчанию, CJS) или Python** (`"runtime": "python"` — sidecar-процесс, см. секцию runtimes). Хост-функции (LLM, файлы, чаты, уведомления и т.д.) доступны через объект `syntee` — в JS он передаётся в `activate(syntee)`, в Python это `from syntee import syntee`. Каждое API-семейство гейтится **правами** из манифеста — пользователь подтверждает их при первом включении плагина.

## Расположение

| Тип | Путь |
|---|---|
| Глобальные | `{userData}/plugins/{id}/` (Windows: `%APPDATA%/SynteeHelper/plugins/{id}/`) |
| Проектные | `{workdir}/.syntee/plugins/{id}/` |
| Встроенные | поставляются с приложением, синхронизируются в глобальную папку при запуске, обновляются вместе с приложением, удалить нельзя (только выключить) |

## Структура папки

```
my-plugin/
  plugin.json      # манифест (обязательно)
  dist/index.js    # entry (CJS): activate(syntee) / deactivate()
  readme.md        # описание для карточки в UI
  ui/panel.html    # опционально: iframe-панель
  docs/…           # опционально: свои ресурсы
```

## Минимальный плагин

```js
// dist/index.js
module.exports.activate = function (syntee) {
  syntee.registerTool({
    name: 'hello',
    description: 'Поздороваться',
    parameters: { type: 'object', properties: { name: { type: 'string' } } },
    handler: async (args) => 'Привет, ' + (args.name || 'мир') + '!',
  })
}

module.exports.deactivate = function () {}
```

```json
// plugin.json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "Что делает плагин",
  "promptDescription": "Tool hello greets the user by name.",
  "main": "dist/index.js",
  "permissions": []
}
```

## Жизненный цикл

1. Плагин появляется в списке (вкладка «Плагины» в extensions-поповере) после скана папки.
2. **Выключен по умолчанию** (opt-in). Включение → consent-диалог прав → запуск процесса.
3. Изменение файлов папки → **hot-reload** запущенного плагина (fs.watch, дебаунс 800 мс).
4. Крах процесса → статус `error`, перезапуск вручную (кнопка «Перезагрузить»).

## Как AI видит плагин

- Тулы доступны модели как `plugin__{pluginId}__{toolName}` (в карточке UI — короткое имя).
- `promptDescription` манифеста (~200 симв.) попадает в system prompt — AI понимает, зачем плагин и что умеют его тулы.
- **`registerPromptSection`** добавляет в промпт статическую markdown-секцию плагина (справки, памятки).
- **`registerMessageTag`** добавляет в промпт список кастомных тегов — AI вставляет их в ответ, приложение рендерит как карточки.
- Слэш-команды `/name` — в автокомплите поля ввода, выполняются до отправки агенту.

## Возможности, о которых стоит знать

- **Стриминг ответа в чат** — `chat.beginReply` / `chat.appendChunk` / `chat.endReply` (и `chat.getActive`); удобно транслировать ответ LLM из `ai.chat({ stream: true })`. См. **api-chat**.
- **Секции system prompt** — `registerPromptSection` / `unregisterPromptSection` (статично на всё время работы) против `registerContextProvider` (на каждый запрос) и хука `prompt:before-build` (полная замена). Плюс `prompt.get()` — чтение финального промпта. См. **api-system**, **permissions**.
- **Кастомные теги сообщений** — `ui.registerMessageTag` (`ui`) с iframe-рендером и `widgetData { attrs, inner }`. См. **ui**.
- **Провайдер моделей** — `provider.register` (`provider`): плагин как OpenAI-совместимый endpoint; модели появляются в Настройках → Провайдеры и назначаются на роли. См. **api-system**.
- **Function calling в `ai.chat`** — тулы плагина (`tools`) + история чата (`chatContext: true`). См. **api-ai**.
- **Live-карточка прогресса** — `ui.beginProgress` (`ui`) для долгих тулов; у виджетов — action-кнопки. См. **ui**.
- **Подтверждение тулов** — `requiresApproval: true` в `registerTool` для мутабельных операций (деплой, удаление). См. **tools**.
- **Пагинация сообщений** — `chats.getMessages` (`chats:read`); хук `chat:message` несёт role/messageId/attachments. См. **api-chat**.
- **Секция в настройках** — `registerSettingsSection` (`ui`), системные диалоги — `fs.pickFiles` / `fs.saveDialog`. См. **ui**.
- **Голос** — `speech.tts` / `speech.stt` (`speech`). См. **api-ai**.
- **Публичные настройки** — `settings.get` (`settings:read`). См. **api-system**.

## Создание плагина

**Не пиши файлы руками** — вызови тул `create_plugin` плагина **plugin-dev** (встроенный):

```
create_plugin({
  id: "my-plugin",
  structure: "multi",        // многофайловая архитектура — дефолт для всего кроме тривиального
  name: "My Plugin",
  description: "…",
  promptDescription: "…",
  permissions: ["fs:read", "net"],
  tools: [{ name: "do_thing", description: "…", parameters: {…} }],
  commands: [{ name: "mycmd", description: "…" }],
  withUi: true
})
```

Он сгенерирует корректный скаффолд. `structure: "multi"` — модульную структуру (index.js-вiring + tools/commands/state/ui + ui/css/js), `structure: "single"` — всё в одном `dist/index.js` (только для мелких). **Перед созданием объёмного плагина прочитай секцию architecture.** Дальше правь файлы — hot-reload следит за `dist/` и `ui/` целиком и перезапускает плагин сам.

## Карта документации

- **architecture** — как строить объёмные плагины: модули, state, cleanup, когда multi
- **manifest** — все поля plugin.json
- **permissions** — все права и что каждое гейтит
- **tools** — registerTool: тулы для AI
- **commands** — слэш-команды
- **ui** — панели, iframe, протокол syntee-plugin://, мост synteeBridge
- **contributions** — виджеты, поиск, autocomplete, контекстное меню, темы, фоны, statusbar
- **api-core** — storage, config, fs, clipboard, notifications, sound, window, bus
- **api-chat** — chat, chats (пагинация `getMessages`, хук `chat:message`), projects, memory
- **api-ai** — ai.chat (вкл. tools/chatContext), embed, listModels, generateImage, speech, agent, mcp
- **api-system** — net, shell, git, process, scheduler, shortcuts, tray, overlay, secrets, prompt (чтение промпта, секции), provider, settings
- **events** — все события on() и хуки (before-send, tool:result, prompt:before-build)
- **examples** — готовые примеры и шаблоны
