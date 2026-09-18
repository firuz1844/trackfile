/* Structural registry merge (#207): a duplicate id gets renumbered against the current next_task, edits to
 * different tasks merge cleanly, an owner conflict on `status`/`result` is resolved or reported, and a
 * cycle introduced by the merge is caught. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeRegistryText, MergeConflictError, parseBlocks } = require('../lib/merge.cjs');
const M = require('../app/assets/model.js');

const now = '2026-01-01T10:00:00+00:00';
const registry = ({ nextTask = 3, tasks = [] } = {}) => {
  const body = tasks.map(t => {
    const data = { id: t.id, title: t.title, kind: 'task', parent: t.parent ?? null, milestone: null, status: t.status ?? 'to-do', author: 'User', assignee: t.assignee ?? null, created_at: now, updated_at: t.updated_at ?? now, completed_at: null, branch: t.branch ?? null, commit: null, result: t.result ?? '', sources: [], ...(t.extra || {}) };
    return `### TASK ${t.id}\n\`\`\`yaml\n${Object.entries(data).map(([k, v]) => `${k}: ${Array.isArray(v) ? '[' + v.map(x => JSON.stringify(x)).join(', ') + ']' : JSON.stringify(v)}`).join('\n')}\n\`\`\`\n\n`;
  }).join('');
  return `---\nschema: 1\nproject: "P"\nnext_task: ${nextTask}\n---\n\n# P\n\n## Tasks\n\n${body}`;
};

test('a duplicate task id (independently created on both sides) gets renumbered against the current next_task', () => {
  const base = registry({ nextTask: 3, tasks: [{ id: '001', title: 'Old' }] });
  const ours = registry({ nextTask: 3, tasks: [{ id: '001', title: 'Old' }, { id: '002', title: 'Ours new' }] });
  const theirs = registry({ nextTask: 4, tasks: [{ id: '001', title: 'Old' }, { id: '002', title: 'Theirs new' }, { id: '003', title: 'Also theirs' }] });
  const { text, taskRemap } = mergeRegistryText(base, ours, theirs, { renumberTasks: true });
  assert.deepEqual([...taskRemap.entries()], [['002', '004']]);
  const doc = M.parse({ registry: text });
  assert.equal(doc.meta.next_task, 5);
  const titles = doc.tasks.map(t => [t.id, t.title]).sort();
  assert.deepEqual(titles, [['001', 'Old'], ['002', 'Theirs new'], ['003', 'Also theirs'], ['004', 'Ours new']]);
});

test('edits to different tasks merge cleanly with no conflict', () => {
  const base = registry({ tasks: [{ id: '001', title: 'A' }, { id: '002', title: 'B' }] });
  const ours = registry({ tasks: [{ id: '001', title: 'A renamed by us', updated_at: '2026-01-02T00:00:00+00:00' }, { id: '002', title: 'B' }] });
  const theirs = registry({ tasks: [{ id: '001', title: 'A' }, { id: '002', title: 'B', status: 'done', updated_at: '2026-01-02T00:00:00+00:00' }] });
  const { text } = mergeRegistryText(base, ours, theirs, { renumberTasks: true });
  const doc = M.parse({ registry: text });
  assert.equal(doc.byId.get('001').title, 'A renamed by us');
  assert.equal(doc.byId.get('002').status, 'done');
});

test('an owner conflict: a user-side cancel wins over an agent-side in_progress', () => {
  const base = registry({ tasks: [{ id: '001', title: 'A', status: 'to-do' }] });
  const ours = registry({ tasks: [{ id: '001', title: 'A', status: 'in_progress', assignee: 'Claude', updated_at: '2026-01-02T00:00:00+00:00' }] });
  const theirs = registry({ tasks: [{ id: '001', title: 'A', status: 'cancelled', updated_at: '2026-01-02T00:00:00+00:00' }] });
  const { text } = mergeRegistryText(base, ours, theirs);
  assert.equal(M.parse({ registry: text }).byId.get('001').status, 'cancelled');
});

test('an unresolvable status conflict (two different agent transitions) is reported, not guessed', () => {
  const base = registry({ tasks: [{ id: '001', title: 'A', status: 'to-do' }] });
  const ours = registry({ tasks: [{ id: '001', title: 'A', status: 'in_progress' }] });
  const theirs = registry({ tasks: [{ id: '001', title: 'A', status: 'review' }] });
  assert.throws(() => mergeRegistryText(base, ours, theirs), error => {
    assert.ok(error instanceof MergeConflictError);
    assert.deepEqual(error.conflicts, [{ id: '001', field: 'status', ours: 'in_progress', theirs: 'review' }]);
    return true;
  });
});

test('an unresolvable result conflict is reported', () => {
  const base = registry({ tasks: [{ id: '001', title: 'A', result: '' }] });
  const ours = registry({ tasks: [{ id: '001', title: 'A', result: 'done via X' }] });
  const theirs = registry({ tasks: [{ id: '001', title: 'A', result: 'done via Y' }] });
  assert.throws(() => mergeRegistryText(base, ours, theirs), MergeConflictError);
});

test('branch/commit/sources conflicts resolve to whichever side edited most recently', () => {
  const base = registry({ tasks: [{ id: '001', title: 'A', branch: null }] });
  const ours = registry({ tasks: [{ id: '001', title: 'A', branch: 'ours-branch', updated_at: '2026-01-03T00:00:00+00:00' }] });
  const theirs = registry({ tasks: [{ id: '001', title: 'A', branch: 'theirs-branch', updated_at: '2026-01-02T00:00:00+00:00' }] });
  const { text } = mergeRegistryText(base, ours, theirs);
  assert.equal(M.parse({ registry: text }).byId.get('001').branch, 'ours-branch');
});

test('labels/blocked_by/relates_to conflicts union both sides instead of dropping either edit', () => {
  const base = registry({ nextTask: 4, tasks: [{ id: '001', title: 'A' }, { id: '002', title: 'B' }, { id: '003', title: 'C' }] });
  const ours = registry({ nextTask: 4, tasks: [{ id: '001', title: 'A', extra: { blocked_by: ['002'] } }, { id: '002', title: 'B' }, { id: '003', title: 'C' }] });
  const theirs = registry({ nextTask: 4, tasks: [{ id: '001', title: 'A', extra: { blocked_by: ['003'] } }, { id: '002', title: 'B' }, { id: '003', title: 'C' }] });
  const { text } = mergeRegistryText(base, ours, theirs);
  assert.deepEqual(M.parse({ registry: text }).byId.get('001').blocked_by.sort(), ['002', '003']);
});

test('a cycle introduced purely by the merge (each side reparents the other half of a swap) is caught', () => {
  const base = registry({ tasks: [{ id: '001', title: 'A' }, { id: '002', title: 'B' }] });
  const ours = registry({ tasks: [{ id: '001', title: 'A', parent: '002', updated_at: '2026-01-02T00:00:00+00:00' }, { id: '002', title: 'B' }] });
  const theirs = registry({ tasks: [{ id: '001', title: 'A' }, { id: '002', title: 'B', parent: '001', updated_at: '2026-01-02T00:00:00+00:00' }] });
  assert.throws(() => mergeRegistryText(base, ours, theirs), /cycle/);
});

test('a plain two-branch git merge with the merge driver produces a conflict-free result', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trackfile-merge-git-')));
  const git = (args) => execFileSync('git', ['-C', tmp, ...args], { encoding: 'utf8' });
  fs.writeFileSync(path.join(tmp, 'TRACKFILE.md'), registry({ tasks: [{ id: '001', title: 'A' }] }));
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']); git(['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', 'theirs']);
  fs.writeFileSync(path.join(tmp, 'TRACKFILE.md'), registry({ nextTask: 4, tasks: [{ id: '001', title: 'A' }, { id: '002', title: 'Theirs new' }] }));
  git(['add', '-A']); git(['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'theirs adds 002']);
  git(['checkout', '-q', 'main']);
  git(['checkout', '-q', '-b', 'ours']);
  fs.writeFileSync(path.join(tmp, 'TRACKFILE.md'), registry({ tasks: [{ id: '001', title: 'A', status: 'done', updated_at: '2026-01-02T00:00:00+00:00' }] }));
  git(['add', '-A']); git(['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'ours closes 001']);

  fs.writeFileSync(path.join(tmp, '.gitattributes'), 'TRACKFILE.md merge=trackfile-merge\n');
  git(['add', '.gitattributes']); git(['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'attrs']);
  git(['checkout', '-q', 'theirs']);
  fs.writeFileSync(path.join(tmp, '.gitattributes'), 'TRACKFILE.md merge=trackfile-merge\n');
  git(['add', '.gitattributes']); git(['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'attrs']);
  git(['config', 'merge.trackfile-merge.name', 'trackfile structural merge']);
  git(['config', 'merge.trackfile-merge.driver', `node ${path.join(__dirname, '..', 'bin', 'trackfile.js')} merge-driver %O %A %B`]);

  git(['merge', '-q', '--no-edit', 'ours']);
  const merged = fs.readFileSync(path.join(tmp, 'TRACKFILE.md'), 'utf8');
  const doc = M.parse({ registry: merged });
  assert.equal(doc.byId.get('001').status, 'done');
  assert.ok(doc.tasks.some(t => t.title === 'Theirs new'));
  assert.equal(git(['status', '--porcelain']).trim(), '', 'the merge produced a clean commit, no leftover conflict markers');
});
