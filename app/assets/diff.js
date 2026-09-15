/* Unified diff parser (`git show -p`) into a structure for the commit page. A pure function without DOM,
 * so it is covered by a Node test; rendering and highlighting live in app.js. Nothing is interpreted as HTML. */
(function (root) {
  'use strict';
  const unquote = s => s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(?:([0-7]{3})|(.))/g, (_, oct, ch) => oct ? String.fromCharCode(parseInt(oct, 8)) : ch) : s;
  // Path from `--- a/x` / `+++ b/x`; `/dev/null` marks an added or deleted file.
  const stripPrefix = s => { const p = unquote(s.trim()); return p === '/dev/null' ? null : p.replace(/^[ab]\//, ''); };
  // Returns [{path, oldPath, status, binary, hunks: [{header, oldStart, newStart, lines: [{type, old, new, text}]}]}].
  function parse(patch) {
    const files = [];
    let file = null, hunk = null, oldNo = 0, newNo = 0;
    for (const raw of patch.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')) {
      if (raw.startsWith('diff --git ')) {
        // `diff --git a/old b/new` — the header carries both names; `---`/`+++` below may be absent for binaries.
        const m = /^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*?)"?$/.exec(raw);
        file = { path: m ? unquote(m[2]) : raw.slice(11), oldPath: m ? unquote(m[1]) : null, status: 'modified', binary: false, hunks: [] };
        if (file.oldPath === file.path) file.oldPath = null;
        files.push(file); hunk = null; continue;
      }
      if (!file) continue;
      if (!hunk) {
        if (raw.startsWith('new file mode')) file.status = 'added';
        else if (raw.startsWith('deleted file mode')) file.status = 'deleted';
        else if (raw.startsWith('rename from ') || raw.startsWith('copy from ')) file.status = raw.startsWith('copy') ? 'copied' : 'renamed';
        else if (raw.startsWith('similarity index') || raw.startsWith('index ') || raw.startsWith('old mode') || raw.startsWith('new mode') || raw.startsWith('rename to') || raw.startsWith('copy to')) continue;
        else if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) { file.binary = true; continue; }
        else if (raw.startsWith('--- ')) { const p = stripPrefix(raw.slice(4)); if (p === null) file.status = 'added'; continue; }
        else if (raw.startsWith('+++ ')) { const p = stripPrefix(raw.slice(4)); if (p === null) file.status = 'deleted'; else file.path = p; continue; }
      }
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
      if (h) {
        oldNo = Number(h[1]); newNo = Number(h[3]);
        hunk = { header: raw, oldStart: oldNo, newStart: newNo, oldCount: h[2] === undefined ? 1 : Number(h[2]), newCount: h[4] === undefined ? 1 : Number(h[4]), context: h[5].trim(), lines: [] };
        file.hunks.push(hunk); continue;
      }
      if (!hunk) continue;
      if (raw.startsWith('+')) hunk.lines.push({ type: 'add', old: null, new: newNo++, text: raw.slice(1) });
      else if (raw.startsWith('-')) hunk.lines.push({ type: 'del', old: oldNo++, new: null, text: raw.slice(1) });
      else if (raw.startsWith('\\')) hunk.lines.push({ type: 'meta', old: null, new: null, text: raw.slice(2) });
      else if (raw.startsWith(' ') || raw === '') hunk.lines.push({ type: 'ctx', old: oldNo++, new: newNo++, text: raw.slice(1) });
    }
    for (const f of files) { f.additions = 0; f.deletions = 0; for (const h of f.hunks) for (const l of h.lines) { if (l.type === 'add') f.additions++; else if (l.type === 'del') f.deletions++; } }
    return files;
  }
  root.DiffParser = { parse };
  if (typeof module !== 'undefined') module.exports = root.DiffParser;
})(globalThis);
