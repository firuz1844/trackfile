/* Registry model contract on a synthetic registry: parsing rules, progress, editing and archiving.
 * Nothing here reads a real project's data. */
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../app/assets/model.js');
const F = require('./fixture.cjs');
const source = F.registry();
const parsed = () => M.parse(F.files());
const withRegistry = text => M.parse({ ...F.files(), registry: text });
const after = (doc, changes) => M.apply(doc, changes);
const now = '2099-01-01T00:00:00Z';
const code = c => e => e.code === c;

test('parses the synthetic registry: tasks, milestones, comments, effective milestones', () => {
  const d = parsed();
  assert.equal(d.tasks.length, 10); assert.equal(d.milestones.length, 2); assert.equal(d.meta.project, 'Sample');
  assert.equal(M.milestoneOf(d, d.byId.get('002')), 'M01', 'inherited from the parent feature');
  assert.equal(M.milestoneOf(d, d.byId.get('007')), null);
  assert.deepEqual(d.byId.get('002').comments.map(c => [c.id, c.author, c.done]), [[1, 'User', false]]);
  assert.equal(d.byId.get('002').body, 'Description of the free task.\n\n#### Check\n- item one');
  assert.equal(M.parse(source).tasks.length, 10, 'a bare string is the registry alone');
});
test('supports CRLF and rejects unknown schema / corrupt YAML / duplicate fields', () => {
  assert.equal(withRegistry(source.replaceAll('\n', '\r\n')).tasks.length, 10);
  assert.throws(() => M.parse(source.replace('schema: 1', 'schema: 2')), code('schema'));
  assert.throws(() => M.yaml('title: "a"\ntitle: "b"'), code('yaml_field'));
  assert.throws(() => M.yaml('title: |\n  hello'), code('yaml_quotes'));
  assert.throws(() => M.parse(source.replace('### TASK 001', '### task 001')), code('headings'));
  assert.throws(() => M.parse('no front matter'), code('front_matter'));
  assert.throws(() => M.parse({}), code('no_registry'));
});
test('rejects repeated task IDs, missing parents, cycles, missing milestones, bad statuses and counter', () => {
  const d = parsed(), a = d.byId.get('003');
  assert.throws(() => withRegistry(source + a.raw), code('duplicate_id'));
  assert.throws(() => withRegistry(source.replace('parent: "001"', 'parent: "999999"')), code('parent_missing'));
  assert.throws(() => withRegistry(source.replace('id: "001"\ntitle: "Feature one"\nkind: "feature"\nparent: null', 'id: "001"\ntitle: "Feature one"\nkind: "feature"\nparent: "002"')), code('cycle'));
  assert.throws(() => withRegistry(source.replace('milestone: "M02"', 'milestone: "M99"')), code('milestone_missing'));
  assert.throws(() => withRegistry(source.replace('status: "done"', 'status: "unknown"')), code('status'));
  assert.throws(() => withRegistry(source.replace(/next_task: \d+/, 'next_task: 1')), code('next_task'));
  assert.throws(() => withRegistry(source.replace('assignee: "Codex"', 'assignee: null')), code('assignee_required'));
  assert.throws(() => withRegistry(source.replace('priority: "normal"', 'priority: "urgent"')), code('priority'));
});
test('errors carry a code and params; messages are formatted in English', () => {
  try { M.setStatus(parsed(), '999', 'done'); assert.fail('should throw'); }
  catch (e) { assert.equal(e.code, 'task_not_found'); assert.deepEqual(e.params, { id: '999' }); assert.equal(e.message, 'Task not found: 999'); }
});
test('edit is surgical, preserves creation, implementation evidence and unrelated raw records', () => {
  const d = parsed(), t = d.byId.get('002');
  const updated = after(d, M.editTask(d, t.id, 'New "name" <script>', 'Body\n\n#### Criterion\n- check input', now));
  const next = updated.byId.get(t.id);
  assert.equal(next.author, 'User'); assert.equal(next.created_at, t.created_at); assert.equal(next.updated_at, now);
  assert.equal(next.title, 'New "name" <script>'); assert.deepEqual(next.sources, t.sources);
  for (const other of d.tasks.filter(other => other.id !== t.id)) assert.equal(updated.byId.get(other.id).raw, other.raw);
});
test('unknown metadata survives user editing', () => {
  const d = parsed(), t = d.byId.get('002');
  const withExtra = withRegistry(source.slice(0, t.start) + t.raw.replace('kind:', 'custom_flag: true\nkind:') + source.slice(t.end));
  assert.equal(after(withExtra, M.editTask(withExtra, t.id, 'Title', 'Body', now)).byId.get(t.id).data.custom_flag, true);
});
test('cannot edit assigned, in-progress, review, completed or archived tasks', () => {
  const d = parsed();
  for (const t of d.tasks.filter(t => t.status !== 'to-do')) assert.throws(() => M.editTask(d, t.id, 'a', 'b', now), code('task_locked'));
  const t = d.byId.get('002');
  const assigned = withRegistry(source.slice(0, t.start) + t.raw.replace('assignee: null', 'assignee: "Claude"') + source.slice(t.end));
  assert.throws(() => M.editTask(assigned, t.id, 'a', 'b', now), code('task_locked'));
});
test('record injection and blank titles cannot corrupt the registry', () => {
  const d = parsed();
  assert.throws(() => M.editTask(d, '002', '', 'body', now), code('title_length'));
  assert.throws(() => M.editTask(d, '002', 'Title', '### TASK 999', now), code('reserved_headings'));
  assert.throws(() => M.addTask(d, { title: 'Title', body: '## Tasks' }, now), code('reserved_headings'));
});
test('creation allocates a stable ID, records User and leaves other tasks intact', () => {
  const d = parsed(), added = M.addTask(d, { title: 'New', body: 'Check', parent: '001' }, now), next = after(d, added.changes), t = next.byId.get(added.id);
  assert.deepEqual(Object.keys(added.changes), ['registry'], 'a new task touches only the registry');
  assert.equal(t.id, '011'); assert.equal(next.meta.next_task, 12);
  assert.equal(t.author, 'User'); assert.equal(t.status, 'to-do'); assert.equal(t.assignee, null);
  assert.equal(t.created_at, now); assert.equal(M.milestoneOf(next, t), 'M01');
  for (const old of d.tasks) assert.deepEqual(next.byId.get(old.id).data, old.data);
});
test('creation rejects missing or removed parents', () => {
  assert.throws(() => M.addTask(parsed(), { title: 'New', body: '', parent: '999' }, now), code('parent_unavailable'));
  assert.throws(() => M.addTask(parsed(), { title: 'New', body: '', parent: '004' }, now), code('parent_unavailable'));
});
test('progress counts leaves only, excludes removed descendants and review', () => {
  const d = parsed(), p = M.progress(d);
  // Leaves: 002, 003, 005, 006, 007, 008, 010 (004 removed, 001/009 are parents) → done: 003, 008.
  assert.deepEqual(p, { total: 7, done: 2, percent: 29, active: 1, review: 1 });
  assert.deepEqual(M.progress(d, 'M01'), { total: 3, done: 2, percent: 67, active: 0, review: 0 });
  assert.deepEqual(M.progress(d, 'M99'), { total: 0, done: 0, percent: 0, active: 0, review: 0 });
  assert.deepEqual(M.progress(d, null, '001'), { total: 2, done: 1, percent: 50, active: 0, review: 0 });
});
test('config drops stale IDs, deduplicates expansion and normalizes invalid filters', () => {
  const d = parsed(), c = M.cleanConfig({ schema: 1, expanded: ['003', '999999', '003'], selected: '99999', status: 'foo', milestone: 'M99', search: 'abc', theme: 'dark', sort: 'updated', lang: 'ru' }, d);
  assert.deepEqual(c.expanded, ['003']); assert.equal(c.selected, null); assert.deepEqual(c.statuses, []); assert.equal(c.milestone, 'all'); assert.equal(c.theme, 'dark'); assert.equal(c.lang, 'ru');
  assert.equal(M.cleanConfig({ schema: 1, lang: 'de' }, d).lang, null, 'unknown language falls back to the browser');
  const entry = d.byId.get('003'), removed = withRegistry(source.slice(0, entry.start) + source.slice(entry.end));
  assert.deepEqual(M.cleanConfig(c, removed).expanded, []);
});
test('config keeps multiple status filters and migrates the legacy filter', () => {
  const d = parsed();
  assert.deepEqual(M.cleanConfig({ schema: 1, statuses: ['done', 'review', 'done', 'unknown'] }, d).statuses, ['done', 'review']);
  assert.deepEqual(M.cleanConfig({ schema: 1, status: 'cancelled' }, d).statuses, ['cancelled']);
  assert.deepEqual(M.cleanConfig({ schema: 1, status: 'all' }, d).statuses, []);
  const milestone = M.cleanConfig({ schema: 1, milestoneStatuses: ['to-do', 'done', 'to-do', 'unknown'], milestoneSort: 'id' }, d);
  assert.deepEqual(milestone.milestoneStatuses, ['to-do', 'done']); assert.equal(milestone.milestoneSort, 'id');
  assert.deepEqual(M.defaults().milestoneStatuses, []); assert.equal(M.defaults().milestoneSort, 'updated');
  assert.equal(M.defaults().sort, 'updated'); assert.equal(M.cleanConfig({ schema: 1, sort: 'unknown' }, d).sort, 'updated');
});
test('milestone edit is surgical; new milestone gets the next M-id inside the milestones section', () => {
  const d = parsed(), m = d.milestones[0];
  const edited = after(d, M.editMilestone(d, m.id, 'New name', 'Description\n\n#### Goal'));
  assert.equal(edited.byMilestone.get(m.id).title, 'New name'); assert.equal(edited.byMilestone.get(m.id).body, 'Description\n\n#### Goal');
  for (const other of d.milestones.filter(o => o.id !== m.id)) assert.equal(edited.byMilestone.get(other.id).raw, other.raw);
  for (const t of d.tasks) assert.equal(edited.byId.get(t.id).raw, t.raw);
  assert.throws(() => M.editMilestone(d, m.id, 'x', '### TASK 999'), code('reserved_headings'));
  const added = M.addMilestone(d, { title: 'Third' });
  const next = after(d, added.changes);
  assert.equal(added.id, 'M03'); assert.equal(next.milestones.length, 3); assert.equal(next.milestones.at(-1).id, 'M03');
  assert.ok(next.byMilestone.get('M03').start < next.tasks[0].start, 'milestone lands before the tasks section');
  assert.throws(() => M.addMilestone(d, { title: '' }), code('title_length'));
});
test('first milestone lands under the milestones heading of an empty registry (English or Russian heading)', () => {
  for (const heading of ['## Milestones', '## Майлстоуны']) {
    const empty = M.parse(`---\nschema: 1\nproject: "P"\nnext_task: 1\n---\n\n# P\n\n${heading}\n\n## Tasks\n`);
    const { changes, id } = M.addMilestone(empty, { title: 'First' });
    const next = after(empty, changes);
    assert.equal(id, 'M01'); assert.equal(next.milestones.length, 1);
    assert.match(next.text, new RegExp(`${heading}\\n\\n### MILESTONE M01\\n`));
  }
  assert.throws(() => M.addMilestone(M.parse('---\nschema: 1\nproject: "P"\nnext_task: 1\n---\n\n## Tasks\n'), { title: 'x' }), code('no_milestone_section'));
});
test('setMilestone rewrites only the changed tasks, keeps author, accepts null and rejects unknown ids', () => {
  const d = parsed();
  const next = after(d, M.setMilestone(d, ['001', '003', '001'], 'M02', now));
  assert.equal(next.byId.get('001').milestone, 'M02'); assert.equal(next.byId.get('003').milestone, 'M02');
  assert.equal(next.byId.get('003').author, 'Codex'); assert.equal(next.byId.get('003').updated_at, now); assert.equal(next.byId.get('003').result, 'Verified by tests.');
  for (const t of d.tasks.filter(t => !['001', '003'].includes(t.id))) assert.equal(next.byId.get(t.id).raw, t.raw);
  assert.deepEqual(M.setMilestone(d, ['001'], 'M01', now), {}, 'no-op returns no changes');
  assert.equal(after(d, M.setMilestone(d, ['001'], null, now)).byId.get('001').milestone, null);
  assert.throws(() => M.setMilestone(d, ['001'], 'M99'), code('milestone_not_found'));
  assert.throws(() => M.setMilestone(d, ['999999'], null), code('task_not_found'));
});
test('rewritten records keep hand-written whitespace: no blank-line growth for empty bodies, spaced arrays', () => {
  const d = parsed(), m = d.milestones.find(m => !m.body);
  assert.deepEqual(M.editMilestone(d, m.id, m.title, m.body), {}, 'no-op edit of an empty-body milestone is byte-identical');
  const t = d.byId.get('002');
  assert.deepEqual(M.editTask(d, t.id, t.title, t.body, t.updated_at), {}, 're-saving an unchanged User task is byte-identical');
});
test('editTask can set or clear the milestone and the parent, and rejects unknown ones', () => {
  const d = parsed(), t = d.byId.get('002');
  assert.equal(after(d, M.editTask(d, t.id, t.title, t.body, now, { milestone: 'M02' })).byId.get(t.id).milestone, 'M02');
  assert.equal(after(d, M.editTask(d, t.id, t.title, t.body, now, { milestone: null })).byId.get(t.id).milestone, null);
  assert.equal(after(d, M.editTask(d, t.id, t.title, t.body, now)).byId.get(t.id).milestone, t.milestone, 'omitted milestone is untouched');
  assert.throws(() => M.editTask(d, t.id, t.title, t.body, now, { milestone: 'M99' }), code('milestone_not_found'));
  assert.equal(after(d, M.editTask(d, t.id, t.title, t.body, now)).byId.get(t.id).parent, '001');
  assert.equal(after(d, M.editTask(d, t.id, t.title, t.body, now, { parent: '007' })).byId.get(t.id).parent, '007');
  assert.equal(after(d, M.editTask(d, t.id, t.title, t.body, now, { parent: null })).byId.get(t.id).parent, null);
  assert.throws(() => M.editTask(d, t.id, t.title, t.body, now, { parent: t.id }), code('self_parent'));
});
test('config keeps hideDone, pins and collapsed nodes, dropping ids that no longer exist', () => {
  const d = parsed();
  const c = M.cleanConfig({ schema: 1, hideDone: true, pinnedTasks: ['001', '001', '999999'], pinnedMilestones: ['M99', 'M01'], milestoneCollapsed: ['003', '999999', '003'], view: 'milestone', selectedMilestone: 'M02', showArchive: true }, d);
  assert.equal(c.hideDone, true); assert.deepEqual(c.pinnedTasks, ['001']); assert.deepEqual(c.pinnedMilestones, ['M01']); assert.deepEqual(c.milestoneCollapsed, ['003']);
  assert.equal(c.view, 'milestone'); assert.equal(c.showArchive, true);
  const empty = M.cleanConfig({ schema: 1, hideDone: 'yes', pinnedTasks: 'x', view: 'milestone', selectedMilestone: 'M99' }, d);
  assert.equal(empty.hideDone, false); assert.deepEqual(empty.pinnedTasks, []); assert.equal(empty.view, 'dashboard'); assert.equal(empty.selectedMilestone, null);
  assert.equal(M.complete({ total: 3, done: 3 }), true); assert.equal(M.complete({ total: 0, done: 0 }), false);
});
test('setStatus changes only status fields; done stamps completed_at, leaving done clears it, in_progress assigns User', () => {
  const d = parsed(), t = d.byId.get('002');
  const done = after(d, M.setStatus(d, t.id, 'done', now)).byId.get(t.id);
  assert.equal(done.status, 'done'); assert.equal(done.completed_at, now); assert.equal(done.updated_at, now);
  assert.equal(done.author, t.author); assert.equal(done.assignee, null); assert.equal(done.body, t.body);
  const reopened = after(d, M.setStatus(d, '003', 'review', now)).byId.get('003');
  assert.equal(reopened.status, 'review'); assert.equal(reopened.completed_at, null); assert.equal(reopened.commit, 'abc1234');
  assert.equal(after(d, M.setStatus(d, t.id, 'in_progress', now)).byId.get(t.id).assignee, 'User');
  assert.deepEqual(M.setStatus(d, t.id, 'to-do', now), {}, 'same status is a no-op');
  assert.throws(() => M.setStatus(d, t.id, 'bogus', now), code('unknown_status'));
  assert.throws(() => M.setStatus(d, '999999', 'done', now), code('task_not_found'));
});
test('task comments append, edit, delete in the comments file and survive task rewrites', () => {
  const d = parsed(), task = d.byId.get('007'), file = M.commentsFile(task.id);
  assert.equal(file, 'comments/007');
  const first = M.addComment(d, task.id, 'First remark', 'User', now);
  assert.deepEqual(Object.keys(first), [file], 'only the comments file changes');
  const one = after(d, first);
  assert.equal(one.byId.get(task.id).raw, task.raw, 'the registry record is untouched');
  assert.deepEqual(one.byId.get(task.id).comments, [{ id: 1, author: 'User', updated_at: now, done: false, text: 'First remark' }]);
  const later = '2099-01-02T00:00:00Z';
  const two = after(one, M.addComment(one, task.id, 'Agent reply with a reference #7.1', 'Codex', later));
  const edited = after(two, M.editComment(two, task.id, 1, 'Refined remark', later));
  assert.equal(edited.byId.get(task.id).comments[0].author, 'User'); assert.equal(edited.byId.get(task.id).comments[0].updated_at, later);
  assert.equal(edited.byId.get(task.id).comments[1].id, 2); assert.equal(edited.byId.get(task.id).comments[1].author, 'Codex');
  const rewritten = after(edited, M.setMilestone(edited, [task.id], 'M02', later)).byId.get(task.id);
  assert.equal(rewritten.comments.length, 2); assert.equal(rewritten.body, task.body);
  const completed = after(edited, M.setCommentDone(edited, task.id, 1, true, later));
  assert.equal(completed.byId.get(task.id).comments[0].done, true); assert.match(completed.files[file], /^#### COMMENT 1 \[x\]$/m);
  assert.deepEqual(M.setCommentDone(completed, task.id, 1, true, later), {}, 'same state is a no-op');
  const deleted = after(edited, M.deleteComment(edited, task.id, 1));
  assert.deepEqual(deleted.byId.get(task.id).comments.map(comment => comment.id), [2], 'remaining permanent references do not shift');
  const afterDelete = after(deleted, M.addComment(deleted, task.id, 'Third comment', 'User', later));
  assert.deepEqual(afterDelete.byId.get(task.id).comments.map(comment => comment.id), [2, 3], 'deleted ids are not reused');
  assert.deepEqual(M.deleteComment(one, task.id, 1), { [file]: null }, 'the last comment removes the file');
  assert.throws(() => M.addComment(d, task.id, '   '), code('comment_blank'));
  assert.throws(() => M.editComment(one, task.id, 2, 'x'), code('comment_not_found'));
  assert.throws(() => M.setCommentDone(one, task.id, 1, 'yes'), code('comment_done_type'));
  assert.throws(() => M.deleteComment(one, task.id, 2), code('comment_not_found'));
  // Format: a comment inside the registry, a file for a missing task and prose outside blocks are errors.
  assert.throws(() => withRegistry(source.slice(0, task.end) + '#### COMMENT 1 [ ]\n```yaml\nid: 1\nauthor: "User"\nupdated_at: "' + now + '"\n```\n\nText\n\n' + source.slice(task.end)), code('comments_in_registry'));
  assert.throws(() => M.parse({ ...F.files(), 'comments/999999': one.files[file] }), code('comments_orphan'));
  assert.throws(() => M.parse({ ...F.files(), [file]: 'prose\n\n' + one.files[file] }), code('comments_prose'));
  assert.throws(() => M.parse({ ...F.files(), 'other': 'x' }), code('unknown_file'));
});
test('archive moves closed tasks to the archive and back; auto-archive respects the week, unarchived_at and open subtasks', () => {
  const d = parsed(), done = d.byId.get('008');
  const changes = M.archive(d, done.id, now);
  assert.deepEqual(Object.keys(changes).sort(), ['archive', 'registry']);
  const a = after(d, changes), moved = a.byId.get(done.id);
  assert.equal(moved.archived, true); assert.equal(moved.file, 'archive'); assert.equal(moved.archived_at, now); assert.equal(moved.body, done.body);
  assert.deepEqual({ ...moved.data, archived_at: undefined }, { ...done.data, archived_at: undefined }, 'record fields are carried over unchanged');
  for (const other of d.tasks.filter(t => t.id !== done.id)) assert.equal(a.byId.get(other.id).raw, other.raw, 'other records are byte-identical');
  assert.equal(a.tasks.length, d.tasks.length, 'the union keeps every task'); assert.equal(M.progress(a).total, M.progress(d).total, 'progress counts archived tasks');
  assert.ok(!a.text.includes(`### TASK ${done.id}\n`)); assert.match(a.files.archive, /^archive: true$/m); assert.match(a.files.archive, /^## Tasks$/m);
  assert.throws(() => M.archive(a, done.id), code('already_archived'));
  assert.throws(() => M.archive(d, '002'), code('archive_open'));
  assert.throws(() => M.archive(d, '009'), code('archive_subtasks'));
  // Return: archived_at goes away, unarchived_at is set, auto-archive skips such a task until its status changes.
  const later = '2099-01-20T00:00:00Z';
  const back = after(a, M.unarchive(a, done.id, later)), returned = back.byId.get(done.id);
  assert.equal(returned.archived, false); assert.equal(returned.archived_at, undefined); assert.equal(returned.unarchived_at, later); assert.equal(returned.updated_at, later);
  assert.throws(() => M.unarchive(back, done.id), code('not_archived'));
  assert.ok(!M.archiveCandidates(back, '2099-03-01T00:00:00Z').includes(done.id), 'manually returned task is not auto-archived');
  const reopenedDoc = after(back, M.setStatus(back, done.id, 'review', later)), reopened = reopenedDoc.byId.get(done.id);
  assert.equal(reopened.unarchived_at, undefined, 'status change clears the marker');
  const finished = after(reopenedDoc, M.setStatus(reopenedDoc, done.id, 'done', later));
  assert.ok(M.archiveCandidates(finished, '2099-03-01T00:00:00Z').includes(done.id), 'closed again: eligible after a week');
  assert.ok(!M.archiveCandidates(finished, '2099-01-22T00:00:00Z').includes(done.id), 'not before a week passes');
  // Opening an archived task returns it to the registry automatically.
  const opened = after(a, M.setStatus(a, done.id, 'in_progress', later)).byId.get(done.id);
  assert.equal(opened.archived, false); assert.equal(opened.status, 'in_progress');
  // Auto-archive: every candidate in one edit; 009 stays because 010 is open, 004 (removed leaf) goes.
  const auto = M.autoArchive(d, '2099-12-31T00:00:00Z');
  assert.deepEqual(auto.ids, ['003', '004', '008']); const archived = after(d, auto.changes);
  for (const id of auto.ids) assert.equal(archived.byId.get(id).archived, true);
  assert.deepEqual(M.autoArchive(d, '2000-01-01T00:00:00Z'), { ids: [], changes: {} });
  // Archive format: archived_at required, milestones forbidden, archived_at forbidden in the registry.
  assert.throws(() => M.parse({ ...a.files, archive: a.files.archive.replace(/archived_at: "[^"]+"\n/, '') }), code('archived_at_required'));
  assert.throws(() => M.parse({ ...a.files, archive: a.files.archive + '\n' + d.milestones[0].raw }), code('milestone_in_archive'));
  assert.throws(() => withRegistry(source.replace(/^(### TASK 003\n```yaml\n)/m, '$1archived_at: "' + now + '"\n')), code('archived_at_forbidden'));
  assert.throws(() => M.parse({ ...a.files, archive: a.files.archive.replace('archive: true', 'archive: false') }), code('archive_flag'));
  assert.throws(() => M.parse({ ...a.files, archive: a.files.archive + '\n' + d.tasks[0].raw.replace('```yaml\n', '```yaml\narchived_at: "' + now + '"\n') }), code('duplicate_id'));
  assert.throws(() => M.addTask(a, { title: 'x', body: '', parent: done.id }, now), code('parent_archived'));
});
test('addToMilestone pins the task explicitly; subtasks follow only with withSubtasks, otherwise inherited ones keep their previous milestone', () => {
  const d = parsed();
  const kept = after(d, M.addToMilestone(d, '001', 'M02', {}, now));
  assert.equal(kept.byId.get('001').milestone, 'M02');
  for (const id of ['002', '003', '004']) { assert.equal(kept.byId.get(id).milestone, 'M01', 'inheriting child is pinned to the old milestone'); }
  for (const t of d.tasks.filter(t => !['001', '002', '003', '004'].includes(t.id))) assert.equal(kept.byId.get(t.id).raw, t.raw, 'untouched tasks keep their raw text');
  const moved = after(d, M.addToMilestone(d, '001', 'M02', { withSubtasks: true }, now));
  for (const id of ['002', '003', '004']) assert.equal(moved.byId.get(id).milestone, 'M02');
  assert.deepEqual(M.addToMilestone(d, '001', 'M01', {}, now), {}, 'already there: no-op');
  assert.throws(() => M.addToMilestone(d, '001', 'M99'), code('milestone_not_found'));
  assert.throws(() => M.addToMilestone(d, '999999', 'M02'), code('task_not_found'));
});
test('milestone priority: default normal, validated on parse, set by edit/add, no-op edit keeps bytes', () => {
  const d = parsed(), m = d.milestones[1];
  assert.equal(M.priorityOf(m), 'normal');
  assert.deepEqual(M.editMilestone(d, m.id, m.title, m.body), {});
  const high = after(d, M.editMilestone(d, m.id, m.title, m.body, { priority: 'high' }));
  assert.equal(high.byMilestone.get(m.id).priority, 'high');
  for (const t of d.tasks) assert.equal(high.byId.get(t.id).raw, t.raw);
  assert.deepEqual(M.editMilestone(high, m.id, m.title, m.body), {}, 'edit without priority keeps the stored value');
  assert.throws(() => M.editMilestone(d, m.id, m.title, m.body, { priority: 'urgent' }), code('unknown_priority'));
  assert.equal(after(d, M.addMilestone(d, { title: 'Urgent', priority: 'low' }).changes).milestones.at(-1).priority, 'low');
});
test('setParent moves a task under another parent, rejects cycles, self and removed parents', () => {
  const d = parsed();
  const moved = after(d, M.setParent(d, '002', '007', now)).byId.get('002');
  assert.equal(moved.parent, '007'); assert.equal(moved.updated_at, now);
  assert.deepEqual(M.setParent(d, '002', '001', now), {}, 'same parent is a no-op');
  assert.throws(() => M.setParent(d, '001', '002', now), code('parent_cycle'));
  assert.throws(() => M.setParent(d, '002', '002', now), code('self_parent'));
  assert.throws(() => M.setParent(d, '002', '999999', now), code('parent_unavailable'));
  assert.throws(() => M.setParent(d, '002', '004', now), code('parent_unavailable'));
  assert.equal(after(d, M.setParent(d, '002', null, now)).byId.get('002').parent, null);
});
test('blocked_by/relates_to: parsed, derived views, validation and setDependencies', () => {
  const d = parsed();
  assert.deepEqual(d.byId.get('005').blocked_by, ['006']);
  assert.deepEqual(M.blockedBy(d, d.byId.get('005')).map(t => t.id), ['006']);
  assert.deepEqual(M.blocks(d, d.byId.get('006')).map(t => t.id), ['005'], 'blocks is derived, never stored');
  assert.equal(M.isBlocked(d, d.byId.get('005')), true, '006 is in_progress');
  assert.equal(M.isBlocked(d, d.byId.get('006')), false, 'no blockers');
  // relates_to is stored on 007 only; 008 sees it through the derived reverse lookup.
  assert.deepEqual(M.relatedTasks(d, d.byId.get('007')).map(t => t.id), ['008']);
  assert.deepEqual(M.relatedTasks(d, d.byId.get('008')).map(t => t.id), ['007']);
  assert.throws(() => withRegistry(source.replace('blocked_by: [\"006\"]', 'blocked_by: [\"999999\"]')), code('dependency_missing'));
  assert.throws(() => withRegistry(source.replace('blocked_by: [\"006\"]', 'blocked_by: [\"005\"]')), code('dependency_self'));
  assert.throws(() => withRegistry(source.replace('blocked_by: [\"006\"]', 'blocked_by: [\"006\", \"006\"]')), code('dependency_format'));
  assert.throws(() => withRegistry(source.replace('blocked_by: [\"006\"]', 'blocked_by: [1]')), code('dependency_format'));
  // A cycle: 006 also blocked by 005 (which is already blocked by 006).
  assert.throws(() => withRegistry(source.replace('assignee: \"Codex\"\ncreated_at', 'assignee: \"Codex\"\nblocked_by: [\"005\"]\ncreated_at')), code('dependency_cycle'));
  const withDeps = after(d, M.setDependencies(d, '007', { blockedBy: ['008'], relatesTo: ['002', '002'] }, now));
  const t = withDeps.byId.get('007');
  assert.deepEqual(t.blocked_by, ['008']); assert.deepEqual(t.relates_to, ['002']); assert.equal(t.updated_at, now);
  assert.deepEqual(M.setDependencies(d, '007', {}, now), {}, 'no fields given is a no-op');
  assert.throws(() => M.setDependencies(d, '999999', { blockedBy: [] }, now), code('task_not_found'));
});
test('setRelationships: reconciles blocking (reverse blocked_by) and relates_to (either side) as a diff', () => {
  const d = parsed();
  // 006 is currently blocked by nothing and blocks 005 (005.blocked_by = ["006"]).
  // Ask 006 to block 002 as well and stop blocking 005: 005 loses 006, 002 gains it.
  const afterBlocking = after(d, M.setRelationships(d, '006', { blocking: ['002'] }, now));
  assert.deepEqual(afterBlocking.byId.get('005').blocked_by, [], '006 no longer blocks 005');
  assert.deepEqual(afterBlocking.byId.get('002').blocked_by, ['006'], '006 now blocks 002');
  assert.deepEqual(M.blocks(afterBlocking, afterBlocking.byId.get('006')).map(t => t.id), ['002']);
  // 007 relates_to ["008"]; 008 holds nothing of its own. Drop 008, add 002 as related.
  const afterRelates = after(d, M.setRelationships(d, '007', { relatesTo: ['002'] }, now));
  assert.deepEqual(afterRelates.byId.get('007').relates_to, ['002']);
  assert.deepEqual(afterRelates.byId.get('008').relates_to ?? [], []);
  // A relation stored on the *other* side (007 sees 002 only through the reverse lookup, since 002 is the
  // one whose own relates_to names 007) is removed from wherever it actually lives, not just from the
  // edited task's own field.
  const reverseSeeded = after(d, M.setDependencies(d, '002', { relatesTo: ['007'] }, now));
  assert.deepEqual(M.relatedTasks(reverseSeeded, reverseSeeded.byId.get('007')).map(t => t.id).sort(), ['002', '008']);
  const afterDrop = after(reverseSeeded, M.setRelationships(reverseSeeded, '007', { relatesTo: ['008'] }, now));
  assert.deepEqual(afterDrop.byId.get('002').relates_to, [], 'removed from 002, which actually stored it');
  assert.deepEqual(afterDrop.byId.get('007').relates_to, ['008'], 'the direct relation is untouched');
  assert.deepEqual(M.relatedTasks(afterDrop, afterDrop.byId.get('007')).map(t => t.id), ['008']);
  // Mutual blocking is still rejected: 006 blocks 005, so asking 005 to also block 006 is a 2-cycle.
  assert.throws(() => M.setRelationships(d, '005', { blocking: ['006'] }, now), code('dependency_cycle'));
  assert.deepEqual(M.setRelationships(d, '007', {}, now), {}, 'no fields given is a no-op');
  assert.throws(() => M.setRelationships(d, '999999', { blockedBy: [] }, now), code('task_not_found'));
});
test('labels: parsed, addLabel/editLabel/deleteLabel, task label validation and assignment', () => {
  const d = parsed();
  assert.equal(d.labels.length, 2); assert.deepEqual(d.byId.get('002').labels, ['L01']);
  assert.throws(() => withRegistry(source.replace('labels: [\"L01\"]', 'labels: [\"L99\"]')), code('label_missing'));
  assert.throws(() => withRegistry(source.replace('labels: [\"L01\"]', 'labels: [\"L01\", \"L01\"]')), code('label_format'));
  assert.throws(() => withRegistry(source.replace('color: \"#ef4444\"', 'color: \"red\"')), code('label_color'));
  const added = M.addLabel(d, { title: 'Urgent', color: '#eab308' }), next = after(d, added.changes);
  assert.equal(added.id, 'L03'); assert.equal(next.labels.length, 3); assert.equal(next.byLabel.get('L03').title, 'Urgent');
  assert.throws(() => M.addLabel(d, { title: '', color: '#eab308' }), code('title_length'));
  assert.throws(() => M.addLabel(d, { title: 'x', color: 'not-a-color' }), code('label_color'));
  const edited = after(d, M.editLabel(d, 'L01', 'Defect', '#dc2626'));
  assert.equal(edited.byLabel.get('L01').title, 'Defect'); assert.equal(edited.byLabel.get('L01').color, '#dc2626');
  assert.throws(() => M.editLabel(d, 'L99', 'x', '#000000'), code('label_not_found'));
  const withAssignment = after(d, M.setTaskLabels(d, '007', ['L01', 'L02', 'L01'], now));
  assert.deepEqual(withAssignment.byId.get('007').labels, ['L01', 'L02']); assert.equal(withAssignment.byId.get('007').updated_at, now);
  assert.deepEqual(M.setTaskLabels(d, '002', ['L01'], now), {}, 'same set is a no-op');
  assert.throws(() => M.setTaskLabels(d, '999999', ['L01'], now), code('task_not_found'));
  const deleted = after(d, M.deleteLabel(d, 'L01'));
  assert.equal(deleted.labels.length, 1); assert.deepEqual(deleted.byId.get('002').labels, [], 'removed from every task that had it');
  assert.throws(() => M.deleteLabel(d, 'L99'), code('label_not_found'));
});
// Migration: registries written before labels existed have no "## Labels" heading at all. addLabel must not
// fail with no_labels_section — it creates the heading itself, in every plausible shape of an old registry.
const taskBlock = (id, extra = '') => `### TASK ${id}\n\`\`\`yaml\nid: "${id}"\ntitle: "T${id}"\nkind: "task"\nparent: null\nmilestone: null\nstatus: "to-do"\nauthor: "User"\nassignee: null\ncreated_at: "2025-01-01T10:00:00+00:00"\nupdated_at: "2025-01-01T10:00:00+00:00"\ncompleted_at: null\nbranch: null\ncommit: null\nresult: ""\n${extra}\`\`\`\n`;
const legacyRegistry = ({ milestones = true, tasks = true } = {}) =>
  `---\nschema: 1\nproject: "Legacy"\nnext_task: 2\n---\n\n# Legacy — task registry\n\n` +
  (milestones ? `## Milestones\n\n### MILESTONE M01\n\`\`\`yaml\nid: "M01"\ntitle: "Backlog"\n\`\`\`\n\n` : '') +
  (tasks ? `## Tasks\n\n${taskBlock('001')}` : '## Tasks\n');
test('migration: addLabel creates a missing "## Labels" heading — with milestones and tasks, tasks only, and an empty registry', () => {
  // Old registry, milestones + tasks, no Labels section at all (the exact shape the report described).
  // addLabel only creates the bare heading here — it never seeds the default set (that is seedDefaultLabels'
  // job, triggered by the UI, not by every direct call to addLabel).
  const withBoth = M.parse(legacyRegistry());
  assert.equal(withBoth.labels.length, 0);
  const addedBoth = M.addLabel(withBoth, { title: 'Bug', color: '#ef4444' });
  const nextBoth = after(withBoth, addedBoth.changes);
  assert.equal(addedBoth.id, 'L01'); assert.equal(nextBoth.labels.length, 1); assert.equal(nextBoth.byLabel.get('L01').color, '#ef4444');
  assert.match(nextBoth.text, /```\n\n## Labels\n\n### LABEL L01\n\`\`\`yaml\nid: "L01"\ntitle: "Bug"\ncolor: "#ef4444"\n\`\`\`\n\n## Tasks\n/, 'lands right after the last milestone, right before Tasks');
  assert.equal(nextBoth.byId.get('001').raw, withBoth.byId.get('001').raw, 'the existing task record is untouched');
  // A second label after migration appends normally, next to the first.
  const addedSecond = M.addLabel(nextBoth, { title: 'Docs', color: '#3b82f6' });
  const nextSecond = after(nextBoth, addedSecond.changes);
  assert.equal(addedSecond.id, 'L02'); assert.equal(nextSecond.labels.length, 2);
  assert.equal((nextSecond.text.match(/## Labels/g) || []).length, 1, 'no duplicate heading on the second label');

  // No milestones at all: the section lands right before the first task instead.
  const tasksOnly = M.parse(legacyRegistry({ milestones: false }));
  const addedTasksOnly = M.addLabel(tasksOnly, { title: 'X', color: '#22c55e' });
  const nextTasksOnly = after(tasksOnly, addedTasksOnly.changes);
  assert.equal(nextTasksOnly.labels.length, 1);
  assert.match(nextTasksOnly.text, /## Labels\n\n### LABEL L01\n```yaml\nid: "L01"\ntitle: "X"\ncolor: "#22c55e"\n```\n\n## Tasks\n\n### TASK 001/);

  // Neither milestones nor tasks yet: nothing to anchor on, the section is appended at the end of the file.
  const empty = M.parse(legacyRegistry({ milestones: false, tasks: false }));
  const addedEmpty = M.addLabel(empty, { title: 'Only', color: '#eab308' });
  const nextEmpty = after(empty, addedEmpty.changes);
  assert.equal(nextEmpty.labels.length, 1); assert.equal(nextEmpty.byLabel.get('L01').title, 'Only');
  assert.match(nextEmpty.text, /## Tasks\n\n## Labels\n\n### LABEL L01\n/);
});
test('migration: addLabel reuses an existing empty "## Labels" heading instead of creating a duplicate', () => {
  const withHeading = M.parse(`---\nschema: 1\nproject: "P"\nnext_task: 1\n---\n\n## Milestones\n\n## Labels\n\n## Tasks\n`);
  const added = after(withHeading, M.addLabel(withHeading, { title: 'X', color: '#ef4444' }).changes);
  assert.equal(added.labels.length, 1);
  assert.equal((added.text.match(/## Labels/g) || []).length, 1);
});
test('needsLabelSeed/seedDefaultLabels: only a registry with no "## Labels" section at all gets the default set, once', () => {
  const n = M.defaultLabels.length;
  // No section at all: needs seeding, and seedDefaultLabels inserts exactly the default set, nothing else.
  const withBoth = M.parse(legacyRegistry());
  assert.equal(M.needsLabelSeed(withBoth), true);
  const seeded = after(withBoth, M.seedDefaultLabels(withBoth));
  assert.equal(seeded.labels.length, n);
  assert.deepEqual(seeded.labels.map(l => [l.title, l.color]), M.defaultLabels.map(l => [l.title, l.color]));
  assert.equal(seeded.byId.get('001').raw, withBoth.byId.get('001').raw, 'the existing task record is untouched');
  // Seeding again is a no-op: needsLabelSeed is now false, seedDefaultLabels returns no changes.
  assert.equal(M.needsLabelSeed(seeded), false);
  assert.deepEqual(M.seedDefaultLabels(seeded), {});
  // An existing but empty "## Labels" section is left alone — the project already opted in to having one.
  const withEmptyHeading = M.parse(`---\nschema: 1\nproject: "P"\nnext_task: 1\n---\n\n## Milestones\n\n## Labels\n\n## Tasks\n`);
  assert.equal(M.needsLabelSeed(withEmptyHeading), false);
  assert.deepEqual(M.seedDefaultLabels(withEmptyHeading), {});
  // A registry that already has labels of its own is left alone too.
  assert.equal(M.needsLabelSeed(parsed()), false);
  assert.deepEqual(M.seedDefaultLabels(parsed()), {});
});
