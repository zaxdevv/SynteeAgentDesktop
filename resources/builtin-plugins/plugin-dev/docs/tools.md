# Тулы для AI — registerTool

Тул — функция, которую модель может вызывать как инструмент (как read_file или search_web у хоста). Тулы плагина попадают в схему агента, когда плагин **запущен** и его scope покрывает текущий чат.

```js
syntee.registerTool({
  name: 'get_weather',            // [a-zA-Z][a-zA-Z0-9_]*, короткое имя (без префикса)
  description: 'Get current weather for a city',
  parameters: {                   // JSON Schema
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
      units: { type: 'string', enum: ['c', 'f'] },
    },
    required: ['city'],
  },
  handler: async (args) => {
    const r = await syntee.net.fetch('https://wttr.in/' + args.city + '?format=j1')
    const data = JSON.parse(r.body)
    return 'Погода в ' + args.city + ': ' + data.current_condition[0].temp_C + '°C'
  },
})
```

## Правила

- **Имя**: `[a-zA-Z][a-zA-Z0-9_]*`. Модель видит тул как `plugin__{pluginId}__{name}`.
- **Description** — по-английски, конкретно: что делает, когда звать, что вернёт. Это единственное, что видит модель кроме схемы.
- **Parameters** — JSON Schema (`type: 'object'`, `properties`, `required`). Без `parameters` — тул без аргументов.
- **Handler** — async или sync. Возврат: **строка** (текст для модели). Объекты сериализуй сам (`JSON.stringify`).
- Ошибка в handler → модель получит текст ошибки (не роняет процесс плагина).
- Права проверяются в handler-е как обычно (`net.fetch` требует `net` и т.д.).

## Подтверждение пользователя — requiresApproval

Мутабельные тулы (покупки, деплой, удаление данных) помечай флагом `requiresApproval: true` — каждый вызов будет показан пользователю в approval-диалоге агента, и только после подтверждения выполнится handler:

```js
syntee.registerTool({
  name: 'deploy',
  description: 'Deploy current branch to production',
  parameters: {
    type: 'object',
    properties: { env: { type: 'string', enum: ['staging', 'prod'] } },
    required: ['env'],
  },
  handler: async (args) => { /* … */ },
  requiresApproval: true,   // каждый вызов требует подтверждения пользователя
})
```

Правило: тулы с побочными эффектами (запись, отправка, удаление) всегда ставь `requiresApproval: true` — подтверждение спрашивается **независимо** от режима подтверждений агента (кроме режима `full`, где подтверждается всё подряд). Read-only тулы (поиск, чтение) флаг не ставят — иначе пользователь устанет жать «Разрешить».

## Инлайн-виджеты (rich-результат)

Тул может вернуть не текст, а JSON-маркер — тогда в чат рендерится **виджет** вместо текста. Два вида:

**1. iframe-виджет** — своя HTML-страница в карточке сообщения:

```js
syntee.ui.registerWidget({ name: 'chart', entry: 'ui/chart.html', height: 260 })

// в handler-е тула:
return JSON.stringify({
  __plugin_ui__: true,
  pluginId: 'my-plugin',            // СВОЙ id из манифеста (обязательно!)
  entry: 'ui/chart.html',           // HTML-файл виджета (обязательно для iframe)
  data: { labels: [...], values: [...] },  // попадёт в виджет (widgetData)
  height: 260,                      // высота карточки, px
})
```

Виджет (ui/chart.html) получает `data` через мост — см. секцию **ui**. `registerWidget(name)` — декларация для system prompt (модель узнаёт, что тул умеет рендерить виджет); сам маркер должен содержать `pluginId` и `entry`.

**2. Нативный diff-виджет** — без iframe, рендерит unified diff в стиле кодоблоков:

```js
return JSON.stringify({
  __plugin_ui__: true,
  pluginId: 'my-plugin',
  kind: 'diff',                     // нативный рендер (entry не нужен)
  title: 'src/app.ts',              // заголовок карточки
  language: 'ts',                   // подсветка синтаксиса
  diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-old\n+new',
})
```

**3. Инлайн-бейдж** (`kind:'badge'`) — декорация без iframe: компактная пилюля-статус в сообщении:

```js
return JSON.stringify({
  __plugin_ui__: true,
  pluginId: 'my-plugin',
  kind: 'badge',
  text: '✓ Тесты пройдены (42)',
  color: '#22c55e',                 // опционально: CSS-цвет (дефолт — акцент темы)
})
```

**4. Action-кнопки** — у iframe-виджета могут быть кнопки под карточкой (см. **ui** → «Action-кнопки у инлайн-виджетов»):

```js
return JSON.stringify({
  __plugin_ui__: true,
  pluginId: 'my-plugin',
  entry: 'ui/card.html',
  data: { status: 'ok' }, height: 260,
  actions: [
    { label: 'Обновить', command: 'refresh' },   // слэш-команда плагина
    { label: 'Открыть панель', panel: 'main' },  // панель из registerPanel
  ],
})
```

Без `pluginId` (+ `entry` или `kind:'diff'` + `diff` / `kind:'badge'` + `text`) маркер НЕ распарсится — сообщение отрендерится как обычный текст.

## Динамические тулы и unregister

`registerTool` можно звать в любой момент (не только в activate). Снять регистрацию в рантайме:

```js
syntee.unregisterTool('get_weather')   // тул исчезает из схемы агента
```

## Динамические тулы

`registerTool` можно звать в любой момент (не только в activate): подписка на событие → регистрация тула по мере надобности. Список тулов в UI обновляется пушем.

## Что НЕ надо делать тулом

- Одноразовые действия пользователя → слэш-команда (см. **commands**).
- Фоновые задачи → scheduler + notifications.
- Тул должен быть полезен **модели** в диалоге.
