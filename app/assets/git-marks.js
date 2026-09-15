/* Highlighting of a file's uncommitted changes on top of the rendered source.
 * Input: the file's `git diff HEAD -U0` patch parsed by DiffParser; output: hit blocks in document order.
 * Added lines get the git-add class on the narrowest block that knows its lines: a code line (.line) or a
 * Markdown block with data-line-start/end. Deleted lines are inserted where they were as pre.git-del
 * (Markdown) or .line.git-del (code). Only textContent — no innerHTML. */
(function (root) {
  'use strict';
  const isElement = n => n && n.nodeType === 1;
  const children = n => Array.from(n.childNodes).filter(isElement);
  const range = n => n.dataset && n.dataset.lineStart !== undefined ? [Number(n.dataset.lineStart), Number(n.dataset.lineEnd)] : null;
  const hasClass = (n, c) => Boolean(n.classList && n.classList.contains(c));

  // From -U0 hunks: the set of added lines (new numbering) and deletions as "before line N" with text.
  function changes(file) {
    const added = new Set(), deletions = [];
    if (!file) return { added, deletions };
    for (const h of file.hunks) {
      const del = h.lines.filter(l => l.type === 'del').map(l => l.text);
      for (const l of h.lines) if (l.type === 'add') added.add(l.new);
      // A pure deletion is addressed by the line it followed; otherwise the deleted text stood before the first new line.
      if (del.length) deletions.push({ before: h.newCount === 0 ? h.newStart + 1 : h.newStart, lines: del });
    }
    return { added, deletions };
  }

  // Code lines inside a node: span.line in document order (without descending into nested pre).
  function codeLines(node, out = []) {
    for (const c of children(node)) { if (hasClass(c, 'line')) { if (!hasClass(c, 'git-del')) out.push(c); } else codeLines(c, out); }
    return out;
  }
  // The narrowest block containing line L. Nested list ranges may extend past the parent's range, so the
  // descent does not stop at "does not contain" — the deepest block whose range contains L wins.
  function deepest(node, L) {
    let best = null;
    for (const c of children(node)) {
      if (hasClass(c, 'git-del')) continue;
      const r = range(c);
      const inner = deepest(c, L);
      if (inner) best = inner; else if (r && L >= r[0] && L <= r[1]) best = c;
    }
    return best;
  }
  // Inside a Markdown `pre` the code lines start right after the ``` line; in plain code from the first line.
  function codeLineFor(pre, L) {
    const r = range(pre), lines = codeLines(pre);
    const k = r ? L - r[0] - 1 : L - 1;
    return k >= 0 && k < lines.length ? lines[k] : null;
  }
  const isPlainCode = scope => !deepest(scope, 1) && !children(scope).some(c => range(c)) && codeLines(scope).length > 0;

  function mark(scope, file, doc = root.document) {
    const { added, deletions } = changes(file);
    const plain = isPlainCode(scope);
    const hit = node => { if (node && !hasClass(node, 'git-add')) node.classList.add('git-add'); };
    for (const L of added) {
      if (plain) { hit(codeLineFor(scope, L)); continue; }
      const block = deepest(scope, L);
      if (!block) continue;
      if (block.tagName === 'PRE') { const line = codeLineFor(block, L); hit(line ?? block); if (line) block.classList.add('git-touched'); }
      else hit(block);
    }
    const makeDel = lines => {
      const pre = doc.createElement('pre'); pre.className = 'git-del';
      const code = doc.createElement('code');
      for (const text of lines) { const s = doc.createElement('span'); s.className = 'line'; s.textContent = text; code.append(s); }
      pre.append(code); return pre;
    };
    for (const { before, lines } of deletions) {
      if (plain) {
        const code = codeLines(scope)[0]?.parentNode; if (!code) continue;
        const ref = codeLineFor(scope, before);
        for (const text of lines) { const s = doc.createElement('span'); s.className = 'line git-del'; s.textContent = text; if (ref) code.insertBefore(s, ref); else code.append(s); }
        continue;
      }
      const block = deepest(scope, before);
      if (block && block.tagName === 'PRE' && codeLineFor(block, before)) {
        const ref = codeLineFor(block, before), code = ref.parentNode;
        for (const text of lines) { const s = doc.createElement('span'); s.className = 'line git-del'; s.textContent = text; code.insertBefore(s, ref); }
        block.classList.add('git-touched'); continue;
      }
      // The top-level block the deleted lines preceded; at the end of the document — append.
      const top = children(scope).find(c => { const r = range(c); return r && r[1] >= before; });
      const del = makeDel(lines);
      if (top) scope.insertBefore(del, top); else scope.append(del);
    }
    const hits = [];
    (function collect(node) { for (const c of children(node)) { if (hasClass(c, 'git-add') || hasClass(c, 'git-del')) hits.push(c); if (!hasClass(c, 'git-del')) collect(c); } })(scope);
    return hits;
  }

  root.GitMarks = { mark, changes };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.GitMarks;
})(typeof globalThis !== 'undefined' ? globalThis : this);
