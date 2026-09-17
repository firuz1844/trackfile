/* Sync engine (#206) for shared-branch mode: the single place that turns a registry mutation into a
 * transaction against the data branch — lock, fetch, reconcile with the remote, apply, commit, push
 * `--force-with-lease`, retry on a lost race. `lib/init.cjs`/`migrate.cjs` touch git directly because they
 * run before shared mode exists or move data between branches; every ordinary registry edit once shared
 * mode is on (CLI commands from #208, the dashboard from #210) goes through `transact` instead.
 *
 * A transaction's `change(doc)` gets the current registry parsed fresh on every attempt — including every
 * retry — so a mutation that reads `doc.meta.next_task` (like `M.addTask`) naturally gets the right answer
 * even when a concurrent transaction won the race in between: no separate "merge my edit onto theirs" step
 * is needed for *this* transaction's own change, only for reconciling an *earlier* transaction's commit
 * that is still queued (unpushed) when the remote has meanwhile diverged from it — that case has no safe
 * generic resolution without #207's structural merge, so it fails clearly instead of guessing. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { lockPath, diskPath, relativeOf, readRegistryFiles } = require('./layout.cjs');
const M = require('../app/assets/model.js');

const STALE_LOCK_MS = 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function git(cwd, args, opts = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', ...opts });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function gitOk(cwd, args, opts) {
  const r = git(cwd, args, opts);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}
const isAncestor = (cwd, a, b) => git(cwd, ['merge-base', '--is-ancestor', a, b]).status === 0;
const isDirty = cwd => gitOk(cwd, ['status', '--porcelain']).trim() !== '';

// O_EXCL: only one caller can create the file. A lock older than a minute is presumed abandoned (a crashed
// process, a killed dashboard) — cleared with a log line rather than left to block every future attempt.
async function acquireLock(file, marker, log) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, marker, time: new Date().toISOString() }), { flag: 'wx' });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable — treat as stale below */ }
      const age = holder ? Date.now() - Date.parse(holder.time) : Infinity;
      if (!holder || !Number.isFinite(age) || age > STALE_LOCK_MS) {
        log(`trackfile sync: clearing a stale lock (${file}${holder ? `, held by ${holder.marker ?? 'unknown'} pid ${holder.pid}, ${Math.round(age / 1000)}s old` : ', unreadable'}).`);
        fs.rmSync(file, { force: true });
        continue;
      }
      throw new Error(`trackfile sync: locked by ${holder.marker ?? 'another process'} (pid ${holder.pid}) since ${holder.time} — retry shortly.`);
    }
  }
}
function releaseLock(file) { fs.rmSync(file, { force: true }); }

function writeChanges(layout, changes) {
  const relatives = [];
  for (const [name, text] of Object.entries(changes)) {
    const file = diskPath(layout, name);
    if (file === null) continue; // logical name the layout doesn't map to a path (defensive; model changes always do)
    if (text === null) { fs.rmSync(file, { force: true }); } else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
    relatives.push(relativeOf(layout, name));
  }
  return relatives;
}

const countUnpushed = (dataRoot, remote, branch) => Number(gitOk(dataRoot, ['rev-list', '--count', `${remote}/${branch}..HEAD`]).trim());

/* Runs `change` as one transaction against the data branch. Returns:
 *  - `{ applied: false }` when `change` reported nothing to do (empty/no changes).
 *  - `{ applied: true, pushed: true, commit }` once the commit reached the remote.
 *  - `{ applied: true, pushed: false, commit, unpushedCount }` when the remote could not be reached at all
 *    (not a race) and the commit is queued locally — the next transaction (by anyone) flushes it first.
 * Throws on: a dirty data worktree, a `change`/validation failure, a local queue that has diverged from a
 * moved remote in a way this engine cannot reconcile alone, or (with `mustPush`) an unreachable remote /
 * an exhausted retry budget — in every throwing case, nothing new is left committed.
 *
 * `change(doc)` returns the model's own `{changes}`-shaped result (or a bare `changes` object) — `null`/`{}`
 * means no-op. `message(doc, outcome)` builds the commit message from the parsed doc and `change`'s result
 * (needed for e.g. `new task`, whose id is only known once `change` has run). `mustPush: true` is for
 * operations that must not silently exist only locally, like allocating a task number. */
async function transact(layout, { change, message, mustPush = false, marker = 'agent', maxAttempts = 5, initialDelayMs = 200, log = () => {} }) {
  if (!layout.shared) throw new Error('trackfile sync: transact() only applies in shared-branch mode.');
  const dataRoot = layout.dataRoot, { remote, branch } = layout.pointer;
  const lock = lockPath(layout);
  await acquireLock(lock, marker, log);
  try { return await attempt(1, initialDelayMs); }
  finally { releaseLock(lock); }

  async function attempt(attemptNumber, delay) {
    if (isDirty(dataRoot)) throw new Error('trackfile sync: the data worktree has uncommitted changes — run `trackfile sync` first.');

    const fetched = git(dataRoot, ['fetch', '-q', remote, branch]).status === 0;
    if (!fetched && mustPush) throw new Error(`trackfile sync: ${remote} is unreachable — refusing an operation that must reserve a number/slot on the shared branch.`);
    if (fetched) reconcile();

    const files = readRegistryFiles(layout);
    const doc = M.parse(files);
    // `localBase` is what HEAD was before this attempt's own commit (to `reset --hard` back to on a lost
    // race); `remoteBase` is the remote ref's actual current value, the only correct lease for
    // `--force-with-lease` — the two differ whenever a still-unpushed commit from an earlier, remote-
    // unreachable transaction is queued ahead of us, which `reconcile()` deliberately leaves in place.
    const localBase = gitOk(dataRoot, ['rev-parse', 'HEAD']).trim();
    const remoteBase = fetched ? gitOk(dataRoot, ['rev-parse', `${remote}/${branch}`]).trim() : null;
    const outcome = await change(doc);
    const changes = outcome && outcome.changes ? outcome.changes : outcome;
    if (!changes || !Object.keys(changes).length) return { applied: false };

    const relatives = writeChanges(layout, changes);
    const commitMessage = typeof message === 'function' ? message(doc, outcome) : message;
    if (!commitMessage || /[\r\n\0]/.test(commitMessage)) throw new Error('trackfile sync: a commit message is required and must be a single line.');
    gitOk(dataRoot, ['add', '-A', '--', ...relatives]);
    gitOk(dataRoot, ['commit', '--only', '-q', '-m', commitMessage, '--', ...relatives]);
    const commitSha = gitOk(dataRoot, ['rev-parse', 'HEAD']).trim();

    if (!fetched) return { applied: true, pushed: false, commit: commitSha, unpushedCount: countUnpushed(dataRoot, remote, branch) };

    const pushed = git(dataRoot, ['push', `--force-with-lease=refs/heads/${branch}:${remoteBase}`, remote, `refs/heads/${branch}:refs/heads/${branch}`]);
    if (pushed.status === 0) return { applied: true, pushed: true, commit: commitSha };

    // Lost the race: undo our commit (never leaves a dangling local commit past the retry budget) and retry.
    gitOk(dataRoot, ['reset', '--hard', localBase]);
    if (attemptNumber >= maxAttempts) throw new Error(`trackfile sync: gave up after ${maxAttempts} attempts racing pushes to ${remote}/${branch}: ${pushed.stderr.trim()}`);
    log(`trackfile sync: push race lost (attempt ${attemptNumber}/${maxAttempts}), retrying in ${delay}ms...`);
    await sleep(delay);
    return attempt(attemptNumber + 1, delay * 2);
  }

  // Brings the worktree's branch in line with what was just fetched, without ever discarding a commit that
  // is only ours: same tip (nothing to do), remote strictly ahead (fast-forward onto it), local strictly
  // ahead (our own queued, not-yet-pushed commit(s) — left alone, `attempt` will push them along with the
  // new one), true divergence (both sides have commits the other lacks — needs #207 to merge, not this).
  function reconcile() {
    const remoteTip = gitOk(dataRoot, ['rev-parse', `${remote}/${branch}`]).trim();
    const localTip = gitOk(dataRoot, ['rev-parse', 'HEAD']).trim();
    if (remoteTip === localTip) return;
    if (isAncestor(dataRoot, remoteTip, localTip)) return; // our queued commit(s); still consistent with base
    if (isAncestor(dataRoot, localTip, remoteTip)) { gitOk(dataRoot, ['reset', '--hard', remoteTip]); return; }
    throw new Error(`trackfile sync: the local data branch and ${remote}/${branch} have diverged (an earlier queued commit is now stale) — this needs the structural merge from #207 to reconcile safely; run \`trackfile sync\` once it exists, or resolve by hand for now.`);
  }
}

module.exports = { transact, countUnpushed, isDirty, STALE_LOCK_MS };
