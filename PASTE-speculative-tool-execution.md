# PASTE — Speculative Tool Execution

> **Pattern-Aware Speculative Tool Execution** (Shanghai Jiao Tong University + Microsoft Research, March 2026)
> Идея украдена у CPU — speculative execution, но для AI-агентов.

---

## Суть одним предложением

Middleware между агентом и tool'ами **предзапускает следующий tool call** ещё до того, как LLM его сгенерировал — если угадал, результат готов мгновенно; если нет — выкидывает и ждёт как обычно.

## Цифры

| Метрика | Значение |
|---------|----------|
| Снижение задержки | **48.5%** в среднем |
| Hit rate (точность предсказания) | **93.8%** |
| Overhead памяти | 2.6 MB |
| Безопасность | 602 side-effecting действий заблокировано из 20K+ предзапусков |

---

## Как работает

### Аналогия

Повар видит, что ты 100 раз подряд делал: разбей яйца → налей молоко → добавь муку.
На 101-й раз, как только ты разбил яйца — повар **уже достаёт муку** и ставит рядом.
Если ты решил жарить яичницу вместо пирога — муку убирает назад. Ноль вреда.

### В агенте

**Без PASTE:**
```
LLM думает → read_file  → ждём ответ
LLM думает → edit_file  → ждём ответ
LLM думает → run_command→ ждём ответ
```
Каждый шаг = раунд-трип к LLM (секунды ожидания).

**С PASTE:**
```
LLM → read_file  → ответ
LLM → edit_file  → ответ
                    PASTE видит паттерн read→edit→test
                    и ЗАПУСКАЕТ run_command заранее
LLM думает "запущу тесты" → результат УЖЕ ГОТОВ, отдаёт мгновенно
```

---

## Откуда берёт аргументы (КАК угадывает файлы/команды)

PASTE НЕ угадывает файлы из воздуха и НЕ задаёт вопросов пользователю.

| Тип аргумента | Откуда берёт |
|---------------|-------------|
| Тот же файл, что в предыдущем шаге | Копирует из `edit_file("src/auth.ts")` → `run_command` тоже про `auth` |
| Фиксированная команда (`npm test`) | Из паттерна — она всегда одинаковая |
| Новый файл, которого не было | **НЕ угадывает** — ждёт LLM как обычно |

### Конкретный пример

Паттерн встречался 20 раз:
```
1. read_file("src/auth/login.ts")
2. edit_file("src/auth/login.ts", ...)
3. read_file("src/auth/login.test.ts")
4. run_command("npm test src/auth/login.test.ts")
```

На 21-й раз PASTE после шага 2 предзапускает шаги 3 и 4.
Выигрыш: ~4-8 секунд (не ждём 2 раунд-трипа к LLM).

---

## Когда НЕ сработает

- LLM решает читать **другой** файл (не из паттерна) → результат выкидывается, ждём реальный вызов
- Команда зависит от контекста (`git commit -m "фикс конкретного бага"`) → непредсказуемо, не предзапускаем
- Новый паттерн (первый раз) → нет истории, нет предзапуска

**Ноль риска для правильности** — это чистая оптимизация скорости.

---

## Архитектура для интеграции в Electron-агента

```
┌─────────────────────────────────────────────┐
│                 LLM (Claude/GPT)             │
└──────────────────┬──────────────────────────┘
                   │ tool_call
                   ▼
┌─────────────────────────────────────────────┐
│              PASTE Middleware                │
│                                              │
│  ┌─────────────┐    ┌────────────────────┐  │
│  │ Pattern DB   │◄──│ Execution Trace Log │  │
│  │ (n-gram)    │    │ (последние N шагов) │  │
│  └──────┬──────┘    └────────────────────┘  │
│         │                                    │
│         │ предсказание следующего tool_call  │
│         ▼                                    │
│  ┌─────────────┐                            │
│  │ Speculative  │ → если confident → запуск │
│  │ Executor     │ → если нет → ждём LLM     │
│  └─────────────┘                            │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│              Tools (read, edit, run)         │
└─────────────────────────────────────────────┘
```

### Компоненты

1. **Execution Trace Log** — кольцевой буфер последних N вызовов tool'ов (name + args + result)
2. **Pattern DB** — n-gram модель: для последовательности `[read, edit]` хранит `P(run_command) = 0.9`
3. **Speculative Executor** — если P > threshold (например 0.85):
   - Извлекает аргументы (копирует файл из предыдущего шага / фиксированную команду)
   - Запускает tool в фоне
   - Кладёт результат в cache
4. **Cache** — когда LLM реально вызывает tool, проверяем: есть ли в cache? Если да и аргументы совпали — отдаём мгновенно. Нет — выполняем как обычно.

### Где живёт в Electron

- Middleware между LLM-response-handler и tool-executor
- Pattern DB — JSON/SQLite в `userData/paste-patterns.json`
- Trace Log — in-memory ring buffer (не персистентный)
- Speculative runs — `worker_threads` или `child_process` (чтобы не блокировать main thread)

### Псевдокод

```typescript
class PASTEMiddleware {
  traceLog: TraceEntry[] = []  // ring buffer
  patternDB: Map<string, Map<string, number>> // n-gram → next tool → probability
  resultCache: Map<string, ToolResult>       // cache key → result
  threshold = 0.85

  onToolCall(tool: string, args: any): ToolResult {
    // 1. Проверить cache — может уже предзапущено
    const cacheKey = `${tool}:${JSON.stringify(args)}`
    if (this.resultCache.has(cacheKey)) {
      const cached = this.resultCache.get(cacheKey)!
      this.resultCache.delete(cacheKey)
      return cached  // мгновенно
    }

    // 2. Выполнить реально
    const result = executeTool(tool, args)

    // 3. Записать в trace
    this.traceLog.push({ tool, args, result })
    this.updatePatterns()

    // 4. Предзапустить следующий
    this.trySpeculative()

    return result
  }

  trySpeculative() {
    const lastN = this.traceLog.slice(-2)  // последние 2 шага
    const key = lastN.map(e => e.tool).join('→')
    const predictions = this.patternDB.get(key)

    if (!predictions) return

    // Находим самый вероятный следующий tool
    let bestTool = '', bestProb = 0
    for (const [t, p] of predictions) {
      if (p > bestProb) { bestTool = t; bestProb = p }
    }

    if (bestProb < this.threshold) return

    // Предсказываем аргументы
    const predictedArgs = this.predictArgs(bestTool, lastN)
    if (!predictedArgs) return  // не смогли — не рискуем

    // Предзапуск в фоне
    const cacheKey = `${bestTool}:${JSON.stringify(predictedArgs)}`
    executeTool(bestTool, predictedArgs).then(result => {
      this.resultCache.set(cacheKey, result)
    })
  }

  predictArgs(tool: string, trace: TraceEntry[]): any | null {
    // Фиксированная команда (npm test) — возвращаем как есть
    if (tool === 'run_command' && this.isFixedCommand(tool, trace)) {
      return { command: this.getFixedCommand(tool, trace) }
    }
    // Тот же файл — копируем из предыдущего шага
    const lastFile = trace[trace.length - 1]?.args?.path
    if (lastFile && tool === 'read_file') {
      return { path: lastFile.replace(/\.ts$/, '.test.ts') }  // эвристика
    }
    // Непредсказуемо — не угадываем
    return null
  }

  updatePatterns() {
    // Обновляем n-gram вероятности на основе traceLog
    for (let i = 0; i < this.traceLog.length - 2; i++) {
      const key = `${this.traceLog[i].tool}→${this.traceLog[i+1].tool}`
      const next = this.traceLog[i+2].tool
      if (!this.patternDB.has(key)) this.patternDB.set(key, new Map())
      const probs = this.patternDB.get(key)!
      probs.set(next, (probs.get(next) ?? 0) + 1)
    }
    // Нормализовать в вероятности
    for (const probs of this.patternDB.values()) {
      let total = 0
      for (const p of probs.values()) total += p
      for (const [t, p] of probs) probs.set(t, p / total)
    }
  }
}
```

---

## Что запомнить

- **PASTE = speculative execution для tool calls**
- Угадал → мгновенно. Не угадал → как обычно. **Ноль риска.**
- Аргументы берёт из **предыдущего шага** (тот же файл) или **фиксированного паттерна** (та же команда)
- Файлы из воздуха НЕ угадывает, вопросов пользователю НЕ задаёт
- 48.5% ускорение, 93.8% hit rate
- В Electron — middleware между LLM-handler и tool-executor + worker_threads для фона

## Источники

- PASTE paper (March 2026, Shanghai Jiao Tong University + Microsoft Research)
- Предшественник: "Speculative Actions" (MIT/Cornell, Oct 2025)
