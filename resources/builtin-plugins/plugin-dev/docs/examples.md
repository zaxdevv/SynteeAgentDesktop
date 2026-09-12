# Примеры и шаблоны

## 1. Минимальный плагин с тулом

```
minimal/
  plugin.json
  dist/index.js
```

```json
{
  "id": "minimal",
  "name": "Minimal",
  "version": "0.1.0",
  "promptDescription": "Tool roll_dice rolls a dice (1-6).",
  "main": "dist/index.js",
  "permissions": []
}
```

```js
module.exports.activate = function (syntee) {
  syntee.registerTool({
    name: 'roll_dice',
    description: 'Roll a dice, returns 1-6',
    parameters: { type: 'object', properties: { sides: { type: 'number', description: 'Default 6' } } },
    handler: async (a) => String(1 + Math.floor(Math.random() * (Number(a.sides) || 6)))
  })
}
module.exports.deactivate = function () {}
```

## 2. Плагин с UI-панелью и RPC

```js
module.exports.activate = function (syntee) {
  let counter = 0

  syntee.registerPanel({ id: 'main', slot: 'right', title: 'Counter', entry: 'ui/panel.html' })

  syntee.ui.handle('get', async () => ({ counter }))
  syntee.ui.handle('bump', async () => {
    counter++
    syntee.ui.setBadge('main', counter)
    syntee.ui.emit('update', { counter })
    return { counter }
  })

  syntee.registerCommand({
    name: 'counter',
    description: 'Открыть счётчик',
    handler: async () => { syntee.ui.openModal({ entry: 'ui/panel.html' }) },
  })
}
```

`ui/panel.html` — шим synteeBridge из секции **ui** + кнопка `bump`.

## 3. Генератор проекта (fs:write:any)

```js
module.exports.activate = function (syntee) {
  syntee.registerTool({
    name: 'scaffold_site',
    description: 'Scaffold a static site: /site folder with index.html + styles',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: async ({ name }) => {
      const cur = await syntee.projects.current()
      const base = (cur.workdir || syntee.pluginDir) + '/site'
      await syntee.fs.writeFiles({
        'index.html': '<!DOCTYPE html>\n<html><head><title>' + name + '</title><link rel="stylesheet" href="styles.css"></head><body><h1>' + name + '</h1></body></html>',
        'styles.css': 'body { font-family: system-ui; margin: 2rem; }',
      }, { baseDir: base })
      return 'Создан сайт: ' + base
    },
  })
}
```

Манифест: `"permissions": ["fs:write:any", "projects:read"]`.

## 4. Фоновый мониторинг + уведомления

См. конец секции **api-system** (scheduler + net.fetch + notifications).

## 5. Контекст-провайдер (данные в system prompt)

```js
module.exports.activate = function (syntee) {
  syntee.registerContextProvider({
    name: 'standup',
    description: 'Текущие задачи из storage',
    handler: async ({ chatId }) => {
      const todos = (await syntee.storage.get('todos')) || []
      return todos.length ? '## Задачи пользователя\n' + todos.map(t => '- ' + t).join('\n') : ''
    },
  })
}
```

Право: `'context'`.

## Чек-лист перед публикацией плагина

- [ ] `id` = имя папки, `[a-zA-Z][a-zA-Z0-9_-]*`
- [ ] `promptDescription` (~200 симв., англ., перечислены тулы)
- [ ] Права — только используемые
- [ ] Секреты — в `secrets`, не в коде
- [ ] `deactivate()` чистит таймеры/watchers/shortcut-ы
- [ ] readme.md с описанием и примерами
- [ ] Проверка: включи плагин → консоль карточки (журнал) без ошибок → тул вызван из чата

## Отладка

- **Журнал**: карточка плагина → «Подробнее» → Журнал (`syntee.log(...)`).
- **Hot-reload**: сохрани файл → плагин перезапустится сам (дебаунс 800 мс).
- **Исходники чужого плагина**: тул `read_plugin` (plugin-dev).
- **Валидация**: тул `validate_plugin` (plugin-dev).
- **DevTools iframe-панелей**: контекстное меню панели (если включено в приложении).
