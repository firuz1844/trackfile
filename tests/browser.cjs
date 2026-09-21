/* Integration test of the dashboard in Chrome through Playwright, against the local server on a throwaway
 * git repository with a synthetic registry. Needs `playwright` resolvable (NODE_PATH) and Chrome (CHROME_PATH). */
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const M = require('../app/assets/model.js');
const F = require('./fixture.cjs');
const { createServer, HOST } = require('../lib/serve.cjs');
const { resolveLayout, readRegistryFiles } = require('../lib/layout.cjs');

(async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'trackfile-ui-'));
  const shots = await fs.mkdtemp(path.join(os.tmpdir(), 'trackfile-shots-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
  git('init', '-q');
  await fs.writeFile(path.join(repo, 'TRACKFILE.md'), F.registry());
  await fs.mkdir(path.join(repo, '.trackfile', 'tasks', '002'), { recursive: true });
  await fs.writeFile(path.join(repo, '.trackfile', 'tasks', '002', 'comments.md'), F.comments());
  await fs.mkdir(path.join(repo, 'docs')); await fs.writeFile(path.join(repo, 'docs', 'design.md'), '# Design\n\nParagraph about task [#002](../TRACKFILE.md#task-002).\n');
  await fs.writeFile(path.join(repo, '.gitignore'), '.trackfile/config.json\n.trackfile/.sync.lock\n');
  git('add', '.'); git('commit', '-q', '-m', 'initial');
  const layout = resolveLayout(repo);
  const server = createServer(layout);
  await new Promise(r => server.listen(0, HOST, r));
  const base = `http://${HOST}:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US' });
  const page = await context.newPage();
  const errors = [], remote = [], confirmations = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith(base)) remote.push(r.url()); });
  page.on('dialog', dialog => { confirmations.push(dialog.message()); dialog.accept(); });
  const waitSave = () => page.waitForFunction(() => ['Saved to the repository', 'Сохранено в репозитории'].includes(document.getElementById('save-state').textContent));
  const readDoc = () => M.parse(readRegistryFiles(layout));
  const newest = doc => [...doc.tasks].sort((a, b) => Number(b.id) - Number(a.id))[0];
  // UI commits happen after the write; poll git until the expected subject is at HEAD.
  const waitCommit = async prefix => { for (let i = 0; i < 100; i++) { if (git('show', '-s', '--format=%s', 'HEAD').startsWith(prefix)) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('no commit ' + prefix); };
  const readConfig = async () => JSON.parse(await fs.readFile(path.join(repo, '.trackfile', 'config.json'), 'utf8'));
  try {
    await page.goto(base + '/');
    await page.locator('#workspace').waitFor({ state: 'visible' }); await waitSave();
    assert.equal(await page.title(), 'Sample · Trackfile', 'the project name comes from the front matter');
    assert.equal(await page.locator('#brand-name').textContent(), 'Sample');
    assert.equal(await page.locator('.milestone-row').count(), 2);
    assert.equal(await page.locator('.stat').count(), 4);
    // Closed tasks older than a week were auto-archived on load, in one commit of both registry files.
    assert.deepEqual(readDoc().tasks.filter(t => t.archived).map(t => t.id), ['003', '004', '008']);
    assert.equal(git('show', '-s', '--format=%s', 'HEAD'), '#003 #004 #008 [auto archive]: auto-archive, tasks: 3');
    assert.equal(git('show', '--format=', '--name-only', 'HEAD'), '.trackfile/archive.md\nTRACKFILE.md');
    // Milestone page: the title is the only H1, kind and number are the subtitle.
    await page.getByRole('button', { name: /M01 First milestone/ }).click();
    assert.equal(await page.locator('h1#heading').textContent(), 'First milestone');
    assert.equal(await page.locator('p#subtitle').textContent(), 'Milestone M01');
    assert.equal(await page.locator('#new-task').textContent(), '＋ New task in milestone');
    await page.locator('#new-task').click();
    assert.equal(await page.locator('#edit-milestone').inputValue(), 'M01');
    await page.locator('#cancel-editor').click();
    await page.getByRole('button', { name: '＋ Add task' }).click();
    await page.locator('#milestone-add-filter').fill('Completely new task');
    await page.getByRole('button', { name: '＋ Create a new task' }).click();
    assert.equal(await page.locator('#edit-title').inputValue(), 'Completely new task');
    await page.locator('#cancel-editor').click();
    // Single click selects into the card, double click opens the page, Back returns with the row flashed.
    await page.locator('.milestone-tree .tree-select').filter({ hasText: '#002' }).click();
    assert.match(page.url(), /#milestone\/M01$/);
    assert.equal(await page.locator('.milestone-detail h2').textContent(), 'Free subtask');
    await page.locator('.milestone-tree .tree-select').filter({ hasText: '#002' }).dblclick();
    assert.match(page.url(), /#task\/002$/);
    // The source reader opens repository files from `sources` and highlights the back-link to the task.
    await page.locator('#task-page .sources a', { hasText: 'docs/design.md' }).click();
    await page.locator('#source-page').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.task-hit').count(), 1, 'the paragraph with the back-link is highlighted');
    await page.locator('#source-body a.md-local').click();
    await page.locator('#task-page').waitFor({ state: 'visible' }); assert.match(page.url(), /#task\/002$/, 'a TRACKFILE.md#task-NNN link opens the task page');
    await page.goBack(); await page.locator('#source-page').waitFor({ state: 'visible' });
    await page.goBack(); await page.locator('#task-page').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '← Back' }).click();
    await page.locator('.milestone-tree .tree-row.flash[data-task="002"]').waitFor();
    // A task created from the milestone page stays there, selected; each save is a git commit.
    await page.locator('#new-task').click();
    await page.locator('#edit-title').fill('Task from milestone');
    await page.locator('#save-task').click();
    await page.locator('#editor').waitFor({ state: 'hidden' }); await waitSave(); await waitCommit('#011 [new task]');
    const fromMilestone = newest(readDoc());
    assert.equal(fromMilestone.milestone, 'M01'); assert.equal(fromMilestone.id, '011');
    assert.equal(git('show', '--format=', '--name-only', 'HEAD'), 'TRACKFILE.md');
    assert.match(page.url(), /#milestone\/M01$/);
    assert.equal(await page.locator('.milestone-tree .tree-row.selected').getAttribute('data-task'), '011');
    // "＋ Subtask" accepts an existing task and warns before re-parenting (confirm is accepted).
    await page.locator('.milestone-tree .tree-select').filter({ hasText: '#001' }).click();
    await page.getByRole('button', { name: '＋ Subtask' }).click();
    await page.locator('#subtask-add-filter').fill('#011');
    await page.locator('#subtask-add-tasks input[type=radio]').check();
    assert.equal((await page.locator('#subtask-add-warning').textContent()).trim(), '');
    await page.locator('#save-subtask-add').click(); await page.locator('#subtask-add').waitFor({ state: 'hidden' }); await waitSave();
    assert.equal(readDoc().byId.get('011').parent, '001');
    await page.locator('.milestone-tree .tree-select').filter({ hasText: '#002' }).click();
    await page.getByRole('button', { name: '＋ Subtask' }).click();
    await page.locator('#subtask-add-filter').fill('#011');
    await page.locator('#subtask-add-tasks input[type=radio]').check();
    await page.locator('#subtask-add-warning').filter({ hasText: 'already a subtask of #001' }).waitFor();
    await page.locator('#save-subtask-add').click(); await page.locator('#subtask-add').waitFor({ state: 'hidden' }); await waitSave();
    assert.match(confirmations.at(-1), /Change its parent to #002/);
    assert.equal(readDoc().byId.get('011').parent, '002');
    assert.equal(await page.locator('.milestone-tree .tree-row[data-task="003"] .archive-chip').count(), 1, 'archived members are shown with a chip');
    await page.locator('#ms-status-filter').click();
    await page.locator('#ms-status-filter .status-options input[value="done"]').check(); await waitSave();
    assert.deepEqual((await readConfig()).milestoneStatuses, ['done']);
    await page.getByRole('button', { name: '← Back' }).click();
    await page.locator('[data-view=tree]').click();
    await page.locator('#expand').click();
    assert.equal(await page.locator('#tree .tree-row').count(), readDoc().tasks.filter(t => !t.archived).length, 'archived tasks are hidden from the tree by default');
    // Multi-status filter persists as an array; search matches descriptions.
    await page.locator('#status-filter').click();
    await page.locator('#status-options input[value="review"]').check();
    await page.locator('#status-options input[value="in_progress"]').check();
    await waitSave();
    assert.deepEqual((await readConfig()).statuses, ['in_progress', 'review']);
    const visibleStatuses = await page.locator('#tree .tree-row').evaluateAll(rows => rows.map(row => row.querySelector('.badge')?.textContent).filter(Boolean));
    assert.ok(visibleStatuses.includes('In review')); assert.ok(visibleStatuses.includes('In progress'));
    await page.locator('#clear-filters').click();
    await page.locator('#search').fill('virtualization');
    assert.equal(await page.locator('#tree .tree-row').count(), 1);
    await page.locator('#clear-filters').click();
    // Create, then edit; HTML in the title stays text.
    await page.locator('#new-task').click();
    await page.locator('#edit-title').fill('Check <img src=x onerror=alert(1)>');
    await page.locator('#edit-body').fill('Save straight to the file.\n\n#### Check\n- Reopen.');
    await page.locator('#edit-parent').selectOption('001');
    await page.locator('#save-task').click();
    await page.locator('#editor').waitFor({ state: 'hidden' }); await waitSave();
    let d = readDoc(), created = newest(d);
    assert.equal(created.author, 'User'); assert.equal(created.parent, '001'); assert.equal(created.status, 'to-do');
    assert.equal(await page.locator('#detail img').count(), 0);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('#edit-title').fill('Changed by the user');
    await page.locator('#save-task').click();
    await page.locator('#editor').waitFor({ state: 'hidden' }); await waitCommit(`#${created.id} [edit task]`);
    assert.equal(readDoc().byId.get(created.id).title, 'Changed by the user');
    // Status, labels and relationships use the default commit path, even without an explicit operation.
    const expectMutationCommit = async action => {
      const previous = git('rev-parse', 'HEAD');
      const committed = page.waitForResponse(response => response.url() === base + '/api/git/commit' && response.request().method() === 'POST');
      const [, response] = await Promise.all([action(), committed]);
      assert.equal(response.status(), 200);
      const payload = await response.json();
      await page.locator('#notice').filter({ hasText: payload.hash.slice(0, 10) }).waitFor();
      assert.notEqual(git('rev-parse', 'HEAD'), previous, 'dashboard mutation created a commit');
      assert.equal(git('show', '-s', '--format=%s', 'HEAD'), `#${created.id} [edit task]: Changed by the user`);
      assert.equal(git('status', '--porcelain').trim(), '', 'dashboard leaves a clean worktree');
    };
    await expectMutationCommit(async () => {
      await page.getByRole('button', { name: 'Change status ▾', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'In review', exact: true }).click();
    });
    assert.equal(readDoc().byId.get(created.id).status, 'review');
    await expectMutationCommit(async () => {
      await page.getByRole('button', { name: 'Labels', exact: true }).click();
      await page.locator('#label-assign-list input[value="L01"]').check();
    });
    await page.locator('#close-label-assign').click();
    assert.deepEqual(readDoc().byId.get(created.id).labels, ['L01']);
    await expectMutationCommit(async () => {
      await page.getByRole('button', { name: 'Relationships', exact: true }).click();
      await page.locator('#dependency-list input[value="007"]').check();
      await page.locator('#save-dependency').click();
      await page.locator('#dependency-editor').waitFor({ state: 'hidden' });
    });
    assert.deepEqual(readDoc().byId.get(created.id).blocked_by, ['007']);
    assert.equal(readDoc().byId.get(created.id).status, 'review');
    await page.locator('.tree-select').filter({ hasText: '#' + created.id }).dblclick();
    await expectMutationCommit(async () => {
      await page.getByRole('button', { name: 'Change status ▾', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'To-do', exact: true }).click();
    });
    // Comments: add, deep link, done marker, edit, delete — each its own commit of the comments file only.
    await page.getByRole('button', { name: '＋ Comment' }).click();
    await page.locator('#comment-body').fill(`Take this into account; reference #${Number(created.id)}.1`);
    await page.locator('#comment-form button[type="submit"]').click(); await page.locator('#comment-editor').waitFor({ state: 'hidden' }); await waitSave();
    assert.equal(readDoc().byId.get(created.id).comments[0].author, 'User');
    await waitCommit(`#${created.id} [commented]`);
    assert.equal(git('show', '--format=', '--name-only', 'HEAD'), `.trackfile/tasks/${created.id}/comments.md`);
    assert.equal(await page.locator('.task-page .copy-ref').first().textContent(), '#' + created.id);
    await page.locator('.comment-ref').click(); assert.match(page.url(), new RegExp(`#task/${created.id}/comment/1$`));
    await page.locator('#comment-1.comment-target').waitFor();
    await page.locator('#comment-1 .comment-done input').check();
    await page.locator('#notice').filter({ hasText: 'done' }).waitFor();
    assert.equal(readDoc().byId.get(created.id).comments[0].done, true);
    await page.locator('#comment-1').getByRole('button', { name: 'Edit' }).click();
    await page.locator('#comment-body').fill('Refined comment'); await page.locator('#comment-form button[type="submit"]').click(); await page.locator('#comment-editor').waitFor({ state: 'hidden' }); await waitCommit(`#${created.id} [edit comment]`);
    assert.equal(readDoc().byId.get(created.id).comments[0].text, 'Refined comment');
    await page.locator('#comment-1').getByRole('button', { name: 'Delete' }).click(); await waitSave();
    assert.match(confirmations.at(-1), new RegExp(`Delete comment #${Number(created.id)}\\.1`));
    assert.equal(readDoc().byId.get(created.id).comments.length, 0);
    await waitCommit(`#${created.id} [delete comment]`);
    assert.equal(git('show', '--format=', '--name-status', 'HEAD'), `D\t.trackfile/tasks/${created.id}/comments.md`);
    // A stale form never overwrites an external edit; the draft stays.
    await page.locator('[data-view=tree]').click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('#edit-body').fill('User draft');
    const current = await fs.readFile(path.join(repo, 'TRACKFILE.md'), 'utf8');
    await fs.writeFile(path.join(repo, 'TRACKFILE.md'), current.replace('title: "Changed by the user"', 'title: "Agent edit"'));
    await page.locator('#save-task').click();
    await page.locator('#editor-error').filter({ hasText: 'changed' }).waitFor();
    assert.equal(readDoc().byId.get(created.id).title, 'Agent edit');
    assert.equal(await page.locator('#edit-body').inputValue(), 'User draft');
    await page.locator('#cancel-editor').click();
    await waitSave(); await page.locator('#reload').click(); await waitSave();
    // An invalid registry never replaces the last valid UI; the error is a translated model code.
    const good = await fs.readFile(path.join(repo, 'TRACKFILE.md'), 'utf8');
    await fs.writeFile(path.join(repo, 'TRACKFILE.md'), 'broken');
    await page.locator('#reload').click();
    await page.locator('#notice').filter({ hasText: 'front matter' }).waitFor();
    assert.ok(await page.locator('#tree .tree-row').count() > 0);
    await fs.writeFile(path.join(repo, 'TRACKFILE.md'), good);
    await page.locator('#reload').click(); await waitSave();
    // Theme, search and language persist in .trackfile/config.json and survive a reload.
    await page.locator('#theme').click();
    await page.locator('#search').fill('video');
    await waitSave();
    let c = await readConfig(); assert.equal(c.search, 'video'); assert.equal(c.theme, 'dark');
    await page.locator('#lang').click(); await waitSave();
    assert.equal((await readConfig()).lang, 'ru');
    assert.equal(await page.locator('[data-view=tree] .text').textContent(), 'Дерево задач');
    assert.equal(await page.locator('#new-task').textContent(), '＋ Новая задача');
    assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
    const russianBadges = await page.locator('#tree .badge').evaluateAll(b => [...new Set(b.map(x => x.textContent))]);
    assert.ok(russianBadges.every(x => ['To-do', 'В работе', 'На проверке', 'Готово', 'Отменено', 'Удалено'].includes(x)), russianBadges.join());
    await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' }); await waitSave();
    assert.equal(await page.locator('#search').inputValue(), 'video');
    assert.equal(await page.locator('body').getAttribute('data-theme'), 'dark');
    assert.equal(await page.locator('#page-name').textContent(), 'Дерево задач', 'the language survives a reload');
    await page.locator('#lang').click(); await waitSave();
    assert.equal((await readConfig()).lang, 'en');
    await page.locator('#clear-filters').click(); await waitSave();
    // Remove a task externally: retained IDs survive, removed selection/expansion gets cleaned.
    d = readDoc(); const remove = d.byId.get(created.id);
    c = await readConfig(); c.expanded = ['001', created.id]; c.selected = created.id;
    await fs.writeFile(path.join(repo, '.trackfile', 'config.json'), JSON.stringify(c));
    await fs.writeFile(path.join(repo, 'TRACKFILE.md'), d.text.slice(0, remove.start) + d.text.slice(remove.end));
    await page.locator('#reload').click(); await waitSave();
    c = await readConfig(); assert.equal(c.selected, null); assert.deepEqual(c.expanded, ['001']);
    await page.locator('#show-archive').check(); await page.locator('#search').fill('#003');
    await page.locator('#tree .tree-select').filter({ hasText: '#003' }).click();
    assert.equal(await page.locator('#tree .tree-row[data-task="003"] .archive-chip').count(), 1, 'archived rows appear with the checkbox');
    assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).count(), 0, 'done tasks are not editable');
    assert.equal(await page.getByRole('button', { name: 'Unarchive' }).count(), 1);
    await page.locator('#show-archive').uncheck();
    await page.locator('#clear-filters').click();
    await page.locator('#expand').click(); await waitSave();
    await page.screenshot({ path: path.join(shots, 'tree-dark.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).display !== 'none').slice(0, 5).map(e => e.tagName + '#' + e.id + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile horizontal overflow: ' + overflow.join(' | '));
    await page.screenshot({ path: path.join(shots, 'mobile.png') });
    // An externally edited config is never silently overwritten.
    await fs.writeFile(path.join(repo, '.trackfile', 'config.json'), '{"schema":1,"theme":"light"}');
    await page.locator('#theme-mobile').click();
    await page.locator('#notice').filter({ hasText: 'changed by another editor' }).waitFor();
    assert.equal(await fs.readFile(path.join(repo, '.trackfile', 'config.json'), 'utf8'), '{"schema":1,"theme":"light"}');
    await page.locator('#reload').click(); await waitSave();
    assert.deepEqual(errors, []); assert.deepEqual(remote, []);
    // Only the test's own external edits of TRACKFILE.md are pending: every UI write was committed, the config is ignored.
    assert.equal(git('status', '--porcelain').trim(), 'M TRACKFILE.md');
    console.log(JSON.stringify({ passed: true, tasks: readDoc().tasks.length, repo, screenshots: shots, checks: 'server, dashboard/milestone/tree/filter, create/edit, subtask, comments, commits, reader + back-links, stale writes, corrupt registry, persistence, language switch, removed IDs, dark/mobile layout, config conflicts, no remote requests' }));
  } catch (error) {
    console.error('Browser state:', await page.locator('#notice').textContent(), await page.locator('.context-menu').innerText(), await page.locator('dialog[open]').evaluateAll(nodes => nodes.map(n => n.id)), errors);
    throw error;
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
