/**
 * builtinPlugins — встроенные плагины, поставляемые вместе с приложением.
 *
 * Исходники лежат в репозитории: resources/builtin-plugins/{id}/
 * (обычные плагины по стандарту: plugin.json + CJS entry + ui/ + docs/).
 * electron-builder копирует resources/ в extraResources, поэтому в
 * packaged-сборке они доступны по process.resourcesPath/builtin-plugins.
 *
 * При каждом запуске приложения syncBuiltinPlugins() синхронизирует их
 * в {userData}/plugins/{id}/ — оттуда их подхватывает обычный loader:
 *   - папки нет            → копируем (установка);
 *   - папка есть и в ней plugin.json с builtin:true:
 *       dev-режим  → заменяем при каждом запуске (репо — истина);
 *       packaged   → заменяем только при смене версии (обновление app);
 *   - папка есть, но это НЕ builtin (пользовательский плагин с тем же id)
 *                           → не трогаем (пользовательское имеет приоритет).
 *
 * Dev-цикл разработки builtin-плагина: правишь исходник прямо в
 * resources/builtin-plugins/{id}/ (он в гите) → hot reload менеджера
 * перезаливает копию и перезапускает плагин (см. pluginManager
 * setupHotReloadWatcher + syncBuiltinPluginDir). Редактировать копию в
 * {userData} не нужно — она рантайм-кэш и перезаписывается синком.
 * При resync СОХРАНЯЮТСЯ: node_modules, маркеры зависимостей (.npm-deps.json,
 * .deps.json), cache/ — иначе плагин с dependencies просил бы переустановку
 * после каждого запуска (dev-режим обновляет копию при каждом старте).
 *
 * Удалить встроенный плагин через UI нельзя (guard в plugins:uninstall);
 * ручное удаление папки откатывается синхронизацией при следующем запуске.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { PluginManifest } from '../../shared/types'

/**
 * Встроенные плагины (builtin) НЕ включаются автоматически ни при первой
 * установке, ни при обновлении: единая модель — opt-in. Плагин без записи в
 * pluginsState считается выключенным, включение — только явным toggle в UI
 * (с consent-диалогом прав). См. PluginManager.getState.
 *
 * Рантайм-состояние плагина, которое ПЕРЕЖИВАЕТ resync из репозитория:
 * установленные npm-пакеты, маркеры зависимостей (npm/python), кэш.
 * Без этого каждый запуск в dev-режиме сносил бы node_modules, и плагин
 * с dependencies просил бы переустановку зависимостей после каждого рестарта.
 */
const RESYNC_PRESERVED = ['node_modules', '.npm-deps.json', '.deps.json', 'cache']

/** Копирует исходники плагина, НЕ тратя node_modules из репозитория
 *  (зависимости ставятся в рантайме в целевую папку — см. npmRuntime). */
function cpPluginSources(srcDir: string, targetDir: string): void {
  cpSync(srcDir, targetDir, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes('node_modules'),
  })
}

/** Папка с исходниками встроенных плагинов (dev — репозиторий, prod — resources). */
export function getBuiltinPluginsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'builtin-plugins')
  }
  // Dev / npm start: app.getAppPath() ненадёжен (при `electron out/main/index.js`
  // возвращает папку скрипта, а не корень проекта) — пробуем несколько кандидатов.
  const candidates = [
    join(app.getAppPath(), 'resources', 'builtin-plugins'),
    join(__dirname, '..', '..', 'resources', 'builtin-plugins'),
    join(process.cwd(), 'resources', 'builtin-plugins'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  console.warn('[plugins] builtin: папка builtin-plugins не найдена, искал в:', candidates)
  return candidates[0]
}

/** Простое сравнение версий '1.2.3' → [1,2,3] (числовое, по компонентам). */
function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Перезаливает один builtin-плагин из репозитория в {userData}/plugins,
 *  сохраняя рантайм-состояние (node_modules, маркеры зависимостей, кэш).
 * Используется dev-режимом hot reload: правка исходника в
 * resources/builtin-plugins → синк → перезапуск плагина с новым кодом.
 * Данные плагина не страдают — storage лежит в plugins-data/. */
export function syncBuiltinPluginDir(srcDir: string, targetDir: string): boolean {
  try {
    // Спасаем рантайм-состояние: выносим во временные папки-соседи.
    const saved: Array<{ tmp: string; dest: string }> = []
    for (const name of RESYNC_PRESERVED) {
      const dest = join(targetDir, name)
      if (!existsSync(dest)) continue
      const tmp = targetDir + '.' + name + '.resync-tmp'
      try {
        rmSync(tmp, { recursive: true, force: true })
        renameSync(dest, tmp)
        saved.push({ tmp, dest })
      } catch {
        /* не смогли вынести — просто потеряем с остальной папкой */
      }
    }
    try {
      rmSync(targetDir, { recursive: true, force: true })
      cpPluginSources(srcDir, targetDir)
    } finally {
      // Возвращаем сохранённое поверх свежих исходников.
      for (const { tmp, dest } of saved) {
        try {
          rmSync(dest, { recursive: true, force: true })
          renameSync(tmp, dest)
        } catch {
          /* ignore */
        }
      }
    }
    return true
  } catch (e) {
    console.warn(`[plugins] builtin resync failed: ${srcDir}:`, (e as Error).message)
    return false
  }
}

function readManifest(dir: string): PluginManifest | null {
  try {
    // \uFEFF: UTF-8 BOM ломает JSON.parse (см. pluginLoader).
    return JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8').replace(/^\uFEFF/, '')) as PluginManifest
  } catch {
    return null
  }
}

export interface BuiltinSyncResult {
  /** Id плагинов, скопированных впервые. */
  installed: string[]
  /** Id плагинов, обновлённых до новой версии приложения. */
  updated: string[]
}

/**
 * Синхронизирует встроенные плагины в глобальную папку плагинов.
 * Вызывается из конструктора PluginManager (до первого scan/autostart).
 */
export function syncBuiltinPlugins(globalPluginsDir: string): BuiltinSyncResult {
  const result: BuiltinSyncResult = { installed: [], updated: [] }
  const srcRoot = getBuiltinPluginsDir()
  if (!existsSync(srcRoot)) {
    console.warn('[plugins] builtin sync: исходники не найдены:', srcRoot)
    return result
  }

  let entries: string[]
  try {
    entries = readdirSync(srcRoot)
  } catch {
    return result
  }

  for (const entry of entries) {
    const srcDir = join(srcRoot, entry)
    try {
      if (!statSync(srcDir).isDirectory()) continue
    } catch {
      continue
    }
    const srcManifest = readManifest(srcDir)
    if (!srcManifest?.id || !srcManifest.main) continue
    // Источник истины id — имя папки (как требует loader).
    if (srcManifest.id !== entry) {
      console.warn(`[plugins] builtin: id (${srcManifest.id}) != имя папки (${entry}) — пропущен`)
      continue
    }

    const targetDir = join(globalPluginsDir, entry)
    if (!existsSync(targetDir)) {
      try {
        mkdirSync(globalPluginsDir, { recursive: true })
        cpPluginSources(srcDir, targetDir)
        result.installed.push(entry)
      } catch (e) {
        console.warn(`[plugins] builtin install failed: ${entry}:`, (e as Error).message)
      }
      continue
    }

    // Папка существует: обновляем только наши builtin-копии.
    const dstManifest = readManifest(targetDir)
    if (!dstManifest?.builtin) continue // пользовательский плагин — не трогаем
    // Dev-режим: репозиторий — источник истины, обновляем при каждом
    // запуске БЕЗ гейта по версии (иначе правка dist/index.js без бампа
    // версии в plugin.json никогда не доезжает до работающей копии).
    // Packaged: обновляем только при смене версии (обновление приложения).
    if (app.isPackaged && compareVersions(dstManifest.version ?? '0', srcManifest.version ?? '0') === 0) continue

    try {
      // Тот же контракт, что у hot-reload resync: обновляем исходники,
      // сохраняя node_modules и маркеры зависимостей пользователя.
      syncBuiltinPluginDir(srcDir, targetDir)
      result.updated.push(entry)
    } catch (e) {
      console.warn(`[plugins] builtin update failed: ${entry}:`, (e as Error).message)
    }
  }

  if (result.installed.length || result.updated.length) {
    console.log(
      `[plugins] builtin sync: установлено [${result.installed.join(', ')}], ` +
      `обновлено [${result.updated.join(', ')}]`,
    )
  }
  return result
}
