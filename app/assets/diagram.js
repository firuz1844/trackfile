/* Pure layout for the Task Relationship Diagram: no DOM, easy to unit-test. Takes the already-filtered list
 * of tasks to draw and the edges between them, and returns node positions for a simple layered (Sugiyama-lite)
 * graph — level by longest path from a root (a node with no incoming parent/blocked_by edge), even spacing
 * within a level. relates_to edges are drawn but never affect leveling (they are undirected by nature). */
(function (root) {
  'use strict';
  // parent: from = parent, to = child. blocked_by: from = the blocker, to = the blocked task.
  // relates_to: from = the task the link was recorded on, to = the other task (order is cosmetic only).
  function edgesFromTasks(tasks) {
    const edges = [];
    for (const t of tasks) {
      if (t.parent) edges.push({ from: t.parent, to: t.id, type: 'parent' });
      for (const b of t.blocked_by ?? []) edges.push({ from: b, to: t.id, type: 'blocked_by' });
      for (const r of t.relates_to ?? []) edges.push({ from: t.id, to: r, type: 'relates_to' });
    }
    return edges;
  }
  const NODE_W = 168, NODE_H = 56, GAP_X = 32, GAP_Y = 64;
  function computeLayout(tasks, edges, options = {}) {
    const nodeW = Math.max(1, options.nodeWidth ?? NODE_W), nodeH = Math.max(1, options.nodeHeight ?? NODE_H);
    const limit = Math.max(1, options.limit ?? 60);
    const truncated = tasks.length > limit;
    const kept = new Set(tasks.slice(0, limit).map(t => t.id));
    const usedEdges = edges.filter(e => kept.has(e.from) && kept.has(e.to));
    const incoming = new Map([...kept].map(id => [id, []]));
    for (const e of usedEdges) if (e.type === 'parent' || e.type === 'blocked_by') incoming.get(e.to)?.push(e.from);
    const level = new Map(), visiting = new Set();
    function levelOf(id) {
      if (level.has(id)) return level.get(id);
      if (visiting.has(id)) return 0; // a cycle should never reach here (parse() rejects them); break defensively
      visiting.add(id);
      const sources = incoming.get(id) ?? [];
      const l = sources.length ? Math.max(...sources.map(levelOf)) + 1 : 0;
      visiting.delete(id); level.set(id, l);
      return l;
    }
    for (const id of kept) levelOf(id);
    const byLevel = new Map();
    for (const id of kept) { const l = level.get(id); if (!byLevel.has(l)) byLevel.set(l, []); byLevel.get(l).push(id); }
    const levels = [...byLevel.keys()].sort((a, b) => a - b);
    const nodes = [];
    for (const l of levels) byLevel.get(l).forEach((id, i) => nodes.push({ id, level: l, x: i * (nodeW + GAP_X), y: l * (nodeH + GAP_Y) }));
    const width = levels.length ? Math.max(...levels.map(l => byLevel.get(l).length * (nodeW + GAP_X) - GAP_X)) : 0;
    const height = levels.length ? levels.length * (nodeH + GAP_Y) - GAP_Y : 0;
    return { nodes, edges: usedEdges, truncated, shown: kept.size, total: tasks.length, width, height, nodeWidth: nodeW, nodeHeight: nodeH };
  }
  const api = { edgesFromTasks, computeLayout };
  root.Diagram = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
