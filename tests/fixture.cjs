/* Synthetic registry for tests: no real project data, just enough structure to exercise every rule.
 * Dates are far in the past so archive checks can use fixed "now" values. */
'use strict';
const task = (id, title, extra = {}, body = '') => {
  const data = { id, title, kind: 'task', parent: null, milestone: null, status: 'to-do', author: 'User', assignee: null, created_at: '2025-01-01T10:00:00+00:00', updated_at: '2025-01-02T10:00:00+00:00', completed_at: null, branch: null, commit: null, result: '', sources: [], ...extra };
  const yaml = Object.entries(data).map(([k, v]) => `${k}: ${Array.isArray(v) ? '[' + v.map(x => JSON.stringify(x)).join(', ') + ']' : JSON.stringify(v)}`).join('\n');
  return `### TASK ${id}\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n${body ? body + '\n\n' : ''}`;
};
const registry = () => `---
schema: 1
project: "Sample"
next_task: 11
---

# Sample — task registry

Intro paragraph.

## Milestones

### MILESTONE M01
\`\`\`yaml
id: "M01"
title: "First milestone"
priority: "normal"
\`\`\`

Goal of the first milestone.

### MILESTONE M02
\`\`\`yaml
id: "M02"
title: "Second milestone"
\`\`\`

## Labels

### LABEL L01
\`\`\`yaml
id: "L01"
title: "Bug"
color: "#ef4444"
\`\`\`

### LABEL L02
\`\`\`yaml
id: "L02"
title: "Docs"
color: "#3b82f6"
\`\`\`

## Tasks

${task('001', 'Feature one', { kind: 'feature', milestone: 'M01' }, 'A feature with subtasks.')}${task('002', 'Free subtask', { parent: '001', sources: ['docs/design.md', 'src/app.js'], labels: ['L01'] }, 'Description of the free task.\n\n#### Check\n- item one')}${task('003', 'Done subtask', { parent: '001', status: 'done', author: 'Codex', completed_at: '2025-01-03T10:00:00+00:00', branch: 'main', commit: 'abc1234', result: 'Verified by tests.' })}${task('004', 'Removed subtask', { parent: '001', status: 'removed' })}${task('005', 'Task in review', { milestone: 'M02', status: 'review', assignee: 'Claude', blocked_by: ['006'] })}${task('006', 'Task in progress', { milestone: 'M02', status: 'in_progress', assignee: 'Codex' })}${task('007', 'Root task without milestone', { relates_to: ['008'] }, 'Mentions virtualization of long lists.')}${task('008', 'Old closed task', { milestone: 'M01', status: 'done', completed_at: '2025-01-05T10:00:00+00:00' })}${task('009', 'Done feature with open child', { kind: 'feature', milestone: 'M02', status: 'done', completed_at: '2025-01-05T10:00:00+00:00' })}${task('010', 'Open child of done feature', { parent: '009' })}`;
const comments = () => `#### COMMENT 1 [ ]
\`\`\`yaml
id: 1
author: "User"
updated_at: "2025-01-04T10:00:00+00:00"
\`\`\`

Take this into account, see #2.1.
`;
const files = () => ({ registry: registry(), 'comments/002': comments() });
module.exports = { registry, comments, files, task };
