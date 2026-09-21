/* Dashboard server in shared-branch mode (#210): /api/git/commit pushes, queues and reports an unpushed
 * count when the remote is unreachable, /api/git/status surfaces it, /api/git/sync flushes the queue, and
 * /api/git/fetch fast-forwards a clean worktree from a second clone's push. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createServer, HOST } = require('../lib/serve.cjs');
const { resolveLayout } = require('../lib/layout.cjs');
const migrate = require('../lib/migrate.cjs');
const M = require('../app/assets/model.js');
const F = require('./fixture.cjs');

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
let nextPort = 47600;

async function sharedRepo() {
  const root = tmp('trackfile-srv-');
  git(root, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), F.registry());
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'seed']);
  const origin = tmp('trackfile-srv-origin-');
  git(origin, ['init', '-q', '--bare', '-b', 'main']);
  git(root, ['remote', 'add', 'origin', origin]);
  git(root, ['push', '-q', 'origin', 'main']);
  await migrate.run({ cwd: root, port: nextPort++, log: () => {} });
  return { root, origin, layout: resolveLayout(root) };
}

async function start(t, layout) {
  const server = createServer(layout);
  await new Promise(r => server.listen(0, HOST, r));
  t.after(() => new Promise(r => server.close(r)));
  return `http://${HOST}:${server.address().port}`;
}

const api = (base, p, init) => fetch(`${base}${p}`, init).then(async r => [r.status, await r.json()]);
const putFile = (base, name, text, expected) => api(base, `/api/file/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, expected }) });
const commitChange = (base, payload) => api(base, '/api/git/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

test('shared: /api/git/commit pushes to the remote, and reports it in the response', async t => {
  const { layout, origin } = await sharedRepo();
  const base = await start(t, layout);
  const before = (await api(base, '/api/file/registry'))[1].text;
  const after = before.replace('title: "Feature one"', 'title: "Feature one, edited"');
  const [putStatus] = await putFile(base, 'registry', after, before);
  assert.equal(putStatus, 200);
  const [status, result] = await commitChange(base, { operation: 'edit task', taskId: '001', title: 'edit', files: ['registry'] });
  assert.equal(status, 200);
  assert.equal(result.pushed, true);
  const doc = M.parse({ registry: git(origin, ['show', 'trackfile:TRACKFILE.md']) });
  assert.equal(doc.byId.get('001').title, 'Feature one, edited');
});

test('shared: an unreachable remote still commits locally, reports pushed:false and an unpushed count, visible via /api/git/status', async t => {
  const { layout } = await sharedRepo();
  const base = await start(t, layout);
  git(layout.dataRoot, ['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'trackfile-srv-nonexistent')]);

  const before = (await api(base, '/api/file/registry'))[1].text;
  const after = before.replace('title: "Feature one"', 'title: "Offline edit"');
  await putFile(base, 'registry', after, before);
  const [status, result] = await commitChange(base, { operation: 'edit task', taskId: '001', title: 'edit', files: ['registry'] });
  assert.equal(status, 200);
  assert.equal(result.pushed, false);
  assert.equal(result.unpushedCount, 1);

  const [, gitStatus] = await api(base, '/api/git/status');
  assert.equal(gitStatus.shared, true);
  assert.equal(gitStatus.unpushed, 1);
});

test('shared: /api/git/sync flushes a queued commit once the remote is reachable again', async t => {
  const { layout, origin } = await sharedRepo();
  const base = await start(t, layout);
  const realUrl = git(layout.dataRoot, ['remote', 'get-url', 'origin']).trim();
  git(layout.dataRoot, ['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'trackfile-srv-nonexistent-2')]);
  const before = (await api(base, '/api/file/registry'))[1].text;
  const after = before.replace('title: "Feature one"', 'title: "Queued edit"');
  await putFile(base, 'registry', after, before);
  await commitChange(base, { operation: 'edit task', taskId: '001', title: 'edit', files: ['registry'] });

  git(layout.dataRoot, ['remote', 'set-url', 'origin', realUrl]);
  const [syncStatus, syncResult] = await api(base, '/api/git/sync', { method: 'POST' });
  assert.equal(syncStatus, 200);
  assert.equal(syncResult.pushed, true);
  const doc = M.parse({ registry: git(origin, ['show', 'trackfile:TRACKFILE.md']) });
  assert.equal(doc.byId.get('001').title, 'Queued edit');

  const [, statusAfter] = await api(base, '/api/git/status');
  assert.equal(statusAfter.unpushed, 0);
});

test('shared: /api/git/fetch fast-forwards a clean worktree after a second clone pushes', async t => {
  const { layout, origin, root } = await sharedRepo();
  const base = await start(t, layout);

  // A second agent, working from a fresh clone, pushes a change to the data branch.
  const other = tmp('trackfile-srv-other-');
  git(other, ['clone', '-q', origin, '.']);
  git(other, ['checkout', '-q', 'trackfile']);
  const otherText = fs.readFileSync(path.join(other, 'TRACKFILE.md'), 'utf8').replace('title: "Feature one"', 'title: "Edited by the other clone"');
  fs.writeFileSync(path.join(other, 'TRACKFILE.md'), otherText);
  git(other, ['add', '-A']);
  git(other, ['-c', 'user.email=b@b.com', '-c', 'user.name=B', 'commit', '-q', '-m', 'edit from elsewhere']);
  git(other, ['push', '-q', 'origin', 'trackfile']);

  assert.doesNotMatch(fs.readFileSync(path.join(layout.dataRoot, 'TRACKFILE.md'), 'utf8'), /Edited by the other clone/, 'not visible yet');
  const [fetchStatus, fetchResult] = await api(base, '/api/git/fetch', { method: 'POST' });
  assert.equal(fetchStatus, 200);
  assert.equal(fetchResult.updated, true);
  assert.match(fs.readFileSync(path.join(layout.dataRoot, 'TRACKFILE.md'), 'utf8'), /Edited by the other clone/, 'the dashboard sees it after fetch');
  const [, registryAfter] = await api(base, '/api/registry');
  assert.match(registryAfter.files.registry, /Edited by the other clone/);
  void root;
});

test('shared: a CAS-only write (no /api/git/commit call) is dirty in /api/git/status and flushed by /api/git/sync', async t => {
  // A low-level API client can write through PUT /api/file without a matching /api/git/commit.
  // That is exactly the case /api/git/sync exists to pick up: the badge must
  // reflect it as unsynced work even though there is no unpushed *commit* yet, and Synchronize must commit
  // and push it like any other pending change.
  const { layout, origin } = await sharedRepo();
  const base = await start(t, layout);
  const before = (await api(base, '/api/file/registry'))[1].text;
  const after = before.replace('title: "Feature one"', 'title: "Renamed without a matching /api/git/commit"');
  await putFile(base, 'registry', after, before);

  const [, statusBefore] = await api(base, '/api/git/status');
  assert.equal(statusBefore.dirty, true);
  assert.equal(statusBefore.unpushed, 0);

  const [syncStatus, syncResult] = await api(base, '/api/git/sync', { method: 'POST' });
  assert.equal(syncStatus, 200);
  assert.equal(syncResult.pushed, true);
  const [, statusAfter] = await api(base, '/api/git/status');
  assert.equal(statusAfter.dirty, false);
  assert.match(git(origin, ['show', 'trackfile:TRACKFILE.md']), /Renamed without a matching \/api\/git\/commit/);
});

test('legacy mode: the new git/status/fetch/sync endpoints report shared:false and do nothing', async t => {
  const root = tmp('trackfile-srv-legacy-');
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), F.registry());
  const base = await start(t, resolveLayout(root));
  assert.deepEqual((await api(base, '/api/git/status'))[1], { shared: false, unpushed: 0, dirty: false });
  assert.deepEqual((await api(base, '/api/git/fetch', { method: 'POST' }))[1], { shared: false });
  assert.deepEqual((await api(base, '/api/git/sync', { method: 'POST' }))[1], { shared: false });
});

test('dashboard default mutations commit and push status, labels, relationships and project metadata', async t => {
  const Store = require('../app/assets/storage.js');
  const commands = require('../lib/commands.cjs');
  const { layout, origin } = await sharedRepo();
  const base = await start(t, layout), store = new Store(base);
  const mutations = [
    doc => M.setStatus(doc, '001', 'in_progress'),
    doc => M.setTaskLabels(doc, '001', ['L01']),
    doc => M.setRelationships(doc, '001', { blockedBy: ['007'] }),
    doc => M.setArchiveAfterDays(doc, 30),
    doc => M.addMilestone(doc, { title: 'New milestone', body: 'Goal' }).changes,
  ];
  for (const mutate of mutations) {
    const before = await store.readAll(), changes = mutate(M.parse(before));
    const head = git(layout.dataRoot, ['rev-parse', 'HEAD']).trim();
    for (const [name, text] of Object.entries(changes)) await store.write(name, text, before[name] ?? null);
    const result = await store.recordMutation(before, changes);
    assert.equal(result.pushed, true);
    assert.notEqual(result.hash, head);
    assert.equal(git(layout.dataRoot, ['status', '--porcelain']).trim(), '');
    assert.equal(git(origin, ['rev-parse', 'trackfile']).trim(), result.hash);
  }
  const doc = M.parse({ registry: git(origin, ['show', 'trackfile:TRACKFILE.md']) });
  assert.equal(doc.byId.get('001').status, 'in_progress');
  assert.deepEqual(doc.byId.get('001').labels, ['L01']);
  assert.deepEqual(doc.byId.get('001').blocked_by, ['007']);
  assert.equal(doc.meta.archive_after_days, 30);
  assert.ok(doc.milestones.some(m => m.title === 'New milestone'));
  assert.equal((await commands.setField(layout, '002', 'status', 'review', { marker: 'alice' })).pushed, true, 'UI actions must not leave a dirty tree blocking the CLI');
});
