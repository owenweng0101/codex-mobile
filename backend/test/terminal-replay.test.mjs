import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { TerminalManager } from '../terminal.mjs';

function fixture({failResize=false,failBeforeReady=false}={}){
 const children=[];
 const manager=new TerminalManager({spawnProcess(command,args){
  const child=new EventEmitter();child.pid=23450+children.length;child.stdout=new PassThrough();child.stderr=new PassThrough();child.messages=[];
  child.event=value=>child.stdout.write(JSON.stringify(value)+'\n');
  child.resize=(cols,rows,ok=true)=>{child.event({type:'resize',cols,rows});child.event({type:'resizeResult',ok});};
  child.output=text=>child.event({type:'data',data:Buffer.from(text).toString('base64')});
  child.stdin=new Writable({write(chunk,encoding,done){const message=JSON.parse(chunk.toString());child.messages.push(message);done();if(message.type==='resize')child.resize(message.cols,message.rows,!failResize);if(message.type==='write')child.event({type:'writeAck',requestId:message.requestId,ok:true});}});
  child.kill=()=>true;children.push(child);
  queueMicrotask(()=>{child.resize(Number(args[4]),Number(args[5]));if(failBeforeReady)child.emit('exit',1);else child.event({type:'ready'});});return child;
 }});
 const query=new URLSearchParams({threadId:'fixture-replay-thread'});
 const post=data=>manager.handle('POST',query,data,()=>'/tmp');
 const read=(id,since=0)=>manager.handle('GET',new URLSearchParams({threadId:'fixture-replay-thread',id,since:String(since),wait:'0'}),{},()=>'/tmp');
 const finish=()=>{manager.closeAll();for(const child of children)child.emit('exit',0);};
 return{manager,children,post,read,finish};
}

test('initial successful size is frame one before shell data, with legacy data frame shape preserved',async()=>{
 const f=fixture();try{
  const created=await f.post({action:'create',tabId:'one',cols:40,rows:12});assert.deepEqual(created.initialSize,{cols:40,rows:12});
  f.children[0].output('MOBILE_ONE\n');const result=await f.read(created.id);
  assert.deepEqual(result.frames[0],{id:1,data:'',type:'resize',cols:40,rows:12});
  assert.equal(Buffer.concat(result.frames.map(frame=>Buffer.from(frame.data,'base64'))).toString(),'MOBILE_ONE\n');
  assert.deepEqual(result.frames[1],{id:2,data:Buffer.from('MOBILE_ONE\n').toString('base64')});assert.deepEqual(result.initialSize,{cols:40,rows:12});
 }finally{f.finish();}
});

test('resize candidates are unnumbered until ioctl confirmation, failure never appears as successful resize',async()=>{
 const f=fixture({failResize:true});try{
  const s=await f.post({action:'create',tabId:'one'}),child=f.children[0];const before=(await f.read(s.id)).sequence;
  child.event({type:'resize',cols:55,rows:17});assert.equal((await f.read(s.id)).sequence,before);
  child.event({type:'resizeResult',ok:false});assert.equal((await f.read(s.id)).sequence,before);
  await f.post({action:'resize',id:s.id,cols:90,rows:25});assert.equal((await f.read(s.id)).sequence,before);
  assert.deepEqual((await f.read(s.id)).currentSize,{cols:80,rows:24});
  child.resize(60,18,true);child.output('redraw');const page=await f.read(s.id,before);
  assert.deepEqual(page.frames.map(frame=>frame.type||'data'),['resize','data']);assert.deepEqual(page.currentSize,{cols:60,rows:18});
 }finally{f.finish();}
});

test('continuous resize and output share one monotonic cursor and exact since pagination order',async()=>{
 const f=fixture();try{
  const s=await f.post({action:'create',tabId:'one',cols:37,rows:11}),child=f.children[0];child.output('before');
  await f.post({action:'resize',id:s.id,cols:55,rows:17});child.output('after-one');
  await f.post({action:'resize',id:s.id,cols:70,rows:21});child.output('after-two');
  const all=await f.read(s.id);assert.deepEqual(all.frames.map(frame=>frame.id),[1,2,3,4,5,6]);
  assert.deepEqual(all.frames.map(frame=>frame.type||'data'),['resize','data','resize','data','resize','data']);
  const next=await f.read(s.id,2);assert.deepEqual(next.frames,all.frames.slice(2));assert.equal(next.sequence,6);assert.equal(next.reset,false);
  assert.deepEqual((await f.read(s.id,6)).frames,[]);
 }finally{f.finish();}
});

test('ring trims resize and data together, preserving the effective size before its retained prefix',async()=>{
 const f=fixture();try{
  const s=await f.post({action:'create',tabId:'one',cols:40,rows:12}),child=f.children[0];child.output('old');
  child.resize(60,18);for(let n=0;n<260;n++)child.output('frame-'+n);
  const page=await f.read(s.id,1),session=f.manager.sessions.get(s.id);
  assert.equal(page.frames.length,256);assert.equal(page.reset,true);assert.deepEqual(page.replaySize,{cols:60,rows:18});assert.deepEqual(page.initialSize,{cols:40,rows:12});assert.deepEqual(page.currentSize,{cols:60,rows:18});
  assert.equal(page.frames[0].type,undefined);assert.equal(session.bytes,page.frames.reduce((n,frame)=>n+(frame.data?.length||0),0));
  child.resize(70,20);child.output('x'.repeat(530000));const capped=await f.read(s.id,0);assert.ok(session.bytes<=700000);assert.deepEqual(capped.replaySize,{cols:70,rows:20});assert.equal(capped.currentSize.cols,70);
 }finally{f.finish();}
});

test('pre-ready supervisor failure rejects creation even if an initial resize frame was already emitted',async()=>{
 const f=fixture({failBeforeReady:true});try{await assert.rejects(f.post({action:'create',tabId:'one'}),/无法启动/);assert.equal(f.manager.summary().livePTYCount,0);}finally{f.finish();}
});

test('write ACK deduplication, explicit tab identity, scope and actual-exit update protection remain intact',async()=>{
 const f=fixture();try{
  const [a,b]=await Promise.all([f.post({action:'create',tabId:'one'}),f.post({action:'create',tabId:'one'})]);assert.equal(a.id,b.id);assert.equal(f.children.length,1);
  const data={action:'write',id:a.id,chunkId:'fixture-input',data:'one\r'};assert.equal((await f.post(data)).acknowledged,true);assert.equal((await f.post(data)).duplicate,true);assert.equal(f.children[0].messages.filter(m=>m.type==='write').length,1);
  await assert.rejects(f.manager.handle('POST',new URLSearchParams({threadId:'wrong'}),{action:'attach',id:a.id},()=>'/tmp'),{code:'TERMINAL_NOT_FOUND'});
  assert.throws(()=>f.manager.prepareUpdate(),{code:'TERMINALS_ACTIVE'});await f.post({action:'close',id:a.id});assert.equal(f.manager.summary().livePTYCount,1);f.children[0].emit('exit',0);
  const drain=f.manager.prepareUpdate();await assert.rejects(f.post({action:'create',tabId:'two'}),{code:'UPDATE_DRAIN_ACTIVE'});f.manager.cancelUpdate(drain.token);
 }finally{f.finish();}
});
