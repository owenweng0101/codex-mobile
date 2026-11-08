import test from 'node:test';
import assert from 'node:assert/strict';
import {threadMetadata} from '../thread-metadata.mjs';
const id='00000000-0000-0000-0000-000000000001';
test('metadata reads remain fresh and omit expensive/private history fields',async()=>{
 let archived=false,calls=0;
 const readThread=async()=>{calls++;return{id,cwd:'/workspace',path:archived?'/home/.codex/archived_sessions/a':'/home/.codex/sessions/a',turns:[{large:'history'}],preview:'private text'};};
 assert.deepEqual(await threadMetadata(id,{readThread}),{thread:{id,cwd:'/workspace',archived:false}});
 archived=true;
 assert.equal((await threadMetadata(id,{readThread})).thread.archived,true);
 assert.equal(calls,2);
});
test('draft metadata avoids native read; invalid and mismatched identities reject',async()=>{
 const drafts=new Map([[id,{id,cwd:'/draft'}]]);
 assert.deepEqual(await threadMetadata(id,{drafts,readThread:()=>{throw Error('must not read')}}),{thread:{id,cwd:'/draft',archived:false}});
 await assert.rejects(threadMetadata('../bad',{readThread:()=>{throw Error('must not read')}}),e=>e.statusCode===400);
 await assert.rejects(threadMetadata(id,{readThread:async()=>({id:'wrong',cwd:'/workspace'})}),e=>e.statusCode===409);
});
