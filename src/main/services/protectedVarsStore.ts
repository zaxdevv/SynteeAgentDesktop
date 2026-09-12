/**
 * Encrypted storage for protected variables (user secrets).
 *
 * Uses Electron safeStorage (DPAPI on Windows, Keychain on macOS, libsecret
 * on Linux) — same approach as tokenStore.ts and plugin secrets. The file
 * {userData}/protectedVars.json holds metadata in plain text plus values as
 * base64-encrypted blobs, so the file is useless when copied to another
 * machine.
 *
 * The renderer only ever receives ProtectedVarMeta (no values). Decrypted
 * values are resolved exclusively for system-prompt injection in the main
 * process.
 */
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ProtectedVarMeta, ProtectedVarResolved, ProtectedVarSaveInput } from '../../shared/types/protectedVars'

/** On-disk record: meta + encrypted value (base64 safeStorage blob). */
interface StoredVar extends ProtectedVarMeta {
  valueEnc: string
}

function filePath(): string {
  return join(app.getPath('userData'), 'protectedVars.json')
}

function canEncrypt(): boolean {
  return safeStorage.isEncryptionAvailable()
}

function loadAll(): StoredVar[] {
  try {
    const file = filePath()
    if (!existsSync(file)) return []
    const data = JSON.parse(readFileSync(file, 'utf-8')) as { vars?: StoredVar[] }
    return Array.isArray(data.vars) ? data.vars : []
  } catch {
    // Повреждённый файл — начинаем с пустого (как plugin secrets)
    return []
  }
}

function persist(vars: StoredVar[]): void {
  // userData всегда существует к моменту вызова — отдельный mkdir не нужен
  writeFileSync(filePath(), JSON.stringify({ vars }, null, 2), { encoding: 'utf-8' })
}

function toMeta(v: StoredVar): ProtectedVarMeta {
  const { valueEnc: _valueEnc, ...meta } = v
  return meta
}

/** All vars as metadata (renderer-safe, no values). */
export function listVars(): ProtectedVarMeta[] {
  return loadAll().map(toMeta)
}

/**
 * Create or update a var. Value is optional on edit (empty = keep stored).
 * Returns updated metadata or throws on validation errors.
 */
export function saveVar(input: ProtectedVarSaveInput): ProtectedVarMeta {
  const key = (input.key ?? '').trim()
  if (!key) throw new Error('Ключ обязателен')
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
    throw new Error('Ключ: только латиница, цифры, _ . -')
  }
  const vars = loadAll()

  // Уникальность ключа
  const duplicate = vars.find(v => v.key === key && v.id !== input.id)
  if (duplicate) throw new Error(`Ключ «${key}» уже существует`)

  const now = Date.now()
  let record: StoredVar

  if (input.id) {
    const existing = vars.find(v => v.id === input.id)
    if (!existing) throw new Error('Переменная не найдена')
    const valueProvided = typeof input.value === 'string' && input.value.length > 0
    if (valueProvided) {
      if (!canEncrypt()) throw new Error('Шифрование недоступно в этой системе (safeStorage)')
      existing.valueEnc = safeStorage.encryptString(input.value).toString('base64')
    }
    existing.key = key
    existing.description = input.description?.trim() || undefined
    existing.group = input.group?.trim() || undefined
    existing.linkedIds = (input.linkedIds ?? []).filter(id => id !== existing.id && vars.some(v => v.id === id))
    existing.enabled = input.enabled ?? existing.enabled
    existing.updatedAt = now
    record = existing
  } else {
    if (!input.value) throw new Error('Значение обязательно при создании')
    if (!canEncrypt()) throw new Error('Шифрование недоступно в этой системе (safeStorage)')
    record = {
      id: randomUUID(),
      key,
      description: input.description?.trim() || undefined,
      group: input.group?.trim() || undefined,
      linkedIds: (input.linkedIds ?? []).filter(id => vars.some(v => v.id === id)),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      valueEnc: safeStorage.encryptString(input.value).toString('base64'),
    }
    vars.push(record)
  }

  persist(vars)
  return toMeta(record)
}

/** Delete a var and clean up links to it from other vars. */
export function deleteVar(id: string): boolean {
  const vars = loadAll()
  const idx = vars.findIndex(v => v.id === id)
  if (idx === -1) return false
  vars.splice(idx, 1)
  let changed = false
  for (const v of vars) {
    if (v.linkedIds.includes(id)) {
      v.linkedIds = v.linkedIds.filter(l => l !== id)
      changed = true
    }
  }
  persist(vars)
  return true
}
/**
 * Decrypt and resolve all ENABLED vars for system-prompt injection.
 * Skips entries that fail to decrypt (file moved from another machine).
 */
export function resolveActive(): ProtectedVarResolved[] {
  const vars = loadAll().filter(v => v.enabled)
  const keyById = new Map(vars.map(v => [v.id, v.key]))
  const out: ProtectedVarResolved[] = []
  for (const v of vars) {
    try {
      const value = safeStorage.decryptString(Buffer.from(v.valueEnc, 'base64'))
      out.push({
        key: v.key,
        value,
        description: v.description,
        group: v.group,
        linkedKeys: v.linkedIds.map(id => keyById.get(id)).filter((k): k is string => Boolean(k)),
      })
    } catch {
      // Расшифровка не удалась — пропускаем, не ломаем промпт
    }
  }
  return out
}
