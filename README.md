# Trackfile

**A simple task tracker for people and coding agents.** Tasks live as plain Markdown files in your Git repository, with a friendly local dashboard in the browser. There is no cloud account, database or build step.

Run these two commands in your project (requires Node.js 18+ and Git). The first creates the Trackfile files and asks which coding agents you use; the second opens the dashboard:

```sh
npx trackfile init
npx trackfile --open
```

Create tasks in the dashboard; each change is saved as a focused Git commit. You only need `git add` and `git commit` if you want to save and share the files created by `init` right away, so you can skip them for a first look. See the [full reference](docs/REFERENCE.md) for every command, option and multi-agent setup, or read the [agent protocol](skill/PROTOCOL.md).

![Trackfile dashboard](docs/screenshots/dashboard-milestones.png)

![Filtered task tree](docs/screenshots/task-tree-filtered.png)
