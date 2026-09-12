# API: сеть, git, процесс, планировщик, шорткаты, трей, секреты

## net — HTTP и WebSocket (`net`)

```js
// HTTP через main (лимит тела 1 МБ)
const r = await syntee.net.fetch('https://api.example.com/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer …' },
  body: JSON.stringify({ q: 1 }),
})
// r: { status, headers, body }  — body это строка

// WebSocket (данные — событиями)
syntee.on('ws:message', (p) => { /* p: { id, data } */ })
await syntee.net.ws.connect('quotes', 'wss://stream.example.com/ws')
syntee.net.ws.send('quotes', JSON.stringify({ sub: 'BTC' }))
syntee.net.ws.close('quotes')
// также события 'ws:open' | 'ws:close' | 'ws:error' с полем id
```

## webhook — локальный HTTP-сервер (`webhook`)

```js
syntee.net.listen(9876, (req) => {
  // req: { method, path, body } — body это строка
  if (req.path === '/hook') {
    syntee.notifications.show('Webhook', req.body.slice(0, 200))
  }
})
syntee.net.close(9876)
```

Внешние сервисы (GitHub, Telegram и т.п.) могут дергать `http://localhost:9876/…`.

## git (`git`)

```js
const st = await syntee.git.status(workdir)
// { branch, ahead, behind, clean, files: [{ path, status }] }
const diff = await syntee.git.diff(workdir, { staged: false, file: 'src/a.ts' })
const log = await syntee.git.log(workdir, 20)     // [{ hash, author, date, message }]
const out = await syntee.git.commit(workdir, 'fix: bug', { addAll: true })
const brs = await syntee.git.branches(workdir)    // [{ name, current }]
```

## process — shell-команды (`process:exec`)

```js
const { stdout, stderr, code } = await syntee.process.exec('git status --short', {
  cwd: workdir,
  timeoutMs: 30000,        // ≤ 120000
})
```

Лимит вывода 1 МБ. Для тяжёлых задач — `agent.run`.

## scheduler (`scheduler`)

```js
const stop1 = syntee.scheduler.every(60000, async () => { /* раз в минуту */ })
const stop2 = syntee.scheduler.cron('0 9 * * 1-5', async () => { /* пн-пт 9:00 */ })
const stop3 = syntee.scheduler.at(5000, async () => { /* через 5 сек */ })
// отмена: stop1() — или ничего не делай, при stop плагина задачи снимаются
```

## shortcuts — глобальные горячие клавиши (`shortcuts`)

```js
syntee.registerShortcut('Ctrl+Shift+N', () => syntee.ui.openModal({ entry: 'ui/quick.html' }))
syntee.unregisterShortcut('Ctrl+Shift+N')
```

Формат Electron: `'Ctrl+Shift+P'`, `'Alt+1'`, `'CommandOrControl+Shift+K'`.

## tray — меню трея (`tray`)

```js
syntee.tray.setMenu([
  { label: 'Быстрое действие', command: 'mycmd' },   // клик → слэш-команда
  { type: 'separator' },
  { label: 'Открыть панель' },                        // без command → событие 'tray:action' { label }
])
syntee.tray.clearMenu()
```

## prompt — system prompt (`hooks` / `context`)

```js
// Чтение ФИНАЛЬНОГО промпта (после сборки секций и хука prompt:before-build).
// permission 'hooks'
const text = await syntee.prompt.get(chatId)   // chatId опционален — по умолчанию активный чат

// Статическая секция промпта на всё время работы плагина.
// permission 'context': в промпт добавляется markdown-блок «### {title}»
syntee.registerPromptSection({
  id: 'kanban-hint',          // опционально, по умолчанию = title
  title: 'Канбан-доска',
  content: 'Используй тег <kanban> для визуализации задач.',
})
syntee.unregisterPromptSection('kanban-hint')   // или без аргумента — по id/title
```

### Три способа вмешаться в промпт

| Способ | Право | Когда вызывается | Что делает |
|---|---|---|---|
| `registerContextProvider` | `context` | **на каждый запрос** | динамический markdown — данные, зависящие от чата/времени |
| `registerPromptSection` | `context` | один раз при регистрации | **статический** markdown-блок `### title` на всё время работы плагина |
| хук `prompt:before-build` | `hooks` | на каждый запрос, последний этап | полная замена/правка уже собранного промпта (`{ action: 'modify', content }`) |

Правило: статичный текст (справка о тегах, памятка) → `registerPromptSection`; живые данные (задачи, состояние) → `registerContextProvider`; тотальная переработка промпта → `prompt:before-build`.

## secrets — шифрованное хранилище (`secrets`)

API-ключи и токены — НЕ в plugin.json и не в storage (открытый JSON). safeStorage ОС:

```js
await syntee.secrets.set('api_key', 'sk-…')
const key = await syntee.secrets.get('api_key')     // string | undefined
await syntee.secrets.delete('api_key')
```

## provider — плагин как провайдер моделей (`provider`)

Плагин может зарегистрировать свой OpenAI-совместимый endpoint — он появится в **Настройках → Провайдеры**, его модели можно назначать на роли:

```js
await syntee.provider.register({
  id: 'my-llm',              // уникальный id (неймспейсится: plugin-{pluginId}-{id})
  name: 'My LLM Service',
  baseUrl: 'https://api.myllm.dev/v1',   // OpenAI-compatible endpoint
  apiKey: 'sk-…',            // опционально — лучше хранить в syntee.secrets
  models: ['my-model-1', 'my-model-2'],  // опционально; без него — запрос к /models
})
await syntee.provider.unregister('my-llm')
```

Провайдер **живёт, пока запущен плагин**: при остановке/крахе процесса он автоматически удаляется из store. Ключ не обязан лежать в манифесте — доставай его из `syntee.secrets.get('api_key')` прямо при регистрации.

## settings — публичные настройки приложения (`settings:read`)

Только чтение — тема, платформа, версия приложения (изменение настроек плагинам не даётся):

```js
const s = await syntee.settings.get()
// s: { theme, accentColor, dark, streaming, platform, appVersion, locale }
```

## Типичный фоновый плагин

```js
module.exports.activate = function (syntee) {
  const check = async () => {
    const r = await syntee.net.fetch('https://api.example.com/status')
    if (JSON.parse(r.body).down) {
      syntee.notifications.show('Сервис упал', 'Проверь api.example.com')
    }
  }
  syntee.scheduler.every(300000, check)   // раз в 5 минут
  check()
}
```
