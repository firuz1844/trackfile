/* Repository layout: where the registry, the archive, task folders and the UI config live.
 * Defaults are TRACKFILE.md at the repository root plus a `.trackfile/` folder; a project may override
 * the three paths in the registry's front matter (`archive_file`, `tasks_dir`, `config_file`) or point the
 * CLI at a differently named registry with `--registry`.
 *
 * Shared-branch mode (#203): `root` is the source clone (code, `.trackfile.json` pointer), `dataRoot` is
 * where the registry files actually live — the same as `root` in the legacy layout, or a git worktree that
 * checks out the data branch named by the pointer. Callers that read/write registry files (the registry
 * itself, the archive, task comments/attachments, the UI config) must use `dataRoot`; callers that browse
 * the project's own source and commits (`serve.cjs`'s source/commit endpoints) keep using `root`. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const M = require('../app/assets/model.js');

const DEFAULTS = Object.freeze({ registry: 'TRACKFILE.md', archive: '.trackfile/archive.md', tasks: '.trackfile/tasks', config: '.trackfile/config.json' });
const POINTER = '.trackfile.json';
const toPosix = p => p.split(path.sep).join('/');

// Walk up from `cwd` until a directory containing the registry file, or the shared-mode pointer, is found
// (like git looks for .git). The pointer alone is enough in shared mode: the registry itself lives in the
// data worktree, not necessarily under `cwd`.
function findRoot(cwd = process.cwd(), registry = DEFAULTS.registry) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, POINTER)) || fs.existsSync(path.join(dir, registry))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Reads and validates `.trackfile.json` at the source root. Returns null in legacy mode (file absent,
// unreadable, not JSON, or `mode` is not "shared") so callers can fall back without special-casing errors.
function readPointer(root) {
  let raw;
  try { raw = fs.readFileSync(path.join(root, POINTER), 'utf8'); } catch { return null; }
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object' || data.mode !== 'shared') return null;
  const branch = typeof data.branch === 'string' && data.branch.trim() ? data.branch.trim() : null;
  if (!branch) return null;
  const remote = typeof data.remote === 'string' && data.remote.trim() ? data.remote.trim() : 'origin';
  return { branch, remote, mode: 'shared' };
}

function runGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

// `git worktree list --porcelain` as [{path, branch}] (branch null for a detached worktree).
function parseWorktrees(output) {
  const entries = [];
  let current = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: line.slice('worktree '.length).trim(), branch: null }; entries.push(current); }
    else if (line.startsWith('branch ') && current) current.branch = line.slice('branch '.length).trim();
  }
  return entries;
}

// Sets up a worktree for the data branch at `target`: reuses a local branch if one exists, otherwise
// fetches it from the pointer's remote and creates a local tracking branch. Throws with a message the CLI
// can print as-is when neither is possible (offline, unknown branch) — resolveDataRoot has no safe fallback.
function createDataWorktree(root, pointer, target) {
  const hasLocalBranch = runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${pointer.branch}`]) !== null;
  if (hasLocalBranch) {
    if (runGit(root, ['worktree', 'add', target, pointer.branch]) !== null) return target;
    throw new Error(`trackfile: failed to create the data worktree at ${target} for branch ${pointer.branch}.`);
  }
  if (runGit(root, ['fetch', pointer.remote, pointer.branch]) === null) {
    throw new Error(`trackfile: could not find local branch ${pointer.branch}, and fetching it from ${pointer.remote} failed. Fetch it manually (or check .trackfile.json) and retry.`);
  }
  if (runGit(root, ['worktree', 'add', '--track', '-b', pointer.branch, target, `${pointer.remote}/${pointer.branch}`]) !== null) return target;
  throw new Error(`trackfile: failed to create the data worktree at ${target} for branch ${pointer.branch}.`);
}

// DEFAULTS.config (and #206's sync lock next to it) resolve *relative to dataRoot* — which, because the
// worktree itself is mounted at `<root>/.trackfile`, puts `.trackfile/config.json` and `.trackfile/.sync.lock`
// *inside the checked-out data branch*, right alongside the tracked `.trackfile/tasks/`. Left alone they
// would show up as untracked files in `git status` on every worktree touched this way. `info/exclude` is
// shared by the common git dir across all of a repo's worktrees, which is exactly right: the source clone
// already gitignores the whole `.trackfile/` directory, so these two extra patterns only ever matter inside
// the data-branch worktree itself. Idempotent — safe to call on a worktree this already ran on.
function excludeLocalWorktreeState(worktree) {
  const excludeFile = runGit(worktree, ['rev-parse', '--git-path', 'info/exclude']);
  if (excludeFile === null) return;
  const resolved = path.isAbsolute(excludeFile.trim()) ? excludeFile.trim() : path.join(worktree, excludeFile.trim());
  const text = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
  const patterns = ['/.trackfile/config.json', '/.trackfile/.sync.lock', '/.trackfile/.agent/'];
  const missing = patterns.filter(p => !text.split(/\r?\n/).includes(p));
  if (!missing.length) return;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, (text && !text.endsWith('\n') ? text + '\n' : text) + missing.join('\n') + '\n');
}

// The `trackfile-merge` driver (#207) is arbitrary code, so git only ever sources it from *local* config —
// never from anything committed and shared (that would let a repository run code on clone/merge). Every
// clone that touches the data worktree registers it here; `.gitattributes` on the data branch itself (see
// migrate.cjs) is what tells git to actually use it for TRACKFILE.md/archive.md. Config is per-repository
// (shared by all of a clone's worktrees), so this only needs to run once per clone; idempotent regardless.
function ensureMergeDriver(worktree) {
  const command = `node ${JSON.stringify(path.join(__dirname, '..', 'bin', 'trackfile.js'))} merge-driver %O %A %B %P`;
  const current = runGit(worktree, ['config', '--get', 'merge.trackfile-merge.driver']);
  if (current !== null && current.trim() === command) return;
  runGit(worktree, ['config', 'merge.trackfile-merge.name', 'trackfile structural merge']);
  runGit(worktree, ['config', 'merge.trackfile-merge.driver', command]);
}
function prepareWorktree(worktree) { excludeLocalWorktreeState(worktree); ensureMergeDriver(worktree); return worktree; }

// In legacy mode dataRoot is root. In shared mode: an existing worktree for the data branch is reused
// wherever `git worktree list` reports it (a linked worktree already set up in this same clone); otherwise
// one is created at `<root>/.trackfile` — fresh clones and machines pay this cost once.
function resolveDataRoot(root, pointer) {
  if (!pointer) return root;
  const ref = `refs/heads/${pointer.branch}`;
  const list = runGit(root, ['worktree', 'list', '--porcelain']);
  if (list !== null) {
    const match = parseWorktrees(list).find(w => w.branch === ref);
    if (match) return prepareWorktree(path.resolve(match.path));
  }
  const target = path.join(root, '.trackfile');
  if (fs.existsSync(path.join(target, '.git'))) return prepareWorktree(target); // already set up; `worktree list` failed transiently
  return prepareWorktree(createDataWorktree(root, pointer, target));
}

// Front-matter overrides are read with the registry's own YAML subset; a broken front matter is not fatal
// here (the dashboard reports it) — the defaults are used instead.
function overridesFrom(file) {
  try {
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(fs.readFileSync(file, 'utf8'));
    return front ? M.yaml(front[1]) : {};
  } catch { return {}; }
}

const safeRelative = (root, value, fallback) => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const rel = toPosix(path.normalize(value.trim()));
  return rel.startsWith('..') || path.isAbsolute(rel) ? fallback : rel;
};

function resolveLayout(root, { registry = DEFAULTS.registry } = {}) {
  root = path.resolve(root);
  const pointer = readPointer(root);
  const dataRoot = resolveDataRoot(root, pointer);
  const registryRel = safeRelative(dataRoot, registry, DEFAULTS.registry);
  const meta = overridesFrom(path.join(dataRoot, registryRel));
  const layout = {
    root,
    dataRoot,
    shared: Boolean(pointer),
    pointer,
    registry: registryRel,
    archive: safeRelative(dataRoot, meta.archive_file, DEFAULTS.archive),
    tasks: safeRelative(dataRoot, meta.tasks_dir, DEFAULTS.tasks),
    config: safeRelative(dataRoot, meta.config_file, DEFAULTS.config)
  };
  // How task text refers to attachments: relative to the registry file (`.trackfile/tasks/042/x.png`).
  layout.attachmentsPrefix = toPosix(path.relative(path.dirname(registryRel), layout.tasks)) || '.';
  return layout;
}

// Logical file names used by the model and the API → repository-relative paths.
function relativeOf(layout, name) {
  if (name === M.REGISTRY) return layout.registry;
  if (name === M.ARCHIVE) return layout.archive;
  if (name === 'config') return layout.config;
  const m = M.COMMENTS_FILE.exec(name);
  if (m) return `${layout.tasks}/${m[1]}/comments.md`;
  return null;
}
const diskPath = (layout, name) => { const rel = relativeOf(layout, name); return rel === null ? null : path.join(layout.dataRoot, rel); };
const taskDir = (layout, id) => path.join(layout.dataRoot, layout.tasks, id);
// Coordinates the dashboard server and CLI agents writing to the same worktree on the same machine (#206);
// lives next to config.json, since both are per-worktree local state rather than tracked data.
const lockPath = layout => path.join(layout.dataRoot, path.dirname(layout.config), '.sync.lock');
// One agent's local state (last-seen hash of a task it `take`s, for #208's stale-context check) — local
// state like the lock and config, git-ignored the same way, keyed by the agent's own marker.
const agentStatePath = (layout, marker) => path.join(layout.dataRoot, path.dirname(layout.config), '.agent', `${marker}.json`);
const publicLayout = layout => ({ registry: layout.registry, archive: layout.archive, tasks: layout.tasks, config: layout.config, attachmentsPrefix: layout.attachmentsPrefix, shared: layout.shared });

// All registry files as the model expects them: {registry, archive?, 'comments/NNN'…}.
function readRegistryFiles(layout, { archive = true } = {}) {
  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const files = { [M.REGISTRY]: read(diskPath(layout, M.REGISTRY)) };
  const archiveText = archive ? read(diskPath(layout, M.ARCHIVE)) : null;
  if (archiveText !== null) files[M.ARCHIVE] = archiveText;
  const tasksDir = path.join(layout.dataRoot, layout.tasks);
  const dirs = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter(d => /^\d{3,}$/.test(d)).sort() : [];
  for (const id of dirs) { const text = read(path.join(tasksDir, id, 'comments.md')); if (text !== null) files[M.commentsFile(id)] = text; }
  return files;
}

module.exports = { DEFAULTS, POINTER, findRoot, readPointer, resolveDataRoot, resolveLayout, relativeOf, diskPath, taskDir, lockPath, agentStatePath, publicLayout, readRegistryFiles };
