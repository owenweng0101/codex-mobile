import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { realpath } from 'node:fs/promises';
import { TerminalManager } from '../terminal.mjs';

function fixture(options = {}) {
  const children = [];
  const manager = new TerminalManager({ ...options, spawnProcess() {
    const child = new EventEmitter(); child.pid = 12000 + children.length;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.messages = [];
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const message = JSON.parse(chunk.toString()); child.messages.push(message); done();
      if (message.type === 'write' && options.ack !== false) queueMicrotask(() => child.ack(message.requestId));
    } });
    child.ack = requestId => child.stdout.write(JSON.stringify({ type:'writeAck', requestId, ok:true })+'\n');
    child.output = text => child.stdout.write(JSON.stringify({type:'data',data:Buffer.from(text).toString('base64')})+'\n');
    child.kill = signal => { child.killedWith = signal; return true; };
    children.push(child); queueMicrotask(() => child.stdout.write('{"type":"ready"}\n')); return child;
  } });
  const finish = () => { manager.closeAll(); for (const child of children) child.emit('exit', 0); };
  const query = new URLSearchParams({threadId:'fixture-thread'});
  const post = data => manager.handle('POST', query, data, () => '/tmp');
  return {manager,children,finish,query,post};
}

test('explicit tab creation is concurrently idempotent and distinct tabs get distinct PTYs', async () => {
  const f=fixture();try {
    const values=await Promise.all(Array.from({length:8},()=>f.post({action:'create',tabId:'tab-one'})));
    assert.equal(new Set(values.map(v=>v.id)).size,1);assert.equal(f.children.length,1);
    const other=await f.post({action:'create',tabId:'tab-two'});assert.notEqual(other.id,values[0].id);assert.equal(f.children.length,2);
    const legacy=await f.post({action:'create'}),again=await f.post({action:'create'});assert.equal(legacy.id,again.id);assert.notEqual(legacy.id,other.id);
    assert.equal(f.manager.summary().livePTYCount,3);
  }finally{f.finish();}
});

test('list and exact-ID attach/read/write/close are confined to both canonical root and scope', async () => {
  const f=fixture();try {
    const first=await f.post({action:'create',tabId:'one'});
    const secondQuery=new URLSearchParams({threadId:'other-thread'});
    const second=await f.manager.handle('POST',secondQuery,{action:'create',tabId:'one'},()=>'/tmp');
    const listed=await f.manager.handle('GET',new URLSearchParams({threadId:'fixture-thread',action:'list'}),{},()=>'/tmp');
    assert.deepEqual(listed.sessions.map(s=>s.id),[first.id]);assert.equal(JSON.stringify(listed).includes('child'),false);
    for(const action of ['attach','write','resize','close'])await assert.rejects(f.manager.handle('POST',secondQuery,{action,id:first.id,data:'x',chunkId:'chunk-one'},()=>'/tmp'),{code:'TERMINAL_NOT_FOUND'});
    await assert.rejects(f.manager.handle('GET',new URLSearchParams({threadId:'other-thread',id:first.id,wait:'0'}),{},()=>'/tmp'),{code:'TERMINAL_NOT_FOUND'});
    await assert.rejects(f.manager.handle('POST',f.query,{action:'attach',id:first.id},()=>'/var'),{code:'TERMINAL_NOT_FOUND'});
    const attached=await f.post({action:'attach',id:first.id});assert.equal(attached.id,first.id);assert.equal(f.children.length,2);assert.notEqual(second.id,first.id);
  }finally{f.finish();}
});

test('same chunk concurrent writes and lost-response retries are delivered to PTY exactly once', async()=>{
  const f=fixture();try{
    const s=await f.post({action:'create',tabId:'one'});
    const data={action:'write',id:s.id,chunkId:'chunk-same',data:'printf hello\r'};
    const [a,b]=await Promise.all([f.post(data),f.post(data)]);assert.equal(a.acknowledged,true);assert.equal(b.acknowledged,true);
    const retry=await f.post(data);assert.equal(retry.duplicate,true);
    assert.equal(f.children[0].messages.filter(m=>m.type==='write').length,1);
    await assert.rejects(f.post({...data,data:'other command\r'}),/不能更换/);
    assert.equal(f.children[0].messages.filter(m=>m.type==='write').length,1);
  }finally{f.finish();}
});

test('unknown write is never replayed, but a late genuine PTY ACK can settle read-only retry', async()=>{
  const f=fixture({ack:false,writeTimeoutMs:15});try{
    const s=await f.post({action:'create',tabId:'one'}),data={action:'write',id:s.id,chunkId:'chunk-late',data:'one\r'};
    await assert.rejects(f.post(data),e=>e.code==='TERMINAL_WRITE_UNKNOWN'&&e.outcomeUnknown);
    await assert.rejects(f.post(data),{code:'TERMINAL_WRITE_UNKNOWN'});
    const writes=f.children[0].messages.filter(m=>m.type==='write');assert.equal(writes.length,1);
    f.children[0].ack(writes[0].requestId);
    const result=await f.post(data);assert.equal(result.acknowledged,true);assert.equal(result.duplicate,true);
    assert.equal(f.children[0].messages.filter(m=>m.type==='write').length,1);
  }finally{f.finish();}
});

test('detach/rebind never creates or writes; output cursor replay has no command replay', async()=>{
  const f=fixture();try{
    const s=await f.post({action:'create',tabId:'one'});f.children[0].output('first\n');f.children[0].output('second\n');
    const attached=await f.post({action:'attach',id:s.id});assert.equal(attached.sequence,2);
    const replay=await f.manager.handle('GET',new URLSearchParams({threadId:'fixture-thread',id:s.id,since:'0',wait:'0'}),{},()=>'/tmp');assert.equal(replay.frames.length,2);
    const incremental=await f.manager.handle('GET',new URLSearchParams({threadId:'fixture-thread',id:s.id,since:'1',wait:'0'}),{},()=>'/tmp');assert.equal(incremental.frames.length,1);
    assert.equal(f.children.length,1);assert.equal(f.children[0].messages.filter(m=>m.type==='write').length,0);
    for(let n=0;n<260;n++)f.children[0].output('frame');
    const gap=await f.manager.handle('GET',new URLSearchParams({threadId:'fixture-thread',id:s.id,since:'1',wait:'0'}),{},()=>'/tmp');assert.equal(gap.reset,true);
  }finally{f.finish();}
});

test('explicit end leaves creation tombstone, and updates wait for actual supervisor exit',async()=>{
  const f=fixture();try{
    const s=await f.post({action:'create',tabId:'one'});
    assert.throws(()=>f.manager.prepareUpdate(),{code:'TERMINALS_ACTIVE'});assert.equal(f.manager.summary().draining,false);
    await f.post({action:'close',id:s.id});assert.equal(f.manager.summary().livePTYCount,1);
    const duplicate=await f.post({action:'create',tabId:'one'});assert.equal(duplicate.id,s.id);assert.equal(duplicate.closed,true);assert.equal(f.children.length,1);
    await assert.rejects(f.post({action:'attach',id:s.id}),{code:'TERMINAL_NOT_FOUND'});
    f.children[0].emit('exit',0);assert.equal(f.manager.summary().livePTYCount,0);
    const drain=f.manager.prepareUpdate();await assert.rejects(f.post({action:'create',tabId:'two'}),{code:'UPDATE_DRAIN_ACTIVE'});
    assert.deepEqual(f.manager.cancelUpdate('wrong'),{released:false});assert.deepEqual(f.manager.cancelUpdate(drain.token),{released:true});
    const next=await f.post({action:'create',tabId:'two'});assert.notEqual(next.id,s.id);
  }finally{f.finish();}
});

test('drain still closes the async pre-spawn race and expires without killing any PTY',async()=>{
  const f=fixture({drainTtlMs:15});try{
    const creating=f.manager.create('/tmp',80,24,{tabId:'one'});const d=f.manager.prepareUpdate();
    await assert.rejects(creating,{code:'UPDATE_DRAIN_ACTIVE'});assert.equal(f.children.length,0);
    await new Promise(resolve=>setTimeout(resolve,35));assert.equal(f.manager.summary().draining,false);
    const fresh=f.manager.prepareUpdate();assert.deepEqual(f.manager.cancelUpdate(d.token),{released:false});f.manager.cancelUpdate(fresh.token);
  }finally{f.finish();}
});

test('strict tab/chunk IDs, UTF8 byte limits and four live supervisor cap are enforced',async()=>{
  const f=fixture();try{
    await assert.rejects(f.post({action:'create',tabId:'../bad'}),/标签标识/);
    const s=await f.post({action:'create',tabId:'one'});
    await assert.rejects(f.post({action:'write',id:s.id,data:'x',chunkId:'../bad'}),/输入标识/);
    await assert.rejects(f.post({action:'write',id:s.id,data:'中'.repeat(30000),chunkId:'chunk-big'}),/过长/);
    await Promise.all(['two','three','four'].map(tabId=>f.post({action:'create',tabId})));
    await assert.rejects(f.post({action:'create',tabId:'five'}),/最多同时打开 4/);assert.equal(f.children.length,4);
    assert.equal((await f.post({action:'create',tabId:'one'})).id,s.id);
  }finally{f.finish();}
});

test('legacy default get-or-create reuses live shell and can create again after explicit end',async()=>{
  const f=fixture();try{
    const first=await f.post({action:'create'});assert.equal((await f.post({action:'create'})).id,first.id);
    await f.post({action:'close',id:first.id});f.children[0].emit('exit',0);
    const second=await f.post({action:'create'});assert.notEqual(second.id,first.id);assert.equal(second.closed,false);
  }finally{f.finish();}
});
