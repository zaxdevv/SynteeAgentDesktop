import { memo } from 'react'
import './FileIcon.css'

// ── FileIcon — SVG-иконки типов файлов (как Seti theme в VS Code) ──────
// Базовая форма — файл с загнутым углом. Цвет и символ внутри — по типу.
// Чистые геометрические SVG, рендерятся чётко на любом размере.

interface FileIconProps {
  name: string
  size?: number
  className?: string
}

// ── Специальные имена файлов (приоритет над расширением) ──────────────
const FILENAME_ICONS: Record<string, string> = {
  'package.json': 'npm',
  'package-lock.json': 'npm',
  'tsconfig.json': 'tsconfig',
  'tsconfig.node.json': 'tsconfig',
  'tsconfig.web.json': 'tsconfig',
  '.gitignore': 'gitignore',
  '.npmrc': 'npm',
  '.editorconfig': 'config',
  '.prettierrc.yaml': 'config',
  '.prettierrc': 'config',
  '.prettierignore': 'config',
  'dockerfile': 'docker',
  'readme.md': 'readme',
  'license': 'license',
  'makefile': 'makefile',
  '.env': 'env',
  '.env.local': 'env',
  '.env.production': 'env',
  '.env.development': 'env',
}

// ── Маппинг расширение → тип иконки ──────────────────────────────────
const EXT_ICONS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json',
  css: 'css', scss: 'scss', sass: 'scss', less: 'css',
  html: 'html', htm: 'html',
  md: 'markdown',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java', class: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  vue: 'vue',
  svelte: 'svelte',
  xml: 'xml', svg: 'svg',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', ico: 'image', webp: 'image', bmp: 'image',
  lock: 'lock',
  env: 'env',
  gitignore: 'gitignore',
  ps1: 'powershell', psm1: 'powershell',
  graphql: 'graphql', gql: 'graphql',
  dockerfile: 'docker',
  txt: 'text',
  log: 'log',
  bat: 'batch', cmd: 'batch',
  lua: 'lua',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  dart: 'dart',
  ex: 'elixir', exs: 'elixir',
  scala: 'scala',
  nim: 'nim',
  zig: 'zig',
  proto: 'protobuf',
  cmake: 'cmake',
  nix: 'nix',
}

function getIconType(name: string): string {
  const lower = name.toLowerCase()
  if (FILENAME_ICONS[lower]) return FILENAME_ICONS[lower]
  const ext = lower.split('.').pop() ?? ''
  return EXT_ICONS[ext] ?? 'default'
}

// ── SVG-иконки ────────────────────────────────────────────────────────
// Базовая форма — файл с загнутым углом. Внутри — текстовая метка (TS, JS, …)
// или простой символ. Все 16x16 viewBox, currentColor для цвета.

const ICONS: Record<string, { color: string; render: () => React.ReactElement }> = {
  typescript: { color: '#3178c6', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">TS</text></>) },
  javascript: { color: '#f7df1e', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">JS</text></>) },
  json: { color: '#f0a000', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11.5" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">{`{}`}</text></>) },
  css: { color: '#264de4', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4.5" fontWeight="700" fill="currentColor" fontFamily="monospace">CSS</text></>) },
  scss: { color: '#cc6699', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">SC</text></>) },
  html: { color: '#e34c26', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4.5" fontWeight="700" fill="currentColor" fontFamily="monospace">HTM</text></>) },
  markdown: { color: '#519aba', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="6" fontWeight="700" fill="currentColor" fontFamily="monospace">M</text></>) },
  python: { color: '#3572a5', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">PY</text></>) },
  go: { color: '#00add8', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">GO</text></>) },
  rust: { color: '#dea584', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">RS</text></>) },
  java: { color: '#b07219', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4.5" fontWeight="700" fill="currentColor" fontFamily="monospace">JVM</text></>) },
  c: { color: '#555555', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="6" fontWeight="700" fill="currentColor" fontFamily="monospace">C</text></>) },
  cpp: { color: '#f34b7d', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">C++</text></>) },
  shell: { color: '#89e051', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">SH</text></>) },
  yaml: { color: '#cb171e', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4.5" fontWeight="700" fill="currentColor" fontFamily="monospace">YML</text></>) },
  toml: { color: '#9c4221', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4.5" fontWeight="700" fill="currentColor" fontFamily="monospace">TOML</text></>) },
  sql: { color: '#e38c00', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">SQL</text></>) },
  vue: { color: '#41b883', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">VUE</text></>) },
  svelte: { color: '#ff3e00', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">SVE</text></>) },
  xml: { color: '#e37933', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4.5" fontWeight="700" fill="currentColor" fontFamily="monospace">XML</text></>) },
  svg: { color: '#ffb13b', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4.5" fontWeight="700" fill="currentColor" fontFamily="monospace">SVG</text></>) },
  image: { color: '#a371f7', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><circle cx="6.5" cy="7" r="1" fill="currentColor" /><path d="M5.5 11l2-2 1.5 1.5L11 8" fill="none" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" /></>) },
  lock: { color: '#6b7280', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><rect x="6.5" y="8" width="3" height="2.5" rx="0.3" fill="currentColor" /><path d="M7 8V7c0-.5.4-1 1-1s1 .5 1 1v1" fill="none" stroke="currentColor" strokeWidth="0.7" /></>) },
  env: { color: '#e0b400', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">ENV</text></>) },
  gitignore: { color: '#f1502f', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">GIT</text></>) },
  npm: { color: '#cb3837', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">NPM</text></>) },
  tsconfig: { color: '#3178c6', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">TSC</text></>) },
  config: { color: '#6b7280', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><path d="M6 8l4 2M6 10l4-2" fill="none" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" /></>) },
  docker: { color: '#2496ed', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><rect x="5.5" y="7.5" width="1.2" height="1.2" fill="currentColor" /><rect x="7" y="7.5" width="1.2" height="1.2" fill="currentColor" /><rect x="8.5" y="7.5" width="1.2" height="1.2" fill="currentColor" /><rect x="7" y="6" width="1.2" height="1.2" fill="currentColor" /><path d="M5 10h5c0-1-.5-1.5-2.5-1.5S5 9 5 10z" fill="currentColor" /></>) },
  readme: { color: '#519aba', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">RD</text></>) },
  license: { color: '#6b7280', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">LIC</text></>) },
  makefile: { color: '#427819', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" fontFamily="monospace">MK</text></>) },
  powershell: { color: '#5391fe', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">PS1</text></>) },
  graphql: { color: '#e535ab', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">GQL</text></>) },
  text: { color: '#6b7280', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><path d="M5.5 7h5M5.5 8.5h5M5.5 10h3.5" fill="none" stroke="currentColor" strokeWidth="0.6" strokeLinecap="round" /></>) },
  log: { color: '#6b7280', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><path d="M5.5 7h5M5.5 8.5h5M5.5 10h3.5" fill="none" stroke="currentColor" strokeWidth="0.6" strokeLinecap="round" /></>) },
  batch: { color: '#89e051', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">BAT</text></>) },
  lua: { color: '#000080', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">LUA</text></>) },
  php: { color: '#777bb4', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">PHP</text></>) },
  ruby: { color: '#cc342d', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">RB</text></>) },
  swift: { color: '#f05138', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">SW</text></>) },
  kotlin: { color: '#7f52ff', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">KT</text></>) },
  dart: { color: '#00b4ab', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">DRT</text></>) },
  elixir: { color: '#4b275f', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">EX</text></>) },
  scala: { color: '#dc322f', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">SCA</text></>) },
  nim: { color: '#ffc200', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">NIM</text></>) },
  zig: { color: '#ec915c', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">ZIG</text></>) },
  protobuf: { color: '#4285f4', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">PRT</text></>) },
  cmake: { color: '#064f8c', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">CMK</text></>) },
  nix: { color: '#7eb1ce', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><text x="8" y="11" textAnchor="middle" fontSize="4" fontWeight="700" fill="currentColor" fontFamily="monospace">NIX</text></>) },
  default: { color: '#6b7280', render: () => (<><path d="M4 1.5h5L12 4.5v10H4z" fill="currentColor" opacity="0.15" /><path d="M9 1.5V4.5h3M4 1.5h5L12 4.5v10H4z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /><path d="M5.5 7h5M5.5 8.5h5M5.5 10h3.5" fill="none" stroke="currentColor" strokeWidth="0.6" strokeLinecap="round" /></>) },
}

function FileIconImpl({ name, size = 16, className }: FileIconProps) {
  const iconType = getIconType(name)
  const icon = ICONS[iconType] ?? ICONS.default
  return (
    <span
      className={`file-icon ${className ?? ''}`}
      style={{ width: size, height: size, color: icon.color, display: 'inline-flex', flexShrink: 0 }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {icon.render()}
      </svg>
    </span>
  )
}

export default memo(FileIconImpl)
