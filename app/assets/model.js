/* Registry model: parser, validation, progress and every mutation of the Markdown registry.
 * Pure functions over a map of files keyed by *logical* names — `registry`, `archive`, `comments/NNN` —
 * so the same code runs in the browser (no modules, no build) and under Node (CLI, tests). The server
 * and the CLI map logical names to the repository layout (TRACKFILE.md, .trackfile/…). */
(function (root) {
  'use strict';
  const statuses = ['to-do', 'in_progress', 'review', 'done', 'cancelled', 'removed'];
  const priorities = ['low', 'normal', 'high'];
  const priorityOf = m => m.priority ?? 'normal';
  const inactive = new Set(['cancelled', 'removed']);
  // Closed statuses are archive candidates; comments live in a per-task file, never inside the registry.
  const closed = new Set(['done', 'cancelled', 'removed']);
  const REGISTRY = 'registry', ARCHIVE = 'archive', ARCHIVE_AFTER_DAYS = 7;
  const commentsFile = id => `comments/${id}`;
  const COMMENTS_FILE = /^comments\/(\d{3,})$/;
  // Human-readable file labels for messages; the UI translates by `code`, the CLI prints `message`.
  const label = name => name === REGISTRY ? 'TRACKFILE.md' : name === ARCHIVE ? 'archive.md' : name.replace(COMMENTS_FILE, 'tasks/$1/comments.md');
  // Every failure carries a stable `code` plus params so the dashboard can localize it; `message` is English.
  const MESSAGES = {
    yaml_field: 'Invalid or repeated YAML field: {line}',
    yaml_value: 'Invalid YAML value: {line}',
    yaml_quotes: 'YAML strings must be double-quoted: {line}',
    comment_id: 'Invalid comment number: {id}',
    comment_author: 'Comment {id}: author is required.',
    comment_date: 'Comment {id}: invalid date.',
    comment_empty: 'Comment {id}: text cannot be empty.',
    comment_order: 'Comment numbers must increase and never repeat.',
    comments_too_big: '{file} is too big (5 MB limit).',
    comments_prose: '{file}: only #### COMMENT N blocks are allowed, no text outside them.',
    registry_too_big: '{file} is too big (5 MB limit).',
    front_matter: '{file} must start with a YAML front matter.',
    schema: 'Unsupported registry schema ({file}).',
    archive_flag: '{file}: the front matter needs archive: true.',
    next_task_missing: 'Unsupported registry schema: next_task is required.',
    headings: '### headings are reserved for TASK <ID> and MILESTONE <ID>.',
    yaml_block: '{id} needs a yaml block right after its heading.',
    id_title: 'Invalid id/title for {id}.',
    comments_in_registry: '{id}: comments are stored in {file}, not in the registry.',
    milestone_in_archive: '{file}: milestones live only in the registry.',
    no_registry: 'No registry file.',
    duplicate_id: 'Invalid or duplicate ID: {id}',
    unknown_file: 'Unknown registry file: {file}',
    comments_orphan: '{file}: task {id} is neither in the registry nor in the archive.',
    priority: '{id}: priority must be one of {values}.',
    next_task: 'next_task must exceed every existing ID.',
    status: 'Unknown status for {id}.',
    kind: 'Invalid kind for {id}.',
    field_required: '{id}: field {field} is required.',
    iso_date: '{id}: invalid ISO date in {field}.',
    updated_before_created: '{id}: updated_at is earlier than created_at.',
    string_or_null: '{id}: {field} must be a string or null.',
    completed_at: '{id}: invalid completion date.',
    archived_at_required: '{id}: archived_at is required in the archive.',
    archived_at_forbidden: '{id}: archived_at is allowed only in the archive.',
    unarchived_at: '{id}: unarchived_at must be an ISO date and only in the registry.',
    assignee_required: '{id}: in_progress needs an assignee.',
    parent_missing: '{id}: parent {parent} does not exist.',
    milestone_missing: '{id}: milestone does not exist.',
    sources: '{id}: sources must be an array of strings.',
    result: '{id}: result must be a string.',
    cycle: 'Parent cycle: {id}',
    reserved_headings: 'Use #### headings or plain text in descriptions; #–### headings are reserved.',
    parent_unavailable: 'Parent is missing, cancelled or removed.',
    parent_archived: 'Parent is archived: unarchive it first.',
    self_parent: 'A task cannot be its own parent.',
    parent_cycle: 'Task #{parent} is a subtask of #{id}: parent cycle.',
    task_locked: 'Only a free to-do task can be edited.',
    title_length: 'Title must be 1 to 240 characters.',
    milestone_not_found: 'Milestone not found: {id}',
    task_not_found: 'Task not found: {id}',
    no_milestone_section: 'The registry has no milestones section.',
    unknown_priority: 'Unknown priority: {priority}',
    unknown_status: 'Unknown status: {status}',
    not_in_file: '{id}: record is not in {file}.',
    already_archived: '#{id} is already archived.',
    archive_open: '#{id}: only done/cancelled/removed tasks can be archived.',
    archive_subtasks: '#{id} has open subtasks.',
    not_archived: '#{id} is not archived.',
    comment_blank: 'Comment cannot be empty.',
    comment_not_found: 'Comment not found: {id}.{comment}',
    comment_done_type: 'Comment state must be true or false.'
  };
  const format = (template, params) => template.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? `{${key}}`);
  const fail = (code, params = {}) => { const e = new Error(format(MESSAGES[code], params)); e.code = code; e.params = params; throw e; };
  function yaml(text) {
    const result = Object.create(null);
    for (const line of text.split('\n')) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const m = /^([a-z][a-z_]*):\s*(.*?)\s*$/.exec(line);
      if (!m || Object.hasOwn(result, m[1])) fail('yaml_field', { line });
      const value = m[2];
      if (/^(?:null|true|false|-?\d+)$/.test(value) || value.startsWith('"') || value.startsWith('[')) {
        try { result[m[1]] = JSON.parse(value); } catch { fail('yaml_value', { line }); }
      } else if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) result[m[1]] = value;
      else fail('yaml_quotes', { line });
    }
    return result;
  }
  // Arrays are written with a space after each comma, matching hand-written records so agent diffs stay minimal.
  const scalar = value => Array.isArray(value) ? '[' + value.map(v => JSON.stringify(v)).join(', ') + ']' : JSON.stringify(value);
  const dump = data => Object.entries(data).map(([key, value]) => `${key}: ${scalar(value)}`).join('\n');
  // Comments are numbered blocks; the number is permanent so `#NNN.K` references never move.
  function splitComments(content) {
    const starts = [...content.matchAll(/^#### COMMENT (\d+)(?: \[([ xXхХ])\])?[ \t]*\n```yaml\n([\s\S]*?)\n```\n?/gm)];
    if (!starts.length) return { body: content.trim(), comments: [] };
    const comments = starts.map((match, index) => {
      const data = yaml(match[3]), id = Number(match[1]), done = Boolean(match[2] && match[2] !== ' ');
      const text = content.slice(match.index + match[0].length, starts[index + 1]?.index ?? content.length).trim();
      if (data.id !== id || !Number.isSafeInteger(id) || id < 1) fail('comment_id', { id: match[1] });
      if (typeof data.author !== 'string' || !data.author.trim()) fail('comment_author', { id });
      if (typeof data.updated_at !== 'string' || !Number.isFinite(Date.parse(data.updated_at))) fail('comment_date', { id });
      if (!text) fail('comment_empty', { id });
      return { id, author: data.author, updated_at: data.updated_at, done, text };
    });
    for (let i = 1; i < comments.length; i++) if (comments[i].id <= comments[i - 1].id) fail('comment_order');
    return { body: content.slice(0, starts[0].index).trim(), comments };
  }
  const commentRecord = comment => `#### COMMENT ${comment.id} [${comment.done ? 'x' : ' '}]\n\`\`\`yaml\nid: ${comment.id}\nauthor: ${JSON.stringify(comment.author)}\nupdated_at: ${JSON.stringify(comment.updated_at)}\n\`\`\`\n\n${comment.text.trim()}`;
  // The comments file holds only `#### COMMENT` blocks; an empty list means the file is absent (null).
  const commentsText = comments => comments.length ? comments.map(commentRecord).join('\n\n') + '\n' : null;
  function parseComments(input, taskId) {
    const file = label(commentsFile(taskId));
    if (typeof input !== 'string' || input.length > 5_000_000) fail('comments_too_big', { file });
    const { body, comments } = splitComments(input.replace(/\r\n/g, '\n'));
    if (body) fail('comments_prose', { file });
    return comments;
  }
  // One registry file: the active registry (milestones, next_task, open tasks) or the archive (closed tasks
  // with archived_at). Same structure, different front matter and required fields.
  function parseRegistry(input, name) {
    const archive = name === ARCHIVE, file = label(name);
    if (typeof input !== 'string' || input.length > 5_000_000) fail('registry_too_big', { file });
    const text = input.replace(/\r\n/g, '\n');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!front) fail('front_matter', { file });
    const meta = yaml(front[1]);
    if (meta.schema !== 1 || typeof meta.project !== 'string') fail('schema', { file });
    if (archive ? meta.archive !== true : !Number.isSafeInteger(meta.next_task)) archive ? fail('archive_flag', { file }) : fail('next_task_missing');
    const headings = [...text.matchAll(/^### (TASK|MILESTONE) ([A-Za-z0-9-]+)[ \t]*$/gm)];
    if ([...text.matchAll(/^### .+$/gm)].length !== headings.length) fail('headings');
    const tasks = [], milestones = [];
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i], start = h.index;
      let end = headings[i + 1]?.index ?? text.length;
      const section = /^## /m.exec(text.slice(start + h[0].length, end));
      if (section) end = start + h[0].length + section.index;
      const raw = text.slice(start, end);
      const block = /^### (?:TASK|MILESTONE) [A-Za-z0-9-]+[ \t]*\n```yaml\n([\s\S]*?)\n```\n?/.exec(raw);
      if (!block) fail('yaml_block', { id: h[2] });
      const data = yaml(block[1]);
      if (data.id !== h[2] || typeof data.title !== 'string' || !data.title.trim()) fail('id_title', { id: h[2] });
      const body = raw.slice(block[0].length).trim();
      if (h[1] === 'TASK' && /^#### COMMENT \d+/m.test(body)) fail('comments_in_registry', { id: h[2], file: label(commentsFile(h[2])) });
      if (h[1] === 'MILESTONE' && archive) fail('milestone_in_archive', { file });
      const entry = { ...data, body, comments: [], start, end, raw, data, file: name, archived: archive };
      (h[1] === 'TASK' ? tasks : milestones).push(entry);
    }
    return { text, meta, frontLength: front[0].length, tasks, milestones };
  }
  // Input: the registry text alone, or a map {registry, archive?, 'comments/NNN'…}; tasks of both files form
  // one tree and each comments file is attached to its task.
  function parse(input) {
    const files = typeof input === 'string' ? { [REGISTRY]: input } : { ...input };
    if (files[REGISTRY] == null) fail('no_registry');
    const project = parseRegistry(files[REGISTRY], REGISTRY);
    const archive = files[ARCHIVE] != null ? parseRegistry(files[ARCHIVE], ARCHIVE) : null;
    const { meta, milestones } = project;
    const tasks = [...project.tasks, ...(archive?.tasks ?? [])];
    files[REGISTRY] = project.text; if (archive) files[ARCHIVE] = archive.text;
    const unique = (items, pattern) => {
      const map = new Map();
      for (const t of items) {
        if (!pattern.test(t.id) || map.has(t.id)) fail('duplicate_id', { id: t.id });
        map.set(t.id, t);
      }
      return map;
    };
    const byId = unique(tasks, /^\d{3,}$/), byMilestone = unique(milestones, /^M\d{2,}$/);
    for (const [name, content] of Object.entries(files)) {
      const m = COMMENTS_FILE.exec(name);
      if (!m) { if (name !== REGISTRY && name !== ARCHIVE) fail('unknown_file', { file: name }); continue; }
      if (content == null) { delete files[name]; continue; }
      const t = byId.get(m[1]);
      if (!t) fail('comments_orphan', { file: label(name), id: m[1] });
      t.comments = parseComments(content, m[1]);
    }
    // Milestone priority is optional: absent means normal, anything else is a format error.
    for (const m of milestones) if (m.priority !== undefined && !priorities.includes(m.priority)) fail('priority', { id: m.id, values: priorities.join('/') });
    if (meta.next_task <= Math.max(0, ...tasks.map(t => Number(t.id)))) fail('next_task');
    for (const t of tasks) {
      if (!statuses.includes(t.status)) fail('status', { id: t.id });
      if (!['feature', 'task'].includes(t.kind)) fail('kind', { id: t.id });
      for (const field of ['author', 'created_at', 'updated_at']) if (typeof t[field] !== 'string' || !t[field]) fail('field_required', { id: t.id, field });
      for (const field of ['created_at', 'updated_at']) if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(t[field]) || !Number.isFinite(Date.parse(t[field]))) fail('iso_date', { id: t.id, field });
      if (Date.parse(t.updated_at) < Date.parse(t.created_at)) fail('updated_before_created', { id: t.id });
      for (const field of ['assignee', 'completed_at', 'branch', 'commit', 'parent', 'milestone']) {
        if (t[field] !== null && typeof t[field] !== 'string') fail('string_or_null', { id: t.id, field });
      }
      if (t.completed_at !== null && !Number.isFinite(Date.parse(t.completed_at))) fail('completed_at', { id: t.id });
      // archived_at is required in the archive and forbidden in the registry; unarchived_at marks a manual return.
      if (t.archived ? typeof t.archived_at !== 'string' || !Number.isFinite(Date.parse(t.archived_at)) : t.archived_at !== undefined) fail(t.archived ? 'archived_at_required' : 'archived_at_forbidden', { id: t.id });
      if (t.unarchived_at !== undefined && (t.archived || typeof t.unarchived_at !== 'string' || !Number.isFinite(Date.parse(t.unarchived_at)))) fail('unarchived_at', { id: t.id });
      if (t.status === 'in_progress' && !t.assignee) fail('assignee_required', { id: t.id });
      if (t.parent !== null && !byId.has(t.parent)) fail('parent_missing', { id: t.id, parent: t.parent });
      if (t.milestone !== null && !byMilestone.has(t.milestone)) fail('milestone_missing', { id: t.id });
      if (t.sources !== undefined && (!Array.isArray(t.sources) || !t.sources.every(s => typeof s === 'string'))) fail('sources', { id: t.id });
      if (t.result !== undefined && typeof t.result !== 'string') fail('result', { id: t.id });
      const seen = new Set([t.id]);
      let p = t.parent;
      while (p) {
        if (seen.has(p)) fail('cycle', { id: t.id });
        seen.add(p); p = byId.get(p)?.parent;
      }
    }
    return { files, text: project.text, meta, frontLength: project.frontLength, archive: archive ? { text: archive.text, meta: archive.meta, frontLength: archive.frontLength } : null, tasks, milestones, byId, byMilestone };
  }
  // Mutations return the set of changed files {name: text | null (delete)}; apply() yields the document after them.
  function apply(doc, changes) {
    const files = { ...doc.files };
    for (const [name, text] of Object.entries(changes)) { if (text === null) delete files[name]; else files[name] = text; }
    return parse(files);
  }
  function milestoneOf(doc, task) {
    let t = task;
    while (t) { if (t.milestone) return t.milestone; t = doc.byId.get(t.parent); }
    return null;
  }
  function excluded(doc, task) {
    let t = task;
    while (t) { if (inactive.has(t.status)) return true; t = doc.byId.get(t.parent); }
    return false;
  }
  function progress(doc, milestone = null, ancestor = null) {
    const parents = new Set(doc.tasks.map(t => t.parent));
    const leaves = doc.tasks.filter(t => {
      if (parents.has(t.id) || excluded(doc, t)) return false;
      if (milestone && milestoneOf(doc, t) !== milestone) return false;
      if (ancestor) {
        let node = t;
        while (node && node.id !== ancestor) node = doc.byId.get(node.parent);
        if (!node) return false;
      }
      return true;
    });
    const done = leaves.filter(t => t.status === 'done').length;
    return { total: leaves.length, done, percent: leaves.length ? Math.round(done / leaves.length * 100) : 0,
      active: leaves.filter(t => t.status === 'in_progress').length, review: leaves.filter(t => t.status === 'review').length };
  }
  // Fresh settings show recently changed tasks first; an empty status list means "all statuses";
  // milestone pages store the collapsed nodes because everything is expanded by default there.
  const defaults = () => ({ schema: 1, view: 'dashboard', expanded: [], selected: null, selectedMilestone: null, search: '', statuses: [], milestone: 'all', sort: 'updated', milestoneStatuses: [], milestoneSort: 'updated', milestoneCollapsed: [], hideArchived: false, hideDone: false, showArchive: false, pinnedTasks: [], pinnedMilestones: [], theme: 'light', sidebarCollapsed: false, lang: null });
  const complete = p => p.total > 0 && p.done === p.total;
  function cleanConfig(value, doc) {
    const c = defaults();
    if (!value || value.schema !== 1) return c;
    c.expanded = [...new Set((Array.isArray(value.expanded) ? value.expanded : []).filter(id => doc.byId.has(id)))];
    c.selected = doc.byId.has(value.selected) ? value.selected : null;
    c.view = ['dashboard', 'tree', 'task', 'milestone'].includes(value.view) ? value.view : c.view;
    if (c.view === 'task' && !c.selected) c.view = 'tree';
    // The milestone page is its own view; without an existing milestone it falls back to the dashboard.
    c.selectedMilestone = doc.byMilestone.has(value.selectedMilestone) ? value.selectedMilestone : null;
    if (c.view === 'milestone' && !c.selectedMilestone) c.view = 'dashboard';
    const legacyStatuses = statuses.includes(value.status) ? [value.status] : [];
    c.statuses = [...new Set((Array.isArray(value.statuses) ? value.statuses : legacyStatuses).filter(status => statuses.includes(status)))];
    c.milestone = value.milestone === 'none' || doc.byMilestone.has(value.milestone) ? value.milestone : 'all';
    c.search = typeof value.search === 'string' ? value.search.slice(0, 500) : '';
    c.sort = ['id', 'updated'].includes(value.sort) ? value.sort : c.sort;
    c.milestoneStatuses = [...new Set((Array.isArray(value.milestoneStatuses) ? value.milestoneStatuses : []).filter(status => statuses.includes(status)))];
    c.milestoneSort = ['id', 'updated'].includes(value.milestoneSort) ? value.milestoneSort : c.milestoneSort;
    c.milestoneCollapsed = [...new Set((Array.isArray(value.milestoneCollapsed) ? value.milestoneCollapsed : []).filter(id => doc.byId.has(id)))];
    c.hideArchived = value.hideArchived === true;
    c.hideDone = value.hideDone === true;
    c.showArchive = value.showArchive === true;
    c.pinnedTasks = [...new Set((Array.isArray(value.pinnedTasks) ? value.pinnedTasks : []).filter(id => doc.byId.has(id)))];
    c.pinnedMilestones = [...new Set((Array.isArray(value.pinnedMilestones) ? value.pinnedMilestones : []).filter(id => doc.byMilestone.has(id)))];
    c.theme = value.theme === 'dark' ? 'dark' : 'light';
    c.sidebarCollapsed = value.sidebarCollapsed === true;
    // UI language override; null means "follow the browser".
    c.lang = ['en', 'ru'].includes(value.lang) ? value.lang : null;
    return c;
  }
  function record(type, data, body) {
    // Reserved headings/fences could forge another record when a user edits prose.
    if (/^#{1,3} /m.test(body) || /^```yaml\s*$/m.test(body)) fail('reserved_headings');
    const prose = body.trim();
    return `### ${type} ${data.id}\n\`\`\`yaml\n${dump(data)}\n\`\`\`\n\n` + (prose ? prose + '\n\n' : '');
  }
  // The parent is checked before parse() so the user gets a clear message instead of "parent cycle".
  function checkParent(doc, id, parent) {
    if (parent === null) return;
    const p = doc.byId.get(parent);
    if (!p || excluded(doc, p)) fail('parent_unavailable');
    if (p.archived) fail('parent_archived');
    if (parent === id) fail('self_parent');
    let node = p;
    while (node) { if (node.id === id) fail('parent_cycle', { parent, id }); node = doc.byId.get(node.parent); }
  }
  const checkTitle = title => { if (!title.trim() || title.length > 240) fail('title_length'); };
  function editTask(doc, id, title, body, now = new Date().toISOString(), { milestone, parent } = {}) {
    const t = doc.byId.get(id);
    if (!t || t.status !== 'to-do' || t.assignee !== null) fail('task_locked');
    checkTitle(title);
    if (milestone !== undefined && milestone !== null && !doc.byMilestone.has(milestone)) fail('milestone_not_found', { id: milestone });
    if (parent !== undefined) checkParent(doc, id, parent);
    const data = { ...t.data, title: title.trim(), author: 'User', updated_at: now, ...(milestone !== undefined ? { milestone } : {}), ...(parent !== undefined ? { parent } : {}) };
    return commit(doc, [{ file: t.file, start: t.start, end: t.end, replacement: record('TASK', data, body) }]);
  }
  function addTask(doc, { title, body, parent = null, milestone = null }, now = new Date().toISOString()) {
    checkTitle(title);
    if (parent) checkParent(doc, null, parent);
    const id = String(doc.meta.next_task).padStart(3, '0');
    const data = { id, title: title.trim(), kind: 'task', parent, milestone, status: 'to-do', author: 'User', assignee: null,
      created_at: now, updated_at: now, completed_at: null, branch: null, commit: null, result: '', sources: [] };
    const meta = { ...doc.meta, next_task: doc.meta.next_task + 1 };
    const text = `---\n${dump(meta)}\n---\n` + doc.text.slice(doc.frontLength).trimEnd() + '\n\n' + record('TASK', data, body);
    return { changes: commit(doc, [], { [REGISTRY]: text }), id };
  }
  // Replace several records at once, per file; offsets stay valid because edits are applied back to front.
  function splice(doc, edits) {
    const changes = {};
    const byFile = new Map();
    for (const e of edits) { const file = e.file ?? REGISTRY; if (!byFile.has(file)) byFile.set(file, []); byFile.get(file).push(e); }
    for (const [file, list] of byFile) {
      let text = doc.files[file];
      for (const e of [...list].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.replacement + text.slice(e.end);
      changes[file] = text;
    }
    return changes;
  }
  // Every mutation validates the outcome by re-parsing all files together and returns only the changed ones.
  function commit(doc, edits, extra = {}) {
    const changes = { ...splice(doc, edits), ...extra };
    for (const name of Object.keys(changes)) if (changes[name] === (doc.files[name] ?? null)) delete changes[name];
    if (Object.keys(changes).length) apply(doc, changes);
    return changes;
  }
  // priority is optional so an edit without it stays a byte-for-byte no-op for records that never had the field.
  const checkPriority = priority => { if (priority !== undefined && !priorities.includes(priority)) fail('unknown_priority', { priority }); };
  function editMilestone(doc, id, title, body, { priority } = {}) {
    const m = doc.byMilestone.get(id);
    if (!m) fail('milestone_not_found', { id });
    checkTitle(title); checkPriority(priority);
    return commit(doc, [{ file: REGISTRY, start: m.start, end: m.end, replacement: record('MILESTONE', { ...m.data, title: title.trim(), ...(priority !== undefined ? { priority } : {}) }, body) }]);
  }
  // The milestones section is the `## ` heading that precedes the first MILESTONE record; in a registry
  // without milestones it is found by name (any language the templates ever used).
  function milestoneSection(doc) {
    const first = doc.milestones[0];
    const headings = [...doc.text.matchAll(/^## .+$/gm)];
    if (first) return headings.filter(h => h.index < first.start).at(-1) ?? null;
    return headings.find(h => /milestone|веха|майлстоун/i.test(h[0])) ?? null;
  }
  function addMilestone(doc, { title, body = '', priority = 'normal' }) {
    checkTitle(title); checkPriority(priority);
    const id = 'M' + String(Math.max(0, ...doc.milestones.map(m => Number(m.id.slice(1)))) + 1).padStart(2, '0');
    const last = doc.milestones.at(-1);
    let at;
    if (last) at = last.end;
    else {
      // No milestones yet: append right after the section heading so the record lands in the right section.
      const heading = milestoneSection(doc);
      if (!heading) fail('no_milestone_section');
      at = Math.min(doc.text.length, heading.index + heading[0].length + 1);
    }
    const before = doc.text.slice(0, at), rest = doc.text.slice(at);
    let replacement = (before.endsWith('\n\n') || !before.endsWith('\n') ? '' : '\n') + record('MILESTONE', { id, title: title.trim(), priority }, body);
    if (!before.endsWith('\n')) replacement = '\n' + replacement;
    if (rest.startsWith('\n')) replacement = replacement.replace(/\n$/, ''); // keep a single blank line before the next section
    const changes = commit(doc, [{ file: REGISTRY, start: at, end: at, replacement }]);
    return { changes, id };
  }
  // Milestone is planning metadata, so unlike title/body it may change for a task in any state.
  // The record's author is kept: reassigning a milestone is not a rewrite of the agent's result.
  function setMilestone(doc, ids, milestone, now = new Date().toISOString()) {
    if (milestone !== null && !doc.byMilestone.has(milestone)) fail('milestone_not_found', { id: milestone });
    const edits = [];
    for (const id of new Set(ids)) {
      const t = doc.byId.get(id);
      if (!t) fail('task_not_found', { id });
      if (t.milestone === milestone) continue;
      edits.push({ file: t.file, start: t.start, end: t.end, replacement: record('TASK', { ...t.data, milestone, updated_at: now }, t.body) });
    }
    return commit(doc, edits);
  }
  // Explicitly add a task to a milestone from the milestone page. Subtasks are never pulled along silently:
  // with withSubtasks they get the same milestone explicitly; without it, subtasks that inherited the parent's
  // milestone are pinned to the previous value so moving the parent does not drag them.
  // A subtask without a previous milestone (nothing to pin) keeps inheriting — a limitation of the model.
  function addToMilestone(doc, id, milestone, { withSubtasks = false } = {}, now = new Date().toISOString()) {
    if (!doc.byMilestone.has(milestone)) fail('milestone_not_found', { id: milestone });
    const t = doc.byId.get(id);
    if (!t) fail('task_not_found', { id });
    const descendants = [];
    const walk = pid => { for (const c of doc.tasks) if (c.parent === pid) { descendants.push(c); walk(c.id); } };
    walk(id);
    const edits = [];
    const set = (task, m) => { if (task.milestone !== m) edits.push({ file: task.file, start: task.start, end: task.end, replacement: record('TASK', { ...task.data, milestone: m, updated_at: now }, task.body) }); };
    for (const d of descendants) {
      if (withSubtasks) set(d, milestone);
      else if (!d.milestone) { const prev = milestoneOf(doc, d); if (prev && prev !== milestone) set(d, prev); }
    }
    set(t, milestone);
    return commit(doc, edits);
  }
  // Re-parent a task in any status (like setStatus/addToMilestone): only parent and updated_at change;
  // a task without an explicit milestone starts inheriting from the new parent.
  function setParent(doc, id, parent, now = new Date().toISOString()) {
    const t = doc.byId.get(id);
    if (!t) fail('task_not_found', { id });
    checkParent(doc, id, parent);
    if (t.parent === parent) return {};
    return commit(doc, [{ file: t.file, start: t.start, end: t.end, replacement: record('TASK', { ...t.data, parent, updated_at: now }, t.body) }]);
  }
  // Status changes from the UI touch only status-related fields: author, branch, commit, body and result
  // stay as the agent left them. done stamps completed_at; leaving done clears it; in_progress needs an
  // assignee, so a free task taken from the UI gets "User".
  function setStatus(doc, id, status, now = new Date().toISOString()) {
    const t = doc.byId.get(id);
    if (!t) fail('task_not_found', { id });
    if (!statuses.includes(status)) fail('unknown_status', { status });
    if (t.status === status) return {};
    const data = { ...t.data, status, updated_at: now, completed_at: status === 'done' ? now : null };
    if (status === 'in_progress' && !data.assignee) data.assignee = 'User';
    // A status change clears the manual-return marker; an open task cannot stay in the archive.
    delete data.unarchived_at;
    if (t.archived && !closed.has(status)) { delete data.archived_at; return move(doc, t, REGISTRY, data); }
    return commit(doc, [{ file: t.file, start: t.start, end: t.end, replacement: record('TASK', data, t.body) }]);
  }
  // Moving a record between the registry and the archive: cut from one file, append to the end of the other.
  const archiveTemplate = project => `---\nschema: 1\nproject: ${JSON.stringify(project)}\narchive: true\n---\n\n# ${project} — archived tasks\n\nClosed records (\`done\`/\`cancelled\`/\`removed\`) moved out of the registry. Milestones and \`next_task\` stay in the registry; \`#NNN\` references keep working.\n\n## Tasks\n`;
  function move(doc, tasks, toFile, dataOf) {
    const list = Array.isArray(tasks) ? tasks : [tasks];
    const fromFile = toFile === REGISTRY ? ARCHIVE : REGISTRY;
    const cuts = list.map(t => { if (t.file !== fromFile) fail('not_in_file', { id: t.id, file: label(fromFile) }); return { file: fromFile, start: t.start, end: t.end, replacement: '' }; });
    // The rest of the source file is kept byte for byte (only the cut records disappear), so every other
    // record's raw text — including the trailing blank line of the last one — survives the move.
    let removed = splice(doc, cuts)[fromFile];
    if (!removed.endsWith('\n')) removed += '\n';
    const base = (doc.files[toFile] ?? archiveTemplate(doc.meta.project)).trimEnd();
    const appended = base + '\n\n' + list.map(t => record('TASK', typeof dataOf === 'function' ? dataOf(t) : dataOf, t.body)).join('');
    return commit(doc, [], { [fromFile]: removed, [toFile]: appended.trimEnd() + '\n' });
  }
  const closedAt = t => Date.parse(t.completed_at ?? t.updated_at);
  const openDescendant = (doc, id) => doc.tasks.some(c => c.parent === id && (!closed.has(c.status) || openDescendant(doc, c.id)));
  function archive(doc, ids, now = new Date().toISOString()) {
    const list = [...new Set(Array.isArray(ids) ? ids : [ids])].map(id => doc.byId.get(id) ?? fail('task_not_found', { id }));
    for (const t of list) {
      if (t.archived) fail('already_archived', { id: t.id });
      if (!closed.has(t.status)) fail('archive_open', { id: t.id });
      if (openDescendant(doc, t.id)) fail('archive_subtasks', { id: t.id });
    }
    if (!list.length) return {};
    return move(doc, list, ARCHIVE, t => { const data = { ...t.data, archived_at: now }; delete data.unarchived_at; return data; });
  }
  function unarchive(doc, id, now = new Date().toISOString()) {
    const t = doc.byId.get(id);
    if (!t) fail('task_not_found', { id });
    if (!t.archived) fail('not_archived', { id });
    return move(doc, t, REGISTRY, () => { const data = { ...t.data, updated_at: now, unarchived_at: now }; delete data.archived_at; return data; });
  }
  // Auto-archive: closed tasks older than a week without a manual-return marker and without open subtasks.
  function archiveCandidates(doc, now = new Date().toISOString(), days = ARCHIVE_AFTER_DAYS) {
    const limit = Date.parse(now) - days * 86_400_000;
    return doc.tasks.filter(t => !t.archived && closed.has(t.status) && t.unarchived_at === undefined && closedAt(t) < limit && !openDescendant(doc, t.id)).map(t => t.id);
  }
  function autoArchive(doc, now = new Date().toISOString(), days = ARCHIVE_AFTER_DAYS) {
    const ids = archiveCandidates(doc, now, days);
    return { ids, changes: ids.length ? archive(doc, ids, now) : {} };
  }
  const findComment = (doc, taskId, commentId) => {
    const t = doc.byId.get(taskId);
    if (!t) fail('task_not_found', { id: taskId });
    const index = t.comments.findIndex(comment => comment.id === Number(commentId));
    if (index < 0) fail('comment_not_found', { id: taskId, comment: commentId });
    return { t, index };
  };
  function addComment(doc, id, text, author = 'User', now = new Date().toISOString()) {
    const t = doc.byId.get(id);
    if (!t) fail('task_not_found', { id });
    if (!text.trim()) fail('comment_blank');
    const nextId = t.comments.length ? t.comments[t.comments.length - 1].id + 1 : 1;
    const comments = [...t.comments, { id: nextId, author, updated_at: now, done: false, text: text.trim() }];
    return commit(doc, [], { [commentsFile(t.id)]: commentsText(comments) });
  }
  function editComment(doc, taskId, commentId, text, now = new Date().toISOString()) {
    const { t, index } = findComment(doc, taskId, commentId);
    if (!text.trim()) fail('comment_blank');
    const comments = t.comments.map((comment, i) => i === index ? { ...comment, text: text.trim(), updated_at: now } : comment);
    return commit(doc, [], { [commentsFile(t.id)]: commentsText(comments) });
  }
  function setCommentDone(doc, taskId, commentId, done, now = new Date().toISOString()) {
    const { t, index } = findComment(doc, taskId, commentId);
    if (typeof done !== 'boolean') fail('comment_done_type');
    if (t.comments[index].done === done) return {};
    const comments = t.comments.map((comment, i) => i === index ? { ...comment, done, updated_at: now } : comment);
    return commit(doc, [], { [commentsFile(t.id)]: commentsText(comments) });
  }
  // Deleting keeps the permanent numbers of the remaining comments so old deep links never change target.
  function deleteComment(doc, taskId, commentId) {
    const { t, index } = findComment(doc, taskId, commentId);
    const comments = t.comments.filter((_, i) => i !== index);
    return commit(doc, [], { [commentsFile(t.id)]: commentsText(comments) });
  }
  const api = { statuses, priorities, priorityOf, inactive, closed, REGISTRY, ARCHIVE, ARCHIVE_AFTER_DAYS, commentsFile, COMMENTS_FILE, MESSAGES, format, label, yaml, dump, parse, parseComments, commentsText, apply, archive, unarchive, archiveCandidates, autoArchive, milestoneOf, excluded, progress, complete, defaults, cleanConfig, editTask, addTask, editMilestone, addMilestone, setMilestone, addToMilestone, setParent, setStatus, addComment, editComment, setCommentDone, deleteComment };
  root.RegistryModel = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
