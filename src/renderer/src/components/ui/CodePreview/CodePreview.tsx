import { useMemo, useRef } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useVirtualizer } from '@tanstack/react-virtual'
import './CodePreview.css'

// ── Language detection для Monaco/Prism ────────────────────────────────
// Monaco 0.56 имеет ~70 встроенных Monarch-токенайзеров (подсветка без workers).
// Workers нужны только для IntelliSense (автодополнение/диагностика) —
// для read-only preview достаточно правильного language ID.
// Базовые языки Monaco: abap, apex, azcli, bat, bicep, cameligo, clojure, coffee,
// cpp, csharp, csp, css, cypher, dart, dockerfile, ecl, elixir, flow9, fsharp,
// go, graphql, handlebars, hcl, html, ini, java, javascript, json, julia, kotlin,
// less, lexon, liquid, lua, m3, markdown, mipsasm, msdax, mysql, objective-c,
// pascal, pascaligo, perl, pgsql, php, plaintext, postiats, powerquery, powershell,
// pug, python, r, razor, redis, redshift, restructuredtext, ruby, rust, sb, scala,
// scheme, scss, shell, solidity, sophix, svelte, swift, systemverilog, tcl, terraform,
// twig, typescript, vb, verilog, wgsl, xml, yaml.
const EXT_MAP: Record<string, string> = {
  // ── JavaScript / TypeScript ──
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  // ── Web / Markup ──
  html: 'html', htm: 'html', xhtml: 'html',
  xml: 'xml', svg: 'xml', xaml: 'xml', resx: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  vue: 'html', svelte: 'svelte',
  hbs: 'handlebars', handlebars: 'handlebars',
  pug: 'pug', jade: 'pug',
  liquid: 'liquid', twig: 'twig',
  razor: 'razor',
  // ── Data / Config ──
  json: 'json', jsonc: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  env: 'ini', properties: 'ini', props: 'ini',
  // ── Python ──
  py: 'python', pyw: 'python', pyi: 'python', py3: 'python',
  // ── Rust / Go / C / C++ ──
  rs: 'rust',
  go: 'go',
  c: 'c', h: 'c',
  cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp',
  // ── Java / Kotlin / Scala ──
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', sc: 'scala',
  // ── C# / F# / VB ──
  cs: 'csharp', csx: 'csharp',
  fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp',
  vb: 'vb',
  // ── Ruby / PHP / Perl ──
  rb: 'ruby', erb: 'ruby',
  php: 'php', phtml: 'php',
  pl: 'perl', pm: 'perl',
  // ── Shell / Scripting ──
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', psd1: 'powershell', psm1: 'powershell',
  bat: 'bat', cmd: 'bat',
  tcl: 'tcl',
  // ── Docs / Markup ──
  md: 'markdown', markdown: 'markdown',
  rst: 'restructuredtext',
  tex: 'latex', latex: 'latex',
  // ── SQL ──
  sql: 'sql', mysql: 'mysql',
  pgsql: 'pgsql', postgres: 'pgsql',
  // ── GraphQL ──
  graphql: 'graphql', gql: 'graphql',
  // ── Lua ──
  lua: 'lua',
  // ── Swift / Dart / R ──
  swift: 'swift',
  dart: 'dart',
  r: 'r', rmd: 'r',
  // ── Functional / JVM alternatives ──
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  ex: 'elixir', exs: 'elixir', eex: 'elixir', heex: 'elixir',
  jl: 'julia',
  nim: 'nim', nims: 'nim',
  zig: 'zig',
  ml: 'ocaml', mli: 'ocaml', fsy: 'fsharp',
  hs: 'haskell', lhs: 'haskell',
  erl: 'erlang', hrl: 'erlang',
  // ── Pascal ──
  pas: 'pascal', pp: 'pascal', lpr: 'pascal',
  // ── Hardware / HDL ──
  v: 'verilog', vh: 'verilog',
  sv: 'systemverilog', svh: 'systemverilog',
  asm: 'mipsasm', s: 'mipsasm',
  // ── Infrastructure / Config ──
  tf: 'terraform', tfvars: 'terraform', tfstate: 'json',
  proto: 'protobuf', protobuf: 'protobuf',
  cmake: 'cmake',
  // ── Cloud / Query ──
  bicep: 'bicep',
  pq: 'powerquery',
  cypher: 'cypher', cyp: 'cypher',
  sparql: 'sparql',
  redis: 'redis',
  // ── Solidity ──
  sol: 'solidity',
  // ── WGSL (WebGPU shaders) ──
  wgsl: 'wgsl',
  // ── Misc ──
  sb: 'smallbasic',
  lexon: 'lexon',
  apex: 'apex',
  azcli: 'azcli',
  abap: 'abap',
}

// Файлы без расширения (или со специальным именем) — матчим по basename
const NAME_MAP: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  cmakelists: 'cmake',
  'cmakelists.txt': 'cmake',
  rakefile: 'ruby',
  gemfile: 'ruby',
  brewfile: 'ruby',
  vagrantfile: 'ruby',
  procfile: 'yaml',
  '.gitignore': 'ini',
  '.dockerignore': 'ini',
  '.npmignore': 'ini',
  '.editorconfig': 'ini',
  '.env': 'ini',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
  '.babelrc': 'json',
}

export function getLanguage(path: string): string {
  const basename = path.split(/[\\/]/).pop() ?? ''
  const lower = basename.toLowerCase()

  // Сначала проверяем точное совпадение имени (Dockerfile, Makefile, .gitignore…)
  if (NAME_MAP[lower]) return NAME_MAP[lower]

  // Затем — расширение
  const ext = basename.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MAP[ext] || 'plaintext'
}

interface CodePreviewProps {
  content: string
  language?: string
  path?: string
  showLineNumbers?: boolean
  maxHeight?: number | string
  truncated?: boolean
  totalSize?: number
  truncatedReason?: string
}

// Prism токенизирует ВЕСЬ контент синхронно. Для файлов >300 строк это
// фризит UI. Порог: до 300 строк — Prism с подсветкой, выше — виртуализированный
// plain text (рендерим только видимые строки, как VSCode).
const PRISM_MAX_LINES = 300
const LINE_HEIGHT = 18

export default function CodePreview({
  content,
  language,
  path,
  showLineNumbers,
  maxHeight = '100%',
  truncated,
  truncatedReason,
}: CodePreviewProps) {
  const lang = language ?? (path ? getLanguage(path) : 'text')
  const lines = useMemo(() => content.split('\n'), [content])
  const lineCount = lines.length
  const showLines = showLineNumbers ?? lineCount > 3
  const usePrism = lineCount <= PRISM_MAX_LINES

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: lineCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 12,
  })

  if (usePrism) {
    return (
      <div className="code-preview">
        <SyntaxHighlighter
          language={lang}
          style={oneDark}
          customStyle={{
            margin: 0,
            borderRadius: 8,
            fontSize: 12,
            maxHeight: maxHeight,
            overflow: 'auto',
            background: 'transparent',
          }}
          showLineNumbers={showLines}
          wrapLongLines={false}
        >
          {content}
        </SyntaxHighlighter>
        {truncated && (
          <div className="code-preview__truncated">
            {truncatedReason ?? 'Файл обрезан — показана только часть содержимого'}
          </div>
        )}
      </div>
    )
  }

  // Виртуализированный plain text — рендерим только видимые строки.
  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className="code-preview">
      <div ref={scrollRef} className="code-preview__scroll" style={{ maxHeight: maxHeight }}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualItems.map(vi => {
            const line = lines[vi.index]
            return (
              <div
                key={vi.index}
                className="code-preview__vline"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  transform: `translateY(${vi.start}px)`,
                  width: '100%',
                  height: vi.size,
                }}
              >
                {showLines && <span className="code-preview__vnum">{vi.index + 1}</span>}
                <span className="code-preview__vtext">{line}</span>
              </div>
            )
          })}
        </div>
      </div>
      {truncated && (
        <div className="code-preview__truncated">
          {truncatedReason ?? 'Файл обрезан — показана только часть содержимого'}
        </div>
      )}
    </div>
  )
}
