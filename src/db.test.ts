import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import * as db from "./db"

let tmpDir: string
let path: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "session-notes-test-"))
  path = join(tmpDir, "notes.db")
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeInput(overrides: Partial<db.SaveInput> = {}): db.SaveInput {
  return {
    sessionId: "ses_test",
    title: "Test note",
    content: "Some content",
    ...overrides,
  }
}

describe("saveNote", () => {
  test("creates a note with all fields", () => {
    const { note, created, appended } = db.saveNote(
      makeInput({ type: "finding", tags: ["auth", "api"], projectDirectory: "/tmp/proj" }),
      path,
    )
    expect(created).toBe(true)
    expect(appended).toBe(false)
    expect(note.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(note.type).toBe("finding")
    expect(note.title).toBe("Test note")
    expect(note.tags).toEqual(["auth", "api"])
    expect(note.projectDirectory).toBe("/tmp/proj")
    expect(note.createdAt).toBe(note.updatedAt)
  })

  test("requires a title when creating", () => {
    expect(() => db.saveNote(makeInput({ title: undefined }), path)).toThrow(/title/)
  })

  test("requires content", () => {
    expect(() => db.saveNote(makeInput({ content: "" }), path)).toThrow(/content/)
  })

  test("normalizes tags (trim, dedupe, cap)", () => {
    const { note } = db.saveNote(
      makeInput({ tags: [" auth ", "auth", "", "  x  "] }),
      path,
    )
    expect(note.tags).toEqual(["auth", "x"])
  })

  test("update replaces content and keeps omitted fields", () => {
    const { note } = db.saveNote(
      makeInput({ type: "decision", tags: ["d1"], title: "Original" }),
      path,
    )
    const updated = db.saveNote(
      makeInput({ id: note.id, content: "Replaced content", title: undefined }),
      path,
    )
    expect(updated.created).toBe(false)
    expect(updated.appended).toBe(false)
    expect(updated.note.content).toBe("Replaced content")
    expect(updated.note.title).toBe("Original")
    expect(updated.note.type).toBe("decision")
    expect(updated.note.tags).toEqual(["d1"])
    expect(updated.note.updatedAt).toBeGreaterThanOrEqual(note.updatedAt)
  })

  test("append adds separator and timestamp header, keeps created_at", async () => {
    const { note } = db.saveNote(makeInput({ content: "First part" }), path)
    await Bun.sleep(3)
    const appended = db.saveNote(
      makeInput({ id: note.id, content: "Second part", title: undefined, append: true }),
      path,
    )
    expect(appended.appended).toBe(true)
    expect(appended.note.content).toContain("First part")
    expect(appended.note.content).toContain("---")
    expect(appended.note.content).toMatch(/\[Appended .+ UTC\]/)
    expect(appended.note.content).toContain("Second part")
    expect(appended.note.createdAt).toBe(note.createdAt)
    expect(appended.note.updatedAt).toBeGreaterThan(note.updatedAt)
  })

  test("updating an unknown id throws", () => {
    expect(() => db.saveNote(makeInput({ id: "nope" }), path)).toThrow(/not found/)
    expect(() => db.saveNote(makeInput({ id: "nope", append: true }), path)).toThrow(/not found/)
  })

  test("migration is idempotent across reopens", () => {
    const before = db.listNotes({ sessionId: "ses_test" }, path)
    expect(before.length).toBeGreaterThan(0)
    const again = db.listNotes({ sessionId: "ses_test" }, path)
    expect(again.length).toBe(before.length)
  })
})

describe("listNotes", () => {
  test("filters by session, type, project; orders newest first; limits", async () => {
    db.saveNote(makeInput({ sessionId: "ses_a", title: "A1", content: "x" }), path)
    await Bun.sleep(3)
    db.saveNote(
      makeInput({ sessionId: "ses_a", title: "A2", type: "plan", content: "x", projectDirectory: "/p1" }),
      path,
    )
    await Bun.sleep(3)
    db.saveNote(makeInput({ sessionId: "ses_b", title: "B1", content: "x" }), path)

    const a = db.listNotes({ sessionId: "ses_a" }, path)
    expect(a.map((n) => n.title)).toEqual(["A2", "A1"])

    const plans = db.listNotes({ sessionId: "ses_a", type: "plan" }, path)
    expect(plans.map((n) => n.title)).toEqual(["A2"])

    const inProject = db.listNotes({ projectDirectory: "/p1" }, path)
    expect(inProject.map((n) => n.title)).toEqual(["A2"])

    const limited = db.listNotes({ sessionId: "ses_a", limit: 1 }, path)
    expect(limited.map((n) => n.title)).toEqual(["A2"])

    const all = db.listNotes({}, path)
    expect(all.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].updatedAt).toBeGreaterThanOrEqual(all[i].updatedAt)
    }
  })
})

describe("searchNotes", () => {
  test("matches title, content, and tags with snippets", () => {
    db.saveNote(
      makeInput({
        sessionId: "ses_s",
        title: "OAuth token refresh",
        content: "The gateway refreshes tokens every 15 minutes via the NEEDLE endpoint.",
        tags: ["auth"],
      }),
      path,
    )
    db.saveNote(
      makeInput({ sessionId: "ses_s", title: "Unrelated", content: "nothing here", tags: ["migration"] }),
      path,
    )

    const byTitle = db.searchNotes({ query: "OAuth" }, path)
    expect(byTitle.length).toBe(1)
    expect(byTitle[0].title).toBe("OAuth token refresh")

    const byContent = db.searchNotes({ query: "needle" }, path)
    expect(byContent.length).toBe(1)
    expect(byContent[0].snippet).toContain("NEEDLE")

    const byTag = db.searchNotes({ query: "migration" }, path)
    expect(byTag.length).toBe(1)
    expect(byTag[0].title).toBe("Unrelated")

    const none = db.searchNotes({ query: "zzz-no-match" }, path)
    expect(none.length).toBe(0)
  })

  test("escapes LIKE wildcards in query", () => {
    db.saveNote(makeInput({ sessionId: "ses_w", title: "Progress", content: "100% done and 50_ units" }), path)
    expect(db.searchNotes({ query: "100%" }, path).length).toBe(1)
    expect(db.searchNotes({ query: "50_" }, path).length).toBe(1)
    expect(db.searchNotes({ query: "0% d" }, path).length).toBe(1)
  })

  test("scopes by session, type, project, and tags", () => {
    db.saveNote(
      makeInput({
        sessionId: "ses_scoped",
        title: "Scoped finding",
        type: "finding",
        content: "shared keyword",
        tags: ["infra"],
        projectDirectory: "/p2",
      }),
      path,
    )
    db.saveNote(
      makeInput({ sessionId: "ses_other", title: "Other finding", type: "finding", content: "shared keyword" }),
      path,
    )

    expect(db.searchNotes({ query: "shared", sessionId: "ses_scoped" }, path).length).toBe(1)
    expect(db.searchNotes({ query: "shared", projectDirectory: "/p2" }, path).length).toBe(1)
    expect(db.searchNotes({ query: "shared", tags: ["infra"] }, path).length).toBe(1)
    expect(db.searchNotes({ query: "shared", type: "finding" }, path).length).toBe(2)
  })

  test("rejects empty query", () => {
    expect(() => db.searchNotes({ query: "  " }, path)).toThrow(/empty/)
  })
})

describe("deleteNote", () => {
  test("deletes and reports unknown ids", () => {
    const { note } = db.saveNote(makeInput({ sessionId: "ses_del" }), path)
    const deleted = db.deleteNote(note.id, path)
    expect(deleted?.id).toBe(note.id)
    expect(db.getNote(note.id, path)).toBeNull()
    expect(db.deleteNote(note.id, path)).toBeNull()
  })
})

describe("clamp", () => {
  test("clamps and falls back", () => {
    expect(db.clamp(undefined, 1, 10, 5)).toBe(5)
    expect(db.clamp(0, 1, 10, 5)).toBe(1)
    expect(db.clamp(99, 1, 10, 5)).toBe(10)
    expect(db.clamp(7.9, 1, 10, 5)).toBe(7)
    expect(db.clamp(Number.NaN, 1, 10, 5)).toBe(5)
  })
})

describe("lookupSessionTitles", () => {
  test("empty input returns empty map", () => {
    expect(db.lookupSessionTitles([])).toEqual({})
  })

  const dbExists = existsSync(db.opencodeDbPath())
  test.skipIf(!dbExists)("looks up real session titles from opencode.db", () => {
    const ocdb = new Database(db.opencodeDbPath(), { readonly: true })
    const row = ocdb
      .prepare(`SELECT id, title FROM session WHERE title IS NOT NULL AND title != '' LIMIT 1`)
      .get() as { id: string; title: string } | undefined
    ocdb.close()
    if (!row) return
    const titles = db.lookupSessionTitles([row.id])
    expect(titles[row.id]).toBe(row.title)
  })
})
