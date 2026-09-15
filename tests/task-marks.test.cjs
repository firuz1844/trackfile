/* Task mention highlighting — contract on a tiny fake DOM (nodeType/childNodes/parentNode/classList). */
const { test } = require('node:test');
const assert = require('node:assert/strict');

class Node {
  constructor(tag, text = null) { this.tagName = tag.toUpperCase(); this.nodeType = text === null ? 1 : 3; this._text = text; this.childNodes = []; this.parentNode = null; this.dataset = {}; this.classes = new Set(); this.listeners = {}; }
  get classList() { const s = this.classes; return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) }; }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); } get className() { return [...this.classes].join(' '); }
  append(...nodes) { for (const n of nodes) { n.parentNode = this; this.childNodes.push(n); } return this; }
  insertBefore(n, ref) { n.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); }
  removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  set textContent(v) { this._text = String(v); this.childNodes = []; if (this.nodeType === 1) { this.childNodes = [Object.assign(new Node('#text', String(v)), { parentNode: this })]; this._text = null; } }
  get textContent() { return this.nodeType === 3 ? this._text : this.childNodes.map(c => c.textContent).join(''); }
}
const doc = { createElement: t => new Node(t), createTextNode: t => new Node('#text', t) };
globalThis.document = doc;
const { mark, pattern, linkComments } = require('../app/assets/task-marks.js');
const el = (tag, cls, text) => { const n = new Node(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const txt = t => new Node('#text', t);
const marks = node => node.nodeType === 3 ? [] : (node.classes.has('task-mark') ? [node] : []).concat(...node.childNodes.map(marks));

test('pattern: leading zeros optional, no prefix match on longer numbers, TASK heading form', () => {
  const re = pattern('045');
  assert.ok(re.test('see #45')); re.lastIndex = 0;
  assert.ok(re.test('[#045](x)')); re.lastIndex = 0;
  assert.ok(re.test('### TASK 045')); re.lastIndex = 0;
  assert.equal(re.test('#0450 and #1045'), false);
  assert.equal(pattern('abc'), null);
});

test('markdown: link marker highlights its paragraph/list item, the link itself becomes the mark, other tasks untouched', () => {
  const body = el('div');
  const p = el('p'); p.append(txt('A paragraph about TLS. '), Object.assign(el('a', 'md-local', '#019'), { dataset: { href: '../TRACKFILE.md#task-019' } }), txt(' '), Object.assign(el('a', 'md-local', '#022'), { dataset: { href: '../TRACKFILE.md#task-022' } }));
  const li = el('li'); li.append(txt('Item. '), Object.assign(el('a', 'md-local', '#022'), { dataset: { href: '../../TRACKFILE.md#task-022' } }));
  const other = el('p', '', 'Nothing about the task.');
  body.append(p, el('ul').append(li), other);
  const hits = mark(body, '022', doc);
  assert.deepEqual(hits, [p, li]);
  assert.ok(p.classes.has('task-hit') && li.classes.has('task-hit') && !other.classes.has('task-hit'));
  const m = marks(body); assert.equal(m.length, 2); assert.ok(m.every(a => a.tagName === 'A' && a.textContent === '#022'));
  assert.equal(p.childNodes[1].classes.has('task-mark'), false, '#019 link stays plain');
  assert.equal(body.textContent, 'A paragraph about TLS. #019 #022Item. #022Nothing about the task.', 'text is preserved');
});

test('code: mentions in comments highlight their line and wrap only the number; a table cell counts as a block', () => {
  const body = el('div'); const pre = el('pre'); const code = el('code');
  const l1 = el('span', 'line'); l1.append(txt('// #135: why so'), el('span', 'tok-comment', ' // and again #135'));
  const l2 = el('span', 'line', 'let x = 1350 // #1350');
  const l3 = el('span', 'line', 'TASK 135 in text');
  code.append(l1, l2, l3); pre.append(code);
  const td = el('td', '', 'cell #135'); const tr = el('tr'); tr.append(td);
  body.append(pre, tr);
  const hits = mark(body, 135, doc);
  assert.deepEqual(hits, [l1, l3, td]);
  assert.equal(l2.classes.has('task-hit'), false);
  const m = marks(body); assert.deepEqual(m.map(s => s.textContent), ['#135', '#135', 'TASK 135', '#135']);
  assert.equal(l1.textContent, '// #135: why so // and again #135');
  assert.ok(m.every(s => s.tagName === 'SPAN'));
});

test('no matches: nothing is touched and an empty list is returned', () => {
  const body = el('div'); const p = el('p', '', 'no numbers'); body.append(p);
  assert.deepEqual(mark(body, '007', doc), []);
  assert.equal(p.childNodes.length, 1); assert.equal(p.classes.size, 0);
});

test('comment references become links with normalized task and comment numbers', () => {
  const body = el('div'), p = el('p', '', 'See #78.3 and #0078.12, but not #78.3x'); body.append(p);
  const opened = [], links = linkComments(body, (task, comment) => opened.push([task, comment]), doc);
  assert.deepEqual(links.map(a => [a.textContent, a.href]), [['#78.3', '#task/078/comment/3'], ['#0078.12', '#task/078/comment/12']]);
  links[0].listeners.click({ preventDefault() {} }); assert.deepEqual(opened, [['078', 3]]);
});
