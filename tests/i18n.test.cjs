/* UI dictionary contract: both languages cover the same keys, plural forms pick by count, a missing key
 * is shown as the key, and every model/server error code has a translation. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const I18n = require('../app/assets/i18n.js');
const M = require('../app/assets/model.js');
const { MESSAGES } = require('../lib/serve.cjs');

test('en and ru have identical key sets and cover every error code', () => {
  const en = Object.keys(I18n.dictionaries.en), ru = Object.keys(I18n.dictionaries.ru);
  assert.deepEqual(en.filter(k => !ru.includes(k)), []); assert.deepEqual(ru.filter(k => !en.includes(k)), []);
  for (const code of [...Object.keys(M.MESSAGES), ...Object.keys(MESSAGES)]) assert.ok(I18n.has('error.' + code), 'error.' + code);
});
test('t formats params and plural forms per language; unknown keys stay visible', () => {
  I18n.setLanguage('en');
  assert.equal(I18n.t('tree.records', { n: 1 }), '1 record'); assert.equal(I18n.t('tree.records', { n: 5 }), '5 records');
  assert.equal(I18n.t('page.task', { id: '042' }), 'Task #042');
  assert.equal(I18n.t('nope.key'), 'nope.key');
  I18n.setLanguage('ru');
  assert.equal(I18n.t('tree.records', { n: 1 }), '1 запись'); assert.equal(I18n.t('tree.records', { n: 3 }), '3 записи'); assert.equal(I18n.t('tree.records', { n: 12 }), '12 записей');
  assert.equal(I18n.locale(), 'ru-RU');
  I18n.setLanguage('xx'); assert.equal(I18n.language, 'en', 'unknown language falls back to English');
});
test('apply fills data-i18n text and attributes on a fake DOM', () => {
  I18n.setLanguage('ru');
  const nodes = [{ dataset: { i18n: 'page.dashboard' }, textContent: '' }];
  const attr = { attrs: {}, getAttribute(k) { return k === 'data-i18n-title' ? 'theme.toggle' : null; }, setAttribute(k, v) { this.attrs[k] = v; } };
  I18n.apply({ querySelectorAll: sel => sel === '[data-i18n]' ? nodes : sel === '[data-i18n-title]' ? [attr] : [] });
  assert.equal(nodes[0].textContent, 'Обзор проекта'); assert.equal(attr.attrs.title, 'Сменить тему');
});
