import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync('src/shared/mentions.ts', 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
new Function('module', 'exports', compiled)(module, module.exports)
const { mimeFromExt, attachmentKindFromMime, mentionToAttachment } = module.exports

test('Media extensions classify audio/video separately from images and text', () => {
  for (const name of ['clip.MP4', 'clip.mov', 'clip.webm', 'clip.mkv', 'clip.avi']) {
    assert.equal(attachmentKindFromMime(mimeFromExt(name)), 'video', name)
  }
  for (const name of ['track.MP3', 'track.wav', 'track.m4a', 'track.flac', 'track.ogg', 'track.opus']) {
    assert.equal(attachmentKindFromMime(mimeFromExt(name)), 'audio', name)
  }
  assert.equal(attachmentKindFromMime(mimeFromExt('picture.png')), 'image')
  assert.equal(attachmentKindFromMime(mimeFromExt('code.ts')), 'file')
  assert.equal(attachmentKindFromMime(undefined), 'file')
  assert.equal(attachmentKindFromMime(mimeFromExt('unknown.bin')), 'file')
})

test('Mention entities retain their kinds and metadata', () => {
  for (const type of ['file', 'image', 'skill', 'command', 'chat', 'project']) {
    const result = mentionToAttachment({ id: 'old', type, label: 'example', path: 'C:/example', mime: 'audio/mpeg' })
    assert.equal(result.kind, type)
    assert.equal(result.path, 'C:/example')
    assert.equal(result.source, 'mention')
  }
})
