/* Renderer contract on a tiny fake DOM: enough to assert structure and that nothing is ever parsed as HTML. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
class Node { constructor(tag) { this.tag = tag; this.children = []; this.text = null; this.dataset = {}; this.listeners = {}; this.attrs = {}; }
  get lastElementChild() { return [...this.children].reverse().find(c => c instanceof Node && c.text === null) ?? null; }
  append(...items) { for (const i of items) this.children.push(typeof i === 'string' ? Object.assign(new Node('#text'), { text: i }) : i); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return this.text !== null ? this.text : this.children.map(c => c.textContent).join(''); }
  set className(v) { this.attrs.class = v; } get className() { return this.attrs.class ?? ''; }
}
globalThis.document = { createElement: tag => new Node(tag), createTextNode: t => Object.assign(new Node('#text'), { text: t }), createDocumentFragment: () => new Node('#fragment') };
const { render } = require('../app/assets/markdown.js');
const tags = node => node.children.filter(c => c.tag !== '#text').map(c => c.tag);
const find = (node, tag) => node.tag === tag ? node : node.children.map(c => find(c, tag)).find(Boolean);

test('blocks: headings, paragraphs, fences, quotes, tables, nested lists, hr', () => {
  const md = '# T\n\npara one\ncontinues\n\n```swift\nlet a = 1\n```\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n  - nested\n- two\n\n1. first\n\n---\n';
  const out = render(md);
  assert.deepEqual(tags(out), ['h1', 'p', 'pre', 'blockquote', 'table', 'ul', 'ol', 'hr']);
  assert.equal(out.children[1].textContent, 'para one continues');
  assert.equal(find(out, 'code').textContent, 'let a = 1'); assert.equal(find(out, 'code').dataset.lang, 'swift');
  assert.equal(find(out, 'td').textContent, '1');
  const ul = out.children[5]; assert.equal(ul.children.length, 2); assert.equal(find(ul.children[0], 'ul').children[0].textContent, 'nested');
});
test('inline: code, emphasis across code, links; local links go through the handler, http links open new tab', () => {
  const opened = [];
  const out = render('_a `x_y` b_ and **bold** and `lit *not em*` [doc](../docs/00.md) [ext](https://e.com)', { linkHandler: h => opened.push(h) });
  const p = out.children[0];
  assert.equal(p.children[0].tag, 'em'); assert.equal(p.children[0].textContent, 'a x_y b'); assert.equal(find(p.children[0], 'code').textContent, 'x_y');
  assert.equal(find(p, 'strong').textContent, 'bold');
  const codes = p.children.filter(c => c.tag === 'code'); assert.equal(codes.at(-1).textContent, 'lit *not em*');
  const links = p.children.filter(c => c.tag === 'a');
  assert.equal(links[0].className, 'md-local'); links[0].listeners.click({ preventDefault() {} }); assert.deepEqual(opened, ['../docs/00.md']);
  assert.equal(links[1].attrs.href ?? links[1].href, 'https://e.com'); assert.equal(links[1].target, '_blank');
});
test('never interprets HTML: tags stay literal text', () => {
  const out = render('<script>alert(1)</script> and <b>x</b>');
  assert.deepEqual(tags(out), ['p']); assert.equal(out.children[0].textContent, '<script>alert(1)</script> and <b>x</b>');
});
// Task descriptions/comments render with breaks — a single newline stays a line break, blank line starts a paragraph.
test('breaks: newline inside a paragraph or list item becomes <br>, blank line still splits paragraphs', () => {
  const out = render('line one\nline two\n\n- item\n  continued', { breaks: true });
  assert.deepEqual(tags(out), ['p', 'ul']);
  assert.deepEqual(tags(out.children[0]), ['br']); assert.equal(out.children[0].textContent, 'line oneline two');
  assert.deepEqual(tags(out.children[1].children[0]), ['br']);
  assert.equal(render('line one\nline two').children[0].textContent, 'line one line two');
});
// With breaks, emphasis may span a line break — the paragraph is parsed as a whole, <br> lands inside <strong>.
test('breaks: bold across a line break stays bold', () => {
  const p = render('**bold one\nbold two** tail', { breaks: true }).children[0];
  assert.equal(p.children[0].tag, 'strong'); assert.deepEqual(tags(p.children[0]), ['br']); assert.equal(p.children[0].textContent, 'bold onebold two');
  assert.equal(render('**a\nb**').children[0].children[0].textContent, 'a b');
});
// `![alt](src)` is an image only when the caller resolves the source (task attachments); otherwise a link.
test('images: rendered through imageSrc, otherwise degrade to a link; label may be empty', () => {
  const out = render('see ![shot](.trackfile/tasks/001/shot.png) and ![ext](https://e.com/x.png) and ![](.trackfile/tasks/001/b.png)', { imageSrc: h => h.startsWith('.trackfile/') ? '/' + h : null });
  const p = out.children[0];
  const wraps = p.children.filter(c => c.className === 'md-image'), imgs = wraps.map(w => w.children[0]), links = p.children.filter(c => c.tag === 'a' && c.className !== 'md-image');
  assert.equal(imgs.length, 2); assert.equal(imgs[0].tag, 'img'); assert.equal(imgs[0].src, '/.trackfile/tasks/001/shot.png'); assert.equal(imgs[0].alt, 'shot'); assert.equal(imgs[1].alt, '');
  assert.equal(wraps[0].href, '/.trackfile/tasks/001/shot.png', 'image links to its full-size file'); assert.equal(wraps[0].target, '_blank');
  assert.equal(links.length, 1); assert.equal(links[0].textContent, 'ext'); assert.equal(links[0].href, 'https://e.com/x.png');
  // Display size travels in the fragment and never reaches the resolver.
  const seen = [];
  const sized = render('![s](.trackfile/tasks/001/shot.png#w=320) ![t](.trackfile/tasks/001/shot.png#w=320x200)', { imageSrc: h => { seen.push(h); return '/' + h; } }).children[0];
  const sizedImgs = sized.children.filter(c => c.className === 'md-image').map(w => w.children[0]);
  assert.deepEqual(seen, ['.trackfile/tasks/001/shot.png', '.trackfile/tasks/001/shot.png']);
  assert.equal(sizedImgs[0].width, 320); assert.equal(sizedImgs[0].height, undefined); assert.equal(sizedImgs[0].className, 'md-sized');
  assert.equal(sizedImgs[1].width, 320); assert.equal(sizedImgs[1].height, 200);
  const plain = render('![shot](.trackfile/tasks/001/shot.png)').children[0];
  assert.deepEqual(tags(plain), ['a']); assert.equal(plain.children[0].textContent, 'shot'); assert.equal(plain.children[0].className, 'md-local');
  assert.equal(render('[](x)').children[0].textContent, '[](x)', 'empty link label stays literal, as before');
});
// Intraword underscores are literal, so two image lines with IMG_NNNN names both render as images.
test('underscore inside a word is not emphasis; two images with underscored names both render', () => {
  const md = 'IMG_4631.PNG - first\n\n![IMG_4631.PNG](.trackfile/tasks/002/IMG_4631.PNG#w=320)\n\nIMG_4632.PNG - second\n![IMG_4632.PNG](.trackfile/tasks/002/IMG_4632.PNG#w=320)';
  const out = render(md, { breaks: true, imageSrc: h => '/' + h });
  const imgs = [];
  const walk = n => { if (n.tag === 'img') imgs.push(n); n.children.forEach(walk); };
  walk(out);
  assert.deepEqual(imgs.map(i => i.alt), ['IMG_4631.PNG', 'IMG_4632.PNG']);
  assert.equal(find(out, 'em'), undefined, 'no italic was produced');
  assert.equal(out.children[0].textContent, 'IMG_4631.PNG - first');
  const p = render('snake_case_name and _real_ and __bold__ and a*b*c and x__y__z').children[0];
  assert.equal(p.textContent, 'snake_case_name and real and bold and abc and x__y__z');
  assert.equal(p.children.filter(c => c.tag === 'em').length, 2); assert.equal(find(p, 'strong').textContent, 'bold');
});
