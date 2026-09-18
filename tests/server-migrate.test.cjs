/* #212: the dashboard's own migration wizard — POST /api/git/migrate runs `trackfile migrate --shared`
 * in-process (against a bare remote), the server's own layout flips to shared without a restart, and a
 * repeat call is a no-op instead of an error. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createServer, HOST } = require('../lib/serve.cjs');
const { resolveLayout } = require('../lib/layout.cjs');
const F = require('./fixture.cjs');

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

async function legacyRepoWithRemote() {
  const root = tmp('trackfile-wizard-');
  git(root, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), F.registry());
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'seed']);
  const origin = tmp('trackfile-wizard-origin-');
  git(origin, ['init', '-q', '--bare', '-b', 'main']);
  git(root, ['remote', 'add', 'origin', origin]);
  git(root, ['push', '-q', 'origin', 'main']);
  return { root, origin };
}

async function start(t, layout) {
  const server = createServer(layout);
  await new Promise(r => server.listen(0, HOST, r));
  t.after(() => new Promise(r => server.close(r)));
  return `http://${HOST}:${server.address().port}`;
}

const api = (base, p, init) => fetch(`${base}${p}`, init).then(async r => [r.status, await r.json()]);
const postMigrate = (base, payload = {}) => api(base, '/api/git/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

test('POST /api/git/migrate --dry-run: reports the plan, leaves the repository untouched', async t => {
  const { root } = await legacyRepoWithRemote();
  const layout = resolveLayout(root);
  const base = await start(t, layout);
  const [status, result] = await postMigrate(base, { dryRun: true });
  assert.equal(status, 200);
  assert.equal(result.dryRun, true);
  assert.ok(result.steps.some(s => s.name === 'branch'));
  assert.equal(layout.shared, false, 'the server layout object itself is untouched by a dry run');
  assert.equal(fs.existsSync(path.join(root, '.trackfile.json')), false);
});

test('POST /api/git/migrate: runs a real migration without the dashboard tripping over its own "is a dashboard running" guard, and the server layout updates in place', async t => {
  const { root, origin } = await legacyRepoWithRemote();
  const layout = resolveLayout(root);
  const base = await start(t, layout);
  const [status, result] = await postMigrate(base, { branch: 'trackfile' });
  assert.equal(status, 200);
  assert.equal(result.branch, 'trackfile');
  assert.equal(result.layout.shared, true);
  assert.match(git(origin, ['branch', '--list', 'trackfile']), /trackfile/, 'pushed for real');

  // The *same* running server now reads from the data worktree, no restart needed.
  const [, registry] = await api(base, '/api/registry');
  assert.equal(registry.layout.shared, true);
  assert.match(registry.files.registry, /next_task/);

  // A second call is a friendly no-op, not an error.
  const [again, alreadyResult] = await postMigrate(base);
  assert.equal(again, 200);
  assert.equal(alreadyResult.alreadyMigrated, true);
});

test('POST /api/git/migrate rejects malformed JSON and only accepts POST', async t => {
  const { root } = await legacyRepoWithRemote();
  const base = await start(t, resolveLayout(root));
  assert.equal((await fetch(`${base}/api/git/migrate`, { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await fetch(`${base}/api/git/migrate`)).status, 405);
});
