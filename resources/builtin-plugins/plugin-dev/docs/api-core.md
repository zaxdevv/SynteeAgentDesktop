# API: storage, config, fs, clipboard, уведомления, звук, окно, шина

## storage — KV-хранилище плагина

Персистится в `{userData}/plugins-data/{pluginId}.json`, изолировано по плагину, дебаунс записи 500 мс. Прав не требует.

```js
await syntee.storage.set('counter', 42)
const c = await syntee.storage.get('counter')        // 42 (undefined если нет)
await syntee.storage.delete('counter')
```

## config — настройки из манифеста

Значения полей `manifest.config` (редактирует пользователь в карточке плагина):

```js
const key = await syntee.config.get('apiKey')         // значение или default
const all = await syntee.config.getAll()              // { apiKey: '…', limit: 10 }
```

Для секретов лучше `secrets` (шифрованное) — см. api-system.

## fs — файлы

Чтение — любые пути (`fs:read`). Запись внутри папки плагина — `fs:write`, вне — `fs:write:any`. Лимиты: чтение ≤ 5 МБ, запись ≤ 5 МБ/файл.

```js
const txt = await syntee.fs.readFile('C:/data/notes.txt')        // строка (utf-8)

// Бинарные файлы (картинки и т.п.) — base64:
const b64 = await syntee.fs.readFile('C:/pic.png', { encoding: 'base64' })
await syntee.fs.writeFile(out + '/copy.png', b64, { encoding: 'base64' })

await syntee.fs.writeFile(syntee.pluginDir + '/cache.json', '{}')
const entries = await syntee.fs.listDir('C:/Projects')           // string[] имён
const st = await syntee.fs.stat(path)                            // { exists, isFile, isDir, size, mtime }
await syntee.fs.mkdir(path, { recursive: true })
await syntee.fs.delete(path)                                     // файл или папка (рекурсивно)
await syntee.fs.rename(from, to)
await syntee.fs.copy(from, to)                                   // файл или папка (рекурсивно)

// Батч-запись — для генерации проектов (родительские папки создаются сами):
await syntee.fs.writeFiles({
  'package.json': '{…}',
  'src/index.ts': '…',
  'README.md': '…',
}, { baseDir: 'C:/Projects/new-app' })                            // ≤ 200 файлов, ≤ 10 МБ

// Наблюдение (возвращает cancel-функцию):
const stop = syntee.fs.watch(dir, (p) => {
  // p: { event, file }
}, { recursive: true })

// Нативные диалоги выбора (permission 'ui'):
const file = await syntee.fs.pickFile({ title: 'Выберите файл', filters: [{ name: 'Images', extensions: ['png', 'jpg'] }] })
const dir = await syntee.fs.pickDir({ title: 'Выберите папку' })   // null — отмена
```

## clipboard (`clipboard`)

```js
const text = await syntee.clipboard.readText()
await syntee.clipboard.writeText('в буфер')
```

## notifications (`notifications`)

```js
await syntee.notifications.show('Заголовок', 'Текст', {
  actions: [
    { label: 'Открыть', command: 'mycmd' },   // клик → слэш-команда плагина
    { label: 'Панель', panel: 'main' },       // клик → открыть панель registerPanel
  ],
})
```

## sound (`ui`)

```js
await syntee.sound.play('synth.send')   // встроенный id или путь к файлу в папке плагина
```

Встроенные: `synth.send`, `synth.done`, `synth.confirm` и др.

## window — тосты и диалоги (`ui`)

```js
await syntee.window.toast('Сохранено', 'success')      // 'info' | 'success' | 'error'
const btn = await syntee.window.dialog('Удалить?', 'Файл будет удалён', ['Отмена', 'Удалить'])
// btn — индекс нажатой кнопки (0 — первая/default)
```

## bus — шина между плагинами

```js
syntee.bus.emit('my-event', { data: 1 })        // всем запущенным плагинам (включая себя)
syntee.bus.on('my-event', (data) => { /* … */ })  // = syntee.on('bus:my-event', …)
```

## log — журнал плагина

Журнал виден в карточке плагина (вкладка Плагины). Вызов как функции = info:

```js
syntee.log('обычная запись')            // level: info
syntee.log.info('информация')
syntee.log.warn('warning: лимит почти исчерпан')
syntee.log.error('ошибка: API недоступен')
```

Ошибки fire-and-forget API (занятый шорткат, недоступный порт и т.п.) автоматически попадают в журнал с level `error`.

## shell (`net`)

```js
await syntee.shell.openExternal('https://example.com')   // в системном браузере
```

## net.fetch — бинарные ответы (`net`)

```js
// Картинка/архив: binary → bodyBase64 (лимит 1 МБ):
const r = await syntee.net.fetch('https://example.com/avatar.png', { binary: true })
const b64 = r.bodyBase64   // base64 бинарных данных
```
