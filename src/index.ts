import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import * as db from "./db"

const INDEX_CAP = 10
const MAX_CONTENT_CHARS = 100_000

const DISCIPLINE_DIRECTIVE = `You have persistent note tools — note_save, note_list, note_read, note_search, note_delete — backed by a SQLite store that survives context compaction and is searchable across sessions. Proactively save important context as you work: findings, decisions (with rationale), and evolving plans. Do not wait to be asked. Before exploring a topic, check for existing notes with note_search. Full guidance: load skill "session-notes".`

function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC"
}

function errorResult(operation: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return {
    title: `Error: ${operation} failed`,
    output: `${operation} failed: ${message}`,
    metadata: { error: true, message },
  }
}

function renderNotesIndex(notes: db.Note[]): string {
  const lines = notes.map(
    (n) => `- [${n.type}] ${n.title} (id: ${n.id}, updated ${fmtTs(n.updatedAt)})`,
  )
  return [
    `<session-notes>`,
    DISCIPLINE_DIRECTIVE,
    ``,
    `Recent notes in this session (newest first — load with note_read, extend with note_save using the id and append: true):`,
    ...lines,
    `</session-notes>`,
  ].join("\n")
}

function sessionLabel(sessionId: string, titles: Record<string, string>, currentId: string): string {
  const title = titles[sessionId] ?? "untitled session"
  const suffix = sessionId === currentId ? " (this session)" : ""
  return `${title}${suffix}`
}

const plugin: Plugin = async () => ({
  tool: {
    note_save: tool({
      description:
        "Create or update a persistent note. PROACTIVE USE: save important findings, decisions (with rationale), and evolving plans as you work — do not wait to be asked. Notes survive compaction and are searchable by any future session. Omit id to create a new note (returns its id). Provide id (from note_list, note_search, or the system-prompt session-notes index) to update: with append: true the content is added to the existing note (timestamped separator) — use this to evolve plans; without it the content replaces the existing note.",
      args: {
        content: tool.schema
          .string()
          .max(MAX_CONTENT_CHARS)
          .describe(
            "Markdown content. Findings: include the question/context that led to it. Decisions: rationale + alternatives considered. Plans: numbered steps with status.",
          ),
        title: tool.schema
          .string()
          .optional()
          .describe("Short descriptive title (required when creating; omit to keep the existing title on update)"),
        type: tool.schema
          .enum(["note", "plan", "finding", "decision"])
          .optional()
          .describe("Note type (default: note)"),
        tags: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe('Retrieval tags, e.g. ["auth", "migration"]'),
        id: tool.schema.string().optional().describe("Existing note id to update or append to"),
        append: tool.schema
          .boolean()
          .optional()
          .describe("Append content to the existing note instead of replacing (requires id)"),
      },
      async execute(args, context) {
        try {
          const result = db.saveNote({
            id: args.id,
            sessionId: context.sessionID,
            title: args.title,
            content: args.content,
            type: args.type,
            tags: args.tags,
            projectDirectory: context.directory,
            append: args.append,
          })
          const { note, created, appended } = result
          const verb = created ? "Created" : appended ? "Appended to" : "Updated"
          const lines = [
            `${verb} [${note.type}] "${note.title}"`,
            `- id: ${note.id}`,
            `- tags: ${note.tags.length > 0 ? note.tags.join(", ") : "(none)"}`,
            `- updated: ${fmtTs(note.updatedAt)}`,
          ]
          if (created) {
            lines.push(`- extend later with note_save using this id and append: true`)
          }
          return {
            title: `${verb} [${note.type}] ${note.title}`,
            output: lines.join("\n"),
            metadata: {
              id: note.id,
              type: note.type,
              title: note.title,
              created,
              appended,
              updatedAt: note.updatedAt,
            },
          }
        } catch (err) {
          return errorResult("note_save", err)
        }
      },
    }),

    note_list: tool({
      description:
        "List notes for a session (default: the current session), newest first. Each line shows type, title, id, and updated time — use the id with note_read to load full content, or note_save with append: true to extend. Filter by type or project_directory if needed.",
      args: {
        session_id: tool.schema.string().optional().describe("Session id (default: current session)"),
        type: tool.schema.enum(["note", "plan", "finding", "decision"]).optional(),
        project_directory: tool.schema.string().optional().describe("Filter by project directory"),
        limit: tool.schema.number().optional().describe("Max notes to return (default: 20, max: 100)"),
      },
      async execute(args, context) {
        try {
          const sessionId = args.session_id ?? context.sessionID
          const notes = db.listNotes({
            sessionId,
            type: args.type,
            projectDirectory: args.project_directory,
            limit: args.limit,
          })
          if (notes.length === 0) {
            return {
              title: "0 notes",
              output: "No notes found. Create one with note_save.",
              metadata: { count: 0 },
            }
          }
          const titles = db.lookupSessionTitles([...new Set(notes.map((n) => n.sessionId))])
          const lines = notes.map(
            (n) =>
              `- [${n.type}] ${n.title} — id: ${n.id} — updated ${fmtTs(n.updatedAt)} — session: ${sessionLabel(n.sessionId, titles, context.sessionID)}`,
          )
          return {
            title: `${notes.length} note(s)`,
            output: lines.join("\n"),
            metadata: { count: notes.length },
          }
        } catch (err) {
          return errorResult("note_list", err)
        }
      },
    }),

    note_read: tool({
      description:
        "Read a note's full content by id. Use to reload findings, decisions, or plans — especially after compaction, when ids are available from the system-prompt session-notes index or note_search.",
      args: {
        id: tool.schema.string().describe("Note id"),
      },
      async execute(args, context) {
        try {
          const note = db.getNote(args.id)
          if (!note) {
            return {
              title: "Note not found",
              output: `No note with id ${args.id}. Use note_list or note_search to find note ids.`,
              metadata: { error: true, notFound: true },
            }
          }
          const titles = db.lookupSessionTitles([note.sessionId])
          const header = [
            `## [${note.type}] ${note.title}`,
            ``,
            `- id: ${note.id}`,
            `- tags: ${note.tags.length > 0 ? note.tags.join(", ") : "(none)"}`,
            `- created: ${fmtTs(note.createdAt)}`,
            `- updated: ${fmtTs(note.updatedAt)}`,
            `- session: ${sessionLabel(note.sessionId, titles, context.sessionID)}`,
          ]
          if (note.projectDirectory) header.push(`- project: ${note.projectDirectory}`)
          return {
            title: `[${note.type}] ${note.title}`,
            output: header.join("\n") + "\n\n" + note.content,
            metadata: {
              id: note.id,
              type: note.type,
              title: note.title,
              updatedAt: note.updatedAt,
            },
          }
        } catch (err) {
          return errorResult("note_read", err)
        }
      },
    }),

    note_search: tool({
      description:
        "Search notes across ALL sessions (including past sessions) by title, content, or tags — use this when starting work on a topic to find prior findings, decisions, and plans before re-exploring. Filter by type, session_id, project_directory, or tags. Results show a snippet per match; use note_read with the id for full content.",
      args: {
        query: tool.schema.string().min(1).describe("Substring to match (case-insensitive)"),
        type: tool.schema.enum(["note", "plan", "finding", "decision"]).optional(),
        session_id: tool.schema.string().optional().describe("Restrict to one session"),
        project_directory: tool.schema.string().optional().describe("Restrict to one project directory"),
        tags: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Restrict to notes with any of these tags"),
        limit: tool.schema.number().optional().describe("Max notes to return (default: 25, max: 200)"),
      },
      async execute(args, context) {
        try {
          const matches = db.searchNotes({
            query: args.query,
            type: args.type,
            sessionId: args.session_id,
            projectDirectory: args.project_directory,
            tags: args.tags,
            limit: args.limit,
          })
          if (matches.length === 0) {
            return {
              title: `0 matches for "${args.query}"`,
              output: `No notes match "${args.query}".`,
              metadata: { count: 0, query: args.query },
            }
          }
          const titles = db.lookupSessionTitles([...new Set(matches.map((m) => m.sessionId))])
          const lines = matches.map(
            (m) =>
              `- [${m.type}] ${m.title} — id: ${m.id} — session: ${sessionLabel(m.sessionId, titles, context.sessionID)} — updated ${fmtTs(m.updatedAt)}\n  ${m.snippet}`,
          )
          return {
            title: `${matches.length} match(es) for "${args.query}"`,
            output: lines.join("\n"),
            metadata: { count: matches.length, query: args.query },
          }
        } catch (err) {
          return errorResult("note_search", err)
        }
      },
    }),

    note_delete: tool({
      description:
        "Delete a note by id. Permanent. Use only when a note is wrong or obsolete; prefer appending corrections otherwise.",
      args: {
        id: tool.schema.string().describe("Note id"),
      },
      async execute(args) {
        try {
          const note = db.deleteNote(args.id)
          if (!note) {
            return {
              title: "Note not found",
              output: `No note with id ${args.id}.`,
              metadata: { error: true, notFound: true },
            }
          }
          return {
            title: `Deleted [${note.type}] ${note.title}`,
            output: `Deleted [${note.type}] "${note.title}" (${note.id}).`,
            metadata: { id: note.id, deleted: true },
          }
        } catch (err) {
          return errorResult("note_delete", err)
        }
      },
    }),
  },

  "experimental.chat.system.transform": async (input, output) => {
    try {
      const sessionID = input?.sessionID
      if (!sessionID) return
      if (!Array.isArray(output?.system) || output.system.length === 0) return
      const notes = db.listNotes({ sessionId: sessionID, limit: INDEX_CAP })
      if (notes.length === 0) return
      output.system[output.system.length - 1] += "\n\n" + renderNotesIndex(notes)
    } catch {
      // fail-open: never break the request pipeline
    }
  },
})

export default { id: "session-notes", server: plugin } satisfies PluginModule
