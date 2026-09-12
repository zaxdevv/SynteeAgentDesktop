import { defineConfig, externalizeDepsPlugin, bytecodePlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
// vite-plugin-monaco-editor@1.1.0 — CJS-модуль с __esModule, но Node ESM-interop
// при внешнем (не esbuild) импорте отдаёт весь namespace { default: [Function], ... }
// вместо самой функции. Поэтому берём .default с фолбэком на сам объект.
import monacoEditorPluginModule from 'vite-plugin-monaco-editor'
const monacoEditorPlugin = (monacoEditorPluginModule as unknown as { default: typeof monacoEditorPluginModule }).default ?? monacoEditorPluginModule
import JavaScriptObfuscator from 'javascript-obfuscator'
import type { Plugin } from 'vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string }

const { obfuscate } = JavaScriptObfuscator
type ObfuscatorOptions = typeof JavaScriptObfuscator extends { obfuscate: (code: string, opts?: infer O) => unknown }
  ? O
  : Record<string, unknown>
// ── Source-code protection ───────────────────────────────────────────────
// Включается ТОЛЬКО через SYNTEE_PROTECT=1 (его выставляют build-release.bat
// и build-release-dev.bat). Дебаг-сборки (run.bat / run-debug.bat /
// run-prod.bat / npm run dev) идут БЕЗ защиты: читаемый JS, сорсмапы,
// быстрая сборка.
//
// main / preload : компиляция в V8-байткод (.jsc) через bytecodePlugin.
//                  removeBundleJS: true — не оставлять читаемый .js рядом
//                  с .jsc (иначе исходник утекает в app.asar как _index.js).
//                  Байткод генерируется локальным бинарником Electron, т.е.
//                  версия V8 всегда совпадает с рантаймом.
// renderer       : javascript-obfuscator, умеренный пресет — БЕЗ
//                  controlFlowFlattening / deadCodeInjection / selfDefending,
//                  чтобы не сломать mermaid/katex/React и не убить перф.
//                  Чанки, состоящие только из node_modules (публичные либы),
//                  пропускаются — защищаем только свой код.

const protect = process.env.SYNTEE_PROTECT === '1'

const RENDERER_OBFUSCATOR_OPTIONS: ObfuscatorOptions = {
  compact: true,
  simplify: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  renameProperties: false,
  stringArray: true,
  stringArrayThreshold: 0.5,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  // reservedStrings — regex-паттерны строк, которые обфускатор НЕ должен
  // переносить в stringArray. Vite code splitting использует динамические
  // import() со статическими путями к чанкам: "./SettingsPage-Dq6IdtYq.js",
  // "./SettingsPage-Mj7zTek5.css" и т.д. Если stringArray заменит эти пути
  // вызовом функции-декодера, import() сломается → "Failed to fetch
  // dynamically imported module" в release-сборке. Шаблоны ниже сохраняют
  // все пути к .js/.css чанкам и любые относительные пути (начинающиеся с ./)
  // в исходном виде, не трогая остальные строковые литералы.
  reservedStrings: [
    '\\.js$',
    '\\.css$',
    '^\\./',
  ],
  splitStrings: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  numbersToExpressions: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  sourceMap: false,
  target: 'browser'
}

function rendererObfuscatorPlugin(): Plugin {
  return {
    name: 'syntee-renderer-obfuscator',
    apply: 'build',
    enforce: 'post',
    renderChunk(code, chunk) {
      // Пропускаем чанки, состоящие только из node_modules (публичные либы)
      const ids = chunk.moduleIds
      if (ids.length > 0 && ids.every((id) => id.includes('node_modules'))) {
        return null
      }
      const result = obfuscate(code, RENDERER_OBFUSCATOR_OPTIONS)
      return { code: result.getObfuscatedCode(), map: null }
    }
  }
}

// ── Bake gateway URL into the main bundle ───────────────────────────────
// Vite `define` does NOT replace `process.env.*` in the main (SSR/Node) build
// because in Node `process.env` is a real runtime object, not a polyfill.
// So we do a literal text replacement via a transform plugin instead — this
// is the only reliable way to bake SYNTEE_API_URL / SYNTEE_WEB_URL into the
// packaged exe at build time. Without this, the production client falls back
// to localhost:8000 and can never reach the gateway.
// Only replaces when the env var is actually set (build-release.bat sets it);
// dev/debug runs leave the live `process.env.*` lookup in place so the
// localhost fallback keeps working.
function bakeEnvPlugin(): Plugin {
  const replacements: Record<string, string> = {}
  if (process.env.SYNTEE_API_URL) {
    replacements['process.env.SYNTEE_API_URL'] = JSON.stringify(process.env.SYNTEE_API_URL)
  }
  if (process.env.SYNTEE_WEB_URL) {
    replacements['process.env.SYNTEE_WEB_URL'] = JSON.stringify(process.env.SYNTEE_WEB_URL)
  }
  return {
    name: 'syntee-bake-env',
    apply: 'build',
    enforce: 'post',
    renderChunk(code, chunk) {
      if (Object.keys(replacements).length === 0) return null
      if (chunk.moduleIds.length > 0 && chunk.moduleIds.every((id) => id.includes('node_modules'))) {
        return null
      }
      let out = code
      let changed = false
      for (const [from, to] of Object.entries(replacements)) {
        if (out.includes(from)) {
          out = out.split(from).join(to)
          changed = true
        }
      }
      return changed ? { code: out, map: null } : null
    }
  }
}

export default defineConfig({
  main: {
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [externalizeDepsPlugin(), bakeEnvPlugin(), ...(protect ? [bytecodePlugin({ removeBundleJS: true })] : [])],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'ai-worker': resolve('src/main/workers/ai-worker.ts'),
          'whisper-worker': resolve('src/main/workers/whisper-worker.ts'),
          'fastContext-worker': resolve('src/main/workers/fastContext-worker.ts'),
          'plugin-host': resolve('src/core/plugins/pluginHost.ts'),
        },
        external: ['web-tree-sitter', 'better-sqlite3', '@huggingface/transformers', 'onnxruntime-node'],
      },
    },
    resolve: {
      // То же что и renderer: .ts/.tsx приоритетнее .js/.jsx, чтобы Vite не
      // грузил устаревшие gitignored .js-мироры (артефакты компиляции) вместо
      // актуального source-of-truth .ts. Без этого правки в .ts-файлах shared/
      // не попадают в main-бандл — импорт перехватывается constants.js и т.п.
      extensions: ['.mjs', '.ts', '.tsx', '.js', '.jsx', '.json'],
      alias: {
        '@main': resolve('src/main'),
        '@core': resolve('src/core'),
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [externalizeDepsPlugin(), ...(protect ? [bytecodePlugin({ removeBundleJS: true })] : [])],
    resolve: {
      // То же что и renderer: .ts/.tsx приоритетнее .js/.jsx, чтобы Vite не
      // грузил устаревшие gitignored-мироры (артефакты компиляции) вместо
      // актуального source-of-truth .ts.
      extensions: ['.mjs', '.ts', '.tsx', '.js', '.jsx', '.json'],
    }
  },
  renderer: {
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [
      react(),
      // Monaco Editor: бандлит web workers локально (офлайн, без CDN).
      // @monaco-editor/react по умолчанию грузит Monaco с CDN (jsdelivr).
      // В Electron (офлайн) это не работает — плагин собирает workers в бандл.
      monacoEditorPlugin({
        // editorWorkerService — base editor worker (diff, minimal edits, unicode
        // highlights, link computation). Without it, Monaco falls back to a
        // data:text/javascript URL which CSP blocks (script-src has no data:).
        // The plugin bundles it as editor.worker.bundle.js → blob:-compatible.
        languageWorkers: ['editorWorkerService', 'json', 'css', 'typescript', 'html'],
        // electron-vite: renderer root — относительный (src/renderer), а outDir —
        // абсолютный. Плагин делает path.join(root, outDir, ...) → инвалидный путь
        // "src\renderer\C:\...\out\renderer". Переопределяем через customDistPath,
        // строим от абсолютного outDir, игнорируя root.
        customDistPath: (_root, outDir, base) => resolve(outDir, base, 'monacoeditorwork'),
      }),
      ...(protect ? [rendererObfuscatorPlugin()] : []),
    ],
    resolve: {
      // По умолчанию Vite резолвит ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json'] —
      // .js/.jsx приоритетнее .ts/.tsx. В репо лежат gitignored .js/.jsx-мироры
      // (артефакты компиляции .ts/.tsx→.js/.jsx), которые перехватывали импорты и
      // Vite грузил устаревший mirror вместо актуального .ts/.tsx. Ставим
      // .ts/.tsx выше .js/.jsx, чтобы источником правды всегда был source-of-truth.
      extensions: ['.mjs', '.ts', '.tsx', '.js', '.jsx', '.json'],
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
