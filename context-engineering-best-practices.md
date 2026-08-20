# Context Engineering для AI-агентов: лучшие практики 2026

> Сводка актуальных исследований и продакшен-практик по работе с контекстом
> при создании AI-агентов. Основано на материалах Anthropic, Sourcegraph,
> Stanford/UW, VentureBeat VB Pulse Q1 2026, Mem0, Zylos.ai, Tembo.io и др.

---

## Оглавление

1. [Контекст — это бюджет, а не ведро](#1-контекст--это-бюджет-а-не-ведро)
2. [Управление токенами (Token Budget Management)](#2-управление-токенами-token-budget-management)
3. [Вынос состояния из промпта (State Externalization)](#3-вынос-состояния-из-промпта-state-externalization)
4. [Архитектура памяти: три уровня](#4-архитектура-памяти-три-уровня)
5. [Sub-agents: изоляция контекста через делегирование](#5-sub-agents-изоляция-контекста-через-делегирование)
6. [RAG vs Long Context vs CAG](#6-rag-vs-long-context-vs-cag)
7. [Lost in the Middle — позиция в контексте имеет значение](#7-lost-in-the-middle--позиция-в-контексте-имеет-значение)
8. [Structured Note Taking](#8-structured-note-taking)
9. [Извлечение узкого контекста (Retrieve Narrowly)](#9-извлечение-узкого-контекста-retrieve-narrowly)
10. [Компактизация для long-horizon задач](#10-компактизация-для-long-horizon-задач)
11. [Сводный чеклист](#11-сводный-чеклист)
12. [Источники](#источники)

---

## 1. Контекст — это бюджет, а не ведро

Главная смена парадигмы 2025-2026: от **prompt engineering** к **context engineering**.
Anthropic, Sourcegraph и другие лидеры формулируют это так: контекстное окно —
это **ограниченный ресурс**, и каждый токен должен «заслуживать» своё место.

> «Before adding anything to context, ask whether it earns its tokens.»
> — Anthropic, *Effective Context Engineering for AI Agents* (Sep 2025)

**Практика:** прежде чем что-то добавить в контекст, спроси: несёт ли это сигнал
для текущего шага? Если нет — выкинь или вынеси во внешнее хранилище.

---

## 2. Управление токенами (Token Budget Management)

Это дисциплина отсечения низкосигнального контента **до** попадания в окно,
а не после (Sourcegraph, 2026):

| Техника | Что делает |
|---|---|
| **Truncation** | Обрезка выводов инструментов (tool outputs) до релевантной части |
| **Compaction** | Сжатие старой части диалога в running summary |
| **Relevance thresholding** | Дроп чанков из RAG ниже порога релевантности |
| **Capping** | Ограничение количества возвращаемых результатов |

**Ключевой принцип:** режьте низкосигнальный контент *до* того, как он попадёт
в контекстное окно, а не после.

---

## 3. Вынос состояния из промпта (State Externalization)

Всё, что агент должен «помнить», но не нужно в каждом шаге — **выносится наружу**:

- **Файлы / scratchpads** — рабочий буфер для промежуточных результатов
- **Memory store** — постоянное хранилище фактов, решений, предпочтений
- **База данных** — структурированные данные

Принцип: **в контексте только то, что нужно прямо сейчас**. Остальное живёт
снаружи и подтягивается по необходимости.

> «Move state out of the prompt. Use files, scratchpads, or a memory store
> for anything the agent needs to keep.» — HappyCapy

---

## 4. Архитектура памяти: три уровня

В 2026 году продакшен-системы разделяют память на три тира
(Mem0 / Zylos.ai / DevToolLab):

```
┌─────────────────────────────────────────┐
│  In-context memory                       │  ← что агент видит прямо сейчас
│  (текущий промпт + контекстное окно)      │
├─────────────────────────────────────────┤
│  Semantic memory                         │  ← факты, извлекаемые по запросу
│  (vector store: профиль, политики, факты) │     через RAG / embeddings
├─────────────────────────────────────────┤
│  Episodic memory                         │  ← история взаимодействий
│  (прошлые сессии, решения, обязательства)│     и принятые решения
└─────────────────────────────────────────┘
```

Дополнительно выделяют **procedural memory** — как агент выполняет задачи
(шаблоны, процедуры, навыки).

| Тир памяти | Что хранит | Пример |
|---|---|---|
| **In-context** | Текущий промпт + окно | Диалог, системный промпт |
| **Semantic** | Факты, конфигурации | Профиль пользователя, политики |
| **Episodic** | История взаимодействий | Прошлые решения, обязательства |
| **Procedural** | Процедуры, навыки | Шаблоны задач, скрипты |

**Тренд 2026:** hybrid vector-graph storage стал стандартом для production-систем
(Zylos.ai, April 2026).

---

## 5. Sub-agents: изоляция контекста через делегирование

Одна из ключевых практик 2025-2026 — **sub-agents (суб-агенты)**:

- Координатор делегирует задачу суб-агенту
- Суб-агент работает в **своём изолированном контекстном окне**
- Выполняет тяжёлую работу (чтение файлов, вызовы инструментов)
- Возвращает **только результат**, промежуточный контекст отбрасывается

```
┌──────────────┐
│  Coordinator │  чистый контекст
│  (оркестратор)│
└──────┬───────┘
       │ делегирует
       ├──► Sub-agent A ──► результат
       ├──► Sub-agent B ──► результат
       └──► Sub-agent C ──► результат
       (каждый в своём изолированном окне)
```

**Почему это работает:**

- Контекст координатора остаётся чистым
- Если суб-агент ошибся — его загрязнённый контекст не заражает остальных
- Позволяет масштабировать сложные задачи без переполнения
- Параллельное выполнение (до 3 одновременно, затем очередь)

> «Reach for subagents first.» — Tembo.io, *Claude Code Subagents: A 2026
> Practical Guide*

> «When a code review sub-agent fails, its corrupted context doesn't infect
> the test-generation pipeline.» — CodeGeeks

---

## 6. RAG vs Long Context vs CAG

Важная дискуссия 2026 года:

| Подход | Суть | Когда использовать |
|---|---|---|
| **RAG** | Внешняя БД + извлечение релевантных чанков | Большие базы знаний, точность важнее полноты |
| **Long Context** | Засунуть всё в окно (1M-2M токенов) | Документы умеренного размера, нужна полнота |
| **CAG** (Cache-Augmented) | Загрузить всё + кешировать | Документы помещаются в окно + повторные запросы |

### Ключевой инсайт: Long context НЕ убил RAG

RAG остаётся нужен, потому что:

- Семантический поиск иногда промахивается («silent failure») — но это
  решается улучшением retrieval, а не отказом от RAG
- Контекстное окно даже в 2M токенов — не бесконечно
- Дешевле извлечь 5 релевантных чанков, чем гнать 2M токенов каждый запрос

### Тренд 2026: Context Architecture

Гибридный подход, заменяющий чистый RAG. Инвестиции в retrieval optimization
выросли с **19% до 28.9%** за Q1 2026 (VB Pulse), впервые обогнав расходы на
evaluation.

---

## 7. Lost in the Middle — позиция в контексте имеет значение

Исследование Stanford + University of Washington (2023, проблема актуальна
и в 2026) показало **U-образную кривую** внимания:

```
Точность
  ▲
  │  ██                                    ██
  │  ██          ██        ██              ██
  │  ██    ██    ██   ██   ██    ██         ██
  │  ██    ██    ██   ██   ██    ██    ██   ██
  └──────────────────────────────────────────►
    начало              середина             конец
```

LLM лучше всего запоминает информацию из **начала и конца** контекста.
Информация из середины теряется («lost in the middle»).

Дополнительное исследование MIT + Google Cloud AI (2024, *Found in the
Middle*) подтвердило: это связано с **позиционным attention bias** —
трансформеры систематически меньше внимания уделяют середине.

**Практика:** кладите самое важное — в начало и конец контекста, не в середину.

---

## 8. Structured Note Taking

Вместо того чтобы держать весь диалог в контексте, агент ведёт
**структурированные заметки во внешнем документе**, которые живут отдельно
от истории разговора (Comet, 2026):

- Заметки обновляются по ходу работы
- При каждом шаге агент читает только релевантные заметки
- Избегает раздувания контекста историей сообщений

```
Диалог (растёт)          Scratchpad (компактный)
┌──────────────┐        ┌──────────────────────┐
│ msg 1        │        │ ## Текущая задача    │
│ msg 2        │        │ ## Решения           │
│ msg 3        │  ←──►  │ ## Факты             │
│ ...          │        │ ## TODO              │
│ msg 50       │        │ ## Открытые вопросы  │
└──────────────┘        └──────────────────────┘
```

---

## 9. Извлечение узкого контекста (Retrieve Narrowly)

> «Pull the specific facts a step needs, not whole documents.» — HappyCapy

Не тяните весь документ, если нужен один абзац. Не тяните весь диалог, если
нужно последнее решение. Чем уже извлечение — тем выше signal-to-noise ratio.

**Примеры:**

| ❌ Плохо | ✅ Хорошо |
|---|---|
| Тянуть весь файл на 5000 строк | Прочитать нужную функцию (offset/limit) |
| Тянуть весь диалог | Извлечь последнее решение из memory |
| Вернуть все результаты поиска | Top-5 релевантных с порогом |

---

## 10. Компактизация для long-horizon задач

Для задач, которые идут десятки минут или часы (миграции кодовой базы,
комплексный анализ) — Anthropic, Sep 2025:

1. Старая часть диалога **сжимается в summary** через LLM
2. Summary заменяет оригинальные сообщения в контексте
3. Агент продолжает с компактным контекстом + свежими сообщениями

```
[ msg1, msg2, ... msg40, msg41, msg42, msg43 ]
         │
         ▼ compaction
[ SUMMARY(msg1-40), msg41, msg42, msg43 ]
```

Это позволяет агенту работать дольше, чем размер контекстного окна.

---

## 11. Сводный чеклист

| # | Практика | Суть |
|---|---|---|
| 1 | **Context as budget** | Каждый токен должен заслуживать место |
| 2 | **Token budget management** | Truncate, threshold, cap выводы инструментов |
| 3 | **State externalization** | Состояние — в файлы/БД/память, не в промпт |
| 4 | **Three-tier memory** | In-context + semantic + episodic (+ procedural) |
| 5 | **Sub-agents** | Изолированный контекст через делегирование |
| 6 | **Retrieve narrowly** | Тянуть конкретные факты, не целые документы |
| 7 | **Position matters** | Важное — в начало/конец, не в середину |
| 8 | **Structured notes** | Внешний scratchpad вместо раздутой истории |
| 9 | **Compaction** | Сжатие старого диалога в summary для long-horizon |
| 10 | **Hybrid RAG + Long Context** | Не выбирать одно — комбинировать по задаче |

---

## Источники

1. **Anthropic** — *Effective Context Engineering for AI Agents* (Sep 2025)
   — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

2. **Sourcegraph** — *Context Engineering: A Practical Guide* (2026)
   — https://sourcegraph.com/blog/context-engineering

3. **HappyCapy** — *Context Engineering for AI Agents: A Practical 2026 Guide*
   — https://happycapy.ai/blog/context-engineering-ai-agents

4. **Stanford / University of Washington** — *Lost in the Middle: How LLMs
   Use Long Contexts*

5. **MIT + Google Cloud AI** (2024) — *Found in the Middle: Calibrating
   Positional Attention Bias Improves Long Context Utilization*

6. **VentureBeat VB Pulse Q1 2026** — *Context Architecture is Replacing RAG*
   — https://venturebeat.com/data/context-architecture-is-replacing-rag

7. **Mem0** — *State of AI Agent Memory 2026*
   — https://mem0.ai/blog/state-of-ai-agent-memory-2026

8. **Zylos.ai** — *AI Agent Memory Architectures: From Context Windows to
   Persistent Knowledge* (Apr 2026)
   — https://zylos.ai/research/2026-04-05-ai-agent-memory-architectures-persistent-knowledge

9. **DevToolLab** — *AI Agent Memory in 2026: Building Persistent Memory*
   — https://devtoollab.com/blog/ai-agent-memory-architecture

10. **Tembo.io** — *Claude Code Subagents: A 2026 Practical Guide*
    — https://www.tembo.io/blog/claude-code-subagents

11. **CodeGeeks** — *Agentic Context Engineering: How AI Agents Manage
    Context at Scale*
    — https://www.codegeeks.solutions/blog/agentic-context-engineering-how-ai-agents-work-with-context

12. **Comet** — *Context Engineering Best Practices for Agentic Systems*
    — https://www.comet.com/site/blog/context-engineering

13. **Victor Dibia** — *Context Engineering 101: How Agents Manage Context*
    — https://newsletter.victordibia.com/p/context-engineering-101-how-agents

14. **Atlan** — *Context Engineering Techniques for AI Agents: A 2026 Guide*
    — https://atlan.com/know/ai-agent/context-engineering/context-engineering-techniques-ai-agents

15. **Redis** — *Context Rot Explained (& How to Prevent It)*
    — https://redis.io/blog/context-rot

16. **PackMind** — *Context Engineering Best Practices for AI-Powered Dev*
    — https://packmind.com/context-engineering-ai-coding/context-engineering-best-practices

17. **Meta-Intelligence** — *Context Engineering Guide: RAG, Memory Systems
    & Dynamic Context for Production AI [2026]*
    — https://www.meta-intelligence.tech/en/insight-context-engineering

18. **ByteByteGo** — *A Guide to Context Engineering for LLMs*
    — https://blog.bytebytego.com/p/a-guide-to-context-engineering-for

---

*Собрано: 17 августа 2026*
