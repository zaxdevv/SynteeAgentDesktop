// specDoc — справка формата ppt-спеки для AI (тул ppt_spec_docs).
// Возвращает компактный, но полный референс: layout, мастера, объекты, транзишены.

function specDoc() {
  return `PPT_CREATE SPEC FORMAT (v1)
============================
Top-level: {
  layout: '16x9' | '16x10' | '4x3' | 'wide' | { name, width, height }   // default '16x9' (10 x 5.625 in)
  title, author, company, subject
  template: THEME_REF                 // ДИЗАЙН-ШАБЛОН (см. ниже) — или параметр тула template
  theme: { headFontFace: 'Calibri', bodyFontFace: 'Calibri' }
  masters: [ MASTER, ... ]            // опционально, см. ниже
  slides: [ SLIDE, ... ]              // ОБЯЗАТЕЛЬНО, >= 1
}

DESIGN TEMPLATES (template / spec.template) — мгновенный красивый дизайн:
  template: '<theme-id>'   — встроенная тема: 'corporate-blue' (деловой), 'midnight' (тёмная tech),
    'minimal' (швейцарский минимализм), 'sunset' (тёплая креативная), 'forest' (эко), 'elegant'
    (премиум serif), 'startup' (SaaS индиго), 'mono' (брутализм), 'ocean' (тёмная морская),
    'warm-earth' (терракота). Полный список с палитрами: тул ppt_templates.
  template: 'C:/path/to/file.pptx|.potx|.thmx' — палитра+шрифты из файла шаблона
    (найти/скачать: ppt_template_search, ppt_template_download).
  template: { colors: { bg, bgAlt, accent, accent2, text, textMuted, onAccent }, fonts: { head, body }, style: 'dark'|'light' }
  Что делает тема: мастер с декором (полосы/фигуры) + slideNumber, фоны слайдов, ЦВЕТА ТЕКСТА ПО
  УМОЛЧАНИЮ (на тёмной теме текст автоматически светлый!), заголовки без цвета → accent,
  chartColors диаграмм, шрифты. Свои явные цвета/мастера всегда выигрывают.
  Для ПОЛНОЙ замены макетов настоящим .potx на готовой деке: ppt_apply_template (COM).

UNITS: все координаты x/y/w/h — ДЮЙМЫ (16:9 = 10.0 x 5.625). Проценты строкой тоже можно: x: '50%'.

SLIDE: {
  master: 'MASTER_ID'             // применить мастер
  background: { color: 'FF0000' } | { path: 'C:/img/bg.png' } | { data: '<base64>' }
  hidden: true                    // скрытый слайд
  notes: 'заметки докладчика'
  slideNumber: { x: 9.4, y: 5.25, color: '888888', fontSize: 10 }
  transition: 'fade' | { type: 'push', dir: 'l', spd: 'fast', advanceAfterMs: 3000, advanceOnClick: false }
  objects: [ OBJ, ... ]
}

TRANSITIONS (между слайдами): type: fade|push|wipe|cover|pull|cut|dissolve|split|wedge|wheel|zoom|blinds|checker|comb|circle|diamond|plus|newsflash|strips|randombar|random
  dir: l|r|u|d (push/wipe), l|r|u|d|ld|lu|rd|ru (cover/pull/strips), horz|vert (blinds/checker/comb/randombar/split.orient), in|out (zoom/split)
  wheel: spokes 1|2|3|4|8. spd: slow|med|fast. advTm=advanceAfterMs (мс, авто-переход).

MASTER: {
  id: 'TITLE_MASTER'              // имя для ссылки в slide.master
  background: { color } | { path } | { data }
  objects: [                      // статичные элементы на каждом слайде мастера
    { rect:  { x, y, w, h, fill: { color: '1F4E79' }, line: { color, width } } },
    { line:  { x, y, w, h, line: { color: 'CCCCCC', width: 1 } } },
    { text:  { text: 'Footer text', options: { x, y, w, h, fontSize: 10, color: '888888', align: 'right' } } },
    { image: { x, y, w, h, path: 'C:/logo.png' } },
    { placeholder: { options: { name: 'title', type: 'title', x, y, w, h }, text: 'prompt' } }
  ],
  slideNumber: { x, y, color, fontSize }
}

OBJECTS (objects[]):
1. TEXT — { type: 'text', x, y, w, h, text: 'строка' | runs | paragraphs, options: {...} }
   runs: [ { text: 'жирный ', options: { bold: true } }, { text: 'красный', options: { color: 'CC0000' } } ]
   paragraphs: [ 'строка 1', { text: 'строка 2', options: { bold: true } } ]  // каждая = абзац
   options: fontSize (пт), fontFace, bold, italic, underline (true|'sng'|'dbl'|...), strike ('sngStrike'|'noStrike'),
     color ('FF0000', без #), align: left|center|right|justify, valign: top|middle|bottom,
     bullet: true | { code: '2022', indent: 12 } | { type: 'number', numberType: 'arabicPeriod' },
     lineSpacing (пт) | lineSpacingMultiple (1.5), charSpacing, isTextBox: true,
     wrap: true|false, fit: 'none'|'shrink'|'resize', shrinkText (deprecated), margin (число|{t,r,b,l} в пт? — дюймы*100? используй число 0..99),
     fill: 'F1F1F1' | { color, transparency: 0..100 }, line: { color, width, dashType },
     shadow: { type: 'outer', blur: 3, offset: 1, angle: 90, color: '000000', opacity: 0.5 },
     outline: { size: 1.5, color: 'FFFFFF' }, glow: { size, opacity, color },
     rotate (градусы), flipH, flipV, vert: 'eaVert'|'horzVert'|... (вертикальный текст),
     lang: 'ru-RU', placeholder: { type: 'title'|'body' } (использовать плейсхолдер мастера),
     shape: 'roundRect' (текст в фигуре), rectRadius: 0.2, softBreakBefore: true
2. TABLE — { type: 'table', x, y, w, rows: [[CELL,...],...], colW: [1.5, 3, 1.5], rowH: 0.4, options }
   CELL: 'строка' | { text: 'x', options: { bold, color, fill: 'EEEEEE', align, valign, fontSize, fontFace, colspan: 2, rowspan: 2, border } }
   options: border: { pt: 1, color: 'CCCCCC' } (или массив [top,right,bottom,left]), fill, align, valign, fontSize, fontFace,
     margin: 0.05, autoPage: true (перенос длинной таблицы на след. слайд), autoPageRepeatHeader: true, rowH
3. IMAGE — { type: 'image', path: 'C:/pic.png' | data: '<base64>', x, y, w, h,
     sizing: { type: 'contain'|'cover'|'crop', w, h }, rotate, rounding: true (круг), shadow, transparency: 0..100, altText }
4. SHAPE — { type: 'shape', shape: 'rect'|'roundRect'|'ellipse'|'triangle'|'diamond'|'pentagon'|'hexagon'|'chevron'|'rightArrow'|'leftArrow'|'upArrow'|'downArrow'|'star5'|'heart'|'cloud'|'lightningBolt'|'donut'|'plus'|'line'|...,
     x, y, w, h, fill: '4472C4' | { color, transparency }, line: { color, width, dashType, beginArrowType, endArrowType },
     rectRadius (roundRect), rotate, flipH, flipV, shadow, display: false,
     text: 'текст внутри фигуры', runs | paragraphs, textOptions: { ...text options } }
5. CHART — { type: 'chart', chartType: 'bar'|'line'|'pie'|'doughnut'|'area'|'scatter'|'bubble'|'radar'|'bar3d'|'combo',
     data: [ { name: 'Серия 1', labels: ['Q1','Q2','Q3'], values: [10, 25, 18] }, ... ], x, y, w, h, options }
     scatter: data = [ { name: 'X', values: [1,2,3] }, { name: 'Y', values: [2,4,6] } ] (первая серия — X)
     bubble: серии с { name, values (X), sizes (размеры) }
     combo: chartType 'combo' + series: [ { chartType: 'bar', data: [...], options: { barGrouping: 'stacked' } }, { chartType: 'line', data: [...], options: { secondaryValAxis: true } } ]
     options: barDir: 'bar'|'col' (горизонтальные/вертикальные), barGrouping: 'clustered'|'stacked'|'percentStacked',
       title, showTitle: true, showLegend: true, legendPos: 'b'|'t'|'l'|'r'|'tr', legendFontSize,
       catAxisTitle, valAxisTitle, valAxisMaxVal, valAxisMinVal, valAxisMajorUnit, valAxisLabelFormatCode: '#,##0',
       chartColors: ['4472C4','ED7D31'], chartColorsOpacity: 80, dataBorder: { pt: 1, color: 'FFFFFF' },
       showValue: true, dataLabelFormatCode: '0.0%', dataLabelColor, dataLabelFontSize, dataLabelPosition: 'ctr'|'inEnd'|'outEnd'|'bestFit',
       holeSize: 50 (doughnut), lineSize: 3, lineSmooth: true, lineDataSymbol: 'circle'|'none'|'square'|...,
       firstSliceAng (pie), radarStyle: 'standard'|'marker'|'filled', gridline: { color, size, style },
       showDataTable: true, shadow
     ДИАГРАММЫ РЕДАКТИРУЕМЫЕ (нативные chart XML, не картинки) — можно менять данные в PowerPoint.
6. MEDIA — { type: 'media', mediaType: 'video'|'audio'|'online', path: 'C:/clip.mp4' | link: 'https://www.youtube.com/embed/...', x, y, w, h, poster: { path|data } (обложка видео) }

COLORS: hex-строки БЕЗ решётки: 'FF0000'. fill может быть { color, transparency: 0..100 }.

DESIGN PATTERNS (для красивых презентаций):
- САМОЕ ПРОСТОЕ: template: 'midnight' (или другая тема) — дизайн готов, ты только пишешь контент.
- Титул: крупный заголовок 40-54 пт bold, подзаголовок 18-24 пт серый, акцентная полоса-фигура или фон-градиент из двух rect.
- Мастер с брендингом: нижняя полоса rect + slideNumber + логотип image — применяй ко всем слайдам.
- Не более 5-7 строк текста на слайде, буллеты 18-22 пт; заголовки слайдов 28-32 пт bold.
- Контраст: тёмный фон ('1A1A2E') + светлый текст ('FFFFFF') + акцент ('E94560'); либо белый фон + тёмный текст + синий акцент ('2563EB').
- Диаграммы: chartColors под стиль деки, dataLabelFormatCode для подписей, w: 6-8, h: 3.5-4.5.
- Таблицы: шапка fill тёмная + текст белый, строки через одну fill 'F2F2F2' (зебра), border 'DDDDDD'.
- Транзишены: 'fade' — универсальный; для динамичных дек 'push' dir 'l'.

LIMITS: анимации объектов (появление по клику) НЕ поддерживаются — только переходы между слайдами (transition).
SmartArt нет (используй shapes). Для правки существующих .pptx — ppt_read + ppt_edit (текст/заметки/порядок/скрытие/транзишены);
добавление слайдов в существующую деку — пересоздай файл через ppt_create (прочитай ppt_read full и собери заново).`
}

module.exports = { specDoc }
