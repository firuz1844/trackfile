---
schema: 1
project: "{{PROJECT}}"
next_task: 1
---

# {{PROJECT}} — task registry

Single source of truth for milestones, features and tasks, shared by people and coding agents. Every record is a `### TASK NNN` / `### MILESTONE Mxx` heading followed by a flat YAML block; `next_task` is the monotonic counter of the next task number. The dashboard runs with `npx trackfile`; the rules for agents are installed next to this file (`npx trackfile init --agents …`).

## How to read statuses

- `to-do`: planned, or the implementation/verification was not found.
- `in_progress`: someone explicitly took the task; their marker is in `assignee`.
- `review`: the work is finished and waits for acceptance; not `done` yet.
- `done`: accepted; `completed_at`, `branch` and `commit` are filled when they exist.
- `cancelled` / `removed`: closed without a result; excluded from progress together with their subtasks.

## Milestones

### MILESTONE M01
```yaml
id: "M01"
title: "Backlog"
priority: "normal"
```

Tasks that are not yet planned into a specific milestone.

## Tasks
