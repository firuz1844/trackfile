/* Where each coding agent reads its project rules, so `trackfile init` can install the protocol for it.
 * `block` — a marked Markdown block inside a shared instructions file; `skill` — a Claude Code skill folder;
 * `mdc` — a Cursor rule with front matter. `global` lists the per-user locations an agent actually reads;
 * agents without a documented user-level file get none, so nothing is promised that is not read. */
'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const PROTOCOL = fs.readFileSync(path.join(__dirname, '..', 'skill', 'PROTOCOL.md'), 'utf8');
const VERSION = require('../package.json').version;

const home = p => path.join(os.homedir(), p);
const AGENTS = {
  claude: { name: 'Claude Code', project: [{ kind: 'skill', path: '.claude/skills/trackfile/SKILL.md' }, { kind: 'block', path: 'CLAUDE.md', pointer: true }], global: [{ kind: 'skill', path: home('.claude/skills/trackfile/SKILL.md') }] },
  codex: { name: 'Codex', project: [{ kind: 'block', path: 'AGENTS.md' }], global: [{ kind: 'block', path: home('.codex/AGENTS.md') }] },
  cursor: { name: 'Cursor', project: [{ kind: 'mdc', path: '.cursor/rules/trackfile.mdc' }], global: [] },
  gemini: { name: 'Gemini CLI', project: [{ kind: 'block', path: 'GEMINI.md' }], global: [{ kind: 'block', path: home('.gemini/GEMINI.md') }] },
  zed: { name: 'Zed', project: [{ kind: 'block', path: 'AGENTS.md' }], global: [] },
  opencode: { name: 'OpenCode', project: [{ kind: 'block', path: 'AGENTS.md' }], global: [] },
  jules: { name: 'Jules', project: [{ kind: 'block', path: 'AGENTS.md' }], global: [] }
};

const START = /<!-- trackfile:start(?: v=([\w.-]+))? -->/, END = '<!-- trackfile:end -->';
const marker = `<!-- trackfile:start v=${VERSION} -->`;
// The full protocol as a block for AGENTS.md-style files; CLAUDE.md gets a short pointer to the skill instead,
// because Claude Code loads CLAUDE.md on every turn and the skill holds the long text.
const blockText = ({ pointer = false } = {}) => `${marker}\n## Task tracking (Trackfile)\n\n${pointer
  ? 'This repository tracks work in `TRACKFILE.md` with Trackfile. Before changing any file — code, docs, tests or config — read and follow the `trackfile` skill (`.claude/skills/trackfile/SKILL.md`): no change without a task number, the task is recorded in `TRACKFILE.md` first, work ends in `review` without a commit, every commit subject starts with `#NNN`.\n'
  : PROTOCOL.trim() + '\n'}${END}\n`;
const skillText = () => `---\nname: trackfile\ndescription: Task-tracking protocol for repositories that use Trackfile (TRACKFILE.md). Use before changing any file — code, docs, tests or config — to pick or create the task, record its status in TRACKFILE.md, and put the task number into commits and code comments.\nversion: ${VERSION}\n---\n\n# Trackfile protocol\n\n${PROTOCOL.trim()}\n`;
const mdcText = () => `---\ndescription: Trackfile task-tracking protocol (TRACKFILE.md)\nalwaysApply: true\n---\n\n${marker}\n# Trackfile protocol\n\n${PROTOCOL.trim()}\n${END}\n`;

// Version installed in an existing block/skill file, or null when the file has no Trackfile content.
function installedVersion(text) {
  const m = START.exec(text) || /^version:\s*([\w.-]+)\s*$/m.exec(text);
  return m ? m[1] ?? 'unknown' : null;
}
// Replace an existing marked block or append a new one; the rest of the file is untouched.
function withBlock(text, block) {
  const start = START.exec(text);
  const end = text.indexOf(END);
  if (start && end > start.index) return text.slice(0, start.index) + block + text.slice(end + END.length).replace(/^\n/, '');
  return (text.trimEnd() ? text.trimEnd() + '\n\n' : '') + block;
}

module.exports = { AGENTS, VERSION, PROTOCOL, START, END, blockText, skillText, mdcText, installedVersion, withBlock };
