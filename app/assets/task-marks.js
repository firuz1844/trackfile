/* Highlighting of task mentions in an open source file.
 * Works on top of an already rendered DOM (a Markdown fragment or highlighted code) and does not know where
 * the nodes came from: it looks for back-link marks `…#task-NNN` and textual `#NNN` / `TASK NNN`, wraps the
 * number itself in span.task-mark and flags the nearest "paragraph" (p/li/td/code line) with task-hit.
 * Only textContent/createTextNode — no innerHTML, the document stays text. */
(function (root) {
  'use strict';
  // Blocks treated as a "paragraph" for highlighting; order is irrelevant — the nearest ancestor wins.
  const BLOCK_TAGS = new Set(['P', 'LI', 'TD', 'TH', 'DD', 'DT', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE']);
  const isElement = n => n && n.nodeType === 1;

  function pattern(id) {
    const digits = String(id).replace(/\D/g, '');
    if (!digits) return null;
    // Leading zeros are optional (#45 == #045), but #1350 must not match #135; TASK 135 is a registry heading.
    return new RegExp('(?:#|\\bTASK\\s+)0*' + Number(digits) + '(?!\\d)', 'g');
  }

  // Nearest block ancestor inside `scope`: a code line (.line) is the narrowest, otherwise p/li/td/…
  function blockFor(node, scope) {
    let el = isElement(node) ? node : node.parentNode;
    let fallback = null;
    while (el && el !== scope) {
      if (el.classList && el.classList.contains('line')) return el;
      if (BLOCK_TAGS.has(el.tagName) && !fallback) fallback = el;
      if (el.tagName === 'PRE') return fallback; // no code line found — highlight the whole pre
      el = el.parentNode;
    }
    return fallback;
  }

  function textNodes(scope, out = []) {
    for (const child of Array.from(scope.childNodes)) {
      if (child.nodeType === 3) out.push(child);
      else if (isElement(child) && !(child.classList && child.classList.contains('task-mark'))) textNodes(child, out);
    }
    return out;
  }

  // Splits a text node around matches and returns the created span.task-mark elements.
  function wrapMatches(text, re, doc) {
    const value = text.textContent; re.lastIndex = 0;
    const marks = []; let last = 0, m; const pieces = [];
    while ((m = re.exec(value))) {
      if (m.index > last) pieces.push(doc.createTextNode(value.slice(last, m.index)));
      const span = doc.createElement('span'); span.className = 'task-mark'; span.textContent = m[0];
      pieces.push(span); marks.push(span); last = m.index + m[0].length;
    }
    if (!marks.length) return marks;
    if (last < value.length) pieces.push(doc.createTextNode(value.slice(last)));
    const parent = text.parentNode;
    for (const piece of pieces) parent.insertBefore(piece, text);
    parent.removeChild(text);
    return marks;
  }

  /** Marks mentions of task `id` inside `scope`; returns the hit blocks in document order. */
  function mark(scope, id, doc = root.document) {
    const re = pattern(id);
    const hits = [];
    if (!re) return hits;
    const addHit = node => {
      const block = blockFor(node, scope) ?? (isElement(node) ? node : node.parentNode);
      if (!block || block === scope) return;
      if (!block.classList.contains('task-hit')) { block.classList.add('task-hit'); hits.push(block); }
    };
    const anchorRe = new RegExp('#task-0*' + Number(String(id).replace(/\D/g, '')) + '$');
    for (const text of textNodes(scope)) {
      // A back-link mark: flag the whole link so a click on it stays a click on the link.
      const link = text.parentNode;
      if (isElement(link) && link.tagName === 'A' && anchorRe.test(link.dataset?.href ?? '')) {
        link.classList.add('task-mark'); addHit(link); continue;
      }
      for (const span of wrapMatches(text, re, doc)) addHit(span);
    }
    return hits;
  }

  // The short reference #78.3 opens the third comment of task 078.
  function linkComments(scope, onOpen, doc = root.document) {
    const links = [];
    for (const text of textNodes(scope)) {
      if (text.parentNode?.closest?.('a, code')) continue;
      const value = text.textContent, re = /#0*(\d+)\.(\d+)(?![\dA-Za-z_])/g;
      let last = 0, match; const pieces = [];
      while ((match = re.exec(value))) {
        if (match.index > last) pieces.push(doc.createTextNode(value.slice(last, match.index)));
        const task = String(Number(match[1])).padStart(3, '0'), comment = Number(match[2]);
        const a = doc.createElement('a'); a.className = 'comment-ref'; a.textContent = match[0]; a.href = `#task/${task}/comment/${comment}`;
        a.addEventListener('click', event => { event.preventDefault(); onOpen(task, comment); });
        pieces.push(a); links.push(a); last = match.index + match[0].length;
      }
      if (!pieces.length) continue;
      if (last < value.length) pieces.push(doc.createTextNode(value.slice(last)));
      const parent = text.parentNode; for (const piece of pieces) parent.insertBefore(piece, text); parent.removeChild(text);
    }
    return links;
  }

  root.TaskMarks = { mark, pattern, linkComments };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TaskMarks;
})(typeof globalThis !== 'undefined' ? globalThis : this);
