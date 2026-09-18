/* Structural 3-way merge of the registry/archive text (#207): used both as a standalone `git merge`
 * driver (registered on TRACKFILE.md/.trackfile/archive.md via .gitattributes) and by the sync engine
 * (#206) whenever it finds a genuinely diverged local queue it can't reconcile by re-fetching and retrying.
 *
 * Deliberately does NOT reuse `M.parse()` for the raw per-file merge: that function requires a registry
 * file to be present (even when merging archive.md alone) and validates cross-file references that may
 * legitimately live in the *other* file (a task's parent living in the registry while it itself is
 * archived, say) — exactly the kind of thing a single-path git merge driver cannot see. Records are instead
 * located with the same block grammar `M.yaml` already parses (`### TYPE ID` + a yaml fence + prose), and
 * the merged text is validated afterwards with `checkInvariants` (shared with `trackfile check`, #208),
 * which only requires internal consistency, not full cross-file resolution. */
'use strict';
const M = require('../app/assets/model.js');

class MergeConflictError extends Error {
  constructor(conflicts) {
    super(`trackfile merge: unresolved conflict(s) on ${conflicts.map(c => `#${c.id}.${c.field} (ours: ${JSON.stringify(c.ours)}, theirs: ${JSON.stringify(c.theirs)})`).join(', ')}`);
    this.conflicts = conflicts;
  }
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
function frontMatter(text) {
  const m = FRONT_MATTER.exec(text);
  if (!m) return { meta: {}, end: 0 };
  return { meta: M.yaml(m[1]), end: m[0].length };
}

// `### TYPE ID` + a yaml fence + prose, up to the next `### `/`## ` heading or EOF — the same grammar
// parseRegistry (private to model.js) uses, reimplemented here because it isn't exported for reuse.
function blockRegex(type) { return new RegExp(`^### ${type} (\\S+)\\r?\\n\`\`\`yaml\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`\\r?\\n\\r?\\n?([\\s\\S]*?)(?=^### |^## |$(?![\\s\\S]))`, 'gm'); }
function parseBlocks(text, type) {
  const blocks = [];
  for (const m of text.matchAll(blockRegex(type))) {
    const [full, id, yamlText, body] = m;
    let data; try { data = M.yaml(yamlText); } catch { continue; } // unparseable block: leave it to `trackfile check` to report, not this merge
    blocks.push({ id, data, body: body.replace(/\s+$/, ''), start: m.index, end: m.index + full.length });
  }
  return blocks;
}
const byId = blocks => new Map(blocks.map(b => [b.id, b]));
const record = (type, data, body) => { const prose = (body || '').trim(); return `### ${type} ${data.id}\n\`\`\`yaml\n${M.dump(data)}\n\`\`\`\n\n` + (prose ? prose + '\n\n' : ''); };
function splice(text, edits) {
  for (const e of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.replacement + text.slice(e.end);
  return text;
}

const USER_CLOSED = new Set(['cancelled', 'removed', 'done']);
const laterOf = (oursVal, theirsVal, oursTime, theirsTime) => (Date.parse(oursTime) >= Date.parse(theirsTime) ? oursVal : theirsVal);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// One field of one record, given its value in the common ancestor and both sides. `undefined` for a field
// absent from a version (added/removed field) behaves like any other differing value.
function mergeField(id, field, baseVal, oursVal, theirsVal, oursTime, theirsTime) {
  if (eq(oursVal, theirsVal)) return oursVal;
  if (eq(oursVal, baseVal)) return theirsVal; // only theirs changed it
  if (eq(theirsVal, baseVal)) return oursVal; // only ours changed it
  // Both changed it, to different values.
  if (field === 'updated_at') return laterOf(oursVal, theirsVal, oursVal, theirsVal);
  if ((field === 'labels' || field === 'blocked_by' || field === 'relates_to') && Array.isArray(oursVal) && Array.isArray(theirsVal)) {
    return [...new Set([...oursVal, ...theirsVal])]; // user-owned metadata: union rather than pick a side
  }
  if (field === 'status') {
    const oursClosed = USER_CLOSED.has(oursVal), theirsClosed = USER_CLOSED.has(theirsVal);
    if (oursClosed && !theirsClosed) return oursVal; // the user's decision to close/cancel wins over an agent's transient status
    if (theirsClosed && !oursClosed) return theirsVal;
    throw new MergeConflictError([{ id, field, ours: oursVal, theirs: theirsVal }]); // both agent-transient, or both closed differently
  }
  if (field === 'result') throw new MergeConflictError([{ id, field, ours: oursVal, theirs: theirsVal }]);
  if (field === 'branch' || field === 'commit' || field === 'sources') return laterOf(oursVal, theirsVal, oursTime, theirsTime);
  return laterOf(oursVal, theirsVal, oursTime, theirsTime); // title, assignee, parent, milestone, kind, completed_at, priority, color, …
}

// Merges one existing record (present in the common ancestor, edited on one or both sides).
function mergeRecord(id, base, ours, theirs) {
  const oursTime = ours.data.updated_at ?? '1970-01-01T00:00:00Z', theirsTime = theirs.data.updated_at ?? '1970-01-01T00:00:00Z';
  const fields = new Set([...Object.keys(ours.data), ...Object.keys(theirs.data), ...(base ? Object.keys(base.data) : [])]);
  const conflicts = [];
  const data = {};
  for (const f of fields) {
    try { data[f] = mergeField(id, f, base ? base.data[f] : undefined, ours.data[f], theirs.data[f], oursTime, theirsTime); }
    catch (error) { if (error instanceof MergeConflictError) conflicts.push(...error.conflicts); else throw error; }
  }
  if (conflicts.length) throw new MergeConflictError(conflicts);
  const body = eq(data, theirs.data) ? theirs.body : (data.updated_at === oursTime ? ours.body : theirs.body);
  return { data, body };
}

// Cycle check identical in spirit to model.js's own (parent chain only; label/dependency existence and
// cross-file references are `trackfile check`'s job, since a single-path merge driver can't see them).
function checkNoCycles(blocks) {
  const parents = new Map(blocks.map(b => [b.id, b.data.parent ?? null]));
  for (const id of parents.keys()) {
    const seen = new Set([id]);
    let p = parents.get(id);
    while (p) { if (seen.has(p)) throw new Error(`trackfile merge: cycle introduced through #${id} → ... → #${p}`); seen.add(p); p = parents.has(p) ? parents.get(p) : null; }
  }
}

/* Merges one record TYPE ('TASK', 'MILESTONE' or 'LABEL') across base/ours/theirs texts, returning
 * `{ text, renumbered }` where `renumbered` maps every id trackfile-merge assigned a fresh number to what
 * it used to be (empty unless `renumber` is set and there was anything to renumber). `theirs` supplies the
 * document shell (front matter, prose, section order) that edits are spliced into; `renumber` additionally
 * bumps `next_task` in that shell's front matter, so it should be true for TASK records in TRACKFILE.md and
 * false everywhere else (archive.md has no `next_task`; milestones/labels aren't sequentially numbered). */
function mergeBlocks(type, baseText, oursText, theirsText, { renumber = false } = {}) {
  const baseBlocks = byId(parseBlocks(baseText, type)), oursBlocks = byId(parseBlocks(oursText, type)), theirsBlocks = byId(parseBlocks(theirsText, type));
  const { meta: theirsMeta } = frontMatter(theirsText);
  let nextId = renumber ? (theirsMeta.next_task ?? 1) : null;
  const remap = new Map();
  const edits = [];
  let appended = '';
  const conflicts = [];

  for (const [id, ours] of oursBlocks) {
    if (baseBlocks.has(id)) continue; // existing record — handled below regardless of theirs' state
    // New in ours (absent from the common ancestor): renumbered unconditionally, whether or not theirs
    // happens to also have something at this id — a stale local id is never trustworthy once merging.
    if (renumber) {
      const freshId = String(nextId++).padStart(3, '0');
      remap.set(id, freshId);
    }
  }
  for (const [id, ours] of oursBlocks) {
    if (baseBlocks.has(id)) continue;
    const freshId = remap.get(id) ?? id;
    const data = { ...ours.data, id: freshId };
    for (const field of ['parent', 'milestone']) if (data[field] && remap.has(data[field])) data[field] = remap.get(data[field]);
    for (const field of ['blocked_by', 'relates_to']) if (Array.isArray(data[field])) data[field] = data[field].map(ref => remap.get(ref) ?? ref);
    appended += record(type, data, ours.body);
  }

  for (const [id, theirs] of theirsBlocks) {
    const base = baseBlocks.get(id) ?? null;
    const ours = oursBlocks.get(id) ?? null;
    if (!ours || !base) continue; // untouched by ours, or ours' record at this id is unrelated (handled above as new-in-ours)
    try { const merged = mergeRecord(id, base, ours, theirs); edits.push({ start: theirs.start, end: theirs.end, replacement: record(type, merged.data, merged.body) }); }
    catch (error) { if (error instanceof MergeConflictError) conflicts.push(...error.conflicts); else throw error; }
  }
  if (conflicts.length) throw new MergeConflictError(conflicts);

  let text = splice(theirsText, edits);
  if (appended) text = text.replace(/\n*$/, '\n\n') + appended.trimEnd() + '\n';
  if (renumber && remap.size) {
    const { meta, end } = frontMatter(text);
    text = `---\n${M.dump({ ...meta, next_task: nextId })}\n---\n` + text.slice(end);
  }
  return { text, remap };
}

// Public entry point: merges a whole registry-like file (TASK records, then MILESTONE, then LABEL —
// order matters only for `remap`, since a later kind's `renumber` is always false so it never reads it).
function mergeRegistryText(baseText, oursText, theirsText, { renumberTasks = false } = {}) {
  let text = theirsText;
  const tasks = mergeBlocks('TASK', baseText, oursText, text, { renumber: renumberTasks });
  text = tasks.text;
  const milestones = mergeBlocks('MILESTONE', baseText, oursText, text);
  text = milestones.text;
  const labels = mergeBlocks('LABEL', baseText, oursText, text);
  text = labels.text;
  checkNoCycles(parseBlocks(text, 'TASK'));
  return { text, taskRemap: tasks.remap };
}

module.exports = { mergeRegistryText, MergeConflictError, parseBlocks, checkNoCycles };
