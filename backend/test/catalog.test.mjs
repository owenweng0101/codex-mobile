import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogCache, includePersistedCreations } from '../catalog.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const fixture = (id = 'a') => ({ projects: [{ id: 'project', name: '项目', roots: ['/tmp/workspace'] }], threads: [{ id, name: '任务 ' + id, preview: '用户请求', cwd: '/tmp/workspace', updatedAt: 100, mobileProjectId: 'project', status: { type: 'idle' }, turns: [{ rawSecret: 'never-store-history' }], authToken: 'never-store-auth' }] });

test('persisted empty creations stay visible only when native read confirms an unarchived thread',async()=>{
  const reads=[];const rows=await includePersistedCreations([{id:'listed'}],['listed','empty','archived','missing'],async id=>{reads.push(id);if(id==='missing')throw Error('deleted');return{id,path:id==='archived'?'/x/archived_sessions/a':'/x/sessions/a'};});
  assert.deepEqual(rows.map(x=>x.id),['listed','empty']);assert.deepEqual(reads,['empty','archived','missing']);
});

test('slow catalog reads deduplicate; stale reads return immediately and forced refresh waits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-catalog-')); let time = 1000, calls = 0; const gates = [];
  const cache = await new CatalogCache({ stateDir: root, now: () => time, load: () => { calls++; return new Promise(resolve => gates.push(resolve)); } }).init();
  try {
    const first = cache.get(), parallel = cache.get(); assert.equal(calls, 1); gates[0](fixture('a')); await Promise.all([first, parallel]);
    time += 16000; const stale = await cache.get(); assert.equal(stale.threads[0].id, 'a'); assert.equal(stale.stale, true); assert.equal(calls, 2);
    let finished = false; const forced = cache.get(true).then(value => { finished = true; return value; }); await tick(); assert.equal(finished, false); assert.equal(calls, 2);
    gates[1](fixture('b')); const fresh = await forced; assert.equal(fresh.threads[0].id, 'b'); assert.equal(fresh.stale, false); assert.equal(fresh.refreshing, false);
  } finally { await cache.writes; await rm(root, { recursive: true, force: true }); }
});

test('a mutation keeps its optimistic list and fences an already-running stale scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-catalog-')); const gates = []; let calls = 0;
  const cache = await new CatalogCache({ stateDir: root, load: () => { calls++; return new Promise(resolve => gates.push(resolve)); } }).init();
  try {
    const first = cache.get(); gates[0](fixture('a')); await first;
    const forced = cache.get(true); cache.invalidate({ remove: 'a', upsert: fixture('b').threads[0] });
    const optimistic = await cache.get(); assert.deepEqual(optimistic.threads.map(t => t.id), ['b']); assert.equal(optimistic.projects[0].count, 1);
    gates[1](fixture('a')); await tick(); assert.equal(calls, 3);
    assert.deepEqual((await cache.get()).threads.map(t => t.id), ['b']); gates[2](fixture('b'));
    assert.deepEqual((await forced).threads.map(t => t.id), ['b']);
  } finally { await cache.writes; await rm(root, { recursive: true, force: true }); }
});

test('private atomic disk metadata survives restart without caching history or credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-catalog-')); let release;
  try {
    const first = await new CatalogCache({ stateDir: root, load: async () => fixture() }).init(); await first.get();
    const saved = await readFile(first.path, 'utf8'); assert.equal(saved.includes('never-store-history'), false); assert.equal(saved.includes('never-store-auth'), false);
    assert.equal((await stat(first.dir)).mode & 0o777, 0o700); assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    const restarted = await new CatalogCache({ stateDir: root, load: () => new Promise(resolve => { release = resolve; }) }).init();
    const restored = await restarted.get(); assert.equal(restored.threads[0].id, 'a'); assert.equal(restored.stale, true);
    release(fixture('b')); await restarted.inflight; assert.equal((await restarted.get()).threads[0].id, 'b');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refresh failures retain usable metadata and explicit refresh still reports the failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-catalog-')); let time = 1000, fail = false, calls = 0;
  const cache = await new CatalogCache({ stateDir: root, now: () => time, load: async () => { calls++; if (fail) throw new Error('offline'); return fixture(); } }).init();
  try {
    await cache.get(); fail = true; time += 16000; assert.equal((await cache.get()).threads[0].id, 'a'); await tick();
    const failedCalls = calls; assert.equal((await cache.get()).threads[0].id, 'a'); assert.equal(calls, failedCalls);
    await assert.rejects(cache.get(true), /offline/); assert.equal((await cache.get()).threads[0].id, 'a');
  } finally { await cache.writes; await rm(root, { recursive: true, force: true }); }
});

test('an explicitly restored thread clears its archive tombstone before the catalog refresh',async()=>{
  const root=await mkdtemp(join(tmpdir(),'codex-catalog-'));let rows=fixture();
  const cache=await new CatalogCache({stateDir:root,load:async()=>rows}).init();
  try{await cache.get();rows={...fixture(),threads:[]};cache.invalidate({remove:'a'});await cache.inflight;assert.equal((await cache.get()).threads.length,0);
    rows=fixture();cache.removed.set('a',Date.now());cache.invalidate({upsert:rows.threads[0]});await cache.inflight;assert.equal(cache.removed.has('a'),false);assert.equal((await cache.get()).threads[0].id,'a');
  }finally{await cache.writes;await rm(root,{recursive:true,force:true});}
});
