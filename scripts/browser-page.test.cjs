/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, console */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const source = fs.readFileSync('src/main/browser/pageAutomation.ts', 'utf8')
for (const token of ["'checkbox'", "'radio'", 'shadowRoot', 'aria-labelledby', 'Ambiguous locator', 'Stale ref', 'readOnly', 'snapshotId', 'expectedValues', 'verify_value']) {
  assert.ok(source.includes(token), `expected automation engine to include ${token}`)
}
assert.match(source, /export async function inspect\(/)
assert.match(source, /export async function snapshot\(/)
assert.match(source, /export async function locate\(/)
assert.match(source, /export async function domAction\(/)
console.log('browser page automation contract: ok')
