# Changelog

## Unreleased

- Task dependencies: `blocked_by` (Finish-Start blocking, with a "blocked" warning chip and cycle detection) and `relates_to` (non-blocking link), editable at any status through a "Relationships" dialog — a search filter, a Blocked by/Blocking/Relates to switch (a task that would directly block one already blocking it is disabled), and explicit Save/Cancel. The task page lists all three with a trash icon per entry to drop one link directly.
- Colored labels (`### LABEL Lxx` records, preset palette or a custom color), seeded with a default set (bug, enhancement, documentation, question, wontfix) on `trackfile init`, and the first time the dashboard's "Labels" or "Manage labels" dialog is opened on an older registry that has no `## Labels` section yet. Assigned per task through a searchable "Labels" dialog with an inline "Create label" row; a "Manage labels" dialog (reachable from there or from a new sidebar Settings menu) lists every label with edit/delete, delete warning how many tasks lose it.
- A new "Relationship diagram" sidebar page: parent/child, blocking and "relates to" links as a small SVG graph, centered on a task or the whole registry, with a status filter, edge-type toggles and a node cap (dim or hide).
- A task's own labels now show in a dedicated, wrapping "Labels" row right under its title (small pill chips, `border-radius:999px`), separate from the status/archive/blocked badges; compact rows (tree, recent changes, subtasks) keep them inline as before.
- The task tree filters gained a labels filter and, behind a "More" toggle, record author and assignee filters, all multi-select like the existing status filter.
- Manual archive now offers to sweep a finished task's own done/cancelled/removed subtasks into the archive along with it, instead of silently leaving them behind in the registry.
- The auto-archive cutoff (previously a fixed week) is now a project-wide setting (`archive_after_days` in the registry's front matter), editable from a new "Auto-archive" dialog under Settings.
- Model, i18n and layout tests for all of the above.

## [0.2.0](https://github.com/firuz1844/trackfile/compare/trackfile-v0.1.1...trackfile-v0.2.0) (2026-09-17)


### Features

* Labels UI overhaul, unified filter bar, sidebar polish, archiving ([7bd2c60](https://github.com/firuz1844/trackfile/commit/7bd2c60f19423a1b936a65898914b3f1b3f2619a))

## 0.1.1

- Protocol: field semantics (`author` is the record's author, `created_at` never changes, `sources` as mandatory evidence for a `review` result), "who changes what" (leaving `review`, reopening, cancelling and other people's tasks are the user's decisions), back-links extended to code.
- `trackfile init --force` reinstalls agent rules even at the same version.

## 0.1.0 — first release

- `TRACKFILE.md` + `.trackfile/` layout, discovered upwards from the current directory; secondary paths configurable in the front matter, the registry name with `--registry`.
- `trackfile` (dashboard), `trackfile init` (registry, `.gitignore`, agent rules for Claude Code, Codex, Cursor, Gemini CLI, Zed, OpenCode, Jules; `--global`, `--force`, `--dry-run`), `trackfile toc`.
- Agent protocol as a single source (`skill/PROTOCOL.md`) installed as a Claude Code skill, an `AGENTS.md`/`GEMINI.md` block or a Cursor rule.
- Dashboard served only through the local server (the File System Access / `file://` mode is gone); English and Russian UI with a persistent switch; localized model and server errors.
- Tests on synthetic registries; Playwright end-to-end test against the server on a throwaway repository.

## 0.0.1

- Placeholder reserving the package name.
