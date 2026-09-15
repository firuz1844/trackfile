# Changelog

## 0.1.0 — first release

- `TRACKFILE.md` + `.trackfile/` layout, discovered upwards from the current directory; secondary paths configurable in the front matter, the registry name with `--registry`.
- `trackfile` (dashboard), `trackfile init` (registry, `.gitignore`, agent rules for Claude Code, Codex, Cursor, Gemini CLI, Zed, OpenCode, Jules; `--global`, `--force`, `--dry-run`), `trackfile toc`.
- Agent protocol as a single source (`skill/PROTOCOL.md`) installed as a Claude Code skill, an `AGENTS.md`/`GEMINI.md` block or a Cursor rule.
- Dashboard served only through the local server (the File System Access / `file://` mode is gone); English and Russian UI with a persistent switch; localized model and server errors.
- Tests on synthetic registries; Playwright end-to-end test against the server on a throwaway repository.

## 0.0.1

- Placeholder reserving the package name.
