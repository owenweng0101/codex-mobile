import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TerminalManager } from '../terminal.mjs';

// Only two self-created, short-lived PTYs in an AppSupport fixture. Never use
// Documents, a business workspace, or an existing manager/session.
test('real separate PTYs rebind by ID and deduplicate an acknowledged command without replay', {timeout:15000}, async()=>{
  const base=join(homedir(),'Library/Application Support/CodexMobile/terminal-fixtures');
  await mkdir(base,{recursive:true,mode:0o700});const directory=await mkdtemp(join(base,'tabs-'));
  const manager=new TerminalManager(),query=new URLSearchParams({threadId:'isolated-terminal-tabs-proof'});
  const post=data=>manager.handle('POST',query,data,()=>directory);
  const read=async(session,since=0)=>manager.handle('GET',new URLSearchParams({threadId:'isolated-terminal-tabs-proof',id:session.id,since:String(since),wait:'0'}),{},()=>directory);
  try{
    const [one,duplicate]=await Promise.all([post({action:'create',tabId:'fixture-tab-one'}),post({action:'create',tabId:'fixture-tab-one'})]);
    const two=await post({action:'create',tabId:'fixture-tab-two'});assert.equal(one.id,duplicate.id);assert.notEqual(one.id,two.id);
    const data={action:'write',id:one.id,chunkId:'fixture-chunk-one',data:"printf 'PTY_%s\\n' TAB_ONE\r"};
    const ack=await post(data);assert.equal(ack.acknowledged,true);assert.equal((await post(data)).duplicate,true);
    await post({action:'write',id:two.id,chunkId:'fixture-chunk-two',data:"printf 'PTY_%s\\n' TAB_TWO\r"});
    const outputs=new Map([[one.id,''],[two.id,'']]),cursors=new Map([[one.id,0],[two.id,0]]);
    for(let attempt=0;attempt<100;attempt++){
      for(const session of [one,two]){const page=await read(session,cursors.get(session.id));cursors.set(session.id,page.sequence);outputs.set(session.id,outputs.get(session.id)+Buffer.concat(page.frames.filter(f=>f.data).map(f=>Buffer.from(f.data,'base64'))).toString('utf8'));}
      if(outputs.get(one.id).includes('PTY_TAB_ONE')&&outputs.get(two.id).includes('PTY_TAB_TWO'))break;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert.equal(outputs.get(one.id).split('PTY_TAB_ONE').length-1,1);assert.equal(outputs.get(two.id).split('PTY_TAB_TWO').length-1,1);
    assert.equal(outputs.get(one.id).includes('PTY_TAB_TWO'),false);assert.equal(outputs.get(two.id).includes('PTY_TAB_ONE'),false);
    const rebound=await post({action:'attach',id:one.id});assert.equal(rebound.id,one.id);assert.equal(rebound.root,await realpath(directory));
    const listed=await manager.handle('GET',new URLSearchParams({threadId:'isolated-terminal-tabs-proof',action:'list'}),{},()=>directory);assert.equal(listed.sessions.length,2);
    assert.throws(()=>manager.prepareUpdate(),{code:'TERMINALS_ACTIVE'});
  }finally{
    manager.closeAll();
    for(let attempt=0;attempt<140&&manager.summary().livePTYCount;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(manager.summary().livePTYCount,0,'both fixture supervisors actually exited before cleanup');
    const prepared=manager.prepareUpdate();manager.cancelUpdate(prepared.token);
    await rm(directory,{recursive:true,force:true});
  }
});
