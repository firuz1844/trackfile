/* Layout discovery, `init` and `toc` on temporary folders: nothing is overwritten, second run is a no-op,
 * --dry-run writes nothing, .gitignore gets no duplicate line, --force refreshes agent rules. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findRoot, resolveLayout, DEFAULTS, relativeOf, readRegistryFiles } = require('../lib/layout.cjs');
const init = require('../lib/init.cjs');
const agents = require('../lib/agents.cjs');
const { toc } = require('../lib/toc.cjs');
const F = require('./fixture.cjs');
const BIN = path.join(__dirname, '..', 'bin', 'trackfile.js');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const quiet = { log: () => {} };

test('findRoot walks up to the registry; resolveLayout applies defaults and front-matter overrides', () => {
  const root = tmp('trackfile-root-');
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  assert.equal(findRoot(path.join(root, 'a', 'b')), null);
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), '---\nschema: 1\nproject: "P"\nnext_task: 1\n---\n');
  assert.equal(findRoot(path.join(root, 'a', 'b')), root);
  const layout = resolveLayout(root);
  assert.deepEqual([layout.registry, layout.archive, layout.tasks, layout.config, layout.attachmentsPrefix], ['TRACKFILE.md', '.trackfile/archive.md', '.trackfile/tasks', '.trackfile/config.json', '.trackfile/tasks']);
  assert.equal(relativeOf(layout, 'comments/042'), '.trackfile/tasks/042/comments.md');
  assert.equal(relativeOf(layout, 'nope'), null);
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), '---\nschema: 1\nproject: "P"\nnext_task: 1\ntasks_dir: "../escape"\narchive_file: "docs/archive.md"\n---\n');
  const custom = resolveLayout(root);
  assert.equal(custom.tasks, DEFAULTS.tasks, 'a path escaping the root falls back to the default');
  assert.equal(custom.archive, 'docs/archive.md');
});

test('init creates the registry, archive, .gitignore and agent rules; a second run changes nothing', () => {
  const root = tmp('trackfile-init-');
  execFileSync('git', ['-C', root, 'init', '-q']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Existing rules\n\nKeep me.\n');
  const dry = init.run({ cwd: root, agents: ['claude', 'codex', 'cursor'], dryRun: true, ...quiet });
  assert.equal(dry.changed, 0); assert.ok(!fs.existsSync(path.join(root, 'TRACKFILE.md')), '--dry-run writes nothing');
  assert.deepEqual(dry.steps.map(s => [s.action, s.path]), [['create', 'TRACKFILE.md'], ['create', '.trackfile/archive.md'], ['append', '.gitignore'], ['create', '.claude/skills/trackfile/SKILL.md'], ['create', 'CLAUDE.md'], ['append', 'AGENTS.md'], ['create', '.cursor/rules/trackfile.mdc'], ['create', '.claude/launch.json']]);
  const first = init.run({ cwd: root, name: 'Demo', agents: ['claude', 'codex', 'cursor'], ...quiet });
  assert.equal(first.changed, 8);
  const registry = fs.readFileSync(path.join(root, 'TRACKFILE.md'), 'utf8');
  assert.match(registry, /^project: "Demo"$/m); assert.match(registry, /^next_task: 1$/m); assert.match(registry, /^### MILESTONE M01$/m);
  assert.match(fs.readFileSync(path.join(root, '.trackfile', 'archive.md'), 'utf8'), /^archive: true$/m);
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'node_modules\n.trackfile/config.json\n');
  const agentsMd = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(agentsMd.startsWith('# Existing rules\n\nKeep me.\n'), 'existing content is kept');
  assert.ok(agentsMd.includes(`<!-- trackfile:start v=${agents.VERSION} -->`) && agentsMd.trimEnd().endsWith('<!-- trackfile:end -->'));
  assert.ok(agentsMd.includes('### No change without a task'), 'the block carries the full protocol');
  const skill = fs.readFileSync(path.join(root, '.claude', 'skills', 'trackfile', 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: trackfile$/m); assert.match(skill, new RegExp(`^version: ${agents.VERSION}$`, 'm')); assert.ok(skill.includes('### No change without a task'));
  assert.ok(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8').includes('.claude/skills/trackfile/SKILL.md'), 'CLAUDE.md points to the skill');
  assert.match(fs.readFileSync(path.join(root, '.cursor', 'rules', 'trackfile.mdc'), 'utf8'), /^alwaysApply: true$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'launch.json'), 'utf8')).configurations[0].name, 'trackfile');
  // Second run: everything is reported as skipped and nothing is rewritten.
  const before = Object.fromEntries(['TRACKFILE.md', '.gitignore', 'AGENTS.md', 'CLAUDE.md'].map(f => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
  const second = init.run({ cwd: root, agents: ['claude', 'codex', 'cursor'], ...quiet });
  assert.equal(second.changed, 0); assert.ok(second.steps.every(s => s.action === 'skip'));
  for (const [f, text] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(root, f), 'utf8'), text);
  // An outdated block is skipped without --force and replaced in place with it.
  fs.writeFileSync(path.join(root, 'AGENTS.md'), agentsMd.replace(`v=${agents.VERSION}`, 'v=0.0.1') + '\nTrailing notes.\n');
  const stale = init.run({ cwd: root, agents: ['codex'], ...quiet });
  assert.ok(stale.steps.find(s => s.path === 'AGENTS.md').reason.includes('--force'));
  const forced = init.run({ cwd: root, agents: ['codex'], force: true, ...quiet });
  assert.equal(forced.changed, 1);
  const updated = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(updated.includes(`v=${agents.VERSION}`) && updated.startsWith('# Existing rules') && updated.trimEnd().endsWith('Trailing notes.'));
  assert.equal((updated.match(/trackfile:start/g) || []).length, 1, 'one block, never duplicated');
  assert.throws(() => init.resolveAgents(['nope']), /Unknown agents/);
  assert.deepEqual(init.resolveAgents(['all']), Object.keys(agents.AGENTS));
});

test('toc prints milestones and open tasks, hides closed ones unless asked, marks comments and the archive', () => {
  const root = tmp('trackfile-toc-');
  fs.writeFileSync(path.join(root, 'TRACKFILE.md'), F.registry().replace('next_task: 11', 'next_task: 100'));
  fs.mkdirSync(path.join(root, '.trackfile', 'tasks', '002'), { recursive: true });
  fs.writeFileSync(path.join(root, '.trackfile', 'tasks', '002', 'comments.md'), F.comments());
  const layout = resolveLayout(root);
  assert.deepEqual(Object.keys(readRegistryFiles(layout)), ['registry', 'comments/002']);
  const open = toc(layout);
  assert.match(open, /^next_task: 100$/m); assert.match(open, /^M01 \| First milestone$/m);
  assert.match(open, /^002 \| to-do {7}\| M01 {7}\| 001 {4}\| task {4}\| Free subtask \[comments: 1\]$/m);
  assert.ok(!/^003 /m.test(open), 'closed tasks are hidden by default');
  assert.match(toc(layout, { closed: true }), /^003 \| done/m);
  // An archived task: `--all` includes it, plain toc still works when its comments folder exists.
  fs.writeFileSync(path.join(root, '.trackfile', 'archive.md'), '---\nschema: 1\nproject: "Sample"\narchive: true\n---\n\n## Tasks\n\n' + F.task('099', 'Archived', { status: 'done', archived_at: '2025-02-01T00:00:00+00:00', completed_at: '2025-01-20T00:00:00+00:00' }));
  fs.mkdirSync(path.join(root, '.trackfile', 'tasks', '099'), { recursive: true });
  fs.writeFileSync(path.join(root, '.trackfile', 'tasks', '099', 'comments.md'), F.comments());
  assert.ok(!/^099 /m.test(toc(layout)), 'archived task stays hidden without --all');
  assert.match(toc(layout, { all: true }), /^099 \| done {8}\| - {9}\| - {6}\| task {4}\| Archived \[archived\] \[comments: 1\]$/m);
  const cli = execFileSync('node', [BIN, 'toc'], { cwd: path.join(root), encoding: 'utf8' });
  assert.match(cli, /^007 \| to-do/m);
  assert.equal(execFileSync('node', [BIN, '--version'], { encoding: 'utf8' }).trim(), require('../package.json').version);
});
