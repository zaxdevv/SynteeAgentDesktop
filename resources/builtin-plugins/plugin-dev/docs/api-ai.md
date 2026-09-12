# API: AI, агент, MCP

## ai — LLM через хост (`ai`)

Биллинг и модели централизованы в приложении — плагин не хранит ключи.

```js
// Простой вызов
const answer = await syntee.ai.chat('Переведи на английский: привет', {
  system: 'Ты переводчик. Отвечай только переводом.',
  model: '…',            // опционально: id модели приложения
  maxTokens: 1024,       // ≤ 8192
})

// Vision: массив сообщений с картинками
const desc = await syntee.ai.chat([
  { type: 'text', text: 'Что на картинке?' },
  { type: 'image', path: 'C:/pic.png' },        // или url: 'https://…' / base64: '…'
])

// Стриминг
let full = ''
const text = await syntee.ai.chat('Расскажи историю', {
  stream: true,
  onDelta: (delta) => { full += delta; syntee.ui.emit('stream', { delta }) },
})

// Эмбеддинги (вектор текста, хостовый эмбеддер)
const vec = await syntee.ai.embed('текст')      // number[], ≤ 32k символов

// Доступные модели
const models = await syntee.ai.listModels()     // [{ id, providerId, name, contextWindow }]

// Генерация изображения → markdown '![…](url)' с временной ссылкой
const md = await syntee.ai.generateImage('кот-космонавт', { size: '1024x1024' })
```

### Function calling — tools + chatContext

`ai.chat` умеет давать модели тулы плагина: модель решает, какие звать (цикл до 8 раундов), хост исполняет **хендлеры плагина** и отдаёт модели результат. Финал — текстовый ответ.

```js
const answer = await syntee.ai.chat('Какая погода в Москве?', {
  system: 'Отвечай кратко.',
  tools: [{
    name: 'get_weather',
    description: 'Погода в городе',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'Название города' } },
      required: ['city'],
    },
    handler: async (args) => ({ temp: 21, condition: 'ясно' }),  // хендлер живёт в плагине
  }],
  chatContext: true,   // подмешать историю чата (последние 40 текстовых сообщений)
  // chatId: '…',      // чат для контекста (по умолчанию активный)
})
```

- **`tools`** — как в `registerTool`: `name`, `description`, `parameters` (JSON Schema), `handler`. Хендлер возвращает объект — он сериализуется и уходит модели как результат тула.
- **`chatContext: true`** — подмешивает историю активного чата (последние 40 текстовых сообщений) как контекст; укажи `chatId` для другого чата.
- `tools` + `chatContext` — **текстовый путь**: vision-сообщения с картинками в этой комбинации не поддерживаются.

## agent — тулы и субагенты (`agent`)

```js
// Прямой вызов host-тулов агента:
//   read-only: read_file, search_code, list_directory, find_files, search_web
//   запись:    write_file, edit_file (дополнительно требует 'fs:write:any')
const files = await syntee.agent.useTool('find_files', {
  pattern: '*.ts', path: workdir,
})
const res = await syntee.agent.useTool('search_web', { query: 'electron utilityProcess docs' })
await syntee.agent.useTool('write_file', { path: 'C:/x.txt', content: '…' })

// Полноценный субагент (воркер + все тулы + планировщик). Возвращает summary.
const { agentId, summary } = await syntee.agent.run(
  'Найди в проекте все TODO и составь список по файлам',
  { model: '…', workdir: 'C:/Projects/app' },
)
```

`agent.run` — для многошаговых задач; пиши задание конкретно, как промпт субагенту. Пишущие тулы субагента доступны только с `fs:write:any` — право проверяется **безусловно при вызове `agent.run`**, даже если задача read-only. Для read-only задач без права записи используй `agent.useTool` с read-only тулами.

## mcp — тулы MCP-серверов (`mcp`)

```js
const tools = await syntee.mcp.listTools()      // [{ server, name, description }]
const res = await syntee.mcp.call('server-name', 'tool-name', { arg: 1 })
```

MCP-серверы настраиваются в приложении (`~/.syntee/mcp.json` / `.mcp.json`) — плагин может вызывать их тулы без своего MCP-клиента.

## speech — синтез и распознавание речи (`speech`)

Голос через инфраструктуру приложения (TTS-провайдер и локальный Whisper) — плагину не нужно поднимать свой движок:

```js
// Синтез речи → base64 MP3 (TTS-провайдер приложения)
const mp3Base64 = await syntee.speech.tts('Привет!')

// Распознавание речи → текст (локальный Whisper)
// WAV: PCM 16/24/32-bit, любое число каналов — ресемплится в 16k mono
const text = await syntee.speech.stt('C:/recording.wav')
```

## Паттерн «AI-тул»

Тул плагина + ai.chat = кастомная AI-фича с чистым UX:

```js
syntee.registerTool({
  name: 'summarize_url',
  description: 'Summarize a web page content',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  handler: async ({ url }) => {
    const r = await syntee.net.fetch(url)
    return await syntee.ai.chat(
      'Summarize this page in 5 bullet points:\n\n' + r.body.slice(0, 20000),
      { system: 'You are a concise summarizer.' },
    )
  },
})
```
