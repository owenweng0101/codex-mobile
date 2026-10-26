import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TerminalManager } from '../terminal.mjs';

// A new manager and one self-created AppSupport PTY only. No QA or production
// connection, business workspace, existing terminal, or protected directory.
test('real PTY records initial and later actual dimensions before their output and preserves since order', {timeout:15000},async()=>{
 const base=join(homedir(),'Library/Application Support/CodexMobile/terminal-fixtures');await mkdir(base,{recursive:true,mode:0o700});
 const directory=await mkdtemp(join(base,'replay-')),manager=new TerminalManager();
 const query=new URLSearchParams({threadId:'isolated-resize-replay-proof'}),post=data=>manager.handle('POST',query,data,()=>directory);
 let session;
 const read=(since=0)=>manager.handle('GET',new URLSearchParams({threadId:'isolated-resize-replay-proof',id:session.id,since:String(since),wait:'0'}),{},()=>directory);
 async function waitFor(marker){for(let attempt=0;attempt<100;attempt++){const page=await read(),text=Buffer.concat(page.frames.filter(f=>typeof f.data==='string').map(f=>Buffer.from(f.data,'base64'))).toString();if(text.includes(marker))return page;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('fixture output not observed');}
 try{
  session=await post({action:'create',tabId:'fixture-replay-tab',cols:37,rows:11});
  assert.deepEqual(session.initialSize,{cols:37,rows:11});
  await post({action:'write',id:session.id,chunkId:'fixture-size-one',data:"printf 'SIZE_A_%s\\n' \"$(stty size)\"; printf 'MOBILE_%s\\n' ONE\r"});
  const first=await waitFor('MOBILE_ONE');assert.deepEqual(first.frames[0],{id:1,data:'',type:'resize',cols:37,rows:11});
  assert.ok(Buffer.concat(first.frames.filter(f=>f.data).map(f=>Buffer.from(f.data,'base64'))).toString().includes('SIZE_A_11 37'));
  await post({action:'resize',id:session.id,cols:55,rows:17});
  await post({action:'write',id:session.id,chunkId:'fixture-size-two',data:"printf 'SIZE_B_%s\\n' \"$(stty size)\"; printf 'MOBILE_%s\\n' TWO\r"});
  await waitFor('SIZE_B_17 55');
  await post({action:'resize',id:session.id,cols:70,rows:21});
  await post({action:'write',id:session.id,chunkId:'fixture-size-three',data:"printf 'SIZE_C_%s\\n' \"$(stty size)\"\r"});
  const all=await waitFor('SIZE_C_21 70');
  const resizeB=all.frames.find(f=>f.type==='resize'&&f.cols===55),resizeC=all.frames.find(f=>f.type==='resize'&&f.cols===70);
  assert.ok(resizeB&&resizeC);assert.ok(resizeB.id<resizeC.id);assert.deepEqual(all.currentSize,{cols:70,rows:21});
  const textAfter=id=>Buffer.concat(all.frames.filter(f=>f.id>id&&f.data).map(f=>Buffer.from(f.data,'base64'))).toString();
  assert.ok(textAfter(resizeB.id).includes('SIZE_B_17 55'));assert.ok(textAfter(resizeC.id).includes('SIZE_C_21 70'));
  const later=await read(first.sequence);assert.deepEqual(later.frames,all.frames.filter(f=>f.id>first.sequence));
  const replay=await read(0);assert.ok(Buffer.concat(replay.frames.filter(f=>f.data).map(f=>Buffer.from(f.data,'base64'))).toString().includes('MOBILE_ONE'));assert.equal(replay.frames.filter(f=>f.type==='resize').length,3);
  assert.deepEqual(all.frames.map(f=>f.id),Array.from({length:all.frames.length},(_,i)=>i+1));
 }finally{
  manager.closeAll();for(let attempt=0;attempt<140&&manager.summary().livePTYCount;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(manager.summary().livePTYCount,0,'fixture supervisor actually exited');await rm(directory,{recursive:true,force:true});
 }
});
