// Browser automation contract. Local Electron webviews; no external debugging port.
const string = (description: string) => ({ type: 'string', description })
const number = (description: string) => ({ type: 'number', description })
const boolean = (description: string) => ({ type: 'boolean', description })
const enumeration = (values: string[], description: string) => ({ type: 'string', enum: values, description })
const context = {
  tab_id: string('Target tab from browser_tabs_list. Always pass it in multi-step workflows; omitted pins the currently active tab when the request starts.'),
  frame_id: number('Electron frame routingId from browser_frames. Omit for main frame. Child-frame trusted pointer actions may be unsupported; errors are explicit.'),
  timeout_ms: { ...number('Total operation timeout, including user approval (default 30000, or 120000 for actions needing confirmation; maximum 120000).'), minimum: 100, maximum: 120000 },
}
const target = {
  ref: string('Unique element ref returned by the latest snapshot of this tab/frame. Old refs are rejected; do not guess refs.'),
  snapshot_id: string('Snapshot identity from browser_snapshot, if available.'),
  locator: {
    type: 'object',
    description: 'Alternative to ref. Must resolve to exactly one element; supports open shadow roots. Prefer role/label over fragile CSS.',
    properties: {
      type: enumeration(['css', 'role', 'text', 'label', 'placeholder', 'testid'], 'Locator strategy.'),
      value: string('CSS selector, role, text, label, placeholder or data-testid.'),
      name: string('Accessible name filter for role locators.'),
      exact: boolean('Exact text/name matching rather than substring.'),
    },
    required: ['type', 'value'],
    additionalProperties: false,
  },
}
function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return { type: 'function' as const, function: { name, description, parameters: {
    type: 'object', properties: { ...context, ...properties }, required, additionalProperties: false,
  } } }
}
const actionTarget = 'Provide ref OR locator. Actions wait for a visible, enabled, stable, unobscured target; failures do not count as success. '
const operation = enumeration(['list', 'get', 'set', 'remove', 'clear'], 'Operation on browser data.')
export const BROWSER_TOOL_SCHEMAS = [
  tool('browser_navigate', 'Navigate the target tab to HTTP(S) and wait for load. Navigation invalidates refs. Non-web protocols require approval.', { url: string('URL or domain.') }, ['url']),
  tool('browser_back', 'Go back and wait for navigation. Take a new snapshot.'),
  tool('browser_forward', 'Go forward and wait for navigation. Take a new snapshot.'),
  tool('browser_reload', 'Reload and wait for load. Take a new snapshot.'),
  tool('browser_snapshot', 'Read a bounded DOM/accessibility-like snapshot with unique refs, element states, tab/frame identity and open shadow-root traversal. Not a complete native accessibility tree. List frames to inspect embedded documents separately.'),
  tool('browser_click', actionTarget + 'Trusted left click. Form submissions can require approval.', target),
  tool('browser_double_click', actionTarget + 'Trusted double click.', target),
  tool('browser_right_click', actionTarget + 'Trusted context-menu click.', target),
  tool('browser_hover', actionTarget + 'Move the pointer over the element.', target),
  tool('browser_focus', 'Focus an element by ref or locator and verify focus.', target),
  tool('browser_type', actionTarget + 'Insert text at the current selection; does not clear existing content. Use fill to replace. Enter submission requires approval.', { ...target, text: string('Text to insert.'), submit: boolean('Press Enter after insertion.') }, ['text']),
  tool('browser_fill', actionTarget + 'Replace editable content and verify the resulting value. Password values are not returned.', { ...target, text: string('Replacement text.') }, ['text']),
  tool('browser_select_option', 'Select native select option(s) by value and verify selection. Provide ref or locator.', { ...target, value: string('Option value.'), values: { type: 'array', items: { type: 'string' }, description: 'Values for a multiple select.' } }),
  tool('browser_check', actionTarget + 'Set checkbox/radio to checked, idempotently.', target),
  tool('browser_uncheck', actionTarget + 'Uncheck checkbox, idempotently.', target),
  tool('browser_drag', actionTarget + 'Pointer drag from source ref/locator to target ref/locator.', { ...target, target_ref: string('Destination ref.'), target_locator: target.locator }),
  tool('browser_press_key', 'Press a key or chord (Enter, Tab, Escape, Control+A, Shift+Tab). Printable characters and modifiers are handled separately. Enter may submit and require approval.', { key: string('Key or chord.') }, ['key']),
  tool('browser_scroll', 'Scroll page or a targeted scrollable element. Supports horizontal directions.', { ...target, direction: enumeration(['up', 'down', 'left', 'right'], 'Direction, default down.'), amount: { ...number('Positive pixels, default 600.'), minimum: 1, maximum: 10000 } }),
  tool('browser_screenshot', 'PNG image for vision: viewport, full page, clip or element. Main-frame only. Full-page/clip capture temporarily resizes the viewport via local CDP and restores it; responsive reflow or brief rendering activation is possible. Size is bounded.', { ...target, full_page: boolean('Capture full document.'), clip: { type: 'object', properties: { x: number('CSS pixels.'), y: number('CSS pixels.'), width: number('CSS pixels.'), height: number('CSS pixels.') }, required: ['x', 'y', 'width', 'height'], additionalProperties: false } }),
  tool('browser_tabs_list', 'List browser tabs with IDs, URLs and active flag.'),
  tool('browser_tab_new', 'Create a browser tab and wait for its webview to register/load.', { url: string('Initial URL, optional.') }),
  tool('browser_tab_select', 'Select a tab and wait for its webview to become available.', {}, ['tab_id']),
  tool('browser_tab_close', 'Close a browser tab and cancel operations targeting it.', {}, ['tab_id']),
  tool('browser_wait', 'Short cancellable sleep. Prefer condition-based browser_wait_for.', { ms: { ...number('Milliseconds, default 1000.'), minimum: 100, maximum: 10000 } }),
  tool('browser_wait_for', 'Wait for selector, text, URL, load state or JavaScript condition. Function conditions require approval. Uses polling with timeout and cancellation.', { condition: enumeration(['selector', 'text', 'url', 'load', 'function'], 'Condition.'), value: string('CSS selector/text/URL substring/load state/expression.'), state: enumeration(['visible', 'hidden', 'attached', 'detached'], 'Element state for selector condition, default visible.') }, ['condition', 'value']),
  tool('browser_frames', 'List live frames with routing IDs and URLs. Use frame_id for snapshots, evaluation and supported frame operations.'),
  tool('browser_accessibility', 'Read Chromium native accessibility nodes with roles, accessible names and states. Bounded to 1200 nodes; backend DOM IDs are diagnostic, NOT element refs. Use DOM snapshot for actionable refs.', { cdp_frame_id: string('Optional raw CDP frame ID, NOT Electron routingId.'), max_nodes: { ...number('Maximum returned nodes, default 1200.'), minimum: 1, maximum: 1200 } }),
  tool('browser_evaluate', 'Execute arbitrary JavaScript in the selected page/frame after explicit approval. Not guaranteed read-only. No Node/Electron API access. Results are size limited; never read secrets without user authorization.', { source: string('JavaScript expression; promises are awaited.') }, ['source']),
  tool('browser_add_script', 'Execute JavaScript after explicit approval, optionally register on future main-frame documents through local CDP. Persistent scripts are scoped to this tab until removal/close.', { source: string('Script source.'), persistent: boolean('Run also in future documents of this tab.'), remove_id: string('Remove a previously registered persistent script instead of adding one.') }),
  tool('browser_add_style', 'Inject CSS into the current document after approval. Does not persist after navigation.', { source: string('CSS text.') }, ['source']),
  tool('browser_console', 'Read bounded console metadata. reveal requires approval to enable sanitized detailed capture for FUTURE events; old message text is not retained.', { clear: boolean('Clear collected messages after reading.'), reveal: boolean('Request approved detailed capture for future messages.') }),
  tool('browser_errors', 'Read bounded JavaScript error metadata. reveal enables sanitized detailed capture for future exceptions after approval.', { clear: boolean('Clear errors after reading.'), reveal: boolean('Request future detailed error capture.') }),
  tool('browser_network', 'Read bounded request/response/failure metadata via local CDP. No bodies or credentials. reveal requires approval for sanitized path details on future events.', { clear: boolean('Clear records after reading.'), reveal: boolean('Request future sanitized path details.') }),
  tool('browser_dialog', 'List or handle a currently pending JavaScript alert/confirm/prompt dialog. Accepting requires approval.', { action: enumeration(['list', 'accept', 'dismiss'], 'Dialog operation, default list.'), text: string('Prompt input for accept.') }),
  tool('browser_downloads', 'List download progress tracked by the embedded browser. User chooses the save path; tool never silently saves files.'),
  tool('browser_upload', 'Attach existing local files to a file input using CDP after explicit approval. Does not submit the form. Files must be absolute regular files with bounded count/size.', { ...target, selector: string('CSS selector for the file input; alternative to ref.'), paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'Absolute local file paths.' } }, ['paths']),
  tool('browser_cookies', 'Origin-bound cookie operations require explicit approval. Values masked unless reveal is approved; writes/deletes are separate confirmed operations.', { operation, name: string('Cookie name.'), value: string('Value for set.'), path: string('Cookie path, default /.'), secure: boolean('Secure cookie.'), http_only: boolean('HttpOnly cookie.'), reveal: boolean('Explicitly request sensitive values.') }),
  tool('browser_storage', 'Current-origin local/session storage read/write operations require approval. Values masked by default. No access to other origins.', { operation, area: enumeration(['local', 'session'], 'Storage area.'), key: string('Storage key.'), value: string('Value to set.'), reveal: boolean('Request actual sensitive values.') }),
  tool('browser_set_user_agent', 'Set user agent for the target tab (effective on subsequent requests).', { value: string('User agent.') }, ['value']),
  tool('browser_zoom', 'Set the visible tab zoom factor (0.25–5). Does not change viewport dimensions.', { value: { ...number('Zoom factor.'), minimum: 0.25, maximum: 5 } }, ['value']),
  tool('browser_trace_start', 'Start bounded local CDP diagnostic event collection for this tab. Not a Playwright trace archive or full HAR.'),
  tool('browser_trace_stop', 'Stop and return bounded sanitized diagnostic trace.'),
  tool('browser_performance', 'Read local CDP performance metrics (not a Lighthouse audit).'),
  tool('browser_permissions', 'Query/request a supported current-origin permission after approval. Existing Electron policies remain authoritative; this tool cannot silently grant or revoke session-wide permissions.', { operation: enumeration(['query', 'request'], 'Query state or invoke supported browser permission request.'), permission: enumeration(['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read', 'clipboard-write'], 'Permission. Clipboard requests are unsupported; query only.') }, ['permission']),
  tool('browser_clear_cache', 'Clear supported cached data for the current origin after approval; does not silently clear all browser sessions.'),
]
export const BROWSER_TOOL_NAMES = BROWSER_TOOL_SCHEMAS.map(schema => schema.function.name)
// Research modes can browse, but cannot execute arbitrary code, upload or mutate private state.
export const BROWSER_RESEARCH_TOOL_NAMES = new Set([
  'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload',
  'browser_snapshot', 'browser_scroll', 'browser_screenshot', 'browser_tabs_list',
  'browser_tab_new', 'browser_tab_select', 'browser_wait',
  'browser_frames', 'browser_accessibility', 'browser_console', 'browser_errors', 'browser_network',
  'browser_downloads', 'browser_performance',
])
export const REQUEST_ACCESS_SCHEMA = {
  type: 'function' as const,
  function: {
    name: 'request_access',
    description: 'Ask the user to enable browser_control for this chat. If approved the browser tools become available in this run; if declined continue without them.',
    parameters: { type: 'object', properties: {
      capability: enumeration(['browser_control'], 'Capability to enable.'),
      reason: string('Short reason shown to the user.'),
    }, required: ['capability'], additionalProperties: false },
  },
}
