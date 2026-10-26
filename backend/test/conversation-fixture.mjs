import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rolloutItem} from '../core.mjs';
import {displayTurn} from '../view.mjs';
export const fixtureId='00000000-0000-4000-8000-000000000913';
export const fixtureThread={id:fixtureId,cwd:'/fixture/indexed-history',model:'fixture-model'};
export const event=payload=>JSON.stringify({type:'event_msg',payload})+'\n';
export function turnRecords(index,{items=2,complete=true}={}){
 const id='turn-'+index,raw=Array.from({length:items},(_,i)=>({id:'item-'+index+'-'+i,type:i===0?'UserMessage':'AgentMessage',...(i===0?{content:[{type:'text',text:'Question '+index}]}:{content:'Answer '+index+' '+i+' '+('字'.repeat(200))})}));
 const records=[event({type:'task_started',turn_id:id,started_at:index+1}),...raw.map(item=>event({type:'item_completed',turn_id:id,item})),...(complete?[event({type:'task_complete',turn_id:id,started_at:index+1,completed_at:index+2})]:[])];
 const turn=displayTurn({id,status:complete?'completed':'inProgress',startedAt:index+1,...(complete?{completedAt:index+2}:{}),items:raw.map(rolloutItem)},{threadId:fixtureId});
 return{id,raw,records,turn};
}
export async function conversationFixture(t,{turnCount=40,items=2}={}){
 const directory=await mkdtemp(join(tmpdir(),'codex-conversation-index-')),file=join(directory,'rollout.jsonl');t.after(()=>rm(directory,{recursive:true,force:true}));
 const turns=[],records=[];for(let i=0;i<turnCount;i++){const value=turnRecords(i,{items});turns.push(value.turn);records.push(...value.records);}
 const content=records.join('');await writeFile(file,content);
 return{file,turns,content,append:async value=>{await appendFile(file,value);}};
}
