/* `trackfile migrate --shared` (#205): moves the registry, archive and task folders from the working
 * branch into a dedicated data branch (default `trackfile`), without losing history reachable from the
 * pre-migration tag, and sets up the `.trackfile.json` pointer + worktree that #204's layout expects.
 *
 * Idempotent: a second run with a compatible pointer already in place is a no-op that just makes sure the
 * worktree exists. `--dry-run` prints the plan and writes nothing. `--local` skips the push (single-clone
 * setups); `--rollback` undoes an unpushed-or-pushed migration by restoring files from the data branch.
 *
 * Out of scope here (left for later tasks, and documented as such rather than half-built):
 *  - `--history` (rewriting the data branch to carry real path history via `git filter-repo`) — #205's own
 *    text calls it optional; wiring a whole history rewrite correctly needs more care than this pass buys.
 *  - `--absorb BRANCH` (folding registry edits from a pre-migration branch into the data branch) needs the
 *    structural merge engine from #207, which does not exist yet.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DEFAULTS, POINTER, readPointer, resolveDataRoot, resolveLayout, readRegistryFiles } = require('./layout.cjs');
const { repoRoot } = require('./init.cjs');
const M = require('../app/assets/model.js');

const BACKUP_TAG = 'trackfile-pre-migration';
const dataPaths = () => [DEFAULTS.registry, DEFAULTS.archive, DEFAULTS.tasks];

function git(cwd, args, opts = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', ...opts });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}
function gitOk(cwd, args, opts) {
  const r = git(cwd, args, opts);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim() || `exit ${r.status}`}`);
  return r.stdout;
}

function isDirty(root, paths) {
  const out = gitOk(root, ['status', '--porcelain', '--', ...paths]);
  return out.trim() ? out.trim().split('\n') : [];
}
const branchExistsLocal = (root, branch) => git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
const branchExistsRemote = (root, remote, branch) => git(root, ['ls-remote', '--exit-code', '--heads', remote, branch]).status === 0;

// No pid file exists yet (#210 adds one); a quick TCP probe of the default port is the best available
// signal that a dashboard could be mid-commit against the files this command is about to move.
function dashboardRunning(port) {
  const net = require('node:net');
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 300 });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

function checkRegistry(root) {
  const layout = resolveLayout(root); // no pointer yet at this point, so dataRoot === root
  let files;
  try { files = readRegistryFiles(layout); M.parse(files); }
  catch (error) { throw new Error(`trackfile migrate: the registry does not pass validation — fix it before migrating: ${error.message}`); }
  return layout;
}

function copyDataFiles(root, paths, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  for (const rel of paths) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
}

function resolveGitDir(root) {
  const common = gitOk(root, ['rev-parse', '--git-common-dir']).trim();
  return path.isAbsolute(common) ? common : path.join(root, common);
}

// Every file under `rel` (rel itself if it is already a file), as paths relative to `root`.
function listFiles(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, child)); else out.push(child);
  }
  return out;
}

// Builds the orphan commit entirely through plumbing (a throwaway index file, `hash-object`,
// `write-tree`, `commit-tree`) so the caller's actual working tree, index and current branch are never
// touched — safe to run no matter what the agent has checked out or staged right now.
function createOrphanBranch(root, branch, paths, message) {
  const gitDir = resolveGitDir(root);
  const indexFile = path.join(os.tmpdir(), `trackfile-migrate-${process.pid}-${crypto.randomBytes(4).toString('hex')}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile, GIT_DIR: gitDir };
  const run = args => { const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`); return r.stdout; };
  try {
    run(['read-tree', '--empty']);
    const files = paths.flatMap(p => listFiles(root, p));
    if (!files.length) throw new Error('trackfile migrate: no data files found to import.');
    for (const rel of files) {
      const posixRel = rel.split(path.sep).join('/');
      const abs = path.join(root, rel);
      const mode = (fs.statSync(abs).mode & 0o111) ? '100755' : '100644';
      const blob = run(['hash-object', '-w', '--', abs]).trim();
      run(['update-index', '--add', '--cacheinfo', `${mode},${blob},${posixRel}`]);
    }
    const tree = run(['write-tree']).trim();
    const commit = run(['commit-tree', tree, '-m', message]).trim();
    run(['update-ref', `refs/heads/${branch}`, commit]);
    return commit;
  } finally { fs.rmSync(indexFile, { force: true }); }
}

// Byte-for-byte: every data file's blob hash on the new branch must match the working tree's, and the
// imported registry must still parse to the same task ids and next_task.
function verifyImport(root, paths, branch) {
  const files = paths.flatMap(p => listFiles(root, p));
  const onBranch = new Map();
  for (const line of gitOk(root, ['ls-tree', '-r', branch]).split('\n').filter(Boolean)) {
    const [info, filePath] = line.split('\t');
    onBranch.set(filePath, info.split(' ')[2]);
  }
  const posixFiles = files.map(f => f.split(path.sep).join('/'));
  const missing = posixFiles.filter(f => !onBranch.has(f));
  if (missing.length) throw new Error(`trackfile migrate: verification failed — missing on branch ${branch}: ${missing.join(', ')}`);
  if (onBranch.size !== posixFiles.length) throw new Error(`trackfile migrate: verification failed — branch ${branch} has ${onBranch.size} file(s), expected ${posixFiles.length}.`);
  for (const rel of files) {
    const posixRel = rel.split(path.sep).join('/');
    const localSha = gitOk(root, ['hash-object', '--', path.join(root, rel)]).trim();
    if (localSha !== onBranch.get(posixRel)) throw new Error(`trackfile migrate: verification failed — ${posixRel} content differs from the working tree.`);
  }
  const registryText = gitOk(root, ['show', `${branch}:${DEFAULTS.registry}`]);
  const archiveProbe = git(root, ['show', `${branch}:${DEFAULTS.archive}`]);
  const importedFiles = { [M.REGISTRY]: registryText };
  if (archiveProbe.status === 0) importedFiles[M.ARCHIVE] = archiveProbe.stdout;
  let after;
  try { after = M.parse(importedFiles); } catch (error) { throw new Error(`trackfile migrate: verification failed — the imported registry does not parse: ${error.message}`); }
  const layout = resolveLayout(root);
  const before = M.parse(readRegistryFiles(layout, { archive: archiveProbe.status === 0 }));
  const beforeIds = [...before.byId.keys()].sort(), afterIds = [...after.byId.keys()].sort();
  if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) throw new Error('trackfile migrate: verification failed — task id sets differ before/after import.');
  if (before.meta.next_task !== after.meta.next_task) throw new Error('trackfile migrate: verification failed — next_task differs before/after import.');
}

function removeFromWorkingBranch(root, paths) {
  for (const rel of paths) if (fs.existsSync(path.join(root, rel))) gitOk(root, ['rm', '-r', '-q', '--', rel]);
}

function ensureGitignored(root, pattern) {
  const file = path.join(root, '.gitignore');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.split(/\r?\n/).some(l => l.trim() === pattern || l.trim() === '/' + pattern)) return;
  fs.writeFileSync(file, (text && !text.endsWith('\n') ? text + '\n' : text) + pattern + '\n');
}

// The directory can only hold the pre-migration config.json at this point (registry/archive/tasks were
// just git-rm'd) — it is local UI state that is never migrated (see the module doc), so it is dropped
// rather than left behind to make `git worktree add` refuse a non-empty target.
function clearLegacyConfig(target) {
  if (fs.existsSync(target) && fs.readdirSync(target).length) fs.rmSync(target, { recursive: true, force: true });
}

async function runMigrate({ root, branch, remote, local, dryRun, task, port, log }) {
  const paths = dataPaths();
  const existingPointer = readPointer(root);
  if (existingPointer) {
    if (existingPointer.branch !== branch) throw new Error(`trackfile migrate: ${POINTER} already points at branch "${existingPointer.branch}", not "${branch}". Remove or edit ${POINTER} before switching data branches.`);
    log(`Already in shared mode (branch ${branch}) — this is a repeat run.`);
    if (!dryRun) log(`Data worktree: ${resolveDataRoot(root, existingPointer)}`);
    return { root, alreadyMigrated: true };
  }

  const dirty = isDirty(root, paths);
  if (dirty.length) throw new Error(`trackfile migrate: uncommitted changes in the data files — commit or discard them first:\n${dirty.join('\n')}`);

  const hasLocalBranch = branchExistsLocal(root, branch);
  const hasRemoteBranch = !local && branchExistsRemote(root, remote, branch);
  if (hasLocalBranch || hasRemoteBranch) throw new Error(`trackfile migrate: branch "${branch}" already exists ${hasLocalBranch ? 'locally' : `on ${remote}`}, but there is no ${POINTER} yet — this looks like an unrelated branch or a partial migration. Investigate by hand before retrying.`);

  checkRegistry(root);

  port = port ?? (Number(process.env.PORT) || 3737);
  if (await dashboardRunning(port)) throw new Error(`trackfile migrate: something is listening on port ${port} — stop the dashboard for this repository first, it could commit to the old location mid-migration.`);

  const steps = [
    { name: 'backup', detail: `tag ${BACKUP_TAG} on HEAD, copy of ${paths.join(', ')} to a sibling backup folder` },
    { name: 'branch', detail: `orphan branch "${branch}" with one import commit (plumbing only, no checkout)` },
    { name: 'verify', detail: 'byte-compare every imported file, re-parse the registry, compare task ids and next_task' },
    { name: 'publish', detail: local ? 'local only (--local): the branch stays unpushed' : `push refs/heads/${branch} to ${remote}` },
    { name: 'rewrite', detail: `git rm ${paths.join(', ')}, write ${POINTER}, ignore .trackfile/, one commit` },
    { name: 'worktree', detail: `git worktree add ${path.join(root, '.trackfile')} ${branch}, then a toc() smoke read` },
  ];
  if (dryRun) { for (const s of steps) log(`  would ${s.name.padEnd(9)} ${s.detail}`); return { root, steps, dryRun: true }; }

  log(`Backing up: tag ${BACKUP_TAG}, copying data files...`);
  const originalHead = gitOk(root, ['rev-parse', 'HEAD']).trim();
  gitOk(root, ['tag', BACKUP_TAG, originalHead]);
  const backupDir = path.join(root, `.trackfile-migration-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  copyDataFiles(root, paths, backupDir);

  log(`Creating orphan branch "${branch}"...`);
  const importMessage = task ? `#${task} [migrate]: данные трекера в ветку ${branch}` : `[migrate]: import task-tracker data into branch ${branch}`;
  const commitSha = createOrphanBranch(root, branch, paths, importMessage);

  log('Verifying the import...');
  try { verifyImport(root, paths, branch); }
  catch (error) { gitOk(root, ['tag', '-d', BACKUP_TAG]); gitOk(root, ['update-ref', '-d', `refs/heads/${branch}`]); throw error; }

  if (!local) {
    log(`Pushing ${branch} to ${remote}...`);
    const pushed = git(root, ['push', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
    if (pushed.status !== 0) {
      gitOk(root, ['tag', '-d', BACKUP_TAG]); gitOk(root, ['update-ref', '-d', `refs/heads/${branch}`]);
      throw new Error(`trackfile migrate: push failed, rolled back the branch creation (the working branch itself was never touched): ${(pushed.stderr || '').trim()}`);
    }
  } else {
    log('--local: the branch is not pushed — data exists in this clone only until you push it.');
  }

  log('Removing data files from the working branch...');
  removeFromWorkingBranch(root, paths);
  fs.writeFileSync(path.join(root, POINTER), JSON.stringify({ branch, remote, mode: 'shared' }, null, 2) + '\n');
  ensureGitignored(root, '.trackfile/');
  ensureGitignored(root, '.trackfile-migration-backup-*/');
  // `git rm` above already staged the data files' removal — only the pointer and .gitignore are new/changed.
  gitOk(root, ['add', '-A', '--', POINTER, '.gitignore']);
  const commitMessage = task ? `#${task} [migrate]: данные трекера в ветку ${branch}` : `[migrate]: move task-tracker data into branch ${branch}`;
  gitOk(root, ['commit', '-q', '-m', commitMessage]);

  log('Setting up the data worktree...');
  const target = path.join(root, '.trackfile');
  clearLegacyConfig(target);
  gitOk(root, ['worktree', 'add', '-q', target, branch]);

  const layout = resolveLayout(root);
  require('./toc.cjs').toc(layout); // throws if reading from the worktree is somehow broken

  log(`Done. Data now lives on branch "${branch}" (worktree: ${layout.dataRoot}). Backup: tag ${BACKUP_TAG}, folder ${backupDir}.`);
  return { root, branch, dataRoot: layout.dataRoot, backupDir, commit: commitSha };
}

async function runRollback({ root, dryRun, log }) {
  const pointer = readPointer(root);
  if (!pointer) throw new Error(`trackfile migrate --rollback: no ${POINTER} found — this clone is not in shared mode.`);
  const tagExists = git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${BACKUP_TAG}`]).status === 0;
  if (!tagExists) throw new Error(`trackfile migrate --rollback: tag ${BACKUP_TAG} not found — cannot verify the pre-migration state. Restore by hand from branch ${pointer.branch} if you are sure.`);
  if (dryRun) { log(`Would restore data files from branch ${pointer.branch}, remove ${POINTER} and its worktree, keep the branch and the ${BACKUP_TAG} tag.`); return { root, dryRun: true }; }

  const dataRoot = resolveDataRoot(root, pointer);
  const paths = dataPaths();
  // The default worktree path IS `<root>/.trackfile`, the same prefix the legacy archive/tasks paths use —
  // copying straight into root would write inside the worktree's own directory, for `git worktree remove`
  // to then delete along with it. Stage outside root first, remove the worktree, then move staged files in.
  log(`Restoring data files from branch ${pointer.branch}...`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'trackfile-rollback-'));
  try {
    for (const rel of paths) {
      const src = path.join(dataRoot, rel);
      if (!fs.existsSync(src)) continue;
      const staged = path.join(staging, rel);
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.cpSync(src, staged, { recursive: true });
    }

    if (dataRoot !== root) {
      log('Removing the data worktree...');
      const removed = git(root, ['worktree', 'remove', '--force', dataRoot]);
      if (removed.status !== 0) fs.rmSync(dataRoot, { recursive: true, force: true });
      git(root, ['worktree', 'prune']);
    }

    for (const rel of paths) {
      const dest = path.join(root, rel);
      fs.rmSync(dest, { recursive: true, force: true });
      const staged = path.join(staging, rel);
      if (!fs.existsSync(staged)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(staged, dest, { recursive: true });
    }
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  fs.rmSync(path.join(root, POINTER), { force: true });
  // -f: rollback must win over any .gitignore entry migrate added (e.g. `.trackfile/`) for these exact
  // paths. A data path that never existed before migration (e.g. no archive.md yet) has nothing to add or
  // remove — passing it to `git add` as an explicit pathspec would fail with "did not match any files".
  // POINTER always did exist (migrate wrote and committed it), so its now-missing path stages as a deletion.
  const restorable = paths.filter(rel => fs.existsSync(path.join(root, rel)));
  gitOk(root, ['add', '-f', '-A', '--', ...restorable, POINTER]);
  gitOk(root, ['commit', '-q', '-m', '[migrate --rollback]: restore task-tracker data to the working branch']);
  log(`Rolled back. Branch "${pointer.branch}" and tag ${BACKUP_TAG} are left in place for inspection; delete them by hand once you are sure.`);
  return { root, restored: true };
}

async function run({ cwd = process.cwd(), branch = 'trackfile', remote = 'origin', local = false, history = false, push = false, dryRun = false, rollback = false, absorb = null, task = null, port = null, log = console.log } = {}) {
  const root = repoRoot(cwd);
  if (absorb) throw new Error('trackfile migrate --absorb requires the structural merge engine from #207 — not implemented yet. Merge the branch by hand for now.');
  if (rollback) return runRollback({ root, dryRun, log });
  if (history) throw new Error('trackfile migrate --history (rewriting path history with git-filter-repo) is not implemented yet — retry without --history for an orphan import; your old commits stay reachable via the trackfile-pre-migration tag.');
  void push; // branch protection + CI workflow setup belongs to #211, once its template exists.
  return runMigrate({ root, branch, remote, local, dryRun, task, port, log });
}

module.exports = { run, BACKUP_TAG, dataPaths };
