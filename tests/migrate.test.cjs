/* trackfile migrate --shared (#205): happy path against a bare remote, --dry-run, --local, idempotent
 * re-run, every precondition rejection, and --rollback restoring the working tree byte-for-byte. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const migrate = require('../lib/migrate.cjs');
const { readPointer, resolveLayout } = require('../lib/layout.cjs');
const { toc } = require('../lib/toc.cjs');
const F = require('./fixture.cjs');

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const quiet = { log: () => {}, port: 47212 };

function seedRepo() {
  const root = tmp('trackfile-migrate-');
  git(root, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), F.registry());
  fs.mkdirSync(path.join(root, '.trackfile', 'tasks', '002'), { recursive: true });
  fs.writeFileSync(path.join(root, '.trackfile', 'tasks', '002', 'comments.md'), F.comments());
  fs.writeFileSync(path.join(root, '.trackfile', 'tasks', '002', 'note.txt'), 'an attachment');
  fs.writeFileSync(path.join(root, 'README.md'), '# Sample project\n');
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'seed']);
  return root;
}
function withBareRemote(root) {
  const origin = tmp('trackfile-migrate-origin-');
  git(origin, ['init', '-q', '--bare', '-b', 'main']);
  git(root, ['remote', 'add', 'origin', origin]);
  git(root, ['push', '-q', 'origin', 'main']);
  return origin;
}

test('migrate --shared --dry-run: prints the plan, touches nothing', async () => {
  const root = seedRepo();
  withBareRemote(root);
  const before = fs.readFileSync(path.join(root, 'TRACKFILE.md'), 'utf8');
  const lines = [];
  const result = await migrate.run({ cwd: root, dryRun: true, port: 47212, log: l => lines.push(l) });
  assert.equal(result.dryRun, true);
  assert.ok(lines.some(l => l.includes('branch')));
  assert.equal(readPointer(root), null);
  assert.equal(fs.readFileSync(path.join(root, 'TRACKFILE.md'), 'utf8'), before);
  assert.equal(git(root, ['status', '--porcelain']).trim(), '');
});

test('migrate --shared: full run against a bare remote, then --rollback restores the original tree', async () => {
  const root = seedRepo();
  const origin = withBareRemote(root);
  const originalFiles = {
    'TRACKFILE.md': fs.readFileSync(path.join(root, 'TRACKFILE.md'), 'utf8'),
    '.trackfile/tasks/002/comments.md': fs.readFileSync(path.join(root, '.trackfile', 'tasks', '002', 'comments.md'), 'utf8'),
    '.trackfile/tasks/002/note.txt': fs.readFileSync(path.join(root, '.trackfile', 'tasks', '002', 'note.txt'), 'utf8'),
  };
  const result = await migrate.run({ cwd: root, task: '204', ...quiet });
  assert.equal(result.branch, 'trackfile');
  assert.deepEqual(readPointer(root), { branch: 'trackfile', remote: 'origin', mode: 'shared' });
  assert.ok(!fs.existsSync(path.join(root, 'TRACKFILE.md')), 'the registry is gone from the working branch');
  assert.equal(git(root, ['status', '--porcelain']).trim(), '', 'the migration commit leaves a clean tree');
  assert.match(git(root, ['log', '-1', '--format=%s']), /^#204 \[migrate\]/);
  assert.match(git(origin, ['branch', '--list', 'trackfile']), /trackfile/, 'the data branch reached the remote');

  const layout = resolveLayout(root);
  assert.equal(layout.shared, true);
  assert.equal(layout.dataRoot, path.join(root, '.trackfile'));
  assert.equal(fs.readFileSync(path.join(layout.dataRoot, 'TRACKFILE.md'), 'utf8'), originalFiles['TRACKFILE.md']);
  assert.match(toc(layout), /^next_task: /m);
  const cliToc = execFileSync('node', [path.join(__dirname, '..', 'bin', 'trackfile.js'), 'toc'], { cwd: root, encoding: 'utf8' });
  assert.match(cliToc, /^next_task: /m);
  assert.ok(fs.existsSync(path.join(root, '.gitignore')) && fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('.trackfile/'));
  assert.ok(git(root, ['tag', '--list', migrate.BACKUP_TAG]).trim(), 'the pre-migration tag exists');

  // Re-running is a no-op, not an error.
  const again = await migrate.run({ cwd: root, ...quiet });
  assert.equal(again.alreadyMigrated, true);

  // --rollback restores the working tree to its pre-migration content, byte for byte.
  const rolled = await migrate.run({ cwd: root, rollback: true, ...quiet });
  assert.equal(rolled.restored, true);
  assert.equal(readPointer(root), null);
  // `.trackfile/` legitimately exists again post-rollback — it is where the legacy layout keeps
  // archive.md/tasks/ — but it must no longer be a git worktree (no linked .git inside).
  assert.ok(!fs.existsSync(path.join(layout.dataRoot, '.git')), 'the data worktree checkout is gone');
  for (const [rel, content] of Object.entries(originalFiles)) assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), content, rel);
  assert.equal(git(root, ['status', '--porcelain']).trim(), '', 'rollback leaves a clean tree too');
  assert.ok(git(root, ['branch', '--list', 'trackfile']).trim(), 'the data branch itself is left in place');
  assert.ok(git(root, ['tag', '--list', migrate.BACKUP_TAG]).trim(), 'the backup tag is left in place');
});

test('migrate --shared --local: does not push, the branch stays out of the remote', async () => {
  const root = seedRepo();
  const origin = withBareRemote(root);
  await migrate.run({ cwd: root, local: true, ...quiet });
  assert.equal(readPointer(root).mode, 'shared');
  assert.equal(git(origin, ['branch', '--list', 'trackfile']).trim(), '', 'nothing was pushed');
  assert.ok(git(root, ['branch', '--list', 'trackfile']).trim(), 'the branch exists locally');
});

test('migrate --shared refuses a dirty data tree, a broken registry, and a pre-existing unrelated branch', async () => {
  const dirty = seedRepo();
  fs.appendFileSync(path.join(dirty, 'TRACKFILE.md'), '\nedited\n');
  await assert.rejects(migrate.run({ cwd: dirty, ...quiet }), /uncommitted changes/);

  const broken = seedRepo();
  fs.writeFileSync(path.join(broken, 'TRACKFILE.md'), F.registry().replace('next_task: 11', 'next_task: 1'));
  git(broken, ['add', '-A']);
  git(broken, ['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'break it']);
  await assert.rejects(migrate.run({ cwd: broken, ...quiet }), /does not pass validation/);

  const collide = seedRepo();
  git(collide, ['branch', 'trackfile']);
  await assert.rejects(migrate.run({ cwd: collide, ...quiet }), /already exists locally/);
});

test('migrate --shared refuses to run while something is listening on the target port', async () => {
  const root = seedRepo();
  withBareRemote(root);
  const server = net.createServer().listen(0);
  await new Promise(resolve => server.on('listening', resolve));
  const port = server.address().port;
  const savedPort = process.env.PORT;
  process.env.PORT = String(port);
  try { await assert.rejects(migrate.run({ cwd: root, log: quiet.log }), /is listening on port/); }
  finally { if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort; server.close(); }
});

test('migrate --history and --absorb refuse clearly instead of doing a half-migration', async () => {
  const root = seedRepo();
  await assert.rejects(migrate.run({ cwd: root, history: true, ...quiet }), /--history.*not implemented/s);
  await assert.rejects(migrate.run({ cwd: root, absorb: 'some-branch', ...quiet }), /--absorb.*#207/);
  assert.equal(readPointer(root), null, 'neither call touched the repository');
});

test('migrate --rollback without a prior migration fails clearly', async () => {
  const root = seedRepo();
  await assert.rejects(migrate.run({ cwd: root, rollback: true, ...quiet }), /no \.trackfile\.json found/);
});
