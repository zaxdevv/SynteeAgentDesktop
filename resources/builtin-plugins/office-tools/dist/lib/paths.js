// paths — папка сохранения и уникальные имена файлов
const path = require('path')
const state = require('../state')
const settings = require('./settings')

const DEFAULT_DIR_NAME = 'Office Tools'

/** Папка сохранения: settings.saveDir или Documents\Office Tools. */
async function getSaveDir() {
  const api = state.api
  const s = await settings.get()
  let dir = s.saveDir
  if (!dir) {
    const docs = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Documents')
    dir = path.join(docs, DEFAULT_DIR_NAME)
  }
  await api.fs.mkdir(dir, { recursive: true })
  return dir
}

/** Уникализация: file.docx → file (2).docx → … */
async function uniquePath(dir, name) {
  const api = state.api
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  let p = path.join(dir, name)
  let i = 2
  while ((await api.fs.stat(p)).exists) {
    p = path.join(dir, base + ' (' + i + ')' + ext)
    i++
  }
  return p
}

/** Абсолютный путь цели: явный path, иначе name+ext в папке сохранения. */
async function resolveTarget({ path: p, name, ext }) {
  if (p) return p
  const dir = await getSaveDir()
  return uniquePath(dir, (name || 'document') + ext)
}

module.exports = { getSaveDir, uniquePath, resolveTarget, DEFAULT_DIR_NAME }
