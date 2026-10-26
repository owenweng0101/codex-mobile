import test from 'node:test';import assert from 'node:assert/strict';import{createQueuedAttachmentResolver}from'../queued-attachments.mjs';
test('queued image scope survives withdrawal but never crosses workspace or session',async()=>{
 const id='a'.repeat(48),sid='00000000-0000-0000-0000-000000000001';let items=[{attachments:[id]}],time=1;
 const resolve=createQueuedAttachmentResolver({now:()=>time,resolveUploaded:async()=>{throw Object.assign(Error('expired'),{code:'CODEX_ATTACHMENT_NOT_FOUND'});},api:{get:async()=>({thread:{id:sid,cwd:'/workspace'},queue:{threadId:sid,items}})}});
 const p={workspacePath:'/workspace',sessionId:sid,ref:'/api/attachment?id='+id};assert.deepEqual(await resolve(p),{id});items=[];assert.deepEqual(await resolve(p),{id});
 await assert.rejects(resolve({...p,workspacePath:'/foreign'}));await assert.rejects(resolve({...p,ref:'/api/attachment?id='+'b'.repeat(48)}));time+=31*60*1000;await assert.rejects(resolve(p));
});
