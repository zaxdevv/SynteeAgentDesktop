const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/components/ui/GoalCard/GoalCard.tsx'), 'utf8')
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const mod = { exports: {} }
new Function('require', 'module', 'exports', output)(id => {
  if (id === 'react-dom') return { createPortal: () => null }
  if (id === 'framer-motion') return { AnimatePresence: ({ children }) => children, motion: { div: 'div', p: 'p', span: 'span', button: 'button' }, useReducedMotion: () => true }
  if (id.includes('../AppIcon/AppIcon')) return { default: () => null }
  return require(id)
}, mod, mod.exports)
const goal = { id: 'goal', chatId: 'chat', objective: 'Check renderer', status: 'paused', criteria: [], constraints: [], progress: [], evidence: [], steps: 0, maxSteps: 5, createdAt: 1, updatedAt: 1 }
const previousDocument = global.document
global.document = { body: {} }
try {
  for (const running of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(mod.exports.default, { goal, running, onCommand: async () => {}, onSave: async () => {} }))
    assert.match(html, /Check renderer/)
    assert.match(source, /Изменить/)
    assert.match(html, /aria-expanded="false"/)
    assert.match(source, running ? /Пауза/ : /Продолжить/)
  }
  assert.match(source, /const editRef = useRef/)
  assert.match(source, /event.key === 'Escape'/)
  console.log('GoalCard render regressions passed (paused and running)')
} finally {
  if (previousDocument === undefined) delete global.document
  else global.document = previousDocument
}
