// ── Web tools: search_web, http_request ──────────────────────────────────

export const WEB_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_web',
      description: 'Поиск в интернете через Tavily API. Используй для актуальной информации — новости, документация, ответы на вопросы.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Поисковый запрос' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'http_request',
      description: 'Прямой HTTP-запрос к API или веб-странице. GET/POST/PUT/DELETE/PATCH с заголовками и телом. Возвращает status, headers, body. Быстрее и надёжнее чем curl через run_command — нет проблем с экранированием. Используй для: API-вызовы, вебхуки, скачивание JSON/XML, проверка эндпоинтов. ВАЖНО: success=true означает что запрос выполнился, а не что HTTP-статус успешный — всегда проверяй Status в выводе (404/500 тоже success=true).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Полный URL (http:// или https://)' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'], description: 'HTTP-метод (по умолч. GET)' },
          headers: { type: 'object', description: 'Заголовки запроса. Например: {"Authorization": "Bearer ...", "Content-Type": "application/json"}', additionalProperties: { type: 'string' } },
          body: { type: 'string', description: 'Тело запроса (для POST/PUT/PATCH). JSON-строка, XML, plain text — что угодно.' },
          timeout: { type: 'number', description: 'Таймаут в секундах (по умолч. 30)' },
        },
        required: ['url'],
      },
    },
  },
]
