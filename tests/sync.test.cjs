/* Sync engine (#206): two independent clones racing to create a task get different numbers, a lost push
 * race retries with the change re-applied against the new base, an unreachable remote queues the commit
 * locally and a later transaction flushes it, and a stale lock is cleared rather than blocking forever. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { transact, countUnpushed, STALE_LOCK_MS } = require('../lib/sync.cjs');
const { resolveLayout, lockPath } = require('../lib/layout.cjs');
const migrate = require('../lib/migrate.cjs');
const M = require('../app/assets/model.js');
const F = require('./fixture.cjs');

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const quiet = { log: () => {} };
let nextPort = 47300;

async function sharedClone(origin, name) {
  const root = tmp(name);
  git(root, ['clone', '-q', origin, '.']);
  git(root, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(root, '.trackfile.json'), JSON.stringify({ branch: 'trackfile', remote: 'origin', mode: 'shared' }));
  return resolveLayout(root);
}

async function seedShared() {
  const seed = tmp('trackfile-sync-seed-');
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, 'TRACKFILE.md'), F.registry());
  git(seed, ['add', '-A']);
  git(seed, ['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'seed']);
  const origin = tmp('trackfile-sync-origin-');
  git(origin, ['init', '-q', '--bare', '-b', 'main']);
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['push', '-q', 'origin', 'main']);
  await migrate.run({ cwd: seed, port: nextPort++, ...quiet });
  return origin;
}

const addTaskChange = title => doc => M.addTask(doc, { title, body: '' });
const addTaskMessage = (doc, outcome) => `#${outcome.id} [new task]: test`;

test('two independent clones creating a task concurrently get different numbers', async () => {
  const origin = await seedShared();
  const alice = await sharedClone(origin, 'trackfile-sync-alice-');
  const bob = await sharedClone(origin, 'trackfile-sync-bob-');

  const [aResult, bResult] = await Promise.all([
    transact(alice, { change: addTaskChange('Alice task'), message: addTaskMessage, mustPush: true, marker: 'alice', ...quiet }),
    transact(bob, { change: addTaskChange('Bob task'), message: addTaskMessage, mustPush: true, marker: 'bob', ...quiet }),
  ]);
  assert.ok(aResult.pushed && bResult.pushed);

  const aliceDoc = M.parse({ registry: fs.readFileSync(path.join(alice.dataRoot, 'TRACKFILE.md'), 'utf8') });
  const bobBefore = M.parse({ registry: fs.readFileSync(path.join(bob.dataRoot, 'TRACKFILE.md'), 'utf8') });
  // Bob's own worktree only reflects his own commit until he fetches again — but the ids the two
  // transactions actually reserved (surfaced via each transaction's own outcome) must differ.
  assert.notEqual(aliceDoc, undefined); assert.notEqual(bobBefore, undefined);

  // The published branch has both tasks under distinct ids — nobody's commit silently clobbered the other.
  const finalDoc = M.parse({ registry: git(origin, ['show', 'trackfile:TRACKFILE.md']) });
  const added = finalDoc.tasks.filter(t => t.title === 'Alice task' || t.title === 'Bob task');
  assert.deepEqual(added.map(t => t.title).sort(), ['Alice task', 'Bob task']);
  assert.equal(new Set(added.map(t => t.id)).size, 2, 'two distinct ids were reserved');
});

test('a lost push race retries by re-fetching, resetting, and re-applying the change on the new base', async () => {
  const origin = await seedShared();
  const alice = await sharedClone(origin, 'trackfile-sync-race-alice-');
  const bob = await sharedClone(origin, 'trackfile-sync-race-bob-');

  // Bob's whole transaction (fetch, apply, push) runs *inside* Alice's `change` callback — i.e. strictly
  // between Alice's own fetch/base and her push attempt — so her first push is guaranteed to lose the race
  // against a lease that no longer matches, forcing the retry path to actually run.
  let bobRan = false;
  const log = [];
  const result = await transact(alice, {
    change: async doc => {
      if (!bobRan) { bobRan = true; await transact(bob, { change: addTaskChange('Bob first'), message: addTaskMessage, mustPush: true, marker: 'bob', ...quiet }); }
      return M.addTask(doc, { title: 'Alice second', body: '' });
    },
    message: addTaskMessage, mustPush: true, marker: 'alice', log: l => log.push(l),
  });
  assert.equal(result.pushed, true);
  assert.ok(log.some(l => l.includes('retrying')), 'the retry path actually ran');
  const finalDoc = M.parse({ registry: git(origin, ['show', 'trackfile:TRACKFILE.md']) });
  const added = finalDoc.tasks.filter(t => t.title === 'Alice second' || t.title === 'Bob first');
  assert.deepEqual(added.map(t => t.title).sort(), ['Alice second', 'Bob first']);
  // Alice's task must have picked the id that was actually free *after* Bob's task landed, not a stale one.
  const bobTask = finalDoc.tasks.find(t => t.title === 'Bob first');
  const aliceTask = finalDoc.tasks.find(t => t.title === 'Alice second');
  assert.notEqual(bobTask.id, aliceTask.id);
});

test('an unreachable remote queues the commit locally; the next transaction flushes it', async () => {
  const origin = await seedShared();
  const alice = await sharedClone(origin, 'trackfile-sync-flush-');
  const realRemote = git(alice.dataRoot, ['remote', 'get-url', 'origin']).trim();
  git(alice.dataRoot, ['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'trackfile-sync-nonexistent-remote')]);

  const originalTitles = new Set(M.parse({ registry: git(origin, ['show', 'trackfile:TRACKFILE.md']) }).tasks.map(t => t.title));

  const queued = await transact(alice, { change: addTaskChange('Queued while offline'), message: addTaskMessage, mustPush: false, marker: 'alice', ...quiet });
  assert.equal(queued.pushed, false);
  assert.equal(queued.unpushedCount, 1);
  const afterQueue = M.parse({ registry: git(origin, ['show', 'trackfile:TRACKFILE.md']) });
  assert.ok(!afterQueue.tasks.some(t => t.title === 'Queued while offline'), 'nothing reached the remote yet');

  git(alice.dataRoot, ['remote', 'set-url', 'origin', realRemote]);
  const flushed = await transact(alice, { change: addTaskChange('Second, once back online'), message: addTaskMessage, mustPush: true, marker: 'alice', ...quiet });
  assert.equal(flushed.pushed, true);
  const finalDoc = M.parse({ registry: git(origin, ['show', 'trackfile:TRACKFILE.md']) });
  const addedTitles = finalDoc.tasks.map(t => t.title).filter(title => !originalTitles.has(title)).sort();
  assert.deepEqual(addedTitles, ['Queued while offline', 'Second, once back online'], 'the queued commit was flushed along with the new one');
});

test('mustPush refuses to create anything while the remote is unreachable', async () => {
  const origin = await seedShared();
  const alice = await sharedClone(origin, 'trackfile-sync-mustpush-');
  const before = M.parse({ registry: fs.readFileSync(path.join(alice.dataRoot, 'TRACKFILE.md'), 'utf8') });
  git(alice.dataRoot, ['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'trackfile-sync-nonexistent-remote-2')]);
  await assert.rejects(
    transact(alice, { change: addTaskChange('Should not exist'), message: addTaskMessage, mustPush: true, marker: 'alice', ...quiet }),
    /unreachable/
  );
  assert.equal(git(alice.dataRoot, ['status', '--porcelain']).trim(), '', 'nothing was committed');
  const after = M.parse({ registry: fs.readFileSync(path.join(alice.dataRoot, 'TRACKFILE.md'), 'utf8') });
  assert.equal(after.tasks.length, before.tasks.length, 'the task number was not reserved');
});

test('a stale lock is cleared and logged; a fresh lock blocks a concurrent attempt', async () => {
  const origin = await seedShared();
  const alice = await sharedClone(origin, 'trackfile-sync-lock-');
  const file = lockPath(alice);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(file, JSON.stringify({ pid: 999999, marker: 'ghost', time: new Date(Date.now() - STALE_LOCK_MS - 5000).toISOString() }));
  const log = [];
  const result = await transact(alice, { change: addTaskChange('After stale lock'), message: addTaskMessage, mustPush: true, marker: 'alice', log: l => log.push(l) });
  assert.equal(result.pushed, true);
  assert.ok(log.some(l => l.includes('stale lock')));

  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, marker: 'me', time: new Date().toISOString() }));
  await assert.rejects(
    transact(alice, { change: addTaskChange('Blocked'), message: addTaskMessage, mustPush: true, marker: 'other', ...quiet }),
    /locked by/
  );
  fs.rmSync(file, { force: true });
});
