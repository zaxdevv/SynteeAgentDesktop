// Патч node-pty: отключить Spectre-mitigation во ВСЕХ .gyp-файлах пакета.
//
// node-pty 1.1.0 ставит msvs_configuration_attributes: { SpectreMitigation:
// 'Spectre' } не только в корневом binding.gyp, но и в deps/winpty/src/
// winpty.gyp (2 вхождения). Старый @electron/rebuild (от electron-builder 25)
// эти атрибуты игнорировал, поэтому сборка всегда проходила. Новый
// @electron/rebuild 4 (от electron-builder 26) применяет их честно — и MSBuild
// требует Spectre-mitigated библиотеки MSVC (error MSB8040), которых нет в
// обычной VS Community. Патч возвращает прежнее поведение (Spectre off) —
// для локального pty-модуля это не security-критично.
//
// Идемпотентен: повторный запуск ничего не меняет. Запускается в
// postinstall ДО electron-builder install-app-deps.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ptyDir = join('node_modules', 'node-pty')
if (!statSync(ptyDir, { throwIfNoEntry: false })) {
  console.log('[patch-node-pty] node-pty не установлен — пропускаю')
  process.exit(0)
}

// Рекурсивно собрать все .gyp внутри node-pty (binding.gyp + deps/**/*.gyp)
function collectGyp(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectGyp(full, acc)
    else if (extname(entry.name) === '.gyp') acc.push(full)
  }
  return acc
}

let patchedCount = 0
for (const gypFile of collectGyp(ptyDir)) {
  const original = readFileSync(gypFile, 'utf-8')
  const patched = original.replace(/'SpectreMitigation':\s*'Spectre'/g, "'SpectreMitigation': 'false'")
  if (patched !== original) {
    writeFileSync(gypFile, patched)
    patchedCount++
    console.log(`[patch-node-pty] ${gypFile}: Spectre -> false`)
  }
}
console.log(patchedCount > 0
  ? `[patch-node-pty] пропатчено файлов: ${patchedCount}`
  : '[patch-node-pty] вхождений Spectre не найдено — уже чисто')
