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
    const needsValue = ['port', 'registry', 'name', 'agents', 'branch', 'remote', 'task', 'absorb'].includes(key);
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
