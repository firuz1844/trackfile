/* `trackfile init`: registry, .gitignore entry and the rules for coding agents in one step.
 * Never overwrites: an existing registry, skill, block or launch entry is reported and skipped (exit 0);
 * `--force` refreshes the agent rules (e.g. after a package update), `--dry-run` only prints the plan. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DEFAULTS } = require('./layout.cjs');
const agents = require('./agents.cjs');

const TEMPLATES = path.join(__dirname, '..', 'templates');
const fill = (file, project) => fs.readFileSync(path.join(TEMPLATES, file), 'utf8').replaceAll('{{PROJECT}}', project);

function repoRoot(cwd) {
  try { return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd; }
  catch { return cwd; }
}

function resolveAgents(list) {
  if (!list || !list.length) return [];
  if (list.includes('all')) return Object.keys(agents.AGENTS);
  const unknown = list.filter(a => !agents.AGENTS[a]);
  if (unknown.length) throw new Error(`Unknown agents: ${unknown.join(', ')}. Known: ${Object.keys(agents.AGENTS).join(', ')}, all`);
  return [...new Set(list)];
}

// Plan first, then apply — so --dry-run and the real run print exactly the same list.
function plan({ root, name, agentList, global = false, launch = false }) {
  const project = name || path.basename(root);
  const steps = [];
  const exists = p => fs.existsSync(p);
  const registry = path.join(root, DEFAULTS.registry);
  steps.push(exists(registry) ? { action: 'skip', path: DEFAULTS.registry, reason: 'exists' } : { action: 'create', path: DEFAULTS.registry, content: fill('TRACKFILE.md', project) });
  const archive = path.join(root, DEFAULTS.archive);
  steps.push(exists(archive) ? { action: 'skip', path: DEFAULTS.archive, reason: 'exists' } : { action: 'create', path: DEFAULTS.archive, content: fill('archive.md', project) });
  const gitignore = path.join(root, '.gitignore');
  const ignoreText = exists(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  const ignored = ignoreText.split(/\r?\n/).some(line => line.trim() === DEFAULTS.config || line.trim() === '/' + DEFAULTS.config || line.trim() === '.trackfile/');
  steps.push(ignored ? { action: 'skip', path: '.gitignore', reason: `already ignores ${DEFAULTS.config}` } : { action: exists(gitignore) ? 'append' : 'create', path: '.gitignore', content: (ignoreText && !ignoreText.endsWith('\n') ? ignoreText + '\n' : ignoreText) + DEFAULTS.config + '\n' });
  // Agent rules: project files always, user-level files with --global where the agent reads them.
  const seen = new Set();
  for (const key of agentList) {
    const agent = agents.AGENTS[key];
    const targets = [...agent.project.map(t => ({ ...t, absolute: path.join(root, t.path), shown: t.path })), ...(global ? agent.global.map(t => ({ ...t, absolute: t.path, shown: t.path.replace(require('node:os').homedir(), '~') })) : [])];
    for (const target of targets) {
      if (seen.has(target.absolute)) continue; seen.add(target.absolute);
      const current = exists(target.absolute) ? fs.readFileSync(target.absolute, 'utf8') : null;
      const installed = current === null ? null : agents.installedVersion(current);
      const fresh = target.kind === 'skill' ? agents.skillText() : target.kind === 'mdc' ? agents.mdcText() : null;
      if (target.kind === 'block') {
        const block = agents.blockText({ pointer: target.pointer });
        if (installed !== null) steps.push({ action: 'skip', path: target.shown, reason: installed === agents.VERSION ? `already has the Trackfile block (v${installed})` : `has the Trackfile block v${installed}; run with --force to update to v${agents.VERSION}`, updatable: installed !== agents.VERSION, content: agents.withBlock(current, block), absolute: target.absolute, agent: agent.name });
        else steps.push({ action: current === null ? 'create' : 'append', path: target.shown, content: agents.withBlock(current ?? '', block), absolute: target.absolute, agent: agent.name });
      } else if (current !== null) steps.push({ action: 'skip', path: target.shown, reason: installed === agents.VERSION ? `already installed (v${installed})` : `installed v${installed ?? '?'}; run with --force to update to v${agents.VERSION}`, updatable: installed !== agents.VERSION, content: fresh, absolute: target.absolute, agent: agent.name });
      else steps.push({ action: 'create', path: target.shown, content: fresh, absolute: target.absolute, agent: agent.name });
    }
  }
  // Claude Code's browser panel can start the dashboard from .claude/launch.json.
  if (launch || agentList.includes('claude')) {
    const file = path.join(root, '.claude', 'launch.json');
    let config = null, broken = false;
    if (exists(file)) { try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { broken = true; } }
    const entry = { name: 'trackfile', runtimeExecutable: 'npx', runtimeArgs: ['trackfile', '--port', '3737'], port: 3737, autoPort: true };
    if (broken) steps.push({ action: 'skip', path: '.claude/launch.json', reason: 'is not valid JSON' });
    else if (config?.configurations?.some(c => c.name === 'trackfile')) steps.push({ action: 'skip', path: '.claude/launch.json', reason: 'already has the trackfile entry' });
    else {
      const next = config ?? { version: '0.0.1', configurations: [] };
      next.configurations = [...(Array.isArray(next.configurations) ? next.configurations : []), entry];
      steps.push({ action: config ? 'append' : 'create', path: '.claude/launch.json', content: JSON.stringify(next, null, 2) + '\n', absolute: file });
    }
  }
  return { project, steps };
}

function run({ cwd = process.cwd(), name, agents: agentList = [], global = false, force = false, dryRun = false, launch = false, log = console.log } = {}) {
  const root = repoRoot(cwd);
  const { project, steps } = plan({ root, name, agentList: resolveAgents(agentList), global, launch });
  log(`${dryRun ? 'Would initialize' : 'Initializing'} Trackfile in ${root} (project "${project}")`);
  let changed = 0;
  for (const step of steps) {
    const absolute = step.absolute ?? path.join(root, step.path);
    // --force rewrites every installed agent rule, even at the same version: the protocol text may change between releases.
    if (step.action === 'skip' && !(force && step.content !== undefined)) { log(`  skip    ${step.path} — ${step.reason}`); continue; }
    const verb = step.action === 'skip' ? 'update' : step.action;
    log(`  ${verb.padEnd(7)} ${step.path}${step.agent ? ` (${step.agent})` : ''}`);
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, step.content);
    changed++;
  }
  if (!dryRun) log(changed ? `Done: ${changed} file(s) written. Start the dashboard with \`npx trackfile\`.` : 'Nothing to do — everything is already in place.');
  return { root, project, steps, changed };
}

module.exports = { run, plan, resolveAgents, repoRoot };
