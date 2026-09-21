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
const { transact, countUnpushed, isDirty, acquireLock, releaseLock, pushWithMergeFallback } = require('./sync.cjs');
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
// `takenAt` is set once, by `take` itself, and carried forward by every later `set`/`comment` on the same
// task — it is when the dashboard's "agent X has been on this since HH:MM" warning (#210) counts from, not
// when the state file was last touched (that's `updatedAt`).
function stampAfter(layout, id, marker, doc, takenAt = null) {
  const t = doc.byId.get(id);
  if (!t) return;
  const previous = readAgentState(layout, marker);
  const since = takenAt ?? (previous && previous.taskId === id ? previous.takenAt : null) ?? new Date().toISOString();
  writeAgentState(layout, marker, { taskId: id, hash: taskHash(t), snapshot: { data: t.data, comments: t.comments }, takenAt: since, updatedAt: new Date().toISOString() });
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
  if (outcome.applied) stampAfter(layout, id, marker, M.parse(readRegistryFiles(layout)), new Date().toISOString());
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
    message: () => `#${id} [commented]: ${text.replace(/[\r\n\0]+/g, ' ').slice(0, 60)}`,
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
  const lock = lockPath(layout);
  await acquireLock(lock, marker, log);
  try {
    if (isDirty(dataRoot)) {
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
    const result = pushWithMergeFallback(dataRoot, remote, branch, log, () => M.parse(readRegistryFiles(layout)));
    if (!result.pushed) return { applied: true, pushed: false, commit: gitOk(dataRoot, ['rev-parse', 'HEAD']).trim(), unpushedCount: result.unpushedCount };
    return { applied: true, pushed: true, commit: gitOk(dataRoot, ['rev-parse', 'HEAD']).trim() };
  } finally { releaseLock(lock); }
}

function driftOf(doc, state) {
  const t = doc.byId.get(state.taskId);
  if (!t) return { taskId: state.taskId, changes: ['task no longer exists (archived/removed?)'] };
  if (taskHash(t) !== state.hash) return { taskId: state.taskId, changes: describeDrift(state.snapshot, t) };
  return null;
}

async function status(layout, { marker = 'agent' } = {}) {
  const dataRoot = layout.dataRoot, { remote, branch } = layout.pointer;
  git(dataRoot, ['fetch', '-q', remote, branch]);
  const unpushed = countUnpushed(dataRoot, remote, branch);
  const state = readAgentState(layout, marker);
  const drift = state ? driftOf(M.parse(readRegistryFiles(layout)), state) : null;
  return { unpushed, dirty: isDirty(dataRoot), ownTask: state ? state.taskId : null, drift };
}

// Every agent-state file this machine/worktree has (there is normally one per marker, but nothing stops
// several) as `{marker, state}` — the shared iteration precommitCheck/liveAssignees both need.
function allAgentStates(layout) {
  const dir = path.join(agentStatePath(layout, '_'), '..');
  let files; try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try { out.push({ marker: file.slice(0, -'.json'.length), state: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) }); } catch { /* unreadable — skip */ }
  }
  return out;
}

// #209: the PreToolUse hook on `git commit` calls this — every local agent-state file gets checked,
// read-only, no fetch.
function precommitCheck(layout) {
  const doc = M.parse(readRegistryFiles(layout));
  const drifts = [];
  for (const { marker, state } of allAgentStates(layout)) {
    const drift = driftOf(doc, state);
    if (drift) drifts.push({ marker, ...drift });
  }
  return drifts;
}

// #210: which currently in_progress tasks this machine has local agent state for, and since when — the
// dashboard's "agent X has been on #NNN since HH:MM" warning. Only ever reflects *this* worktree's own
// `.trackfile/.agent/` — an assignee working from a different clone shows no warning, by design (there is
// nothing this machine could read to know about them).
function liveAssignees(layout) {
  const live = {};
  for (const { marker, state } of allAgentStates(layout)) {
    if (state && state.taskId && state.takenAt) live[state.taskId] = { marker, since: state.takenAt };
  }
  return live;
}

module.exports = { newTask, take, setField, comment, sync, status, precommitCheck, liveAssignees, StaleTaskError };
