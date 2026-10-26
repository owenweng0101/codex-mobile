import { EventEmitter } from 'node:events';
import { mkdir, chmod, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const string = (value, limit = 200) => typeof value === 'string' ? value.slice(0, limit) : null;
export function catalogMetadata(input) {
  const projects = (input?.projects || []).slice(0, 200).filter(p => typeof p.id === 'string').map(p => ({ id: p.id, name: string(p.name), roots: (p.roots || []).filter(r => typeof r === 'string').slice(0, 20) }));
  const threads = (input?.threads || []).slice(0, 10000).filter(t => typeof t.id === 'string').map(t => ({ id: t.id, name: string(t.name), preview: string(t.preview) || '', cwd: string(t.cwd, 4096), updatedAt: Number(t.updatedAt) || 0, createdAt: Number(t.createdAt) || 0, status: typeof t.status === 'string' ? string(t.status, 50) : { type: string(t.status?.type, 50) || 'notLoaded' }, model: string(t.model, 100), projectId: string(t.projectId, 100), mobileProjectId: string(t.mobileProjectId, 100) }));
  threads.sort((a,b) => b.updatedAt - a.updatedAt);
  return { projects: projects.map(p => ({ ...p, count: threads.filter(t => t.mobileProjectId === p.id).length })), threads, truncated: !!input?.truncated };
}

export class CatalogCache extends EventEmitter {
  constructor({ stateDir, load, ttlMs = 15000, retryMs = 5000, now = Date.now }) {
    super(); this.dir = resolve(stateDir, 'cache'); this.path = resolve(this.dir, 'catalog.json'); this.load = load; this.ttlMs = ttlMs; this.retryMs = retryMs; this.now = now;
    this.value = null; this.version = 0; this.updatedAt = 0; this.revision = 0; this.dirty = true; this.inflight = null; this.writes = Promise.resolve(); this.lastFailureAt = null; this.removed = new Map();
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 }); await chmod(this.dir, 0o700);
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved.schemaVersion === 1 && Array.isArray(saved.data?.projects) && Array.isArray(saved.data?.threads)) {
        this.value = catalogMetadata(saved.data); this.updatedAt = Number(saved.updatedAt) || 0; this.version = Number(saved.version) || 0;
        for (const row of saved.removed || []) if (typeof row.id === 'string' && this.now() - row.at < 5 * 60 * 1000) this.removed.set(row.id, row.at);
      }
    } catch (error) { if (error.code !== 'ENOENT') this.emit('diagnostic', '目录缓存将重新读取'); }
    return this;
  }
  snapshot() { return this.value ? { ...this.value, time: this.updatedAt, version: this.version, stale: this.dirty || this.now() - this.updatedAt >= this.ttlMs, refreshing: !!this.inflight, updatedAt: this.updatedAt } : null; }
  get(force = false) {
    if (force || !this.value) return this.refresh().then(() => this.snapshot());
    if ((this.dirty || this.now() - this.updatedAt >= this.ttlMs) && (this.lastFailureAt == null || this.now() - this.lastFailureAt >= this.retryMs)) this.refresh().catch(() => {});
    return Promise.resolve(this.snapshot());
  }
  persist() {
    const data = JSON.stringify({ schemaVersion: 1, version: this.version, updatedAt: this.updatedAt, data: this.value, removed: [...this.removed].map(([id, at]) => ({ id, at })) });
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temporary = this.path + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp';
      try { await writeFile(temporary, data, { mode: 0o600 }); await rename(temporary, this.path); }
      finally { await rm(temporary, { force: true }); }
    });
    return this.writes;
  }
  invalidate({ upsert, remove, patch, project, removeProject } = {}) {
    this.revision++; this.dirty = true;
    if (remove) this.removed.set(remove, this.now());
    if (upsert) this.removed.delete(upsert.id);
    if (this.value && (upsert || remove || patch || project || removeProject)) {
      let threads = this.value.threads.filter(t => t.id !== remove);
      let projects = this.value.projects.filter(p => p.id !== removeProject);
      if (project) projects = [project, ...projects.filter(p => p.id !== project.id)];
      if (removeProject) threads = threads.map(t => t.mobileProjectId === removeProject ? { ...t, mobileProjectId:null, ...(t.projectId === removeProject ? { projectId:null } : {}) } : t);
      if (upsert) threads = [upsert, ...threads.filter(t => t.id !== upsert.id)];
      if (patch) threads = threads.map(t => t.id === patch.id ? { ...t, ...patch } : t);
      this.value = catalogMetadata({ ...this.value, threads, projects }); this.version++;
      this.persist().catch(() => this.emit('diagnostic', '目录缓存暂未写入'));
      this.emit('change', { version: this.version, updatedAt: this.updatedAt, stale: true });
    }
    this.refresh().catch(() => {});
  }
  refresh() {
    if (this.inflight) return this.inflight;
    const pending = (async () => {
      try {
        do {
          const revision = this.revision, loaded = catalogMetadata(await this.load());
          if (revision !== this.revision) continue;
          for (const [id, at] of this.removed) {
            if (!loaded.threads.some(t => t.id === id) || this.now() - at >= 5 * 60 * 1000) this.removed.delete(id);
            else loaded.threads = loaded.threads.filter(t => t.id !== id);
          }
          const next = catalogMetadata(loaded), changed = JSON.stringify(next) !== JSON.stringify(this.value);
          this.value = next; this.updatedAt = this.now(); this.dirty = false; this.lastFailureAt = null;
          if (changed) this.version++;
          await this.persist();
          if (changed) this.emit('change', { version: this.version, updatedAt: this.updatedAt, stale: this.dirty });
          if (revision === this.revision) return this.snapshot();
        } while (true);
      } catch (error) { this.lastFailureAt = this.now(); this.dirty = true; throw error; }
    })().finally(() => { if (this.inflight === pending) this.inflight = null; });
    this.inflight = pending; return pending;
  }
}
