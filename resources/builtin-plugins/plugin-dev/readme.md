# Plugin Dev — студия разработки плагинов

Встроенный плагин SynteeHelper: всё необходимое для создания собственных плагинов.

## Тулы (для AI)

| Тул | Что делает |
|---|---|
| `plugin_docs` | Полная документация plugin API. Без аргументов — оглавление, с `section` — конкретная секция (вкл. `architecture`) |
| `create_plugin` | Скаффолдинг нового плагина: plugin.json + readme + код. `structure:"multi"` — модульная архитектура (index/tools/commands/state/ui), `"single"` — один файл |
| `list_plugins` | Список установленных плагинов с манифестами |
| `read_plugin` | Исходники плагина (манифест + entry или конкретный файл) |
| `validate_plugin` | Проверка плагина: манифест, права, entry, readme |
| `delete_plugin` | Удаление плагина (кроме встроенных) |

## Команда

`/plugin_dev` — открыть студию (модальная панель).

## Панель

Правая панель «Plugin Dev»: браузер документации (14 секций), мастер создания плагинов и список установленных.

Документация покрывает и новые API ядра: стриминг ответа в чат (`chat.beginReply/appendChunk/endReply`), чтение промпта и статические секции (`prompt.get`, `registerPromptSection`), кастомные теги сообщений (`ui.registerMessageTag`), function calling в `ai.chat` (`tools` + `chatContext`), live-карточка прогресса (`ui.beginProgress`) и action-кнопки виджетов, плагин-провайдеры моделей (`provider.register`), пагинация сообщений (`chats.getMessages`), секции в настройках (`registerSettingsSection`), системные диалоги (`fs.pickFiles`/`fs.saveDialog`), голос (`speech.tts`/`speech.stt`), чтение настроек (`settings.get`) и подтверждение тулов (`requiresApproval`).

## Для AI: как создать плагин

1. Прочитай доки: `plugin_docs(section="index")` → для объёмного плагина обязательно `architecture`, дальше по необходимости (`tools`, `permissions`, …).
2. Вызови `create_plugin` с полной спецификацией (id, `structure:"multi"`, права, тулы, команды, withUi).
3. Плагин появится в списке — пользователь включит его (consent-диалог прав).
4. Правь код — hot-reload следит за `dist/` и `ui/` целиком и перезапускает плагин автоматически.
