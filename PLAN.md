# Plan: `opencode-session-notes`

A plugin + skill that gives opencode agents a self-serve persistence layer — proactively saving findings, decisions, and evolving plans during long exploratory sessions so important context survives compaction, and enabling cross-session search so future sessions can build on prior work.

**Status:** implemented and verified (v0.1.0, 2026-10-27)
**Repo:** `jflowers/opencode-session-notes`
**Runtime target:** opencode 1.x (`@opencode-ai/plugin@1.19.0`)

---

## 1. Motivation

In exploratory sessions that build toward a plan, important details get lost to compaction unless the user explicitly asks the agent to write a running report. The agent should do this **without being told** — every session, proactively.

Two failure modes to solve:

1. **Within-session loss** — compaction prunes discovered architecture, measured findings, and decision rationale mid-conversation.
2. **Cross-session loss** — a new session starts from zero even though a previous session already explored the same topic/project.

## 2. Architecture

Pattern proven by `opencode-session-search` + the `opencode-db` skill: **plugin supplies tools, skill teaches the agent when/how to use them proactively.** Three legs:

1. **Tools** (`src/index.ts`): 5 tools via the 1.x `tool()` helper; `export default { id: "session-notes", server } satisfies PluginModule`.
2. **Storage**: own SQLite db at `~/.local/share/opencode-session-notes/notes.db` — read-write, WAL mode, auto-migrated. Cross-reference to opencode's own `opencode.db` (read-only) for session titles in list/search results.
3. **Re-injection (two channels)**: an `experimental.chat.system.transform` hook appends a `<session-notes>` block (discipline directive + current-session recent-notes index) to the system prompt every turn — opportunistic, since delivery is gateway-dependent (see injection mechanics below). The primary channel is `experimental.session.compacting`: the same index is injected into the compaction prompt's context so **compaction summaries carry note ids** — in-conversation text, which demonstrably survives the gateway.

Zero new dependencies — `bun:sqlite` and `crypto.randomUUID()` are built into the runtime.

### Injection mechanics (critical design constraints)

- **Append to the last system element, never `push()`.** Pushed *secondary* system messages are dropped by the tested gateways (enmaas, OpenRouter) — proven at the model by the opencode-supervisor memo-drop investigation (glm-5-3/enmaas, claude-sonnet-5/OpenRouter; the request was verified correct through every local layer — the drop is in the gateway). The 2026-10-27 needle test (this repo) showed **append-to-last is not delivered at the model through enmaas either** — no `<session-notes>` block visible on any request after a mid-session save, and post-compaction no-tools recall of the note id failed. The system-prompt channel is therefore kept as an opportunistic secondary only (zero cost; honors gateways/credentials that pass system appends). Never `push()` regardless: pushing would also corrupt DCP's injection if this plugin ran before it, since DCP appends to the last element.
- **Guards:** try/catch fail-open (never break the request pipeline); `Array.isArray(output?.system)` + non-empty check; skip when `input.sessionID` is undefined; skip when the session has no notes (system prompt untouched).
- **Self-limiting:** the index is keyed by the current `sessionID` — subagent and internal sessions (title generator, summarizer) have their own ids with no notes, so nothing is injected into them.
- **Index spec:** current session only, ordered by `updated_at DESC` (evolving plans bump `updated_at`; `created_at` would misorder append flows), capped at 10, one line per note: `[type] title (id: …, updated …)`.
- **Skill autoinvoke is a non-feature** — on 1.x the frontmatter field is ignored entirely, and on v2 only `false` (hide from `<available_skills>`) does anything. The always-on channel is therefore the plugin's own hook; the skill stays listed by omitting `autoinvoke` and serves as on-demand deep guidance.

## 3. Database Schema

```sql
-- notes.db (WAL mode, read-write)
CREATE TABLE note (
  id            TEXT PRIMARY KEY,              -- uuid v4
  session_id    TEXT NOT NULL,                 -- from context.sessionID
  type          TEXT NOT NULL DEFAULT 'note',  -- 'note' | 'plan' | 'finding' | 'decision'
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,                 -- markdown
  tags          TEXT,                          -- JSON array: '["auth","api-design"]'
  project_directory TEXT,                      -- auto-captured from context.directory
  created_at    INTEGER NOT NULL,              -- epoch ms
  updated_at    INTEGER NOT NULL               -- epoch ms
);

CREATE INDEX idx_note_session ON note(session_id);
CREATE INDEX idx_note_type    ON note(type);
CREATE INDEX idx_note_created ON note(created_at);
CREATE INDEX idx_note_project ON note(project_directory);
```

- Migration: `CREATE TABLE IF NOT EXISTS` on every open (idempotent, µs-cheap), `PRAGMA user_version = 1`.
- DB and parent directory created lazily on first use (`mkdirSync({ recursive: true })`).

## 4. Tools

| Tool | Purpose | Key args |
|---|---|---|
| **`note_save`** | Create or update/append a note | `content`, `title?` (required when creating), `type?` (default `"note"`), `tags?`, `id?` (omit = create), `append?` |
| **`note_list`** | List notes for a session | `session_id?` (defaults to current), `type?`, `project_directory?`, `limit?` (default 20, max 100) |
| **`note_read`** | Read full content of one note | `id` |
| **`note_search`** | Search across all sessions | `query`, `type?`, `project_directory?`, `session_id?`, `tags?`, `limit?` (default 25, max 200) |
| **`note_delete`** | Remove a note | `id` |

**Semantics:**

- `note_save` auto-captures `session_id` from `context.sessionID` and `project_directory` from `context.directory`.
- Without `id`: create — `title` required, returns the generated `id` for later appends.
- With `id` + `append: true`: appends content with a `---` separator and `[Appended <timestamp>]` header; bumps `updated_at`; keeps `created_at`. Omitted `title`/`type`/`tags` keep their existing values.
- With `id`, no `append`: full content replacement; omitted fields keep existing values.
- With unknown `id`: error (no silent orphan creation).
- `note_list` / `note_search` results include the **session title**, looked up read-only from `opencode.db` (skipped gracefully if absent).
- `note_search` matches case-insensitive `LIKE` across `title`, `content`, and `tags` (LIKE wildcards escaped), ordered by `updated_at DESC`, with a ±120-char snippet per match.
- Content capped at 100,000 chars; tags normalized (trim, dedupe, max 20 × 64 chars).
- Return format: `{ title, output, metadata }` — counts/ids/timings in metadata (session-search conventions).
- Tool **descriptions embed behavioral policy** — `note_save` says "PROACTIVE USE: … do not wait to be asked"; `note_search` says to use it when starting work on a topic.

## 5. Skill: `session-notes`

**Location:** `.opencode/skills/session-notes/SKILL.md` in the repo, symlinked to `~/.config/opencode/skills/session-notes/` (single source of truth, same as `opencode-db`).

**Frontmatter:** `name: session-notes`, `opencode/slash: "true"` (human slash command). `autoinvoke` is deliberately **omitted** — the default keeps the skill listed in `<available_skills>` for on-demand loading; there is no always-inject frontmatter mechanism (see §2).

**Content:** when to save proactively (after discoveries, at decisions, as plans evolve, before context risk, before delegating, at checkpoints), when to retrieve (session start, before deep-dives, after compaction, when resuming), note-type guidance, content-structure best practices, tool reference, and the compaction story — the system-prompt index carries ids; append via `note_save` with `id` + `append: true`.

## 6. Repo Structure

```
opencode-session-notes/
├── package.json                  # @jflowers/opencode-session-notes; exports: {"./server": "./src/index.ts"}
├── tsconfig.json                 # ESNext, moduleResolution bundler, strict, types: ["bun"]
├── src/
│   ├── index.ts                  # plugin entry: 5 tools + system.transform hook
│   ├── db.ts                     # SQLite layer: open, migrate, CRUD, search, title lookup
│   └── db.test.ts                # bun:test suite (temp-dir DB; live opencode.db test skipIf absent)
├── .opencode/
│   ├── .gitignore                # ignores node_modules, package.json, lockfiles
│   ├── package.json              # @opencode-ai/plugin@1.19.0 (what opencode installs against)
│   └── skills/session-notes/SKILL.md
├── PLAN.md                       # this document
└── LICENSE                       # Apache-2.0
```

## 7. db.ts Design

Unlike session-search (strictly read-only), this plugin **writes**:

- `openNotesDB(path)`: read-write `Database`; `PRAGMA journal_mode=WAL`; `PRAGMA busy_timeout=5000`; idempotent migrate; per-call open/close (no held handles — WAL readers/writers coexist with any other process).
- `openOpencodeDB()`: separate read-only connection for session-title lookup, only opened when results need titles; returns `{}` on any failure.
- All SQL uses **prepared statements with bound parameters** — arbitrary SQL is never accepted from the model, so no `validateSql` guard is needed (unlike `db_query`).
- UUIDs via `crypto.randomUUID()`.
- `clamp(n, min, max, fallback)` for arg limits; `escapeLike()` for `%`/`_`/`\` in user queries and tags.
- Every function takes an explicit `path` parameter (defaulting to the real db) so tests run against a temp directory.

## 8. Testing

`src/db.test.ts` (bun:test) against a `mkdtempSync` temp DB:

- Create roundtrip (fields, tags, uuid shape), validation errors (missing title/content, unknown id)
- Append semantics (separator, timestamp header, `created_at` preserved, `updated_at` bumped)
- Update semantics (replace content, keep omitted fields)
- Tag normalization (trim, dedupe)
- `listNotes` filters (session, type, project), `updated_at DESC` ordering, limit
- `searchNotes` matches title/content/tags, snippet extraction, scoping, LIKE-wildcard escaping (`100%`, `50_`)
- `deleteNote` roundtrip; `clamp` bounds
- Migration idempotence across reopens
- Live `lookupSessionTitles` test against the real `opencode.db` (`skipIf` absent)

Verification: `bun x tsc --noEmit`, `bun test`, restart opencode, exercise each tool live, then a **needle test** — fresh session, confirm the model can use a note id from the system-prompt index without prior mention (verifies delivery *through the gateway at the model*, not just at the API boundary — the lesson from the supervisor memo-drop investigation).

**Needle test result (2026-10-27): FAILED for system-prompt delivery.** No `<session-notes>` block visible at the model on any request after a mid-session save; post-compaction no-tools recall of the note id failed (the id had been pruned from context; the index was the only remaining source). Conclusion: the enmaas gateway drops system-transform content for append-to-last as well as push, matching the supervisor's finding for push. Follow-ups shipped with this result: (1) debug instrumentation behind `SESSION_NOTES_DEBUG=1` — one JSON line per hook invocation in `~/.local/share/opencode-session-notes/debug.log` with states `appended` / `no-notes` / `no-session-id` / `no-system-array` / `no-context-array` / `error: …`; restart with the env var set, send a message, read the log to separate "hook fires locally, gateway drops it" from "hook never fires"; (2) `experimental.session.compacting` implemented as the primary delivery channel — **verified PASS (2026-10-27)**: instrumentation confirms the transform hook fires and appends on every request while the model sees nothing (gateway drop, not a local failure), and a manual `/compact` delivered end-to-end — the compacting hook fired (`session.compacting` → `contextElements: 1`), the generated summary carried both note ids in a preserve-verbatim section, and the summary became the top of the model's context.

## 9. Registration & Rollout

1. `/Users/jflowers/Projects/github/jflowers/opencode-session-notes` added to the `plugin` array in `~/.config/opencode/opencode.jsonc`.
2. Symlink `~/.config/opencode/skills/session-notes` → repo's `.opencode/skills/session-notes`.
3. Restart opencode (plugin code changes require restart; skills are hot).

## 10. Locked Decisions

| # | Decision |
|---|---|
| 1 | Note types: `note \| plan \| finding \| decision` |
| 2 | Cross-session search scoped by both `session_id` and `project_directory` |
| 3 | New repo under `jflowers/` (like `opencode-session-search`) |
| 4 | `note_save` supports append mode (in addition to full replace) |
| 5 | DCP integration is future work only |
| 6 | `note_list`/`note_search` results include session title (looked up from opencode.db) |
| 7 | Within-session re-surface: compaction-summary index via `experimental.session.compacting` (primary, in-conversation); `system.transform` append-to-last kept as opportunistic secondary (gateway-dependent, never push); skill keeps save discipline only |
| 8 | Recent-notes index is **current-session only** (cross-session needs served by `note_search` + skill retrieval triggers; project-wide index would add standing prompt noise) |

## 11. Future Work (not v1)

- **Compaction routing (answered 2026-10-27):** DCP-range compression (the `compress` tool) **bypasses** the native compacting hook — no `session.compacting` log lines during compress calls; native `/compact` fires it. Mitigated in global config: DCP `experimental.customPrompts` enabled, with an override at `~/.config/opencode/dcp-prompts/overrides/compress-range.md` adding a PERSISTENT CROSS-SESSION IDENTIFIERS section (durable ids copied verbatim into summaries) — the skill's compress discipline is now structural, not just behavioral.
- **FTS5 index** on note content if volume grows beyond what `LIKE` handles comfortably.
- **Note linking** — reference related notes from other notes.
- **Export** — dump notes to markdown files for external consumption.
- Rewrite session-search Gen 1 tools on direct SQL (carried over from that repo's PLAN.md).
