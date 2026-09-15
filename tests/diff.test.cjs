/* Contract of the unified-diff parser used by the commit page. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../app/assets/diff.js');

test('modified file: hunks, line numbers, context/add/del/meta', () => {
  const patch = ['diff --git a/src/a.js b/src/a.js', 'index 111..222 100644', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,3 +1,4 @@ function f', ' one', '-two', '+two!', '+three', ' four', '\\ No newline at end of file'].join('\n') + '\n';
  const [f] = parse(patch);
  assert.equal(f.path, 'src/a.js'); assert.equal(f.oldPath, null); assert.equal(f.status, 'modified'); assert.equal(f.binary, false);
  assert.equal(f.hunks.length, 1); assert.equal(f.hunks[0].context, 'function f');
  assert.deepEqual(f.hunks[0].lines.map(l => [l.type, l.old, l.new, l.text]), [
    ['ctx', 1, 1, 'one'], ['del', 2, null, 'two'], ['add', null, 2, 'two!'], ['add', null, 3, 'three'], ['ctx', 3, 4, 'four'], ['meta', null, null, 'No newline at end of file']
  ]);
  assert.equal(f.additions, 2); assert.equal(f.deletions, 1);
});
test('added, deleted, renamed and binary files', () => {
  const patch = [
    'diff --git a/new.md b/new.md', 'new file mode 100644', 'index 000..111', '--- /dev/null', '+++ b/new.md', '@@ -0,0 +1 @@', '+hello',
    'diff --git a/gone.md b/gone.md', 'deleted file mode 100644', 'index 111..000', '--- a/gone.md', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    'diff --git a/old/name.js b/new/name.js', 'similarity index 90%', 'rename from old/name.js', 'rename to new/name.js', 'index 1..2 100644', '--- a/old/name.js', '+++ b/new/name.js', '@@ -1 +1 @@', '-x', '+y',
    'diff --git a/img.png b/img.png', 'new file mode 100644', 'index 000..abc', 'Binary files /dev/null and b/img.png differ'
  ].join('\n') + '\n';
  const files = parse(patch);
  assert.deepEqual(files.map(f => [f.path, f.oldPath, f.status, f.binary, f.hunks.length]), [
    ['new.md', null, 'added', false, 1], ['gone.md', null, 'deleted', false, 1], ['new/name.js', 'old/name.js', 'renamed', false, 1], ['img.png', null, 'added', true, 0]
  ]);
  assert.equal(files[0].hunks[0].lines[0].new, 1); assert.equal(files[1].hunks[0].lines[0].old, 1);
});
test('never treats text as markup and tolerates an empty patch', () => {
  const [f] = parse('diff --git a/x.html b/x.html\n--- a/x.html\n+++ b/x.html\n@@ -1 +1 @@\n-<b>a</b>\n+<script>x</script>\n');
  assert.equal(f.hunks[0].lines[1].text, '<script>x</script>');
  assert.deepEqual(parse(''), []);
});
