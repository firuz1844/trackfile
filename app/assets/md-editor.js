/* Markdown helper for the dialog textareas (task description, comment, milestone description).
 * No third-party editors: the dashboard is plain <script> tags without npm or a build, CSP script-src 'self'.
 * All logic is a pure function edit(text, start, end, key) → {text, start, end} | null so it can be tested
 * without a browser; mount() only wires keydown, the Preview tab (same MarkdownRenderer) and the hint. */
(function (root) {
  'use strict';
  const ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/; // indent, marker, gap, checkbox, content
  const FENCE = /^\s*(```|~~~)/;
  const INDENT = '  ';

  const lineStart = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = (text, pos) => { const n = text.indexOf('\n', pos); return n === -1 ? text.length : n; };
  // Is a fence open before the position: an odd number of fence lines above means we are inside a code block.
  const insideFence = (text, pos) => text.slice(0, lineStart(text, pos)).split('\n').filter(l => FENCE.test(l)).length % 2 === 1;

  // Wrap the selection in a marker (**, _, `): applying it again removes it; without a selection insert a pair with the caret inside.
  function wrap(text, start, end, mark) {
    const sel = text.slice(start, end), n = mark.length;
    if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length >= 2 * n) return { text: text.slice(0, start) + sel.slice(n, -n) + text.slice(end), start, end: end - 2 * n };
    if (text.slice(start - n, start) === mark && text.slice(end, end + n) === mark) return { text: text.slice(0, start - n) + sel + text.slice(end + n), start: start - n, end: end - n };
    return { text: text.slice(0, start) + mark + sel + mark + text.slice(end), start: start + n, end: end + n };
  }
  // Link: a selected URL goes into the parentheses and the placeholder label is selected; otherwise the selection becomes the label and the URL slot is selected.
  function link(text, start, end) {
    const sel = text.slice(start, end);
    if (/^https?:\/\/\S+$/.test(sel)) { const label = linkLabel(); return { text: text.slice(0, start) + '[' + label + '](' + sel + ')' + text.slice(end), start: start + 1, end: start + 1 + label.length }; }
    const url = 'url', head = text.slice(0, start) + '[' + sel + '](';
    return { text: head + url + ')' + text.slice(end), start: head.length, end: head.length + url.length };
  }
  // Indent the selected lines (or the current one) by one step; delta = -1 removes at most one step.
  function shift(text, start, end, delta) {
    const from = lineStart(text, start), to = lineEnd(text, Math.max(start, end - (end > start && text[end - 1] === '\n' ? 1 : 0)));
    const lines = text.slice(from, to).split('\n');
    let firstDelta = 0, total = 0;
    const out = lines.map((l, i) => {
      let d;
      if (delta > 0) { l = INDENT + l; d = INDENT.length; }
      else { const cut = Math.min(INDENT.length, /^ */.exec(l)[0].length); l = l.slice(cut); d = -cut; }
      if (i === 0) firstDelta = d; total += d; return l;
    });
    // A selection starting at a line start stays at the line start, so a repeated Tab moves the same lines.
    return { text: text.slice(0, from) + out.join('\n') + text.slice(to), start: start === from ? from : Math.max(from, start + firstDelta), end: Math.max(from, end + total) };
  }
  function enter(text, start, end) {
    const from = lineStart(text, start), line = text.slice(from, start), tail = text.slice(start, lineEnd(text, start));
    // A ``` fence was opened and Enter pressed — close it right away with the caret on the empty line inside.
    const fence = FENCE.exec(line);
    if (fence && !tail && !insideFence(text, start)) { const ins = '\n\n' + fence[1]; return { text: text.slice(0, start) + ins + text.slice(end), start: start + 1, end: start + 1 }; }
    if (insideFence(text, start)) return null;
    const m = ITEM.exec(line);
    if (!m) return null;
    const [, indent, marker, gap, box, content] = m;
    // Enter on an empty item ends the list: the marker is removed, the line stays empty.
    if (!content && !tail) return { text: text.slice(0, from) + text.slice(start), start: from, end: from };
    const next = /\d/.test(marker) ? String(parseInt(marker, 10) + 1) + marker.slice(-1) : marker;
    const ins = '\n' + indent + next + gap + (box ? '[ ] ' : '');
    return { text: text.slice(0, start) + ins + text.slice(end), start: start + ins.length, end: start + ins.length };
  }
  function backspace(text, start, end) {
    if (start !== end) return null;
    const from = lineStart(text, start), line = text.slice(from, start), m = ITEM.exec(line);
    if (!m || m[5] || text.slice(start, lineEnd(text, start))) return null; // only on an empty item with the caret at its end
    // The nesting level goes first, then the marker itself (as in list editors).
    const rest = m[1].length >= INDENT.length ? m[1].slice(INDENT.length) + line.slice(m[1].length) : m[1];
    return { text: text.slice(0, from) + rest + text.slice(start), start: from + rest.length, end: from + rest.length };
  }

  /** key: {key, shiftKey, mod}. Returns the new state or null — then the textarea keeps its default behaviour. */
  function edit(text, start, end, key) {
    if (key.mod && !key.shiftKey) {
      switch (key.key.toLowerCase()) {
        case 'b': return wrap(text, start, end, '**');
        case 'i': return wrap(text, start, end, '_');
        case 'e': return wrap(text, start, end, '`');
        case 'k': return link(text, start, end);
        default: return null;
      }
    }
    if (key.mod) return null;
    switch (key.key) {
      case 'Enter': return key.shiftKey ? null : enter(text, start, end);
      case 'Tab': {
        if (key.shiftKey) return shift(text, start, end, -1);
        // Tab always stays in the field — a list item and a multi-line selection shift as a whole,
        // elsewhere an indent is inserted at the caret (move focus through the form with the mouse or Esc).
        const multi = text.slice(start, end).includes('\n');
        if (multi || ITEM.test(text.slice(lineStart(text, start), lineEnd(text, start)))) return shift(text, start, end, 1);
        return { text: text.slice(0, start) + INDENT + text.slice(end), start: start + INDENT.length, end: start + INDENT.length };
      }
      case 'Backspace': return backspace(text, start, end);
      default: return null;
    }
  }

  // Strings come from I18n when it is loaded (the dashboard); the pure editor keeps English fallbacks.
  const tr = (key, fallback) => root.I18n ? root.I18n.t(key) : fallback;
  const linkLabel = () => tr('md.link_label', 'link');
  /** Wraps the textarea in Write / Preview tabs; render(text) → DocumentFragment. Returns {write()}. */
  function mount(textarea, { render } = {}) {
    const doc = textarea.ownerDocument;
    const el = (tag, cls, txt) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (txt !== undefined) n.textContent = txt; return n; };
    textarea.addEventListener('keydown', e => {
      if (e.isComposing || e.altKey) return;
      const next = edit(textarea.value, textarea.selectionStart, textarea.selectionEnd, { key: e.key, shiftKey: e.shiftKey, mod: e.metaKey || e.ctrlKey });
      if (!next) return;
      e.preventDefault();
      textarea.value = next.text; textarea.setSelectionRange(next.start, next.end);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    if (!render) return { write() {} };
    const box = el('div', 'md-editor'), tabs = el('div', 'md-editor-tabs'), preview = el('div', 'md-editor-preview md');
    const writeTab = el('button', 'active', tr('md.write', 'Write')), previewTab = el('button', '', tr('md.preview', 'Preview'));
    writeTab.type = previewTab.type = 'button';
    const show = mode => {
      const p = mode === 'preview';
      writeTab.classList.toggle('active', !p); previewTab.classList.toggle('active', p);
      textarea.hidden = p; preview.hidden = !p;
      if (p) { preview.replaceChildren(textarea.value.trim() ? render(textarea.value) : el('p', 'hint', tr('md.empty', 'Nothing to preview.'))); }
      else textarea.focus();
    };
    writeTab.addEventListener('click', () => show('write')); previewTab.addEventListener('click', () => show('preview'));
    const hint = el('span', 'md-editor-hint', tr('md.hint', 'Markdown · ⌘B bold · ⌘I italic · ⌘E code · ⌘K link · Tab / ⇧Tab indent · Enter continues a list')); hint.title = hint.textContent; tabs.append(writeTab, previewTab, hint);
    textarea.replaceWith(box); preview.hidden = true; box.append(tabs, textarea, preview);
    return { write: () => show('write') };
  }

  root.MdEditor = { edit, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MdEditor;
})(typeof globalThis !== 'undefined' ? globalThis : this);
