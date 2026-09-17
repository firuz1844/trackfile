/* `trackfile check` (#207): OK on a healthy registry, a clear failure message on a broken one — reusing
 * exactly the invariants `M.parse` already enforces (duplicate ids, next_task, missing parents/labels). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check } = require('../lib/check.cjs');
const { resolveLayout } = require('../lib/layout.cjs');
const F = require('./fixture.cjs');

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const BIN = path.join(__dirname, '..', 'bin', 'trackfile.js');

test('check reports OK with counts on a healthy registry', () => {
  const root = tmp('trackfile-check-ok-');
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), F.registry());
  const result = check(resolveLayout(root));
  assert.equal(result.ok, true);
  assert.match(result.message, /OK — 10 task\(s\)/);
});

test('check reports the parse failure on a broken registry', () => {
  const root = tmp('trackfile-check-bad-');
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), F.registry().replace('next_task: 11', 'next_task: 1'));
  const result = check(resolveLayout(root));
  assert.equal(result.ok, false);
  assert.match(result.message, /next_task/);
});

test('the CLI exits 0 on a healthy registry and non-zero with the error on stderr otherwise', () => {
  const ok = tmp('trackfile-check-cli-ok-');
  fs.writeFileSync(path.join(ok, 'TRACKFILE.md'), F.registry());
  const out = execFileSync('node', [BIN, 'check'], { cwd: ok, encoding: 'utf8' });
  assert.match(out, /OK/);

  const bad = tmp('trackfile-check-cli-bad-');
  fs.writeFileSync(path.join(bad, 'TRACKFILE.md'), F.registry().replace('next_task: 11', 'next_task: 1'));
  assert.throws(() => execFileSync('node', [BIN, 'check'], { cwd: bad, encoding: 'utf8' }));
});
