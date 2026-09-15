# Trackfile

**Git-native task tracker for humans and coding agents.**
Tasks live in Markdown next to your code; every edit is a commit.

> **Status: placeholder.** This `0.0.x` release only reserves the package
> name. The tool itself is being extracted from a private project and is not
> published yet. Watch the repository for the first release:
> https://github.com/firuz1844/trackfile

## What Trackfile will be

- **Tasks in your repository.** Milestones, tasks, subtasks, comments and
  attachments are plain files under `PROJECT/`, versioned by Git. Diffs are
  readable, history is `git log`, conflicts are resolved like code.
- **One source of truth for people and AI agents.** A single `PROJECT.md`
  (Markdown with YAML front matter) plus a short protocol for coding agents
  (Claude Code, Codex, Cursor, …): no change without a task number,
  compare-and-swap ID allocation, task ↔ document back-links, `#NNN` in
  every commit subject.
- **A dashboard with no build step.** Static HTML and a dependency-free
  Node server bound to `127.0.0.1`: board and tree views, Markdown editor,
  source reader with uncommitted-change and task-mention highlighting,
  commit pages with diffs.
- **Every action is a commit.** Creating a task, commenting, editing —
  each becomes a focused commit like `#042 [new task]: …`, so agents and
  humans stay accountable to the same log.
- **Nothing leaves your machine.** No cloud, no database, no telemetry.

## Planned usage

```sh
npx trackfile        # start the dashboard in the current repository
```

Until the first release the command prints a notice and exits with code 1.

## License

MIT
