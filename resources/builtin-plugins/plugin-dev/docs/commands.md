# Слэш-команды — registerCommand

Слэш-команда — быстрое действие пользователя из поля ввода: `/name аргументы`. Появляется в автокомплите (после ввода `/`), выполняется **до** отправки сообщения агенту.

```js
syntee.registerCommand({
  name: 'joke',                    // [a-zA-Z][a-zA-Z0-9_]*, без слэша
  description: 'Рассказать шутку',
  icon: 'smile',                   // опционально: имя иконки
  handler: async (args) => {
    // args — строка после /joke (может быть пустой)
    const r = await syntee.net.fetch('https://official-joke-api.appspot.com/random_joke')
    const j = JSON.parse(r.body)
    return j.setup + '\n\n…' + j.punchline
  },
})
```

## Поведение

- Возврат строки → сохраняется как **сообщение ассистента** в текущем чате (пользователь видит результат; агент — тоже, это часть истории).
- Возврат `undefined`/`null` → ничего не добавляется (для команд с побочными эффектами: открытие панели, уведомление).
- Ошибка → сообщение об ошибке в чате.
- Команда не запускает агент — это прямой вызов кода плагина.
- Снять регистрацию в рантайме: `syntee.unregisterCommand('joke')` — команда исчезает из списка.

## Связка с UI

Кнопки (`registerUi` type 'button'), пункты трея, кнопки уведомлений и input actions могут ссылаться на команду через `command: 'joke'` — клик выполнит её без ввода.

## Примеры

```js
// Команда с панелью
syntee.registerCommand({
  name: 'notes',
  description: 'Открыть мои заметки',
  handler: async () => {
    syntee.ui.openModal({ entry: 'ui/notes.html', title: 'Заметки' })
  },
})

// Команда с аргументами
syntee.registerCommand({
  name: 'remind',
  description: 'Напоминание через N минут: /remind 10 позвонить',
  handler: async (args) => {
    const [min, ...rest] = args.split(' ')
    syntee.scheduler.at(Number(min) * 60000, () => {
      syntee.notifications.show('Напоминание', rest.join(' '))
    })
    return 'Напомню через ' + min + ' мин.'
  },
})
```
