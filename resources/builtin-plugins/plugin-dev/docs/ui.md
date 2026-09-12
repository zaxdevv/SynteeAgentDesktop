# UI: панели, iframe, мост synteeBridge

UI плагина — HTML-файл, рендерящийся в **sandboxed iframe** (без `allow-same-origin` — DOM приложения недоступен). Файлы отдаются по кастомному протоколу:

```
syntee-plugin://{pluginId}/{относительный/путь}
```

Хост отдаёт только файлы из папки плагина (path traversal закрыт).

## Слоты и регистрация

```js
// Кнопка в низу сайдбара (клик → слэш-команда плагина)
syntee.registerUi({ slot: 'sidebar', type: 'button', label: 'Мой плагин', icon: 'star', command: 'mycmd' })

// Панель — таб в правой панели приложения (keep-alive, бейджи)
syntee.registerPanel({ id: 'main', slot: 'right', title: 'Мой плагин', icon: 'star', entry: 'ui/panel.html' })

// Модальная панель (по требованию)
syntee.ui.openModal({ entry: 'ui/form.html', title: 'Форма', width: 480, height: 360 })
syntee.ui.closeModal()

// Бейдж на правой панели (число или null — сброс)
syntee.ui.setBadge('main', 3)
```

Слоты `registerPanel`:

| Слот | Где рендерится |
|---|---|
| `'right'` | таб в правой панели приложения (keep-alive, бейджи через `ui.setBadge`) |
| `'sidebar'` | кнопка/панель в сайдбаре |
| `'bottom'` | таб в нижнем доке (горизонтальная панель под чатом) |
| `'page'` | полноэкранный оверлей в области чата (свой «экран» поверх сообщений) |
| `'modal'` | модальное окно (обычно через `ui.openModal`, без registerPanel) |

Entry — путь относительно папки плагина; по умолчанию `manifest.ui`.

Требуется permission `'ui'`.

## Мост synteeBridge (внутри iframe)

Хост НЕ инъектит мост — подключи шим в свой HTML:

```html
<script>
const synteeBridge = (() => {
  let seq = 0
  const pending = new Map()
  const handlers = new Map()
  window.addEventListener('message', (e) => {
    const d = e.data
    if (!d || d.source !== 'syntee-plugin-host') return
    // RPC-ответ
    if (d.rpc && pending.has(d.id)) {
      const p = pending.get(d.id); pending.delete(d.id)
      d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || 'RPC error'))
      return
    }
    // Тема (при загрузке iframe и при смене)
    if (d.theme) { /* { theme, accentColor, dark } */ return }
    // Push от плагина: syntee.ui.emit(method, data) приходит обёрнутым
    // в { __rpc__: true, method, data } внутри d.data
    if (d.data && d.data.__rpc__) {
      ;(handlers.get(d.data.method) || []).forEach(cb => { try { cb(d.data.data) } catch (err) { console.error(err) } })
      return
    }
    // Legacy push (syntee.ui.postMessage)
    if (d.data !== undefined) {
      ;(handlers.get('*') || []).forEach(cb => { try { cb(d.data) } catch (err) { console.error(err) } })
    }
  })
  return {
    call(method, args) {           // → syntee.ui.handle(method) в процессе плагина
      const id = 'rpc-' + (++seq)
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        parent.postMessage({ source: 'syntee-plugin', rpc: true, id, method, args }, '*')
      })
    },
    on(method, cb) {               // push из плагина: syntee.ui.emit(method, data)
      if (!handlers.has(method)) handlers.set(method, [])
      handlers.get(method).push(cb)
    },
    _handlers: handlers,
  }
})()
</script>
```

### Прямые host-методы из iframe (без хопа в процесс плагина)

`synteeBridge.call(method, args)` с этими именами идёт сразу в main (права манифеста проверяются):

`fs.readFile`, `fs.listDir`, `fs.stat`, `config.get`, `config.getAll`, `ui.getTheme`, `clipboard.readText`, `clipboard.writeText`, `storage.get`, `storage.set`, `storage.delete`, `chats.list`, `chats.get`, `projects.list`, `projects.current`, `memory.search`, `ai.listModels`

Все остальные методы → RPC в `syntee.ui.handle(method, handler)` процесса плагина.

## Сторона плагина

```js
// RPC-хендлеры (вызовы из iframe)
syntee.ui.handle('getStats', async (args) => ({ calls: 42 }))
syntee.ui.handle('save', async (args) => { await syntee.storage.set('draft', args.text); return { saved: true } })

// Push во все свои iframe (synteeBridge.on('update', cb) в панели)
syntee.ui.emit('update', { count: 43 })

// Legacy-канал (fire-and-forget postMessage)
syntee.ui.onMessage((data) => { /* сообщение из iframe */ })
syntee.ui.postMessage({ hello: true })   // → во все свои панели
```

## Тема

```js
const { theme, accentColor, dark } = await syntee.ui.getTheme()
syntee.on('theme:changed', (p) => { /* { theme, accentColor, dark } */ })
```

⚠️ **Важно:** iframe изолирован (sandbox без `allow-same-origin`) — CSS-переменные приложения (`--bg`, `--text`, `--accent`…) **не наследуются** в документ плагина. Хост присылает тему сообщением `{source:'syntee-plugin-host', theme:{theme, accentColor, dark}}` при загрузке iframe и при каждой смене темы/акцента. Чтобы выглядеть «как в проге» — применяй её к `:root` сам:

```js
// шим темы: сообщение хоста → CSS-переменные документа
function applyTheme(t) {
  const s = document.documentElement.style
  s.setProperty('--accent', t.accentColor)
  s.setProperty('--text',   t.dark ? '#e6e6ec' : '#1c1c22')
  s.setProperty('--text-2', t.dark ? '#9aa0ae' : '#5b616e')
  s.setProperty('--bg',     t.dark ? '#141418' : '#f7f7f9')
  s.setProperty('--bg-2',   t.dark ? '#1c1c22' : '#ffffff')
  s.setProperty('--border', t.dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.10)')
}
window.addEventListener('message', (e) => {
  const d = e.data
  if (d && d.source === 'syntee-plugin-host' && d.theme) applyTheme(d.theme)
})
```

Дальше в CSS — `color: var(--text)`, `border: 1px solid var(--border)`, `background: var(--accent)` и т.д. Панель будет перекрашиваться вместе с приложением (27 тем + кастомный акцент).

## Дизайн панелей: как выглядеть нативно

Шаблоны `create_plugin` (withUi) уже содержат готовый каркас — мост, тему, SVG-иконки, демо-RPC. Правила хорошего тона:

- **Цвета — только через CSS-переменные** из шима темы выше. Не хардкодь тёмные цвета — панель должна работать и в светлых темах.
- **Шрифт** — `system-ui, -apple-system, 'Segoe UI', sans-serif` (как у приложения).
- **Радиусы** — 8–12px у карточек, 6–8px у кнопок/инпутов.
- **Иконки — inline SVG** (stroke, `stroke-width: 1.75`, размер 16–18px). Внешние icon-пакеты не грузить — CSP разрешает только свою папку:

```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>  <!-- молния -->
</svg>
```

- **Layout**: шапка (иконка + название), сетка stat-карточек, ряд action-кнопок, список. Скролл — `overflow-y: auto` у контента, шапка фиксирована.
- **Состояния**: hover у кнопок (`filter: brightness(1.1)`), loading (спиннер или «…»), ошибки — красным + текст, не alert.
- **Данные** — только через `synteeBridge.call(...)`; рендер после ответа, до ответа — skeleton/placeholder.

## Кастомный UI настроек — configUi

`manifest.configUi: 'ui/settings.html'` — iframe в карточке плагина вместо декларативной формы `config`. Панель читает/пишет настройки через `synteeBridge.call('…')` → свои `ui.handle`-хендлеры (например, хранит в `storage` или `secrets`).

## Секция в настройках приложения — registerSettingsSection (`ui`)

Своя вкладка в SettingsPage (iframe) — для богатой конфигурации, которая не влезает в декларативную форму `config` и не тонет в карточке плагина:

```js
syntee.registerSettingsSection({
  id: 'main',
  title: 'My Plugin',
  entry: 'ui/settings.html',   // путь относительно папки плагина
})
syntee.unregisterSettingsSection('main')
```

Отличие от `configUi`: `configUi` рендерится **внутри карточки плагина**, а секция — полноценная вкладка в настройках приложения (в ряду остальных). Работает как обычный iframe-UI: `synteeBridge.call(...)` → `syntee.ui.handle(...)`.

## Chat overlay — плавающая панель поверх чата (`ui`)

В отличие от `overlay.show` (отдельное окно поверх всего) и `openModal` (модалка с затемнением) — компактный iframe, висящий над областью переписки в главном окне. Живые данные — через `ui.emit` + `synteeBridge.on`:

```js
syntee.ui.showChatOverlay({ entry: 'ui/live.html', title: 'Live', width: 360, height: 300, position: 'right' })
syntee.ui.hideChatOverlay()
```

## Live-карточка прогресса — ui.beginProgress (`ui`)

Для долгих операций тулов: плавающая карточка над полем ввода чата с текстом статуса.

```js
const progress = syntee.ui.beginProgress({ label: 'Рендерю сцену…' })
progress.update('Кадр 12/40')   // обновляет текст карточки в чате
progress.finish()               // убирает карточку
```

Пока карточка жива — тул «работает» визуально. Вызывай `finish()` в конце (лучше — в `finally`), иначе карточка повиснет.

## События жизненного цикла панелей

Плагин узнаёт, что его панель реально открыли/закрыли (ленивая загрузка данных):

```js
syntee.on('panel:opened', (p) => { /* p: { panelId } */ })
syntee.on('panel:closed', (p) => { /* p: { panelId } */ })
```

Работает для right-табов, page, bottom, modal. Прав не требует.

## Кастомные теги сообщений — registerMessageTag (`ui`)

Плагин регистрирует собственный тег, который AI вставляет в текст ответа, а приложение рендерит как iframe-карточку прямо в сообщении:

```js
syntee.ui.registerMessageTag({
  tag: 'kanban',                                    // [a-zA-Z][a-zA-Z0-9-]*
  entry: 'ui/tag.html',                             // HTML-файл в папке плагина
  height: 300,                                       // высота карточки, px (по умолчанию 260)
  description: 'Канбан-доска — вставляй для визуализации задач', // попадает в system prompt
})
```

`description` виден модели — AI узнаёт, что тег существует, и может вставлять его в ответ парно или самозакрыто:

```html
<kanban title="Спринт">куплено;сделано;готово</kanban>
<kanban data="todo|doing|done" />
```

Незарегистрированный тег остаётся обычным текстом.

Свойства тега приходят в iframe как `widgetData`:

| Поле | Тип | Что это |
|---|---|---|
| `widgetData.attrs` | `Record<string, string>` | распарсенные атрибуты тега (`title`, `data`, …) |
| `widgetData.inner` | `string` | внутренний текст тега |

Пример `ui/tag.html`, читающего теги:

```html
<!DOCTYPE html>
<html><body>
<div id="board"></div>
<script>
function render(widgetData) {
  const attrs = widgetData.attrs || {}
  const inner = widgetData.inner || ''
  const columns = (attrs.data || '').split('|').filter(Boolean)
  document.getElementById('board').innerHTML =
    '<h3>' + (attrs.title || 'Доска') + '</h3>' +
    (columns.length ? '<ul>' + columns.map(c => '<li>' + c + '</li>').join('') + '</ul>'
                    : '<pre>' + inner + '</pre>')
}
// Хост присылает widgetData сообщением — как тему, через syntee-plugin-host
window.addEventListener('message', (e) => {
  const d = e.data
  if (d && d.source === 'syntee-plugin-host' && d.widgetData) render(d.widgetData)
})
</script>
</body></html>
```

Снять регистрацию: `syntee.ui.unregisterMessageTag('kanban')`.

## Action-кнопки у инлайн-виджетов (`ui`)

Тул может вернуть виджет с кнопками под карточкой — клик выполняет слэш-команду плагина или открывает панель:

```js
return JSON.stringify({
  __plugin_ui__: true,
  pluginId: 'myplugin',
  entry: 'ui/card.html',
  data: { … },
  height: 260,
  actions: [
    { label: 'Обновить', command: 'refresh' },   // слэш-команда плагина (см. commands)
    { label: 'Открыть панель', panel: 'main' },  // панель из registerPanel
  ],
})
```

`command` — имя слэш-команды плагина (`/refresh`), `panel` — id панели из `registerPanel`. Кнопки рендерятся внизу карточки виджета.

## unregister — снять регистрацию панели

```js
syntee.unregisterPanel('main')   // панель закрывается у пользователя
```

## Системные диалоги — fs.pickFiles / fs.saveDialog (`ui`)

```js
// Выбор нескольких файлов → массив абсолютных путей
const files = await syntee.fs.pickFiles({
  title: 'Выберите файлы',
  filters: [{ name: 'Images', extensions: ['png', 'jpg'] }],
})

// Диалог сохранения → путь файла (null — пользователь отменил)
const path = await syntee.fs.saveDialog({ title: 'Сохранить отчёт', defaultPath: 'report.md' })
```

Отмена диалога → `[]` / `null` — обрабатывай оба случая.

## Ограничения iframe

- Sandbox: нет доступа к DOM приложения, localStorage родителя, файловой системе напрямую.
- CSP хоста: скрипты только из своей папки (через syntee-plugin://), инлайн-`<script>` в своих файлах работает.
- Один HTML = один iframe; для сложных экранов делай SPA внутри одного файла.
