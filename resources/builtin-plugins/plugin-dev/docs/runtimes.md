# Рантаймы: Node.js и Python

Логика плагина исполняется в изолированном utilityProcess. Хост (pluginHost)
загружает entry-файл и общается с ним JSON-сообщениями протокола. Рантайм
задаётся в манифесте:

```json
{ "runtime": "python", "main": "dist/main.py" }
```

Без поля `runtime` — `"node"` (обратная совместимость).

## Node.js (по умолчанию)

- `main` — CJS-модуль (`dist/index.js`), экспортирует `activate(syntee)` /
  `deactivate()`. Относительные `require()` работают из коробки.
- **npm-зависимости поддерживаются**: utilityProcess — полноценный Node-процесс
  со стандартным module resolution, `require('pkg')` из entry резолвится в
  `node_modules` **папки плагина**. Зависимости объявляются в манифесте:

```json
{ "dependencies": ["lodash", "dayjs@1.11"] }
```

  - **Устанавливаются автоматически** при первом запуске плагина
    (`npm install --omit=dev …` в папку плагина), лог npm идёт в журнал.
  - В карточке плагина (UI) — статус + кнопка **Установить** (как у pip).
  - Маркер установки — `.npm-deps.json`; смена списка `dependencies`
    сбрасывает его.
  - Ограничения: пакеты должны быть **CJS-совместимыми** (`require()`
    ESM-only пакета упадёт — такие бандлить заранее, напр. esbuild);
    **нативные `.node`-модули** не гарантированы (должны быть собраны под
    ABI Electron). Для тяжёлых деревьев зависимостей бандлинг всё равно
    предпочтительнее (меньше вес, быстрее старт).

## Python

- `main` — Python-файл (`dist/main.py`). Хост спавнит sidecar-процесс
  `python dist/main.py` и проксирует тот же протокол через stdin/stdout
  (JSON Lines). Изоляция даже лучше: крах Python-кода не роняет хост.
- Нужен установленный **Python 3.8+**. Детект: `SYNTEE_PYTHON` → `python` →
  `python3` → `py -3` (Windows). Override: `runtimePath` в манифесте
  (можно venv).
- **SDK**: `from syntee import syntee` — хост кладёт SDK в `PYTHONPATH`
  (`{userData}/python-sdk/syntee.py`, только stdlib).

### Шаблон

```python
from syntee import syntee

@syntee.tool("hello", "Поздороваться", parameters={
    "type": "object",
    "properties": {"name": {"type": "string"}},
    "required": ["name"],
})
def hello(args):
    return f"Привет, {args['name']}!"

@syntee.command("demo", "Демо-команда")
def demo(args):          # args — строка после /demo
    return "получил: " + args

@syntee.on("chat:message")
def on_message(payload):
    syntee.log("сообщение: " + str(payload.get("content", "")))

@syntee.deactivate
def on_shutdown():
    pass

syntee.run()   # ОБЯЗАТЕЛЬНО последней строкой — цикл обработки
```

### API SDK

| Вызов | Что делает | Permission |
|---|---|---|
| `syntee.tool(name, description, parameters)` | декоратор тула для AI | — |
| `syntee.command(name, description, icon)` | декоратор слэш-команды | — |
| `syntee.on(event)` | хендлер события/хука (см. events) | `hooks` для хуков контента |
| `syntee.deactivate(fn)` | очистка при выключении | — |
| `syntee.log(msg, level)` | запись в журнал (карточка UI) | — |
| `syntee.storage.get/set/delete(key, …)` | персистентное KV-хранилище | — |
| `syntee.config_get(key, default)` | значение настройки (config) | — |
| `syntee.fetch(url, method, headers, body, binary)` | HTTP через хост | `net` |
| `syntee.notify(title, body)` | системное уведомление | `notifications` |
| `syntee.host_request(method, **params)` | любой host-API (api-core…) | по методу |
| `syntee.plugin_dir` / `syntee.permissions` / `syntee.version` | контекст | — |

Хуки (`chat:before-send`, `tool:result`, `prompt:before-build`): хендлер
возвращает `None` (allow), `{"action": "modify", "content": …}` или
`{"action": "reject", "reason": …}`.

### Зависимости (requirements)

pip-зависимости объявляются в манифесте:

```json
{ "runtime": "python", "requirements": ["requests", "rich>=13"] }
```

- **Устанавливаются автоматически** при первом запуске плагина
  (`python -m pip install …`), лог pip идёт в журнал плагина.
- В карточке плагина (UI) виден статус: «⚠ требуются зависимости» +
  кнопка **Установить** (переустановка вручную), либо «✓ установлены».
- Маркер установки — `.deps.json` в папке плагина; смена списка
  `requirements` в манифесте сбрасывает его.

### Ограничения Python-рантайма (v1)

- UI-вклады (registerPanel, ui.handle) пока не поддержаны SDK — логика и
  тулы только. UI-панели появятся в следующих версиях.
- `structure: "multi"` игнорируется — генерируется один `dist/main.py`
  (свои модули можно импортировать обычными `import`).
- Hot reload работает так же (правка `dist/main.py` → перезапуск).

## Что дальше

Другие рантаймы (Go/Rust/C# — бинарник, говорящий по протоколу JSON Lines
через stdio) добавляются по тому же рецепту: мост в pluginHost + SDK языка.
