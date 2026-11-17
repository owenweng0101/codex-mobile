import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPlanOperation,NativePlanReducer} from '../backend/lib/native-plan.mjs';
import {runtimeStatus,nativeRuntimeObservation} from '../backend/lib/runtime-status.mjs';
import {parseTranscript} from '../backend/lib/sessions.mjs';

const update='mcp__ccd_turn__update_plan',wrap='mcp__ccd_turn__wrap_up';
const items=[{content:'接入',status:'in_progress'},{content:'验证',status:'pending'},{content:'交付',status:'pending'}];
const call=(id,name,input)=>({type:'assistant',uuid:'a-'+id,message:{role:'assistant',content:[{type:'tool_use',id,name,input}]}});
const result=(id,is_error=false)=>({type:'user',uuid:'r-'+id,message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content:'Plan updated',is_error}]}});
const jsonl=rows=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';

test('task snapshots, advance, done/start and wrap follow confirmed native tool results',()=>{
  const p=new NativePlanReducer();p.call('1',update,{items});assert.equal(p.plan,null);
  p.result('1');assert.equal(p.plan[0].status,'in_progress');
  p.call('2',update,{advance:true});p.result('2');p.result('2');
  assert.deepEqual(p.plan.map(i=>i.status),['done','in_progress','pending']);
  p.call('3',update,{done:[2],start:3});p.result('3');
  assert.deepEqual(p.plan.map(i=>i.status),['done','done','in_progress']);
  p.call('4',wrap,{});p.result('4',{isError:true});assert.equal(p.plan[2].status,'in_progress');
  p.call('5',wrap,{});p.result('5');assert.ok(p.plan.every(i=>i.status==='done'));
});

test('failed or duplicated task events do not invent task progress',()=>{
  const p=new NativePlanReducer();p.call('1',update,{items});p.result('1',{isError:true});assert.equal(p.plan,null);
  p.call('2',update,{items});p.result('2',{content:[{type:'text',text:'Error: not applied'}]});assert.equal(p.plan,null);
  assert.equal(applyPlanOperation(null,update,{advance:true}),null);
  const plan=applyPlanOperation(items,update,{done:[0,99],start:-1});assert.deepEqual(plan,items);
});

test('transcript incremental views carry complete confirmed task state',()=>{
  const rows=[call('1',update,{items}),result('1'),call('2',update,{advance:true}),result('2')];
  const value=parseTranscript(jsonl(rows),'session',3);
  assert.deepEqual(value.plan.map(i=>i.status),['done','in_progress','pending']);
  assert.equal(parseTranscript(jsonl([call('1',update,{items})]),'session').plan,null);
  const finished=parseTranscript(jsonl([...rows,call('3',wrap,{}),result('3')]),'session');
  assert.ok(finished.plan.every(i=>i.status==='done'));
});

test('a live idle process is not a running task and missing native clocks stay missing',()=>{
  assert.equal(runtimeStatus({attached:true,status:'idle',now:100}).running,false);
  const busy=runtimeStatus({attached:true,status:'busy',now:100});
  assert.equal(busy.phase,'running');assert.equal(busy.startedAtMs,null);assert.equal(busy.turnId,null);
  const detached=runtimeStatus({attached:false,status:'busy',now:100});
  assert.equal(detached.known,false);assert.equal(detached.running,false);
  assert.equal(runtimeStatus({attached:true,status:'busy',waitingFor:'permission prompt',now:100}).phase,'waiting');
});

test('duration is derived only from a matching observed native turn lifecycle',()=>{
  const observation={status:'running',turnId:'turn-1',startedAt:1000,endedAt:null,durationMs:null,updatedAt:1000};
  const running=runtimeStatus({attached:true,status:'busy',observation,now:9000});
  assert.equal(running.startedAtMs,1000);assert.equal(running.serverNowMs,9000);
  assert.equal(runtimeStatus({attached:true,status:'idle',observation,now:9000}).startedAtMs,null);
  const completed={...observation,status:'idle',endedAt:9000,durationMs:7500,updatedAt:9000};
  assert.equal(runtimeStatus({attached:true,status:'idle',observation:completed,now:10000}).durationMs,7500);
  assert.equal(runtimeStatus({attached:true,status:'busy',observation:completed,now:10000}).startedAtMs,null);
  assert.equal(nativeRuntimeObservation({...observation,startedAt:90000,updatedAt:90000},100),null);
});

test('queued desktop inputs retain stable source UUID and images until real user materializes',()=>{
  const queue={type:'attachment',uuid:'queue-row',attachment:{type:'queued_command',humanTurn:true,source_uuid:'native-user',prompt:[{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}}]}};
  const first=parseTranscript(jsonl([queue]),'s');
  assert.equal(first.messages[0].id,'native-user');assert.equal(first.messages[0].attachments.length,1);assert.equal(first.messages[0].queued,true);assert.equal(first.currentUserId,null,'queued input has not started a confirmed user turn');
  const real={type:'user',uuid:'native-user',message:{role:'user',content:'桌面输入'}};
  const full=parseTranscript(jsonl([queue,real]),'s');assert.equal(full.messages.filter(m=>m.role==='user').length,1);
  const delta=parseTranscript(jsonl([queue,real]),'s',first.cursor);
  assert.equal(delta.messages[0].id,first.messages[0].id);assert.notEqual(delta.messages[0].queued,true);assert.equal(delta.currentUserId,'native-user');
  const unrelated={type:'assistant',uuid:'native-user',message:{role:'assistant',content:'not a user'}};
  assert.equal(parseTranscript(jsonl([queue,unrelated]),'s').messages.filter(m=>m.role==='user').length,1);
});

test('explicit human/native-user input is not hidden merely for a system-looking prefix',()=>{
  for(const origin of [{kind:'human'},{kind:'plugin',name:'mobile-native-bridge',asUser:true}]){
    const text='<system-reminder>这是我粘贴的示例</system-reminder>';
    const value=parseTranscript(jsonl([{type:'user',uuid:'u',origin,message:{role:'user',content:text}}]),'s');
    assert.equal(value.messages.length,1);assert.equal(value.messages[0].text,text);
  }
});
