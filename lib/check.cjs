/* `trackfile check` (#207): validates the full-document invariants that a single-path merge driver can't
 * see on its own — unique ids, next_task ahead of every existing id, and that every parent/milestone/label/
 * dependency reference actually exists (`M.parse` already enforces all of this; this command is just the
 * user-facing "is the registry healthy" entry point migrate/sync's own preflight checks share). */
'use strict';
const M = require('../app/assets/model.js');
const { readRegistryFiles } = require('./layout.cjs');

function check(layout) {
  let doc;
  try { doc = M.parse(readRegistryFiles(layout)); }
  catch (error) { return { ok: false, message: `trackfile check: ${error.message}` }; }
  const archived = doc.tasks.filter(t => t.archived).length;
  return { ok: true, message: `trackfile check: OK — ${doc.tasks.length} task(s) (${archived} archived), ${doc.milestones.length} milestone(s), ${doc.labels.length} label(s), next_task ${doc.meta.next_task}.` };
}

module.exports = { check };
