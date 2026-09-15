/* Minimal Markdown → DOM renderer for the source reader and task text. Builds nodes with textContent only,
 * so task-supplied documents can never inject markup or scripts (CSP forbids inline anyway).
 * Covers what project docs use: headings, paragraphs, lists, code, quotes, tables, links, images. */
(function (root) {
  'use strict';
  const doc = () => root.document;
  const el = (tag, text) => { const n = doc().createElement(tag); if (text !== undefined) n.textContent = text; return n; };

  // Inline: code spans are cut out first (their content is literal) and stand in as placeholders while
  // links, bold and italic are matched across the whole run, then put back as <code>.
  // breaks — the text arrives with '\n' inside (a whole paragraph, so **bold** can span a line break);
  // the breaks themselves become <br> here, at the level of text pieces.
  // `![alt](src)` is an image only when the caller allowed the source through imageSrc(href) → URL (task
  // attachments); otherwise (source reader, external addresses) it stays a plain link with the alt text —
  // nothing is lost silently.
  function inline(text, target, linkHandler, breaks = false, imageSrc = null) {
    const codes = [];
    const masked = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    const emitText = str => {
      for (const piece of str.split(/(\u0000\d+\u0000)/)) {
        if (!piece) continue;
        const m = /^\u0000(\d+)\u0000$/.exec(piece);
        if (m) { target.append(el('code', codes[m[1]])); continue; }
        if (!breaks) { target.append(doc().createTextNode(piece)); continue; }
        piece.split('\n').forEach((part, n) => { if (n) target.append(el('br')); if (part) target.append(doc().createTextNode(part)); });
      }
    };
    // `_`/`__` inside a word (IMG_4631.PNG) is not emphasis, as in CommonMark; otherwise the underscores of
    // two neighbouring file names would form an <em> and eat the markup of the second image. Intraword `*` is allowed.
    const re = /(!?)\[([^\]]*)\]\(([^)\s]+)\)|\*\*([^]+?)\*\*|(?<![\p{L}\p{N}_])__([^]+?)__(?![\p{L}\p{N}_])|\*(?!\s)([^]+?)(?<!\s)\*|(?<![\p{L}\p{N}_])_(?!\s)([^]+?)(?<!\s)_(?![\p{L}\p{N}_])/u;
    let rest = masked, m;
    while ((m = re.exec(rest))) {
      if (m.index) emitText(rest.slice(0, m.index));
      const unmask = str => str.replace(/\u0000(\d+)\u0000/g, (_, i) => '`' + codes[i] + '`');
      if (m[3] !== undefined) {
        const href = m[3], label = unmask(m[2]); // captured: the loop reuses `m`
        // `#w=320` (or `#w=320x200`) at the end of the address is the display size in px; the fragment never
        // reaches the server and other Markdown viewers simply ignore it. The image is wrapped in a link to the full file.
        const size = /#w=(\d+)(?:x(\d+))?$/.exec(href);
        const src = m[1] && imageSrc ? imageSrc(size ? href.slice(0, size.index) : href) : null;
        if (src) {
          const img = el('img'); img.src = src; img.alt = label; img.loading = 'lazy'; img.dataset.href = href;
          if (size) { img.width = Number(size[1]); if (size[2]) img.height = Number(size[2]); img.className = 'md-sized'; }
          const a = el('a'); a.href = src; a.target = '_blank'; a.rel = 'noopener'; a.className = 'md-image'; a.title = label || href; a.append(img); target.append(a);
        }
        else if (!m[1] && !label) emitText(m[0]);
        else {
          const a = el('a'); inline(label || href, a, linkHandler, breaks, imageSrc); a.dataset.href = href;
          if (/^https?:\/\//.test(href)) { a.href = href; a.target = '_blank'; a.rel = 'noopener'; }
          else { a.href = '#'; a.className = 'md-local'; if (linkHandler) a.addEventListener('click', e => { e.preventDefault(); linkHandler(href); }); }
          target.append(a);
        }
      } else if (m[4] !== undefined || m[5] !== undefined) { const b = el('strong'); inline(unmask(m[4] ?? m[5]), b, linkHandler, breaks, imageSrc); target.append(b); }
      else { const i = el('em'); inline(unmask(m[6] ?? m[7]), i, linkHandler, breaks, imageSrc); target.append(i); }
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) emitText(rest);
  }

  // Every block gets data-line-start/data-line-end (1-based source lines, with lineOffset for nested quotes)
  // so lines from a git diff can be highlighted on top of the DOM.
  // breaks — a single line break inside a paragraph/item becomes <br> (like GitHub comments): task
  // descriptions and comments were written as plain text with pre-wrap and their lines must not merge.
  function render(markdown, { linkHandler, highlight, lineOffset = 0, breaks = false, imageSrc = null } = {}) {
    const out = doc().createDocumentFragment();
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    const span = (node, from, to) => { node.dataset.lineStart = String(lineOffset + from + 1); node.dataset.lineEnd = String(lineOffset + to + 1); return node; };
    const listStack = []; // { indent, node }
    const closeLists = (indent = -1) => { while (listStack.length && listStack.at(-1).indent > indent) listStack.pop(); };
    let paragraph = [], paragraphStart = 0;
    const flush = () => {
      if (!paragraph.length) return;
      const p = el('p');
      inline(paragraph.join(breaks ? '\n' : ' '), p, linkHandler, breaks, imageSrc);
      out.append(span(p, paragraphStart, paragraphStart + paragraph.length - 1)); paragraph = [];
    };
    while (i < lines.length) {
      const line = lines[i], start = i;
      let m;
      if ((m = /^(\s*)(```|~~~)\s*(\S*)/.exec(line))) {
        flush(); closeLists();
        const fence = m[2], code = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
        i++;
        const pre = el('pre'), c = el('code');
        if (m[3]) c.dataset.lang = m[3];
        if (highlight && m[3]) highlight(c, code.join('\n'), m[3]); else c.textContent = code.join('\n');
        pre.append(c); out.append(span(pre, start, Math.min(i, lines.length) - 1));
        continue;
      }
      if (!line.trim()) { flush(); closeLists(); i++; continue; }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { flush(); closeLists(); const h = el('h' + m[1].length); inline(m[2], h, linkHandler, false, imageSrc); out.append(span(h, i, i)); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); closeLists(); out.append(span(el('hr'), i, i)); i++; continue; }
      if ((m = /^>\s?(.*)$/.exec(line))) {
        flush(); closeLists();
        const quoted = [];
        while (i < lines.length && (m = /^>\s?(.*)$/.exec(lines[i]))) { quoted.push(m[1]); i++; }
        const q = el('blockquote'); q.append(render(quoted.join('\n'), { linkHandler, highlight, lineOffset: lineOffset + start, breaks, imageSrc })); out.append(span(q, start, i - 1));
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush(); closeLists();
        const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const table = el('table'), thead = el('thead'), tr = el('tr');
        for (const c of cells(line)) { const th = el('th'); inline(c, th, linkHandler, false, imageSrc); tr.append(th); }
        thead.append(span(tr, i, i)); table.append(thead);
        const tbody = el('tbody'); i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          const row = el('tr'); for (const c of cells(lines[i])) { const td = el('td'); inline(c, td, linkHandler, false, imageSrc); row.append(td); }
          tbody.append(span(row, i, i)); i++;
        }
        table.append(tbody); out.append(span(table, start, i - 1));
        continue;
      }
      if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
        flush();
        const indent = m[1].length, ordered = /\d/.test(m[2]);
        closeLists(indent);
        if (!listStack.length || listStack.at(-1).indent < indent) {
          const list = el(ordered ? 'ol' : 'ul');
          const parentItem = listStack.length ? listStack.at(-1).node.lastElementChild : null;
          (parentItem || out).append(list);
          listStack.push({ indent, node: list });
        }
        const li = el('li');
        let text = m[3];
        const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
        if (task) { const box = el('input'); box.type = 'checkbox'; box.checked = task[1] !== ' '; box.disabled = true; li.append(box, ' '); text = task[2]; }
        const item = [text];
        listStack.at(-1).node.append(li);
        i++;
        // Lazy continuation lines belong to the item.
        while (i < lines.length && lines[i].trim() && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]) && !/^#{1,6}\s|^```|^>|^\s*\|/.test(lines[i])) { item.push(lines[i].trim()); i++; }
        inline(item.join(breaks ? '\n' : ' '), li, linkHandler, breaks, imageSrc);
        span(li, start, i - 1);
        continue;
      }
      closeLists();
      if (!paragraph.length) paragraphStart = i;
      paragraph.push(line.trim()); i++;
    }
    flush(); closeLists();
    return out;
  }
  root.MarkdownRenderer = { render };
  if (typeof module !== 'undefined') module.exports = root.MarkdownRenderer;
})(globalThis);
