import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const bundle=await readFile(new URL('./assets/index-BsmXQHMM.js',import.meta.url),'utf8');
const start=bundle.indexOf('Jr=(0,Q.useCallback)(async(e,t,n,r)=>{');
const end=bundle.indexOf(',[Wr,je.taskGroupService,Gr,Oe,Kr,qr,m,Or,l,c])',start);
assert(start>0&&end>start);
const source=bundle.slice(start+'Jr=(0,Q.useCallback)('.length,end);
function fixture({commit=true,fail=false}={}){
 const calls=[],toasts=[];
 const context={qe:{current:null},Or:id=>calls.push(['open',id]),m:null,c:'/conversations',l:undefined,ua:()=>null,
  qr:()=>{},Kr:{controller:new AbortController()},Gr:()=>calls.push(['refresh']),
  Oe:{formatMessage:({id})=>id},J:{error(){}},lo:(message,options)=>toasts.push({message,...options}),
  je:{taskGroupService:{admit:async params=>{calls.push(['admit',params]);if(fail)throw Error('Task was not found in the actual Codex catalog');}}},
  Wr:commit?async(task,open,signal,place)=>{await place?.();open();}:undefined};
 return{run:vm.runInNewContext('('+source+')',context),calls,toasts};
}
for(const commit of [true,false])for(const group of [null,undefined])test(`unselected group opens the created conversation without admission (commit=${commit}, group=${group})`,async()=>{
 const f=fixture({commit,fail:true});await f.run('created-id','draft','message-id',group);
 assert.deepEqual(f.calls,[['open','created-id']]);assert.equal(f.toasts.length,0);
});
test('an explicitly selected group still receives placement',async()=>{
 const f=fixture();await f.run('created-id','draft','message-id','group-1');
 assert.equal(f.calls[0][0],'admit');assert.equal(f.calls[0][1].placement.groupId,'group-1');
 assert.equal(f.calls[0][1].placement.creationId,'message-id');assert.deepEqual(f.calls.at(-1),['open','created-id']);assert.equal(f.toasts.length,0);
});
test('real placement failure remains retryable but its notice expires',async()=>{
 const f=fixture({fail:true});await f.run('created-id','draft','message-id','group-1');
 assert.deepEqual(f.calls.at(-1),['open','created-id']);assert.equal(f.toasts.length,1);
 assert.equal(f.toasts[0].durationMs,5000);assert.equal(typeof f.toasts[0].onAction,'function');
 f.toasts[0].onAction();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls.filter(([name])=>name==='admit').length,2);
});
