# Архитектура плагина — как писать объёмные плагины

Плагины поддерживают **многофайловую структуру**: код через `require('./файл')`, UI через относительные пути в HTML, ассеты — файлами в папке плагина. Эта секция — правила, по которым объёмный плагин остаётся поддерживаемым.

> **Правило для AI**: любой плагин кроме тривиального (1–2 тула, без состояния) создавай через `create_plugin` с `structure: "multi"`. Это дефолт для хорошей архитектуры.

## Структура папки (multi)

```
my-plugin/
├── plugin.json          ← манифест (источник истины)
├── readme.md            ← описание для карточки в UI
├── dist/                ← код (Node, CJS)
│   ├── index.js         ← ТОЛЬКО wiring: activate → подключает модули
│   ├── state.js         ← общее состояние + доступ к API
│   ├── tools.js         ← тулы для AI (registerTool)
│   ├── commands.js      ← слэш-команды (registerCommand)
│   ├── ui.js            ← registerPanel + RPC-хендлеры (ui.handle)
│   └── lib/             ← своя логика: api-клиенты, парсеры, утилиты
│       ├── github.js
│       └── format.js
└── ui/                  ← интерфейс (iframe)
    ├── panel.html       ← разметка
    ├── css/panel.css    ← стили
    └── js/
        ├── bridge.js    ← мост synteeBridge (копируй как есть)
        └── panel.js     ← логика панели
```

## Правила

### 1. index.js — только wiring, ноль логики

```js
const { registerTools } = require('./tools')
const { registerCommands } = require('./commands')
const { registerPanel, registerHandlers } = require('./ui')
const state = require('./state')

module.exports.activate = function (syntee) {
  state.init(syntee)
  registerTools(syntee)
  registerCommands(syntee)
  registerPanel(syntee)
  registerHandlers(syntee)
}

module.exports.deactivate = function () {
  state.cleanup()
}
```

### 2. state.js — единая точка доступа к API и очистке

Все модули берут API из `state.api`, а не параметром — тогда таймеры и колбэки всегда имеют доступ. Всё, что надо останавливать, регистрируется через `state.every()` и чистится в `deactivate` автоматически.

```js
let api = null
const timers = new Set()

module.exports = {
  get api() { return api },
  init(syntee) { api = syntee },
  every(intervalMs, fn) {
    const t = setInterval(fn, intervalMs)
    timers.add(t)
    return () => { clearInterval(t); timers.delete(t) }
  },
  cleanup() {
    for (const t of timers) clearInterval(t)
    timers.clear()
    api = null
  },
}
```

### 3. Модули = домены, а не слои

Один файл — одна зона ответственности: `tools.js` (тулы), `commands.js`, `ui.js` (панель+RPC), `lib/*.js` (интеграции: `lib/github.js`, `lib/jira.js`). Не делай `utils.js`-свалку — называй по смыслу (`format.js`, `dates.js`).

### 4. Тулы тонкие, логика в lib

Handler тула — валидация + вызов lib + форматирование ответа. Вся работа (HTTP-клиенты, кэш, парсинг) — в `lib/`. Тогда один и тот же код переиспользуется тулами, командами и панелью:

```js
// dist/tools.js
const state = require('./state')
const github = require('./lib/github')

function registerTools(syntee) {
  syntee.registerTool({
    name: 'list_issues',
    description: 'List open issues of a GitHub repo',
    parameters: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
    handler: async ({ repo }) => {
      const issues = await github.listIssues(state.api, repo)
      return issues.map(i => `#${i.number} ${i.title}`).join('\n') || 'No open issues'
    },
  })
}
module.exports = { registerTools }
```

### 5. UI: html/css/js раздельно, мост — отдельным файлом

`bridge.js` (мост synteeBridge) — копируй из шаблона как есть. Логика панели — в `panel.js`. Хендлеры RPC — в `dist/ui.js` рядом с registerPanel, чтобы UI-код плагина жил в одном месте.

### 6. Данные — не в коде

- Персистентное состояние → `syntee.storage` (KV, изолирован по pluginId).
- Настройки пользователя → `syntee.config` (схема в манифесте `config`).
- Секреты → `syntee.secrets` (шифрованные). Никогда не храни токены в storage/config.
- Файлы плагина (кэш) → `syntee.pluginDir`.

### 7. Ошибки и логи

- Ошибки в handler-ах тулов можно бросать — модель получит текст, процесс не упадёт.
- В фоновой логике (таймеры, watch, ws) — ВСЕГДА try/catch + `syntee.log.error(...)`: необработанный reject в фоне может уронить процесс.
- Уровни: `syntee.log.info/warn/error`.

## Когда single, когда multi

| Плагин | Структура |
|---|---|
| 1–2 тула, без состояния, без UI | `single` |
| Всё остальное | `multi` |

`create_plugin` с `structure: "multi"` генерирует каркас выше (index/state/tools/commands/ui + panel.html/css/js) — дальше наполняй модули.

## Ограничения

- **Только CJS** (`require` / `module.exports`), не ESM-импорты.
- **npm-пакеты поддерживаются** через `dependencies` в манифесте (см. runtimes): ставятся автоматически в `node_modules` папки плагина и резолвятся из utilityProcess. Нюансы: пакеты должны быть CJS-совместимыми, нативные `.node`-модули не гарантированы, ESM-only — бандлить заранее (esbuild).
- Hot reload следит за `dist/`, `ui/` и `plugin.json` — правка любого файла перезапускает плагин (дебаунс 800 мс). Данные в storage/своих папках вне dist/ui не триггерят reload.
