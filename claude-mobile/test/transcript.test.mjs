import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTranscript} from '../backend/lib/sessions.mjs';
const start='2026-11-13T00:00:00Z',end='2026-11-13T00:00:01Z';
const use={uuid:'use',type:'assistant',timestamp:start,message:{content:[{type:'tool_use',id:'tool',name:'Read',input:{file_path:'/tmp/a'}}]}};
const result={uuid:'result',type:'user',timestamp:end,message:{content:[{type:'tool_result',tool_use_id:'tool',is_error:true,content:'read failed'}]}};
test('incremental tool completions survive older assistant timestamp',()=>{const value=parseTranscript([use,result].map(JSON.stringify).join('\n'),'session',1);assert.equal(value.messages.length,0);assert.deepEqual(value.toolUpdates,[{id:'tool',text:'read failed',isError:true,seq:2,ts:end}]);assert.equal(value.cursor,2);});
test('full transcript preserves tool failure status and stable ids',()=>{const value=parseTranscript([use,result].map(JSON.stringify).join('\n'),'session');assert.equal(value.messages[0].id,'use');assert.equal(value.messages[0].tools[0].isError,true);assert.equal(value.messages[0].tools[0].result,'read failed');});
test('image-only user messages survive history loading',()=>{const record={uuid:'image',type:'user',timestamp:start,message:{content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'YWJj'}}]}};const value=parseTranscript(JSON.stringify(record),'session');assert.equal(value.messages.length,1);assert.equal(value.messages[0].attachments[0].url,'data:image/png;base64,YWJj');});


test('image coordinate companions do not become user messages or split the native reply',()=>{
 const raw=[{uuid:'peer-id',type:'user',isMeta:true,origin:{kind:'peer'},message:{content:'Another Claude session sent a message:\n看图\n\nThis came from another Claude session'},timestamp:'2026-11-13T01:00:00Z'},{uuid:'image-companion',type:'user',isMeta:true,turnCompanion:true,message:{content:'[Image: original 1179x2556, displayed at 923x2000.]'},timestamp:'2026-11-13T01:00:01Z'},{uuid:'reply',type:'assistant',message:{content:[{type:'text',text:'图片内容'}],stop_reason:'end_turn'},timestamp:'2026-11-13T01:00:02Z'}].map(x=>JSON.stringify(x)).join('\n');
 const result=parseTranscript(raw,'native');assert.deepEqual(result.messages.map(m=>[m.id,m.role]),[['peer-id','user'],['reply','assistant']]);assert.equal(result.messages[0].text,'看图');
});


test('native interrupt marker settles the same reply without becoming a user prompt',()=>{
 const raw=[{uuid:'prompt',type:'user',message:{content:'Count to 2000'},timestamp:'2026-11-13T01:00:00Z'},{uuid:'partial',type:'assistant',message:{content:[{type:'text',text:'1\n2\n3'}],stop_reason:null},timestamp:'2026-11-13T01:00:01Z'},{uuid:'native-interrupt',type:'user',message:{content:'[Request interrupted by user]'},timestamp:'2026-11-13T01:00:02Z'}].map(x=>JSON.stringify(x)).join('\n');
 const full=parseTranscript(raw,'native');assert.equal(full.currentUserId,'prompt');assert.equal(full.messages.filter(m=>m.role==='user').length,1);assert.equal(full.messages.at(-1).interrupted,true);assert.equal(full.messages.at(-1).terminal,true);
 const delta=parseTranscript(raw,'native',2);assert.equal(delta.messages.length,1);assert.equal(delta.messages[0].interrupted,true);assert.equal(delta.currentUserId,'prompt');
});


test('bootstrap model and rename commands stay out of visible phone history and its title',()=>{
 const contents=['<command-name>/model</command-name><command-args>native</command-args>','<local-command-stdout>Set model to native</local-command-stdout>','<command-name>/rename</command-name><command-args>Phone title</command-args>','<local-command-stdout>Session renamed to: Phone title</local-command-stdout>','Real user message'];
 const raw=contents.map((content,i)=>JSON.stringify({uuid:'id-'+i,type:'user',message:{content},timestamp:'2026-11-13T01:00:0'+i+'Z'})).join('\n');const result=parseTranscript(raw,'native');assert.equal(result.messages.length,1);assert.equal(result.title,'Real user message');assert.equal(result.currentUserId,'id-4');
});


test('native completed todos become completed rows instead of staying active forever',()=>{
 const raw=JSON.stringify({uuid:'todo',type:'assistant',message:{content:[{type:'tool_use',id:'write-todos',name:'TodoWrite',input:{todos:[{content:'完成的任务',status:'completed'},{content:'当前任务',status:'in_progress'},{content:'后续任务',status:'pending'}]}}]},timestamp:'2026-11-13T01:00:00Z'});
 const confirmed=JSON.stringify({uuid:'todo-result',type:'user',message:{content:[{type:'tool_result',tool_use_id:'write-todos',content:'Updated todos'}]}});
 const result=parseTranscript(raw+'\n'+confirmed,'native');assert.deepEqual(result.plan.map(x=>x.status),['done','in_progress','pending']);
 assert.equal(parseTranscript(raw,'native').plan,null,'unconfirmed tool calls do not become task state');
});

test('incremental poll beyond 400 new messages is marked truncated instead of silently dropping the middle',()=>{
 const total=601;
 const raw=Array.from({length:total},(_,i)=>JSON.stringify({uuid:'m-'+i,type:'user',message:{content:'消息 '+i}})).join('\n')+'\n';
 const delta=parseTranscript(raw,'native',1);
 assert.equal(delta.truncated,true,'两次轮询间新增 600 条时必须标记截断');
 assert.equal(delta.sinceTruncated,true,'增量缺口要显式标记，手机端据此整会话重载');
 assert.equal(delta.dropped,200,'被跳过的中间消息条数可见');
 assert.equal(delta.messages.length,400,'增量只回最后 400 条');
 assert.equal(delta.messages[0].seq,202,'中间的 201 条不会悄悄消失');
 assert.deepEqual(delta.messages.map(message=>message.seq),Array.from({length:400},(_,i)=>i+202));
 assert.equal(delta.cursor,total,'cursor 仍是文件尾，由手机端决定重载整份历史');
 const exact=parseTranscript(raw,'native',total-400);
 assert.equal(exact.messages.length,400);
 assert.equal(exact.truncated,false,'正好 400 条不标记截断');
 assert.equal(exact.sinceTruncated,false);
 assert.equal(exact.dropped,0);
 const full=parseTranscript(raw,'native');
 assert.equal(full.truncated,true,'整份读取仍标记只显示最近 400 条');
 assert.equal(full.sinceTruncated,false,'整份读取的截断是“还有更早历史”，不是增量缺口');
 const empty=parseTranscript(raw,'native',total);
 assert.deepEqual(empty.messages,[]);assert.equal(empty.truncated,false);assert.equal(empty.dropped,0);assert.equal(empty.cursor,total);
});

test('a human message queued mid-turn stays visible instead of only its reply',()=>{
 const lines=[
  {uuid:'u1',type:'user',message:{content:'第一条'},timestamp:'2026-11-13T01:00:00Z'},
  {uuid:'a1',type:'assistant',message:{content:[{type:'text',text:'处理中'}],stop_reason:null},timestamp:'2026-11-13T01:00:01Z'},
  {uuid:'q1',type:'attachment',attachment:{type:'queued_command',prompt:'桌面上补的一句话',commandMode:'prompt',origin:{kind:'human'},humanTurn:true,source_uuid:'u2'},timestamp:'2026-11-13T01:00:02Z'},
  {uuid:'a2',type:'assistant',message:{content:[{type:'text',text:'收到'}]},timestamp:'2026-11-13T01:00:03Z'},
  {uuid:'q2',type:'attachment',attachment:{type:'queued_command',prompt:[{type:'text',text:'<system-reminder>内部提示</system-reminder>'}],commandMode:'prompt',origin:{kind:'human'},humanTurn:true},timestamp:'2026-11-13T01:00:04Z'},
  {uuid:'u3',type:'user',message:{content:'补写后的同一句话'},timestamp:'2026-11-13T01:00:05Z'}
 ];
 const raw=lines.map(x=>JSON.stringify(x)).join('\n');
 const result=parseTranscript(raw,'native');
 const users=result.messages.filter(m=>m.role==='user').map(m=>m.text);
 assert.deepEqual(users,['第一条','桌面上补的一句话','补写后的同一句话'],'排队的桌面消息要显示，纯 system-reminder 不显示');
 const materialized=parseTranscript(lines.map(x=>JSON.stringify(x.uuid==='q1'?{...x,attachment:{...x.attachment,source_uuid:'u1'}}:x)).join('\n'),'native');
 assert.deepEqual(materialized.messages.filter(m=>m.role==='user').map(m=>m.text),['第一条','补写后的同一句话'],'已补写成 user 记录时不重复');
});

test('a half-written last line does not consume the poll cursor',()=>{
 const u1=JSON.stringify({uuid:'u1',type:'user',message:{content:'第一条'}});
 const a1=JSON.stringify({uuid:'a1',type:'assistant',message:{content:[{type:'text',text:'回复'}]}});
 const a2=JSON.stringify({uuid:'a2',type:'assistant',message:{content:[{type:'text',text:'正在写入'}]}});
 const partial=parseTranscript([u1,a1,a2.slice(0,30)].join('\n'),'native');
 assert.equal(partial.cursor,2,'未写完的行不推进游标');
 assert.equal(partial.messages.length,2);
 const complete=parseTranscript([u1,a1,a2].join('\n'),'native',partial.cursor);
 assert.deepEqual(complete.messages.map(m=>m.text),['正在写入'],'补全后能被下一次增量读到');
 assert.equal(complete.cursor,3);
});

test('a desktop-rewritten transcript resets the stale poll cursor instead of returning silence',()=>{
 const line=(i)=>JSON.stringify({uuid:'r-'+i,type:'user',message:{content:'重写后的消息 '+i}});
 const rewritten=Array.from({length:6},(_,i)=>line(i)).join('\n')+'\n';
 const stale=parseTranscript(rewritten,'native',900);
 assert.equal(stale.reset,true,'旧游标越过文件尾时必须要求整会话重载');
 assert.equal(stale.messages.length,6,'重载响应带回全部可见消息');
 assert.equal(stale.sinceTruncated,false,'重载不是增量缺口');
 assert.equal(stale.cursor,6);
 const current=parseTranscript(rewritten,'native',6);
 assert.equal(current.reset,undefined,'游标正好在文件尾时是正常空增量');
 assert.deepEqual(current.messages,[]);
});
