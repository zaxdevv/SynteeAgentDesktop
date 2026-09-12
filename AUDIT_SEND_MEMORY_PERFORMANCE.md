# Аудит производительности: отправка сообщений + память

**Дата:** 30.08.2026
**Тип:** read-only исследование (правки кода НЕ вносились)
**Симптом:** на одном ПК при отправке сообщений рандомно начинаются лаги / зависания приложения, на другом — нет. На одном клиенте память «полная» (много записей, много проектов), на другом ~1500 записей.

---

## 1. Как устроена отправка сообщения (`chat:send`)

Файл: `src/main/ipc/chat.ipc.ts` (~3830 строк)

```
UI (renderer)
  └─ window.syntee.chat.send(params)          ← IPC
       └─ ipcMain.handle('chat:send')          chat.ipc.ts:3107
            ├─ getMessagesCached(chatId)       ← ВСЯ история чата из SQLite + JSON.parse (historyCache.ts)
            ├─ слот занят? → очередь chatQueues[chatId]
            └─ runChatSend()                   chat.ipc.ts:959 (fire-and-forget)
                 ├─ saveMessage(userMsg)                        ← sync-запись + FTS-триггеры
                 ├─ getLiveMessages(history)                    ← сообщения после compact-divider
                 ├─ applyRollingWindowAsync(...)                ← КОМПАКЦИЯ при 92% (LLM inline!)  :1078
                 ├─ getSystemPrompt() #1 (для token estimate)   :1201
                 │    ├─ buildCuratedSummary(projectId)         ← sync SQL (LIMIT-запросы)
                 │    ├─ getMemoryStatsForProject()             ← sync COUNT
                 │    ├─ getGraphStats()                        ← sync SQL
                 │    ├─ readProjectContextFiles()              ← sync fs I/O (mtime-кэш)
                 │    └─ скиллы + MCP-серверы                   ← sync
                 ├─ estimateMessagesTokens(processedHistory)    ← tiktoken ВСЯ история  :1203
                 ├─ buildSnapshotFromEstimate(+tool schemas)    ← tiktoken schemas
                 ├─ getSystemPrompt() #2 (для воркера)          :2808  ← ДУБЛЬ
                 ├─ Auto-recall (НА КАЖДОЕ сообщение)           :2811-2886
                 │    ├─ extractRecallKeywords(content)         ← stopwords, top-10 слов
                 │    ├─ searchAllSources(...)                  ← 5 sync-SQL источников
                 │    └─ crossProject fallback (если 0)         ← поиск по ВСЕМ проектам  :2838
                 ├─ new Worker('ai-worker.js')                  ← новый воркер на каждый send  :1578
                 └─ worker.postMessage({ history, systemPrompt, ... })
```

### Во время стриминга ответа

- **UI-батчинг токенов**: 50 мс (`UI_FLUSH_MS`, chat.ipc.ts:1276) — токены копятся и флешатся пачками. ✅
- **Checkpoint каждые 3 сек** (chat.ipc.ts:1613-1640): `INSERT OR REPLACE` всего растущего сообщения
  (JSON.stringify всех steps/iterations/thinking) → **FTS5 trigram триггеры переиндексируют весь content**.
  Dirty-flag пропускает тик, если ничего не пришло. ⚠️
- **sendDone** (chat.ipc.ts:1297): финальная запись + regex-извлечение фактов (`extractMemoriesFromConversation`)
  + чекпоинты/снапшоты + end-of-task extraction (LLM сразу, если не было tool_calls) + idle-extraction через 10 мин (LLM).

### После ответа (фоновые задачи)

| Задача | Триггер | Стоимость |
|---|---|---|
| `extractMemoriesFromConversation` | каждый sendDone | regex, мгновенно |
| `extractAndSaveFacts` (LLM) | сразу, если turn без tool_calls | LLM-вызов + sync SQL-записи |
| `scheduleIdleExtraction` (LLM) | 10 мин после последнего send | LLM-вызов + sync SQL-записи |
| `extractAndSaveOutcomes` | вместе с idle/compaction | LLM + SQL |
| `incrementalUpdateConversation` (graph) | при компакции | LLM + SQL |
| `autoNameChat` | первое сообщение | LLM-вызов |

---

## 2. Как устроена память

### Хранилище
- **БД**: `%APPDATA%\syntee-helper\syntee.db`, better-sqlite3, **синхронный API в main-процессе** (`src/core/db/handle.ts`).
- **Прагмы** (handle.ts:34-46): WAL, foreign_keys, cache_size 64MB, mmap 256MB, synchronous=NORMAL, temp_store=MEMORY. ✅
- **FTS5 trigram индексы**: `messages_fts`, `memory_fts`, `chat_summaries_fts` — с триггерами
  AFTER INSERT/DELETE/UPDATE (initialSchema.ts:349-365). Trigram-индекс в 3-5× больше текста.

### Поиск по памяти (`src/core/memory/store/search.ts`)
- `searchMemory` (search.ts:191): гибридный скоринг
  - канал 1: TF-IDF cosine по **top-500 записей по importance** (`SELECT * ... LIMIT 500` — тянет embedding BLOB'ы)
  - канал 2: FTS5 trigram (`memory_fts` MATCH + bm25) — морфология для русского
  - combo = tfidfCos×12 + importance×0.5 + recency×0.8 + pinned×0.8 + likeBoost + ftsBoost
- `searchAllSources` (search.ts:344): 5 источников — memory, messages (FTS5), summaries (FTS5/LIKE), agent_logs (LIKE, 14д), pinned.
- `searchGraphDirect` (search.ts:42): knowledge graph, LIKE по label узлов + 1-hop соседи.
- **Embeddings**: neural (MiniLM ONNX) **выключен по умолчанию** — TF-IDF fallback, чистый JS, 0 CPU (embeddings.ts:24-33). ✅

### Вывод по объёму памяти
**1500 записей — НЕ проблема**: `searchMemory` ограничен top-500 по importance, LIMIT-запросы быстрые.
Проблема не в количестве записей памяти, а в **размере messages + FTS-индексов** и **диске** (см. §4).

---

## 3. Renderer (UI) — что уже оптимизировано

| Механизм | Где | Статус |
|---|---|---|
| Виртуализация списка сообщений | `useVirtualizer` (ChatPage.tsx:1846+) | ✅ |
| Кэш высот рядов (Map<msgId, height>) | ChatPage.tsx:1847 | ✅ |
| Фоновая догрузка полной истории | `useBackgroundLoadFullChat` | ✅ |
| Батчинг стриминг-токенов | 50 мс main + renderer | ✅ |
| Slim-сообщения в UI | `slimMessagesForUI` | ✅ |
| Real-priority контекст-счётчик | `useContextCounter` (real usage > estimate) | ✅ |
| Очередь на chatId | `chatQueues` | ✅ |
| AI в worker_threads | `ai-worker.js` на каждый send | ✅ (но spawn ~50-100мс) |

---

## 4. Узкие места (по убыванию важности)

### 🔴 1. Стриминг-чекпоинт каждые 3с — FTS re-index всего сообщения
**Где:** chat.ipc.ts:1613-1640, `saveMessage` = `INSERT OR REPLACE` (messages.ts:16).
`INSERT OR REPLACE` = DELETE + INSERT → триггеры FTS **удаляют и заново строят trigram-индекс всего content** каждые 3 секунды.
На длинном ответе с тулами (сотни КБ JSON) — мегабайты записи + trigram-токенизация **синхронно на main**.
На HDD/с антивирусом — видимые фризы каждые 3с во время стриминга.

**Фикс:** писать чекпоинты в отдельную таблицу `streaming_buffers(chat_id, msg_id, json, updated_at)` БЕЗ FTS-триггеров
(финальный sendDone всё равно пишет полную версию в messages), или throttle до 10-15с.

### 🔴 2. tiktoken по всей истории на каждый send
**Где:** chat.ipc.ts:1203 (`estimateMessagesTokens` + `buildSnapshotFromEstimate` с tool schemas), usageTracker.ts:33.
LRU-кэш 500 записей **ключом является полный текст сообщения** (usageTracker.ts:30-31) — на большой истории
(>500 сообщений или тяжёлые tool-результаты) кэш промахивается → полный re-encode всей истории.
js-tiktoken — чистый JS, O(длина текста): 200-300k токенов истории = **0.5-2 сек CPU, блокируя main**.
Плюс то же самое в `context:calculate` при смене чата (chat.ipc.ts:3052-3075).

**Фикс:** инкрементальный кэш токенов по `msg.id` (суммировать дельту), или считать в воркере (у него уже есть всё).

### 🔴 3. Полная перечитка истории на каждый send
**Где:** historyCache.ts + messages.ts:76 (`getMessages`).
Кэш инвалидается **каждой** записью (`setMessageSavedCallback`), а записи идут каждые 3с во время стриминга
→ следующий send гарантированно перечитывает **всю историю чата + JSON.parse до 9 полей на сообщение**
(toolSteps, iterations, thinkingBlocks, attachments...). На чате 1000+ сообщений с тяжёлыми тулами — сотни мс sync.

**Фикс:** для контекста читать только live-сообщения после compact-divider (`created_at > divider.createdAt`),
старые заменены summary и в модели не нужны. JSON-поля парсить лениво.

### 🟠 4. Auto-recall на каждое сообщение
**Где:** chat.ipc.ts:2811-2886.
`searchAllSources` = 5 sync-SQL запросов на main (memory TF-IDF top-500 + FTS5 messages + FTS5 summaries).
Если project-scope дал 0 → **crossProject fallback** (chat.ipc.ts:2838) — FTS5 по сообщениям **всех** проектов ×2.
На «полном» клиенте (много проектов, десятки тысяч сообщений) — заметно на каждом send.

**Фикс:** на follow-up не гонять полный multi-source (или тоже вынести в воркер — у него есть DB connection);
ограничить crossProject fallback только first-message.

### 🟠 5. Компакция inline в пути отправки
**Где:** chat.ipc.ts:1078 `await applyRollingWindowAsync(...)` с LLM-summary (`summaryFn`, :1049).
При пересечении 92% контекста отправка «висит» пока summary-модель пишет резюме (секунды — десятки секунд).
Это **главный источник «рандомно зависает при отправке»** — срабатывает только когда контекст подходит к лимиту.

**Фикс:** показывать явный статус «Сжимаю контекст...» в UI (частично есть через CHAT_COMPACTED, но до — нет);
рассмотреть pre-emptive компакцию после ответа, а не перед следующим send.

### 🟡 6. getSystemPrompt ×2 за send
**Где:** chat.ipc.ts:1201 (для token estimate) и :2808 (для воркера). Каждый вызов = buildCuratedSummary +
memoryStats + graphStats + чтение файлов проекта + скиллы + MCP. На SSD единицы-десятки мс, но это дубль.

**Фикс:** кэш результата на 2-5с или строить один раз и переиспользовать.

### 🟡 7. searchMemory тянет embedding BLOB'ы
**Где:** search.ts:226 `SELECT * ... LIMIT 500` — 500 строк × ~1-7KB BLOB = единицы МБ из БД на каждый поиск.
При TF-IDF (neural выключен) BLOB'ы вообще не нужны — только content/title/importance.

**Фикс:** не выбирать `embedding` колонку, когда neural embeddings выключены.

### 🟡 8. Мелочи
- `new Worker()` на каждый send (chat.ipc.ts:1578) — spawn потока ~50-100мс; можно пул переиспользуемых воркеров.
- `Atomics.wait` в withRetrySync (chat.ipc.ts:548) — честная блокировка потока при SQLITE_BUSY retry.
- WAL auto-checkpoint (каждые ~1000 страниц) — периодические паузы записи на больших БД.

---

## 5. Почему «на одном ПК лагает, на другом нет»

Код один и тот же — разница в **окружении и размере данных**:

| Фактор | ПК без лагов | ПК с лагами |
|---|---|---|
| **Диск** | NVMe/SSD — sync-записи SQLite <1-5мс | HDD/SATA — sync-записи 50-300мс → блокировка main = фриз UI |
| **Windows Defender** | исключение для `%APPDATA%\syntee-helper` | сканирует `syntee.db` + `syntee.db-wal` при **каждой** записи (чекпоинты каждые 3с!) |
| **Размер БД** | 1500 записей, короткие чаты | «полная память»: FTS5 trigram индексы в 3-5× текста, БД сотни МБ |
| **Проекты** | мало | много → crossProject fallback ищет по всем чатам всех проектов |
| **История чатов** | короткие | длинные + тяжёлые toolSteps/iterations JSON → tiktoken + JSON.parse |
| **RAM/CPU** | достаточно | swap/троттлинг усиливает всё вышеперечисленное |

**«Рандомность» лагов** объясняется событиями, которые происходят не каждый раз:
1. компакция при пересечении 92% контекста (LLM inline);
2. idle-extraction через 10 мин тишины (LLM + записи);
3. end-of-task extraction после turn'а без тулов (LLM);
4. crossProject fallback (когда project-scope дал 0);
5. WAL auto-checkpoint на выросшей БД;
6. чекпоинты стриминга на длинных ответах с тулами;
7. антивирусные сканы пачками.

---

## 6. Рекомендации (приоритетный порядок)

1. **Чекпоинты стриминга — вне FTS** (отдельная таблица без триггеров / throttle 10-15с). Самая частая запись в БД.
2. **Инкрементальный подсчёт токенов** — кэш по `msg.id`, а не по тексту; или считать в воркере.
3. **Live-only чтение истории** — только сообщения после compact-divider для контекста.
4. **Auto-recall** — на follow-up легче (или в воркер); crossProject fallback только для first-message.
5. **Кэш getSystemPrompt** 2-5с (строится 2 раза за send почти одинаковым).
6. **Инфраструктура на лагающем ПК**: исключение `%APPDATA%\syntee-helper` в Defender; убедиться что БД на SSD.
7. **Диагностика**: добавить ms-замеры фаз send в логи (history load / rolling / sysprompt / tokens / recall / worker spawn) — на лагающей машине сразу видно проседающую фазу.
8. **searchMemory** не выбирать embedding BLOB при выключенном neural.

---

## 7. Что уже сделано хорошо ✅

- Очередь запросов на chatId (никаких параллельных прогонов в одном чате).
- AI-логика в worker_threads — стриминг не блокирует main.
- UI-батчинг токенов 50мс + виртуализация с кэшем высот (нет фризов от рендера).
- historyCache LRU (cap 20 чатов) — повторные чтения без изменений бесплатны.
- TF-IDF вместо neural embeddings по умолчанию — 0 CPU в простое.
- Прагмы SQLite: WAL, synchronous=NORMAL, cache 64MB, mmap 256MB.
- Dirty-flag на чекпоинтах (не пишем, если нечего).
- Retry на SQLITE_BUSY с backoff в getSystemPrompt.
- Real-priority для счётчика контекста (real usage от провайдера > tiktoken-estimate).
- Компакция: атомарная запись summary + divider в одной транзакции.

---

## 8. Ключевые файлы

| Файл | Роль |
|---|---|
| `src/main/ipc/chat.ipc.ts` | chat:send, runChatSend, auto-recall, чекпоинты, sendDone |
| `src/main/ipc/historyCache.ts` | LRU-кэш распарсенной истории |
| `src/main/ipc/chatShared.ts` | очередь, autoRecallInjectedKeys, idle-extraction |
| `src/core/db/messages.ts` | saveMessage (INSERT OR REPLACE), getMessages |
| `src/core/db/handle.ts` | подключение + прагмы SQLite |
| `src/core/db/migrations/initialSchema.ts` | FTS5 trigram таблицы + триггеры |
| `src/core/memory/store/search.ts` | searchMemory, searchAllSources, buildCuratedSummary |
| `src/core/memory/chatSearch.ts` | FTS5 поиск по сообщениям/summary |
| `src/core/context/embeddings.ts` | TF-IDF/neural embeddings (neural выключен) |
| `src/core/tokens/usageTracker.ts` | tiktoken encoder + LRU-кэш токенов |
| `src/core/context/contextManager.ts` | rolling window, estimateTokens |
| `src/renderer/src/pages/Chat/ChatPage.tsx` | виртуализация, handleSend |
