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
`;

function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const [key, inline] = a.slice(2).split('=');
    const needsValue = ['port', 'registry', 'name', 'agents'].includes(key);
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
  console.error(`Unknown command: ${command}\n\n${HELP}`); process.exit(2);
}
main().catch(error => { console.error(error.message); process.exit(1); });
