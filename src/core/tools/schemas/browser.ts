// ── Browser tools: управление встроенным браузером (Playwright MCP-style) ──
//
// Два слоя:
//  1. BROWSER_TOOL_SCHEMAS — 15 отдельных тулов (browser_navigate, browser_click,
//     ...). Появляются в тулсете когда browserMode чата ВКЛ (тумблер плюс-меню
//     или подтверждение request_access).
//  2. REQUEST_ACCESS_SCHEMA — один универсальный тул запроса доступа к
//     выключенной возможности. Сейчас единственный capability —
//     'browser_control'; будущие gated-фичи (голос, терминал) добавят
//     enum-значения. Всегда в тулсете (когда browserMode ВКЛ — не нужен,
//     execute вернёт already enabled).
//
// Рефы: snapshot инжектит скрипт-обходчик DOM, элементы складываются в
// window.__syntee_refs страницы — умирают при навигации, модель обязана
// ре-снапшотиться после перехода (как в Playwright MCP).

export const BROWSER_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'browser_navigate',
      description: 'Navigate the built-in browser (right panel) to a URL. Waits for the page to load. After navigation, element refs from previous snapshots are invalid — take a new snapshot before interacting.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL (https://... or domain)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_back',
      description: 'Go back one step in browser history.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_forward',
      description: 'Go forward one step in browser history.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_reload',
      description: 'Reload the current page. Refs are invalid after reload — take a new snapshot.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_snapshot',
      description: 'Capture the accessibility snapshot of the current page: a YAML-like tree of interactive elements (buttons, links, textboxes, selects) each with a [ref=eN] id. THIS IS YOUR MAIN WAY TO SEE THE PAGE. Use refs with browser_click/browser_type. Take a new snapshot after any navigation.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_click',
      description: 'Click an element by its ref from the last snapshot. Sends a real (trusted) mouse event — sites treat it as a user click.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from the snapshot, e.g. "e5"' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_type',
      description: 'Type text into an element (input/textarea) by ref. Focuses the element first, inserts the text, optionally presses Enter (submit).',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from the snapshot' },
          text: { type: 'string', description: 'Text to type' },
          submit: { type: 'boolean', description: 'Press Enter after typing (submits forms / search)' },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_press_key',
      description: 'Press a keyboard key in the page: Enter, Escape, Tab, ArrowDown, ArrowUp, etc.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name: Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace, Delete' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_scroll',
      description: 'Scroll the page up or down by a pixel amount (default 600px).',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
          amount: { type: 'number', description: 'Pixels to scroll (default 600)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_screenshot',
      description: 'Capture a PNG screenshot of the current page for visual analysis (sent to your vision). Use when the accessibility snapshot is not enough — complex layouts, images, charts. The browser panel must be visible.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_tabs_list',
      description: 'List the open browser tabs (id, title, URL, active flag).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_tab_new',
      description: 'Open a new browser tab (optionally with a URL). Use for parallel research without losing the current page.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Initial URL (optional)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_tab_select',
      description: 'Switch the active browser tab by its id (from browser_tabs_list).',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'Tab id from the tabs list' },
        },
        required: ['tab_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_tab_close',
      description: 'Close a browser tab by its id.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'Tab id from the tabs list' },
        },
        required: ['tab_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_wait',
      description: 'Wait for a moment (ms, 100–10000) — for page transitions, animations, lazy loading. Default 1000ms.',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'number', description: 'Milliseconds to wait (100–10000, default 1000)' },
        },
      },
    },
  },
]

/** Универсальный тул запроса доступа к выключенной возможности.
 *  Один тул на все gated-фичи: capability-enum регулирует, что именно
 *  запрашивается. Сейчас: browser_control. Будущее: голос, терминал и т.д. */
export const REQUEST_ACCESS_SCHEMA = {
  type: 'function' as const,
  function: {
    name: 'request_access',
    description:
      'Request user permission to enable a currently disabled capability. The user sees a confirmation dialog with your reason. ' +
      'Available capabilities: browser_control — enables the built-in browser tools (browser_navigate, browser_snapshot, browser_click, browser_type, browser_screenshot, tabs, scroll) for driving the visible browser in the right panel. ' +
      'Call it when the task requires web interaction and browser control is disabled. If declined, continue without the capability.',
    parameters: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          enum: ['browser_control'],
          description: 'The capability to request. browser_control — built-in browser automation.',
        },
        reason: {
          type: 'string',
          description: 'Short explanation why this capability is needed for the current task (shown to the user).',
        },
      },
      required: ['capability'],
    },
  },
}
