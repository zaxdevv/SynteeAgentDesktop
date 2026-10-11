# Полный аудит производительности SynteeHelper

**Дата:** 11.10.2026  
**Режим:** read-only аудит. Код приложения не изменялся.  
**Цель:** найти причины зависаний, фризов и лагов на слабых ПК, определить приоритет оптимизации и план измерений.

> Важно: этот документ — технический аудит исходного кода и архитектуры. Без профилирования на конкретном слабом ПК нельзя утверждать, какая причина проявляется чаще именно у пользователя. Поэтому ниже отдельно отмечены доказанные кодом риски и гипотезы, которые нужно подтвердить метриками.

---

## 1. Резюме для принятия решений

Проблема не выглядит как одна неисправность. Приложение большое: Electron 44, React, SQLite, AI workers, semantic indexing, fast-context indexing, PTY, browser automation, plugins, Monaco, Mermaid/KaTeX, audio/video-like visual effects. На мощном ПК большая часть задержек незаметна, а на слабом ПК и HDD несколько синхронных операций складываются в видимый «зависший» интерфейс.

### Главные вероятные источники фризов

1. **Синхронный SQLite и файловый I/O в Electron main process.** `better-sqlite3`, FTS-триггеры, JSON-сериализация и `Atomics.wait()` блокируют event loop.
2. **Отправка сообщения выполняет слишком много работы до старта AI-stream.** Контекст, память, graph stats, skills, MCP, plugins, token estimate и auto-recall могут выполняться последовательно.
3. **Промежуточные streaming checkpoint-записи потенциально переиндексируют большой message через FTS5.** Это особенно опасно для ответов с большими tool payloads.
4. **Подсчёт токенов и чтение/парсинг истории могут быть O(размер истории) на каждый send.** Большой чат с тяжёлыми сообщениями усиливает проблему.
5. **Фоновая индексация памяти и fast-context конкурирует за CPU и SQLite.** E5-модель, graph sync и файловый анализ могут работать в неподходящий момент.
6. **PTY и браузерный automation могут создавать большие потоки данных и долгие очереди.** Это даёт ощущение зависания, хотя процесс формально работает.
7. **Renderer в целом уже оптимизирован, но стриминг Markdown/код/KaTeX, анимационный фон, audio visualizer и тяжёлые страницы остаются дорогими сценариями.**
8. **Размер release-бандла заметный:** главный renderer chunk около 12.9 MB, TypeScript Monaco worker около 13.3 MB, CSS около 1.1 MB. Это ухудшает старт, загрузку lazy chunks и давление на RAM, хотя само по себе не объясняет фриз во время обычного чата.

### Приоритеты

- **P0:** добавить измерения event-loop lag/RSS/CPU и фаз `chat:send`; без этого оптимизация будет вслепую.
- **P0:** убрать тяжёлые streaming checkpoint-записи из таблицы messages/FTS-пути.
- **P0:** исключить блокирующий sync retry (`Atomics.wait`) из main.
- **P1:** сократить работу на каждом send: один system prompt, incremental token cache, live-only history, менее агрессивный auto-recall.
- **P1:** ввести строгий scheduler для semantic/fast-context indexing с приоритетом активного чата и idle budget.
- **P1:** ограничить PTY/Browser payloads и очереди.
- **P2:** профилировать renderer и включать экономичный режим эффектов автоматически на слабых GPU/CPU.

---

## 2. Архитектурный профиль проекта

### Процессы и подсистемы

- **Electron main:** окна, IPC, SQLite, настройки, browser manager, PTY, plugins, watchers, updater, network integrations.
- **Renderer React:** ChatPage, split/side chats, Sidebar, settings, memory, messenger, Dots, browser panel, Monaco/xterm, charts/diagrams, animated background.
- **Workers:** AI worker, whisper worker, fastContext worker, plugin host и отдельные worker-related операции.
- **SQLite:** локальная persistent БД с WAL, FTS5/trigram индексами, memory/graph/chat/agent-log таблицами.
- **Фоновые задачи:** semantic E5 indexing, fast-context file indexing, graph sync, memory extraction, update polling, browser watchers, plugin watchers.

### Положительные решения, уже присутствующие

- SQLite WAL, `synchronous=NORMAL`, bounded cache/mmap.
- AI streaming вынесен в worker thread.
- Chat UI использует virtualization и кэш высот строк.
- Токены стрима отправляются батчами, а tool output имеет batching/backpressure.
- Large chats имеют pagination/reverse infinite scroll.
- Lazy loading страниц уменьшает начальный renderer bundle.
- Neural MiniLM embeddings отключены по умолчанию, что экономит CPU в idle.
- E5 semantic index запускается с задержкой, использует bounded pagination и `_running` guard.
- Fast-context parsing вынесен в worker.
- Browser имеет ограничения tab count, timeout/quarantine и idle discard.

---

## 3. Критические риски main/core/IPC

## 3.1. Синхронный SQLite блокирует main process — P0

**Доказательства:**

- `src/core/db/handle.ts:33-48` — `better-sqlite3`, синхронные запросы и миграции.
- `src/main/ipc/chat.ipc.ts:696-714` — `withRetrySync()` при `SQLITE_BUSY` использует `Atomics.wait()`.
- `src/main/ipc/chat.ipc.ts:718-822` — system prompt последовательно вызывает DB-backed context, memory stats, graph stats, skills/MCP/plugins.

**Влияние:** пока main занят SQL, sync FS, JSON или ожиданием lock, Electron не может нормально обрабатывать IPC и часть UI-событий. На HDD, при Defender scan или большой WAL это превращается в заметный фриз.

**Что сделать:**

1. Убрать `Atomics.wait()` из main: retry через async backoff или через DB worker.
2. Профилировать каждый sync DB-вызов и транзакцию.
3. Контекст prompt собирать одним агрегирующим запросом/кэшем, а не серией независимых обращений.
4. Долгие операции записи/индексации перенести в DB worker или сериализованный persistence queue.
5. Не выполнять тяжёлый graph build в синхронном пути отправки.

## 3.2. Путь `chat:send` перегружен последовательными фазами — P0/P1

По существующей логике перед/вокруг AI-run выполняются:

- сохранение user message;
- чтение/подготовка истории;
- rolling context/compaction;
- system prompt;
- token estimation;
- memory/auto-recall по нескольким источникам;
- project context, skills, MCP и plugins;
- создание worker;
- затем уже streaming.

`src/main/ipc/chat.ipc.ts:716-857` подтверждает, что system prompt включает DB, filesystem, skills, MCP, plugins, memory и graph operations.

**Риск:** пользователь видит «ничего не происходит» до первого токена, хотя приложение занято подготовкой контекста.

**Что сделать:**

- вывести в UI отдельные состояния: `Подготавливаю контекст`, `Сжимаю историю`, `Ищу в памяти`, `Запускаю модель`;
- записывать duration каждой фазы;
- переиспользовать один snapshot system prompt для estimate и worker;
- кэшировать prompt по `(chatId, projectId, settingsVersion, memoryVersion, filesVersion)` на короткое время;
- не запускать необязательные post-send задачи до появления первого ответа.

## 3.3. Streaming checkpoint и FTS — P0

Предыдущий аудит уже указывал на риск: промежуточная запись растущего assistant message через `INSERT OR REPLACE` может активировать FTS5-триггеры и переиндексировать весь content. Особенно дорого это для сообщений, содержащих `toolSteps`, `iterations`, thinking и большие результаты команд.

**Риск-файлы:** `src/main/ipc/chat.ipc.ts` (checkpoint/sendDone), `src/core/db/messages.ts`, схема FTS в `src/core/db/migrations/initialSchema.ts`.

**Что сделать:**

- хранить промежуточный streaming state только в `streaming_buffers` без FTS-триггеров;
- в `messages` писать полноценную запись только при завершении или редким snapshot interval;
- ограничить размер checkpoint payload;
- не сериализовать и не записывать неизменённые sections;
- измерять размер JSON и duration каждой checkpoint-записи.

## 3.4. Полная история и token counting — P0/P1

Большой чат может приводить к повторному чтению, `JSON.parse` тяжёлых полей и tiktoken по большой истории. Ранее найденный риск: cache по полному тексту хуже, чем cache по `message.id + contentHash`.

**Что сделать:**

- incremental token cache по `message.id`, content hash и model tokenizer;
- хранить token count рядом с сообщением при финальной записи;
- для model context использовать только live messages после compact divider + summary;
- не парсить tool payloads, если текущей фазе нужны только role/content/token count;
- `context:calculate` отправлять в worker.

## 3.5. Auto-recall на каждый send — P1

`searchAllSources` обращается к нескольким источникам, а fallback может искать cross-project. Это может быть полезно качественно, но дорого количественно.

**Что сделать:**

- полный cross-project recall — только для первого сообщения/явного запроса;
- follow-up ограничить текущим chat/project scope;
- debounce/кэшировать recall по normalized query;
- выполнять поиск в worker или через read-only DB connection;
- ограничить объём кандидатов и payload до prompt.

## 3.6. Автоматическая compaction в send path — P0/P1

Когда контекст подходит к лимиту, rolling compaction может вызвать LLM-summary прямо перед ответом. Это естественный источник «рандомного зависания»: срабатывает только на длинных чатах.

**Что сделать:**

- заранее показывать статус `Сжимаю контекст…`;
- запускать preemptive compaction после завершения предыдущего turn, когда пользователь ничего не ждёт;
- сохранять progress/cancel;
- не делать graph rebuild синхронно в critical path;
- иметь hard timeout/fallback summary.

---

## 4. Фоновые задачи и конкуренция за ресурсы

## 4.1. Semantic E5 index — P1

`src/core/memory/semanticIndex.ts:60-74, 194-249`:

- 5 источников;
- страницы по 200 строк;
- E5 embedding для новых/изменённых строк;
- пауза 15 ms после embedding;
- синхронные SQLite select/upsert;
- периодический запуск.

Плюс: есть `_running` guard и stop logic. Риск остаётся в CPU/RAM и конкуренции с пользовательским запросом. E5 pipeline загружается через `@huggingface/transformers` в `src/core/context/embeddings.ts:120-159`.

**Что сделать:**

- вынести E5 pipeline + DB операций semantic index в отдельный worker;
- ввести idle/CPU budget и паузу, зависящую от event-loop lag;
- индексировать dirty rows, а не регулярно проверять весь корпус;
- при active chat автоматически ставить semantic index на паузу;
- на слабом ПК отключать E5 по умолчанию и оставить FTS/TF-IDF;
- не делать большой orphan cleanup одним блокирующим DELETE.

## 4.2. Fast-context watcher — P1

По коду worker уже используется, что хорошо. Но watcher event и safety-net могут потенциально формировать конкурирующие jobs для одного проекта. Полный parse и graph sync могут создавать пики после массовых изменений файлов, checkout или build.

**Что сделать:**

- per-project mutex/serial executor;
- during full scan only accumulate/coalesce `pendingPaths`;
- приоритет активного проекта;
- разнести дешёвый fingerprint и дорогой parse/graph sync;
- ограничить число файлов/байтов за один time slice;
- логировать queue wait и concurrent jobs.

## 4.3. Memory extraction и graph operations — P1/P2

После turn могут запускаться regex/LLM extraction, idle extraction, outcome extraction и graph updates. Даже если они асинхронны, их SQLite-записи конкурируют с чатом.

**Что сделать:** единая low-priority background queue с budget, отменой и приоритетом foreground; не запускать несколько extraction jobs одновременно; переносить большие graph rebuilds в worker.

---

## 5. PTY, tools и файловые операции

## 5.1. PTY output — P1

`src/main/managers/PtyManager.ts:402-489` и `src/main/ipc/pty.ipc.ts` показывают, что PTY живёт в main, обрабатывает chunks и отправляет output в renderer. Для `npm`, `tsc`, `git` и генераторов логов поток может быть очень большим.

**Риски:** строковые копирования, ANSI/regex parsing, IPC volume, xterm rendering, память буферов.

**Оптимизация:**

- лимит bytes/sec на UI-поток;
- coalesce по времени/размеру, например максимум один UI update за animation frame или 30–60 ms;
- кольцевой raw buffer вместо постоянного копирования растущей строки;
- ограничение AI tool output и truncation с сохранением tail/head;
- kill/circuit breaker для runaway-команд;
- parsing/filtering в worker при подтверждении нагрузки.

## 5.2. Синхронные file handlers — P1/P2

`src/main/ipc/index.ts:124-192, 229-264` использует `writeFileSync`, `readFileSync`, `readdirSync`, `statSync`; binary loads превращаются в base64.

Особенно чувствительны background images, sounds, fonts и большие attachments.

**Оптимизация:** `fs.promises`, лимиты размера IPC payload, custom protocol/stream вместо base64, thumbnails/decoded-size limits, async directory enumeration.

## 5.3. Plugin scan/watch — P2

`src/core/plugins/pluginManager.ts:360-401, 797-850` содержит sync scan/stat и recursive watch/snapshot. При больших plugin directories или частых build events это может давать bursts.

**Оптимизация:** кэш scan, игнорирование `node_modules/.git/cache`, debounce событий, worker для глубокого snapshot.

---

## 6. Browser automation

## 6.1. Долгие операции и queue tail — P1

`src/core/agent/browserWorkerBroker.ts` и `src/main/managers/BrowserManager.ts:650-703` используют длинные timeout и tab operation queue. Timeout Promise не всегда отменяет уже выполняющийся `executeJavaScript`/navigation/CDP action.

**Симптом:** агент визуально «завис», а следующие действия на том же tab стоят в очереди.

**Оптимизация:** hard timeout + quarantine tab, ограничение queue length, отдельный tab для некancellable actions, короткие timeout для snapshot/tabs/scroll, длинные оставить только для явного wait/confirmation.

## 6.2. Большой DOM/accessibility snapshot — P1

Snapshot может обходить большой DOM и передавать до десятков тысяч символов. Это дорого в browser renderer, main, IPC и prompt tokens.

**Оптимизация:** scoped snapshot, лимит nodes/depth/text/frames, cache до navigation/mutation, compact representation, метрики serialization time и size.

---

## 7. Renderer/UI аудит

## 7.1. Chat renderer — в основном защищён, но live Markdown остаётся дорогим

Найденные защиты:

- virtualizer в `ChatPage.tsx`;
- `overscan: 5`;
- memo-компоненты;
- ResizeObserver + rAF batching;
- slim messages для UI;
- batching tool output.

Риск:

- `MessageBubble.tsx:895-925` — ReactMarkdown, remark/rehype, syntax highlighting, KaTeX;
- `ChatPage.tsx:2350-2412` — dynamic height measuring во время изменения live message.

На длинном streaming Markdown/code/KaTeX повторный render может быть дорогим даже при virtualization.

**Оптимизация:**

- для live message рендерить упрощённый plain/limited Markdown, полный parse только после flush/finish;
- throttled publish live text на слабом режиме;
- не запускать KaTeX/Mermaid до завершения блока;
- cache parsed markdown по content hash;
- лимитировать live code highlight и большие tool results.

## 7.2. Background/WebGL/audio effects — P1/P2

`AnimatedBackground` использует worker/OffscreenCanvas и DPR cap, что хорошо. Но нужно проверить, что при выключении эффекта worker действительно прекращает RAF, а не только получает `disable`.

`AudioVisualizerLayer` имеет RAF и остановку на тихом сигнале, но активный аудиосигнал всё равно создаёт постоянную графическую нагрузку.

**Оптимизация:**

- автоматический low-power mode по CPU/GPU/`prefers-reduced-motion`/FPS;
- DPR 1 на слабых устройствах;
- 30 FPS вместо 60 для эффектов, не влияющих на ввод;
- полное уничтожение worker/WebGL context при отключении или длительном hide;
- не обновлять визуализатор, когда окно невидимо/свёрнуто.

## 7.3. Большие lazy chunks и тяжёлые библиотеки — P2

Проверка `out/renderer/assets` показала крупные артефакты:

| Артефакт | Примерный размер |
|---|---:|
| TypeScript Monaco worker | 13.3 MB |
| основной renderer chunk | 12.9 MB |
| CSS chunk | 1.1 MB |
| mermaid core | 1.2 MB |
| html worker | 1.3 MB |
| cytoscape | 0.96 MB |
| Settings chunk | 0.51 MB |
| KaTeX chunk | 0.48 MB |

Это не обязательно runtime-фриз, но влияет на старт, загрузку страниц и RAM. Monaco workers особенно желательно грузить только после открытия редактора.

**Оптимизация:** отдельные entry/chunks для Monaco languages, Mermaid diagram types, Cytoscape, KaTeX; не импортировать CSS тяжёлых страниц глобально; проверить tree-shaking и duplicate dependencies.

## 7.4. Background loading полной истории — условный P1

`useBackgroundLoadFullChat.ts` для небольших чатов в idle догружает всю историю страницами. Это удобно, но на машине с медленным диском/IPC может конкурировать с текущим вводом и render.

**Оптимизация:** полностью приостанавливать background load во время typing/stream/tool execution; ограничить бюджет страниц в минуту; начинать только после idle 2–5 секунд; учитывать RSS.

## 7.5. Memory/graph pages

Виртуализация списка памяти есть, но раскрытая карточка может содержать полный Markdown. Графы/d3/cytoscape и диаграммы могут создавать крупные пики при открытии.

**Оптимизация:** только одна раскрытая тяжёлая карточка; lazy mount graph; ограничить nodes/edges; cleanup graph instance при уходе со страницы; не держать скрытые тяжёлые страницы смонтированными.

---

## 8. Данные, БД и рост профиля пользователя

Количество memory items само по себе не обязательно является причиной лагов. Опаснее комбинация:

- длинные `messages`;
- большие tool result JSON;
- FTS5/trigram индексы;
- WAL и частые записи;
- большие embeddings BLOB;
- много проектов и cross-project search;
- HDD/Defender/RAM pressure.

### Что измерять на реальном проблемном ПК

- размер `syntee.db`, `syntee.db-wal`, FTS tables;
- число messages по чатам и максимальный message size;
- средний/95-й размер tool payload;
- размер `semantic_embeddings`;
- WAL checkpoint duration;
- `SQLITE_BUSY` count;
- скорость чтения/записи DB;
- свободная RAM и pagefile pressure;
- наличие Windows Defender scanning userData.

---

## 9. План обязательного профилирования

До оптимизации добавить диагностический режим, не включённый постоянно.

### Main process

- `monitorEventLoopDelay` p50/p95/p99;
- CPU/RSS/heap каждые 1–2 секунды;
- duration IPC handlers;
- длительность каждой `chat:send` фазы;
- sync DB calls > 10 ms;
- file operations > 10 ms;
- count/size checkpoint writes.

### Renderer

- FPS/long frames (>50 ms, >100 ms);
- React render duration ChatPage/MessageBubble;
- number of mounted message rows;
- Markdown parse/highlight duration;
- memory estimate where available;
- animation/background/audio active state.

### Workers

- AI worker spawn/start/first token;
- fast-context queue wait and job duration;
- semantic index rows/sec, embedding duration, DB upsert duration;
- worker CPU/RSS where possible.

### Browser/PTY

- browser queue wait, operation duration, timeout count;
- snapshot nodes/chars/serialization duration;
- PTY bytes/sec, chunks/sec, UI batches/sec, renderer write duration.

---

## 10. Матрица воспроизведения

Проверять минимум 4 профиля:

1. SSD + 16 GB RAM + современный CPU;
2. HDD/SATA + 8 GB RAM;
3. слабый CPU/GPU + SSD;
4. большая пользовательская БД + обычный ПК.

Сценарии:

- короткий обычный вопрос;
- длинный ответ с Markdown и code blocks;
- ответ с несколькими tool calls и большим PTY output;
- чат около context limit, срабатывание compaction;
- 1000+ сообщений в чате;
- memory search при большой БД;
- параллельно semantic/fast-context indexing;
- активный animated background/audio visualizer;
- browser snapshot на тяжёлой странице;
- переключение чатов во время фоновой догрузки.

Критерии приемки после оптимизации:

- нет main event-loop stalls >100 ms в обычном send path;
- первый статус появляется менее чем за 100–200 ms после send;
- первый токен не задерживается из-за необязательного background work;
- no visible checkpoint spikes;
- background indexing автоматически уступает foreground;
- renderer не имеет устойчивых long frames во время обычного стрима;
- память процесса стабилизируется после закрытия тяжёлых страниц/browser tabs.

---

## 11. Приоритетный план оптимизации

### Этап A — диагностика и самые опасные блокировки

1. Instrumentation main/renderer/workers.
2. Streaming buffers вместо промежуточных записей в FTS messages.
3. Удаление `Atomics.wait` из main.
4. UI статусы до первого токена и во время compaction.
5. Проверка и ограничение крупных checkpoint/tool payloads.

### Этап B — сокращение стоимости каждого send

1. Один system prompt snapshot на send.
2. Token cache по message id/hash.
3. Live-only history после compact divider.
4. Auto-recall cache и ограниченный cross-project fallback.
5. Долгие context calculations в worker.

### Этап C — фоновые задачи

1. Единственный scheduler с приоритетами foreground/background.
2. E5 semantic indexing в отдельном worker с CPU budget.
3. Per-project mutex для fast-context.
4. Приостановка background load/indexing во время typing/stream/tool.
5. Incremental dirty queues вместо периодических полных проходов.

### Этап D — UI и тяжёлые функции

1. Low-power mode для фоновых эффектов.
2. Ограничение Markdown/KaTeX/highlight во время live stream.
3. Lazy split Monaco/Mermaid/Cytoscape workers.
4. Cleanup hidden graph/browser/editor resources.
5. Browser snapshot scoping и PTY output rate limits.

---

## 12. Итоговый диагноз

У проекта уже есть много правильных оптимизаций, поэтому проблема не похожа на «React полностью перерисовывает весь чат» или «1500 записей памяти сами по себе убивают приложение». Основной системный риск — **нагрузка концентрируется в Electron main process и возникает пачками**: sync SQLite/FTS, token counting, контекст, checkpoint, memory/graph operations, indexing и file I/O.

На слабом ПК это проявляется как зависания в разные моменты, потому что разные события активируют разные дорогие пути. Самые выгодные действия — сначала убрать блокировки main и частые FTS checkpoint writes, затем сократить работу перед каждым send, после этого ввести scheduler фоновых задач и только потом тонко оптимизировать эффекты/renderer.

**Код в рамках этого аудита не изменялся.**
