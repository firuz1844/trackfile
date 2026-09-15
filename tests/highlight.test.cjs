const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../app/assets/highlight.js');
const classes = (lang, src) => H.tokenize(src, lang).filter(t => t.cls).map(t => t.cls + ':' + t.text);

test('tokens cover the whole input and unknown languages pass text through untouched', () => {
  const src = 'let x = "a" // c';
  assert.equal(H.tokenize(src, 'swift').map(t => t.text).join(''), src);
  assert.deepEqual(H.tokenize(src, 'brainfuck'), [{ cls: null, text: src }]);
  assert.equal(H.languageFor('app/host/Foo.swift'), 'swift'); assert.equal(H.languageFor('start.command'), 'bash'); assert.equal(H.languageFor('x.png'), null);
  assert.equal(H.resolve('sh'), 'bash'); assert.equal(H.resolve('TS'), 'javascript');
});
test('swift, bash, javascript and markup tokens', () => {
  assert.deepEqual(classes('swift', '@main struct A { let s = "x" /* c */ }'), ['attribute:@main', 'keyword:struct', 'type:A', 'keyword:let', 'string:"x"', 'comment:/* c */']);
  assert.deepEqual(classes('bash', 'echo "$HOME" # hi'), ['builtin:echo', 'string:"$HOME"', 'comment:# hi']);
  assert.deepEqual(classes('javascript', 'const r = /a\\/b/g;'), ['keyword:const', 'regex:/a\\/b/g']);
  assert.deepEqual(classes('json', '{"k": [1, null]}'), ['property:"k"', 'number:1', 'keyword:null']);
  assert.deepEqual(classes('html', '<a href="x">'), ['tag:<a', 'attribute:href', 'string:"x"', 'tag:>']);
  assert.deepEqual(classes('yaml', 'id: "M01" # c'), ['property:id', 'string:"M01"', 'comment:# c']);
});
