/* API contract of the local server: registry read, compare-and-swap write, path hygiene, Git views,
 * attachments and commits — on throwaway folders and repositories with synthetic data. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer, HOST } = require('../lib/serve.cjs');
const { resolveLayout } = require('../lib/layout.cjs');

const start = async (t, root) => {
  const server = createServer(resolveLayout(root));
  await new Promise(r => server.listen(0, HOST, r));
  t.after(() => new Promise(r => server.close(r)));
  return `http://${HOST}:${server.address().port}`;
};

test('file API: logical names, compare-and-swap, deletion with text null, whole registry in one request', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trackfile-serve-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'TRACKFILE.md'), 'v1');
  const base = await start(t, root);
  const api = (name, init) => fetch(`${base}/api/file/${name}`, init).then(async r => [r.status, await r.json()]);
  const put = (name, text, expected) => api(name, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, expected }) });

  assert.deepEqual(await api('registry'), [200, { name: 'registry', text: 'v1' }]);
  assert.deepEqual(await api('config'), [200, { name: 'config', text: null }]);
  const [conflict, payload] = await put('registry', 'v2', 'stale');
  assert.equal(conflict, 409, 'mismatched expected must not write'); assert.equal(payload.code, 'conflict'); assert.equal(payload.text, 'v1');
  assert.equal(await fs.readFile(path.join(root, 'TRACKFILE.md'), 'utf8'), 'v1');
  assert.equal((await put('registry', 'v2', 'v1'))[0], 200);
  assert.equal(await fs.readFile(path.join(root, 'TRACKFILE.md'), 'utf8'), 'v2');
  assert.equal((await put('config', '{}', null))[0], 200, 'null expected creates a missing file');
  assert.equal(await fs.readFile(path.join(root, '.trackfile', 'config.json'), 'utf8'), '{}', 'config lives in .trackfile/');
  assert.equal((await put('config', '{}', null))[0], 409, 'null expected refuses an existing file');
  assert.equal((await put('README.md', 'x', null))[0], 404, 'only registry files, comments and the config are writable');
  assert.equal((await put('TRACKFILE.md', 'x', null))[0], 404, 'physical names are not API names');
  assert.equal((await put('comments/176', 'c1', null))[0], 200, 'comments file is created together with its folder');
  assert.equal(await fs.readFile(path.join(root, '.trackfile', 'tasks', '176', 'comments.md'), 'utf8'), 'c1');
  assert.deepEqual(await api('comments/176'), [200, { name: 'comments/176', text: 'c1' }]);
  assert.equal((await put('comments/176', null, 'stale'))[0], 409);
  assert.equal((await put('comments/176', null, 'c1'))[0], 200, 'text null deletes the file');
  assert.equal((await api('comments/176'))[1].text, null);
  assert.equal((await put('comments/176', 'c2', null))[0], 200);
  assert.equal((await put('comments/1', 'x', null))[0], 404, 'task ids have at least three digits');
  assert.equal((await put('archive', 'arch', null))[0], 200);
  assert.equal(await fs.readFile(path.join(root, '.trackfile', 'archive.md'), 'utf8'), 'arch');
  const registry = await fetch(`${base}/api/registry`).then(r => r.json());
  assert.deepEqual(registry.files, { registry: 'v2', archive: 'arch', 'comments/176': 'c2' });
  assert.deepEqual(registry.layout, { registry: 'TRACKFILE.md', archive: '.trackfile/archive.md', tasks: '.trackfile/tasks', config: '.trackfile/config.json', attachmentsPrefix: '.trackfile/tasks', shared: false, dataBranch: null });
  assert.equal((await fetch(`${base}/api/registry`, { method: 'PUT' })).status, 405);
  assert.equal((await api('registry', { method: 'PUT', body: 'not json' }))[0], 400);
  assert.equal((await fs.readdir(root)).filter(f => f.endsWith('.tmp')).length, 0, 'no temp files left behind');

  // Source reader: files come from the repository root, text only, no dotfiles, no escaping the root.
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs', 'note.md'), '# Hi');
  await fs.writeFile(path.join(root, 'docs', 'blob.png'), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(root, 'docs', '.secret'), 'x');
  const src = p => fetch(`${base}/api/source/${p}`).then(async r => [r.status, await r.json()]);
  assert.equal((await src('docs/note.md'))[0], 200);
  assert.equal((await src('docs/note.md'))[1].changes, null, 'outside a git repository changes are null');
  assert.equal((await src('docs/note.md'))[1].markdown, true);
  assert.equal((await src('docs/blob.png'))[0], 415);
  assert.equal((await src('docs/.secret'))[0], 404);
  assert.equal((await src('.trackfile/archive.md'))[0], 404, 'dot folders are not readable as sources');
  assert.equal((await src('docs/missing.md'))[0], 404);
  assert.equal((await src(`..%2F${path.basename(root)}%2Fdocs%2Fnote.md`))[0], 404);
  assert.equal((await fetch(`${base}/api/source/docs/note.md`, { method: 'PUT' })).status, 405);

  // Commit viewer: hex hashes only, read-only, 404 when the folder is not inside a git repository.
  const commit = h => fetch(`${base}/api/commit/${h}`).then(async r => [r.status, await r.json()]);
  assert.equal((await commit('zzz'))[0], 400, 'non-hex refs are rejected before git runs');
  assert.equal((await commit('HEAD'))[0], 400);
  assert.equal((await commit('0123456789abcdef'))[0], 404, 'temp folder is not a repository or has no such commit');
  assert.equal((await fetch(`${base}/api/commit/abcdef`, { method: 'PUT' })).status, 405);

  // Attachments: files under .trackfile/tasks/NNN, strict names, no overwrite, served at /attachments/.
  const files = (p, init) => fetch(`${base}/api/files/${p}`, init).then(async r => [r.status, await r.json().catch(() => ({}))]);
  const upload = (p, bytes) => files(p, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  assert.deepEqual(await files('176'), [200, { taskId: '176', files: [] }], 'a folder with only comments.md is an empty list');
  assert.equal((await files('17'))[0], 404, 'task id needs at least three digits');
  const [upStatus, up] = await upload('176/shot.png', Buffer.from([137, 80, 78, 71]));
  assert.equal(upStatus, 200); assert.equal(up.name, 'shot.png'); assert.equal(up.size, 4); assert.equal(up.image, true); assert.equal(up.path, '.trackfile/tasks/176/shot.png');
  assert.equal(up.hash, null, 'outside git there is no commit'); assert.ok(up.commitError);
  assert.equal((await upload('176/shot.png', Buffer.from([1])))[1].name, 'shot-2.png', 'existing name gets a suffix instead of being overwritten');
  assert.equal(await fs.readFile(path.join(root, '.trackfile', 'tasks', '176', 'shot.png')).then(b => b.length), 4);
  const listed = (await files('176'))[1].files;
  assert.deepEqual(listed.map(f => [f.name, f.size, f.image]), [['shot-2.png', 1, true], ['shot.png', 4, true]], 'comments.md is not listed as an attachment');
  assert.equal((await upload('176/comments.md', Buffer.from([1])))[0], 400, 'comments.md cannot be uploaded or deleted as an attachment');
  assert.equal((await files('176/comments.md', { method: 'DELETE' }))[0], 400);
  assert.ok(listed.every(f => typeof f.modified === 'string'));
  for (const bad of ['176/.env', '176/a%20b.txt', '176/a%2Fb.txt', '176/..', '176/a%23b', '176/x/y']) assert.ok([400, 404].includes((await upload(bad, Buffer.from([1])))[0]), 'rejected: ' + bad);
  assert.equal((await upload('176/empty.txt', Buffer.alloc(0)))[0], 400, 'empty body is not saved');
  assert.equal((await fetch(`${base}/api/files/176/shot.png`, { method: 'POST' })).status, 405);
  const served = await fetch(`${base}/attachments/176/shot.png`);
  assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/attachments/176/comments.md`)).status, 404, 'comments are not served as attachments');
  assert.equal((await fetch(`${base}/attachments/176/..%2F..%2Farchive.md`)).status, 404);
  assert.equal((await files('176/shot-2.png', { method: 'DELETE' }))[0], 200);
  assert.equal((await files('176/shot-2.png', { method: 'DELETE' }))[0], 404);
  assert.deepEqual((await files('176'))[1].files.map(f => f.name), ['shot.png']);
  assert.equal((await fs.readdir(path.join(root, '.trackfile', 'tasks', '176'))).filter(f => f.endsWith('.tmp')).length, 0);

  // Static UI comes from the package, never from the repository.
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/index.html`)).headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal((await fetch(`${base}/assets/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/assets/favicon.svg`)).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await fetch(`${base}/assets/favicon.png`)).headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/TRACKFILE.md`)).status, 404, 'repository files are not static assets');
  assert.equal((await fetch(`${base}/..%2Fsecret`)).status, 404);
  assert.equal((await fetch(`${base}/.hidden`)).status, 404);
  assert.equal((await fetch(`${base}/index.html`, { method: 'POST' })).status, 405);
});

test('a custom layout from the front matter is honoured by every route', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trackfile-layout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'PROJECT'));
  await fs.writeFile(path.join(root, 'PROJECT', 'PROJECT.md'), '---\nschema: 1\nproject: "P"\nnext_task: 1\narchive_file: "PROJECT/ARCHIVE.md"\ntasks_dir: "PROJECT/files"\nconfig_file: "PROJECT/config.json"\n---\n');
  const layout = resolveLayout(root, { registry: 'PROJECT/PROJECT.md' });
  assert.deepEqual([layout.archive, layout.tasks, layout.config, layout.attachmentsPrefix], ['PROJECT/ARCHIVE.md', 'PROJECT/files', 'PROJECT/config.json', 'files']);
  const server = createServer(layout);
  await new Promise(r => server.listen(0, HOST, r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://${HOST}:${server.address().port}`;
  await fetch(`${base}/api/file/comments/042`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'c', expected: null }) });
  assert.equal(await fs.readFile(path.join(root, 'PROJECT', 'files', '042', 'comments.md'), 'utf8'), 'c');
  const up = await fetch(`${base}/api/files/042/a.txt`, { method: 'PUT', body: Buffer.from('x') }).then(r => r.json());
  assert.equal(up.path, 'files/042/a.txt', 'attachment paths are relative to the registry file');
  assert.equal((await fetch(`${base}/api/registry`).then(r => r.json())).layout.attachmentsPrefix, 'files');
});

// Against a throwaway repository: metadata, numstat and a patch the parser understands; commits of registry files only.
test('git views and commits on a real repository', async t => {
  const { execFileSync } = require('node:child_process');
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'trackfile-git-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
  git('init', '-q');
  await fs.writeFile(path.join(repo, 'TRACKFILE.md'), 'initial\n');
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git('add', '.'); git('commit', '-q', '-m', '#001: first');
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\n2\nthree\n');
  await fs.writeFile(path.join(repo, 'b.png'), Buffer.from([0, 1, 2]));
  git('add', '.'); git('commit', '-q', '-m', '#002: second\n\nbody line');
  const hash = git('rev-parse', 'HEAD');
  const base = await start(t, repo);
  const [status, c] = await fetch(`${base}/api/commit/${hash.slice(0, 7)}`).then(async r => [r.status, await r.json()]);
  assert.equal(status, 200);
  assert.equal(c.hash, hash); assert.equal(c.short, hash.slice(0, 7)); assert.equal(c.author, 'T'); assert.equal(c.subject, '#002: second'); assert.equal(c.body, 'body line');
  assert.equal(c.parents.length, 1); assert.equal(c.truncated, false);
  assert.deepEqual(c.files, [{ path: 'a.txt', oldPath: null, additions: 2, deletions: 1, binary: false }, { path: 'b.png', oldPath: null, additions: null, deletions: null, binary: true }]);
  const { parse } = require('../app/assets/diff.js');
  assert.deepEqual(parse(c.patch).map(f => [f.path, f.status, f.binary, f.additions, f.deletions]), [['a.txt', 'modified', false, 2, 1], ['b.png', 'added', true, 0, 0]]);
  assert.equal((await fetch(`${base}/api/commit/${c.parents[0]}`)).status, 200);

  // Task/comment writes get an exact commit message and commit only the registry files named.
  await fs.writeFile(path.join(repo, 'TRACKFILE.md'), 'changed by web app\n');
  await fs.writeFile(path.join(repo, 'a.txt'), 'unrelated working tree change\n');
  const autoCommit = (payload, method = 'POST') => fetch(`${base}/api/git/commit`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then(async r => [r.status, await r.json().catch(() => ({}))]);
  const [autoStatus, auto] = await autoCommit({ operation: 'new task', taskId: '185', title: 'Task title' });
  assert.equal(autoStatus, 200); assert.equal(auto.message, '#185 [new task]: Task title');
  assert.equal(git('show', '-s', '--format=%s', 'HEAD'), '#185 [new task]: Task title');
  assert.equal(git('show', '--format=', '--name-only', 'HEAD'), 'TRACKFILE.md');
  assert.equal(await fs.readFile(path.join(repo, 'a.txt'), 'utf8'), 'unrelated working tree change\n');
  assert.equal((await autoCommit({ operation: 'new task', taskId: '185', title: 'bad\nsubject' }))[0], 400);
  assert.equal((await autoCommit({ operation: 'remove everything', taskId: '185', title: 'Task title' }))[0], 400);
  assert.equal((await fetch(`${base}/api/git/commit`)).status, 405);
  assert.equal((await autoCommit({ operation: 'commented', taskId: '185', title: 'T', files: ['a.txt'] }))[0], 400, 'only registry files may be committed');
  await fs.mkdir(path.join(repo, '.trackfile', 'tasks', '185'), { recursive: true });
  await fs.writeFile(path.join(repo, '.trackfile', 'tasks', '185', 'comments.md'), 'c\n');
  await fs.writeFile(path.join(repo, 'TRACKFILE.md'), 'dirty registry\n');
  const [cStatus, c1] = await autoCommit({ operation: 'commented', taskId: '185', title: 'T', files: ['comments/185'] });
  assert.equal(cStatus, 200); assert.equal(c1.message, '#185 [commented]: T');
  assert.equal(git('show', '--format=', '--name-only', 'HEAD'), '.trackfile/tasks/185/comments.md', 'the registry stays uncommitted');
  await fs.unlink(path.join(repo, '.trackfile', 'tasks', '185', 'comments.md'));
  assert.equal((await autoCommit({ operation: 'delete comment', taskId: '185', title: 'T', files: ['comments/185'] }))[0], 200);
  assert.equal(git('show', '--format=', '--name-status', 'HEAD'), 'D\t.trackfile/tasks/185/comments.md');
  await fs.writeFile(path.join(repo, '.trackfile', 'archive.md'), 'archive\n');
  const [aStatus, arch] = await autoCommit({ operation: 'auto archive', taskIds: ['001', '002'], title: 'auto-archive, tasks: 2', files: ['registry', 'archive'] });
  assert.equal(aStatus, 200); assert.equal(arch.message, '#001 #002 [auto archive]: auto-archive, tasks: 2');
  assert.equal(git('show', '--format=', '--name-only', 'HEAD'), '.trackfile/archive.md\nTRACKFILE.md');
  assert.equal(await fs.readFile(path.join(repo, 'a.txt'), 'utf8'), 'unrelated working tree change\n');
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\n2\nthree\n');

  // Each attachment upload/deletion is its own commit touching only that file.
  await fs.writeFile(path.join(repo, 'a.txt'), 'dirty again\n');
  const uploaded = await fetch(`${base}/api/files/002/note.txt`, { method: 'PUT', body: Buffer.from('hi') }).then(r => r.json());
  assert.equal(uploaded.commitError, null); assert.equal(uploaded.hash, git('rev-parse', 'HEAD'));
  assert.equal(git('show', '-s', '--format=%s', 'HEAD'), '#002 [attach file]: note.txt');
  assert.equal(git('show', '--format=', '--name-only', 'HEAD'), '.trackfile/tasks/002/note.txt');
  assert.equal(await fs.readFile(path.join(repo, 'a.txt'), 'utf8'), 'dirty again\n', 'unrelated changes stay uncommitted');
  const removed = await fetch(`${base}/api/files/002/note.txt`, { method: 'DELETE' }).then(r => r.json());
  assert.equal(removed.commitError, null); assert.equal(git('show', '-s', '--format=%s', 'HEAD'), '#002 [delete file]: note.txt');
  assert.equal(git('show', '--format=', '--name-status', 'HEAD'), 'D\t.trackfile/tasks/002/note.txt');
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\n2\nthree\n');

  // Uncommitted changes of a source file relative to HEAD — clean / modified (-U0 patch) / untracked.
  const src = p => fetch(`${base}/api/source/${p}`).then(r => r.json());
  assert.deepEqual((await src('a.txt')).changes, { status: 'clean', patch: '' });
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\n2\nthree\nfour\n');
  const modified = (await src('a.txt')).changes;
  assert.equal(modified.status, 'modified'); assert.match(modified.patch, /^@@ -3,0 \+4 @@.*\n\+four$/m);
  await fs.writeFile(path.join(repo, 'new.md'), '# new');
  assert.equal((await src('new.md')).changes.status, 'untracked');
  git('add', 'new.md');
  assert.equal((await src('new.md')).changes.status, 'modified', 'staged new file is a diff against HEAD');
});
