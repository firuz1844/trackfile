/* Repository layout: where the registry, the archive, task folders and the UI config live.
 * Defaults are TRACKFILE.md at the repository root plus a `.trackfile/` folder; a project may override
 * the three paths in the registry's front matter (`archive_file`, `tasks_dir`, `config_file`) or point the
 * CLI at a differently named registry with `--registry`. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const M = require('../app/assets/model.js');

const DEFAULTS = Object.freeze({ registry: 'TRACKFILE.md', archive: '.trackfile/archive.md', tasks: '.trackfile/tasks', config: '.trackfile/config.json' });
const toPosix = p => p.split(path.sep).join('/');

// Walk up from `cwd` until a directory containing the registry file is found (like git looks for .git).
function findRoot(cwd = process.cwd(), registry = DEFAULTS.registry) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, registry))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Front-matter overrides are read with the registry's own YAML subset; a broken front matter is not fatal
// here (the dashboard reports it) — the defaults are used instead.
function overridesFrom(file) {
  try {
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(fs.readFileSync(file, 'utf8'));
    return front ? M.yaml(front[1]) : {};
  } catch { return {}; }
}

const safeRelative = (root, value, fallback) => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const rel = toPosix(path.normalize(value.trim()));
  return rel.startsWith('..') || path.isAbsolute(rel) ? fallback : rel;
};

function resolveLayout(root, { registry = DEFAULTS.registry } = {}) {
  root = path.resolve(root);
  const registryRel = safeRelative(root, registry, DEFAULTS.registry);
  const meta = overridesFrom(path.join(root, registryRel));
  const layout = {
    root,
    registry: registryRel,
    archive: safeRelative(root, meta.archive_file, DEFAULTS.archive),
    tasks: safeRelative(root, meta.tasks_dir, DEFAULTS.tasks),
    config: safeRelative(root, meta.config_file, DEFAULTS.config)
  };
  // How task text refers to attachments: relative to the registry file (`.trackfile/tasks/042/x.png`).
  layout.attachmentsPrefix = toPosix(path.relative(path.dirname(registryRel), layout.tasks)) || '.';
  return layout;
}

// Logical file names used by the model and the API → repository-relative paths.
function relativeOf(layout, name) {
  if (name === M.REGISTRY) return layout.registry;
  if (name === M.ARCHIVE) return layout.archive;
  if (name === 'config') return layout.config;
  const m = M.COMMENTS_FILE.exec(name);
  if (m) return `${layout.tasks}/${m[1]}/comments.md`;
  return null;
}
const diskPath = (layout, name) => { const rel = relativeOf(layout, name); return rel === null ? null : path.join(layout.root, rel); };
const taskDir = (layout, id) => path.join(layout.root, layout.tasks, id);
const publicLayout = layout => ({ registry: layout.registry, archive: layout.archive, tasks: layout.tasks, config: layout.config, attachmentsPrefix: layout.attachmentsPrefix });

// All registry files as the model expects them: {registry, archive?, 'comments/NNN'…}.
function readRegistryFiles(layout, { archive = true } = {}) {
  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const files = { [M.REGISTRY]: read(diskPath(layout, M.REGISTRY)) };
  const archiveText = archive ? read(diskPath(layout, M.ARCHIVE)) : null;
  if (archiveText !== null) files[M.ARCHIVE] = archiveText;
  const tasksDir = path.join(layout.root, layout.tasks);
  const dirs = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter(d => /^\d{3,}$/.test(d)).sort() : [];
  for (const id of dirs) { const text = read(path.join(tasksDir, id, 'comments.md')); if (text !== null) files[M.commentsFile(id)] = text; }
  return files;
}

module.exports = { DEFAULTS, findRoot, resolveLayout, relativeOf, diskPath, taskDir, publicLayout, readRegistryFiles };
