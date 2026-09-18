#!/usr/bin/env node
/* Trackfile CLI: `trackfile` serves the dashboard of the repository you are in, `trackfile init` sets a
 * repository up, `trackfile toc` prints the registry's table of contents for agents. */
'use strict';
const path = require('node:path');
const { findRoot, resolveLayout, DEFAULTS } = require('../lib/layout.cjs');
const { version } = require('../package.json');

const HELP = `Trackfile ${version} — git-native task tracker for humans and coding agents.

Usage:
  trackfile [serve] [--open] [--port N] [--registry FILE]   start the dashboard (default command)
  trackfile init [--name NAME] [--agents LIST] [--global] [--force] [--dry-run] [--launch]
  trackfile toc [--closed] [--all] [--registry FILE]         table of contents for agents
  trackfile migrate --shared [--branch NAME] [--remote NAME] [--local] [--dry-run] [--task ID]
  trackfile migrate --rollback [--dry-run]
  trackfile check [--registry FILE]                          validate registry/archive invariants
  trackfile merge-driver %O %A %B [%P]                       git merge driver (registered automatically)
  trackfile new TITLE [--parent ID] [--milestone ID] [--body TEXT] [--marker NAME]
  trackfile take ID [--marker NAME]
  trackfile set ID FIELD VALUE [--marker NAME] [--acknowledge]
  trackfile comment ID TEXT [--marker NAME] [--acknowledge]
  trackfile sync [--marker NAME]
  trackfile status [--marker NAME]
  trackfile --help | --version

serve:
  --open            open the dashboard in the default browser
  --port N          port on 127.0.0.1 (default 3737, or PORT)
  --registry FILE   registry file name to look for (default ${DEFAULTS.registry}), searched upwards from cwd

init:
  --name NAME       project name for the front matter (default: folder name)
  --agents LIST     comma-separated: claude, codex, cursor, gemini, zed, opencode, jules, all
  --global          also install the rules at user level where the agent reads them
  --force           update already installed agent rules to this version
  --dry-run         print what would be created, write nothing
  --launch          add the dashboard to .claude/launch.json

migrate:
  --shared          move the registry/archive/tasks into a dedicated data branch (default: trackfile)
  --branch NAME     data branch name (default: trackfile)
  --remote NAME     remote to push the data branch to (default: origin)
  --local           do not push the data branch — single-clone setups only
  --task ID         prefix the migration commits with #ID, like any other trackfile edit
  --dry-run         print the plan, write nothing
  --rollback        undo a migration: restore data files, drop the pointer and worktree
`;

function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const [key, inline] = a.slice(2).split('=');
    const needsValue = ['port', 'registry', 'name', 'agents', 'branch', 'remote', 'task', 'absorb', 'marker', 'parent', 'milestone', 'body'].includes(key);
    opts[key] = needsValue ? (inline ?? argv[++i]) : true;
  }
  return opts;
}

function layoutFor(opts) {
  const registry = opts.registry || DEFAULTS.registry;
  const root = findRoot(process.cwd(), registry);
  if (!root) { console.error(`No ${registry} found in ${process.cwd()} or its parents. Run \`npx trackfile init\` in the repository root, or pass --registry.`); process.exit(2); }
  return resolveLayout(root, { registry });
}

async function main() {
  const opts = parse(process.argv.slice(2));
  const command = opts._[0] ?? 'serve';
  if (opts.version) return console.log(version);
  if (opts.help || command === 'help') return console.log(HELP);
  if (command === 'serve') {
    const { listen } = require('../lib/serve.cjs');
    listen(layoutFor(opts), { port: Number(opts.port) || Number(process.env.PORT) || 3737, open: Boolean(opts.open) });
    return;
  }
  if (command === 'toc') {
    const { toc } = require('../lib/toc.cjs');
    return console.log(toc(layoutFor(opts), { all: Boolean(opts.all), closed: Boolean(opts.closed) }));
  }
  if (command === 'init') {
    const init = require('../lib/init.cjs');
    let agents = opts.agents ? opts.agents.split(',').map(s => s.trim()).filter(Boolean) : null;
    if (agents === null && process.stdin.isTTY && !opts['dry-run']) {
      const readline = require('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Install rules for which agents? (claude, codex, cursor, gemini, zed, opencode, jules, all; empty = none) [claude,codex]: ');
      rl.close();
      agents = (answer.trim() === '' ? 'claude,codex' : answer).split(',').map(s => s.trim()).filter(s => s && s !== 'none');
    }
    init.run({ name: opts.name, agents: agents ?? [], global: Boolean(opts.global), force: Boolean(opts.force), dryRun: Boolean(opts['dry-run']), launch: Boolean(opts.launch) });
    return;
  }
  if (command === 'migrate') {
    if (!opts.shared && !opts.rollback && !opts.absorb) { console.error(`Usage: trackfile migrate --shared | --rollback | --absorb BRANCH\n\n${HELP}`); process.exit(2); }
    const migrate = require('../lib/migrate.cjs');
    try {
      await migrate.run({ branch: opts.branch || 'trackfile', remote: opts.remote || 'origin', local: Boolean(opts.local), history: Boolean(opts.history), push: Boolean(opts.push), dryRun: Boolean(opts['dry-run']), rollback: Boolean(opts.rollback), absorb: opts.absorb || null, task: opts.task || null });
    } catch (error) { console.error(error.message); process.exit(1); }
    return;
  }
  const AGENT_COMMANDS = new Set(['new', 'take', 'set', 'comment', 'sync', 'status']);
  if (AGENT_COMMANDS.has(command)) {
    const commands = require('../lib/commands.cjs');
    const marker = opts.marker || process.env.TRACKFILE_AGENT || require('node:os').userInfo().username;
    const layout = layoutFor(opts);
    try {
      if (command === 'new') {
        const title = opts._[1];
        if (!title) { console.error('Usage: trackfile new TITLE [--parent ID] [--milestone ID] [--body TEXT] [--marker NAME]'); process.exit(2); }
        const result = await commands.newTask(layout, { title, parent: opts.parent || null, milestone: opts.milestone || null, body: opts.body || '', marker, log: console.log });
        console.log(`#${result.id}`);
      } else if (command === 'take') {
        const id = opts._[1];
        if (!id) { console.error('Usage: trackfile take ID [--marker NAME]'); process.exit(2); }
        const result = await commands.take(layout, id, { marker, log: console.log });
        console.log(result.applied ? `#${id} taken by ${marker}${result.pushed ? '' : ' (queued — remote unreachable)'}` : `#${id}: nothing to change.`);
      } else if (command === 'set') {
        const [, id, field, value] = opts._;
        if (!id || !field || value === undefined) { console.error('Usage: trackfile set ID FIELD VALUE [--marker NAME] [--acknowledge]'); process.exit(2); }
        const result = await commands.setField(layout, id, field, value, { marker, acknowledge: Boolean(opts.acknowledge), log: console.log });
        console.log(result.applied ? `#${id}: ${field} = ${value}` : `#${id}: nothing to change.`);
      } else if (command === 'comment') {
        const [, id, ...rest] = opts._;
        const text = rest.join(' ');
        if (!id || !text) { console.error('Usage: trackfile comment ID TEXT [--marker NAME] [--acknowledge]'); process.exit(2); }
        await commands.comment(layout, id, text, { marker, acknowledge: Boolean(opts.acknowledge), log: console.log });
        console.log(`#${id}: comment added.`);
      } else if (command === 'sync') {
        const result = await commands.sync(layout, { marker, log: console.log });
        console.log(result.clean ? 'Nothing to sync.' : result.pushed ? `Synced (${result.commit.slice(0, 8)}).` : `Committed locally, queued (${result.unpushedCount} unpushed) — remote unreachable.`);
      } else if (command === 'status') {
        const result = await commands.status(layout, { marker });
        console.log(`Unpushed commits: ${result.unpushed}`);
        console.log(`Data worktree: ${result.dirty ? 'dirty (run trackfile sync)' : 'clean'}`);
        if (result.ownTask) console.log(`Your task: #${result.ownTask}${result.drift ? ` — changed since take:\n${result.drift.changes.map(c => `  - ${c}`).join('\n')}` : ' (unchanged since take)'}`);
      }
    } catch (error) { console.error(error.message); process.exit(1); }
    return;
  }
  if (command === 'hook-precommit') {
    // Claude Code PreToolUse hook (#209, installed by `init`): reads the tool-call JSON from stdin, and for
    // a `git commit` Bash call, warns — non-blocking, stdout only — when the agent's own taken task
    // (`.trackfile/.agent/<marker>.json`) has drifted since `take`. Silent and always exit 0 for anything
    // else: an unreadable input, a non-git-commit command, a repository not using trackfile at all, or one
    // still in the legacy layout (no shared-mode agent state to check).
    let input = '';
    process.stdin.on('data', c => { input += c; });
    process.stdin.on('end', () => {
      try {
        const event = JSON.parse(input);
        if (!/\bgit\s+([^&|;]*\s)?commit\b/.test(event?.tool_input?.command || '')) return;
        const root = findRoot(process.cwd(), DEFAULTS.registry);
        if (!root) return;
        const layout = resolveLayout(root);
        if (!layout.shared) return;
        const commands = require('../lib/commands.cjs');
        const drifts = commands.precommitCheck(layout);
        for (const d of drifts) console.log(`trackfile: #${d.taskId} (taken by ${d.marker}) changed since take:\n${d.changes.map(c => `  - ${c}`).join('\n')}`);
      } catch { /* advisory only — never block or fail a commit over this */ }
    });
    return;
  }
  if (command === 'check') {
    const { check } = require('../lib/check.cjs');
    const result = check(layoutFor(opts));
    if (result.ok) { console.log(result.message); return; }
    console.error(result.message); process.exit(1);
    return;
  }
  if (command === 'merge-driver') {
    const fs = require('node:fs');
    const merge = require('../lib/merge.cjs');
    const [, oFile, aFile, bFile, pPath] = opts._;
    if (!oFile || !aFile || !bFile) { console.error('Usage: trackfile merge-driver %O %A %B [%P]'); process.exit(2); }
    const renumberTasks = path.basename(pPath || aFile) === DEFAULTS.registry;
    try {
      const baseText = fs.readFileSync(oFile, 'utf8'), oursText = fs.readFileSync(aFile, 'utf8'), theirsText = fs.readFileSync(bFile, 'utf8');
      const { text } = merge.mergeRegistryText(baseText, oursText, theirsText, { renumberTasks });
      fs.writeFileSync(aFile, text);
    } catch (error) { console.error(error.message); process.exit(1); }
    return;
  }
  console.error(`Unknown command: ${command}\n\n${HELP}`); process.exit(2);
}
main().catch(error => { console.error(error.message); process.exit(1); });
