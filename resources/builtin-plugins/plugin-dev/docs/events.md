# События и хуки — syntee.on(event, handler)

Подписка на события хоста. Fire-and-forget события — просто колбэк; **хуки** — колбэк с ответом (`return { action: 'modify' | 'reject', … }`), хост ждёт результат (таймаут 1.5 с).

> **Permission `hooks`**: события контента (`chat:message`, `chat:before-send`, `chat:completed`, `message:delta`, `tool:call`, `tool:result`, `prompt:before-build`) требуют permission `"hooks"` в манифесте — без него плагин не может читать/менять переписку и промпт. Остальные события доступны без прав.

## Хуки (могут менять поведение)

### chat:before-send — перехват отправки сообщения

```js
syntee.on('chat:before-send', (p) => {
  // p: { chatId, content }
  if (p.content.includes('пароль')) {
    return { action: 'reject', reason: 'В сообщении есть секрет — отправка заблокирована' }
  }
  if (p.content.includes('/old')) {
    return { action: 'modify', content: p.content.replace('/old', '/new') }
  }
  // undefined / нет return / { action: 'allow' } — пропустить как есть
})
```

### tool:result — модификация результата тула (до модели)

```js
syntee.on('tool:result', (p) => {
  // p: { toolName, args, result }
  if (p.toolName === 'read_file' && String(p.result).includes('REDACTED')) {
    return { action: 'modify', content: String(p.result).replaceAll('REDACTED', '***') }
  }
})
```

### prompt:before-build — последний шанс изменить system prompt

```js
syntee.on('prompt:before-build', (p) => {
  // p: { chatId, prompt }
  return { action: 'modify', content: p.prompt + '\n\n## Дополнение от плагина\n…' }
})
```

Хук вызывается **последним** — после сборки секций и context-провайдеров. Читать финальный промпт без изменения можно через `syntee.prompt.get(chatId?)`; статические секции — через `syntee.registerPromptSection({ title, content })` (см. api-system).

## События (уведомления)

| Событие | Payload | Когда |
|---|---|---|
| `chat:message` | `{ chatId, content, role, messageId, attachments? }` — `attachments`: `[{ name, kind, path }]` | сообщение пользователя отправлено (permission `hooks`) |
| `chat:completed` | `{ chatId }` | агент закончил ответ (permission `hooks`) |
| `chat:switched` | `{ chatId }` | пользователь переключил активный чат |
| `message:delta` | `{ chatId, delta }` | стриминг ответа (троттлинг 250 мс; permission `hooks`) |
| `agent:status` | `{ chatId, status, toolName? }` | `started` / `finished` / `error` |
| `tool:call` | `{ toolName, args }` | любой тул вызван (fire-and-forget; permission `hooks`) |
| `theme:changed` | `{ theme, accentColor, dark }` | смена темы приложения |
| `app:focus` | `{}` | главное окно получило фокус |
| `input-action` | `{ id }` | клик по кнопке над инпутом (registerInputAction без command) |
| `panel:opened` | `{ panelId }` | панель плагина открыта (right/page/bottom/modal) |
| `panel:closed` | `{ panelId }` | панель плагина закрыта |
| `bus:<name>` | `{ data, from }` | шина между плагинами (syntee.bus.emit) |

## События со спец-каналом (НЕ подписываются через on())

Эти события доставляются колбэками соответствующих API — `syntee.on('fs:change')` и т.п. **не сработает**:

| Событие | Как подписаться | Payload |
|---|---|---|
| `fs:change` | `syntee.fs.watch(path, cb)` | `{ event, file }` |
| `scheduler:tick` | `syntee.scheduler.every/cron/at(cb)` | — (сам колбэк) |
| `shortcut` | `syntee.registerShortcut(acc, cb)` | — (сам колбэк) |
| `tray:action` | `syntee.tray.setMenu(items)` — item без command | `{ label }` |
| `webhook:request` | `syntee.net.listen(port, handler)` | `{ method, path, body }` |
| `ws:open/message/close/error` | `syntee.net.ws.connect(url, handlers)` | `{ id, … }` |

## Подписка и short-circuit

Хост шлёт хуковые события только плагинам, которые на них подписаны (при `on('chat:before-send', …)` плагин автоматически регистрирует подписку). Отписки нет — на время жизни процесса.

## Паттерн «реакция на сообщения»

```js
syntee.on('chat:message', async (p) => {
  if (/ошибка|error/i.test(String(p.content))) {
    // мягкая реакция: сохранить в память, ответить панелью и т.п.
    await syntee.memory.chat.set(p.chatId, 'last_error', String(p.content).slice(0, 500))
    syntee.ui.setBadge('main', 1)
  }
})
```

## Паттерн «фильтр приватности»

```js
const BLOCKED = [/sk-[a-zA-Z0-9]{20,}/, /\b\d{16}\b/]   // ключи, номера карт

syntee.on('chat:before-send', (p) => {
  for (const re of BLOCKED) {
    if (re.test(p.content)) {
      return { action: 'reject', reason: 'Обнаружен секрет — убери его из сообщения' }
    }
  }
})
```
