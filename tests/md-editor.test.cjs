// Contract of the Markdown textarea helper — the pure edit() function, no DOM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { edit } = require('../app/assets/md-editor.js');
const K = (key, extra = {}) => ({ key, shiftKey: false, mod: false, ...extra });
const mod = key => K(key, { mod: true });
const caret = s => { const i = s.indexOf('|'); return [s.replace('|', ''), i, i]; }; // "ab|c" → text, start, end
const sel = s => { const a = s.indexOf('['), t = s.replace('[', ''), b = t.indexOf(']'); return [t.replace(']', ''), a, b]; };
const out = (r) => r.text.slice(0, r.start) + (r.start === r.end ? '|' : '[') + (r.start === r.end ? '' : r.text.slice(r.start, r.end) + ']') + r.text.slice(r.end);

test('shortcuts wrap and unwrap a selection; without selection place the caret inside the pair', () => {
  assert.equal(out(edit(...sel('a [bc] d'), mod('b'))), 'a **[bc]** d');
  assert.equal(out(edit(...sel('a **[bc]** d'), mod('b'))), 'a [bc] d');
  assert.equal(out(edit(...sel('a [**bc**] d'), mod('B'))), 'a [bc] d');
  assert.equal(out(edit(...caret('x|'), mod('i'))), 'x_|_');
  assert.equal(out(edit(...sel('[code]'), mod('e'))), '`[code]`');
  assert.equal(edit(...caret('x|'), K('b', { mod: true, shiftKey: true })), null);
});
test('link: selected text becomes the label with the url slot selected; a selected url gets a placeholder label', () => {
  assert.equal(out(edit(...sel('see [docs] now'), mod('k'))), 'see [docs]([url]) now');
  assert.equal(out(edit(...sel('[https://e.com/x]'), mod('k'))), '[[link]](https://e.com/x)');
});
test('Enter continues bullet, numbered and checkbox items with the same indent; empty item ends the list', () => {
  assert.equal(out(edit(...caret('- one|'), K('Enter'))), '- one\n- |');
  assert.equal(out(edit(...caret('  2. two|\nrest'), K('Enter'))), '  2. two\n  3. |\nrest');
  assert.equal(out(edit(...caret('- [x] done|'), K('Enter'))), '- [x] done\n- [ ] |');
  assert.equal(out(edit(...caret('- one\n- |'), K('Enter'))), '- one\n|');
  assert.equal(edit(...caret('plain|'), K('Enter')), null);
  assert.equal(edit(...caret('- one|'), K('Enter', { shiftKey: true })), null);
});
test('Enter after an opening fence closes it and leaves the caret inside; inside a fence lists are not continued', () => {
  assert.equal(out(edit(...caret('```swift|'), K('Enter'))), '```swift\n|\n```');
  assert.equal(edit(...caret('```\n- item|\n```'), K('Enter')), null);
  assert.equal(edit(...caret('```\n|code\n```'), K('Tab')).text, '```\n  code\n```');
});
test('Tab indents a list item or a multi-line selection, Shift+Tab outdents at most one step; elsewhere Tab inserts an indent', () => {
  assert.equal(out(edit(...caret('- a|'), K('Tab'))), '  - a|');
  assert.equal(out(edit(...caret('    - a|'), K('Tab', { shiftKey: true }))), '  - a|');
  assert.equal(out(edit(...sel('[- a\n- b]'), K('Tab'))), '[  - a\n  - b]');
  assert.equal(out(edit(...sel('  x\n [y]'), K('Tab', { shiftKey: true }))), '  x\n[y]');
  assert.equal(out(edit(...caret('pla|in'), K('Tab'))), 'pla  |in');
});
test('Backspace on an empty item first drops a nesting level, then the marker itself', () => {
  assert.equal(out(edit(...caret('  - |'), K('Backspace'))), '- |');
  assert.equal(out(edit(...caret('- |'), K('Backspace'))), '|');
  assert.equal(out(edit(...caret('1. |\nnext'), K('Backspace'))), '|\nnext');
  assert.equal(edit(...caret('- text|'), K('Backspace')), null);
  assert.equal(edit(...sel('- [ ]'), K('Backspace')), null);
});
