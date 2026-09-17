/* Pure layout logic of the Task Relationship Diagram: leveling, edge shapes, truncation. No DOM involved. */
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/assets/diagram.js');

test('edgesFromTasks builds parent/blocked_by/relates_to triples with the documented direction', () => {
  const tasks = [
    { id: '001', parent: null },
    { id: '002', parent: '001', blocked_by: ['003'], relates_to: ['004'] },
    { id: '003', parent: null },
    { id: '004', parent: null },
  ];
  assert.deepEqual(D.edgesFromTasks(tasks), [
    { from: '001', to: '002', type: 'parent' },
    { from: '003', to: '002', type: 'blocked_by' },
    { from: '002', to: '004', type: 'relates_to' },
  ]);
});
test('levels: parent chain and a blocking edge both advance the level, relates_to never does', () => {
  const tasks = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }];
  const edges = [
    { from: 'A', to: 'B', type: 'parent' },
    { from: 'B', to: 'C', type: 'parent' },
    { from: 'A', to: 'D', type: 'blocked_by' },
    { from: 'A', to: 'E', type: 'relates_to' },
  ];
  const { nodes } = D.computeLayout(tasks, edges, { limit: 60 });
  const level = id => nodes.find(n => n.id === id).level;
  assert.equal(level('A'), 0); assert.equal(level('B'), 1); assert.equal(level('C'), 2); assert.equal(level('D'), 1);
  assert.equal(level('E'), 0, 'relates_to never advances the level');
});
test('a node picks the longest incoming path when it has several ancestors', () => {
  const tasks = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  const edges = [{ from: 'A', to: 'C', type: 'parent' }, { from: 'A', to: 'B', type: 'parent' }, { from: 'B', to: 'C', type: 'blocked_by' }];
  const { nodes } = D.computeLayout(tasks, edges, { limit: 60 });
  assert.equal(nodes.find(n => n.id === 'C').level, 2, 'via A->B->C, not the shorter A->C');
});
test('nodes at the same level get distinct x, levels get distinct y, size reflects the widest level', () => {
  const tasks = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  const edges = [{ from: 'A', to: 'B', type: 'parent' }, { from: 'A', to: 'C', type: 'parent' }];
  const { nodes, width, height, nodeWidth, nodeHeight } = D.computeLayout(tasks, edges, { limit: 60 });
  const [b, c] = [nodes.find(n => n.id === 'B'), nodes.find(n => n.id === 'C')];
  assert.notEqual(b.x, c.x); assert.equal(b.y, c.y);
  assert.ok(width >= 2 * nodeWidth); assert.ok(height >= nodeHeight);
});
test('truncation: only the first `limit` tasks are kept, edges touching a dropped task are dropped, total is reported', () => {
  const tasks = [{ id: '001' }, { id: '002' }, { id: '003' }];
  const edges = [{ from: '001', to: '002', type: 'parent' }, { from: '002', to: '003', type: 'parent' }];
  const { nodes, edges: kept, truncated, shown, total } = D.computeLayout(tasks, edges, { limit: 2 });
  assert.equal(truncated, true); assert.equal(shown, 2); assert.equal(total, 3);
  assert.deepEqual(nodes.map(n => n.id).sort(), ['001', '002']);
  assert.deepEqual(kept, [{ from: '001', to: '002', type: 'parent' }]);
});
test('no truncation when tasks fit within the limit', () => {
  const { truncated, shown, total } = D.computeLayout([{ id: 'A' }], [], { limit: 60 });
  assert.equal(truncated, false); assert.equal(shown, 1); assert.equal(total, 1);
});
test('an unexpected cycle in the input does not hang: it is broken defensively', () => {
  const tasks = [{ id: 'A' }, { id: 'B' }];
  const edges = [{ from: 'A', to: 'B', type: 'parent' }, { from: 'B', to: 'A', type: 'parent' }];
  const { nodes } = D.computeLayout(tasks, edges, { limit: 60 });
  assert.equal(nodes.length, 2);
});
