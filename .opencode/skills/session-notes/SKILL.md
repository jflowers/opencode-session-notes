---
name: session-notes
description: Proactive note-taking and plan-building with persistent, cross-session-searchable notes. Use when working on tasks where findings, decisions, or plans should be preserved — the note tools (note_save, note_list, note_read, note_search, note_delete) survive compaction and are shared across sessions. Load this skill for when and how to capture context effectively.
metadata:
  opencode/slash: "true"
---

# Session Notes

You have persistent note tools backed by a local SQLite store (`~/.local/share/opencode-session-notes/notes.db`). Notes survive context compaction and are searchable by any future session, on any project. The system prompt carries a `<session-notes>` block listing this session's recent notes so their ids stay available even after compaction.

## When to save — proactively, without being asked

- **After discovering something** — architecture, file locations, patterns, non-obvious behavior, measured results. Capture it as a `finding` before moving on.
- **When making a design decision** — record the choice, the rationale, and the alternatives considered as a `decision`. Future sessions (including future you after compaction) need the *why*, not just the *what*.
- **When a plan forms or evolves** — record it as a `plan` with numbered steps and status. Extend it with `note_save` + the note's `id` + `append: true` as work progresses; never rewrite history.
- **Before context is at risk** — long exploration, heavy tool output, or a topic switch coming up: save the current state of understanding first.
- **Before delegating to subagents** — save the context they will need, and save their key results when they return.
- **At natural checkpoints** — tests green, milestone reached, blocker identified.

Do not wait to be asked. The cost of a note is one tool call; the cost of a lost finding is redoing the exploration.

## When to retrieve

- **At session start**, before exploring a topic: `note_search` with the key terms. Prior sessions may already have findings, decisions, or plans.
- **Before deep-diving** into an area: check whether it was already covered.
- **After compaction**: the system prompt's `<session-notes>` block lists recent notes with ids — `note_read` any you need, and `note_save` with `id` + `append: true` to continue evolving them.
- **When resuming** a topic in a new session: search, read the plan, continue from where it left off.

## Note types

| Type | Use for | Key content |
|---|---|---|
| `finding` | Technical discoveries | The question asked, the answer, file paths, measured values |
| `decision` | Choices made | The choice, rationale, alternatives considered |
| `plan` | Evolving work plans | Numbered steps with status; append as work progresses |
| `note` | Everything else | Anything worth keeping |

## Writing good notes

- **Title**: short and searchable — future searches match title, content, and tags.
- **Content**: include the question/context that led to the result, not just the result. File paths as absolute paths. Markdown.
- **Tags**: 2-5 retrieval tags, e.g. `["auth", "migration"]`. Filter searches with them.
- **Plans**: numbered steps with status (`[x]` done, `[ ]` todo), decisions called out inline. Append updates — don't replace.

## Tool reference

| Tool | Purpose |
|---|---|
| `note_save` | Create (omit `id`) or update/append (with `id`; `append: true` extends) |
| `note_list` | List notes for a session (default: current), newest first |
| `note_read` | Full content of one note by `id` |
| `note_search` | Search across **all** sessions by text/tags; filter by `type`, `session_id`, `project_directory`, `tags` |
| `note_delete` | Permanent removal — prefer appending corrections instead |

`session_id` and `project_directory` are captured automatically on save, so notes are scoping-aware for free.

## Workflow example

1. Session starts on a familiar topic → `note_search({ query: "oauth token refresh" })`
2. Prior `plan` found → `note_read` it, continue the steps
3. New discovery made → `note_save({ type: "finding", title: "...", content: "...", tags: [...] })` — keep the returned `id`
4. Design choice made → `note_save({ type: "decision", ... })`
5. Plan progresses → `note_save({ id: <plan id>, content: "step 3 done: ...", append: true })`
6. Compaction happens → ids still in the system-prompt index → keep appending
