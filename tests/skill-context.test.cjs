/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise TypeScript helpers in Node without Electron. */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { getEncoding } = require('js-tiktoken')
const ts = require('typescript')

function load(path) {
  const code = ts.transpileModule(readFileSync(join(__dirname, '..', path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  new Function('exports', code)(exports)
  return exports
}

const { buildSkillsBlock, buildOneShotSkillBlock } = load('src/core/prompts/sections/skillsSection.ts')
const { formatSkillSearch } = load('src/core/skills/skillSearch.ts')

test('large skill catalogues stay short, while any skill remains discoverable by query or page', t => {
  const skills = Array.from({ length: 80 }, (_, i) => ({
    name: `Skill ${i}`,
    id: `project:skill-${i}`,
    description: 'Project workflow, validation and documentation. '.repeat(12),
    state: { enabled: i !== 79 },
  }))
  const previous = skills.map(skill => `- **${skill.name}** (id: ${skill.id}): ${skill.description}`).join('\n')
  const encoding = getEncoding('cl100k_base')
  const tokens = text => encoding.encode(text).length
  const prompt = buildSkillsBlock(skills)
  t.diagnostic(`cl100k_base: skill catalogue ${tokens(previous)} → ${tokens(prompt)} tokens`)
  assert.ok(tokens(prompt) < tokens(previous) / 4)
  assert.match(prompt, /list_extensions/)
  assert.doesNotMatch(prompt, /Skill 79/)
  assert.match(formatSkillSearch(skills, 'project:skill-79'), /id: project:skill-79, inactive/)
  assert.match(formatSkillSearch(skills, '', 70), /id: project:skill-79, inactive/)
  assert.match(formatSkillSearch(skills, '', 0), /Next offset: 10/)
  assert.match(formatSkillSearch(skills, 'unrelated'), /No skills/)
  assert.match(buildOneShotSkillBlock({ name: 'Review', instructions: 'Keep the exact instructions.' }), /Keep the exact instructions\./)
})
