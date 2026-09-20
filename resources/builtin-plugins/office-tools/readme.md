# Office Tools — офисные документы

Встроенный плагин SynteeHelper: полный цикл работы с Word-, Excel- и PowerPoint-документами.

## Тулы (для AI)

| Тул | Что делает |
|---|---|
| `word_create` | Создание .docx из JSON-спеки: стили, списки, таблицы (merged/borders/fills), картинки, **математические формулы LaTeX** (нативные equations Word: дроби, корни, суммы/интегралы, греческие буквы, матрицы), TOC, колонтитулы (default/first/even), сноски, водяные знаки, титульная страница, закладки/ссылки, настройка страницы, умная вёрстка |
| `word_spec_docs` | Полный справочник формата спеки (вызывай перед сложными документами) |
| `word_read` | Чтение .docx: `structure` / `text` / `full` (с сохранением page setup) / `stats`. Встроенные картинки извлекаются в файлы (`cache/media`) и возвращаются путями — base64 в контекст AI не попадает |
| `word_edit` | Гранулярные правки существующих .docx: append/insert_after/insert_at, replace_text, replace_block, move_block, delete_block, find_text, set_style, set_run_style, insert_table, add_table_row/delete_table_row, merge_cells, insert_list, **insert_math (формулы LaTeX)**, add_image, add/remove_watermark, add_header/add_footer, patch_document, set_page, set_typography. Существующие формулы сохраняются при пересборке (читаются как LaTeX) |
| `word_append` | Дописать блоки в конец документа |
| `word_compare` | Сравнение двух .docx (диф по блокам или строкам): добавлено/удалено/изменено |
| `excel_create` | Создание .xlsx из JSON-спеки: листы, формулы, форматы, стили, merged, freeze, автофильтры, валидация, условное форматирование, защита |
| `excel_spec_docs` | Справочник формата Excel-спеки |
| `excel_read` | Чтение .xlsx: `meta` / `values` / `formulas` / `full` (+ превью-таблица в чате) |
| `excel_edit` | Гранулярные правки: ячейки, строки/колонки, листы, ширины, merge, freeze, сортировка |
| `excel_chart` | Диаграммы через реальный Excel (COM) |
| `ppt_create` | Создание .pptx из JSON-спеки: **дизайн-шаблоны** (template: id темы или путь к .pptx/.potx), **мастера слайдов** (брендинг), темы (шрифты), фоны (цвет/картинка), текст с полным оформлением (runs, буллеты, интервалы, тени, контуры, вертикальный текст), таблицы (fills, merged, зебра, autoPage), картинки (contain/cover/crop, круг), 180+ фигур с текстом, **нативные редактируемые диаграммы** (bar/line/pie/doughnut/area/scatter/bubble/radar/3d/combo — меняются в PowerPoint), медиа (видео/аудио/YouTube), заметки докладчика, скрытые слайды, номера слайдов, **транзишены** (fade/push/wipe/zoom…, автопереход) |
| `ppt_spec_docs` | Справочник формата ppt-спеки + паттерны дизайна красивых презентаций |
| `ppt_read` | Чтение .pptx: `meta` / `slides` (тексты+заметки) / `full` (объекты с позициями, данные диаграмм, таблицы; картинки → в файлы) |
| `ppt_edit` | Правки существующих .pptx (XML-level, форматирование сохраняется): find_replace (слайды+заметки), set_notes (создаёт notesSlide при отсутствии), delete_slide, move_slide, hide_slide, set_transition (все слайды или один). Бэкап `.bak` |
| `ppt_templates` | Каталог дизайн-ресурсов: 10 встроенных тем (палитры, шрифты, описания) + локальные файлы шаблонов (скачанные, пользовательские, Office) с извлечёнными палитрами |
| `ppt_template_search` | Поиск бесплатных шаблонов в интернете (fppt.com → прямые .pptx) + автоскачивание в кэш плагина + извлечение палитры/шрифтов. Fallback: DuckDuckGo |
| `ppt_template_download` | Скачивание шаблона по прямой ссылке .pptx/.potx/.thmx (до 1 МБ) с валидацией |
| `ppt_apply_template` | Применение настоящего шаблона PowerPoint (.potx) к готовой деке через COM — полная замена мастеров/макетов |
| `ppt_export_pdf` | Экспорт .pptx → PDF через реальный PowerPoint (COM) |
| `office_convert` | Конвертация: xlsx↔csv, docx→markdown/txt/html, pptx→markdown/txt |
| `office_export_pdf` | Экспорт .docx/.xlsx/.pptx → PDF (COM) |
| `office_save_as` | Сохранение в другом формате (COM): .doc↔.docx, .ppt↔.pptx, →pdf/mp4 (видео из деки!)/png/html/rtf/txt |
| `office_open` | Открыть файл в реальном Word/Excel/PowerPoint (COM) |

## Презентации — как это работает

- **pptxgenjs** генерирует стандартный OOXML .pptx — PowerPoint, Keynote, LibreOffice, Google Slides (импорт).
- Диаграммы — нативный chart XML (не картинки): данные правятся в PowerPoint.
- Транзишены pptxgenjs не умеет — инъектируются в slideN.xml постпроцессингом (`lib/ppt/transition.js`).
- Чтение/правка — свой XML-парсер поверх adm-zip: порядок слайдов из `p:sldIdLst`, тексты из `a:t`, диаграммы из `charts/chartN.xml`, заметки из `notesSlides`.

## Дизайн-шаблоны презентаций

- **10 встроенных тем** (`lib/ppt/themes.js`): corporate-blue, midnight, minimal, sunset, forest, elegant, startup, mono, ocean, warm-earth. Каждая — палитра, шрифты, декор мастера (полосы/фигуры/свечения), автоцвета текста (на тёмных темах текст автоматически светлый), chartColors диаграмм.
- Применение: `ppt_create { template: "midnight", spec: {...} }` или `spec.template` — свои явные цвета/мастера всегда выигрывают.
- **Файлы-шаблоны**: `template: "C:/.../file.potx"` — палитра+шрифты извлекаются из theme1.xml файла.
- **Поиск в интернете**: `ppt_template_search { query }` — ищет на fppt.com (WordPress-поиск → страницы → прямые .pptx), скачивает в `cache/templates/`, извлекает палитру. Fallback: DuckDuckGo `filetype:pptx`. Лимит скачивания — 1 МБ (ограничение net.fetch хоста).
- **Настоящие .potx**: `ppt_apply_template` — COM `Presentation.ApplyTemplate`, полная замена мастеров/макетов у готовой деки.
- Каталог: `ppt_templates` — темы + найденные локально файлы (кэш плагина, `%APPDATA%\Microsoft\Templates`, Office PUBREP).
- **Ограничения**: анимации объектов (появление по клику) не поддерживаются — только переходы между слайдами; SmartArt нет (эмулируется фигурами); добавление слайдов в существующую деку — пересборкой через ppt_create (ppt_read full + новые слайды); скачивание шаблонов — до 1 МБ.
- Старый бинарный .ppt: конвертируй через `office_save_as` → .pptx, дальше доступны ppt_read/ppt_edit.

## Умная вёрстка Word (настраивается в панели + в спеке)

- **Поля по умолчанию**: ГОСТ (3/1.5/2/2 см) / Word (2.54 см) / свои значения. Спека `page.margins` всегда выигрывает.
- **Красная строка** 1.25 см для абзацев: авто (для русскоязычных текстов) / всегда / никогда (`page.firstLineIndent`).
- **Компактные отступы списков** (`page.compactLists`, по умолчанию вкл).
- **Умные разрывы страниц** (`page.smartBreaks`, по умолчанию вкл): заголовки не отрываются от текста (keepNext/keepLines), строки таблиц не рвутся между страницами (cantSplit, отключается `allowSplit: true` у таблицы).
- **Точный подсчёт страниц** — контент-ориентированная оценка (поля, шрифт, таблицы, картинки, разрывы).
- **Водяной знак** (`page.watermark`: text/color/opacity/diagonal) — VML-шейп в колонтитуле.
- **Колонтитулы first/even/odd** (`page.differentFirstPage`, `page.evenAndOdd` + `header: { default, first, even }`).
- При `word_edit` page setup (поля/размер/ориентация/колонки) сохраняется.

## Панель

Правая панель «Office»: быстрые действия (новый документ/таблица/презентация/из шаблона), недавние файлы, настройки (папка сохранения, превью, поля страницы, красная строка, списки, разрывы), живое превью текущего документа.

## Команда

`/office` — открыть панель.

## Рендеры в чате

- Карточка файла (после word_create / ppt_create) — имя, статистика, кнопки «Открыть» / «Показать в папке» / «PDF»
- Превью Excel-таблиц

## Технологии

- Генерация Word: npm `docx`; Excel: `exceljs`; PowerPoint: `pptxgenjs`; чтение: `mammoth`; zip: `adm-zip` (ставятся автоматически в папку плагина)
- COM-автоматизация Word/Excel/PowerPoint: PowerShell-скрипты (`process:exec`)
- Файлы по умолчанию: `Documents\Office Tools` (настраивается в панели)
