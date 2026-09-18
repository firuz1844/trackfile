/* #209: the PreToolUse `git commit` hook warns (stdout, never blocking) when an agent's own taken task
 * drifted since `take` — silent for anything else (non-commit commands, legacy-mode repos, bad input). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const commands = require('../lib/commands.cjs');
const { resolveLayout } = require('../lib/layout.cjs');
const migrate = require('../lib/migrate.cjs');
const F = require('./fixture.cjs');

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const quiet = { log: () => {} };
const BIN = path.join(__dirname, '..', 'bin', 'trackfile.js');
const runHook = (cwd, event) => spawnSync('node', [BIN, 'hook-precommit'], { cwd, input: JSON.stringify(event), encoding: 'utf8' });

async function sharedRepo(port) {
  const root = tmp('trackfile-hook-');
  git(root, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), F.registry());
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=a@a.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'seed']);
  const origin = tmp('trackfile-hook-origin-');
  git(origin, ['init', '-q', '--bare', '-b', 'main']);
  git(root, ['remote', 'add', 'origin', origin]);
  git(root, ['push', '-q', 'origin', 'main']);
  await migrate.run({ cwd: root, port, ...quiet });
  return { root, layout: resolveLayout(root) };
}

test('silent for a non-commit command', async () => {
  const { root } = await sharedRepo(47500);
  const result = runHook(root, { tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), '');
});

test('silent in a legacy (non-shared) repository', () => {
  const root = tmp('trackfile-hook-legacy-');
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), F.registry());
  const result = runHook(root, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), '');
});

test('silent for garbage stdin', () => {
  const root = tmp('trackfile-hook-garbage-');
  const result = spawnSync('node', [BIN, 'hook-precommit'], { cwd: root, input: 'not json', encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), '');
});

test('warns on a git commit when the taken task drifted, silent when it did not', async () => {
  const { root, layout } = await sharedRepo(47501);
  await commands.take(layout, '001', { marker: 'claude', root, ...quiet });

  const clean = runHook(root, { tool_name: 'Bash', tool_input: { command: 'git commit -m "wip"' } });
  assert.equal(clean.status, 0); assert.equal(clean.stdout.trim(), '', 'no drift yet — silent');

  // The user edits the record directly and syncs, exactly like the earlier commands.test.cjs scenario.
  const registryPath = path.join(layout.dataRoot, 'TRACKFILE.md');
  const before = fs.readFileSync(registryPath, 'utf8');
  const M = require('../app/assets/model.js');
  const doc = M.parse({ registry: before });
  const t = doc.byId.get('001');
  fs.writeFileSync(registryPath, before.slice(0, t.start) + before.slice(t.start, t.end).replace('status: "in_progress"', 'status: "cancelled"') + before.slice(t.end));
  await commands.sync(layout, { marker: 'user', ...quiet });

  const warned = runHook(root, { tool_name: 'Bash', tool_input: { command: 'git commit -m "wip"' } });
  assert.equal(warned.status, 0, 'advisory only — never blocks the commit');
  assert.match(warned.stdout, /#001 \(taken by claude\) changed since take/);
  assert.match(warned.stdout, /status/);
});
