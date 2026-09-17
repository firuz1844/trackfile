/* Agent-facing CLI commands (#208): `new`, `take`, `set`, `comment`, `sync`, `status`. `new`/`take`/`set`/
 * `comment` are each a single transaction through the sync engine (#206) — no command reads-then-writes
 * across two separate git operations, so there's nothing for the engine's own retry/reconcile to race
 * against. `sync` is the one exception: it commits edits the agent already made *by hand* in the worktree,
 * which the engine's `transact()` refuses to run on top of (a dirty tree there means something else is
 * mid-write) — so it drives the same lock/commit/push machinery itself, and falls back to a real `git
 * merge` (using the driver from #207) rather than `transact`'s reset-and-reapply trick, since a hand-edit
 * isn't a replayable function the way `M.addTask` etc. are.
 *
 * Stale-context protection: `take` records a hash of the task (its fields plus its comments) in local,
 * git-ignored agent state (`.trackfile/.agent/<marker>.json`). Every later `set`/`comment` by that marker
 * re-fetches, hashes the *current* task, and compares — a mismatch means the user (or another agent)
 * changed something after `take`, and the command refuses with a description of what changed rather than
 * silently overwriting it. `--acknowledge` skips the check (the caller is asserting it already re-read the
 * task) and re-stamps the hash so the next command isn't blocked by the same diff.
 *
 * Deliberately doesn't call model.js's private per-field mutators beyond what it exports: `record` is the
 * same 3-line helper merge.cjs already needed for the same reason (no exported API for "replace this one
 * record's fields"), and every hand-built change is validated with the exported `apply` (which re-parses)
 * before it is ever handed to the sync engine, so an invalid edit fails before commit. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { transact, countUnpushed, isDirty, acquireLock, releaseLock } = require('./sync.cjs');
const { lockPath, agentStatePath, readRegistryFiles } = require('./layout.cjs');
const M = require('../app/assets/model.js');

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function gitOk(cwd, args, opts) { const r = git(cwd, args, opts); if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || `exit ${r.status}`}`); return r.stdout; }
const currentBranch = root => { const r = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']); return r.status === 0 ? r.stdout.trim() : null; };

const record = (type, data, body) => { const prose = (body || '').trim(); return `### ${type} ${data.id}\n\`\`\`yaml\n${M.dump(data)}\n\`\`\`\n\n` + (prose ? prose + '\n\n' : ''); };
function replaceTask(doc, t, data, body) {
  const changes = { [t.file]: doc.files[t.file].slice(0, t.start) + record('TASK', data, body) + doc.files[t.file].slice(t.end) };
  M.apply(doc, changes); // re-parses; throws on anything invalid before this ever reaches the sync engine
  return changes;
}

const taskHash = t => crypto.createHash('sha256').update(JSON.stringify({ data: t.data, body: t.body, comments: t.comments })).digest('hex');
function readAgentState(layout, marker) { try { return JSON.parse(fs.readFileSync(agentStatePath(layout, marker), 'utf8')); } catch { return null; } }
function writeAgentState(layout, marker, state) {
  const file = agentStatePath(layout, marker);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

class StaleTaskError extends Error {
  constructor(id, changes) { super(`trackfile: #${id} changed since you took it:\n${changes.map(c => `  - ${c}`).join('\n')}\nRe-read the task, then retry with --acknowledge if your write should still apply.`); this.id = id; this.changes = changes; }
}
function describeDrift(before, t) {
  const changes = [];
  for (const key of new Set([...Object.keys(before.data), ...Object.keys(t.data)])) {
    if (JSON.stringify(before.data[key]) !== JSON.stringify(t.data[key])) changes.push(`${key}: ${JSON.stringify(before.data[key])} → ${JSON.stringify(t.data[key])}`);
  }
  const beforeComments = before.comments?.length ?? 0, afterComments = t.comments?.length ?? 0;
  if (afterComments > beforeComments) changes.push(`${afterComments - beforeComments} new comment(s)`);
  else if (afterComments < beforeComments) changes.push(`comments: ${beforeComments} → ${afterComments}`);
  return changes;
}
// Throws StaleTaskError when the task drifted from what `marker` last saw and `acknowledge` wasn't passed;
// otherwise returns the current task record.
function checkFresh(layout, doc, id, marker, acknowledge) {
  const t = doc.byId.get(id);
  if (!t) throw new Error(`trackfile: #${id} not found.`);
  const state = readAgentState(layout, marker);
  if (state && state.taskId === id && !acknowledge && taskHash(t) !== state.hash) throw new StaleTaskError(id, describeDrift(state.snapshot, t));
  return t;
}
function stampAfter(layout, id, marker, doc) {
  const t = doc.byId.get(id);
  if (t) writeAgentState(layout, marker, { taskId: id, hash: taskHash(t), snapshot: { data: t.data, comments: t.comments }, updatedAt: new Date().toISOString() });
}

async function newTask(layout, { title, parent = null, milestone = null, body = '', marker = 'agent', log = () => {} }) {
  const outcome = await transact(layout, {
    change: doc => M.addTask(doc, { title, body, parent, milestone }),
    message: (doc, o) => `#${o.id} [new task]: ${title}`,
    mustPush: true, marker, log,
  });
  if (!outcome.applied) throw new Error('trackfile new: nothing to create.');
  return { id: outcome.result.id, commit: outcome.commit, pushed: outcome.pushed };
}

async function take(layout, id, { marker = 'agent', root = layout.root, log = () => {} }) {
  const branch = currentBranch(root);
  const outcome = await transact(layout, {
    change: doc => {
      const t = doc.byId.get(id);
      if (!t) throw new Error(`trackfile take: #${id} not found.`);
      if (t.status === 'in_progress' && t.assignee && t.assignee !== marker) throw new Error(`trackfile take: #${id} is already in_progress, assigned to ${t.assignee}.`);
      const data = { ...t.data, status: 'in_progress', assignee: marker, branch: branch ?? t.branch, updated_at: new Date().toISOString() };
      return replaceTask(doc, t, data, t.body);
    },
    message: () => `#${id} [take]: ${marker}`,
    marker, log,
  });
  if (outcome.applied) stampAfter(layout, id, marker, M.parse(readRegistryFiles(layout)));
  return outcome;
}

const ARRAY_FIELDS = new Set(['labels', 'blocked_by', 'relates_to', 'sources']);
async function setField(layout, id, field, rawValue, { marker = 'agent', acknowledge = false, log = () => {} }) {
  const value = rawValue === 'null' ? null : ARRAY_FIELDS.has(field) ? (rawValue ? rawValue.split(',').map(s => s.trim()).filter(Boolean) : []) : rawValue;
  const outcome = await transact(layout, {
    change: doc => {
      const t = checkFresh(layout, doc, id, marker, acknowledge);
      const data = { ...t.data, [field]: value, updated_at: new Date().toISOString() };
      if (field === 'status' && value === 'done') data.completed_at = new Date().toISOString();
      return replaceTask(doc, t, data, t.body);
    },
    message: () => `#${id} [set ${field}]: ${String(value)}`,
    marker, log,
  });
  if (outcome.applied) stampAfter(layout, id, marker, M.parse(readRegistryFiles(layout)));
  return outcome;
}

async function comment(layout, id, text, { marker = 'agent', acknowledge = false, log = () => {} }) {
  const outcome = await transact(layout, {
    change: doc => { checkFresh(layout, doc, id, marker, acknowledge); return M.addComment(doc, id, text, marker); },
    message: () => `#${id} [commented]: ${text.slice(0, 60)}`,
    marker, log,
  });
  if (outcome.applied) stampAfter(layout, id, marker, M.parse(readRegistryFiles(layout)));
  return outcome;
}

// Maps a dirty git-status path back to the model's logical file name, or null for anything this command
// doesn't handle (an attachment, say) — left for the caller to commit some other way.
function logicalNameOf(layout, rel) {
  if (rel === layout.registry) return M.REGISTRY;
  if (rel === layout.archive) return M.ARCHIVE;
  const m = new RegExp(`^${layout.tasks.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\d{3,})/comments\\.md$`).exec(rel);
  return m ? M.commentsFile(m[1]) : null;
}

/* `trackfile sync`: commits and pushes registry/archive/comments edits the agent (or a person) made
 * directly in the worktree, through the same validation as every other command. Unlike `transact()`, a
 * dirty tree is exactly what this expects to find, so it isn't built on top of it: lock, validate, commit,
 * fetch, push — and if the push is rejected because the remote moved, an actual `git merge` (driven by
 * #207's registered merge driver) reconciles the just-made commit against the new tip, since a hand-edit
 * has no `change(doc)` function to simply re-run the way the other commands do. */
async function sync(layout, { marker = 'agent', log = () => {} }) {
  const dataRoot = layout.dataRoot, { remote, branch } = layout.pointer;
  const dirtyBefore = isDirty(dataRoot);
  if (!dirtyBefore && countUnpushed(dataRoot, remote, branch) === 0) return { applied: false, clean: true };
  const lock = lockPath(layout);
  await acquireLock(lock, marker, log);
  try {
    if (dirtyBefore) {
      const dirty = gitOk(dataRoot, ['status', '--porcelain']).split('\n').filter(Boolean).map(l => l.slice(3));
      const relevant = dirty.filter(rel => logicalNameOf(layout, rel) !== null);
      if (!relevant.length) throw new Error('trackfile sync: no registry/archive/comments changes to send (other dirty files are left for you to commit yourself).');
      const merged = { ...readRegistryFiles(layout) };
      for (const rel of relevant) {
        const abs = path.join(dataRoot, rel);
        merged[logicalNameOf(layout, rel)] = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      }
      M.parse(merged); // validate before committing anything
      gitOk(dataRoot, ['add', '-A', '--', ...relevant]);
      gitOk(dataRoot, ['commit', '-q', '-m', `[sync]: manual edits by ${marker}`, '--', ...relevant]);
    }
    // No new commit of our own this time, but a still-unpushed one from an earlier, remote-unreachable
    // transaction: `trackfile sync` is exactly the command whose job is to send that tail along.

    const fetched = git(dataRoot, ['fetch', '-q', remote, branch]).status === 0;
    if (!fetched) return { applied: true, pushed: false, commit: gitOk(dataRoot, ['rev-parse', 'HEAD']).trim(), unpushedCount: countUnpushed(dataRoot, remote, branch) };

    let pushed = git(dataRoot, ['push', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
    if (pushed.status !== 0) {
      log('trackfile sync: push rejected, merging the remote tip in (using the trackfile-merge driver)...');
      const merge = git(dataRoot, ['merge', '-q', '--no-edit', `${remote}/${branch}`]);
      if (merge.status !== 0) throw new Error(`trackfile sync: push was rejected and the automatic merge failed — resolve by hand in ${dataRoot}:\n${merge.stderr.trim() || merge.stdout.trim()}`);
      pushed = git(dataRoot, ['push', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
      if (pushed.status !== 0) throw new Error(`trackfile sync: push still failing after merging: ${pushed.stderr.trim()}`);
    }
    return { applied: true, pushed: true, commit: gitOk(dataRoot, ['rev-parse', 'HEAD']).trim() };
  } finally { releaseLock(lock); }
}

async function status(layout, { marker = 'agent' } = {}) {
  const dataRoot = layout.dataRoot, { remote, branch } = layout.pointer;
  git(dataRoot, ['fetch', '-q', remote, branch]);
  const unpushed = countUnpushed(dataRoot, remote, branch);
  const state = readAgentState(layout, marker);
  let drift = null;
  if (state) {
    const doc = M.parse(readRegistryFiles(layout));
    const t = doc.byId.get(state.taskId);
    if (!t) drift = { taskId: state.taskId, changes: ['task no longer exists (archived/removed?)'] };
    else if (taskHash(t) !== state.hash) drift = { taskId: state.taskId, changes: describeDrift(state.snapshot, t) };
  }
  return { unpushed, dirty: isDirty(dataRoot), ownTask: state ? state.taskId : null, drift };
}

module.exports = { newTask, take, setField, comment, sync, status, StaleTaskError };
