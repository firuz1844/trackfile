/* Agent CLI commands (#208): new/take/set/comment/sync/status on a real shared-branch fixture, and the
 * spec's own scenario — an agent takes a task, the user cancels it through the file, and the agent's
 * `review` transition (a `set status review`) is refused with an explanation instead of silently landing. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const commands = require('../lib/commands.cjs');
const { resolveLayout } = require('../lib/layout.cjs');
const migrate = require('../lib/migrate.cjs');
const M = require('../app/assets/model.js');
const F = require('./fixture.cjs');

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const quiet = { log: () => {} };
let nextPort = 47400;

async function sharedRepo() {
  const root = tmp('trackfile-cmd-');
  git(root, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), F.registry());
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'seed']);
  const origin = tmp('trackfile-cmd-origin-');
  git(origin, ['init', '-q', '--bare', '-b', 'main']);
  git(root, ['remote', 'add', 'origin', origin]);
  git(root, ['push', '-q', 'origin', 'main']);
  await migrate.run({ cwd: root, port: nextPort++, ...quiet });
  return { root, origin, layout: resolveLayout(root) };
}

test('new allocates a number, prints it only after a successful push', async () => {
  const { layout, origin } = await sharedRepo();
  const result = await commands.newTask(layout, { title: 'From the CLI', marker: 'alice', ...quiet });
  assert.match(result.id, /^\d{3,}$/);
  assert.equal(result.pushed, true);
  const doc = M.parse({ registry: git(origin, ['show', 'trackfile:TRACKFILE.md']) });
  assert.equal(doc.byId.get(result.id).title, 'From the CLI');
});

test('take sets in_progress/assignee/branch and refuses a task already taken by someone else', async () => {
  const { layout, root } = await sharedRepo();
  git(root, ['checkout', '-q', '-b', 'feature/x']);
  const result = await commands.take(layout, '001', { marker: 'alice', root, ...quiet });
  assert.equal(result.applied, true);
  const doc = M.parse({ registry: fs.readFileSync(path.join(layout.dataRoot, 'TRACKFILE.md'), 'utf8') });
  const t = doc.byId.get('001');
  assert.equal(t.status, 'in_progress'); assert.equal(t.assignee, 'alice'); assert.equal(t.branch, 'feature/x');

  await assert.rejects(commands.take(layout, '001', { marker: 'bob', root, ...quiet }), /already in_progress, assigned to alice/);
});

test('set changes a field and comment appends a comment, both validated before committing', async () => {
  const { layout, origin } = await sharedRepo();
  await commands.setField(layout, '001', 'title', 'Renamed via CLI', { marker: 'alice', ...quiet });
  await commands.comment(layout, '001', 'a note from the CLI', { marker: 'alice', ...quiet });
  const registryText = git(origin, ['show', 'trackfile:TRACKFILE.md']);
  assert.equal(M.parse({ registry: registryText }).byId.get('001').title, 'Renamed via CLI');
  const commentsText = git(origin, ['show', `trackfile:.trackfile/tasks/001/comments.md`]);
  assert.match(commentsText, /a note from the CLI/);
});

test('set on an array field (labels) accepts a comma-separated list', async () => {
  const { layout } = await sharedRepo();
  await commands.setField(layout, '001', 'labels', 'L01, L02', { marker: 'alice', ...quiet });
  const doc = M.parse({ registry: fs.readFileSync(path.join(layout.dataRoot, 'TRACKFILE.md'), 'utf8') });
  assert.deepEqual(doc.byId.get('001').labels, ['L01', 'L02']);
});

test("scenario: an agent takes a task, the user cancels it by hand, and the agent's review transition is refused", async () => {
  const { layout, root } = await sharedRepo();
  const taken = await commands.take(layout, '001', { marker: 'claude', root, ...quiet });
  assert.equal(taken.applied, true);

  // The user edits the file directly (as the protocol allows) and syncs it — this is *not* going through
  // the agent's own take/set commands, simulating "the user changed the record out from under the agent".
  const registryPath = path.join(layout.dataRoot, 'TRACKFILE.md');
  const before = fs.readFileSync(registryPath, 'utf8');
  const doc = M.parse({ registry: before });
  const t = doc.byId.get('001');
  const cancelled = before.slice(0, t.start) + before.slice(t.start, t.end).replace('status: "in_progress"', 'status: "cancelled"') + before.slice(t.end);
  fs.writeFileSync(registryPath, cancelled);
  const synced = await commands.sync(layout, { marker: 'user', ...quiet });
  assert.equal(synced.pushed, true);

  // The agent, unaware, tries to move the task to review — refused, with the drift explained.
  await assert.rejects(
    commands.setField(layout, '001', 'status', 'review', { marker: 'claude', ...quiet }),
    error => { assert.match(error.message, /changed since you took it/); assert.match(error.message, /status/); return true; }
  );
  // With --acknowledge (after re-reading), the agent's write is allowed to proceed.
  const acked = await commands.setField(layout, '001', 'status', 'review', { marker: 'claude', acknowledge: true, ...quiet });
  assert.equal(acked.applied, true);
});

test('sync commits and pushes a hand-edit; status reports unpushed commits and drift on the agent\'s own task', async () => {
  const { layout, origin, root } = await sharedRepo();
  await commands.take(layout, '002', { marker: 'claude', root, ...quiet });

  // Simulate a network partition: nothing pushes until the remote comes back.
  const realUrl = git(layout.dataRoot, ['remote', 'get-url', 'origin']).trim();
  git(layout.dataRoot, ['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'trackfile-cmd-nonexistent')]);
  await commands.setField(layout, '002', 'result', 'partial progress', { marker: 'claude', ...quiet });
  let status = await commands.status(layout, { marker: 'claude' });
  assert.equal(status.unpushed, 1);

  git(layout.dataRoot, ['remote', 'set-url', 'origin', realUrl]);
  status = await commands.status(layout, { marker: 'claude' });
  assert.equal(status.unpushed, 1, 'status() itself fetches, but does not flush anything');
  const flushed = await commands.sync(layout, { marker: 'claude', ...quiet }); // no dirty tree, but a queued commit to send
  assert.equal(flushed.pushed, true);
  const doc = M.parse({ registry: git(origin, ['show', 'trackfile:TRACKFILE.md']) });
  assert.equal(doc.byId.get('002').result, 'partial progress', 'the queued commit reached the remote via sync');
});

test('sync pulls a remote-only change into a clean worktree even with a stale tracking ref', async () => {
  const { layout, origin } = await sharedRepo();
  const other = tmp('trackfile-cmd-pull-');
  git(other, ['clone', '-q', '--branch', 'trackfile', origin, '.']);
  const file = path.join(other, 'TRACKFILE.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Feature one', 'Changed remotely'));
  git(other, ['add', '-A']);
  git(other, ['-c', 'user.email=b@b.com', '-c', 'user.name=B', 'commit', '-qm', 'remote edit']);
  git(other, ['push', '-q', 'origin', 'trackfile']);
  const remoteHead = git(other, ['rev-parse', 'HEAD']).trim();
  assert.notEqual(git(layout.dataRoot, ['rev-parse', 'origin/trackfile']).trim(), remoteHead);
  const result = await commands.sync(layout, quiet);
  assert.equal(result.pushed, true);
  assert.equal(git(layout.dataRoot, ['rev-parse', 'HEAD']).trim(), remoteHead);
  assert.equal(M.parse({ registry: fs.readFileSync(path.join(layout.dataRoot, 'TRACKFILE.md'), 'utf8') }).byId.get('001').title, 'Changed remotely');
  assert.equal(git(layout.dataRoot, ['status', '--porcelain']).trim(), '');
});

test('multiline comments retain their text, commit a single-line subject, and allow subsequent edits', async () => {
  const { layout, origin } = await sharedRepo();
  const text = 'First paragraph.\n\nSecond paragraph.\r\n- item';
  const result = await commands.comment(layout, '001', text, { marker: 'alice', ...quiet });
  assert.equal(result.pushed, true);
  const comments = git(origin, ['show', 'trackfile:.trackfile/tasks/001/comments.md']);
  assert.equal(M.parseComments(comments)[0].text, text.replace(/\r\n/g, '\n'));
  assert.equal(git(layout.dataRoot, ['log', '-1', '--format=%s']).trim(), '#001 [commented]: First paragraph. Second paragraph. - item');
  assert.equal(git(layout.dataRoot, ['status', '--porcelain']).trim(), '');
  const next = await commands.setField(layout, '001', 'status', 'review', { marker: 'alice', ...quiet });
  assert.equal(next.pushed, true);
});

test('sync merges local archiving with remote edits and publishes a valid registry/archive pair', async () => {
  const { readRegistryFiles } = require('../lib/layout.cjs');
  const { layout, origin } = await sharedRepo();
  const other = tmp('trackfile-cmd-archive-');
  git(other, ['clone', '-q', '--branch', 'trackfile', origin, '.']);
  const otherFile = path.join(other, 'TRACKFILE.md');
  fs.writeFileSync(otherFile, fs.readFileSync(otherFile, 'utf8').replace('Feature one', 'Remote feature'));
  git(other, ['add', '-A']);
  git(other, ['-c', 'user.email=b@b.com', '-c', 'user.name=B', 'commit', '-qm', 'remote title']);
  git(other, ['push', '-q', 'origin', 'trackfile']);
  const doc = M.parse(readRegistryFiles(layout)), changes = M.archive(doc, ['008']);
  const { diskPath } = require('../lib/layout.cjs');
  for (const [name, text] of Object.entries(changes)) {
    const file = diskPath(layout, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  git(layout.dataRoot, ['add', '-A']);
  assert.equal((await commands.sync(layout, quiet)).pushed, true);
  const published = M.parse({ registry: git(origin, ['show', 'trackfile:TRACKFILE.md']), archive: git(origin, ['show', 'trackfile:.trackfile/archive.md']) });
  assert.equal(published.byId.get('008').archived, true);
  assert.equal(published.byId.get('001').title, 'Remote feature');
  assert.equal(published.tasks.filter(task => task.id === '008').length, 1);
  assert.equal(git(layout.dataRoot, ['status', '--porcelain']).trim(), '');
});

test('sync refuses to publish a merge that violates references across records', async () => {
  const { readRegistryFiles } = require('../lib/layout.cjs');
  const { layout, origin } = await sharedRepo();
  const other = tmp('trackfile-cmd-invalid-merge-');
  git(other, ['clone', '-q', '--branch', 'trackfile', origin, '.']);
  const otherFile = path.join(other, 'TRACKFILE.md');
  const remoteDoc = M.parse({ registry: fs.readFileSync(otherFile, 'utf8') });
  fs.writeFileSync(otherFile, M.setTaskLabels(remoteDoc, '007', ['L02']).registry);
  git(other, ['add', '-A']);
  git(other, ['-c', 'user.email=b@b.com', '-c', 'user.name=B', 'commit', '-qm', 'use label']);
  git(other, ['push', '-q', 'origin', 'trackfile']);
  const remoteHead = git(origin, ['rev-parse', 'trackfile']);
  const localDoc = M.parse(readRegistryFiles(layout));
  fs.writeFileSync(path.join(layout.dataRoot, 'TRACKFILE.md'), M.deleteLabel(localDoc, 'L02').registry);
  await assert.rejects(commands.sync(layout, quiet), error => error.code === 'label_missing');
  assert.equal(git(origin, ['rev-parse', 'trackfile']), remoteHead, 'invalid merged data must never be pushed');
  await assert.rejects(commands.sync(layout, quiet), error => error.code === 'label_missing');
  assert.equal(git(origin, ['rev-parse', 'trackfile']), remoteHead, 'retry must not publish the invalid local merge either');
});
