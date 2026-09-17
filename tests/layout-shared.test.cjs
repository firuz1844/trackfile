/* Shared-branch layout (#204): dataRoot resolution in the three cases the task calls for — legacy (no
 * pointer), shared mode with the data branch already checked out as a worktree in the same clone, and
 * shared mode in a separate clone that has to fetch and create the worktree from scratch. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findRoot, resolveLayout, readPointer, resolveDataRoot, POINTER } = require('../lib/layout.cjs');
const { toc } = require('../lib/toc.cjs');

// realpath: on macOS os.tmpdir() is a /tmp symlink into /private/tmp, and git worktree paths (via
// resolveDataRoot's path.resolve on `git worktree list`'s output) come back already resolved.
const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const commitAll = (cwd, message) => { git(cwd, ['add', '-A']); git(cwd, ['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', message]); };

function initRepo(dir) {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '--allow-empty', '-m', 'root commit']);
  return dir;
}

// An orphan branch holding just the registry — mirrors what `trackfile migrate --shared` (#205) will produce.
function createDataBranch(dir, branch, registryText) {
  const current = git(dir, ['branch', '--show-current']).trim();
  git(dir, ['checkout', '-q', '--orphan', branch]);
  git(dir, ['rm', '-rf', '-q', '--ignore-unmatch', '.']);
  fs.writeFileSync(path.join(dir, 'TRACKFILE.md'), registryText);
  commitAll(dir, 'import data branch');
  git(dir, ['checkout', '-q', current]);
}

const REGISTRY = '---\nschema: 1\nproject: "Shared"\nnext_task: 1\n---\n\n# Shared\n';

test('resolveLayout: legacy mode has no pointer, dataRoot is root', () => {
  const root = tmp('trackfile-legacy-');
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), REGISTRY);
  assert.equal(readPointer(root), null);
  const layout = resolveLayout(root);
  assert.equal(layout.dataRoot, root);
  assert.equal(layout.shared, false);
  assert.equal(layout.pointer, null);
});

test('findRoot stops at a directory holding only the pointer, without the registry itself', () => {
  const root = tmp('trackfile-pointer-only-');
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, POINTER), JSON.stringify({ branch: 'trackfile', remote: 'origin', mode: 'shared' }));
  assert.equal(findRoot(path.join(root, 'a', 'b')), root);
});

test('readPointer rejects anything but a well-formed shared pointer', () => {
  const root = tmp('trackfile-pointer-bad-');
  const write = data => fs.writeFileSync(path.join(root, POINTER), typeof data === 'string' ? data : JSON.stringify(data));
  write('not json'); assert.equal(readPointer(root), null);
  write({ mode: 'legacy', branch: 'trackfile' }); assert.equal(readPointer(root), null);
  write({ mode: 'shared' }); assert.equal(readPointer(root), null);
  write({ mode: 'shared', branch: '  ' }); assert.equal(readPointer(root), null);
  write({ mode: 'shared', branch: 'trackfile' }); assert.deepEqual(readPointer(root), { branch: 'trackfile', remote: 'origin', mode: 'shared' });
  write({ mode: 'shared', branch: 'trackfile', remote: 'upstream' }); assert.deepEqual(readPointer(root), { branch: 'trackfile', remote: 'upstream', mode: 'shared' });
});

test('resolveDataRoot reuses an existing linked worktree for the data branch in the same clone', () => {
  const root = initRepo(tmp('trackfile-shared-linked-'));
  createDataBranch(root, 'trackfile', REGISTRY);
  const worktree = path.join(root, '.trackfile');
  git(root, ['worktree', 'add', '-q', worktree, 'trackfile']);
  fs.writeFileSync(path.join(root, POINTER), JSON.stringify({ branch: 'trackfile', remote: 'origin', mode: 'shared' }));
  const pointer = readPointer(root);
  const dataRoot = resolveDataRoot(root, pointer);
  assert.equal(dataRoot, worktree);
  // resolveLayout wires it end to end: the registry is read from the worktree, toc reflects its content.
  const layout = resolveLayout(root);
  assert.equal(layout.dataRoot, worktree);
  assert.equal(layout.shared, true);
  assert.match(toc(layout), /^next_task: 1$/m);
});

test('resolveDataRoot fetches and creates the worktree on a fresh clone that has never checked out the data branch', () => {
  const origin = tmp('trackfile-shared-origin-');
  git(origin, ['init', '-q', '--bare', '-b', 'main']);
  const seed = initRepo(tmp('trackfile-shared-seed-'));
  createDataBranch(seed, 'trackfile', REGISTRY);
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['push', '-q', 'origin', 'main', 'trackfile']);
  // A second clone never had the data branch checked out — it only has `main` and the pointer.
  const clone = tmp('trackfile-shared-clone-');
  git(clone, ['clone', '-q', origin, '.']);
  git(clone, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(clone, POINTER), JSON.stringify({ branch: 'trackfile', remote: 'origin', mode: 'shared' }));
  assert.equal(git(clone, ['worktree', 'list']).trim().split('\n').length, 1, 'only the main worktree exists yet');
  const layout = resolveLayout(clone);
  const worktree = path.join(clone, '.trackfile');
  assert.equal(layout.dataRoot, worktree);
  assert.equal(fs.readFileSync(path.join(worktree, 'TRACKFILE.md'), 'utf8'), REGISTRY);
  assert.match(git(clone, ['worktree', 'list', '--porcelain']), /branch refs\/heads\/trackfile/);
  // Idempotent: resolving again reuses the worktree instead of trying (and failing) to recreate it.
  const again = resolveLayout(clone);
  assert.equal(again.dataRoot, worktree);
});

test('resolveDataRoot fails clearly when the data branch cannot be found locally or on the remote', () => {
  const root = initRepo(tmp('trackfile-shared-missing-'));
  const pointer = { branch: 'no-such-branch', remote: 'origin', mode: 'shared' };
  assert.throws(() => resolveDataRoot(root, pointer), /could not find local branch no-such-branch/);
});
