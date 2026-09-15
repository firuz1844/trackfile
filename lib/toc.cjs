/* Table of contents of the registry for agents: one line per task instead of reading the whole file.
 * `trackfile toc` — open tasks; `--closed` adds done/cancelled/removed; `--all` also includes the archive. */
'use strict';
const M = require('../app/assets/model.js');
const { readRegistryFiles } = require('./layout.cjs');

function toc(layout, { all = false, closed = false } = {}) {
  let files = readRegistryFiles(layout, { archive: all });
  let doc;
  try { doc = M.parse(files); } catch (error) {
    // A comments folder of an archived task is not a reason to stay silent: retry with the archive, then report.
    if (!all && error.code === 'comments_orphan') { files = readRegistryFiles(layout, { archive: true }); doc = M.parse(files); } else throw error;
  }
  const lines = [`next_task: ${doc.meta.next_task}`, ''];
  for (const m of doc.milestones) lines.push(`${m.id} | ${m.title}`);
  lines.push('', 'ID  | status      | milestone | parent | kind    | title');
  for (const t of doc.tasks) {
    if (!closed && !all && M.closed.has(t.status)) continue;
    lines.push(`${t.id} | ${t.status.padEnd(11)} | ${(M.milestoneOf(doc, t) ?? '-').padEnd(9)} | ${(t.parent ?? '-').padEnd(6)} | ${t.kind.padEnd(7)} | ${t.title}${t.archived ? ' [archived]' : ''}${t.comments.length ? ` [comments: ${t.comments.length}]` : ''}`);
  }
  return lines.join('\n');
}
module.exports = { toc };
