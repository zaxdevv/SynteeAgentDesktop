# plugin.json — манифест

Единственный обязательный файл. Парсится при скане; невалидный JSON или отсутствие полей → плагин не попадает в список.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "author": "You",
  "description": "Короткое описание для списка в UI",
  "promptDescription": "Short description for the system prompt (~200 chars): what the plugin does and which tools it gives.",
  "main": "dist/index.js",
  "ui": "ui/panel.html",
  "readme": "readme.md",
  "configUi": "ui/settings.html",
  "permissions": ["fs:read", "net"],
  "config": [
    { "key": "apiKey", "label": "API-ключ", "type": "password", "default": "", "placeholder": "sk-…", "description": "Ключ сервиса" },
    { "key": "limit", "label": "Лимит", "type": "number", "default": 10 },
    { "key": "verbose", "label": "Подробный лог", "type": "boolean", "default": false }
  ],
  "builtin": false
}
```

## Поля

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | string | ✓ | Уникальный slug, `[a-zA-Z][a-zA-Z0-9_-]*`, **должен совпадать с именем папки** |
| `name` | string | ✓ | Отображаемое имя |
| `version` | string | ✓ | Semver-подобная версия |
| `author` | string | | Автор |
| `description` | string | | Описание для карточки в UI |
| `promptDescription` | string | | ~200 символов для system prompt — AI видит это и понимает назначение плагина. **Пиши по-английски, перечисли тулы.** |
| `main` | string | ✓ | Entry-файл (относительный путь, **CJS-модуль**). Экспортирует `activate(syntee)` и опционально `deactivate()` |
| `ui` | string | | HTML-файл UI по умолчанию (для registerPanel без entry, ui.openModal без entry) |
| `readme` | string | | Путь до markdown-описания (по умолчанию `readme.md`) — рендерится в карточке |
| `configUi` | string | | Кастомный UI настроек (HTML-iframe ВМЕСТО декларативной формы `config`). Общается через `synteeBridge.call` → `syntee.ui.handle`, сохраняет через свой хендлер |
| `permissions` | string[] | | Права (см. секцию permissions). Неизвестные права молча вырезаются лоадером |
| `config` | Field[] | | Декларативная схема настроек — форма в карточке плагина. Значения читаются через `syntee.config.get(key)` |
| `activation` | string[] | | События активации (пока информационные; дефолт `onLoad`). Задел: `'onLoad'`, `'chat:message'`, `'command:<name>'` |
| `apiVersion` | string | | Версия plugin API, под которую написан плагин (`'1'` — текущая). При мажорных изменениях API хост предупредит в журнале |
| `runtime` | string | | `"node"` (по умолчанию) или `"python"` — рантайм логики. Python: sidecar-процесс, SDK `from syntee import syntee` (см. секцию runtimes) |
| `runtimePath` | string | | Явный путь до интерпретатора Python (override авто-детекта; можно venv). Только при `runtime:"python"` |
| `requirements` | string[] | | pip-зависимости Python-плагина (`"requests"`, `"rich>=13"`). Ставятся автоматически при первом запуске + кнопка в карточке UI |
| `dependencies` | string[] | | npm-зависимости Node-плагина (`"lodash"`, `"dayjs@1.11"`). Ставятся автоматически (`npm install --omit=dev` в папку плагина) + кнопка в карточке UI. Только CJS-совместимые пакеты; нативные модули не гарантированы |
| `builtin` | boolean | | Только для встроенных плагинов (ставится приложением). Не указывай в своих |

## Корневые поля объекта syntee (в activate)

Кроме методов API, объект `syntee` несёт метаданные:

```js
module.exports.activate = (syntee) => {
  syntee.pluginDir     // абсолютный путь до папки плагина (свои ресурсы/файлы)
  syntee.permissions   // string[] — права, реально выданные плагину (после consent)
  syntee.version       // версия хоста (приложения) — для совместимости API
}
```

## Что требует какого права (шпаргалка)

| API | Право |
|---|---|
| `chat.beginReply` / `appendChunk` / `endReply` / `chat.send` / `chat.reply` | `chat` |
| `chat.getActive` | `chats:read` |
| `prompt.get` | `hooks` |
| `registerPromptSection` / `unregisterPromptSection` / `registerContextProvider` | `context` |
| `ui.registerMessageTag` | `ui` |
| `registerSettingsSection` / `unregisterSettingsSection` | `ui` |
| `ui.beginProgress` | `ui` |
| `fs.pickFiles` / `fs.saveDialog` | `ui` |
| `chats.getMessages` | `chats:read` |
| `provider.register` / `provider.unregister` | `provider` |
| `settings.get` | `settings:read` |
| `speech.tts` / `speech.stt` | `speech` |

Полный список прав — в секции **permissions**.

## Config-поля

Декларативная схема настроек — хост сам рисует форму в карточке плагина (вкладка «Плагины» → «Подробнее»). Пользователь редактирует значения в UI, плагин читает их через `syntee.config.get(key)` / `getAll()`.

```jsonc
"config": [
  { "key": "apiKey",   "label": "API-ключ",       "type": "password", "default": "",  "placeholder": "sk-…", "description": "Ключ сервиса" },
  { "key": "limit",    "label": "Лимит",           "type": "number",   "default": 10, "min": 1, "max": 100, "step": 1 },
  { "key": "verbose",  "label": "Подробный лог",   "type": "boolean",  "default": false },
  { "key": "mode",     "label": "Режим",           "type": "select",   "default": "auto",
    "options": ["auto", "fast", "precise"] },
  { "key": "sources",  "label": "Источники",       "type": "multiselect", "default": ["github"],
    "options": [{ "value": "github", "label": "GitHub" }, { "value": "gitlab", "label": "GitLab" }] },
  { "key": "prompt",   "label": "Промпт",          "type": "textarea", "placeholder": "Текст…" },
  { "key": "accent",   "label": "Акцент",          "type": "color",    "default": "#22d3ee" }
]
```

| Поле | Типы | Описание |
|---|---|---|
| `type` | `string` \| `password` \| `number` \| `boolean` \| `select` \| `multiselect` \| `textarea` \| `color` | Тип контрола: текст / скрытый текст / число / тумблер / выпадающий список / чипы (несколько сразу) / многострочный текст / цвет |
| `default` | `string` \| `number` \| `boolean` \| `string[]` | Значение по умолчанию (для `multiselect` — массив). Кнопка «По умолчанию» в форме сбрасывает к нему |
| `placeholder` | `string` | Подсказка в поле |
| `description` | `string` | Подсказка под полем (и tooltip) |
| `options` | `(string \| {value,label})[]` | Варианты для `select` / `multiselect` |
| `min`, `max`, `step` | `number` | Границы и шаг для `type:'number'` |

Для сложных настроек (зависимые поля, валидация, свой layout) — см. `configUi` выше: свой HTML вместо декларативной формы.

## Правила entry (main)

- CJS (`module.exports`), не ESM.
- `activate(syntee)` вызывается после спавна процесса; бросок ошибки → статус `error`.
- `deactivate()` вызывается при graceful stop (выключение/reload) — чисти таймеры, соединения, shortcut-ы.
- Внутри процесса доступен Node.js (`require('path')`, `console` и т.д.) — это изоляция процесса, а не песочница. Опасные операции гейтятся правами на уровне host-моста.
