Trackfile is the task registry of this repository: `TRACKFILE.md` at the repository root (milestones, `next_task`, open and recently closed tasks), `.trackfile/archive.md` (closed tasks older than a week, same format) and `.trackfile/tasks/NNN/` (comments in `comments.md` plus attachments). The dashboard runs with `npx trackfile`; the table of contents for agents with `npx trackfile toc`. The rules below apply to every coding agent working in this repository (Claude Code, Codex, Cursor, Gemini CLI and others), for code, documentation, tests and configuration alike.

### No change without a task

- Before changing anything in the repository, name the task `### TASK NNN` you are working on and record it in `TRACKFILE.md` (see below). This covers every size of change, from a typo to a feature. Work started "without a task, I'll add one later" is a violation: stop and file the record first. State the task number in your first reply.
- Pick the task strictly in this order:
  1. The user named a number — work on it. If that record is cancelled/removed, do not resume it silently: say so and continue with steps 2–4.
  2. No number — read the registry by its table of contents, not in full: the front matter and the `## Milestones` section entirely; from `## Tasks` only one line per task (`npx trackfile toc`; without Node: `grep -A8 '^### TASK' TRACKFILE.md | grep -E '^(### TASK|title:|status:|parent:|milestone:)'`); the bodies only of candidate tasks. Closed tasks (`done`/`cancelled`/`removed`) and `.trackfile/archive.md` are not candidates — read them only when the user points to a number or asks for history. Find an existing task that matches the request unambiguously (the same result, not merely the same topic). Found one — state the number and start without asking. Several candidates — take the narrowest and name the alternatives in one line.
  3. No matching task — create one. Choose the milestone yourself: the one from `## Milestones` whose goal covers the request; the parent is the feature the work belongs to (or `null`). Do not ask the user which milestone to use — decide and justify it in one sentence.
  4. No milestone covers the request — add one: a `### MILESTONE Mxx` record with the next free number (at least two digits, never reused), a `title` and a short goal, at the end of `## Milestones`; then create the task in it. Do not stretch someone else's milestone with a "roughly fitting" task.
  A conversation, an answer to a question or reading code without changing the repository needs no task. Ask a clarifying question only when the request itself is unclear, never to decide where to file it.
- Before starting, re-read the chosen record in full, including every `#### COMMENT N [ ]` block in `.trackfile/tasks/NNN/comments.md` (no file — no comments): comments carry mandatory context and may be referenced as `#078.3`. When a comment's request is fully done, change its marker to `#### COMMENT N [x]` and update the comment's `updated_at`; leave it open when it is done only partially or needs the user's check. Mark a free task `status: "in_progress"`, put your marker in `assignee`, the real branch in `branch` (or `null` outside Git) and refresh `updated_at`. Never take over a task assigned to someone else without agreement. Announcing in chat does not replace the record in the file.

### Creating records

- A task ID is the permanent string from `next_task`, zero-padded to at least three digits; increment the counter. Set `author` to your marker, `created_at`, `updated_at`, `parent` and `milestone` (when any). Never renumber existing records or reuse deleted IDs. Create subtasks when the agreed scope needs them. Adding work under a completed feature — update its status/comment explicitly.
- Allocate the number as a compare-and-swap: right before inserting, re-read `TRACKFILE.md`, take the current `next_task` and include the old `next_task` line in the same atomic edit as its increment and the new record. If the context has changed meanwhile, drop the prepared number, re-read `next_task` and rebuild the edit. After writing, re-read the registry and check that the new `### TASK NNN` appears exactly once and `next_task` exceeds the highest ID. Never reserve a number in memory only or continue with a value read before other work.
- Record format (Markdown with a flat YAML block; strings in double quotes, arrays inline, dates ISO 8601 with a timezone offset):

  ````
  ### TASK 042
  ```yaml
  id: "042"
  title: "Task title"
  kind: "task"
  parent: "038"
  milestone: null
  status: "to-do"
  author: "Claude"
  assignee: null
  created_at: "2026-01-01T12:00:00+00:00"
  updated_at: "2026-01-01T12:00:00+00:00"
  completed_at: null
  branch: null
  commit: null
  result: ""
  sources: ["docs/design.md"]
  ```
  ````

  Then a blank line and the description in Markdown: what must change and how the result is verified. `#`, `##`, `###` are reserved for the structure — use `####` or plain text inside descriptions. New tasks go to the end of `## Tasks`.

### Fields

- `kind`: `feature` — a lasting capability or a group of tasks; `task` — concrete work with a verifiable result.
- `parent`: ID of the feature/task this record belongs to, or `null`. Cycles and missing parents are format errors.
- `milestone`: ID from `## Milestones` or `null`; `null` inherits the nearest ancestor's milestone. A milestone is planning metadata and may be changed in any status.
- `status`: `to-do` (not started), `in_progress` (taken; `assignee` required), `review` (finished, waiting for the user's acceptance), `done` (accepted by the user), `cancelled` / `removed` (closed without a result; excluded from progress with all descendants).
- `author`: who created the record — your agent marker (`Claude`, `Codex`, `Gemini`, …) or `User`. It is the author of the registry entry, never a claim about who implemented the work. Never rewrite another author's marker; the dashboard writes `User` when a person edits.
- `assignee`: who is doing the work now, or `null`. Set your marker when you take a task, keep it while the task is `in_progress`/`review`.
- `created_at`: when the record was created; never changed afterwards. `updated_at`: the last modification of the record; refresh it on every change. `completed_at`: when the task became `done`; `null` otherwise. All dates are ISO 8601 with a timezone offset.
- `branch`, `commit`: the real branch and an existing commit of the implementation, or `null`. Never a placeholder, never a guessed hash.
- `result`: what was done, how it was verified, what remains or is not covered. Written when the task moves to `review`; updated when the task is resumed.
- `sources`: repository-relative paths to the documents, code and tests that back the task's status and result (design docs, ADRs, specs, changed source files, tests). Every task that reaches `review` must have the evidence for its result in `sources`; when the status of an existing task rests on a document or code, add the path here rather than describing it in prose only. Markdown documents in this list carry back-link marks (see below). Only repository paths, never URLs.
- A record may carry extra fields a project defines (for example an import audit reference); keep them untouched.

### Who changes what

- An agent changes only the tasks it works on: its own new records and the task it took. Moving a task out of `review` (back to `to-do` or `in_progress`), reopening a `done` task, cancelling or removing a task, and changing another agent's task are the user's decisions: do it only when the user asks for it explicitly, and say so in `result`. A task the user put back to `to-do` with comments is picked up again through the comments, not by silently continuing the old work.
- `done` is set by the user, or by an agent after the user's explicit acceptance in this conversation, together with `completed_at` and the commit hash.
- Milestones are created by agents when no existing one covers the request (see above); renaming, reprioritising or deleting milestones and rewriting other people's descriptions is the user's call.

### Statuses, results, commits

- After every change to a task refresh `updated_at`. When finished, write a short `result`: what was done, how it was verified, what remains. `done` requires `completed_at`, the real branch and the commit hash if that commit already exists; otherwise `commit: null`. Never invent a hash and never commit just to fill the field. `review` means the result still needs the user's acceptance; `to-do` means not started.
- **Finishing work moves the task to `review`, not `done`, and creates no commit**: leave the changes in the working tree, write `result` and wait for the user to check the outcome and explicitly allow a commit and/or `done`. The commit rules below apply only after that permission; `done` without the user's explicit consent is not allowed. When resuming a task, clear the old `completed_at` and explain why in `result`. If a resumed record lives in `.trackfile/archive.md`, move it back to `TRACKFILE.md` (cut it out of the archive, drop `archived_at`, append it to the end of `## Tasks`) — an open task never stays in the archive; agents never move records into the archive, the dashboard does that.
- **The task number goes into the commit and into the code.** A commit is created only after the user's explicit permission. The commit subject starts with the numbers of every affected task (`#134 #135: …`); a commit without a task number is not created, just like a change without a task. The same number goes into the code: a changed or added block of logic gets a comment `// #NNN: why it is done this way` (in the project's style — the reason, not a paraphrase of the code; `# #NNN: …` or the language's own comment syntax where `//` does not exist); one comment per coherent change, not per line. Mechanical edits (renames, formatting) need no comment, but the number in the commit is mandatory for them too. After the commit, write its hash into the task's `commit` field.
- **Documents and tasks link both ways.** When changing documentation (docs, READMEs, ADRs, specs) within a known task, mark the changed or added paragraphs, list items or table rows with a link at the end of the line: `[#NNN](<relative path to>TRACKFILE.md#task-NNN)` (from `docs/` — `../TRACKFILE.md#task-NNN`). Several tasks — several links in a row; in a table row the mark goes inside the last cell; no marks inside code blocks. Both links are made at once, never "later": the document's path goes into the task's `sources`, the `#task-NNN` mark into the document. The same applies to code: changed files go into `sources` and the changed logic carries the `// #NNN:` comment. The dashboard's reader uses these marks to highlight every mention of a task, so an unmarked change is invisible to the next reader.

### Editing safely

- Before writing, re-read the registry, keep other people's changes and edit only the records you need. Agents and the dashboard share no transactional lock: never write the same file in parallel. On a conflict, stop and reconcile the current version.
- `.trackfile/config.json` holds only the dashboard's UI state of one person and is git-ignored. Do not edit it; statuses, milestones and results always go into `TRACKFILE.md`.
