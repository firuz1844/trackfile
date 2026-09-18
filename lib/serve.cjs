/* Local dashboard server. Zero dependencies, loopback only.
 * Serves the bundled UI from the package and exposes the registry files of one repository for read and
 * compare-and-swap write, plus read-only Git views (sources, commits) and task attachments. The browser
 * never needs a directory picker: the repository is the one the CLI was started in. */
'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const M = require('../app/assets/model.js');
const { relativeOf, diskPath, taskDir, publicLayout, lockPath, resolveLayout } = require('./layout.cjs');
const sync = require('./sync.cjs');
const commands = require('./commands.cjs');
const migrate = require('./migrate.cjs');
const DASHBOARD_MARKER = 'dashboard';

const HOST = '127.0.0.1';
const APP_DIR = path.resolve(__dirname, '..', 'app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.heic': 'image/heic', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' };

// Every API error carries a stable code (translated by the dashboard) and an English message.
const MESSAGES = {
  body_too_big: 'Request body is too big',
  bad_path: 'Invalid path: {path}',
  outside_repo: 'Path is outside the repository',
  not_text: 'Only text files can be viewed: {path}',
  file_not_found: 'File not found: {path}',
  not_a_file: 'Not a file: {path}',
  source_too_big: 'File is bigger than 2 MB: {path}',
  bad_hash: 'Expected a hex commit hash: {ref}',
  not_git: 'The repository folder is not a Git repository',
  commit_not_found: 'Commit not found: {ref}',
  bad_change: 'Expected JSON {operation, taskId, title}',
  bad_change_fields: 'Invalid operation/taskId/title',
  bad_change_files: 'files: only the registry, the archive and comments files can be committed',
  git_commit_failed: 'Git did not create a commit for {files}',
  bad_attachment_route: 'Expected /api/files/<task id>[/<file name>]',
  bad_file_name: 'Invalid file name',
  file_name_rules: 'Invalid file name: no spaces, slashes or :#?%*"<>| characters, must not start with a dot, up to 200 characters',
  comments_not_attachment: 'comments.md holds the task comments; edit it from the task page',
  file_too_big: 'File is bigger than {limit} MB',
  empty_file: 'An empty file is not saved',
  attachment_not_found: 'File not found: {name}',
  git_attachment_failed: 'Git did not create a commit for the file',
  git_push_conflict: 'Committed locally, but pushing to the shared branch needs manual attention: {detail}',
  git_locked: 'Another write to the shared branch is in progress ({marker}) — retry shortly.',
  git_unreachable: 'The shared branch’s remote could not be reached; {count} commit(s) are queued locally.',
  bad_migrate: 'Expected JSON {branch?, remote?, local?, push?, dryRun?}',
  migrate_failed: 'Migration failed: {detail}',
  not_editable: 'File is not available through the API: {name}',
  bad_write: 'Expected JSON {text, expected}',
  bad_write_types: 'Fields text/expected have the wrong type',
  conflict: '{name} was changed by another editor. Reload; your draft stays in the form.'
};
const format = (template, params) => template.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? `{${key}}`);
const failure = (code, params = {}, extra = {}) => ({ error: format(MESSAGES[code], params), code, params, ...extra });

// Writes to one file are serialized in-process; the expected text is compared right before the rename.
// The queue alone only coordinates this one Node process — #206's `.sync.lock` (shared by CLI agents and
// any other dashboard instance on this machine) wraps the actual work too, so nothing outside this process
// can commit to the same data worktree mid-write either.
const queues = new Map();
function serialized(layout, name, work) {
  const next = (queues.get(name) || Promise.resolve()).catch(() => {}).then(async () => {
    const lock = lockPath(layout);
    await sync.acquireLock(lock, DASHBOARD_MARKER, () => {});
    try { return await work(); } finally { sync.releaseLock(lock); }
  });
  queues.set(name, next);
  return next;
}
async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
function json(res, status, value) { send(res, status, JSON.stringify(value), 'application/json; charset=utf-8'); }
function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) { reject(new Error(MESSAGES.body_too_big)); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Read-only view of repository files referenced by tasks' `sources`: plain text files only, never
// dotfiles/.git, never anything outside the repository root.
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.swift', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.yaml', '.yml', '.toml', '.sh', '.css', '.html', '.xml', '.plist', '.entitlements', '.py', '.rb', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.m', '.mm', '.kt', '.java', '.cs', '.php', '.sql', '.csv', '.gitignore', '.editorconfig']);
async function source(req, res, layout, relative) {
  if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); return res.end(); }
  const repo = layout.root;
  const segments = relative.split('/');
  if (!relative || segments.some(seg => !seg || seg === '.' || seg === '..' || (seg.startsWith('.') && seg !== '.gitignore' && seg !== '.editorconfig'))) return json(res, 404, failure('bad_path', { path: relative }));
  const file = path.resolve(repo, relative);
  if (!file.startsWith(repo + path.sep)) return json(res, 404, failure('outside_repo'));
  const ext = path.extname(file).toLowerCase() || path.basename(file);
  if (!TEXT_EXT.has(ext) && !TEXT_EXT.has('.' + ext)) return json(res, 415, failure('not_text', { path: relative }));
  let stat;
  try { stat = await fs.stat(file); } catch { return json(res, 404, failure('file_not_found', { path: relative })); }
  if (!stat.isFile()) return json(res, 404, failure('not_a_file', { path: relative }));
  if (stat.size > 2 * 1024 * 1024) return json(res, 413, failure('source_too_big', { path: relative }));
  const text = await fs.readFile(file, 'utf8');
  return json(res, 200, { path: relative, text, size: stat.size, markdown: ext === '.md' || ext === '.markdown', changes: await uncommitted(repo, relative) });
}
// Uncommitted changes of a file relative to HEAD (index + working tree) for the reader's highlighting.
// -U0 keeps only the changed lines; outside a git repository the result is null, a clean file has no patch.
async function uncommitted(repo, relative) {
  try {
    const tracked = (await git(repo, ['ls-files', '--', relative])).trim() !== '';
    if (!tracked) {
      const inHead = await git(repo, ['ls-tree', '--name-only', 'HEAD', '--', relative]).then(s => s.trim() !== '', () => false);
      if (!inHead) return { status: 'untracked', patch: '' };
    }
    const patch = await git(repo, ['diff', 'HEAD', '--no-color', '-U0', '--', relative]);
    return patch ? { status: 'modified', patch } : { status: 'clean', patch: '' };
  } catch { return null; }
}

// Commit page by hash: metadata, numstat and unified diff from `git`. Read-only; the hash is validated by
// a regular expression and passed as an argument (no shell).
const PATCH_LIMIT = 4 * 1024 * 1024;
function git(repo, args, maxBuffer = PATCH_LIMIT * 2) {
  return new Promise((resolve, reject) => execFile('git', ['-C', repo, ...args], { maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
}
async function commit(req, res, layout, ref) {
  if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); return res.end(); }
  if (!/^[0-9a-f]{4,40}$/i.test(ref)) return json(res, 400, failure('bad_hash', { ref }));
  const repo = layout.root;
  let hash;
  try { hash = (await git(repo, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'])).trim(); }
  catch (error) { return json(res, 404, /not a git repository/i.test(error.stderr || '') ? failure('not_git') : failure('commit_not_found', { ref })); }
  const [meta, stat] = await Promise.all([
    git(repo, ['show', '-s', '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%P%x00%s%x00%b', hash]),
    git(repo, ['show', '--format=', '--numstat', '-M', '--first-parent', hash])
  ]);
  const [full, short, author, email, date, parents, subject, message] = meta.split('\0');
  const files = stat.split('\n').filter(Boolean).map(line => {
    const [a, d, ...rest] = line.split('\t'); const name = rest.join('\t');
    // numstat writes renames as `dir/{old => new}` or `old => new`.
    const m = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(name) || /^(.*) => (.*)$/.exec(name);
    const oldPath = m ? (m.length === 5 ? m[1] + m[2] + m[4] : m[1]) : null, newPath = m ? (m.length === 5 ? m[1] + m[3] + m[4] : m[2]) : name;
    return { path: newPath, oldPath, additions: a === '-' ? null : Number(a), deletions: d === '-' ? null : Number(d), binary: a === '-' };
  });
  let patch = await git(repo, ['show', '--format=', '--no-color', '-M', '--first-parent', '-p', hash]);
  const truncated = patch.length > PATCH_LIMIT;
  if (truncated) patch = patch.slice(0, PATCH_LIMIT);
  return json(res, 200, { hash: full, short, author, email, date, parents: parents ? parents.split(' ') : [], subject, body: message.replace(/\n+$/, ''), files, patch, truncated });
}

// The dashboard may commit only the registry files it just wrote, never unrelated changes. The message is
// assembled from validated fields and every git argument is passed without a shell. `files` lists logical
// names (registry, archive, comments/NNN); `taskIds` may hold several numbers (`#001 #002 [auto archive]: …`).
const CHANGE_OPERATIONS = new Set(['new task', 'commented', 'edit task', 'edit comment', 'delete comment', 'archive', 'unarchive', 'auto archive']);
const committable = name => name === M.REGISTRY || name === M.ARCHIVE || M.COMMENTS_FILE.test(name);
async function recordChange(req, res, layout) {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
  let payload;
  try { payload = JSON.parse(await body(req)); } catch { return json(res, 400, failure('bad_change')); }
  const operation = payload.operation, title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const taskIds = Array.isArray(payload.taskIds) ? payload.taskIds : [payload.taskId];
  const files = payload.files === undefined ? [M.REGISTRY] : payload.files;
  if (!CHANGE_OPERATIONS.has(operation) || !taskIds.length || taskIds.length > 200 || !taskIds.every(id => typeof id === 'string' && /^\d+$/.test(id)) || !title || title.length > 240 || /[\r\n\0]/.test(title)) {
    return json(res, 400, failure('bad_change_fields'));
  }
  if (!Array.isArray(files) || !files.length || files.length > 200 || !files.every(f => typeof f === 'string' && committable(f))) return json(res, 400, failure('bad_change_files'));
  const repo = layout.dataRoot, relatives = [...new Set(files)].map(f => relativeOf(layout, f));
  return serialized(layout, M.REGISTRY, async () => {
    let hash, message;
    try {
      message = `${taskIds.map(id => '#' + id).join(' ')} [${operation}]: ${title}`;
      // add -A also stages the deletion of a comments file; --only limits the commit to these paths.
      await git(repo, ['add', '-A', '--', ...relatives]);
      await git(repo, ['commit', '--only', '-m', message, '--', ...relatives]);
      hash = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    } catch (error) {
      const detail = (error.stderr || '').trim();
      return json(res, 409, detail ? { error: detail, code: null } : failure('git_commit_failed', { files: relatives.join(', ') }));
    }
    if (!layout.shared) return json(res, 200, { hash, message });
    try {
      const pushResult = sync.pushWithMergeFallback(repo, layout.pointer.remote, layout.pointer.branch);
      return json(res, 200, { hash, message, pushed: pushResult.pushed, unpushedCount: pushResult.unpushedCount ?? 0 });
    } catch (error) {
      // The commit itself succeeded and is not undone — only the push/merge failed, needing a human.
      return json(res, 200, { hash, message, pushed: false, ...failure('git_push_conflict', { detail: error.message }) });
    }
  });
}

// The whole registry in one request — the registry, the archive (null when absent) and every task's
// comments — so the client does not issue one request per task on load and on every poll.
async function registry(req, res, layout) {
  if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); return res.end(); }
  const files = { [M.REGISTRY]: await readOptional(diskPath(layout, M.REGISTRY)), [M.ARCHIVE]: await readOptional(diskPath(layout, M.ARCHIVE)) };
  let dirs = [];
  try { dirs = await fs.readdir(path.join(layout.dataRoot, layout.tasks)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const dir of dirs.sort()) {
    if (!/^\d{3,}$/.test(dir)) continue;
    const text = await readOptional(path.join(taskDir(layout, dir), 'comments.md'));
    if (text !== null) files[M.commentsFile(dir)] = text;
  }
  return json(res, 200, { layout: publicLayout(layout), files, liveAssignees: commands.liveAssignees(layout) });
}

// #210: git status/fetch/sync for the shared data branch — no-ops (shared:false) in the legacy layout, so
// the dashboard can call these unconditionally and just read `shared` to decide whether to show anything.
async function gitStatus(req, res, layout) {
  if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); return res.end(); }
  if (!layout.shared) return json(res, 200, { shared: false, unpushed: 0, dirty: false });
  const result = await commands.status(layout, { marker: DASHBOARD_MARKER });
  return json(res, 200, { shared: true, unpushed: result.unpushed, dirty: result.dirty });
}
// Background poll (#210): fetch, fast-forward only, and only when the worktree is clean — never resets or
// merges on the dashboard's own initiative, so it can run unattended every 30s without surprising a person
// mid-edit. A dirty worktree or a fast-forward that isn't possible (real divergence) is silently skipped;
// the "Synchronize" button below is the deliberate action for anything beyond a plain fast-forward.
async function gitFetch(req, res, layout) {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
  if (!layout.shared) return json(res, 200, { shared: false });
  return serialized(layout, 'git-fetch', async () => {
    const repo = layout.dataRoot, { remote, branch } = layout.pointer;
    const fetched = await git(repo, ['fetch', '-q', remote, branch]).then(() => true, () => false);
    let updated = false;
    if (fetched && !sync.isDirty(repo)) updated = await git(repo, ['merge', '--ff-only', '-q', `${remote}/${branch}`]).then(() => true, () => false);
    return json(res, 200, { shared: true, fetched, updated });
  });
}
// The "Synchronize" button (#210): flushes any queued commit and fetches, through the same lock/merge-
// fallback path as `trackfile sync` — the one action here that may create a merge commit, so it is explicit
// rather than run automatically in the background.
async function gitSync(req, res, layout) {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
  if (!layout.shared) return json(res, 200, { shared: false });
  try {
    const result = await commands.sync(layout, { marker: DASHBOARD_MARKER });
    return json(res, 200, { shared: true, ...result });
  } catch (error) { return json(res, 409, { error: error.message, code: null }); }
}

// Task attachments are ordinary files in the task folder, never listed in the registry: the list is read
// from disk, names are validated strictly (no path separators, whitespace or URL-special characters, so a
// `tasks/NNN/name` link in Markdown is valid without escaping), writes go through a temp file and rename.
// Each upload/deletion is committed on its own (only that path), like registry edits.
const FILE_LIMIT = 25 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);
const validTaskId = id => /^\d{3,}$/.test(id);
const validFileName = name => typeof name === 'string' && name.length > 0 && name.length <= 200 && !name.startsWith('.') && !/[\s\x00-\x1f\x7f/\\:#?%*"<>|]/.test(name) && name !== '..';
function rawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error(format(MESSAGES.file_too_big, { limit: limit / 1024 / 1024 })), { status: 413, code: 'file_too_big', params: { limit: limit / 1024 / 1024 } })); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function commitAttachment(layout, relative, message) {
  const repo = layout.dataRoot;
  try {
    await git(repo, ['add', '--', relative]).catch(() => {}); // after a deletion `add` is unnecessary and fails — not an error
    await git(repo, ['commit', '--only', '-m', message, '--', relative]);
    const hash = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    if (!layout.shared) return { hash, commitError: null };
    try {
      const pushResult = sync.pushWithMergeFallback(repo, layout.pointer.remote, layout.pointer.branch);
      return { hash, commitError: null, pushed: pushResult.pushed, unpushedCount: pushResult.unpushedCount ?? 0 };
    } catch (error) { return { hash, commitError: null, pushed: false, pushError: error.message }; }
  } catch (error) { return { hash: null, commitError: (error.stderr || error.message || '').trim() || MESSAGES.git_attachment_failed }; }
}
async function attachments(req, res, layout, rest) {
  const [taskId, encodedName, ...extra] = rest.split('/');
  if (!validTaskId(taskId) || extra.length) return json(res, 404, failure('bad_attachment_route'));
  const dir = taskDir(layout, taskId), repo = layout.dataRoot;
  if (!encodedName) {
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); return res.end(); }
    let names;
    try { names = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return json(res, 200, { taskId, files: [] }); throw e; }
    const files = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (name.startsWith('.') || name === 'comments.md') continue; // the comments file is not an attachment
      const stat = await fs.stat(path.join(dir, name));
      if (stat.isFile()) files.push({ name, size: stat.size, modified: stat.mtime.toISOString(), image: IMAGE_EXT.has(path.extname(name).toLowerCase()) });
    }
    return json(res, 200, { taskId, files });
  }
  let name;
  try { name = decodeURIComponent(encodedName); } catch { return json(res, 400, failure('bad_file_name')); }
  if (!validFileName(name)) return json(res, 400, failure('file_name_rules'));
  if (name === 'comments.md') return json(res, 400, failure('comments_not_attachment'));
  if (req.method === 'PUT') {
    let data;
    try { data = await rawBody(req, FILE_LIMIT); } catch (error) { return json(res, error.status || 400, { error: error.message, code: error.code ?? null, params: error.params ?? {} }); }
    if (!data.length) return json(res, 400, failure('empty_file'));
    return serialized(layout, 'files/' + taskId, async () => {
      await fs.mkdir(dir, { recursive: true });
      // An existing name is never overwritten: a -2, -3… suffix is added and the final name returned.
      const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
      let final = name;
      for (let n = 2; await readable(path.join(dir, final)); n++) final = `${stem}-${n}${ext}`;
      const tmp = path.join(dir, `.${final}.${process.pid}.tmp`);
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, path.join(dir, final));
      const relative = path.relative(repo, path.join(dir, final));
      const committed = await commitAttachment(layout, relative, `#${taskId} [attach file]: ${final}`);
      return json(res, 200, { taskId, name: final, size: data.length, image: IMAGE_EXT.has(ext.toLowerCase()), path: `${layout.attachmentsPrefix}/${taskId}/${final}`, ...committed });
    });
  }
  if (req.method === 'DELETE') {
    return serialized(layout, 'files/' + taskId, async () => {
      const file = path.join(dir, name), relative = path.relative(repo, file);
      // A file git does not track (placed by hand) is deleted without a commit.
      const tracked = await git(repo, ['ls-files', '--', relative]).then(out => out.trim() !== '', () => false);
      try { await fs.unlink(file); } catch (e) { if (e.code === 'ENOENT') return json(res, 404, failure('attachment_not_found', { name })); throw e; }
      const committed = tracked ? await commitAttachment(layout, relative, `#${taskId} [delete file]: ${name}`) : { hash: null, commitError: null };
      return json(res, 200, { taskId, name, ...committed });
    });
  }
  res.writeHead(405, { allow: 'PUT, DELETE' }); res.end();
}
async function readable(file) { try { await fs.access(file); return true; } catch { return false; } }

const editable = name => name === 'config' || committable(name);
function createServer(layout) {
  async function api(req, res, name) {
    if (!editable(name)) return json(res, 404, failure('not_editable', { name }));
    const file = diskPath(layout, name);
    if (req.method === 'GET') {
      const text = await readOptional(file);
      return json(res, 200, { name, text });
    }
    if (req.method === 'PUT') {
      let payload;
      try { payload = JSON.parse(await body(req)); } catch { return json(res, 400, failure('bad_write')); }
      // text: null deletes the file (the task's last comment was removed) — with the same `expected` check.
      if ((typeof payload.text !== 'string' && payload.text !== null) || (payload.expected !== null && typeof payload.expected !== 'string')) return json(res, 400, failure('bad_write_types'));
      return serialized(layout, name, async () => {
        const current = await readOptional(file);
        if (current !== payload.expected) return json(res, 409, failure('conflict', { name: M.label(name) }, { text: current }));
        if (payload.text === null) { if (current !== null) await fs.unlink(file); return json(res, 200, { name, text: null }); }
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
        await fs.writeFile(tmp, payload.text, 'utf8');
        await fs.rename(tmp, file);
        return json(res, 200, { name, text: payload.text });
      });
    }
    res.writeHead(405, { allow: 'GET, PUT' }); res.end();
  }

  // #212: the dashboard's migration wizard — the one place `layout` (this closure's own variable, not a
  // fresh read) gets reassigned after a real migration, so every request dispatched after this one sees
  // the new dataRoot without restarting the server. skipDashboardCheck: migrate's own "is a dashboard
  // running" guard would otherwise trip on this very process — see lib/migrate.cjs.
  async function gitMigrate(req, res) {
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
    if (layout.shared) return json(res, 200, { shared: true, alreadyMigrated: true, layout: publicLayout(layout) });
    let payload;
    try { const text = await body(req); payload = text.trim() ? JSON.parse(text) : {}; } catch { return json(res, 400, failure('bad_migrate')); }
    const lines = [];
    try {
      const result = await migrate.run({
        cwd: layout.root,
        branch: typeof payload.branch === 'string' && payload.branch.trim() ? payload.branch.trim() : 'trackfile',
        remote: typeof payload.remote === 'string' && payload.remote.trim() ? payload.remote.trim() : 'origin',
        local: Boolean(payload.local), push: Boolean(payload.push), dryRun: Boolean(payload.dryRun),
        skipDashboardCheck: true, log: line => lines.push(line),
      });
      if (!payload.dryRun && !result.alreadyMigrated) layout = resolveLayout(layout.root, { registry: layout.registry });
      return json(res, 200, { ...result, lines, layout: publicLayout(layout) });
    } catch (error) { return json(res, 409, { ...failure('migrate_failed', { detail: error.message }), lines }); }
  }

  async function serveFile(req, res, base, relative) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const file = path.normalize(path.join(base, relative));
    if (!file.startsWith(base + path.sep) || path.basename(file).startsWith('.')) return send(res, 404, 'Not found');
    let data;
    try { data = await fs.readFile(file); } catch { return send(res, 404, 'Not found'); }
    send(res, 200, req.method === 'HEAD' ? '' : data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${HOST}`);
      const p = url.pathname;
      if (p.startsWith('/api/file/')) return await api(req, res, decodeURIComponent(p.slice('/api/file/'.length)));
      if (p === '/api/registry') return await registry(req, res, layout);
      if (p.startsWith('/api/source/')) return await source(req, res, layout, decodeURIComponent(p.slice('/api/source/'.length)));
      if (p.startsWith('/api/commit/')) return await commit(req, res, layout, p.slice('/api/commit/'.length));
      if (p === '/api/git/status') return await gitStatus(req, res, layout);
      if (p === '/api/git/fetch') return await gitFetch(req, res, layout);
      if (p === '/api/git/sync') return await gitSync(req, res, layout);
      if (p === '/api/git/migrate') return await gitMigrate(req, res);
      if (p === '/api/git/commit') return await recordChange(req, res, layout);
      if (p.startsWith('/api/files/')) return await attachments(req, res, layout, p.slice('/api/files/'.length));
      // Attachments are served from the task folder of the repository, the UI from the package.
      const attachment = /^\/attachments\/(\d{3,})\/([^/]+)$/.exec(p);
      if (attachment) { const name = decodeURIComponent(attachment[2]); return validFileName(name) && name !== 'comments.md' ? await serveFile(req, res, taskDir(layout, attachment[1]), name) : send(res, 404, 'Not found'); }
      return await serveFile(req, res, APP_DIR, decodeURIComponent(p === '/' ? '/index.html' : p));
    } catch (error) { json(res, 500, { error: error.message, code: null }); }
  });
}

function listen(layout, { port = 3737, open = false, log = console.log, onError = console.error } = {}) {
  const server = createServer(layout);
  server.listen(port, HOST, () => {
    const address = `http://${HOST}:${port}/`;
    const dataLine = layout.shared ? `\nData branch: ${layout.pointer.branch} (${layout.dataRoot})` : '';
    log(`Trackfile dashboard: ${address}\nRepository: ${layout.root}${dataLine}\nRegistry: ${layout.registry}\nPress Ctrl+C to stop.`);
    if (open) {
      const opener = process.platform === 'darwin' ? ['open', [address]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', address]] : ['xdg-open', [address]];
      spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  });
  server.on('error', error => {
    onError(error.code === 'EADDRINUSE' ? `Port ${port} is busy. The dashboard may already be running: open http://${HOST}:${port}/ or pass --port.` : error.message);
    process.exit(1);
  });
  return server;
}

module.exports = { createServer, listen, HOST, MESSAGES };
