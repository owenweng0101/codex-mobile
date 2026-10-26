import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageQueue } from '../queue.mjs';
async function settled(queue) { const deadline=Date.now()+2000; while(true){await queue.writes;if(!queue.running.size)return;if(Date.now()>deadline)throw new Error('queue did not settle');await new Promise(resolve=>setImmediate(resolve));} }

test('queue persists ordered edits, pauses and drains independently of a browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-')); let active = true; const sent = [];
  try {
    const queue = await new MessageQueue({ stateDir: dir, isActive: () => active, send: async data => { sent.push(data.requestId); active = true; } }).init();
    await queue.enqueue('task', { requestId: 'a', text: '第一条' }); await queue.enqueue('task', { requestId: 'b', text: '第二条' });
    assert.equal((await queue.enqueue('task', { requestId: 'a', text: '重复' })).duplicate, true);
    await queue.handle('task', { action: 'move', id: 'b', direction: 'up' }); await queue.handle('task', { action: 'edit', id: 'b', text: '修改后的第二条' });
    await queue.handle('task', { action: 'pause' }); active = false; queue.kick('task'); await settled(queue); assert.deepEqual(sent, []);
    await queue.handle('task', { action: 'resume' }); await settled(queue); assert.deepEqual(sent, ['b']); assert.deepEqual(queue.get('task').items.map(i => i.id), ['a']);
    active = false; queue.kick('task'); await settled(queue); assert.deepEqual(sent, ['b', 'a']); assert.equal(queue.get('task').items.length, 0);
    assert.equal((await queue.enqueue('task', { requestId: 'a', text: '重复' })).duplicate, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('queue preserves failed and interrupted sending records without silent replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-')); let fail = true;
  try {
    const queue = await new MessageQueue({ stateDir: dir, isActive: () => false, send: async () => { if (fail) throw new Error('离线'); } }).init();
    await queue.enqueue('task', { requestId: 'a', text: '消息' }); await settled(queue); assert.equal(queue.get('task').paused, true); assert.equal(queue.get('task').items[0].status, 'failed');
    fail = false; await queue.handle('task', { action: 'resume' }); await settled(queue); assert.equal(queue.get('task').items.length, 0);
    await writeFile(join(dir, 'message-queue.json'), JSON.stringify({ threads: { task: { paused: false, items: [{ id: 'b', requestId: 'b', text: '不确定', status: 'sending' }] } } }));
    const recovered = await new MessageQueue({ stateDir: dir, isActive: () => false, send: async () => assert.fail('must not replay') }).init(); recovered.kickAll(); await settled(recovered);
    assert.equal(recovered.get('task').items[0].status, 'uncertain'); await assert.rejects(recovered.handle('task', { action: 'resume' }), /状态未确认/);
    await recovered.handle('task', { action: 'remove', id: 'b' }); assert.equal(recovered.get('task').items.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('send now uses steer for an active turn without changing queue pause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-')); const calls = [];
  try {
    const queue = await new MessageQueue({ stateDir: dir, isActive: () => true, send: async (data, options) => calls.push({ id: data.id, steer: options.steer }) }).init();
    await queue.handle('task', { action: 'pause' }); await queue.enqueue('task', { requestId: 'a', text: '补充本轮' });
    await queue.handle('task', { action: 'sendNow', id: 'a' }); assert.deepEqual(calls, [{ id: 'a', steer: true }]); assert.equal(queue.get('task').paused, true); assert.equal(queue.get('task').items.length, 0);
    await assert.rejects(queue.enqueue('__proto__', { requestId: 'x', text: 'x' }), /无效/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for(const unknown of [false,true])test('send now falls back only when the active turn ended with definite non-delivery, unknown='+unknown,async t=>{const dir=await mkdtemp(join(tmpdir(),'codex-queue-race-'));t.after(()=>rm(dir,{recursive:true,force:true}));const calls=[],queue=await new MessageQueue({stateDir:dir,isActive:()=>true,send:async(data,{steer})=>{calls.push({requestId:data.requestId,steer});if(steer)throw Object.assign(Error('ended'),{code:'TURN_ENDED',sent:false,outcomeUnknown:unknown});}}).init();await queue.enqueue('task',{requestId:'same-request',text:'next'});await queue.handle('task',{action:'sendNow',id:'same-request'});assert.equal(calls.length,unknown?1:2);assert(calls.every(c=>c.requestId==='same-request'));assert.deepEqual(queue.get('task').items.map(i=>i.status),unknown?['uncertain']:[]);if(!unknown)assert.equal(calls[1].steer,false);});
