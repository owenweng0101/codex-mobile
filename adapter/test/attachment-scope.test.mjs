import test from 'node:test';
import assert from 'node:assert/strict';
import {createAttachmentScope} from '../attachment-scope.mjs';
const id='00000000-0000-0000-0000-000000000001';
test('each upload authorization checks current metadata, never reads conversation history',async()=>{
 let archived=false,workspace='/workspace';const paths=[];
 const scope=createAttachmentScope({readTree:async()=>({tasks:[],projects:[{roots:[{rootPath:'/workspace'}]}]}),api:{get:async path=>{paths.push(path);return{thread:{id,cwd:workspace,archived}};}}});
 for(let i=0;i<8;i++)assert.equal(await scope({workspacePath:'/workspace'},id),true);
 assert.equal(paths.length,8);assert.ok(paths.every(p=>p==='/api/thread-metadata?threadId='+id));
 archived=true;await assert.rejects(scope({workspacePath:'/workspace'},id),/不属于/);
 archived=false;workspace='/elsewhere';await assert.rejects(scope({workspacePath:'/workspace'},id),/不属于/);
 const count=paths.length;await assert.rejects(scope({workspacePath:'/unauthorized'},id),/未授权/);assert.equal(paths.length,count);
});
test('draft workspace upload is still authorized without inventing native session metadata',async()=>{
 const scope=createAttachmentScope({readTree:async()=>({conversationWorkspacePath:'/draft',tasks:[]}),api:{get:()=>{throw Error('must not read');}}});
 assert.equal(await scope({workspacePath:'/draft'},'draft-new'),true);
});
