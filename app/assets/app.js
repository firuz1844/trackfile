/* Dashboard UI. No network beyond the local server, no backend, no CDN, no localStorage, no generated copy of the registry. */
(() => {
  'use strict';
  const M = RegistryModel, $ = id => document.getElementById(id), { t, plural } = I18n;
  const labels = status => t('status.' + status);
  let doc = null, store = null, baseline = null, configBaseline = null, config = M.defaults(), layout = null, liveAssignees = {};
  let configTimer, configQueue = Promise.resolve(), configWrites = 0, pendingConfig = false, editing = null, commentEditing = null, commentTarget = null, saving = false, polling = false, loading = false;
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action, className = '') => { const b = el('button', className, text); b.type = 'button'; b.addEventListener('click', action); return b; };
  const badge = task => el('span', 'badge ' + task.status, labels(task.status));
  // A record from the archive is marked with a chip next to its status everywhere it is shown.
  const archiveChip = task => { const chip = el('span', 'archive-chip', t('archive.chip')); chip.title = t('archive.since', { date: date(task.archived_at) }); return chip; };
  const labelChip = l => { const chip = el('span', 'label-chip', l.title); chip.style.setProperty('--label-color', l.color); chip.title = l.title; return chip; };
  function blockedChip(task) {
    const openBlockers = M.blockedBy(doc, task).filter(b => b.status !== 'done' && !M.inactive.has(b.status));
    const chip = el('span', 'archive-chip blocked-chip', t('dependency.blocked_chip'));
    chip.title = t('dependency.blocked_hint', { ids: openBlockers.map(b => '#' + b.id).join(', ') });
    return chip;
  }
  function badges(task) {
    const list = [badge(task)];
    if (task.archived) list.push(archiveChip(task));
    if (M.isBlocked(doc, task)) list.push(blockedChip(task));
    return list;
  }
  const labelChips = task => (task.labels ?? []).map(id => doc.byLabel.get(id)).filter(Boolean).map(labelChip);
  // Compact rows (tree, recent changes, subtask lists) show labels inline next to the status badges; the
  // full task view shows them separately, in their own wrapping "Labels" row under the title (see below).
  const rowBadges = task => [...badges(task), ...labelChips(task)];
  function taskLabelsRow(task) {
    const chips = labelChips(task);
    if (!chips.length) return null;
    const row = el('div', 'task-labels');
    row.append(el('span', 'task-labels-heading', t('task.labels')), ...chips);
    return row;
  }
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
    store = candidate; doc = parsed; baseline = files; configBaseline = rawConfig; config = M.cleanConfig(state, doc); layout = candidate.layout; liveAssignees = candidate.liveAssignees;
    // Filters, pins and expansion are restored from config; the page itself comes from the URL hash
    // (deep link / reload) and otherwise is the dashboard.
    config.view = 'dashboard';
    applyLanguage();
    pendingConfig = false; notice(t('notice.connected', { registry: layout.registry })); $('reload').disabled = false;
    initialRoute(); saveConfig();
    autoArchive();
    updateGitStatus();
    updateMigrateBanner();
    return true;
  }
  // Shared-branch mode (#210): the sidebar button/badge, a background fast-forward every 30s while the tab
  // is visible, and re-checking after every write so the badge never lags a commit this tab itself made.
  const gitSyncButton = $('git-sync'), gitSyncBadge = $('git-sync-badge');
  let gitSyncing = false;
  async function updateGitStatus() {
    if (!store || !layout?.shared) { gitSyncButton.hidden = true; return; }
    gitSyncButton.hidden = false;
    try {
      const { unpushed, dirty } = await store.gitStatus();
      // `dirty` also covers manual edits and writes whose commit failed. Synchronize can commit
      // those changes, so the badge reflects them as well as commits awaiting a push.
      gitSyncBadge.hidden = !unpushed && !dirty; gitSyncBadge.textContent = unpushed ? String(unpushed) : '•';
      gitSyncButton.title = dirty ? t('sync.dirty_hint') : unpushed ? t('sync.unpushed_hint', { n: unpushed }) : t('sync.clean_hint');
    } catch { /* advisory only — a failed status check never blocks the UI */ }
  }
  async function runGitSync() {
    if (!store || gitSyncing) return;
    gitSyncing = true; gitSyncButton.disabled = true;
    try {
      // Pull first (fetch + fast-forward if clean), then send anything queued — "Synchronize" means both
      // directions, not just flushing this clone's own unpushed commits.
      await store.gitFetch();
      const result = await store.gitSync();
      await reload();
      if (result.pushed) notice(t('sync.done'));
      else if (result.clean) notice(t('sync.nothing'));
      else notice(t('sync.queued', { n: result.unpushedCount ?? 0 }));
    } catch (error) { notice(errorText(error), true); }
    finally { gitSyncing = false; gitSyncButton.disabled = false; updateGitStatus(); }
  }
  gitSyncButton.addEventListener('click', runGitSync);
  setInterval(async () => {
    if (!store || !layout?.shared || document.hidden || editing || saving) return;
    try {
      const result = await store.gitFetch();
      if (result.updated) await reload(); else updateGitStatus();
    } catch { /* the background poll never surfaces its own errors — the badge just won't move */ }
  }, 30000);

  // #212: the migration wizard — a dismissible nudge (not a modal, not automatic) toward shared mode for a
  // repository still on the legacy layout, and the dialog that runs `trackfile migrate --shared` for real.
  const migrateBanner = $('migrate-banner'), migrateWizard = $('migrate-wizard');
  const migratePlan = $('migrate-plan'), migratePlanList = $('migrate-plan-list'), migrateRunButton = $('migrate-run'), migrateError = $('migrate-wizard-error');
  function updateMigrateBanner() {
    migrateBanner.hidden = !store || Boolean(layout?.shared) || Boolean(config.migrationBannerDismissed);
  }
  $('migrate-banner-dismiss').addEventListener('click', () => { config.migrationBannerDismissed = true; saveConfig(); updateMigrateBanner(); });
  $('migrate-banner-open').addEventListener('click', () => {
    $('migrate-branch').value = 'trackfile'; $('migrate-remote').value = 'origin'; $('migrate-local').checked = false; $('migrate-push').checked = false;
    migratePlan.hidden = true; migratePlanList.replaceChildren(); migrateError.textContent = ''; migrateRunButton.disabled = true;
    migrateWizard.showModal();
  });
  const closeMigrateWizard = () => migrateWizard.close();
  $('close-migrate-wizard').addEventListener('click', closeMigrateWizard);
  $('cancel-migrate-wizard').addEventListener('click', closeMigrateWizard);
  migrateWizard.addEventListener('cancel', e => { e.preventDefault(); closeMigrateWizard(); });
  const migrateOptions = () => ({ branch: $('migrate-branch').value.trim() || 'trackfile', remote: $('migrate-remote').value.trim() || 'origin', local: $('migrate-local').checked, push: $('migrate-push').checked });
  $('migrate-preview').addEventListener('click', async () => {
    migrateError.textContent = ''; migrateRunButton.disabled = true;
    try {
      const result = await store.gitMigrate({ ...migrateOptions(), dryRun: true });
      if (result.alreadyMigrated) { migrateError.textContent = t('migrate.already'); migratePlan.hidden = true; return; }
      migratePlanList.replaceChildren(...(result.steps ?? []).map(s => el('li', '', `${s.name}: ${s.detail}`)));
      migratePlan.hidden = false; migrateRunButton.disabled = false;
    } catch (error) { migrateError.textContent = errorText(error); }
  });
  migrateRunButton.addEventListener('click', async () => {
    migrateError.textContent = ''; migrateRunButton.disabled = true; $('migrate-preview').disabled = true;
    try {
      const result = await store.gitMigrate({ ...migrateOptions(), dryRun: false });
      if (result.alreadyMigrated) { migrateError.textContent = t('migrate.already'); return; }
      notice(t('migrate.success'));
      closeMigrateWizard();
      await reload();
    } catch (error) { migrateError.textContent = errorText(error); migrateRunButton.disabled = false; }
    finally { $('migrate-preview').disabled = false; }
  });
  // When the registry loads, closed tasks older than a week move to the archive in one write and one commit.
  async function autoArchive() {
    const days = doc.meta.archive_after_days ?? M.ARCHIVE_AFTER_DAYS;
    const ids = M.archiveCandidates(doc, undefined, days);
    if (!ids.length) return;
    await mutateProject(current => M.autoArchive(current, undefined, days).changes, t('notice.auto_archived', { n: ids.length, ids: ids.map(id => '#' + id).join(', ') }), { operation: 'auto archive', taskIds: ids, title: `auto-archive, tasks: ${ids.length}` });
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
      doc = parsed; baseline = files; configBaseline = rawConfig; layout = store.layout; liveAssignees = store.liveAssignees;
      config = M.cleanConfig(incoming, doc); pendingConfig = false;
      applyLanguage(); render(); saveConfig(); notice(t('notice.reloaded'));
      autoArchive();
      updateGitStatus();
      updateMigrateBanner();
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
    config.search = ''; config.statuses = []; config.milestone = 'all'; config.labels = []; config.authors = []; config.assignees = []; selectTask(id, view);
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
    else if (hash === 'diagram') config.view = 'diagram';
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
    updateWorkspaceNote();
  }
  // #212 follow-up: once migrated, the sidebar footer should say so — "Local workspace" on its own would
  // read as though nothing was ever pushed anywhere, which stops being true the moment shared mode is on.
  // Needs `t()` with params (branch/remote), so it's not one of I18n.apply's plain data-i18n nodes.
  function updateWorkspaceNote() {
    const note = $('workspace-mode');
    if (layout?.shared) { note.textContent = t('sidebar.shared', { branch: layout.dataBranch }); note.title = t('sidebar.shared_hint', { branch: layout.dataBranch, remote: layout.dataRemote }); }
    else { note.textContent = t('sidebar.local'); note.title = t('sidebar.local_hint'); }
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
    $('dashboard').hidden = view !== 'dashboard'; $('tree-view').hidden = view !== 'tree'; $('task-page').hidden = view !== 'task'; $('source-page').hidden = view !== 'source'; $('milestone-page').hidden = view !== 'milestone'; $('diagram-view').hidden = view !== 'diagram';
    $('task-nav').hidden = view !== 'task' && view !== 'source' && view !== 'milestone'; $('page-actions').hidden = view !== 'task';
    // On the milestone page its title is the main heading and the kind/number become the subtitle.
    $('heading').textContent = view === 'dashboard' ? t('page.dashboard') : view === 'tree' ? t('page.tree') : view === 'diagram' ? t('page.diagram') : view === 'task' ? t('page.task', { id: task.id }) : view === 'milestone' ? milestone.title : reader.commit ? t('page.commit', { hash: reader.commit.short }) : reader.path.split('/').pop();
    $('page-name').textContent = $('heading').textContent;
    $('subtitle').textContent = view === 'dashboard' ? t('page.dashboard_sub') : view === 'tree' ? t('page.tree_sub') : view === 'diagram' ? t('page.diagram_sub') : view === 'task' ? (task.kind === 'feature' ? t('kind.feature') : t('kind.task')) + ' · ' + labels(task.status) : view === 'milestone' ? t('page.milestone_sub', { id: milestone.id }) : reader.commit ? t('page.commit_sub', { subject: reader.commit.subject }) : t('page.source_sub', { path: reader.path });
    // The top button on a milestone page creates the task right inside that milestone.
    $('new-task').textContent = view === 'milestone' ? t('task.new_in_milestone') : t('task.new');
    $('new-task').hidden = view === 'diagram';
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === (view === 'dashboard' || view === 'milestone' ? 'dashboard' : view === 'diagram' ? 'diagram' : 'tree')));
    if (view === 'dashboard') renderDashboard(); else if (view === 'tree') { renderFilters(); renderTree(); renderDetail(); } else if (view === 'diagram') renderDiagram(); else if (view === 'task') renderTaskPage(task); else if (view === 'milestone') renderMilestonePage(milestone); else renderSourcePage();
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
    row.append(el('span', 'mono', '#' + t.id), el('span', 'recent-title', t.title), ...rowBadges(t), el('time', 'mono', date(t.updated_at)));
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
  // The tree and the milestone page share one multi-select status filter and one sort order: a field plus an
  // independent asc/desc direction (a completed_at-less task sorts as if "never", i.e. last regardless of
  // direction, since there is nothing to compare).
  const SORT_FIELDS = [['id', 'sort.id'], ['created', 'sort.created'], ['updated', 'sort.updated'], ['completed', 'sort.completed']];
  const sortKey = (field, task) => field === 'created' ? Date.parse(task.created_at)
    : field === 'updated' ? Date.parse(task.updated_at)
    : field === 'completed' ? (task.completed_at ? Date.parse(task.completed_at) : -Infinity)
    : Number(task.id);
  const taskOrder = (field, dir) => {
    const mul = dir === 'asc' ? 1 : -1;
    return (a, b) => mul * (sortKey(field, a) - sortKey(field, b)) || Number(a.id) - Number(b.id);
  };
  // Generic multi-select dropdown: a <details><summary> showing the selection, a checkbox list below.
  // An empty selection means "no filter" (everything shown); `emptyLabel` is the summary text for that case.
  // `swatch(value)` optionally renders an extra node (a color dot) between the checkbox and its text.
  function renderCheckPicker(summary, container, items, selected, emptyLabel, onChange, swatch = null) {
    summary.textContent = selected.length ? items.filter(([value]) => selected.includes(value)).map(([, text]) => text).join(', ') : emptyLabel;
    container.replaceChildren(...items.map(([value, text]) => {
      const label = el('label');
      const input = el('input'); input.type = 'checkbox'; input.value = value; input.checked = selected.includes(value);
      input.addEventListener('change', () => onChange([...container.querySelectorAll('input:checked')].map(item => item.value)));
      label.append(input, ...(swatch ? [swatch(value)] : []), el('span', '', text)); return label;
    }));
  }
  function renderStatusPicker(summary, container, selected, onChange) {
    renderCheckPicker(summary, container, M.statuses.map(status => [status, labels(status)]), selected, t('filter.all_statuses'), onChange);
  }
  function renderLabelPicker(summary, container, selected, onChange) {
    const swatch = id => { const s = el('span', 'label-swatch'); s.style.background = doc.byLabel.get(id)?.color ?? 'transparent'; return s; };
    renderCheckPicker(summary, container, doc.labels.map(l => [l.id, l.title]), selected, t('filter.all_labels'), onChange, swatch);
  }
  // Single-select counterpart of renderCheckPicker: no radio dots — a checkmark on the selected row instead
  // (the same convention as the context menu's radio items), with unselected rows padded to match so the
  // text never shifts depending on which row happens to be checked. Picking one applies and closes the popover.
  function renderRadioPicker(summary, container, items, selected, onChange) {
    const details = container.closest('details');
    summary.textContent = (items.find(([value]) => value === selected) ?? items[0])[1];
    container.replaceChildren(...items.map(([value, text]) => {
      const checked = value === selected;
      const opt = el('button', 'radio-item' + (checked ? ' checked' : ''), text);
      opt.type = 'button'; opt.setAttribute('role', 'menuitemradio'); opt.setAttribute('aria-checked', String(checked));
      opt.addEventListener('click', () => { onChange(value); details.open = false; });
      return opt;
    }));
  }
  function renderSortDirButton(dir) {
    const btn = $('sort-dir'); btn.textContent = dir === 'asc' ? '↑' : '↓';
    btn.title = t(dir === 'asc' ? 'sort.dir_asc' : 'sort.dir_desc'); btn.setAttribute('aria-label', btn.title);
  }
  function renderFilters() {
    $('search').value = config.search;
    renderStatusPicker($('status-summary'), $('status-options'), config.statuses, selected => {
      config.statuses = selected; renderFilters(); renderTree(); saveConfig();
    });
    $('label-filter').hidden = !doc.labels.length;
    if (doc.labels.length) renderLabelPicker($('label-summary'), $('label-options'), config.labels, selected => {
      config.labels = selected; renderFilters(); renderTree(); saveConfig();
    });
    renderRadioPicker($('milestone-summary'), $('milestone-options'), [['all', t('filter.all_milestones')], ['none', t('filter.no_milestone')], ...doc.milestones.map(m => [m.id, `${m.id} · ${m.title}`])], config.milestone, selected => {
      config.milestone = selected; renderFilters(); renderTree(); saveConfig();
    });
    const authorItems = [...new Set(doc.tasks.map(x => x.author).filter(Boolean))].sort().map(a => [a, a]);
    renderCheckPicker($('author-summary'), $('author-options'), authorItems, config.authors, t('filter.all_authors'), selected => {
      config.authors = selected; renderFilters(); renderTree(); saveConfig();
    });
    const assigneeItems = [['none', t('meta.unassigned')], ...[...new Set(doc.tasks.map(x => x.assignee).filter(Boolean))].sort().map(a => [a, a])];
    renderCheckPicker($('assignee-summary'), $('assignee-options'), assigneeItems, config.assignees, t('filter.all_assignees'), selected => {
      config.assignees = selected; renderFilters(); renderTree(); saveConfig();
    });
    renderRadioPicker($('sort-summary'), $('sort-options'), SORT_FIELDS.map(([value, key]) => [value, t(key)]), config.sort, selected => {
      config.sort = selected; renderFilters(); renderTree(); saveConfig();
    });
    renderSortDirButton(config.sortDir);
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
    const filtering = !!term || config.statuses.length > 0 || config.milestone !== 'all' || config.labels.length > 0 || config.authors.length > 0 || config.assignees.length > 0;
    const matches = new Set(doc.tasks.filter(t => {
      if (t.archived && !config.showArchive) return false; // archived rows only when asked for
      if (config.statuses.length && !config.statuses.includes(t.status)) return false;
      const milestone = M.milestoneOf(doc, t);
      if (config.milestone !== 'all' && milestone !== (config.milestone === 'none' ? null : config.milestone)) return false;
      if (config.labels.length && !(t.labels ?? []).some(id => config.labels.includes(id))) return false;
      if (config.authors.length && !config.authors.includes(t.author)) return false;
      if (config.assignees.length && !config.assignees.includes(t.assignee ?? 'none')) return false;
      return !term || `${t.id} ${t.title} ${t.body} ${t.result ?? ''} ${t.assignee ?? ''}`.toLocaleLowerCase().includes(term.replace(/^#/, ''));
    }).map(t => t.id));
    const visible = new Set(matches);
    for (const id of matches) { let p = doc.byId.get(id)?.parent; while (p) { visible.add(p); p = doc.byId.get(p)?.parent; } }
    const children = new Map();
    for (const t of doc.tasks) { const key = t.parent; if (!children.has(key)) children.set(key, []); children.get(key).push(t); }
    for (const list of children.values()) list.sort((a, b) => byPin('pinnedTasks')(a, b) || taskOrder(config.sort, config.sortDir)(a, b));
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
      row.append(expander, pick, ...rowBadges(t)); group.append(row);
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
      row.append(el('span', 'expander', ''), pick, ...rowBadges(t)); return row;
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
      if (Object.keys(changes).length) {
        try {
          const ids = change ? changedIds(change) : [];
          const committed = change
            ? await store.recordChange(change.operation, ids, change.title ?? doc.byId.get(ids[0]).title, Object.keys(changes))
            : await store.recordMutation(files, changes);
          notice(`${message} ${t('notice.committed', { hash: committed.hash.slice(0, 10) })}`);
        } catch (error) { notice(`${message} ${errorText(error)}`, true); }
      } else notice(message);
      return true;
    } catch (error) { notice(errorText(error), true); return false; }
    finally { saving = false; updateGitStatus(); }
  }
  // #210: a non-blocking heads-up when a live agent is on this task — never prevents the write, just says
  // so, since only the writer decides whether to proceed (the protocol already says agents only touch their
  // own tasks; this is for the *user* acting on one an agent currently has).
  function liveWarning(taskId) {
    const live = liveAssignees[taskId];
    if (!live) return '';
    return ' ' + t('live.warning', { marker: live.marker, time: new Date(live.since).toLocaleTimeString(I18n.locale(), { hour: '2-digit', minute: '2-digit' }) });
  }
  function setStatus(task, status) {
    return mutateProject(current => M.setStatus(current, task.id, status), t('notice.status_set', { id: task.id, status: labels(status) }) + liveWarning(task.id));
  }
  // #202: a finished task can have finished subtasks still sitting in the registry (the dashboard
  // never archives them on its own), so a manual archive offers to sweep the whole closed subtree in one go.
  function archiveTask(task) {
    const subtasks = M.closedDescendants(doc, task.id);
    const withSubtasks = subtasks.length > 0 && confirm(t('archive.with_subtasks_confirm', { n: subtasks.length }));
    const ids = withSubtasks ? [task.id, ...subtasks] : task.id;
    const message = withSubtasks ? t('notice.archived_with_subtasks', { id: task.id, n: subtasks.length }) : t('notice.archived', { id: task.id });
    const change = withSubtasks ? { operation: 'archive', taskIds: ids, title: task.title } : { operation: 'archive', taskId: task.id };
    return mutateProject(current => M.archive(current, ids), message, change);
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
    if (!task.archived) list.push({ label: t('action.manage_dependencies'), run: () => openDependencyEditor(task.id) });
    if (!task.archived) list.push({ label: t('action.manage_labels'), run: () => openLabelAssign(task.id) });
    list.push({ label: t('action.change_status'), submenu: () => statusItems(task) });
    // Manual move between the registry and the archive; a closed task with open subtasks stays.
    if (task.archived) list.push({ label: t('action.unarchive'), run: () => mutateProject(current => M.unarchive(current, task.id), t('notice.unarchived', { id: task.id }), { operation: 'unarchive', taskId: task.id }) });
    else if (M.closed.has(task.status)) list.push({ label: t('action.archive'), run: () => archiveTask(task) });
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
  // Every filter dropdown (status, labels, milestone, author, assignee, sort — tree, milestone page and
  // diagram alike) is a plain <details class="status-filter">; one delegated listener closes whichever is
  // open when the click lands outside it, native <select>-like behavior a <details> doesn't give for free.
  document.addEventListener('pointerdown', e => {
    document.querySelectorAll('.status-filter[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
  });
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
    const relationList = (items, kind) => {
      if (!items.length) return null;
      const ul = el('ul', 'sources');
      for (const other of items) {
        const li = el('li', 'relation-row'), a = el('a', '', `#${other.id} ${other.title}`);
        a.href = '#'; a.addEventListener('click', e => { e.preventDefault(); openTaskPage(other.id); });
        const remove = button('🗑', () => removeRelation(task.id, other.id, kind), 'relation-remove');
        remove.title = t('dependency.remove'); remove.setAttribute('aria-label', remove.title);
        li.append(a, remove); ul.append(li);
      }
      return ul;
    };
    const blockedBy = relationList(M.blockedBy(doc, task), 'blocked_by'), blocks = relationList(M.blocks(doc, task), 'blocking'), related = relationList(M.relatedTasks(doc, task), 'relates_to');
    const actions = el('div', 'detail-actions');
    actions.append(...taskActions(task).filter(a => !a.menuOnly && (!a.navigation || a.always)).map(a => {
      if (!a.submenu) return button(a.label, a.run, a.className);
      const b = button(a.label + ' ▾', () => { const r = b.getBoundingClientRect(); showMenu(a.submenu(), r.left, r.bottom + 4, a.label); }, a.className);
      b.setAttribute('aria-haspopup', 'menu'); return b;
    }));
    const editable = task.status === 'to-do' && task.assignee === null;
    const lock = editable ? null : el('p', 'hint', t('task.locked'));
    return { meta, progress, description, result, sources, blockedBy, blocks, related, actions, lock, children, attachments: compact => attachmentsSection(task, { compact }) };
  }
  // The preview card is shared by the tree and the milestone page; `task` is passed explicitly when the
  // selected task must come from the current list (a milestone never shows a foreign task selected in the tree).
  function renderDetail(target = $('detail'), task = doc.byId.get(config.selected)) {
    target.replaceChildren();
    if (!task) { target.append(el('p', 'hint', t('detail.empty'))); return; }
    const parts = taskParts(task);
    const top = el('div', 'detail-title'); top.append(copyControl('#' + task.id), ...badges(task));
    target.append(top, el('h2', '', task.title));
    const labelsRow = taskLabelsRow(task); if (labelsRow) target.append(labelsRow);
    target.append(parts.meta);
    if (parts.progress) target.append(parts.progress);
    target.append(parts.description);
    target.append(parts.attachments(true));
    if (parts.result) target.append(parts.result);
    if (parts.sources) target.append(el('h3', '', t('task.sources')), parts.sources);
    if (parts.blockedBy) target.append(el('h3', '', t('dependency.blocked_by')), parts.blockedBy);
    if (parts.blocks) target.append(el('h3', '', t('dependency.blocks_label')), parts.blocks);
    if (parts.related) target.append(el('h3', '', t('dependency.related_label')), parts.related);
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
    // milestone page of the dashboard (its own route); Back returns to the document. In shared mode (#211)
    // the same mark may instead point at the data worktree locally (`.trackfile/TRACKFILE.md#task-NNN`) or
    // at the data branch's GitHub blob view (`blob/<branch>/TRACKFILE.md#task-NNN`, for a reader without
    // the dashboard) — the reader recognizes both alongside the plain legacy path.
    const isRegistryLink = resolved === layout.registry
      || (layout.shared && resolved === `${layout.tasks.split('/')[0]}/${layout.registry}`)
      || (layout.shared && resolved === `blob/${layout.dataBranch}/${layout.registry}`);
    if (isRegistryLink) {
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
    // Every task with this effective milestone; with a filter the parents of matches are kept for context.
    const members = doc.tasks.filter(task => M.milestoneOf(doc, task) === m.id);
    // The same filter bar as the task tree (status/labels/author/assignee/sort), minus a milestone picker —
    // this page is already scoped to one. Each multi-select reopens itself after a change (page.replaceChildren
    // below discards the old popover, so the freshly built one with the same id is what "reopen" acts on).
    const filters = el('div', 'filters');
    const statusFilter = el('details', 'status-filter'); statusFilter.id = 'ms-status-filter';
    const statusSummary = el('summary'), statusOptions = el('div', 'status-options'); statusFilter.append(statusSummary, statusOptions);
    renderStatusPicker(statusSummary, statusOptions, config.milestoneStatuses, selected => {
      config.milestoneStatuses = selected; renderMilestonePage(m); $('ms-status-filter').open = true; saveConfig();
    });
    const labelFilter = el('details', 'status-filter'); labelFilter.id = 'ms-label-filter'; labelFilter.hidden = !doc.labels.length;
    const labelSummary = el('summary'), labelOptions = el('div', 'status-options'); labelFilter.append(labelSummary, labelOptions);
    if (doc.labels.length) renderLabelPicker(labelSummary, labelOptions, config.milestoneLabels, selected => {
      config.milestoneLabels = selected; renderMilestonePage(m); $('ms-label-filter').open = true; saveConfig();
    });
    const authorItems = [...new Set(members.map(x => x.author).filter(Boolean))].sort().map(a => [a, a]);
    const authorFilter = el('details', 'status-filter'); authorFilter.id = 'ms-author-filter';
    const authorSummary = el('summary'), authorOptions = el('div', 'status-options'); authorFilter.append(authorSummary, authorOptions);
    renderCheckPicker(authorSummary, authorOptions, authorItems, config.milestoneAuthors, t('filter.all_authors'), selected => {
      config.milestoneAuthors = selected; renderMilestonePage(m); $('ms-author-filter').open = true; saveConfig();
    });
    const assigneeItems = [['none', t('meta.unassigned')], ...[...new Set(members.map(x => x.assignee).filter(Boolean))].sort().map(a => [a, a])];
    const assigneeFilter = el('details', 'status-filter'); assigneeFilter.id = 'ms-assignee-filter';
    const assigneeSummary = el('summary'), assigneeOptions = el('div', 'status-options'); assigneeFilter.append(assigneeSummary, assigneeOptions);
    renderCheckPicker(assigneeSummary, assigneeOptions, assigneeItems, config.milestoneAssignees, t('filter.all_assignees'), selected => {
      config.milestoneAssignees = selected; renderMilestonePage(m); $('ms-assignee-filter').open = true; saveConfig();
    });
    const sortWrap = el('div', 'sort-control');
    const sortFilter = el('details', 'status-filter'); sortFilter.id = 'ms-sort-filter';
    const sortSummary = el('summary'), sortOptions = el('div', 'status-options'); sortFilter.append(sortSummary, sortOptions);
    renderRadioPicker(sortSummary, sortOptions, SORT_FIELDS.map(([value, key]) => [value, t(key)]), config.milestoneSort, selected => {
      config.milestoneSort = selected; renderMilestonePage(m); saveConfig();
    });
    const sortDirBtn = button(config.milestoneSortDir === 'asc' ? '↑' : '↓', () => {
      config.milestoneSortDir = config.milestoneSortDir === 'asc' ? 'desc' : 'asc'; renderMilestonePage(m); saveConfig();
    }, 'sort-dir');
    sortDirBtn.title = t(config.milestoneSortDir === 'asc' ? 'sort.dir_asc' : 'sort.dir_desc'); sortDirBtn.setAttribute('aria-label', sortDirBtn.title);
    sortWrap.append(sortFilter, sortDirBtn);
    filters.append(statusFilter, labelFilter, authorFilter, assigneeFilter, sortWrap); page.append(filters);
    const msFiltering = config.milestoneStatuses.length > 0 || config.milestoneLabels.length > 0 || config.milestoneAuthors.length > 0 || config.milestoneAssignees.length > 0;
    const ids = new Set(members.map(task => task.id));
    const matches = new Set(members.filter(task =>
      (!config.milestoneStatuses.length || config.milestoneStatuses.includes(task.status)) &&
      (!config.milestoneLabels.length || (task.labels ?? []).some(id => config.milestoneLabels.includes(id))) &&
      (!config.milestoneAuthors.length || config.milestoneAuthors.includes(task.author)) &&
      (!config.milestoneAssignees.length || config.milestoneAssignees.includes(task.assignee ?? 'none'))
    ).map(task => task.id));
    const visible = new Set(matches);
    for (const id of matches) { let parent = doc.byId.get(id)?.parent; while (ids.has(parent)) { visible.add(parent); parent = doc.byId.get(parent)?.parent; } }
    const children = new Map();
    for (const task of members.filter(task => visible.has(task.id))) { const key = ids.has(task.parent) && visible.has(task.parent) ? task.parent : null; if (!children.has(key)) children.set(key, []); children.get(key).push(task); }
    for (const list of children.values()) list.sort(taskOrder(config.milestoneSort, config.milestoneSortDir));
    // As in the tree: single click selects into the card on the right, double click opens the page; nodes with
    // subtasks fold with the arrow or with Collapse/Expand all (with a filter active everything is expanded
    // because parents are shown for context).
    const filtering = msFiltering;
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
      row.append(expander, pick, ...rowBadges(task)); group.append(row);
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
    const header = el('div', 'tree-header'); header.append(el('span', '', t('tree.header')), el('span', '', msFiltering ? t('tree.matches_of', { n: matches.size, total: members.length }) : t('tree.records', { n: members.length }))); tree.append(header);
    const roots = children.get(null) ?? [];
    if (roots.length) tree.append(...roots.map(node)); else tree.append(el('div', 'empty', msFiltering ? t('milestone.empty_filtered') : t('milestone.empty')));
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
  // Dependencies are editable in any task status. The editor stages Blocked by/Blocking/Relates to as three
  // local sets and writes them all at once through setRelationships on Save; Cancel just discards the sets.
  // A direct 2-task blocking cycle is disabled in the list as it's picked (any longer cycle is still caught
  // by parse() on save and shown as an error).
  let dependencyTarget = null, dependencyPending = null, dependencyType = 'blocked_by';
  const dependencyFieldOf = type => type === 'blocked_by' ? 'blockedBy' : type === 'blocking' ? 'blocking' : 'relatesTo';
  function openDependencyEditor(id) {
    if (!doc || saving) return;
    const task = doc.byId.get(id);
    if (!task) return;
    dependencyTarget = id;
    dependencyType = 'blocked_by';
    dependencyPending = {
      blockedBy: new Set(task.blocked_by ?? []),
      blocking: new Set(M.blocks(doc, task).map(x => x.id)),
      relatesTo: new Set(M.relatedTasks(doc, task).map(x => x.id)),
    };
    $('dependency-heading').textContent = t('dependency.heading', { id });
    $('dependency-error').textContent = '';
    $('dependency-filter').value = '';
    $('dependency-editor').querySelector('input[name="dependency-type"][value="blocked_by"]').checked = true;
    renderDependencyEditor();
    $('dependency-editor').showModal(); $('dependency-filter').focus();
  }
  function renderDependencyEditor() {
    const task = doc.byId.get(dependencyTarget);
    if (!task) return;
    const hints = { blocked_by: 'dependency.blocked_by_hint', blocking: 'dependency.blocking_hint', relates_to: 'dependency.relates_to_hint' };
    $('dependency-type-hint').textContent = t(hints[dependencyType]);
    const field = dependencyFieldOf(dependencyType);
    const pending = dependencyPending[field];
    // A direct cycle would be created by picking a task that already sits on the opposite blocking side.
    const opposite = dependencyType === 'blocked_by' ? dependencyPending.blocking : dependencyType === 'blocking' ? dependencyPending.blockedBy : null;
    const term = $('dependency-filter').value.trim().toLocaleLowerCase();
    const matches = doc.tasks.filter(x => x.id !== task.id && !x.archived && (!term || x.id.includes(term) || x.title.toLocaleLowerCase().includes(term)));
    const rows = matches.map(x => {
      const row = el('label');
      const box = el('input'); box.type = 'checkbox'; box.value = x.id;
      box.checked = pending.has(x.id);
      const wouldCycle = Boolean(opposite?.has(x.id)) && !box.checked;
      box.disabled = wouldCycle;
      if (wouldCycle) { row.classList.add('dependency-row-disabled'); row.title = t('dependency.mutual_hint'); }
      box.addEventListener('change', () => { box.checked ? pending.add(x.id) : pending.delete(x.id); renderDependencyEditor(); });
      row.append(box, el('span', 'mono', '#' + x.id), el('span', '', x.title));
      return row;
    });
    $('dependency-list').replaceChildren(...(rows.length ? rows : [el('div', 'empty', t('picker.nothing'))]));
  }
  async function saveDependencyEditor() {
    if (!dependencyTarget || saving) return;
    const id = dependencyTarget;
    const ok = await mutateProject(current => M.setRelationships(current, id, {
      blockedBy: [...dependencyPending.blockedBy], blocking: [...dependencyPending.blocking], relatesTo: [...dependencyPending.relatesTo],
    }), t('notice.dependencies_saved', { id }));
    if (ok) closeDependencyEditor(); else $('dependency-error').textContent = t('save.failed');
  }
  function closeDependencyEditor() { dependencyTarget = null; dependencyPending = null; $('dependency-editor').close(); }
  // Removing one relation from the task page: the trash icon next to each entry. blocked_by/blocking edit
  // the side that actually stores the field; relates_to may live on either task's own record.
  function removeRelation(taskId, otherId, kind) {
    if (!doc || saving) return;
    const label = kind === 'blocking' ? t('notice.dependencies_saved', { id: otherId }) : t('notice.dependencies_saved', { id: taskId });
    return mutateProject(current => {
      if (kind === 'blocked_by') {
        const set = new Set(current.byId.get(taskId)?.blocked_by ?? []); set.delete(otherId);
        return M.setRelationships(current, taskId, { blockedBy: [...set] });
      }
      if (kind === 'blocking') {
        const set = new Set(current.byId.get(otherId)?.blocked_by ?? []); set.delete(taskId);
        return M.setRelationships(current, otherId, { blockedBy: [...set] });
      }
      const task = current.byId.get(taskId);
      const set = new Set(M.relatedTasks(current, task).map(x => x.id)); set.delete(otherId);
      return M.setRelationships(current, taskId, { relatesTo: [...set] });
    }, label);
  }
  // Labels: three dialogs. "Labels" (label-assign) picks labels for one task, with a search field and a
  // "Create label" row always at the bottom of the (filtered) list. "Manage labels" (label-manage), reachable
  // from there or from Settings, lists every label with edit/delete. "New/Edit label" (label-form) is shared
  // by both creation paths. Dialogs stack (each showModal() lands on top), so the one underneath is simply
  // left open and re-rendered once the one on top closes.
  let labelTarget = null, labelForm = null;
  // Toggles one label on the current assign target and reports whether the mutation went through.
  async function toggleLabelAssign(labelId, checked) {
    const set = new Set(doc.byId.get(labelTarget)?.labels ?? []);
    checked ? set.add(labelId) : set.delete(labelId);
    return mutateProject(current2 => M.setTaskLabels(current2, labelTarget, [...set]), t('notice.labels_saved', { id: labelTarget }));
  }
  function renderLabelAssign() {
    const task = doc.byId.get(labelTarget);
    if (!task) return;
    const rawTerm = $('label-assign-filter').value.trim();
    const term = rawTerm.toLocaleLowerCase();
    const current = new Set(task.labels ?? []);
    const matches = doc.labels.filter(l => !term || l.title.toLocaleLowerCase().includes(term));
    const rows = matches.map(l => {
      const row = el('label');
      const box = el('input'); box.type = 'checkbox'; box.value = l.id; box.checked = current.has(l.id);
      box.addEventListener('change', async () => {
        box.disabled = true;
        const ok = await toggleLabelAssign(l.id, box.checked);
        if (ok) renderLabelAssign(); else { box.checked = !box.checked; box.disabled = false; }
      });
      const swatch = el('span', 'label-swatch'); swatch.style.background = l.color;
      row.append(box, swatch, el('span', '', l.title));
      return row;
    });
    // The typed text is only appended to "Create label" when nothing in the list matches it — with any
    // match shown above, the row stays generic (the match itself is the obvious thing to pick).
    const create = button(rawTerm && !matches.length ? t('label.create_row_named', { title: rawTerm }) : t('label.create_row'), () => openLabelForm({ presetTitle: rawTerm, returnTo: 'assign' }), 'create-task-row');
    $('label-assign-list').replaceChildren(...(rows.length ? rows : term ? [] : [el('div', 'empty', t('label.none_yet'))]), create);
  }
  // Enter in the search field: an exact (case-insensitive) name match toggles that label and closes the
  // dialog — the fast path for "type the label name, hit Enter". No exact match but the text matches nothing
  // at all in the list opens "Create label" prefilled with it, same as clicking the row would. A partial
  // match with no exact hit is still an ambiguous, in-progress search, so Enter does nothing.
  async function handleLabelAssignEnter(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const rawTerm = $('label-assign-filter').value.trim();
    if (!rawTerm || !labelTarget) return;
    const term = rawTerm.toLocaleLowerCase();
    const exact = doc.labels.find(l => l.title.toLocaleLowerCase() === term);
    if (exact) {
      const current = new Set(doc.byId.get(labelTarget)?.labels ?? []);
      const ok = await toggleLabelAssign(exact.id, !current.has(exact.id));
      if (ok) closeLabelAssign();
      return;
    }
    if (!doc.labels.some(l => l.title.toLocaleLowerCase().includes(term))) openLabelForm({ presetTitle: rawTerm, returnTo: 'assign' });
  }
  // A registry with no "## Labels" section at all gets the default set the first time the user actually
  // looks at labels (opens either dialog below) — never automatically, and never for a project that already
  // has a (possibly empty) Labels section of its own.
  async function ensureLabelsSeeded() {
    if (!doc || !M.needsLabelSeed(doc)) return;
    await mutateProject(current => M.seedDefaultLabels(current), t('notice.labels_seeded'));
  }
  async function openLabelAssign(id) {
    if (!doc || saving) return;
    await ensureLabelsSeeded();
    labelTarget = id;
    $('label-assign-context').textContent = doc.byId.get(id)?.title ?? '';
    $('label-assign-filter').value = '';
    renderLabelAssign();
    $('label-assign').showModal(); $('label-assign-filter').focus();
  }
  function closeLabelAssign() { labelTarget = null; $('label-assign').close(); }
  function renderLabelManage() {
    $('label-manage-list').replaceChildren(...doc.labels.map(l => {
      const row = el('div', 'label-manage-row');
      const swatch = el('span', 'label-swatch'); swatch.style.background = l.color;
      const edit = button('✎', () => openLabelForm({ id: l.id, returnTo: 'manage' }), 'milestone-edit');
      edit.title = t('label.edit_title', { title: l.title }); edit.setAttribute('aria-label', edit.title);
      const del = button('🗑', async () => {
        const n = doc.tasks.filter(x => x.labels?.includes(l.id)).length;
        if (!confirm(t('label.confirm_delete', { title: l.title, n }))) return;
        const ok = await mutateProject(current2 => M.deleteLabel(current2, l.id), t('notice.label_deleted', { id: l.id }));
        if (ok) { renderLabelManage(); if ($('label-assign').open) renderLabelAssign(); }
      }, 'milestone-edit danger-action');
      del.title = t('label.delete_title', { title: l.title }); del.setAttribute('aria-label', del.title);
      row.append(swatch, el('span', 'label-manage-title', l.title), edit, del);
      return row;
    }));
    if (!doc.labels.length) $('label-manage-list').append(el('div', 'empty', t('label.none_yet')));
  }
  async function openLabelManage() {
    if (!doc || saving) return;
    await ensureLabelsSeeded();
    renderLabelManage();
    $('label-manage').showModal();
  }
  function closeLabelManage() { $('label-manage').close(); }
  function renderLabelPalette() {
    const current = $('label-form-color').value, isCustom = !M.presetColors.includes(current);
    const swatches = M.presetColors.map(color => {
      const b = button('', () => { $('label-form-color').value = color; renderLabelPalette(); }, 'label-preset' + (color === current ? ' selected' : ''));
      b.style.background = color; b.title = color; return b;
    });
    const custom = button('+', () => $('label-form-color-input').click(), 'label-preset label-preset-custom' + (isCustom ? ' selected' : ''));
    custom.style.background = isCustom ? current : '#ffffff'; custom.title = t('label.custom_color'); custom.setAttribute('aria-label', custom.title);
    $('label-form-palette').replaceChildren(...swatches, custom);
  }
  function openLabelForm({ id = null, presetTitle = '', returnTo }) {
    const l = id ? doc.byLabel.get(id) : null;
    labelForm = { id, returnTo };
    $('label-form-heading').textContent = id ? t('label.edit_heading') : t('label.new_heading');
    $('label-form-title').value = l ? l.title : presetTitle;
    $('label-form-color').value = l ? l.color : M.presetColors[0];
    $('label-form-error').textContent = '';
    renderLabelPalette();
    $('label-form').showModal(); $('label-form-title').focus();
  }
  function closeLabelForm() { labelForm = null; $('label-form').close(); }
  async function saveLabelForm(event) {
    event.preventDefault(); if (!labelForm || saving) return;
    const title = $('label-form-title').value.trim(), color = $('label-form-color').value;
    if (!title) { $('label-form-error').textContent = t('error.title_length'); return; }
    const { id, returnTo } = labelForm;
    if (id) {
      const ok = await mutateProject(current2 => M.editLabel(current2, id, title, color), t('notice.label_updated', { id }));
      if (!ok) { $('label-form-error').textContent = t('save.failed'); return; }
    } else {
      let newId = null;
      const ok = await mutateProject(current2 => { const added = M.addLabel(current2, { title, color }); newId = added.id; return added.changes; }, t('notice.label_added', { id: '' }));
      if (!ok) { $('label-form-error').textContent = t('save.failed'); return; }
      if (returnTo === 'assign' && labelTarget && newId) {
        const set = new Set(doc.byId.get(labelTarget)?.labels ?? []); set.add(newId);
        await mutateProject(current2 => M.setTaskLabels(current2, labelTarget, [...set]), t('notice.labels_saved', { id: labelTarget }));
      }
    }
    closeLabelForm();
    if ($('label-assign').open) renderLabelAssign();
    if ($('label-manage').open) renderLabelManage();
  }
  // #202: auto-archive cutoff, a project-wide setting stored in the registry's front matter, edited from Settings.
  function openSettingsArchive() {
    $('settings-archive-days').value = doc.meta.archive_after_days ?? M.ARCHIVE_AFTER_DAYS;
    $('settings-archive-error').textContent = '';
    $('settings-archive').showModal(); $('settings-archive-days').focus();
  }
  function closeSettingsArchive() { $('settings-archive').close(); }
  async function saveSettingsArchive(event) {
    event.preventDefault(); if (saving) return;
    const days = Number($('settings-archive-days').value);
    if (!Number.isInteger(days) || days < 0) { $('settings-archive-error').textContent = t('error.archive_after_days'); return; }
    // #202: a shorter cutoff can make already-closed tasks eligible right away — confirm before the
    // next autoArchive() sweeps them in, so the user is not surprised by a batch move they did not ask for.
    const immediate = M.archiveCandidates(doc, undefined, days).length;
    if (immediate > 0 && !confirm(t('settings.archive_immediate_confirm', { n: immediate }))) return;
    const ok = await mutateProject(current => M.setArchiveAfterDays(current, days), t('notice.archive_days_saved', { n: days }));
    if (!ok) { $('settings-archive-error').textContent = t('save.failed'); return; }
    closeSettingsArchive();
    autoArchive();
  }
  // Task Relationship Diagram: a filtered, capped subgraph rendered as inline SVG (diagram.js does the layout).
  function diagramScope() {
    const all = doc.tasks.filter(x => !x.archived);
    if (!config.diagramRoot || !doc.byId.has(config.diagramRoot)) return all;
    const edges = Diagram.edgesFromTasks(all);
    const adjacency = new Map(all.map(x => [x.id, []]));
    for (const e of edges) { adjacency.get(e.from)?.push(e.to); adjacency.get(e.to)?.push(e.from); }
    const seen = new Set([config.diagramRoot]), queue = [config.diagramRoot];
    while (queue.length) { const id = queue.shift(); for (const n of adjacency.get(id) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); } }
    return all.filter(x => seen.has(x.id));
  }
  function renderDiagramRootOptions() {
    options($('diagram-root'), [['', t('diagram.root_all')], ...doc.tasks.filter(x => !x.archived).map(x => [x.id, `#${x.id} ${x.title}`])], config.diagramRoot ?? '');
  }
  function renderDiagramRelationships() {
    const names = { parent: t('diagram.legend_parent'), blocked_by: t('diagram.legend_blocked_by'), relates_to: t('diagram.legend_relates_to') };
    renderCheckPicker($('diagram-relationships-summary'), $('diagram-relationships-options'), M.edgeTypes.map(type => [type, names[type]]), config.diagramRelationships, t('diagram.all_relationships'), selected => {
      config.diagramRelationships = selected; renderDiagram(); saveConfig();
    });
  }
  function renderDiagramMilestones() {
    const items = doc.milestones.map(m => [m.id, `${m.id} · ${m.title}`]);
    renderCheckPicker($('diagram-milestones-summary'), $('diagram-milestones-options'), items, config.diagramMilestones, t('filter.all_milestones'), selected => {
      config.diagramMilestones = selected; renderDiagram(); saveConfig();
    });
  }
  function renderDiagramFilteredMode() {
    const modes = [['dim', t('diagram.mode_dim')], ['hide', t('diagram.mode_hide')]];
    $('diagram-filtered-mode').replaceChildren(...modes.map(([value, text]) => {
      const b = button(text, () => { config.diagramFilteredMode = value; renderDiagramFilteredMode(); renderDiagramCanvas(); saveConfig(); });
      b.classList.toggle('active', config.diagramFilteredMode === value);
      b.setAttribute('aria-pressed', String(config.diagramFilteredMode === value));
      return b;
    }));
  }
  const EDGE_STYLE = { parent: { dash: '4 3', arrow: false, cls: 'edge-parent' }, blocked_by: { dash: '', arrow: true, cls: 'edge-blocked' }, relates_to: { dash: '2 4', arrow: false, cls: 'edge-relates' } };
  function legendItem(cls, text) { const row = el('span', 'legend-item'); row.append(el('span', 'legend-line ' + cls), el('span', '', text)); return row; }
  function setDiagramZoom(value) {
    config.diagramZoom = Math.min(2.5, Math.max(0.4, Math.round(value * 20) / 20));
    renderDiagramCanvas(); saveConfig();
  }
  function renderDiagramCanvas() {
    const preScope = diagramScope();
    const relTypes = config.diagramRelationships.length ? config.diagramRelationships : M.edgeTypes;
    let scope = preScope;
    if (config.diagramHideIsolated) {
      const connected = new Set();
      for (const e of Diagram.edgesFromTasks(preScope).filter(e => relTypes.includes(e.type))) { connected.add(e.from); connected.add(e.to); }
      scope = preScope.filter(x => connected.has(x.id));
    }
    const hasStatusFilter = config.diagramStatuses.length > 0, hasMilestoneFilter = config.diagramMilestones.length > 0;
    const hasFilter = hasStatusFilter || hasMilestoneFilter;
    const matches = x => (!hasStatusFilter || config.diagramStatuses.includes(x.status)) && (!hasMilestoneFilter || config.diagramMilestones.includes(M.milestoneOf(doc, x)));
    const kept = hasFilter ? scope.filter(matches) : scope;
    const mode = config.diagramFilteredMode;
    const drawTasks = hasFilter && mode !== 'hide' ? scope : kept;
    const dimmedIds = new Set(hasFilter && mode === 'dim' ? scope.filter(x => !matches(x)).map(x => x.id) : []);
    const edges = Diagram.edgesFromTasks(drawTasks).filter(e => relTypes.includes(e.type));
    const nodeSize = config.diagramShowNames ? { nodeWidth: 168, nodeHeight: 56 } : { nodeWidth: 64, nodeHeight: 32 };
    const layout = Diagram.computeLayout(drawTasks, edges, { limit: config.diagramLimit, ...nodeSize });
    const canvas = $('diagram-canvas'); canvas.replaceChildren();
    $('diagram-note').textContent = !layout.nodes.length ? t('diagram.empty') : layout.truncated ? t('diagram.truncated', { shown: layout.shown, total: layout.total }) : '';
    if (!layout.nodes.length) return;
    const ns = 'http://www.w3.org/2000/svg', pad = 24, zoom = config.diagramZoom;
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${layout.width + pad * 2} ${layout.height + pad * 2}`);
    svg.setAttribute('width', (layout.width + pad * 2) * zoom); svg.setAttribute('height', (layout.height + pad * 2) * zoom);
    const defs = document.createElementNS(ns, 'defs');
    defs.innerHTML = '<marker id="diagram-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="diagram-arrowhead"/></marker>';
    const g = document.createElementNS(ns, 'g'); g.setAttribute('transform', `translate(${pad},${pad})`);
    const pos = new Map(layout.nodes.map(n => [n.id, n]));
    for (const e of layout.edges) {
      const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) continue;
      const style = EDGE_STYLE[e.type];
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', a.x + layout.nodeWidth / 2); line.setAttribute('y1', a.y + layout.nodeHeight);
      line.setAttribute('x2', b.x + layout.nodeWidth / 2); line.setAttribute('y2', b.y);
      line.setAttribute('class', 'diagram-edge ' + style.cls);
      if (style.dash) line.setAttribute('stroke-dasharray', style.dash);
      if (style.arrow) line.setAttribute('marker-end', 'url(#diagram-arrow)');
      g.append(line);
    }
    for (const n of layout.nodes) {
      const task = doc.byId.get(n.id); if (!task) continue;
      const node = document.createElementNS(ns, 'g');
      node.setAttribute('class', 'diagram-node status-' + task.status + (dimmedIds.has(n.id) ? ' dimmed' : ''));
      node.setAttribute('transform', `translate(${n.x},${n.y})`);
      node.addEventListener('click', () => openTaskPage(n.id));
      const rect = document.createElementNS(ns, 'rect'); rect.setAttribute('width', layout.nodeWidth); rect.setAttribute('height', layout.nodeHeight); rect.setAttribute('rx', 8);
      node.append(rect);
      const idText = document.createElementNS(ns, 'text'); idText.setAttribute('x', 8); idText.setAttribute('class', 'mono'); idText.textContent = '#' + n.id;
      if (config.diagramShowNames) {
        idText.setAttribute('y', 20);
        const titleText = document.createElementNS(ns, 'text'); titleText.setAttribute('x', 8); titleText.setAttribute('y', 40);
        titleText.textContent = task.title.length > 22 ? task.title.slice(0, 21) + '…' : task.title;
        node.append(titleText);
      } else {
        idText.setAttribute('y', config.diagramShowLabels && task.labels?.length ? layout.nodeHeight / 2 : layout.nodeHeight / 2 + 4);
      }
      node.append(idText);
      if (config.diagramShowLabels && task.labels?.length) {
        const compact = !config.diagramShowNames;
        const dotR = compact ? 3 : 4, dotGap = compact ? 10 : 14, dotY = compact ? layout.nodeHeight - 8 : layout.nodeHeight - 10;
        task.labels.forEach((id, i) => {
          const l = doc.byLabel.get(id); if (!l) return;
          const dot = document.createElementNS(ns, 'circle');
          dot.setAttribute('cx', 8 + dotR + i * dotGap); dot.setAttribute('cy', dotY); dot.setAttribute('r', dotR);
          dot.setAttribute('fill', l.color); dot.setAttribute('class', 'diagram-label-dot');
          node.append(dot);
        });
      }
      const labelNames = (task.labels ?? []).map(id => doc.byLabel.get(id)?.title).filter(Boolean);
      const titleNode = document.createElementNS(ns, 'title');
      titleNode.textContent = `#${n.id} ${task.title}` + (labelNames.length ? ` (${labelNames.join(', ')})` : '');
      node.append(titleNode); g.append(node);
    }
    svg.append(defs, g); canvas.append(svg);
  }
  function renderDiagram() {
    renderDiagramRootOptions(); $('diagram-root').value = config.diagramRoot ?? '';
    $('diagram-limit').value = config.diagramLimit;
    $('diagram-show-names').checked = config.diagramShowNames;
    $('diagram-show-labels').checked = config.diagramShowLabels;
    $('diagram-hide-isolated').checked = config.diagramHideIsolated;
    renderDiagramRelationships();
    renderDiagramMilestones();
    renderDiagramFilteredMode();
    renderStatusPicker($('diagram-status-summary'), $('diagram-status-options'), config.diagramStatuses, selected => { config.diagramStatuses = selected; renderDiagram(); saveConfig(); });
    $('diagram-legend').replaceChildren(legendItem('edge-parent', t('diagram.legend_parent')), legendItem('edge-blocked', t('diagram.legend_blocked_by')), legendItem('edge-relates', t('diagram.legend_relates_to')));
    renderDiagramCanvas();
  }
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
    main.append(top, el('h2', '', task.title));
    const labelsRow = taskLabelsRow(task); if (labelsRow) main.append(labelsRow);
    main.append(el('h3', '', t('task.description')), parts.description);
    main.append(parts.attachments(false));
    if (parts.result) main.append(el('h3', '', t('task.result')), parts.result);
    if (parts.sources) main.append(el('h3', '', t('task.sources')), parts.sources);
    if (parts.blockedBy) main.append(el('h3', '', t('dependency.blocked_by')), parts.blockedBy);
    if (parts.blocks) main.append(el('h3', '', t('dependency.blocks_label')), parts.blocks);
    if (parts.related) main.append(el('h3', '', t('dependency.related_label')), parts.related);
    if (parts.children.length) {
      main.append(el('h3', '', t('task.subtasks')));
      if (parts.progress) main.append(parts.progress);
      const list = el('div', 'subtasks');
      for (const c of parts.children) {
        const row = el('div', 'tree-row'); row.dataset.task = c.id;
        const pick = button('', () => openTaskPage(c.id), 'tree-select');
        pick.append(el('span', 'mono', '#' + c.id + (c.kind === 'feature' ? ' · ' + t('kind.feature_tag') : '')), el('span', '', c.title));
        row.append(el('span', 'expander', ''), pick, ...rowBadges(c)); list.append(row);
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
      (commentId ? t('notice.comment_updated', { ref: `#${Number(taskId)}.${commentId}` }) : t('notice.comment_added', { id: Number(taskId) })) + (commentId ? '' : liveWarning(taskId)),
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
      render(); saveConfig();
      const message = t('notice.milestone_saved', { id });
      try {
        if (Object.keys(changes).length) await store.recordMutation(files, changes);
        notice(message);
      } catch (error) { notice(`${message} ${errorText(error)}`, true); }
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
  $('sort-dir').addEventListener('click', () => { config.sortDir = config.sortDir === 'asc' ? 'desc' : 'asc'; renderSortDirButton(config.sortDir); renderTree(); saveConfig(); });
  $('show-archive').addEventListener('change', () => { config.showArchive = $('show-archive').checked; renderTree(); saveConfig(); });
  $('hide-done-dashboard').addEventListener('change', () => { config.hideDone = $('hide-done-dashboard').checked; render(); saveConfig(); });
  $('expand').addEventListener('click', () => { config.expanded = doc.tasks.map(task => task.id); renderTree(); saveConfig(); });
  $('collapse').addEventListener('click', () => { config.expanded = []; renderTree(); saveConfig(); });
  $('clear-filters').addEventListener('click', () => { config.search = ''; config.statuses = []; config.milestone = 'all'; config.labels = []; config.authors = []; config.assignees = []; render(); saveConfig(); });
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
  $('close-dependency').addEventListener('click', closeDependencyEditor); $('cancel-dependency').addEventListener('click', closeDependencyEditor);
  $('dependency-editor').addEventListener('cancel', e => { e.preventDefault(); closeDependencyEditor(); });
  $('save-dependency').addEventListener('click', saveDependencyEditor);
  $('dependency-filter').addEventListener('input', renderDependencyEditor);
  for (const radio of $('dependency-type-tabs').querySelectorAll('input[name="dependency-type"]')) {
    radio.addEventListener('change', () => { dependencyType = radio.value; renderDependencyEditor(); });
  }
  $('close-label-assign').addEventListener('click', closeLabelAssign); $('close-label-assign-bottom').addEventListener('click', closeLabelAssign);
  $('label-assign').addEventListener('cancel', e => { e.preventDefault(); closeLabelAssign(); });
  $('label-assign-filter').addEventListener('input', renderLabelAssign);
  $('label-assign-filter').addEventListener('keydown', handleLabelAssignEnter);
  $('open-label-manage').addEventListener('click', openLabelManage);
  $('new-label-manage').addEventListener('click', () => openLabelForm({ returnTo: 'manage' }));
  $('close-label-manage').addEventListener('click', closeLabelManage); $('close-label-manage-bottom').addEventListener('click', closeLabelManage);
  $('label-manage').addEventListener('cancel', e => { e.preventDefault(); closeLabelManage(); });
  $('label-form-form').addEventListener('submit', saveLabelForm);
  $('close-label-form').addEventListener('click', closeLabelForm); $('cancel-label-form').addEventListener('click', closeLabelForm);
  $('label-form').addEventListener('cancel', e => { e.preventDefault(); closeLabelForm(); });
  $('label-form-color-input').addEventListener('input', () => { $('label-form-color').value = $('label-form-color-input').value; renderLabelPalette(); });
  $('settings-gear').addEventListener('click', () => {
    const r = $('settings-gear').getBoundingClientRect();
    showMenu([{ label: t('label.manage_heading'), run: openLabelManage }, { label: t('settings.archive_heading'), run: openSettingsArchive }], r.right + 8, r.top, t('settings.title'));
  });
  $('settings-archive-form').addEventListener('submit', saveSettingsArchive);
  $('close-settings-archive').addEventListener('click', closeSettingsArchive); $('cancel-settings-archive').addEventListener('click', closeSettingsArchive);
  $('settings-archive').addEventListener('cancel', e => { e.preventDefault(); closeSettingsArchive(); });
  $('diagram-root').addEventListener('change', () => { config.diagramRoot = $('diagram-root').value || null; renderDiagramCanvas(); saveConfig(); });
  $('diagram-limit').addEventListener('change', () => { config.diagramLimit = Math.max(1, Math.min(500, Number($('diagram-limit').value) || 60)); $('diagram-limit').value = config.diagramLimit; renderDiagramCanvas(); saveConfig(); });
  $('diagram-show-names').addEventListener('change', () => { config.diagramShowNames = $('diagram-show-names').checked; renderDiagramCanvas(); saveConfig(); });
  $('diagram-show-labels').addEventListener('change', () => { config.diagramShowLabels = $('diagram-show-labels').checked; renderDiagramCanvas(); saveConfig(); });
  $('diagram-hide-isolated').addEventListener('change', () => { config.diagramHideIsolated = $('diagram-hide-isolated').checked; renderDiagramCanvas(); saveConfig(); });
  $('diagram-zoom-in').addEventListener('click', () => setDiagramZoom(config.diagramZoom + 0.15));
  $('diagram-zoom-out').addEventListener('click', () => setDiagramZoom(config.diagramZoom - 0.15));
  $('diagram-clear-filters').addEventListener('click', () => {
    config.diagramRoot = null; config.diagramStatuses = []; config.diagramRelationships = []; config.diagramMilestones = [];
    renderDiagram(); saveConfig();
  });
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
      liveAssignees = currentStore.liveAssignees;
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
