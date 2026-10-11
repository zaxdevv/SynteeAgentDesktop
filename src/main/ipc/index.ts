import { ipcMain, nativeTheme, webContents } from 'electron'
import { join, resolve } from 'path'
import { app } from 'electron'
import { promises as fs } from 'fs'
import type Store from 'electron-store'
import { DEFAULT_TOOL_SETTINGS, normalizeDisabledTools } from '../../shared/toolSettings'
import { getActivityManager } from '../managers/ActivityManager'
import { getPluginManager } from '../../core/plugins/pluginManager'
import type { MainWindow } from '../windows/MainWindow'
import type { OverlayWindow } from '../windows/OverlayWindow'
import type { VoiceWindow } from '../windows/VoiceWindow'
import type { SpotlightWindow } from '../windows/SpotlightWindow'
import type { TrayMenuWindow } from '../windows/TrayMenuWindow'
import type { HotkeyManager } from '../hotkeys/HotkeyManager'

interface IPCContext {
  store: Store
  mainWindow: MainWindow
  overlayWindow: OverlayWindow
  voiceWindow: VoiceWindow
  spotlightWindow: SpotlightWindow
  trayMenuWindow: TrayMenuWindow
  hotkeyManager?: HotkeyManager
}

export function registerAllIPC(ctx: IPCContext): void {
  registerWindowIPC(ctx)
  registerSettingsIPC(ctx)
  registerSystemIPC(ctx)
  registerOverlayIPC(ctx)
  registerSpotlightIPC(ctx)
  registerTrayMenuIPC(ctx)
}

function registerWindowIPC({ mainWindow }: IPCContext): void {
  ipcMain.handle('window:hide', () => mainWindow.hide())
  ipcMain.handle('window:minimize', () => mainWindow.minimize())
  ipcMain.handle('window:show', () => mainWindow.show())
  ipcMain.handle('window:maximizeToggle', () => mainWindow.maximizeToggle())
  ipcMain.handle('window:isMaximized', () => mainWindow.isMaximized())
}

// ── Автозагрузка (Login Items / HKCU\...\Run) ──────────────────
// Реальное состояние берём из Electron (app.getLoginItemSettings),
// а не из config.json — чекбокс в настройках всегда показывает правду
// (в т.ч. если юзер отключил автозапуск через Диспетчер задач).
function getAutostartState(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch (e) {
    console.error('[autostart] getLoginItemSettings failed:', e)
    return false
  }
}

function applyAutostart(enabled: boolean): boolean {
  try {
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: enabled })
    } else {
      // dev-режим: process.execPath = electron.exe, без явного path/args
      // в Run прописался бы голый electron без пути к приложению.
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: [resolve(process.argv[1] || '.')],
      })
    }
    return true
  } catch (e) {
    console.error('[autostart] setLoginItemSettings failed:', e)
    return false
  }
}

function registerSettingsIPC({ store, hotkeyManager }: IPCContext): void {
  ipcMain.handle('settings:get', (_, key: string) => store.get(key, DEFAULT_TOOL_SETTINGS[key as keyof typeof DEFAULT_TOOL_SETTINGS]))
  ipcMain.handle('settings:set', (_, key: string, value: unknown) => {
    // Автозагрузка: применяем в ОС ДО сохранения настройки — если реестр
    // недоступен, чекбокс не должен показывать ложное «включено».
    if (key === 'autostart') {
      if (!applyAutostart(Boolean(value))) return
    }
    if (key === 'customToolsEnabled') value = value === true
    if (key === 'disabledTools') value = normalizeDisabledTools(value)
    store.set(key, value)
    // Сброс кэша ActivityManager при изменении его настройки
    if (key === 'activityMonitor') {
      getActivityManager()?.refreshConfig()
    }
    // Перерегистрация глобальных хоткеев при изменении биндингов.
    // Без этого старые шорткаты остаются зарегистрированными до перезапуска.
    if (key === 'hotkeys') {
      hotkeyManager?.reload()
    }
  })
  ipcMain.handle('settings:getAll', () => ({ ...DEFAULT_TOOL_SETTINGS, ...store.store }))
  // Живой опрос реального состояния автозагрузки из реестра Windows
  ipcMain.handle('settings:autostartStatus', () => getAutostartState())
  ipcMain.handle('settings:reset', () => { store.clear(); return true })

  // ── Background image persistence ──────────────────────────────
  // Картинки фона хранятся как файлы в userData/bg-images/, а не как
  // base64 dataURL в config.json (который раздувался бы мегабайтами).
  // settings.bgImage.src хранит путь к файлу (bg-images://filename).
  // Папка = библиотека: юзер может держать несколько картинок и
  // переключаться между ними. Активная = bgImage.src.
  const bgDir = join(app.getPath('userData'), 'bg-images')

  // Защита от path traversal: убеждаемся, что filename не содержит
  // разделителей путей и резолвится внутри bgDir.
  function safeBgPath(filename: string): string | null {
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return null
    }
    const filepath = join(bgDir, filename)
    if (!filepath.startsWith(bgDir)) return null
    return filepath
  }

  ipcMain.handle('bgImage:save', async (_, data: Uint8Array, ext: string) => {
    try {
      await fs.mkdir(bgDir, { recursive: true })
      const filename = `bg-${Date.now()}.${ext || 'png'}`
      const filepath = join(bgDir, filename)
      await fs.writeFile(filepath, Buffer.from(data))
      return `bg-images://${filename}`
    } catch (e) {
      console.error('[bgImage:save]', e)
      return null
    }
  })

  ipcMain.handle('bgImage:list', async () => {
    try {
      const files = await fs.readdir(bgDir).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return []
        throw e
      })
      const entries = await Promise.all(files
        .filter(f => !f.startsWith('.'))
        .map(async f => {
          let size = 0, mtime = 0
          try { const st = await fs.stat(join(bgDir, f)); size = st.size; mtime = st.mtimeMs } catch { /* ok */ }
          return { src: `bg-images://${f}`, name: f, size, mtime }
        }))
      return entries.sort((a, b) => b.mtime - a.mtime)
    } catch (e) {
      console.error('[bgImage:list]', e)
      return []
    }
  })

  ipcMain.handle('bgImage:delete', async (_, src: string) => {
    try {
      if (!src || !src.startsWith('bg-images://')) return false
      const filename = src.replace('bg-images://', '')
      const filepath = safeBgPath(filename)
      if (!filepath) return false
      await fs.unlink(filepath)
      return true
    } catch (e) {
      console.error('[bgImage:delete]', e)
      return false
    }
  })

  ipcMain.handle('bgImage:load', async (_, src: string) => {
    if (!src || !src.startsWith('bg-images://')) return null
    try {
      const filename = src.replace('bg-images://', '')
      const filepath = safeBgPath(filename)
      if (!filepath) return null
      const buf = await fs.readFile(filepath)
      const base64 = buf.toString('base64')
      // Определяем mime по расширению
      const ext = filename.split('.').pop()?.toLowerCase() || 'png'
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif'
        : 'image/png'
      return `data:${mime};base64,${base64}`
    } catch (e) {
      console.error('[bgImage:load]', e)
      return null
    }
  })

  ipcMain.handle('bgImage:clear', async () => {
    try {
      const files = await fs.readdir(bgDir).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return []
        throw e
      })
      for (const f of files) {
        await fs.unlink(join(bgDir, f))
      }
      return true
    } catch { return false }
  })

  // ── Sound files persistence ───────────────────────────────────
  // Кастомные звуки интерфейса хранятся как файлы в userData/sounds/.
  // Схема та же что и bg-images: soundId = custom://<filename>.
  // Встроенные звуки (synth.*) генерируются через Web Audio API в renderer.
  const soundDir = join(app.getPath('userData'), 'sounds')

  function safeSoundPath(filename: string): string | null {
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return null
    }
    const filepath = join(soundDir, filename)
    if (!filepath.startsWith(soundDir)) return null
    return filepath
  }

  function extToMime(ext: string): string {
    return ext === 'mp3' ? 'audio/mpeg'
      : ext === 'wav' ? 'audio/wav'
      : ext === 'ogg' ? 'audio/ogg'
      : ext === 'm4a' ? 'audio/mp4'
      : 'audio/mpeg'
  }

  ipcMain.handle('sound:save', async (_, data: Uint8Array, ext: string, originalName?: string) => {
    try {
      await fs.mkdir(soundDir, { recursive: true })
      const safeExt = (ext || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '')
      // Имя файла: из оригинала (sanitized) или timestamp
      let base = `sound-${Date.now()}`
      if (originalName) {
        base = originalName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9а-яА-Я_-]/g, '_').slice(0, 40) || base
      }
      const filename = `${base}-${Date.now()}.${safeExt}`
      const filepath = join(soundDir, filename)
      await fs.writeFile(filepath, Buffer.from(data))
      return `custom://${filename}`
    } catch (e) {
      console.error('[sound:save]', e)
      return null
    }
  })

  ipcMain.handle('sound:list', async () => {
    try {
      const files = await fs.readdir(soundDir).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return []
        throw e
      })
      const entries = await Promise.all(files
        .filter(f => !f.startsWith('.'))
        .map(async f => {
          let size = 0, mtime = 0
          try { const st = await fs.stat(join(soundDir, f)); size = st.size; mtime = st.mtimeMs } catch { /* ok */ }
          return { id: `custom://${f}`, name: f, size, mtime }
        }))
      return entries.sort((a, b) => b.mtime - a.mtime)
    } catch (e) {
      console.error('[sound:list]', e)
      return []
    }
  })

  ipcMain.handle('sound:load', async (_, id: string) => {
    if (!id || !id.startsWith('custom://')) return null
    try {
      const filename = id.replace('custom://', '')
      const filepath = safeSoundPath(filename)
      if (!filepath) return null
      const buf = await fs.readFile(filepath)
      const base64 = buf.toString('base64')
      const ext = filename.split('.').pop()?.toLowerCase() || 'mp3'
      return `data:${extToMime(ext)};base64,${base64}`
    } catch (e) {
      console.error('[sound:load]', e)
      return null
    }
  })

  ipcMain.handle('sound:delete', async (_, id: string) => {
    try {
      if (!id || !id.startsWith('custom://')) return false
      const filename = id.replace('custom://', '')
      const filepath = safeSoundPath(filename)
      if (!filepath) return false
      await fs.unlink(filepath)
      return true
    } catch (e) {
      console.error('[sound:delete]', e)
      return false
    }
  })

  // ── Internet Archive sound search (keyless, free) ───────────────
  // Поиск звуков на archive.org — не требует API-ключа.
  // CSP блокирует внешние запросы из renderer, поэтому fetch идёт здесь.
  // shortOnly: фильтр item_size:[* TO 2000000] — отсекает музыку/альбомы,
  // оставляя короткие звуки (клики, уведомления и т.д.).
  ipcMain.handle('sound:search', async (_, query: string, page = 1, shortOnly = true) => {
    try {
      const rows = 30
      const start = (page - 1) * rows
      // Поиск и по title, и по subject — даёт релевантные SFX, а не музыку.
      const quoted = query.includes(' ') ? `"${query}"` : query
      let q = `collection:opensource_audio AND (title:${quoted} OR subject:${quoted})`
      if (shortOnly) q += ` AND item_size:[* TO 2000000]`
      const url = `https://archive.org/advancedsearch.php`
        + `?q=${encodeURIComponent(q)}`
        + `&fl[]=identifier&fl[]=title&fl[]=downloads&fl[]=item_size`
        + `&sort[]=downloads desc&rows=${rows}&start=${start}&output=json`
      const res = await fetch(url)
      if (!res.ok) return { results: [], total: 0, page }
      const data = await res.json() as {
        response: { docs: { identifier: string; title: string; downloads: number; item_size: number }[]; numFound: number }
      }
      return {
        results: data.response.docs.map(d => ({
          identifier: d.identifier,
          title: d.title,
          downloads: d.downloads,
          size: d.item_size,
        })),
        total: data.response.numFound,
        page,
      }
    } catch (e) {
      console.error('[sound:search]', e)
      return { results: [], total: 0, page }
    }
  })

  // Получить список аудиофайлов для превью/скачивания
  ipcMain.handle('sound:getFiles', async (_, identifier: string) => {
    try {
      const res = await fetch(`https://archive.org/metadata/${identifier}`)
      if (!res.ok) return { files: [], title: identifier }
      const data = await res.json() as {
        files: { name: string; format: string; length?: string; size?: string }[]
        metadata?: { title?: string }
      }
      // Берём MP3-файлы (original или derivative)
      const audioFiles = (data.files || [])
        .filter(f => f.format === 'VBR MP3' || f.format === 'MP3')
        .map(f => ({
          name: f.name,
          length: f.length || '?',
          size: parseInt(f.size || '0', 10),
        }))
      return { files: audioFiles, title: data.metadata?.title || identifier }
    } catch (e) {
      console.error('[sound:getFiles]', e)
      return { files: [], title: identifier }
    }
  })

  // AbortController для отмены превью — позволяет мгновенно стопнуть загрузку.
  let previewAbort: AbortController | null = null

  ipcMain.handle('sound:cancelPreview', async () => {
    if (previewAbort) {
      previewAbort.abort()
      previewAbort = null
    }
    return true
  })

  // Скачать удалённый звук и вернуть как data URL (для превью).
  // Поддерживает отмену через sound:cancelPreview.
  ipcMain.handle('sound:fetchPreview', async (_, identifier: string, filename: string) => {
    // Отменяем предыдущий превью-запрос если он ещё в полёте.
    if (previewAbort) previewAbort.abort()
    previewAbort = new AbortController()
    const ac = previewAbort
    try {
      const url = `https://archive.org/download/${identifier}/${encodeURIComponent(filename)}`
      const res = await fetch(url, { signal: ac.signal })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      const base64 = buf.toString('base64')
      return `data:audio/mpeg;base64,${base64}`
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return null
      console.error('[sound:fetchPreview]', e)
      return null
    } finally {
      if (previewAbort === ac) previewAbort = null
    }
  })

  // Скачать удалённый звук и сохранить как кастомный
  ipcMain.handle('sound:saveRemote', async (_, identifier: string, filename: string, title: string) => {
    try {
      const url = `https://archive.org/download/${identifier}/${encodeURIComponent(filename)}`
      const res = await fetch(url)
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      await fs.mkdir(soundDir, { recursive: true })
      const base = title.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9а-яА-Я_-]/g, '_').slice(0, 40) || `sound-${Date.now()}`
      const filename_local = `${base}-${Date.now()}.mp3`
      await fs.writeFile(join(soundDir, filename_local), buf)
      return `custom://${filename_local}`
    } catch (e) {
      console.error('[sound:saveRemote]', e)
      return null
    }
  })

  // ── Custom font persistence ───────────────────────────────────
  // Кастомные шрифты хранятся как файлы в userData/custom-fonts/.
  // Схема как bg-images/sounds: file:// URL для @font-face инжекта.
  // Поддерживаемые форматы: .woff2, .woff, .ttf, .otf.
  const fontDir = join(app.getPath('userData'), 'custom-fonts')

  function safeFontPath(filename: string): string | null {
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return null
    }
    const filepath = join(fontDir, filename)
    if (!filepath.startsWith(fontDir)) return null
    return filepath
  }

  // Разрешённые расширения шрифтов
  const FONT_EXTS = ['woff2', 'woff', 'ttf', 'otf']
  function fontExt(filename: string): string {
    return (filename.split('.').pop() || '').toLowerCase()
  }

  ipcMain.handle('font:import', async (_, data: Uint8Array, filename: string) => {
    try {
      const ext = fontExt(filename)
      if (!FONT_EXTS.includes(ext)) return null
      await fs.mkdir(fontDir, { recursive: true })
      // Sanitize filename: убираем путь, оставляем имя + расширение
      const safeName = filename.replace(/[^a-zA-Z0-9а-яА-Я._-]/g, '_').slice(0, 60)
      const finalName = `${Date.now()}-${safeName}`
      const filepath = join(fontDir, finalName)
      await fs.writeFile(filepath, Buffer.from(data))
      return `custom-fonts://${finalName}`
    } catch (e) {
      console.error('[font:import]', e)
      return null
    }
  })

  ipcMain.handle('font:list', async () => {
    try {
      const files = await fs.readdir(fontDir).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return []
        throw e
      })
      const entries = await Promise.all(files
        .filter(f => !f.startsWith('.') && FONT_EXTS.includes(fontExt(f)))
        .map(async f => {
          let size = 0, mtime = 0
          try { const st = await fs.stat(join(fontDir, f)); size = st.size; mtime = st.mtimeMs } catch { /* ok */ }
          return { id: `custom-fonts://${f}`, name: f, size, mtime }
        }))
      return entries.sort((a, b) => b.mtime - a.mtime)
    } catch (e) {
      console.error('[font:list]', e)
      return []
    }
  })

  ipcMain.handle('font:delete', async (_, id: string) => {
    try {
      if (!id || !id.startsWith('custom-fonts://')) return false
      const filename = id.replace('custom-fonts://', '')
      const filepath = safeFontPath(filename)
      if (!filepath) return false
      await fs.unlink(filepath)
      return true
    } catch (e) {
      console.error('[font:delete]', e)
      return false
    }
  })

  // Читает файл шрифта и возвращает как data URL для @font-face инжекта
  ipcMain.handle('font:read', async (_, id: string) => {
    if (!id || !id.startsWith('custom-fonts://')) return null
    try {
      const filename = id.replace('custom-fonts://', '')
      const filepath = safeFontPath(filename)
      if (!filepath) return null
      const buf = await fs.readFile(filepath)
      const base64 = buf.toString('base64')
      const ext = fontExt(filename)
      const mime = ext === 'woff2' ? 'font/woff2'
        : ext === 'woff' ? 'font/woff'
        : ext === 'ttf' ? 'font/ttf'
        : ext === 'otf' ? 'font/otf'
        : 'font/woff2'
      return `data:${mime};base64,${base64}`
    } catch (e) {
      console.error('[font:read]', e)
      return null
    }
  })

}

function registerSystemIPC(_ctx: IPCContext): void {
  const { app, shell } = require('electron')
  ipcMain.handle('system:info', () => ({
    platform: process.platform,
    version: process.getSystemVersion(),
    appVersion: app.getVersion(),
  }))
  ipcMain.handle('system:logError', (_, message: string, stack?: string) => {
    console.error('[Renderer Error]', message, stack)
  })
  ipcMain.handle('shell:openPath', (_, path: string) => shell.openPath(path))
  // Показать файл в Проводнике (с выделением). Для папок — открыть папку.
  ipcMain.handle('shell:showItemInFolder', (_, path: string) => shell.showItemInFolder(path))

  // ── Системная тема Windows (nativeTheme) ─────────────────────
  // Renderer использует для настройки «Синхронизация с темой Windows»:
  // isDark — текущее состояние, событие — live-переключение без перезапуска.
  ipcMain.handle('systemTheme:isDark', () => nativeTheme.shouldUseDarkColors)
  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send('systemTheme:changed', isDark)
    }
  })

  ipcMain.handle('extensions:getPaths', () => {
    const { app } = require('electron')
    const { join } = require('path')
    const { homedir } = require('os')
    return {
      mcpConfig: join(homedir(), '.syntee', 'mcp.json'),
      mcpConfigDir: join(homedir(), '.syntee'),
      skillsUserDir: join(app.getPath('userData'), 'skills'),
      skillsBuiltinDir: join(process.resourcesPath ?? app.getAppPath(), 'skills'),
    }
  })
}

function registerOverlayIPC({ overlayWindow }: IPCContext): void {
  ipcMain.handle('overlay:show', () => overlayWindow.show())
  ipcMain.handle('overlay:hide', () => overlayWindow.hide())
  ipcMain.handle('overlay:getDisplays', () => overlayWindow.getDisplaysInfo())
}

function registerSpotlightIPC({ spotlightWindow, mainWindow, voiceWindow, store }: IPCContext): void {
  ipcMain.handle('spotlight:show', () => spotlightWindow.show())
  ipcMain.handle('spotlight:hide', () => spotlightWindow.hide())
  ipcMain.handle('spotlight:expand', () => spotlightWindow.expand())
  ipcMain.handle('spotlight:collapse', () => spotlightWindow.collapse())

  // voice:show не зарегистрирован в voice.ipc.ts (там только STT/TTS/статус).
  // Добавляем минимальный show/hide здесь, т.к. voiceWindow уже в контексте —
  // это закрывает потребность Spotlight/tray запустить голосовой ввод.
  ipcMain.handle('voice:show', () => voiceWindow.show())
  ipcMain.handle('voice:hide', () => voiceWindow.hide())

  // ── Relay-действия из Spotlight в главное окно ────────────────────────
  // Spotlight — отдельное BrowserWindow, не имеет доступа к AI-стриму/чату
  // напрямую (chat:send стримит в mainWindow.webContents). Поэтому применяем
  // паттерн tray openSettings: показываем главное окно + шлём nav-событие,
  // которое App.tsx слушает и обрабатывает (создать чат / открыть чат /
  // отправить быстрый запрос).
  // quickAsk: query + опциональный chatId. Если chatId передан — отправить
  // в существующий чат (App.tsx). Иначе — создать новый.
  ipcMain.handle('spotlight:quickAsk', (_, query: string, chatId?: string) => {
    spotlightWindow.hide()
    mainWindow.show()
    mainWindow.getWindow()?.webContents.send('nav:quick-ask', {
      query: String(query ?? ''),
      chatId: chatId ? String(chatId) : null,
    })
  })
  ipcMain.handle('spotlight:newChat', () => {
    spotlightWindow.hide()
    mainWindow.show()
    mainWindow.getWindow()?.webContents.send('nav:new-chat')
  })
  ipcMain.handle('spotlight:openChat', (_, chatId: string) => {
    spotlightWindow.hide()
    mainWindow.show()
    mainWindow.getWindow()?.webContents.send('nav:open-chat', String(chatId ?? ''))
  })
  // openSettings с опциональной секцией (App.tsx вызывает useNavStore.openSettings(section)).
  ipcMain.handle('spotlight:openSettings', (_, section?: string) => {
    spotlightWindow.hide()
    mainWindow.show()
    mainWindow.getWindow()?.webContents.send('nav:open-settings', String(section ?? ''))
  })

  // ── История запросов Spotlight (персистится в electron-store) ──────────
  // getHistory возвращает последние запросы (новые первыми). addHistory
  // добавляет наверх с дедупликацией, лимит 12.
  ipcMain.handle('spotlight:getHistory', () => {
    const arr = store.get('spotlightHistory')
    return Array.isArray(arr) ? arr as string[] : []
  })
  ipcMain.handle('spotlight:addHistory', (_, q: string) => {
    const text = String(q ?? '').trim()
    if (!text) return
    const arr = (store.get('spotlightHistory') as string[] | undefined) ?? []
    const next = [text, ...arr.filter(x => x !== text)].slice(0, 12)
    store.set('spotlightHistory', next)
  })
  ipcMain.handle('spotlight:clearHistory', () => {
    store.set('spotlightHistory', [])
  })
}

// ── Кастомное трей-меню ──────────────────────────────────────────────
// Действия меню выполняются в main-процессе (доступ к окнам), renderer
// только триггерит их по id и скрывает меню. openSettings показывает
// главное окно и шлёт ему nav-событие — App.tsx слушает и переключает
// страницу на settings.
function registerTrayMenuIPC({ trayMenuWindow, mainWindow, voiceWindow, spotlightWindow }: IPCContext): void {
  ipcMain.handle('tray-menu:hide', () => trayMenuWindow.hide())
  ipcMain.handle('tray-menu:getMeta', () => ({ version: app.getVersion() }))
  // Plugins: пункты меню трея от плагинов (снапшот + клик).
  ipcMain.handle('tray-menu:getPluginItems', () => {
    try { return getPluginManager().getTrayItems() } catch { return [] }
  })
  ipcMain.handle('tray-menu:pluginAction', (_, pluginId: string, label: string, command?: string) => {
    try {
      void getPluginManager().trayAction(pluginId, label, command)
    } catch { /* ignore */ }
  })
  ipcMain.handle('tray-menu:action', (_, action: string) => {
    switch (action) {
      case 'showMain':
        mainWindow.show()
        break
      case 'showVoice':
        voiceWindow.show()
        break
      case 'showSpotlight':
        spotlightWindow.show()
        break
      case 'openSettings':
        mainWindow.show()
        mainWindow.getWindow()?.webContents.send('nav:open-settings')
        break
      case 'openDots':
        mainWindow.show()
        mainWindow.getWindow()?.webContents.send('nav:open-dots')
        break
      case 'quit':
        app.exit(0)
        break
    }
  })
}
