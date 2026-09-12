# API: чаты, проекты, память

## chat — действия в активном чате (`chat`)

```js
// Отправить сообщение ОТ ИМЕНИ ПОЛЬЗОВАТЕЛЯ — запускает агента.
// attachments — файлы к сообщению: текст инлайном, картинки → vision.
await syntee.chat.send('Проверь файл', {
  attachments: [
    { path: 'C:/report.txt', name: 'report.txt', kind: 'file' },
    { path: 'C:/pic.png', kind: 'image' },
  ],
})

// silent: true — только вставить текст в поле ввода, не отправлять
await syntee.chat.send('черновик', { silent: true })

// Вставить ответ ОТ ИМЕНИ ПЛАГИНА (не запускает агента)
await syntee.chat.reply('Готово: найдено 3 файла.')
```

### Стриминг ответа (живой текст)

Вместо одного `chat.reply` можно постепенно дописывать ответ — UI обновляется на лету (троттлинг ~120 мс):

```js
// 1. Создать пустое assistant-сообщение в активном чате → его id
const replyId = await syntee.chat.beginReply()

// 2. Дописывать текст по мере поступления
await syntee.chat.appendChunk(replyId, 'Начинаю… ')
await syntee.chat.appendChunk(replyId, 'готово.')

// 3. Финализировать (обязательно — иначе сообщение останется «пишущимся»)
await syntee.chat.endReply(replyId)
```

Типичный сценарий — трансляция ответа LLM в чат:

```js
const rid = await syntee.chat.beginReply()
await syntee.ai.chat(prompt, {
  stream: true,
  onDelta: (d) => syntee.chat.appendChunk(rid, d),
}).then(() => syntee.chat.endReply(rid))
```

### Активный чат

```js
// permission 'chats:read'
const { chatId } = await syntee.chat.getActive()   // string | null — активный чат в UI
```

## chats — чтение и изменение чатов

```js
// 'chats:read'
const list = await syntee.chats.list()          // [{ id, title, createdAt, updatedAt }]
const full = await syntee.chats.get(chatId)     // { chat: {...}, messages: [...] } | null
await syntee.chats.open(chatId)                 // переключить активный чат в UI
const atts = await syntee.chats.getAttachments(messageId)  // [{ id, kind, name, path, mime, size }]

// Пагинация сообщений — для длинных чатов (не тащи всё сразу)
const page = await syntee.chats.getMessages(chatId, { limit: 50 })  // последние 50
// page: { messages: [...], hasMore: boolean }
const older = await syntee.chats.getMessages(chatId, {
  limit: 50,
  beforeCreatedAt: page.messages[0].createdAt,   // курсор = первый элемент страницы
  beforeId: page.messages[0].id,
})
// Листай «вглубь»: курсор каждой следующей страницы — первый элемент предыдущей

// Пагинация сообщений — для длинных чатов (не тащи всё сразу)
const page = await syntee.chats.getMessages(chatId, { limit: 50 })  // последние 50
// page: { messages: [...], hasMore: boolean }
const older = await syntee.chats.getMessages(chatId, {
  limit: 50,
  beforeCreatedAt: page.messages[0].createdAt,   // курсор = первый элемент страницы
  beforeId: page.messages[0].id,
})
// Листай «вглубь»: курсор каждой следующей страницы — первый элемент предыдущей

// 'chats:write'
const { id } = await syntee.chats.create('Новый чат', projectId?)
await syntee.chats.rename(chatId, 'Новое имя')
await syntee.chats.delete(chatId)
const { id: msgId } = await syntee.chats.appendMessage(chatId, 'assistant', 'текст')
await syntee.chats.editMessage(msgId, 'новый текст')
await syntee.chats.deleteMessage(msgId)
```

## Хук chat:message (обогащённый payload)

Событие `chat:message` (permission `hooks`) несёт полные метаданные сообщения — плагины-логгеры и поисковики больше не тянут весь чат через `chats.get`:

```js
syntee.on('chat:message', (p) => {
  // p: { chatId, content, role: 'user', messageId, attachments?: [{ name, kind, path }] }
  if (p.attachments?.length) {
    // файлы, приложенные к сообщению: kind — 'file' | 'image'
  }
})
```

## projects (`projects:read` / `projects:write`)

```js
const list = await syntee.projects.list()       // [{ id, name, workdir }]
const cur = await syntee.projects.current()     // { chatId, projectId?, projectName?, workdir? }
const p = await syntee.projects.create('C:/Projects/app', { name: 'Моё приложение', projectContext: 'что за проект' })
```

`projects.current().workdir` — рабочий каталог активного чата (если чат привязан к проекту). Используй для fs-операций «в проекте пользователя».

## memory — долговременная память (`memory`)

```js
// Поиск по памяти приложения (то же, что у ассистента)
const found = await syntee.memory.search('настройки деплоя')   // [{ … }]

// Сохранить факт
await syntee.memory.save('deploy-key', 'деплой через gh-pages', 'work')

// Заметки, привязанные к чату (попадают в контекст, если у плагина есть context provider)
await syntee.memory.chat.set(chatId, 'summary', 'пользователь делает игру на Unity')
const s = await syntee.memory.chat.get(chatId, 'summary')
await syntee.memory.chat.delete(chatId, 'summary')
```

## Типичный сценарий: контекст плагина в промпте

```js
// 1. Данные (storage/memory)
await syntee.memory.chat.set(chatId, 'todos', ['купить хлеб', 'дописать плагин'])

// 2. Context provider отдаёт их в system prompt перед каждым запросом
syntee.registerContextProvider({
  name: 'todos',
  handler: ({ chatId }) => '## Todos\n' + (await syntee.memory.chat.get(chatId, 'todos')).join('\n'),
})
```

Требует permission `'context'` — см. contributions/events.
