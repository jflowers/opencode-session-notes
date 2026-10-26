import { Database, type SQLQueryBindings } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const NOTE_TYPES = ["note", "plan", "finding", "decision"] as const
export type NoteType = (typeof NOTE_TYPES)[number]

export type Note = {
  id: string
  sessionId: string
  type: NoteType
  title: string
  content: string
  tags: string[]
  projectDirectory: string | null
  createdAt: number
  updatedAt: number
}

export type SearchMatch = Note & { snippet: string }

export type SaveResult = {
  note: Note
  created: boolean
  appended: boolean
}

const MAX_TAGS = 20
const MAX_TAG_LENGTH = 64
const BUSY_TIMEOUT_MS = 5000

function dataHome(): string {
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
}

export function notesDbPath(): string {
  return join(dataHome(), "opencode-session-notes", "notes.db")
}

export function opencodeDbPath(): string {
  return join(dataHome(), "opencode", "opencode.db")
}

export function clamp(n: number | undefined, min: number, max: number, fallback: number): number {
  if (n === undefined || n === null || Number.isNaN(n)) return fallback
  const v = Math.floor(n)
  return Math.min(max, Math.max(min, v))
}

export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => "\\" + ch)
}

function normalizeTags(tags: string[] | undefined | null): string[] {
  if (!tags) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const t = String(raw).trim().slice(0, MAX_TAG_LENGTH)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

function toNoteType(value: unknown): NoteType {
  return NOTE_TYPES.includes(value as NoteType) ? (value as NoteType) : "note"
}

type NoteRow = {
  id: string
  session_id: string
  type: string
  title: string
  content: string
  tags: string | null
  project_directory: string | null
  created_at: number
  updated_at: number
}

function rowToNote(row: NoteRow): Note {
  let tags: string[] = []
  if (row.tags) {
    try {
      const parsed = JSON.parse(row.tags)
      if (Array.isArray(parsed)) tags = parsed.map(String)
    } catch {
      tags = []
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    type: toNoteType(row.type),
    title: row.title,
    content: row.content,
    tags,
    projectDirectory: row.project_directory,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      type          TEXT NOT NULL DEFAULT 'note',
      title         TEXT NOT NULL,
      content       TEXT NOT NULL,
      tags          TEXT,
      project_directory TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_session ON note(session_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_type ON note(type)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_created ON note(created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_project ON note(project_directory)`)
  db.exec(`PRAGMA user_version = 1`)
}

export function openNotesDB(path: string = notesDbPath()): Database {
  const dir = join(path, "..")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new Database(path)
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  db.exec(`PRAGMA journal_mode = WAL`)
  migrate(db)
  return db
}

function openOpencodeDB(): Database | null {
  const path = opencodeDbPath()
  if (!existsSync(path)) return null
  const db = new Database(path, { readonly: true })
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  return db
}

export type SaveInput = {
  id?: string
  sessionId: string
  title?: string
  content: string
  type?: NoteType
  tags?: string[]
  projectDirectory?: string | null
  append?: boolean
}

export function saveNote(input: SaveInput, path: string = notesDbPath()): SaveResult {
  const content = input.content
  if (!content || !content.trim()) throw new Error("content is required")

  const db = openNotesDB(path)
  try {
    if (input.id) {
      const existingRow = db
        .prepare(`SELECT * FROM note WHERE id = ?`)
        .get(input.id) as NoteRow | undefined
      if (!existingRow) throw new Error(`note not found: ${input.id}`)
      const existing = rowToNote(existingRow)

      let newContent: string
      if (input.append) {
        const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC"
        newContent = `${existing.content}\n\n---\n\n[Appended ${stamp}]\n\n${content}`
      } else {
        newContent = content
      }

      const title = input.title?.trim() || existing.title
      const type = input.type ?? existing.type
      const tags = input.tags ? normalizeTags(input.tags) : existing.tags
      const updatedAt = Date.now()

      db.prepare(
        `UPDATE note SET title = ?, type = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?`,
      ).run(title, type, newContent, JSON.stringify(tags), updatedAt, input.id)

      return {
        note: {
          ...existing,
          title,
          type,
          content: newContent,
          tags,
          updatedAt,
        },
        created: false,
        appended: !!input.append,
      }
    }

    const title = input.title?.trim()
    if (!title) throw new Error("title is required when creating a note")

    const id = crypto.randomUUID()
    const type = input.type ?? "note"
    const tags = normalizeTags(input.tags)
    const now = Date.now()

    db.prepare(
      `INSERT INTO note (id, session_id, type, title, content, tags, project_directory, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.sessionId, type, title, content, JSON.stringify(tags), input.projectDirectory ?? null, now, now)

    return {
      note: {
        id,
        sessionId: input.sessionId,
        type,
        title,
        content,
        tags,
        projectDirectory: input.projectDirectory ?? null,
        createdAt: now,
        updatedAt: now,
      },
      created: true,
      appended: false,
    }
  } finally {
    db.close()
  }
}

export function getNote(id: string, path: string = notesDbPath()): Note | null {
  const db = openNotesDB(path)
  try {
    const row = db.prepare(`SELECT * FROM note WHERE id = ?`).get(id) as NoteRow | undefined
    return row ? rowToNote(row) : null
  } finally {
    db.close()
  }
}

export type ListFilter = {
  sessionId?: string
  type?: NoteType
  projectDirectory?: string
  limit?: number
}

export function listNotes(filter: ListFilter, path: string = notesDbPath()): Note[] {
  const limit = clamp(filter.limit, 1, 100, 20)
  const where: string[] = []
  const params: SQLQueryBindings[] = []

  if (filter.sessionId) {
    where.push(`session_id = ?`)
    params.push(filter.sessionId)
  }
  if (filter.type) {
    where.push(`type = ?`)
    params.push(filter.type)
  }
  if (filter.projectDirectory) {
    where.push(`project_directory = ?`)
    params.push(filter.projectDirectory)
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
  const db = openNotesDB(path)
  try {
    const rows = db
      .prepare(`SELECT * FROM note ${whereSql} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit) as NoteRow[]
    return rows.map(rowToNote)
  } finally {
    db.close()
  }
}

export type SearchFilter = {
  query: string
  type?: NoteType
  sessionId?: string
  projectDirectory?: string
  tags?: string[]
  limit?: number
}

const SNIPPET_RADIUS = 120

function buildSnippet(content: string, query: string): string {
  const lower = content.toLowerCase()
  const idx = lower.indexOf(query.toLowerCase())
  const start = idx === -1 ? 0 : Math.max(0, idx - SNIPPET_RADIUS)
  const end =
    idx === -1
      ? Math.min(content.length, SNIPPET_RADIUS * 2)
      : Math.min(content.length, idx + query.length + SNIPPET_RADIUS)
  let snippet = content.slice(start, end).replace(/\s+/g, " ").trim()
  if (start > 0) snippet = "..." + snippet
  if (end < content.length) snippet = snippet + "..."
  return snippet
}

export function searchNotes(filter: SearchFilter, path: string = notesDbPath()): SearchMatch[] {
  const query = filter.query.trim()
  if (!query) throw new Error("query must not be empty")
  const limit = clamp(filter.limit, 1, 200, 25)

  const where: string[] = []
  const params: SQLQueryBindings[] = []

  const escaped = escapeLike(query)
  where.push(`(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')`)
  params.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`)

  if (filter.type) {
    where.push(`type = ?`)
    params.push(filter.type)
  }
  if (filter.sessionId) {
    where.push(`session_id = ?`)
    params.push(filter.sessionId)
  }
  if (filter.projectDirectory) {
    where.push(`project_directory = ?`)
    params.push(filter.projectDirectory)
  }
  if (filter.tags && filter.tags.length > 0) {
    const tagClauses: string[] = []
    for (const tag of filter.tags) {
      const t = String(tag).trim()
      if (!t) continue
      tagClauses.push(`tags LIKE ? ESCAPE '\\'`)
      params.push(`%${escapeLike(JSON.stringify(t)).slice(1, -1)}%`)
    }
    if (tagClauses.length > 0) where.push(`(${tagClauses.join(" OR ")})`)
  }

  const db = openNotesDB(path)
  try {
    const rows = db
      .prepare(`SELECT * FROM note WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit) as NoteRow[]
    return rows.map((row) => {
      const note = rowToNote(row)
      return { ...note, snippet: buildSnippet(note.content, query) }
    })
  } finally {
    db.close()
  }
}

export function deleteNote(id: string, path: string = notesDbPath()): Note | null {
  const db = openNotesDB(path)
  try {
    const row = db.prepare(`SELECT * FROM note WHERE id = ?`).get(id) as NoteRow | undefined
    if (!row) return null
    db.prepare(`DELETE FROM note WHERE id = ?`).run(id)
    return rowToNote(row)
  } finally {
    db.close()
  }
}

export function lookupSessionTitles(sessionIds: string[]): Record<string, string> {
  const ids = [...new Set(sessionIds)].filter((id) => typeof id === "string" && id.length > 0)
  if (ids.length === 0) return {}

  const db = openOpencodeDB()
  if (!db) return {}
  try {
    const placeholders = ids.map(() => `?`).join(`, `)
    const rows = db
      .prepare(`SELECT id, title FROM session WHERE id IN (${placeholders})`)
      .all(...ids) as { id: string; title: string | null }[]
    const out: Record<string, string> = {}
    for (const row of rows) {
      if (row.title) out[row.id] = row.title
    }
    return out
  } catch {
    return {}
  } finally {
    db.close()
  }
}
