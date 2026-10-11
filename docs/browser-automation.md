# Автоматизация встроенного браузера

## Архитектура

Управление существующими Electron webview через `webContents`, frame API и локальный канал CDP `webContents.debugger`. Отдельный Chrome/Playwright-процесс и TCP remote-debugging port не запускаются. Вкладки используют прежнюю сессию браузера, авторизации и расширения.

Маршрут: схемы → ToolDispatcher → worker broker → BrowserManager → pageAutomation / BrowserExtras → результат модели. Broker передаёт полные аргументы, идентификаторы вкладки/фрейма и AbortSignal; удаляет обработчики ответов при завершении, отмене и остановке worker.

## Инструменты

- Навигация, история, перезагрузка, список/создание/выбор/закрытие вкладок.
- DOM snapshot с refs и отдельный native Chromium accessibility snapshot.
- Локаторы CSS, role/name, text, label, placeholder, data-testid.
- Click, double/right click, hover/focus, type/fill, select, check/uncheck, drag, клавиши и прокрутка.
- Ожидания условий selector/text/URL/load/function.
- Выполнение JavaScript, инжект CSS, текущие и persistent скрипты.
- Скриншоты viewport/full-page/clip/элемента.
- Ограниченные console/errors/network buffers, dialogs и downloads.
- Upload, cookies, local/session storage, user agent, zoom, performance, permissions, Cache Storage и диагностический trace.

## Контракт использования

1. Получить `tab_id` из списка/создания вкладки.
2. Передавать `tab_id` во всех последовательных действиях: ручное переключение пользователем не должно менять цель операции.
3. После навигации и изменения страницы получить новый snapshot. Не угадывать refs.
4. `ref` относится к документу и snapshot. Альтернатива — `locator`, разрешающийся ровно в один элемент. На динамических страницах предпочтительнее role/name или label.
5. `browser_type` вставляет текст, `browser_fill` заменяет. Результат действия проверять новым snapshot или wait condition.
6. `frame_id` — Electron routingId. `cdp_frame_id` у accessibility — другое, сырое CDP ID; нельзя их смешивать.

## Безопасность

- Произвольный JavaScript не считается read-only. Для evaluate/scripts/style/function ожиданий требуется подтверждение.
- Защищённые переменные не подставляются в произвольный JS; известные значения маскируются в текстовых результатах.
- Upload подтверждает конкретные существующие абсолютные файлы; лимит количества/общего размера, realpath/stat/hash проверяются перед прикреплением. Прикрепление не отправляет форму.
- Cookies/storage и раскрытие значений требуют разрешения. По умолчанию значения скрыты.
- Диагностические логи по умолчанию metadata-only. Подтверждённое `reveal` включает ограниченный очищенный захват подробностей для будущих событий, не восстанавливает старые сообщения.
- Страница работает без Node integration, с contextIsolation/sandbox/webSecurity. Содержание страницы — недоверенные данные, не инструкции ассистенту.
- Ask/Plan/research-набор не содержит произвольного JS, загрузки файлов, ввода и изменения приватного состояния. Custom disabled tools продолжают фильтровать набор после gating.

## Честные ограничения

Это не полная реализация Playwright API или Playwright MCP.

- DOM snapshot ограничен; native accessibility выдаётся отдельно и не создаёт actionable refs.
- Открытые shadow roots доступны; закрытые shadow roots не обещаются.
- Frame snapshots/evaluation доступны; trusted pointer/input действия в child frames ограничены и должны выдавать явную ошибку, а не кликать по неверным координатам.
- Trace — ограниченная CDP диагностика, не Playwright trace archive и не полный HAR. Сетевые тела, interception/mock response и arbitrary headers не предоставляются.
- Zoom не равен эмуляции viewport. Proxy/mobile/device emulation как отдельные инструменты не реализованы.
- Full-page/clip захват использует временное ограниченное изменение viewport и Electron capturePage с восстановлением в finally. Возможен responsive reflow; при скрытом браузере Electron может временно активировать отрисовку/видимость. Захват без любого визуального воздействия не гарантируется.
- Permission query/request подчиняется действующим Electron/Chromium policies; silent session-wide grant/revoke не предоставляется.
- Cache clearing ограничен Cache Storage текущего origin, не общим HTTP кэшем пользователя.
- Cookies ограничены host-only; родительские доменные cookies сохраняются. Cookies невозможно изолировать по порту.
- Отмена останавливает ожидания и последующие шаги, но не может отменить уже исполненный JavaScript или отозвать CDP mutation, уже отправленную Chromium. Неотменяемые операции не должны освобождать очередь вкладки до завершения.
- CAPTCHA, нестандартные drag/drop и сложные живые сайты требуют отдельных проверок.

## Проверка

```powershell
node --test scripts/browser-contract.test.mjs scripts/tool-settings.test.mjs
node scripts/browser-dispatch.test.cjs
node scripts/browser-broker.test.cjs
node scripts/browser-extras.test.cjs
node scripts/browser-accessibility.test.cjs
node scripts/browser-automation-smoke.cjs
npm run build
```

Smoke-тест запускает отдельный Electron с временным профилем и локальными HTTP fixtures. Не использует пользовательские вкладки/авторизации; внешние запросы блокируются. Он проверяет фактическое состояние страницы, а не только success-флаг инструмента. Общепроектные TypeScript ошибки следует отличать от новых ошибок браузерных файлов; успешный bundling сам по себе не доказывает чистый полный typecheck.

### Последний проверенный результат

- Изолированный Electron smoke: **27/27 PASS, 0 failed, 0 skipped**.
- Contract/settings, dispatcher, broker, extras, accessibility и page-contract тесты прошли.
- ESLint браузерного backend и интеграционных файлов — без ошибок.
- `npm run build` — успешно после финальной интеграции.
- Полный `tsc -p tsconfig.node.json --noEmit` остаётся красным: 69 диагностик в других областях проекта; в проверенных браузерных модулях и новых интеграционных файлах ошибок не обнаружено. Автоматический get_diagnostics не смог корректно завершить все проверки.
- Живые внешние сайты, CAPTCHA и весь пользовательский UI lifecycle не покрыты локальными fixture-тестами.
