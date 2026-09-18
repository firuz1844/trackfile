/* Registry access over the local server: the server does the compare-and-swap, the repository is implicit
 * (the one the CLI was started in). Every failure keeps the server's `code`/`params` so the UI can localize it. */
(function (root) {
  'use strict';
  const serverError = (code, params = {}) => Object.assign(new Error(code), { code, params });
  const fromPayload = (payload, fallbackCode, fallbackParams) => {
    if (payload.code) return Object.assign(new Error(payload.error), { code: payload.code, params: payload.params ?? {}, text: payload.text });
    if (payload.error) return Object.assign(new Error(payload.error), { code: null, params: {}, text: payload.text });
    return serverError(fallbackCode, fallbackParams);
  };
  class RegistryStore {
    constructor(base = '') { this.base = base; this.tail = Promise.resolve(); this.layout = null; }
    async fetchJson(url, init, offlineCode) {
      let response;
      try { response = await fetch(`${this.base}${url}`, { cache: 'no-store', ...init }); }
      catch { throw serverError(offlineCode); }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw fromPayload(payload, 'server_status', { status: response.status });
      return payload;
    }
    request(name, init) { return this.fetchJson(`/api/file/${name.split('/').map(encodeURIComponent).join('/')}`, init, 'offline'); }
    async read(name) {
      const { text } = await this.request(name);
      if (text === null) throw Object.assign(serverError('not_found', { name }), { name: 'NotFoundError' });
      return text;
    }
    async optional(name) { try { return await this.read(name); } catch (error) { if (error.name === 'NotFoundError') return null; throw error; } }
    // One request for the whole registry (registry, archive, every task's comments) plus the layout.
    async readAll() {
      const payload = await this.fetchJson('/api/registry', {}, 'offline');
      this.layout = payload.layout;
      this.liveAssignees = payload.liveAssignees ?? {};
      if (payload.files?.registry == null) throw Object.assign(serverError('no_registry'), { name: 'NotFoundError' });
      const files = { ...payload.files };
      if (files.archive === null) delete files.archive;
      return files;
    }
    source(relative) { return this.fetchJson(`/api/source/${relative.split('/').map(encodeURIComponent).join('/')}`, {}, 'offline'); }
    commit(hash) { return this.fetchJson(`/api/commit/${encodeURIComponent(hash)}`, {}, 'offline'); }
    // The server validates the fields and commits only the registry files just written, never unrelated changes.
    recordChange(operation, taskIds, title, files = ['registry']) {
      return this.fetchJson('/api/git/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, taskIds: [].concat(taskIds), title, files }) }, 'offline_commit');
    }
    // Attachments: the PUT body is the raw file; the server resolves name clashes, commits and returns the final name.
    async listFiles(taskId) { return (await this.fetchJson(`/api/files/${encodeURIComponent(taskId)}`, {}, 'offline_list')).files; }
    uploadFile(taskId, file, name) {
      return this.fetchJson(`/api/files/${encodeURIComponent(taskId)}/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: file }, 'offline_upload');
    }
    deleteFile(taskId, name) {
      return this.fetchJson(`/api/files/${encodeURIComponent(taskId)}/${encodeURIComponent(name)}`, { method: 'DELETE' }, 'offline_delete');
    }
    // Shared-branch mode (#210): a no-op {shared:false} in the legacy layout, so callers don't need to
    // check `this.layout.shared` themselves before calling these.
    gitStatus() { return this.fetchJson('/api/git/status', {}, 'offline'); }
    gitFetch() { return this.fetchJson('/api/git/fetch', { method: 'POST' }, 'offline'); }
    gitSync() { return this.fetchJson('/api/git/sync', { method: 'POST' }, 'offline'); }
    write(name, text, expected) {
      const operation = this.tail.catch(() => {}).then(() => this.request(name, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, expected: expected ?? null })
      }));
      this.tail = operation;
      return operation.then(() => {});
    }
  }
  root.RegistryStore = RegistryStore;
  if (typeof module !== 'undefined') module.exports = RegistryStore;
})(globalThis);
