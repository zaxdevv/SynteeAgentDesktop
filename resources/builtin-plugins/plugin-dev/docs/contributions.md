# Вклады в UI: виджеты, поиск, темы, фон, статусбар

Все требуют permission `'ui'`.

## Инлайн-виджеты в чате

Карточка-iframe прямо в сообщении (тул возвращает `__plugin_ui__`-маркер, см. **tools**):

```js
syntee.ui.registerWidget({ name: 'chart', entry: 'ui/chart.html', height: 260, description: 'График' })
```

Виджет получает данные через `synteeBridge`: хост передаёт `data` из маркера (см. ui.md — шим; данные приходят сообщением при загрузке).

## Markdown-рендереры кодоблоков

Кодоблок ```` ```mylang ```` в ответах модели рендерится твоим iframe:

```js
syntee.registerMarkdownRenderer({ language: 'mermaid', entry: 'ui/mermaid.html', height: 320 })
```

Код блока приходит в виджет через мост (как у виджетов).

## Search provider (глобальный поиск Spotlight)

```js
syntee.registerSearchProvider({
  id: 'notes',
  label: 'Заметки',
  handler: async (q) => {
    if ('query' in q) {
      // q.query — строка поиска → результаты
      return [
        { id: 'n1', label: 'Заметка 1', sub: 'превью', icon: 'note' },
      ]
    }
    // q.click — клик по результату { id, label, ... }
    syntee.ui.openModal({ entry: 'ui/note.html' })
  },
})
```

## Autocomplete в поле ввода

```js
syntee.registerAutocomplete({
  trigger: '@note',          // после ввода этого слова — подсказки
  handler: async (q) => [
    { label: 'Заметка 1', insertText: 'ссылка на заметку 1' },
    { label: 'Команда', command: 'mycmd' },   // клик выполнит команду
  ],
})
```

## Контекстное меню сообщений

```js
syntee.registerContextMenu({
  id: 'translate',
  label: 'Перевести',
  icon: 'languages',
  scope: 'selection',     // 'selection' (выделенный текст) | 'message' (всё сообщение)
  button: true,           // true — кнопка в ряду действий сообщения, а не в меню «⋯»
  handler: async (p) => {
    // p: { messageId?, chatId?, content?, selection? }
    const text = p.selection || p.content || ''
    // …
  },
})
```

## Кнопки над полем ввода

```js
syntee.registerInputAction({
  id: 'quick-note',
  label: 'Заметка',
  icon: 'note',
  tooltip: 'Быстрая заметка',
  command: 'note',        // клик → слэш-команда плагина
  // без command — событие 'input-action' { id }
})
```

## Темы

```js
syntee.registerTheme({
  name: 'Nord',
  dark: true,
  colors: {
    '--bg': '#2e3440',
    '--text': '#d8dee9',
    '--accent': '#88c0d0',
    // … CSS-переменные приложения
  },
})
```

Тема появляется в ThemePicker приложения.

## Фоны

```js
syntee.registerBackground({
  id: 'waves',
  name: 'Waves',
  kind: 'shader',        // 'shader' | 'video' | 'image'
  src: 'ui/bg.frag',    // файл относительно папки плагина
})
```

Появляется в пикере фонов (AnimatedBackground).

## Status bar

Полоса внизу главного окна:

```js
syntee.statusbar.set('my-status', '● онлайн', { tooltip: 'Сервис доступен', command: 'mycmd' })
syntee.statusbar.clear('my-status')
```

## Overlay

HTML плагина поверх всего экрана (frameless, always-on-top):

```js
await syntee.overlay.show({ entry: 'ui/popup.html', data: { hello: 1 }, width: 360, height: 240, timeoutMs: 5000 })
await syntee.overlay.hide()
```

Требует permission `'overlay'`.
