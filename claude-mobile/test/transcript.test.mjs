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
 const result=parseTranscript(raw,'native');assert.deepEqual(result.plan.map(x=>x.status),['done','in_progress','pending']);
});
