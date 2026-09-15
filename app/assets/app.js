/* Dashboard UI. No network beyond the local server, no backend, no CDN, no localStorage, no generated copy of the registry. */
(() => {
  'use strict';
  const M = RegistryModel, $ = id => document.getElementById(id), { t, plural } = I18n;
  const labels = status => t('status.' + status);
  let doc = null, store = null, baseline = null, configBaseline = null, config = M.defaults(), layout = null;
  let configTimer, configQueue = Promise.resolve(), configWrites = 0, pendingConfig = false, editing = null, commentEditing = null, commentTarget = null, saving = false, polling = false, loading = false;
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action, className = '') => { const b = el('button', className, text); b.type = 'button'; b.addEventListener('click', action); return b; };
  const badge = task => el('span', 'badge ' + task.status, labels(task.status));
  // A record from the archive is marked with a chip next to its status everywhere it is shown.
  const archiveChip = task => { const chip = el('span', 'archive-chip', t('archive.chip')); chip.title = t('archive.since', { date: date(task.archived_at) }); return chip; };
  const badges = task => task.archived ? [badge(task), archiveChip(task)] : [badge(task)];
  // baseline — the map of registry files as store.readAll() returned them; compared by content.
  const sameFiles = (a, b) => { if (!a || !b) return a === b; const keys = new Set([...Object.keys(a), ...Object.keys(b)]); for (const k of keys) if ((a[k] ?? null) !== (b[k] ?? null)) return false; return true; };
  async function writeChanges(changes, expected) { for (const [name, text] of Object.entries(changes)) await store.write(name, text, expected[name] ?? null); }
  const changedIds = change => [].concat(change.taskIds ?? change.taskId);
  // Errors from the model and the server carry a code: translate it, otherwise show the message as is.
  const errorText = error => error?.code && I18n.has('error.' + error.code) ? t('error.' + error.code, error.params ?? {}) : error?.message ?? String(error);
  // Milestone priority — a coloured dot (low yellow, normal grey, high red) with the label in the tooltip.
  const priorityDot = m => { const p = M.priorityOf(m); const dot = el('span', 'priority-dot ' + p); dot.title = t('priority.label', { value: t('priority.' + p) }); dot.setAttribute('aria-label', dot.title); return dot; };
  const date = value => value ? new Date(value).toLocaleString(I18n.locale(), { dateStyle: 'short', timeStyle: 'short' }) : t('meta.unset');
  function notice(message = '', error = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
  function options(select, values, selected) {
    select.replaceChildren(...values.map(([value, title]) => { const o = el('option', '', title); o.value = value; return o; }));
    select.value = selected ?? '';
  }
  const saveState = text => { $('save-state').textContent = text; };
  function saveConfig() {
    if (!store || !doc) return;
    clearTimeout(configTimer); pendingConfig = true; saveState(t('save.pending'));
    configTimer = setTimeout(flushConfig, 350);
  }
  function flushConfig() {
    clearTimeout(configTimer);
    if (!pendingConfig || !store) return configQueue;
    const currentStore = store;
    const serialized = JSON.stringify(M.cleanConfig(config, doc), null, 2) + '\n';
    pendingConfig = false;
    configWrites++;
    configQueue = configQueue.catch(() => {}).then(async () => {
      try {
        if (serialized !== configBaseline) await currentStore.write('config', serialized, configBaseline);
        configBaseline = serialized;
        if (!pendingConfig && configWrites === 1) saveState(t('save.saved'));
      } catch (error) {
        pendingConfig = true; saveState(t('save.failed')); notice(errorText(error), true);
      } finally { configWrites--; }
    });
    return configQueue;
  }
  // Attachments live in the task folder of the repository. Task text refers to them relative to the registry
  // file (`.trackfile/tasks/042/shot.png`); only that path shape resolves to an image, everything else stays a link.
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attachmentPattern = () => new RegExp('^(?:\\./)?' + (layout.attachmentsPrefix === '.' ? '' : escapeRe(layout.attachmentsPrefix) + '/') + '(\\d{3,})/([^/]+)$');
  const attachmentPath = (taskId, name) => (layout.attachmentsPrefix === '.' ? '' : layout.attachmentsPrefix + '/') + `${taskId}/${name}`;
  const attachmentHref = (taskId, name) => `attachments/${taskId}/${encodeURIComponent(name)}`;
  function attachmentUrl(href) {
    const m = layout && attachmentPattern().exec(href);
    if (!m) return null;
    // A file of a task that is still being created is previewed from memory.
    const pending = editing?.pending?.find(item => item.url && item.name === m[2]);
    return pending ? pending.url : attachmentHref(m[1], m[2]);
  }
  async function openStore(candidate) {
    await flushConfig();
    if (pendingConfig) throw Object.assign(new Error(), { code: 'config_unsaved' });
    const files = await candidate.readAll();
    const parsed = M.parse(files);
    const rawConfig = await candidate.optional('config');
    let state;
    try { state = rawConfig ? JSON.parse(rawConfig) : M.defaults(); } catch { throw Object.assign(new Error(), { code: 'config_corrupt' }); }
    if (state.schema !== 1) throw Object.assign(new Error(), { code: 'config_schema' });
    store = candidate; doc = parsed; baseline = files; configBaseline = rawConfig; config = M.cleanConfig(state, doc); layout = candidate.layout;
    // Filters, pins and expansion are restored from config; the page itself comes from the URL hash
    // (deep link / reload) and otherwise is the dashboard.
    config.view = 'dashboard';
    applyLanguage();
    pendingConfig = false; notice(t('notice.connected', { registry: layout.registry })); $('reload').disabled = false;
    initialRoute(); saveConfig();
    autoArchive();
    return true;
  }
  // When the registry loads, closed tasks older than a week move to the archive in one write and one commit.
  async function autoArchive() {
    const ids = M.archiveCandidates(doc);
    if (!ids.length) return;
    await mutateProject(current => M.autoArchive(current).changes, t('notice.auto_archived', { n: ids.length, ids: ids.map(id => '#' + id).join(', ') }), { operation: 'auto archive', taskIds: ids, title: `auto-archive, tasks: ${ids.length}` });
  }
  async function reload() {
    if (!store || saving || loading) return;
    loading = true; $('reload').disabled = true; saveState(t('save.reloading'));
    try {
      // Explicit reload is also the recovery path for a config conflict.
      clearTimeout(configTimer); await configQueue;
      const files = await store.readAll();
      const parsed = M.parse(files);
      const rawConfig = await store.optional('config');
      let incoming = rawConfig ? JSON.parse(rawConfig) : M.defaults();
      if (incoming.schema !== 1) throw Object.assign(new Error(), { code: 'config_schema' });
      doc = parsed; baseline = files; configBaseline = rawConfig; layout = store.layout;
      config = M.cleanConfig(incoming, doc); pendingConfig = false;
      applyLanguage(); render(); saveConfig(); notice(t('notice.reloaded'));
      autoArchive();
    } catch (error) { saveState(t('save.reload_failed')); notice(errorText(error), true); }
    finally { loading = false; $('reload').disabled = false; }
  }
  function selectTask(id, view = 'tree', comment = null) {
    const pageChange = reader || view !== config.view || (view === 'task' && (config.selected !== id || comment !== commentTarget));
    reader = null; commentTarget = comment; config.view = view; config.selected = id;
    let parent = doc.byId.get(id)?.parent;
    while (parent) { if (!config.expanded.includes(parent)) config.expanded.push(parent); parent = doc.byId.get(parent)?.parent; }
    render(); saveConfig();
    // Selecting without a page change updates the current history entry, otherwise Back from the task page
    // would restore an older selection from state and flash the wrong row.
    if (pageChange) pushRoute(); else replaceRoute();
  }
  function jumpTask(id, view = 'tree') {
    config.search = ''; config.statuses = []; config.milestone = 'all'; selectTask(id, view);
  }
  const openTaskPage = id => selectTask(id, 'task');
  const openTaskComment = (id, comment) => selectTask(id, 'task', Number(comment));
  // Single click selects, double click opens the full page; the select is idempotent so the extra click is harmless.
  function clickable(node, id) { node.addEventListener('dblclick', () => openTaskPage(id)); node.dataset.task = id; return node; }
  // Each view keeps its own scroll offset for the session; a task page always opens at the top and
  // going back to the tree lands where the user left it. Not persisted: the config stores no scroll state.
  const scrollMemory = {}; let lastView = null, lastReaderPath = null, lastMilestone = null, flashTask = null, flashSource = null;
  // The milestone page remembers its position per milestone, like the reader per document: Back from a task
  // returns to the same spot, while a fresh open (openMilestone/deep link) starts at the top.
  const scrollKey = (view, path) => view === 'source' ? 'source:' + path : view === 'milestone' ? 'milestone:' + path : view;
  // The source reader is session-only navigation on top of config.view: it never lands in the config.
  let reader = null; // { path, text, markdown, stack: [previous readers] }
  const activeView = () => reader ? 'source' : config.view;
  // Browser history: every page-level move (dashboard/tree, a task page, a source) is an entry, so the
  // browser's Back/Forward and the in-app Back are the same navigation. Scroll is ours to restore.
  history.scrollRestoration = 'manual';
  const sourceCache = new Map(); // path -> {path, text, markdown} | {path: 'commit:<hash>', commit}
  // The commit page lives in the same stack as sources (history, Back, deep link): the key `commit:<hash>`
  // tells it apart from a file path, in the address it is `#commit/<hash>`.
  const commitKey = hash => 'commit:' + hash, commitOf = key => key.startsWith('commit:') ? key.slice(7) : null;
  // A source opened explicitly is re-read (git changes move between views); the cache serves history.
  const loadReader = async (key, fresh = false) => (!fresh || commitOf(key) ? sourceCache.get(key) : null) ?? (commitOf(key) ? { path: key, commit: await store.commit(commitOf(key)) } : await store.source(key));
  let routeIndex = 0;
  const currentRoute = () => ({ app: true, index: routeIndex, view: config.view, selected: config.selected, comment: commentTarget, milestone: config.selectedMilestone, reader: reader ? { path: reader.path, task: reader.task ?? null, stack: reader.stack.map(r => r.path) } : null });
  const routeHash = r => r.reader ? (commitOf(r.reader.path) ? '#commit/' + commitOf(r.reader.path) : '#source/' + r.reader.path) : r.view === 'task' ? `#task/${r.selected}${r.comment ? '/comment/' + r.comment : ''}` : r.view === 'milestone' ? '#milestone/' + r.milestone : '#' + r.view;
  function pushRoute() { routeIndex++; const r = currentRoute(); history.pushState(r, '', routeHash(r)); }
  function replaceRoute() { const r = currentRoute(); history.replaceState(r, '', routeHash(r)); }
  function go(view) {
    if (!reader && view === config.view) return;
    reader = null; config.view = view; render(); saveConfig(); pushRoute();
  }
  // The milestone page is its own view; the tree filters are left alone.
  function openMilestone(id) {
    if (!reader && config.view === 'milestone' && config.selectedMilestone === id) return;
    // An explicit open starts at the top; the remembered position serves only Back.
    delete scrollMemory[scrollKey('milestone', id)];
    reader = null; config.view = 'milestone'; config.selectedMilestone = id; render(); saveConfig(); pushRoute();
  }
  // Back: a real browser back when we pushed the entry we are on, otherwise the given fallback.
  function goBack(fallback) { if (routeIndex > 0 && history.state?.app) history.back(); else fallback(); }
  async function applyRoute(state) {
    if (!doc) return;
    routeIndex = state.index;
    if (state.reader) {
      const paths = [...state.reader.stack, state.reader.path];
      try { for (const p of paths) if (!sourceCache.has(p)) sourceCache.set(p, await loadReader(p)); }
      catch (error) { notice(errorText(error), true); return; }
      let chain = null;
      for (const p of paths) chain = { ...sourceCache.get(p), task: state.reader.task, stack: chain ? [...chain.stack, chain] : [] };
      reader = chain;
    } else reader = null;
    config.view = state.view; commentTarget = state.comment ?? null; if (state.selected && doc.byId.has(state.selected)) config.selected = state.selected;
    if (state.milestone && doc.byMilestone.has(state.milestone)) config.selectedMilestone = state.milestone;
    render(); saveConfig();
  }
  // popstate covers Back/Forward (state present) and a hash typed into the address bar (state null).
  window.addEventListener('popstate', e => e.state?.app ? applyRoute(e.state) : initialRoute());
  // Deep link on load (#task/050, #source/path, #tree); anything else lands on the dashboard.
  function initialRoute() {
    if (!doc) return;
    const hash = decodeURIComponent(location.hash.slice(1));
    let m; routeIndex = 0; reader = null; commentTarget = null; config.view = 'dashboard';
    if ((m = /^task\/(\d+)(?:\/comment\/(\d+))?$/.exec(hash)) && doc.byId.has(m[1])) { config.view = 'task'; config.selected = m[1]; commentTarget = m[2] ? Number(m[2]) : null; }
    else if ((m = /^source\/(.+)$/.exec(hash))) { render(); replaceRoute(); openSource(m[1], null, true); return; }
    else if ((m = /^commit\/([0-9a-f]{4,40})$/i.exec(hash))) { render(); replaceRoute(); openSource(commitKey(m[1]), null, true); return; }
    else if (hash === 'tree') config.view = 'tree';
    else if ((m = /^milestone\/(M\d+)$/.exec(hash)) && doc.byMilestone.has(m[1])) { config.view = 'milestone'; config.selectedMilestone = m[1]; }
    render(); replaceRoute();
  }
  function applySidebar() {
    document.body.classList.toggle('sidebar-collapsed', config.sidebarCollapsed);
    const b = $('sidebar-toggle'); b.setAttribute('aria-expanded', String(!config.sidebarCollapsed));
    b.title = config.sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse'); b.setAttribute('aria-label', b.title);
  }
  // Language: the config override wins over the browser; static strings are re-applied to the DOM here.
  function applyLanguage() {
    I18n.setLanguage(config.lang ?? I18n.detect());
    I18n.apply(document);
    document.documentElement.lang = I18n.language;
    const project = doc?.meta.project ?? 'Trackfile';
    document.title = `${project} · Trackfile`;
    $('brand-name').textContent = project; $('crumb-project').textContent = project;
    $('lang').lastElementChild.textContent = t('lang.switch');
  }
  function render() {
    closeMenu();
    document.body.dataset.theme = config.theme; applySidebar();
    if (!doc) return;
    const switching = lastView !== null && lastView !== activeView();
    // The reader remembers its position per document so Back from a task returns to the same spot;
    // a new document still opens at the top (openSource scrolls itself).
    if (lastView !== null) scrollMemory[scrollKey(lastView, lastView === 'source' ? lastReaderPath : lastMilestone)] = scrollY;
    if (switching && lastView === 'source' && lastReaderPath) flashSource = lastReaderPath;
    // Returning from a task page to a milestone flashes the row, like in the tree.
    if (switching && lastView === 'task' && (config.view === 'tree' || config.view === 'milestone')) flashTask = config.selected;
    $('welcome').hidden = true; $('workspace').hidden = false;
    $('task-count').textContent = doc.tasks.length;
    if (config.view === 'task' && !doc.byId.has(config.selected)) config.view = 'tree';
    if (config.view === 'milestone' && !doc.byMilestone.has(config.selectedMilestone)) config.view = 'dashboard';
    const view = activeView(), task = config.view === 'task' ? doc.byId.get(config.selected) : null, milestone = config.view === 'milestone' ? doc.byMilestone.get(config.selectedMilestone) : null;
    $('dashboard').hidden = view !== 'dashboard'; $('tree-view').hidden = view !== 'tree'; $('task-page').hidden = view !== 'task'; $('source-page').hidden = view !== 'source'; $('milestone-page').hidden = view !== 'milestone';
    $('task-nav').hidden = view !== 'task' && view !== 'source' && view !== 'milestone'; $('page-actions').hidden = view !== 'task';
    // On the milestone page its title is the main heading and the kind/number become the subtitle.
    $('heading').textContent = view === 'dashboard' ? t('page.dashboard') : view === 'tree' ? t('page.tree') : view === 'task' ? t('page.task', { id: task.id }) : view === 'milestone' ? milestone.title : reader.commit ? t('page.commit', { hash: reader.commit.short }) : reader.path.split('/').pop();
    $('page-name').textContent = $('heading').textContent;
    $('subtitle').textContent = view === 'dashboard' ? t('page.dashboard_sub') : view === 'tree' ? t('page.tree_sub') : view === 'task' ? (task.kind === 'feature' ? t('kind.feature') : t('kind.task')) + ' · ' + labels(task.status) : view === 'milestone' ? t('page.milestone_sub', { id: milestone.id }) : reader.commit ? t('page.commit_sub', { subject: reader.commit.subject }) : t('page.source_sub', { path: reader.path });
    // The top button on a milestone page creates the task right inside that milestone.
    $('new-task').textContent = view === 'milestone' ? t('task.new_in_milestone') : t('task.new');
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === (view === 'dashboard' || view === 'milestone' ? 'dashboard' : 'tree')));
    if (view === 'dashboard') renderDashboard(); else if (view === 'tree') { renderFilters(); renderTree(); renderDetail(); } else if (view === 'task') renderTaskPage(task); else if (view === 'milestone') renderMilestonePage(milestone); else renderSourcePage();
    const readerChanged = view === 'source' && lastReaderPath !== reader.path;
    const milestoneChanged = view === 'milestone' && lastMilestone !== milestone.id;
    if (switching || readerChanged || milestoneChanged || lastView === null) scrollTo({ top: view === 'task' ? 0 : scrollMemory[scrollKey(view, view === 'source' ? reader.path : milestone?.id)] ?? 0, behavior: 'instant' });
    lastView = view; lastReaderPath = reader?.path ?? null; lastMilestone = milestone?.id ?? null; flashTask = null; flashSource = null;
  }
  const isPinned = (list, id) => config[list].includes(id);
  function togglePin(list, id) {
    config[list] = isPinned(list, id) ? config[list].filter(x => x !== id) : [...config[list], id];
    render(); saveConfig();
  }
  const byPin = list => (a, b) => Number(isPinned(list, b.id)) - Number(isPinned(list, a.id));
  const hiddenDone = t => config.hideDone && t.status === 'done';
  function taskRow(t) {
    const row = clickable(button('', () => jumpTask(t.id), 'recent-row'), t.id);
    row.append(el('span', 'mono', '#' + t.id), el('span', 'recent-title', t.title), ...badges(t), el('time', 'mono', date(t.updated_at)));
    return row;
  }
  const milestoneState = p => p.total && p.done === p.total ? t('milestone.state_done') : p.active ? t('milestone.state_active') : t('milestone.state_progress');
  function renderDashboard() {
    const p = M.progress(doc);
    $('hide-done-dashboard').checked = config.hideDone;
    const pinned = config.pinnedTasks.map(id => doc.byId.get(id));
    $('pinned-dashboard').hidden = !pinned.length;
    $('pinned-tasks').replaceChildren(...pinned.map(taskRow));
    const data = [[t('stats.done'), p.percent + '%', t('stats.done_foot', { done: p.done, total: p.total })], [t('stats.active'), p.active, t('stats.active_foot')], [t('stats.review'), p.review, t('stats.review_foot')], [t('stats.total'), doc.tasks.length, t('stats.total_foot', { milestones: doc.milestones.length, archived: doc.tasks.filter(t => t.archived).length })]];
    $('stats').replaceChildren(...data.map(([label, value, foot]) => { const card = el('div', 'stat'); card.append(el('div', 'stat-label', label), el('div', 'stat-number', value), el('div', 'stat-foot', foot)); return card; }));
    const shown = [...doc.milestones].sort(byPin('pinnedMilestones')).filter(m => !(config.hideDone && M.complete(M.progress(doc, m.id))));
    const hiddenCount = doc.milestones.length - shown.length;
    $('milestones').replaceChildren(...shown.map(m => {
      const p = M.progress(doc, m.id);
      const row = button('', () => openMilestone(m.id), 'milestone-row priority-' + M.priorityOf(m) + (isPinned('pinnedMilestones', m.id) ? ' pinned-row' : ''));
      const bar = el('progress'); bar.max = 100; bar.value = p.percent; bar.setAttribute('aria-label', m.title + ': ' + p.percent + '%');
      const state = el('span', 'milestone-state', milestoneState(p));
      row.append(priorityDot(m), el('span', 'mono milestone-id', m.id), el('h3', '', m.title), bar, el('span', 'milestone-count', p.total ? t('milestone.count', { done: p.done, total: p.total }) : t('milestone.no_active')), el('strong', 'milestone-percent', p.total ? p.percent + '%' : '—'), state);
      const line = el('div', 'milestone-line');
      const pinned = isPinned('pinnedMilestones', m.id);
      const pin = button(pinned ? '★' : '☆', () => togglePin('pinnedMilestones', m.id), 'pin' + (pinned ? ' active' : '')); pin.title = t(pinned ? 'pin.unpin' : 'pin.pin', { id: m.id }); pin.setAttribute('aria-label', pin.title); pin.setAttribute('aria-pressed', String(pinned));
      const edit = button('✎', () => openMilestoneEditor(m.id), 'milestone-edit'); edit.title = t('milestone.edit', { id: m.id }); edit.setAttribute('aria-label', edit.title);
      line.append(row, pin, edit); return line;
    }));
    if (hiddenCount) $('milestones').append(el('div', 'empty', t('milestone.hidden_done', { n: hiddenCount })));
    const recent = doc.tasks.filter(t => !hiddenDone(t) && !t.archived).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || Number(b.id) - Number(a.id)).slice(0, 8);
    $('recent').replaceChildren(...recent.map(taskRow));
  }
  // The tree and the milestone page share one multi-select status filter and one sort order.
  const taskOrder = mode => mode === 'updated'
    ? (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || Number(a.id) - Number(b.id)
    : (a, b) => Number(a.id) - Number(b.id);
  function renderStatusPicker(summary, container, selected, onChange) {
    summary.textContent = selected.length ? selected.map(labels).join(', ') : t('filter.all_statuses');
    container.replaceChildren(...M.statuses.map(status => {
      const label = el('label');
      const input = el('input'); input.type = 'checkbox'; input.value = status; input.checked = selected.includes(status);
      input.addEventListener('change', () => onChange([...container.querySelectorAll('input:checked')].map(item => item.value)));
      label.append(input, el('span', '', labels(status))); return label;
    }));
  }
  function renderFilters() {
    $('search').value = config.search;
    renderStatusPicker($('status-summary'), $('status-options'), config.statuses, selected => {
      config.statuses = selected; renderFilters(); renderTree(); saveConfig();
    });
    options($('milestone'), [['all', t('filter.all_milestones')], ['none', t('filter.no_milestone')], ...doc.milestones.map(m => [m.id, `${m.id} · ${m.title}`])], config.milestone);
    options($('sort'), [['id', t('sort.id')], ['updated', t('sort.updated')]], config.sort);
    $('show-archive').checked = config.showArchive;
  }
  // Every tree row shows the code of its effective milestone; an inherited one is dimmed.
  function taskLabel(t) {
    const line = el('span', 'mono', '#' + t.id + (t.kind === 'feature' ? ' · ' + I18n.t('kind.feature_tag') : ''));
    const m = M.milestoneOf(doc, t);
    if (m) { const chip = el('span', 'milestone-chip' + (t.milestone ? '' : ' inherited'), m); chip.title = I18n.t('milestone.chip', { id: m, title: doc.byMilestone.get(m).title }) + (t.milestone ? '' : ' ' + I18n.t('milestone.inherited_suffix')); line.append(' ', chip); }
    return line;
  }
  function renderTree() {
    const term = config.search.toLocaleLowerCase().trim();
    const filtering = !!term || config.statuses.length > 0 || config.milestone !== 'all';
    const matches = new Set(doc.tasks.filter(t => {
      if (t.archived && !config.showArchive) return false; // archived rows only when asked for
      if (config.statuses.length && !config.statuses.includes(t.status)) return false;
      const milestone = M.milestoneOf(doc, t);
      if (config.milestone !== 'all' && milestone !== (config.milestone === 'none' ? null : config.milestone)) return false;
      return !term || `${t.id} ${t.title} ${t.body} ${t.result ?? ''} ${t.assignee ?? ''}`.toLocaleLowerCase().includes(term.replace(/^#/, ''));
    }).map(t => t.id));
    const visible = new Set(matches);
    for (const id of matches) { let p = doc.byId.get(id)?.parent; while (p) { visible.add(p); p = doc.byId.get(p)?.parent; } }
    const children = new Map();
    for (const t of doc.tasks) { const key = t.parent; if (!children.has(key)) children.set(key, []); children.get(key).push(t); }
    for (const list of children.values()) list.sort((a, b) => byPin('pinnedTasks')(a, b) || taskOrder(config.sort)(a, b));
    function node(t) {
      const group = el('div', 'tree-node');
      const row = el('div', 'tree-row' + (config.selected === t.id ? ' selected' : '') + (flashTask === t.id ? ' flash' : '') + (t.archived ? ' archived' : '')); row.dataset.task = t.id;
      const kids = (children.get(t.id) ?? []).filter(c => visible.has(c.id));
      const expanded = filtering || config.expanded.includes(t.id);
      const expander = button(kids.length ? (expanded ? '⌄' : '›') : '·', () => {
        if (expanded) config.expanded = config.expanded.filter(id => id !== t.id); else config.expanded.push(t.id);
        renderTree(); saveConfig();
      }, 'expander');
      expander.disabled = !kids.length || filtering; expander.setAttribute('aria-label', I18n.t(expanded ? 'tree.collapse_node' : 'tree.expand_node', { title: t.title }));
      if (kids.length) expander.setAttribute('aria-expanded', String(expanded));
      const pick = clickable(button('', () => selectTask(t.id), 'tree-select'), t.id);
      pick.append(taskLabel(t), el('span', '', t.title));
      row.append(expander, pick, ...badges(t)); group.append(row);
      if (expanded && kids.length) { const branch = el('div', 'tree-children'); branch.append(...kids.map(node)); group.append(branch); }
      return group;
    }
    // Pinned tasks are repeated flat above the tree so they stay on top regardless of nesting or filters.
    const pinned = config.pinnedTasks.map(id => doc.byId.get(id));
    $('pinned-tree').hidden = !pinned.length;
    $('pinned-tree').replaceChildren(...pinned.map(t => {
      const row = el('div', 'tree-row' + (config.selected === t.id ? ' selected' : '')); row.dataset.task = t.id;
      const pick = clickable(button('', () => selectTask(t.id), 'tree-select'), t.id);
      pick.append(el('span', 'mono', '★ #' + t.id), el('span', '', t.title));
      row.append(el('span', 'expander', ''), pick, ...badges(t)); return row;
    }));
    $('tree').replaceChildren(...(children.get(null) ?? []).filter(t => visible.has(t.id)).map(node));
    if (!visible.size) $('tree').append(el('div', 'empty', t('tree.empty')));
    const archivedCount = doc.tasks.filter(t => t.archived).length;
    $('matches').textContent = (filtering ? t('tree.matches', { n: matches.size }) : t('tree.records', { n: matches.size })) + (archivedCount && !config.showArchive ? ' · ' + t('tree.archived', { n: archivedCount }) : '');
  }
  // Single write path for one-shot edits outside the forms: fresh read, check against what the UI shows, write, re-render.
  // A mutation returns {file: text|null}; each file is written with a check of its own previous content.
  async function mutateProject(mutate, message, change = null) {
    if (!store || saving || loading) return false;
    saving = true;
    try {
      const files = await store.readAll();
      if (!sameFiles(files, baseline)) throw Object.assign(new Error(), { code: 'registry_changed' });
      const current = M.parse(files), changes = mutate(current);
      await writeChanges(changes, files);
      baseline = { ...files }; for (const [name, text] of Object.entries(changes)) { if (text === null) delete baseline[name]; else baseline[name] = text; }
      doc = M.apply(current, changes); config = M.cleanConfig(config, doc);
      render(); saveConfig();
      // Records and comments created or edited through the UI get their own Git commit.
      if (change && Object.keys(changes).length) {
        try {
          const ids = changedIds(change);
          const committed = await store.recordChange(change.operation, ids, change.title ?? doc.byId.get(ids[0]).title, Object.keys(changes));
          notice(`${message} ${t('notice.committed', { hash: committed.hash.slice(0, 10) })}`);
        } catch (error) { notice(`${message} ${errorText(error)}`, true); }
      } else notice(message);
      return true;
    } catch (error) { notice(errorText(error), true); return false; }
    finally { saving = false; }
  }
  function setStatus(task, status) {
    return mutateProject(current => M.setStatus(current, task.id, status), t('notice.status_set', { id: task.id, status: labels(status) }));
  }
  function copiedPopup(event) {
    document.querySelector('.copied-popup')?.remove();
    const popup = el('span', 'copied-popup', t('copy.copied'));
    const rect = event?.currentTarget?.getBoundingClientRect?.();
    const x = event?.clientX || (rect ? rect.left + rect.width / 2 : innerWidth / 2);
    const y = event?.clientY || (rect ? rect.top : innerHeight / 2);
    popup.style.left = `${Math.max(8, Math.min(x, innerWidth - 110))}px`;
    popup.style.top = `${Math.max(8, y - 12)}px`;
    document.body.append(popup);
    popup.addEventListener('animationend', () => popup.remove(), { once: true });
  }
  async function copyReference(reference, event) {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(reference);
      copiedPopup(event);
    } catch { notice(t('copy.unavailable'), true); }
  }
  const copyTimers = new WeakMap();
  function copyControl(reference) {
    const control = el('span', 'copy-ref mono', reference);
    control.tabIndex = 0; control.setAttribute('role', 'button'); control.title = t('copy.number');
    control.addEventListener('click', event => {
      if (event.detail > 1) return;
      const point = { clientX: event.clientX, clientY: event.clientY, currentTarget: control };
      const timer = setTimeout(() => { copyTimers.delete(control); copyReference(reference, point); }, 260);
      copyTimers.set(control, timer);
    });
    control.addEventListener('dblclick', () => {
      clearTimeout(copyTimers.get(control)); copyTimers.delete(control);
    });
    control.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); copyReference(reference, { currentTarget: control });
    });
    return control;
  }
  // Submenu items for "Change status": the current status is ticked and inert.
  const statusItems = task => M.statuses.map(s => ({ label: labels(s), checked: task.status === s, run: () => setStatus(task, s) }));
  // The single list of everything one can do with a task. The side card, the task page and the
  // context menu all render from it, so a new action added here shows up everywhere at once.
  function taskActions(task) {
    const pinned = isPinned('pinnedTasks', task.id), editable = task.status === 'to-do' && task.assignee === null;
    const list = [];
    if (config.view !== 'task' || config.selected !== task.id) list.push({ label: t('action.open_page'), run: () => openTaskPage(task.id), navigation: true, always: config.view !== 'task' });
    if (config.view !== 'tree' || config.selected !== task.id) list.push({ label: t('action.show_in_tree'), run: () => jumpTask(task.id), navigation: true });
    list.push({ label: pinned ? '★ ' + t('action.unpin') : '☆ ' + t('action.pin'), run: () => togglePin('pinnedTasks', task.id), className: 'pin' + (pinned ? ' active' : '') });
    if (editable) list.push({ label: t('action.edit'), run: () => openEditor(task.id) });
    else list.push({ label: t('action.edit'), disabled: t('action.edit_locked'), menuOnly: true });
    if (!M.excluded(doc, task) && !task.archived) list.push({ label: '＋ ' + t('action.subtask'), run: () => openAddSubtask(task.id) });
    list.push({ label: t('action.change_status'), submenu: () => statusItems(task) });
    // Manual move between the registry and the archive; a closed task with open subtasks stays.
    if (task.archived) list.push({ label: t('action.unarchive'), run: () => mutateProject(current => M.unarchive(current, task.id), t('notice.unarchived', { id: task.id }), { operation: 'unarchive', taskId: task.id }) });
    else if (M.closed.has(task.status)) list.push({ label: t('action.archive'), run: () => mutateProject(current => M.archive(current, task.id), t('notice.archived', { id: task.id }), { operation: 'archive', taskId: task.id }) });
    list.push({ label: t('action.copy_number'), run: () => copyReference('#' + task.id), navigation: true });
    return list;
  }
  // Context menu: one delegated listener; any element with data-task="id" gets the full action list.
  const menu = el('div', 'context-menu'); menu.setAttribute('role', 'menu'); menu.hidden = true; document.body.append(menu);
  function closeMenu() { menu.hidden = true; menu.replaceChildren(); }
  function menuItem(a, x, y) {
    const item = el('button', 'menu-item' + (a.checked ? ' checked' : '') + (a.submenu ? ' has-sub' : ''), a.label); item.type = 'button';
    item.setAttribute('role', a.checked !== undefined ? 'menuitemradio' : 'menuitem');
    if (a.checked !== undefined) item.setAttribute('aria-checked', String(a.checked));
    if (a.disabled) { item.disabled = true; item.title = a.disabled; }
    else if (a.submenu) item.addEventListener('click', () => showMenu(a.submenu(), x, y, a.label, () => showMenu(currentMenu.items, x, y, currentMenu.title)));
    else if (a.checked) item.addEventListener('click', closeMenu);
    else item.addEventListener('click', () => { closeMenu(); a.run(); });
    return item;
  }
  let currentMenu = null;
  function showMenu(items, x, y, title, back = null) {
    if (!back) currentMenu = { items, title };
    const head = el('div', 'menu-title', title);
    if (back) { const b = el('button', 'menu-item menu-back', '‹ ' + title); b.type = 'button'; b.addEventListener('click', back); head.replaceChildren(); head.append(b); head.className = 'menu-head'; }
    menu.replaceChildren(head, ...items.map(a => menuItem(a, x, y)));
    menu.hidden = false;
    const { offsetWidth: w, offsetHeight: h } = menu;
    menu.style.left = Math.min(x, innerWidth - w - 8) + 'px'; menu.style.top = Math.min(y, innerHeight - h - 8) + 'px';
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  const openMenu = (task, x, y) => showMenu(taskActions(task), x, y, `#${task.id} · ${task.title}`);
  document.addEventListener('contextmenu', e => {
    const host = e.target.closest?.('[data-task]'), task = host && doc?.byId.get(host.dataset.task);
    if (!task || editing) return;
    e.preventDefault(); openMenu(task, e.clientX, e.clientY);
  });
  document.addEventListener('pointerdown', e => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) closeMenu(); });
  window.addEventListener('scroll', closeMenu, true); window.addEventListener('resize', closeMenu);
  // Shared building blocks for the side card and the full task page. Description, result, comments and the
  // milestone description are Markdown rendered by the same renderer as the reader (textContent only, HTML
  // stays text). Links resolve relative to the registry file, so `[#NNN](TRACKFILE.md#task-NNN)` opens the
  // task page and `#NNN.K` in text opens a comment. Fenced blocks get the same highlighter, no line numbers.
  const highlight = (node, text, lang) => Highlighter.renderCode(node, text, lang, { lineNumbers: false });
  // The same three fields are edited with the Markdown helper (shortcuts, lists, indentation, fences) and a
  // Preview tab using the same renderer; links in the preview are inert — following one would close the dialog.
  const mdEditors = {};
  for (const id of ['edit-body', 'milestone-body', 'comment-body']) mdEditors[id] = MdEditor.mount($(id), { render: text => MarkdownRenderer.render(text, { linkHandler: () => {}, highlight, breaks: true, imageSrc: attachmentUrl }) });
  function richText(className, text) {
    const box = el('div', className + ' md');
    box.append(MarkdownRenderer.render(text, { linkHandler: href => followLink(layout.registry, href), highlight, breaks: true, imageSrc: attachmentUrl }));
    TaskMarks.linkComments(box, openTaskComment);
    return box;
  }
  // Images are inserted with a 320px display width by default (`#w=320`, see markdown.js); a click opens the original.
  const IMAGE_WIDTH = 320;
  const attachmentMarkdown = (taskId, f) => f.image ? `![${f.name}](${attachmentPath(taskId, f.name)}#w=${IMAGE_WIDTH})` : `[${f.name}](${attachmentPath(taskId, f.name)})`;
  // Images are compressed on the client before upload — phone screenshots weigh megabytes and end up in git.
  // The long side is capped at 1600px; no alpha → JPEG, alpha → PNG; SVG/GIF are left alone.
  // The result is used only when it is smaller than the original, otherwise the file goes as is.
  const IMAGE_MAX_SIDE = 1600, IMAGE_MIN_BYTES = 150 * 1024, JPEG_QUALITY = 0.82;
  async function compressImage(file) {
    if (!/^image\/(png|jpeg|webp|heic|heif|avif)$/.test(file.type) || typeof createImageBitmap !== 'function') return null;
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { return null; }
    try {
      const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && file.size < IMAGE_MIN_BYTES) return null;
      const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0, w, h);
      const alpha = file.type === 'image/jpeg' ? false : hasAlpha(ctx, w, h);
      const type = alpha ? 'image/png' : 'image/jpeg';
      const blob = await new Promise(resolve => canvas.toBlob(resolve, type, JPEG_QUALITY));
      if (!blob || blob.size >= file.size) return null;
      const stem = file.name.replace(/\.[^.]+$/, '');
      return { blob, name: `${stem}.${type === 'image/png' ? 'png' : 'jpg'}`, from: file.size };
    } finally { bitmap.close?.(); }
  }
  function hasAlpha(ctx, w, h) {
    // Sampling is enough: an opaque screenshot and a translucent icon differ on any row of pixels.
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 20000)));
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (data[(y * w + x) * 4 + 3] < 250) return true;
    return false;
  }
  // Preparing a file for attachment (shared by uploads and by the deferred files of a new task).
  async function prepareAttachment(file) {
    const packed = await compressImage(file).catch(() => null);
    const name = safeFileName(packed ? packed.name : file.name);
    return { blob: packed ? packed.blob : file, name, size: packed ? packed.blob.size : file.size, image: isImage(name), original: file.name, from: packed ? packed.from : null };
  }
  const isImage = name => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name);
  const fileSize = bytes => bytes < 1024 ? t('size.b', { n: bytes }) : bytes < 1024 * 1024 ? t('size.kb', { n: (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) }) : t('size.mb', { n: (bytes / 1024 / 1024).toFixed(1) });
  // The name is normalized to what the server accepts: whitespace → "_", path/URL-special characters dropped.
  const safeFileName = name => { const cleaned = name.normalize('NFC').replace(/\s+/g, '_').replace(/[\x00-\x1f\x7f/\\:#?%*"<>|]/g, '').replace(/^\.+/, ''); return (cleaned || 'file').slice(0, 200); };
  const attachmentsCache = new Map(); // taskId -> [{name,size,modified,image}]
  async function loadAttachments(taskId) {
    const files = await store.listFiles(taskId);
    const changed = JSON.stringify(files) !== JSON.stringify(attachmentsCache.get(taskId) ?? null);
    attachmentsCache.set(taskId, files);
    return { files, changed };
  }
  function refreshAttachments(taskId) { document.querySelectorAll(`.attachments[data-task="${taskId}"]`).forEach(box => box._refresh?.(true)); }
  let uploading = false;
  async function uploadAttachments(task, fileList) {
    if (!store || uploading || !fileList.length) return;
    uploading = true; saveState(t('save.uploading'));
    const done = [], errors = [];
    let saved = 0;
    for (const file of fileList) {
      try {
        // A list item is either an already prepared attachment (new-task form) or a raw File.
        const item = file.blob ? file : await prepareAttachment(file);
        done.push(await store.uploadFile(task.id, item.blob, item.name));
        if (item.from) saved += item.from - item.size;
      } catch (error) { errors.push(`${file.name ?? file.original}: ${errorText(error)}`); }
    }
    uploading = false; saveState(t('save.saved'));
    const commits = done.filter(d => d.hash).map(d => d.hash.slice(0, 10)), commitErrors = done.map(d => d.commitError).filter(Boolean);
    const summary = done.length ? t('files.attached', { id: task.id, names: done.map(d => d.name).join(', ') }) + (saved > 0 ? ' ' + t('files.compressed', { size: fileSize(saved) }) : '') : '';
    const git = commits.length ? ' ' + t('files.commits', { n: commits.length, hashes: commits.join(', ') }) : commitErrors.length ? ` Git: ${commitErrors[0]}` : '';
    notice([summary + git, ...errors].filter(Boolean).join(' '), errors.length > 0 || commitErrors.length > 0);
    refreshAttachments(task.id);
    return done;
  }
  async function deleteAttachment(task, f) {
    if (!store || uploading) return;
    // A destructive action runs only after the user's explicit browser confirmation.
    if (!confirm(t('files.confirm_delete', { name: f.name, id: task.id }))) return;
    try {
      const r = await store.deleteFile(task.id, f.name);
      notice(t('files.deleted', { name: f.name, id: task.id }) + (r.hash ? ' ' + t('notice.commit', { hash: r.hash.slice(0, 10) }) : r.commitError ? ` Git: ${r.commitError}` : ''), Boolean(r.commitError));
    } catch (error) { notice(errorText(error), true); }
    refreshAttachments(task.id);
  }
  function attachButton(task, label, onDone = null) {
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true;
    input.addEventListener('change', async () => { const files = [...input.files]; input.value = ''; const done = await uploadAttachments(task, files); if (done?.length && onDone) onDone(done); });
    const b = button(label, () => input.click(), 'quiet'); b.append(input);
    return b;
  }
  // Images open in the built-in viewer instead of downloading; download is a separate icon button.
  function svgIcon(path, title) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', path); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.6'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    svg.append(p); if (title) { const node = document.createElementNS(ns, 'title'); node.textContent = title; svg.prepend(node); }
    return svg;
  }
  // Arrow into a tray — the conventional download icon.
  const DOWNLOAD_PATH = 'M8 2.5v7.5M4.8 7l3.2 3.2L11.2 7M2.5 10.5v2.2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2.2';
  function downloadLink(url, name) {
    const a = el('a', 'icon-button download'); a.href = url; a.download = name; a.title = t('files.download', { name }); a.setAttribute('aria-label', a.title);
    a.append(svgIcon(DOWNLOAD_PATH)); return a;
  }
  function openLightbox(url, name) {
    const box = $('lightbox'); $('lightbox-image').src = url; $('lightbox-image').alt = name; $('lightbox-name').textContent = name;
    const dl = $('lightbox-download'); dl.href = url; dl.download = name; dl.title = t('files.download', { name });
    const open = $('lightbox-open'); open.href = url;
    if (!box.open) box.showModal();
  }
  function closeLightbox() { const box = $('lightbox'); if (box.open) box.close(); $('lightbox-image').removeAttribute('src'); }
  $('lightbox').addEventListener('click', e => { if (e.target === $('lightbox') || e.target === $('lightbox-image') || e.target.id === 'lightbox-close') closeLightbox(); });
  $('lightbox').addEventListener('cancel', e => { e.preventDefault(); closeLightbox(); });
  // An image from Markdown (description, comment, form preview) also opens in the viewer, not in a new tab.
  document.addEventListener('click', e => {
    const a = e.target.closest?.('a.md-image'); if (!a) return;
    e.preventDefault(); openLightbox(a.getAttribute('href'), a.querySelector('img')?.alt || a.title || '');
  });
  // One list for the task page, the card in the tree/milestone and the editor: mode picks the per-file buttons.
  // insert(f) — the editor inserts Markdown into the description; otherwise Markdown is copied to the clipboard.
  function attachmentsSection(task, { compact = false, insert = null } = {}) {
    const box = el('section', 'attachments' + (compact ? ' compact' : '')); box.dataset.task = task.id;
    const head = el('div', 'attachments-heading'); const title = el('h3', '', t('files.heading'));
    head.append(title, attachButton(task, compact ? '＋ ' + t('files.attach_short') : '＋ ' + t('files.attach'), insert ? done => done.forEach(f => insert(f)) : null));
    const list = el('ul', 'attachment-list'); box.append(head, list);
    const paint = files => {
      title.textContent = `${t('files.heading')} · ${files.length}`;
      list.replaceChildren(...files.map(f => {
        const li = el('li', 'attachment'); const url = attachmentHref(task.id, f.name);
        const open = el('a', 'attachment-link'); open.href = url;
        // An image goes to the viewer; everything else (PDF, text) the browser shows in a new tab.
        if (f.image) { open.title = t('files.open_viewer'); open.addEventListener('click', e => { e.preventDefault(); openLightbox(url, f.name); }); }
        else { open.target = '_blank'; open.rel = 'noopener'; open.title = t('files.open_tab'); }
        if (f.image) { const img = el('img', 'attachment-thumb'); img.src = url; img.alt = f.name; img.loading = 'lazy'; open.append(img); }
        else open.append(el('span', 'attachment-icon', f.name.includes('.') ? f.name.split('.').pop().slice(0, 5).toUpperCase() : 'FILE'));
        open.append(el('span', 'attachment-name', f.name));
        const meta = el('span', 'attachment-meta', fileSize(f.size));
        const actions = el('span', 'attachment-actions');
        actions.append(downloadLink(url, f.name));
        if (insert) actions.append(button(t('files.insert'), () => insert(f), 'quiet tiny'));
        else actions.append(button('Markdown', e => copyReference(attachmentMarkdown(task.id, f), e), 'quiet tiny'));
        actions.append(button(t('action.delete'), () => deleteAttachment(task, f), 'quiet tiny danger-action'));
        li.append(open, meta, actions); return li;
      }));
      if (!files.length) list.append(el('li', 'hint attachment-empty', compact ? t('files.none_short') : t('files.none', { dir: attachmentPath(task.id, ''), example: attachmentPath(task.id, 'name.png') })));
    };
    if (attachmentsCache.has(task.id)) paint(attachmentsCache.get(task.id));
    box._refresh = async (force = false) => {
      try { const { files, changed } = await loadAttachments(task.id); if (changed || force || !list.childElementCount) paint(files); }
      catch (error) { if (!list.childElementCount) list.replaceChildren(el('li', 'hint attachment-empty', errorText(error))); }
    };
    box._refresh();
    return box;
  }
  function taskParts(task) {
    const p = M.progress(doc, null, task.id), milestone = M.milestoneOf(doc, task);
    const info = [[t('meta.author'), task.author], [t('meta.assignee'), task.assignee ?? t('meta.unassigned')], [t('meta.milestone'), milestone ? `${milestone} · ${doc.byMilestone.get(milestone).title}` + (task.milestone ? '' : ' ' + t('milestone.inherited_suffix')) : t('meta.no_milestone')], [t('meta.created'), date(task.created_at)], [t('meta.updated'), date(task.updated_at)], [t('meta.completed'), date(task.completed_at)], [t('meta.branch'), task.branch ?? t('meta.unset')], [t('meta.commit'), task.commit ?? t('meta.unset')], ...(task.archived ? [[t('meta.archived_since'), date(task.archived_at)]] : task.unarchived_at ? [[t('meta.unarchived'), date(task.unarchived_at)]] : [])];
    // The milestone in the metadata links to its page (from the card and from the task page).
    if (milestone) { const a = el('a', 'milestone-link', info[2][1]); a.href = '#milestone/' + milestone; a.title = t('milestone.open', { id: milestone }); a.addEventListener('click', e => { e.preventDefault(); openMilestone(milestone); }); info[2][1] = a; }
    // The commit hash links to the commit page with the diff; the page gets the task number for the return chip.
    if (task.commit) { const a = el('a', 'mono commit-link', task.commit.slice(0, 10)); a.href = '#commit/' + task.commit; a.title = task.commit; a.addEventListener('click', e => { e.preventDefault(); openSource(commitKey(task.commit), task.id); }); info[7][1] = a; } // the commit row, not the trailing archive rows
    const meta = el('dl'); for (const [key, value] of info) { const dd = el('dd'); if (value instanceof Node) dd.append(value); else dd.textContent = value; meta.append(el('dt', '', key), dd); }
    const children = doc.tasks.filter(n => n.parent === task.id);
    const progress = children.length ? el('p', 'hint', t('task.subtasks_progress', { done: p.done, total: p.total, percent: p.percent })) : null;
    const description = task.body ? richText('description', task.body) : el('div', 'description', t('task.no_description'));
    const result = task.result ? richText('result', task.result) : null;
    let sources = null;
    if (task.sources?.length) {
      sources = el('ul', 'sources');
      for (const source of task.sources) {
        const li = el('li');
        // Only repository-relative paths, never arbitrary URLs supplied by a task.
        if (/^[\w./-]+$/.test(source) && !source.split('/').includes('..') && !source.startsWith('/')) {
          const a = el('a', flashSource === source ? 'flash' : '', source); a.href = '#'; a.dataset.source = source;
          a.addEventListener('click', e => { e.preventDefault(); openSource(source, task.id); }); li.append(a);
        } else li.textContent = source;
        sources.append(li);
      }
    }
    const actions = el('div', 'detail-actions');
    actions.append(...taskActions(task).filter(a => !a.menuOnly && (!a.navigation || a.always)).map(a => {
      if (!a.submenu) return button(a.label, a.run, a.className);
      const b = button(a.label + ' ▾', () => { const r = b.getBoundingClientRect(); showMenu(a.submenu(), r.left, r.bottom + 4, a.label); }, a.className);
      b.setAttribute('aria-haspopup', 'menu'); return b;
    }));
    const editable = task.status === 'to-do' && task.assignee === null;
    const lock = editable ? null : el('p', 'hint', t('task.locked'));
    return { meta, progress, description, result, sources, actions, lock, children, attachments: compact => attachmentsSection(task, { compact }) };
  }
  // The preview card is shared by the tree and the milestone page; `task` is passed explicitly when the
  // selected task must come from the current list (a milestone never shows a foreign task selected in the tree).
  function renderDetail(target = $('detail'), task = doc.byId.get(config.selected)) {
    target.replaceChildren();
    if (!task) { target.append(el('p', 'hint', t('detail.empty'))); return; }
    const parts = taskParts(task);
    const top = el('div', 'detail-title'); top.append(copyControl('#' + task.id), ...badges(task));
    target.append(top, el('h2', '', task.title), parts.meta);
    if (parts.progress) target.append(parts.progress);
    target.append(parts.description);
    target.append(parts.attachments(true));
    if (parts.result) target.append(parts.result);
    if (parts.sources) target.append(el('h3', '', t('task.sources')), parts.sources);
    if (parts.lock) target.append(parts.lock);
    target.dataset.task = task.id;
    target.append(parts.actions);
  }
  // `task` — the number of the task the source was opened from; the reader highlights its mentions.
  // Following a link inside the document inherits the number so the highlight survives the chain.
  async function openSource(path, task = reader?.task ?? null, replace = false) {
    if (!store || loading) return;
    loading = true; saveState(t('save.reading'));
    try {
      const file = await loadReader(path, true);
      sourceCache.set(file.path, file);
      reader = { path: file.path, text: file.text, markdown: file.markdown, commit: file.commit, changes: file.changes, task, stack: reader ? [...reader.stack, reader] : [] };
      render(); scrollTo({ top: 0, behavior: 'instant' }); saveState(t('save.saved'));
      if (replace) replaceRoute(); else pushRoute();
    } catch (error) { saveState(''); notice(errorText(error), true); }
    finally { loading = false; }
  }
  function closeSource() {
    if (!reader) return;
    goBack(() => {
      if (reader.stack.length) { reader = reader.stack.at(-1); render(); scrollTo({ top: 0, behavior: 'instant' }); }
      else { reader = null; render(); }
      replaceRoute();
    });
  }
  // Links inside a Markdown document resolve against its folder; only repository-relative text files open in the reader.
  function followLink(from, href) {
    const comment = /^#0*(\d+)\.(\d+)$/.exec(href);
    if (comment) return openTaskComment(String(Number(comment[1])).padStart(3, '0'), Number(comment[2]));
    const [target, anchor = ''] = href.split('#'); if (!target) return;
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
    const resolved = decodeURIComponent(new URL(target, 'file:///' + dir).pathname.replace(/^\/+/, ''));
    if (!resolved || resolved.includes('..')) return notice(t('notice.link_outside', { href }), true);
    // A link to an attachment is a file, not a source for the reader: open it (viewer or new tab).
    const attachment = new RegExp('^' + escapeRe(layout.tasks) + '/(\\d{3,})/([^/]+)$').exec(resolved);
    if (attachment) { const url = attachmentHref(attachment[1], attachment[2]); if (isImage(attachment[2])) openLightbox(url, attachment[2]); else window.open(url, '_blank', 'noopener'); return; }
    // A `…/TRACKFILE.md#task-NNN` mark is a link to a registry record, not to a file: open the task or
    // milestone page of the dashboard (its own route); Back returns to the document.
    if (resolved === layout.registry) {
      let m;
      if ((m = /^task-(\d+)$/.exec(anchor)) && doc.byId.has(m[1])) return openTaskPage(m[1]);
      if ((m = /^milestone-(M\d+)$/.exec(anchor)) && doc.byMilestone.has(m[1])) return openMilestone(m[1]);
    }
    openSource(resolved);
  }
  function renderSourcePage() {
    const nav = $('task-nav'); nav.replaceChildren();
    nav.append(button('← ' + t('nav.back'), closeSource, 'quiet'));
    const crumbs = el('div', 'task-crumbs');
    const crumb = r => r.commit ? r.commit.short : r.path.split('/').pop();
    for (const previous of reader.stack) crumbs.append(el('span', 'mono', crumb(previous)), el('span', '', '›'));
    crumbs.append(el('span', 'mono', reader.commit ? reader.commit.hash : reader.path)); nav.append(crumbs);
    const body = $('source-body'); body.replaceChildren();
    $('source-page').classList.toggle('commit', Boolean(reader.commit));
    if (reader.commit) { renderCommitPage(body, reader.commit); if (reader.task) { const chip = button('#' + reader.task, () => openTaskPage(reader.task), 'quiet mono'); chip.title = t('action.open_task'); const box = el('div', 'task-hits'); box.append(chip); nav.append(box); } return; }
    const language = Highlighter.languageFor(reader.path);
    const lineCount = reader.text.split('\n').length;
    body.append(el('p', 'source-meta', `${reader.path} · ${reader.markdown ? 'Markdown' : language ?? t('source.text')} · ${t('source.lines', { n: lineCount })}`));
    if (reader.markdown) body.append(MarkdownRenderer.render(reader.text, { linkHandler: href => followLink(reader.path, href), highlight }));
    else { const pre = el('pre', 'plain'), code = el('code'); Highlighter.renderCode(code, reader.text, language); pre.append(code); body.append(pre); }
    TaskMarks.linkComments(body, openTaskComment);
    if (reader.task) renderTaskHits(nav, body, reader.task);
    if (reader.changes && reader.changes.status !== 'clean') renderGitHits(nav, body, reader.changes);
  }
  // Highlighting of uncommitted changes (git diff HEAD) and "‹ ›" navigation between them.
  function renderGitHits(nav, body, changes) {
    const box = el('div', 'task-hits git-hits');
    const label = el('span', 'git-chip', changes.status === 'untracked' ? t('git.untracked') : t('git.uncommitted'));
    label.title = changes.status === 'untracked' ? t('git.untracked_hint') : t('git.uncommitted_hint');
    box.append(label);
    if (changes.status === 'untracked') { body.classList.add('git-untracked'); nav.append(box); return; }
    const hits = GitMarks.mark(body, DiffParser.parse(changes.patch)[0] ?? null);
    if (!hits.length) { box.append(el('span', 'hint', t('git.no_visible_changes'))); nav.append(box); return; }
    let current = -1;
    const counter = el('span', 'hint');
    const jump = index => {
      if (current >= 0) hits[current].classList.remove('git-hit-current');
      current = (index + hits.length) % hits.length;
      hits[current].classList.add('git-hit-current');
      hits[current].scrollIntoView({ block: 'center', behavior: 'smooth' });
      counter.textContent = `${current + 1} / ${hits.length}`;
    };
    box.append(button('‹', () => jump(current - 1), 'quiet'), counter, button('›', () => jump(current + 1), 'quiet'));
    nav.append(box);
    // Opened from a task page, the first scroll goes to the task mention; otherwise to the first change.
    if (!reader.task) requestAnimationFrame(() => jump(0)); else counter.textContent = `${hits.length}`;
  }
  // Commit page: header, registry tasks with this commit, file list and a unified diff per file.
  // Diff lines are highlighted by the same Highlighter line by line (like GitHub); content is textContent only.
  function linkTasks(container, text) {
    // `#NNN` in a commit message links to the task when the registry has it; the rest of the text stays as is.
    let last = 0;
    for (const m of text.matchAll(/#(\d{3,})\b/g)) {
      const task = doc.byId.get(m[1]);
      if (!task) continue;
      container.append(text.slice(last, m.index));
      const a = el('a', 'mono', m[0]); a.href = '#task/' + task.id; a.title = task.title; a.addEventListener('click', e => { e.preventDefault(); openTaskPage(task.id); });
      container.append(a); last = m.index + m[0].length;
    }
    container.append(text.slice(last));
  }
  function renderCommitPage(body, c) {
    const files = DiffParser.parse(c.patch);
    const stats = c.files.length ? c.files : files;
    const totalAdd = stats.reduce((n, f) => n + (f.additions ?? 0), 0), totalDel = stats.reduce((n, f) => n + (f.deletions ?? 0), 0);
    const head = el('header', 'commit-head');
    const subject = el('h2', 'commit-subject'); linkTasks(subject, c.subject); head.append(subject);
    if (c.body) { const pre = el('pre', 'commit-message'); linkTasks(pre, c.body); head.append(pre); }
    const meta = el('dl', 'commit-meta');
    const row = (key, value) => { const dd = el('dd'); if (value instanceof Node) dd.append(value); else dd.textContent = value; meta.append(el('dt', '', key), dd); };
    const hash = el('span', 'mono'); hash.append(c.hash, ' ', button(t('action.copy'), () => navigator.clipboard?.writeText(c.hash).then(() => notice(t('commit.hash_copied', { hash: c.short }))), 'quiet tiny'));
    row(t('commit.hash'), hash);
    row(t('commit.author'), `${c.author} <${c.email}>`);
    row(t('commit.date'), c.date ? new Date(c.date).toLocaleString(I18n.locale(), { dateStyle: 'long', timeStyle: 'short' }) : '—');
    if (c.parents.length) { const p = el('span', 'mono'); c.parents.forEach((parent, i) => { if (i) p.append(', '); const a = el('a', '', parent.slice(0, 10)); a.href = '#commit/' + parent; a.title = parent; a.addEventListener('click', e => { e.preventDefault(); openSource(commitKey(parent)); }); p.append(a); }); row(t('commit.parents', { n: c.parents.length }), p); }
    const linked = doc.tasks.filter(t => t.commit && (t.commit === c.hash || c.hash.startsWith(t.commit)));
    if (linked.length) { const p = el('span'); linked.forEach((task, i) => { if (i) p.append(', '); const a = el('a', 'mono', '#' + task.id); a.href = '#task/' + task.id; a.title = task.title; a.addEventListener('click', e => { e.preventDefault(); openTaskPage(task.id); }); p.append(a); }); row(t('commit.tasks'), p); }
    body.append(head, meta);
    const summary = el('p', 'source-meta');
    summary.append(t('commit.files_changed', { n: stats.length }) + ' · ', el('span', 'diff-add-count', '+' + totalAdd), ' ', el('span', 'diff-del-count', '−' + totalDel));
    if (c.truncated) summary.append(' · ', el('span', 'error-text', t('commit.truncated')));
    body.append(summary);
    // File index: a click scrolls to the file's diff.
    const list = el('ol', 'commit-files');
    const byPath = new Map(files.map(f => [f.path, f]));
    stats.forEach((f, index) => {
      const li = el('li'), a = el('a', 'mono', f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path); a.href = '#'; a.addEventListener('click', e => { e.preventDefault(); document.getElementById('diff-' + index)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
      const status = byPath.get(f.path)?.status ?? (f.binary ? 'binary' : 'modified');
      li.append(el('span', 'diff-status ' + status, statusLabel(status)), a, el('span', 'diff-counts'));
      li.lastChild.append(el('span', 'diff-add-count', f.binary ? t('diff.binary') : '+' + f.additions), ' ', el('span', 'diff-del-count', f.binary ? '' : '−' + f.deletions));
      list.append(li);
    });
    body.append(list);
    stats.forEach((f, index) => body.append(renderFileDiff(byPath.get(f.path) ?? { ...f, status: f.binary ? 'binary' : 'modified', hunks: [] }, index)));
  }
  const statusLabel = s => ({ added: 'A', deleted: 'D', renamed: 'R', copied: 'C', modified: 'M', binary: 'B' })[s] ?? 'M';
  function renderFileDiff(f, index) {
    const section = el('section', 'diff-file ' + f.status); section.id = 'diff-' + index;
    const header = el('div', 'diff-file-head');
    const title = el('span', 'mono diff-file-name'); title.append(el('span', 'diff-status ' + f.status, statusLabel(f.status)), f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path);
    header.append(title);
    const tools = el('span', 'diff-file-tools');
    if (!f.binary && f.hunks.length) tools.append(el('span', 'diff-add-count', '+' + f.additions), ' ', el('span', 'diff-del-count', '−' + f.deletions), ' ');
    // Open the current version of the file in the reader — if it still exists the server serves it, otherwise it reports an error.
    if (f.status !== 'deleted') tools.append(button(t('diff.open_file'), () => openSource(f.path), 'quiet tiny'));
    const fold = button(t('diff.fold'), () => { const hidden = section.classList.toggle('folded'); fold.textContent = hidden ? t('diff.unfold') : t('diff.fold'); }, 'quiet tiny');
    tools.append(fold); header.append(tools); section.append(header);
    if (f.binary) { section.append(el('p', 'hint diff-empty', t('diff.binary_hint'))); return section; }
    if (!f.hunks.length) { section.append(el('p', 'hint diff-empty', f.status === 'renamed' ? t('diff.rename_only') : t('diff.no_content'))); return section; }
    const language = Highlighter.languageFor(f.path);
    const table = el('table', 'diff-table'), tbody = el('tbody');
    for (const h of f.hunks) {
      const tr = el('tr', 'diff-hunk'), td = el('td'); td.colSpan = 3; td.textContent = h.header; tr.append(td); tbody.append(tr);
      for (const line of h.lines) {
        const row = el('tr', 'diff-line ' + line.type);
        row.append(el('td', 'diff-no', line.old ?? ''), el('td', 'diff-no', line.new ?? ''));
        const cell = el('td', 'diff-text');
        if (line.type === 'meta') cell.textContent = '\\ ' + line.text;
        else { cell.append(el('span', 'diff-sign', line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ')); for (const tok of Highlighter.tokenize(line.text, language)) { if (tok.cls) cell.append(el('span', 'tok-' + tok.cls, tok.text)); else cell.append(tok.text); } }
        row.append(cell); tbody.append(row);
      }
    }
    table.append(tbody); const wrap = el('div', 'diff-scroll'); wrap.append(table); section.append(wrap);
    return section;
  }
  // Highlighting of task mentions in an open source and "‹ ›" navigation between them.
  function renderTaskHits(nav, body, taskId) {
    const hits = TaskMarks.mark(body, taskId);
    const box = el('div', 'task-hits');
    const chip = button('#' + taskId, () => openTaskPage(taskId), 'quiet mono');
    chip.title = t('action.open_task');
    box.append(chip);
    if (!hits.length) { box.append(el('span', 'hint', t('source.no_mentions'))); nav.append(box); return; }
    let current = -1;
    const counter = el('span', 'hint');
    const jump = index => {
      if (current >= 0) hits[current].classList.remove('task-hit-current');
      current = (index + hits.length) % hits.length;
      hits[current].classList.add('task-hit-current');
      hits[current].scrollIntoView({ block: 'center', behavior: 'smooth' });
      counter.textContent = `${current + 1} / ${hits.length}`;
    };
    box.append(button('‹', () => jump(current - 1), 'quiet'), counter, button('›', () => jump(current + 1), 'quiet'));
    nav.append(box);
    // render() scrolls the page to the top — move to the first hit on the next frame.
    requestAnimationFrame(() => jump(0));
  }
  // Milestone page: description, progress and the tree of its tasks; the tree filters are untouched.
  function renderMilestonePage(m) {
    const nav = $('task-nav'); nav.replaceChildren();
    nav.append(button('← ' + t('nav.back'), () => goBack(() => go('dashboard')), 'quiet'));
    const crumbs = el('div', 'task-crumbs'); crumbs.append(button(t('page.dashboard'), () => go('dashboard'), 'quiet'), el('span', '', '›'), el('span', 'mono', m.id)); nav.append(crumbs);
    const page = $('milestone-page'); page.replaceChildren();
    const p = M.progress(doc, m.id);
    const card = el('div', 'milestone-card priority-' + M.priorityOf(m));
    const summary = el('div', 'milestone-summary');
    const priority = el('span', 'priority-badge ' + M.priorityOf(m)); priority.append(priorityDot(m), t('priority.label', { value: t('priority.' + M.priorityOf(m)) }));
    card.append(priority);
    const bar = el('progress'); bar.max = 100; bar.value = p.percent;
    summary.append(bar, el('span', 'milestone-count', p.total ? t('milestone.leaf_count', { done: p.done, total: p.total }) : t('milestone.no_active')), el('strong', 'milestone-percent', p.total ? p.percent + '%' : '—'), el('span', 'milestone-state', milestoneState(p)));
    card.append(summary, m.body ? richText('description', m.body) : el('div', 'description', t('task.no_description')));
    const actions = el('div', 'detail-actions');
    actions.append(button('＋ ' + t('milestone.add_task'), () => openAddToMilestone(m.id), 'primary'), button('✎ ' + t('action.edit'), () => openMilestoneEditor(m.id)), button(isPinned('pinnedMilestones', m.id) ? '★ ' + t('action.unpin') : '☆ ' + t('action.pin'), () => togglePin('pinnedMilestones', m.id), 'quiet'));
    card.append(actions); page.append(card);
    const filters = el('div', 'filters milestone-filters');
    const statusFilter = el('details', 'status-filter');
    const statusSummary = el('summary'), statusOptions = el('div', 'status-options'); statusFilter.append(statusSummary, statusOptions);
    renderStatusPicker(statusSummary, statusOptions, config.milestoneStatuses, selected => {
      config.milestoneStatuses = selected; renderMilestonePage(m); page.querySelector('.status-filter').open = true; saveConfig();
    });
    const sortLabel = el('label'); sortLabel.append(el('span', 'sr-only', t('sort.label')));
    const sort = el('select'); options(sort, [['id', t('sort.id')], ['updated', t('sort.updated')]], config.milestoneSort);
    sort.addEventListener('change', () => { config.milestoneSort = sort.value; renderMilestonePage(m); saveConfig(); });
    sortLabel.append(sort); filters.append(statusFilter, sortLabel); page.append(filters);
    // Every task with this effective milestone; with a filter the parents of matches are kept for context.
    const members = doc.tasks.filter(task => M.milestoneOf(doc, task) === m.id);
    const ids = new Set(members.map(task => task.id));
    const matches = new Set(members.filter(task => !config.milestoneStatuses.length || config.milestoneStatuses.includes(task.status)).map(task => task.id));
    const visible = new Set(matches);
    for (const id of matches) { let parent = doc.byId.get(id)?.parent; while (ids.has(parent)) { visible.add(parent); parent = doc.byId.get(parent)?.parent; } }
    const children = new Map();
    for (const task of members.filter(task => visible.has(task.id))) { const key = ids.has(task.parent) && visible.has(task.parent) ? task.parent : null; if (!children.has(key)) children.set(key, []); children.get(key).push(task); }
    for (const list of children.values()) list.sort(taskOrder(config.milestoneSort));
    // As in the tree: single click selects into the card on the right, double click opens the page; nodes with
    // subtasks fold with the arrow or with Collapse/Expand all (with a status filter everything is expanded
    // because parents are shown for context).
    const filtering = config.milestoneStatuses.length > 0;
    const collapsed = new Set(config.milestoneCollapsed);
    const withKids = [...children.keys()].filter(Boolean);
    const rerender = () => { renderMilestonePage(m); saveConfig(); };
    const node = task => {
      const group = el('div', 'tree-node');
      const row = el('div', 'tree-row' + (config.selected === task.id ? ' selected' : '') + (flashTask === task.id ? ' flash' : '')); row.dataset.task = task.id;
      const kids = children.get(task.id) ?? [];
      const expanded = filtering || !collapsed.has(task.id);
      const expander = button(kids.length ? (expanded ? '⌄' : '›') : '·', () => {
        config.milestoneCollapsed = expanded ? [...config.milestoneCollapsed, task.id] : config.milestoneCollapsed.filter(id => id !== task.id);
        rerender();
      }, 'expander');
      expander.disabled = !kids.length || filtering; expander.setAttribute('aria-label', t(expanded ? 'tree.collapse_node' : 'tree.expand_node', { title: task.title }));
      if (kids.length) expander.setAttribute('aria-expanded', String(expanded));
      const pick = clickable(button('', () => selectTask(task.id, 'milestone'), 'tree-select'), task.id);
      pick.append(el('span', 'mono', '#' + task.id + (task.kind === 'feature' ? ' · ' + t('kind.feature_tag') : '')), el('span', '', task.title + (task.milestone ? '' : ' · ' + t('milestone.inherits'))));
      row.append(expander, pick, ...badges(task)); group.append(row);
      if (expanded && kids.length) { const branch = el('div', 'tree-children'); branch.append(...kids.map(node)); group.append(branch); }
      return group;
    };
    const tools = el('div', 'tree-actions milestone-tree-actions'), toolRow = el('div');
    const expandAll = button(t('tree.expand_all'), () => { config.milestoneCollapsed = config.milestoneCollapsed.filter(id => !ids.has(id)); rerender(); }, 'quiet');
    const collapseAll = button(t('tree.collapse_all'), () => { config.milestoneCollapsed = [...new Set([...config.milestoneCollapsed, ...withKids])]; rerender(); }, 'quiet');
    expandAll.disabled = collapseAll.disabled = filtering || !withKids.length;
    toolRow.append(expandAll, collapseAll); tools.append(toolRow); page.append(tools);
    const layoutBox = el('div', 'tree-layout milestone-layout');
    const tree = el('div', 'milestone-tree tree-panel');
    tree.append(el('p', 'hint tree-hint', t('tree.hint')));
    const header = el('div', 'tree-header'); header.append(el('span', '', t('tree.header')), el('span', '', config.milestoneStatuses.length ? t('tree.matches_of', { n: matches.size, total: members.length }) : t('tree.records', { n: members.length }))); tree.append(header);
    const roots = children.get(null) ?? [];
    if (roots.length) tree.append(...roots.map(node)); else tree.append(el('div', 'empty', config.milestoneStatuses.length ? t('milestone.empty_filtered') : t('milestone.empty')));
    const detail = el('aside', 'detail milestone-detail');
    renderDetail(detail, ids.has(config.selected) ? doc.byId.get(config.selected) : null);
    layoutBox.append(tree, detail); page.append(layoutBox);
  }
  // "Add task to milestone" dialog: one existing task, subtasks only by checkbox.
  let adding = null; // { milestone, picked }
  function openAddToMilestone(milestoneId) {
    if (!store) return;
    adding = { milestone: milestoneId, picked: null };
    $('milestone-add-heading').textContent = t('milestone.add_to', { id: milestoneId });
    $('milestone-add-context').textContent = doc.byMilestone.get(milestoneId).title;
    $('milestone-add-filter').value = ''; $('milestone-add-subtasks').checked = false; $('milestone-add-error').textContent = '';
    renderAddToMilestone(); $('milestone-add').showModal(); $('milestone-add-filter').focus();
  }
  const descendantsOf = id => doc.tasks.filter(task => { let p = task.parent; while (p) { if (p === id) return true; p = doc.byId.get(p)?.parent; } return false; });
  function renderAddToMilestone() {
    if (!adding) return;
    const term = $('milestone-add-filter').value.toLocaleLowerCase().trim().replace(/^#/, '');
    const rows = doc.tasks.filter(task => M.milestoneOf(doc, task) !== adding.milestone && (!term || `${task.id} ${task.title}`.toLocaleLowerCase().includes(term))).map(task => {
      const label = el('label', adding.picked === task.id ? 'picked' : '');
      const radio = el('input'); radio.type = 'radio'; radio.name = 'milestone-add-task'; radio.value = task.id; radio.checked = adding.picked === task.id;
      radio.addEventListener('change', () => { adding.picked = task.id; renderAddToMilestone(); });
      const effective = M.milestoneOf(doc, task);
      label.append(radio, el('span', 'mono', '#' + task.id), el('span', '', task.title), el('span', 'where', effective ? (task.milestone ? t('where.now', { id: effective }) : t('where.inherits', { id: effective })) : t('where.no_milestone')));
      return label;
    });
    if (rows.length) $('milestone-add-tasks').replaceChildren(...rows);
    else {
      const empty = el('div', 'empty', t('picker.nothing'));
      const contents = [empty];
      // The search text becomes the title of a new task and the current milestone is passed to the editor.
      if (term) contents.push(button('＋ ' + t('picker.create_task'), () => {
        const { milestone } = adding;
        const title = $('milestone-add-filter').value.trim();
        closeAddToMilestone();
        openEditor(null, null, { milestone, title });
      }, 'create-task-row'));
      $('milestone-add-tasks').replaceChildren(...contents);
    }
    const kids = adding.picked ? descendantsOf(adding.picked) : [];
    $('milestone-add-subtasks-label').textContent = adding.picked ? t('milestone.with_subtasks_n', { n: kids.length }) : t('milestone.with_subtasks');
    $('milestone-add-subtasks').disabled = !kids.length;
    $('save-milestone-add').disabled = !adding.picked;
  }
  async function saveAddToMilestone(event) {
    event.preventDefault(); if (!adding?.picked || saving) return;
    const { milestone, picked } = adding, withSubtasks = $('milestone-add-subtasks').checked;
    const ok = await mutateProject(current => M.addToMilestone(current, picked, milestone, { withSubtasks }), t(withSubtasks ? 'notice.added_to_milestone_subtasks' : 'notice.added_to_milestone', { id: picked, milestone }));
    if (ok) { adding = null; $('milestone-add').close(); }
  }
  function closeAddToMilestone() { adding = null; $('milestone-add').close(); }
  // "＋ Subtask" offers an existing task as well as creating a new one: the list excludes the task itself,
  // its descendants (cycle) and its direct children; creating goes to the editor with the parent preselected.
  let subtask = null; // { parent, picked }
  function openAddSubtask(parentId) {
    if (!store) return;
    subtask = { parent: parentId, picked: null };
    const parent = doc.byId.get(parentId);
    $('subtask-add-heading').textContent = t('subtask.heading', { id: parentId });
    $('subtask-add-context').textContent = parent.title;
    $('subtask-add-filter').value = ''; $('subtask-add-error').textContent = '';
    renderAddSubtask(); $('subtask-add').showModal(); $('subtask-add-filter').focus();
  }
  function renderAddSubtask() {
    if (!subtask) return;
    const term = $('subtask-add-filter').value.toLocaleLowerCase().trim().replace(/^#/, '');
    const banned = new Set([subtask.parent, ...descendantsOf(subtask.parent).map(d => d.id)]);
    const rows = doc.tasks.filter(task => !banned.has(task.id) && task.parent !== subtask.parent && (!term || `${task.id} ${task.title}`.toLocaleLowerCase().includes(term))).map(task => {
      const label = el('label', subtask.picked === task.id ? 'picked' : '');
      const radio = el('input'); radio.type = 'radio'; radio.name = 'subtask-add-task'; radio.value = task.id; radio.checked = subtask.picked === task.id;
      radio.addEventListener('change', () => { subtask.picked = task.id; renderAddSubtask(); });
      label.append(radio, el('span', 'mono', '#' + task.id), el('span', '', task.title), el('span', 'where', task.parent ? t('where.under', { id: task.parent }) : t('where.root')));
      return label;
    });
    const create = button('＋ ' + t('picker.create_subtask'), () => {
      const { parent } = subtask, title = $('subtask-add-filter').value.trim();
      closeAddSubtask(); openEditor(null, parent, { title });
    }, 'create-task-row');
    $('subtask-add-tasks').replaceChildren(...(rows.length ? rows : [el('div', 'empty', t('picker.nothing'))]), create);
    const picked = subtask.picked ? doc.byId.get(subtask.picked) : null;
    $('subtask-add-warning').textContent = picked?.parent ? t('subtask.reparent_warning', { id: picked.id, from: picked.parent, to: subtask.parent }) : '';
    $('save-subtask-add').disabled = !picked;
  }
  async function saveAddSubtask(event) {
    event.preventDefault(); if (!subtask?.picked || saving) return;
    const { parent, picked } = subtask, task = doc.byId.get(picked);
    // Re-parenting a task already nested under another one requires explicit confirmation.
    if (task.parent && task.parent !== parent && !confirm(t('subtask.reparent_confirm', { id: picked, from: task.parent, to: parent }))) return;
    const from = M.milestoneOf(doc, task), to = task.milestone ? from : M.milestoneOf(doc, doc.byId.get(parent));
    const note = from !== to ? ' ' + t('notice.milestone_now_inherited', { id: to ?? t('meta.none') }) : '';
    const ok = await mutateProject(current => M.setParent(current, picked, parent), t('notice.reparented', { id: picked, parent }) + note);
    if (ok) closeAddSubtask();
  }
  function closeAddSubtask() { subtask = null; $('subtask-add').close(); }
  function renderTaskPage(task) {
    const target = $('task-page'); target.replaceChildren();
    const parts = taskParts(task);
    const main = el('div', 'task-main'), side = el('div', 'task-side');
    const nav = $('task-nav'); nav.replaceChildren();
    nav.append(button('← ' + t('nav.back'), () => goBack(() => selectTask(task.id, 'tree')), 'quiet'));
    const crumbs = el('div', 'task-crumbs');
    const chain = []; let p = doc.byId.get(task.parent); while (p) { chain.unshift(p); p = doc.byId.get(p.parent); }
    for (const ancestor of chain) { crumbs.append(button(`#${ancestor.id} ${ancestor.title}`, () => openTaskPage(ancestor.id), 'quiet'), el('span', '', '›')); }
    crumbs.append(el('span', 'mono', '#' + task.id));
    nav.append(crumbs);
    const top = el('div', 'detail-title'); top.append(copyControl('#' + task.id), el('span', 'kind-label', task.kind === 'feature' ? 'FEATURE' : 'TASK'), ...badges(task));
    main.append(top, el('h2', '', task.title), el('h3', '', t('task.description')), parts.description);
    main.append(parts.attachments(false));
    if (parts.result) main.append(el('h3', '', t('task.result')), parts.result);
    if (parts.sources) main.append(el('h3', '', t('task.sources')), parts.sources);
    if (parts.children.length) {
      main.append(el('h3', '', t('task.subtasks')));
      if (parts.progress) main.append(parts.progress);
      const list = el('div', 'subtasks');
      for (const c of parts.children) {
        const row = el('div', 'tree-row'); row.dataset.task = c.id;
        const pick = button('', () => openTaskPage(c.id), 'tree-select');
        pick.append(el('span', 'mono', '#' + c.id + (c.kind === 'feature' ? ' · ' + t('kind.feature_tag') : '')), el('span', '', c.title));
        row.append(el('span', 'expander', ''), pick, ...badges(c)); list.append(row);
      }
      main.append(list);
    }
    const comments = el('section', 'comments');
    const commentsHead = el('div', 'comments-heading'); commentsHead.append(el('h3', '', `${t('comments.heading')} · ${task.comments.length}`), button('＋ ' + t('comments.add'), () => openCommentEditor(task.id), 'quiet'));
    comments.append(commentsHead);
    if (!task.comments.length) comments.append(el('p', 'hint', t('comments.none')));
    for (const comment of task.comments) {
      const card = el('article', 'comment'); card.id = `comment-${comment.id}`; card.dataset.comment = String(comment.id);
      const reference = `#${Number(task.id)}.${comment.id}`;
      const done = el('label', 'comment-done'); const doneBox = el('input'); doneBox.type = 'checkbox'; doneBox.checked = comment.done;
      doneBox.addEventListener('change', async () => {
        const requested = doneBox.checked;
        const saved = await mutateProject(current => M.setCommentDone(current, task.id, comment.id, requested), t(requested ? 'notice.comment_done' : 'notice.comment_reopened', { ref: reference }));
        if (!saved) doneBox.checked = !requested;
      });
      done.append(doneBox, el('span', '', comment.done ? '[x] ' + t('comments.done') : '[ ] ' + t('comments.open')));
      const actions = el('div', 'comment-actions');
      actions.append(button(t('action.edit'), () => openCommentEditor(task.id, comment.id), 'quiet'), button(t('action.delete'), async () => {
        // Destructive action runs only after the user's explicit browser confirmation.
        if (!confirm(t('comments.confirm_delete', { ref: reference }))) return;
        await mutateProject(
          current => M.deleteComment(current, task.id, comment.id),
          t('notice.comment_deleted', { ref: reference }),
          { operation: 'delete comment', taskId: task.id }
        );
      }, 'quiet danger-action'));
      const head = el('header'); head.append(copyControl(reference), done, el('span', '', comment.author), el('time', '', date(comment.updated_at)), actions);
      card.append(head, richText('comment-text', comment.text)); comments.append(card);
    }
    main.append(comments);
    side.append(parts.meta);
    if (parts.lock) side.append(parts.lock);
    $('page-actions').replaceChildren(...parts.actions.childNodes);
    main.dataset.task = task.id; side.dataset.task = task.id;
    target.append(main, side);
    if (commentTarget) requestAnimationFrame(() => {
      const comment = document.getElementById('comment-' + commentTarget);
      if (comment) { comment.classList.add('comment-target'); comment.scrollIntoView({ block: 'center' }); }
      commentTarget = null;
    });
  }
  function openCommentEditor(taskId, commentId = null) {
    const task = doc.byId.get(taskId), comment = commentId ? task?.comments.find(item => item.id === commentId) : null;
    if (!task || (commentId && !comment)) return;
    commentEditing = { taskId, commentId };
    $('comment-heading').textContent = comment ? t('comments.editing', { ref: `#${Number(taskId)}.${comment.id}` }) : t('comments.new_for', { id: Number(taskId) });
    $('comment-context').textContent = task.title; $('comment-body').value = comment?.text ?? ''; $('comment-error').textContent = '';
    mdEditors['comment-body'].write(); $('comment-editor').showModal(); $('comment-body').focus();
  }
  function closeCommentEditor() { commentEditing = null; $('comment-editor').close(); }
  async function saveComment(event) {
    event.preventDefault(); if (!commentEditing || saving) return;
    const { taskId, commentId } = commentEditing, text = $('comment-body').value;
    const ok = await mutateProject(
      current => commentId ? M.editComment(current, taskId, commentId, text) : M.addComment(current, taskId, text),
      commentId ? t('notice.comment_updated', { ref: `#${Number(taskId)}.${commentId}` }) : t('notice.comment_added', { id: Number(taskId) }),
      { operation: commentId ? 'edit comment' : 'commented', taskId }
    );
    if (ok) { commentEditing = null; $('comment-editor').close(); openTaskComment(taskId, commentId ?? doc.byId.get(taskId).comments.length); }
    else $('comment-error').textContent = t('comments.not_saved');
  }
  function openMilestoneEditor(id = null) {
    if (!doc || saving) return;
    const m = doc.byMilestone.get(id);
    editing = { kind: 'milestone', id, baseline, original: null, picked: new Set(doc.tasks.filter(task => id && task.milestone === id).map(task => task.id)) };
    $('milestone-heading').textContent = m ? t('milestone.editing', { id: m.id }) : t('milestone.new');
    $('milestone-context').textContent = m ? t('milestone.edit_hint') : t('milestone.new_hint');
    $('milestone-title').value = m?.title ?? ''; $('milestone-body').value = m?.body ?? ''; $('milestone-filter').value = ''; $('milestone-only-picked').checked = false;
    $('milestone-priority').value = m ? M.priorityOf(m) : 'normal';
    renderMilestoneTasks();
    $('milestone-error').textContent = ''; editing.original = formState(); mdEditors['milestone-body'].write(); $('milestone-editor').showModal(); $('milestone-title').focus();
  }
  function renderMilestoneTasks() {
    const { id, picked } = editing, term = $('milestone-filter').value.toLocaleLowerCase().trim().replace(/^#/, '');
    // "Only selected" shows the explicitly ticked tasks and those inheriting the milestone (ticked too, disabled).
    const onlyPicked = $('milestone-only-picked').checked;
    const rows = doc.tasks.filter(task => !M.excluded(doc, task) && (!term || `${task.id} ${task.title}`.toLocaleLowerCase().includes(term)) && (!onlyPicked || picked.has(task.id) || (!task.milestone && !!id && M.milestoneOf(doc, task) === id))).map(task => {
      const effective = M.milestoneOf(doc, task);
      const inherited = !task.milestone && !!id && effective === id;
      const label = el('label', inherited ? 'inherited' : '');
      const box = el('input'); box.type = 'checkbox'; box.value = task.id; box.checked = inherited || picked.has(task.id); box.disabled = inherited;
      box.addEventListener('change', () => { box.checked ? picked.add(task.id) : picked.delete(task.id); $('milestone-picked').textContent = t('picker.selected', { n: picked.size }); });
      const where = inherited ? t('where.inherits_from', { id: task.parent }) : task.milestone && task.milestone !== id ? t('where.now', { id: task.milestone }) : !task.milestone && effective && effective !== id ? t('where.inherits', { id: effective }) : '';
      label.append(box, el('span', 'mono', '#' + task.id), el('span', '', task.title), el('span', 'where', where));
      return label;
    });
    $('milestone-tasks').replaceChildren(...(rows.length ? rows : [el('div', 'empty', onlyPicked && !term ? t('picker.none_selected') : t('picker.nothing'))]));
    $('milestone-picked').textContent = t('picker.selected', { n: picked.size });
  }
  async function saveMilestone(event) {
    event.preventDefault(); if (!editing || saving) return;
    saving = true; $('save-milestone').disabled = true;
    try {
      const files = await store.readAll();
      if (!sameFiles(files, editing.baseline)) throw Object.assign(new Error(), { code: 'registry_changed_form' });
      let current = M.parse(files), id = editing.id, changes = {};
      const step = c => { changes = { ...changes, ...c }; current = M.apply(current, c); };
      // priority is written only when it changed, so old records without the field are not rewritten for nothing.
      const priority = $('milestone-priority').value, m = current.byMilestone.get(id);
      if (id) step(M.editMilestone(current, id, $('milestone-title').value, $('milestone-body').value, priority !== M.priorityOf(m) ? { priority } : {}));
      else { const added = M.addMilestone(current, { title: $('milestone-title').value, body: $('milestone-body').value, priority }); step(added.changes); id = added.id; }
      const picked = editing.picked;
      const assign = doc.tasks.filter(task => picked.has(task.id) && task.milestone !== id).map(task => task.id);
      const release = doc.tasks.filter(task => !picked.has(task.id) && task.milestone === id).map(task => task.id);
      if (assign.length) step(M.setMilestone(current, assign, id));
      if (release.length) step(M.setMilestone(current, release, null));
      await writeChanges(changes, files);
      baseline = current.files; doc = current; config = M.cleanConfig(config, doc); editing = null; $('milestone-editor').close();
      render(); saveConfig(); notice(t('notice.milestone_saved', { id }));
    } catch (error) { $('milestone-error').textContent = errorText(error); }
    finally { saving = false; $('save-milestone').disabled = false; }
  }
  function openEditor(id = null, parent = null, preset = {}) {
    if (!doc || saving) return;
    const task = doc.byId.get(id);
    editing = { kind: 'task', id, baseline, original: null, pending: [] };
    $('editor-heading').textContent = task ? t('task.editing', { id: task.id }) : t('task.new_heading');
    $('editor-context').textContent = task ? t('task.edit_hint') : t('task.new_hint');
    $('edit-title').value = task?.title ?? preset.title ?? ''; $('edit-body').value = task?.body ?? '';
    // The parent can be changed while editing too; the task itself and its descendants are excluded (cycle).
    const banned = task ? new Set([task.id, ...descendantsOf(task.id).map(d => d.id)]) : new Set();
    options($('edit-parent'), [['', t('task.no_parent')], ...doc.tasks.filter(x => !M.excluded(doc, x) && !x.archived && !banned.has(x.id)).map(x => [x.id, `#${x.id} ${x.title}`])], task?.parent ?? parent ?? '');
    renderEditorMilestones(task?.milestone ?? preset.milestone ?? '');
    // Editing an existing task shows its files with "Insert into description" (Markdown at the caret);
    // a new task has no number yet, so its files are attached after saving.
    const filesBox = $('edit-files'); filesBox.replaceChildren();
    if (task) filesBox.append(attachmentsSection(task, { compact: true, insert: f => insertIntoBody(attachmentMarkdown(task.id, f)) }));
    else filesBox.append(pendingSection());
    $('editor-error').textContent = ''; editing.original = formState(); mdEditors['edit-body'].write(); $('editor').showModal(); $('edit-title').focus();
  }
  // A new task has no number yet — files are held in the form's memory and uploaded after the record is saved.
  // Markdown is inserted right away with the expected number (next_task); if the number turns out different
  // on save (the registry changed), saveTask rewrites the paths in the description.
  const prospectiveId = () => String(doc.meta.next_task).padStart(3, '0');
  function pendingSection() {
    const box = el('section', 'attachments compact pending');
    const head = el('div', 'attachments-heading'); const title = el('h3', '', t('files.heading'));
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true;
    const add = button('＋ ' + t('files.attach_short'), () => input.click(), 'quiet'); add.append(input);
    input.addEventListener('change', async () => {
      const files = [...input.files]; input.value = ''; add.disabled = true;
      for (const file of files) { try { const item = await prepareAttachment(file); item.url = URL.createObjectURL(item.blob); editing.pending.push(item); } catch (error) { $('editor-error').textContent = `${file.name}: ${errorText(error)}`; } }
      add.disabled = false; paint();
      for (const item of editing.pending.slice(-files.length)) insertIntoBody(attachmentMarkdown(prospectiveId(), item));
    });
    head.append(title, add);
    const list = el('ul', 'attachment-list'); box.append(head, list);
    const paint = () => {
      const items = editing?.pending ?? [];
      title.textContent = `${t('files.heading')} · ${items.length}`;
      list.replaceChildren(...items.map(item => {
        const li = el('li', 'attachment');
        const name = el('span', 'attachment-link');
        if (item.image) { const img = el('img', 'attachment-thumb'); img.src = item.url; img.alt = item.name; name.append(img); }
        else name.append(el('span', 'attachment-icon', item.name.includes('.') ? item.name.split('.').pop().slice(0, 5).toUpperCase() : 'FILE'));
        name.append(el('span', 'attachment-name', item.name));
        const meta = el('span', 'attachment-meta', fileSize(item.size) + (item.from ? ' ' + t('files.was', { size: fileSize(item.from) }) : ''));
        const actions = el('span', 'attachment-actions');
        actions.append(button(t('files.insert'), () => insertIntoBody(attachmentMarkdown(prospectiveId(), item)), 'quiet tiny'));
        actions.append(button(t('action.remove'), () => { editing.pending.splice(editing.pending.indexOf(item), 1); URL.revokeObjectURL(item.url); paint(); }, 'quiet tiny danger-action'));
        li.append(name, meta, actions); return li;
      }));
      if (!items.length) list.append(el('li', 'hint attachment-empty', t('files.pending_hint', { dir: attachmentPath(prospectiveId(), '') })));
    };
    paint();
    return box;
  }
  function insertIntoBody(snippet) {
    const area = $('edit-body'); mdEditors['edit-body'].write();
    const start = area.selectionStart ?? area.value.length, end = area.selectionEnd ?? start, before = area.value.slice(0, start), after = area.value.slice(end);
    const text = (before && !before.endsWith('\n') ? '\n' : '') + snippet + (after && !after.startsWith('\n') ? '\n' : '');
    area.value = before + text + after; const caret = before.length + text.length; area.setSelectionRange(caret, caret); area.focus();
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // The "Same as parent (Mxx)" label is recomputed when the parent changes in the form.
  function renderEditorMilestones(selected = $('edit-milestone').value) {
    const effectiveParent = $('edit-parent').value || null;
    const inherited = effectiveParent ? M.milestoneOf(doc, doc.byId.get(effectiveParent)) : null;
    options($('edit-milestone'), [['', inherited ? t('task.milestone_as_parent', { id: inherited }) : effectiveParent ? t('task.milestone_as_parent', { id: t('meta.none') }) : t('task.no_milestone')], ...doc.milestones.map(m => [m.id, `${m.id} · ${m.title}`])], selected);
  }
  function formState() {
    if (editing?.kind === 'milestone') return JSON.stringify([$('milestone-title').value, $('milestone-priority').value, $('milestone-body').value, [...editing.picked ?? []].sort()]);
    return JSON.stringify([...['edit-title', 'edit-body', 'edit-parent', 'edit-milestone'].map(id => $(id).value), (editing?.pending ?? []).map(p => p.name)]);
  }
  function closeEditor() {
    if (saving) return;
    if (editing && editing.original !== formState() && !confirm(t('editor.discard_confirm'))) return;
    const dialog = editing?.kind === 'milestone' ? 'milestone-editor' : 'editor';
    editing?.pending?.forEach(item => URL.revokeObjectURL(item.url));
    editing = null; $(dialog).close();
  }
  async function saveTask(event) {
    event.preventDefault(); if (!editing || saving) return;
    saving = true; $('save-task').disabled = true;
    try {
      const files = await store.readAll();
      if (!sameFiles(files, editing.baseline)) throw Object.assign(new Error(), { code: 'registry_changed_form' });
      const current = M.parse(files);
      let changes, id = editing.id;
      const operation = id ? 'edit task' : 'new task';
      if (id) changes = M.editTask(current, id, $('edit-title').value, $('edit-body').value, undefined, { milestone: $('edit-milestone').value || null, parent: $('edit-parent').value || null });
      else {
        // The number in already inserted attachment paths is adjusted to the actual next_task of the fresh file.
        const actual = String(current.meta.next_task).padStart(3, '0'), guessed = prospectiveId();
        const body = actual === guessed ? $('edit-body').value : $('edit-body').value.split(attachmentPath(guessed, '')).join(attachmentPath(actual, ''));
        const added = M.addTask(current, { title: $('edit-title').value, body, parent: $('edit-parent').value || null, milestone: $('edit-milestone').value || null }); changes = added.changes; id = added.id;
      }
      await writeChanges(changes, files);
      const pending = editing.pending;
      doc = M.apply(current, changes); baseline = doc.files; editing = null; $('editor').close();

      // A task created or edited from a milestone page and still in it is shown there (selected in the card)
      // instead of jumping to the tree; a foreign milestone still goes to the tree.
      if (config.view === 'milestone' && M.milestoneOf(doc, doc.byId.get(id)) === config.selectedMilestone) selectTask(id, 'milestone');
      else jumpTask(id, config.view === 'task' ? 'task' : 'tree');
      const message = t('notice.task_saved', { id });
      // The commit operation is fixed before the editor is reset, to tell creation from editing.
      try {
        const committed = await store.recordChange(operation, id, doc.byId.get(id).title, Object.keys(changes));
        notice(`${message} ${t('notice.committed', { hash: committed.hash.slice(0, 10) })}`);
      } catch (error) { notice(`${message} ${errorText(error)}`, true); }
      // Files of a new task go after the record and its commit — each gets its own `[attach file]` commit.
      if (pending.length) { await uploadAttachments(doc.byId.get(id), pending); pending.forEach(item => URL.revokeObjectURL(item.url)); render(); }
    } catch (error) { $('editor-error').textContent = errorText(error); }
    finally { saving = false; $('save-task').disabled = false; }
  }
  $('reload').addEventListener('click', reload);
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
  $('new-task').addEventListener('click', () => openEditor(null, null, config.view === 'milestone' ? { milestone: config.selectedMilestone } : {}));
  $('sidebar-toggle').addEventListener('click', () => { config.sidebarCollapsed = !config.sidebarCollapsed; applySidebar(); saveConfig(); });
  for (const id of ['theme', 'theme-mobile']) $(id).addEventListener('click', () => { config.theme = config.theme === 'dark' ? 'light' : 'dark'; render(); saveConfig(); });
  // The language toggle stores an explicit choice; static strings are re-applied and dynamic ones re-rendered.
  $('lang').addEventListener('click', () => { config.lang = I18n.language === 'ru' ? 'en' : 'ru'; applyLanguage(); notice(''); render(); saveConfig(); });
  $('search').addEventListener('input', () => { config.search = $('search').value; renderTree(); saveConfig(); });
  for (const field of ['milestone', 'sort']) $(field).addEventListener('change', () => { config[field] = $(field).value; renderTree(); saveConfig(); });
  $('show-archive').addEventListener('change', () => { config.showArchive = $('show-archive').checked; renderTree(); saveConfig(); });
  $('hide-done-dashboard').addEventListener('change', () => { config.hideDone = $('hide-done-dashboard').checked; render(); saveConfig(); });
  $('expand').addEventListener('click', () => { config.expanded = doc.tasks.map(task => task.id); renderTree(); saveConfig(); });
  $('collapse').addEventListener('click', () => { config.expanded = []; renderTree(); saveConfig(); });
  $('clear-filters').addEventListener('click', () => { config.search = ''; config.statuses = []; config.milestone = 'all'; render(); saveConfig(); });
  $('close-editor').addEventListener('click', closeEditor); $('cancel-editor').addEventListener('click', closeEditor);
  $('editor').addEventListener('cancel', e => { e.preventDefault(); closeEditor(); });
  $('task-form').addEventListener('submit', saveTask);
  $('edit-parent').addEventListener('change', () => renderEditorMilestones());
  $('new-milestone').addEventListener('click', () => openMilestoneEditor());
  $('close-milestone').addEventListener('click', closeEditor); $('cancel-milestone').addEventListener('click', closeEditor);
  $('milestone-editor').addEventListener('cancel', e => { e.preventDefault(); closeEditor(); });
  $('milestone-filter').addEventListener('input', renderMilestoneTasks);
  $('milestone-only-picked').addEventListener('change', renderMilestoneTasks);
  $('milestone-form').addEventListener('submit', saveMilestone);
  $('milestone-add-form').addEventListener('submit', saveAddToMilestone);
  $('milestone-add-filter').addEventListener('input', renderAddToMilestone);
  $('milestone-add-subtasks').addEventListener('change', renderAddToMilestone);
  $('close-milestone-add').addEventListener('click', closeAddToMilestone); $('cancel-milestone-add').addEventListener('click', closeAddToMilestone);
  $('milestone-add').addEventListener('cancel', e => { e.preventDefault(); closeAddToMilestone(); });
  $('subtask-add-form').addEventListener('submit', saveAddSubtask);
  $('subtask-add-filter').addEventListener('input', renderAddSubtask);
  $('close-subtask-add').addEventListener('click', closeAddSubtask); $('cancel-subtask-add').addEventListener('click', closeAddSubtask);
  $('subtask-add').addEventListener('cancel', e => { e.preventDefault(); closeAddSubtask(); });
  $('comment-form').addEventListener('submit', saveComment);
  $('close-comment').addEventListener('click', closeCommentEditor); $('cancel-comment').addEventListener('click', closeCommentEditor);
  $('comment-editor').addEventListener('cancel', e => { e.preventDefault(); closeCommentEditor(); });
  window.addEventListener('beforeunload', e => { if (saving || pendingConfig || configWrites || (editing && editing.original !== formState())) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushConfig(); });
  // The registry is re-read every 2.5 s while the tab is visible and no form is open.
  setInterval(async () => {
    if (!store || document.hidden || editing || saving || polling || loading) return;
    polling = true;
    try {
      const currentStore = store;
      const files = await currentStore.readAll();
      if (currentStore !== store || loading || editing || saving) return;
      if (!sameFiles(files, baseline)) {
        const parsed = M.parse(files); doc = parsed; baseline = files; config = M.cleanConfig(config, doc);
        applyLanguage(); render(); saveConfig(); notice(t('notice.external_change'));
      }
    } catch (error) { notice(errorText(error), true); }
    finally { polling = false; }
  }, 2500);
  async function connect() {
    // Served by the CLI: the repository is the server's, no picker involved.
    I18n.setLanguage(I18n.detect()); I18n.apply(document);
    $('welcome-hint').textContent = t('welcome.connecting');
    try { await openStore(new RegistryStore()); }
    catch (error) { $('welcome-hint').textContent = t('welcome.failed'); notice(errorText(error), true); }
  }
  connect();
})();
