import type { Project } from '../../shared/types'
import { v4 as uuid } from 'uuid'
import { basename } from 'path'
import { getDB } from './handle'
import { deleteChat } from './chats'

// === PROJECTS ===

export function createProject(workdir: string, projectContext?: string): Project {
  const db = getDB()
  const now = Date.now()
  const name = basename(workdir) || workdir
  // Если проект с таким workdir уже существует — возвращаем его (UNIQUE на workdir).
  const existing = db.prepare(`SELECT * FROM projects WHERE workdir = ?`).get(workdir) as Project | undefined
  if (existing) {
    // Обновляем last_used и контекст если передан новый
    if (projectContext) {
      db.prepare(`UPDATE projects SET project_context = ?, last_used = ? WHERE id = ?`).run(projectContext, now, existing.id)
    } else {
      db.prepare(`UPDATE projects SET last_used = ? WHERE id = ?`).run(now, existing.id)
    }
    return { ...existing, lastUsed: now, projectContext: projectContext ?? existing.projectContext }
  }
  const project: Project = {
    id: uuid(),
    name,
    workdir,
    projectContext,
    createdAt: now,
    lastUsed: now,
  }
  db.prepare(`INSERT INTO projects (id, name, workdir, project_context, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(project.id, project.name, project.workdir, projectContext ?? null, project.createdAt, project.lastUsed)
  return project
}

export function getAllProjects(): Project[] {
  return getDB().prepare(`
    SELECT id, name, workdir, project_context as projectContext, verification_command as verificationCommand,
           created_at as createdAt, last_used as lastUsed
    FROM projects ORDER BY last_used DESC
  `).all() as Project[]
}

export function renameProject(id: string, name: string): void {
  getDB().prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
}

export function setProjectVerificationCommand(id: string, command: string | null): void {
  getDB().prepare('UPDATE projects SET verification_command = ? WHERE id = ?').run(command, id)
}

export function deleteProject(id: string, deleteChats = false): void {
  const db = getDB()
  db.transaction(() => {
    if (deleteChats) {
      // Удаляем все чаты проекта (с полным каскадом: граф, summary, memory, messages)
      const chatIds = db.prepare('SELECT id FROM chats WHERE project_id = ?').all(id) as { id: string }[]
      for (const { id: chatId } of chatIds) {
        deleteChat(chatId)
      }
    } else {
      // Чаты остаются, но workdir и project_context зануляем —
      // иначе migrateChatsToProjects() пересоздаст проект при следующем старте.
      db.prepare(
        'UPDATE chats SET project_id = NULL, workdir = NULL, project_context = NULL WHERE project_id = ?'
      ).run(id)
    }
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  })()
}

export function getProjectById(id: string): Project | undefined {
  const row = getDB().prepare(`
    SELECT id, name, workdir, project_context as projectContext, verification_command as verificationCommand,
           created_at as createdAt, last_used as lastUsed
    FROM projects WHERE id = ?
  `).get(id) as Project | undefined
  return row
}

export function touchProject(id: string): void {
  getDB().prepare('UPDATE projects SET last_used = ? WHERE id = ?').run(Date.now(), id)
}
