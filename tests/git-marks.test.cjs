/* Git highlighting on a fake DOM — through the real MarkdownRenderer and Highlighter, so line ranges
 * and insertion of deleted lines are checked on the real structure. */
const { test } = require('node:test');
const assert = require('node:assert/strict');

class Node {
  constructor(tag, text = null) { this.tagName = tag.toUpperCase(); this.nodeType = text === null ? 1 : 3; this._text = text; this.childNodes = []; this.parentNode = null; this.dataset = {}; this.classes = new Set(); }
  get classList() { const s = this.classes; return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c), toggle: (c, on) => on ? s.add(c) : s.delete(c) }; }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); } get className() { return [...this.classes].join(' '); }
  get lastElementChild() { return [...this.childNodes].reverse().find(c => c.nodeType === 1) ?? null; }
  append(...nodes) { for (let n of nodes) { if (typeof n === 'string') n = new Node('#text', n); if (n.tagName === '#FRAGMENT') { this.append(...n.childNodes); continue; } n.parentNode = this; this.childNodes.push(n); } return this; }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  insertBefore(n, ref) { n.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); }
  addEventListener() {}
  set textContent(v) { this.childNodes = []; if (this.nodeType === 1) this.childNodes = [Object.assign(new Node('#text', String(v)), { parentNode: this })]; else this._text = String(v); }
  get textContent() { return this.nodeType === 3 ? this._text : this.childNodes.map(c => c.textContent).join(''); }
}
globalThis.document = { createElement: t => new Node(t), createTextNode: t => new Node('#text', t), createDocumentFragment: () => new Node('#fragment') };
const { render } = require('../app/assets/markdown.js');
const Highlighter = require('../app/assets/highlight.js');
const { parse } = require('../app/assets/diff.js');
const { mark, changes } = require('../app/assets/git-marks.js');
const patch = (hunks, path = 'doc.md') => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` + hunks.join('\n') + '\n';
const flat = node => node.nodeType === 3 ? [] : [node, ...node.childNodes.flatMap(flat)];
const withClass = (node, c) => flat(node).filter(n => n.classes?.has(c));

test('changes(): added lines in new numbering, deletions addressed before a line', () => {
  const f = parse(patch(['@@ -2,0 +3,2 @@', '+a', '+b', '@@ -7,2 +9,0 @@', '-x', '-y', '@@ -12 +13 @@', '-old', '+new']))[0];
  const c = changes(f);
  assert.deepEqual([...c.added], [3, 4, 13]);
  assert.deepEqual(c.deletions, [{ before: 10, lines: ['x', 'y'] }, { before: 13, lines: ['old'] }]);
});
test('markdown: blocks carry line ranges; added lines mark the narrowest block, deletions land before the next block', () => {
  const md = '# T\n\npara one\ncontinues\n\n- item\n  - nested\n\n```js\nlet a = 1;\nlet b = 2;\n```\n\n| a |\n|---|\n| 1 |\n';
  const body = new Node('article');
  body.append(render(md, { highlight: (c, t, l) => Highlighter.renderCode(c, t, l, { lineNumbers: false }) }));
  const ranges = body.childNodes.filter(n => n.nodeType === 1).map(n => [n.tagName, n.dataset.lineStart, n.dataset.lineEnd]);
  assert.deepEqual(ranges, [['H1', '1', '1'], ['P', '3', '4'], ['UL', undefined, undefined], ['PRE', '9', '12'], ['TABLE', '14', '16']]);
  // line 4 → paragraph, line 7 → nested li, line 11 → second code line, line 16 → table row; deletion before line 9 → before pre.
  const f = parse(patch(['@@ -3,0 +4 @@', '+continues', '@@ -6,0 +7 @@', '+  - nested', '@@ -10,0 +11 @@', '+let b = 2;', '@@ -9 +8,0 @@', '-gone', '@@ -15,0 +16 @@', '+| 1 |']))[0];
  const hits = mark(body, f);
  assert.deepEqual(hits.map(h => h.tagName + (h.classes.has('git-del') ? '(del)' : '') + ':' + h.textContent.trim()), ['P:para one continues', 'LI:nested', 'PRE(del):gone', 'SPAN:let b = 2;', 'TR:1']);
  assert.equal(withClass(body, 'git-add').length, 4);
  const pre = body.childNodes.find(n => n.tagName === 'PRE' && !n.classes.has('git-del'));
  assert.ok(pre.classes.has('git-touched'));
  assert.equal(withClass(pre, 'git-add')[0].textContent, 'let b = 2;');
});
test('plain code: lines by index, deleted lines inserted in place, trailing deletion appended', () => {
  const body = new Node('article'), pre = new Node('pre'), code = new Node('code');
  Highlighter.renderCode(code, 'l1\nl2\nl3\n', 'javascript'); pre.append(code); body.append(pre);
  const f = parse(patch(['@@ -2 +2 @@', '-old2', '+l2', '@@ -4 +3,0 @@', '-tail'], 'a.js'))[0];
  const hits = mark(body, f);
  const lines = code.childNodes.map(n => (n.classes.has('git-del') ? '-' : n.classes.has('git-add') ? '+' : ' ') + n.textContent);
  assert.deepEqual(lines, [' l1', '-old2', '+l2', ' l3', '-tail']);
  assert.equal(hits.length, 3);
  assert.deepEqual(mark(new Node('article'), null), []);
});
