import test from 'node:test';
import assert from 'node:assert/strict';
import {stat,writeFile,utimes} from 'node:fs/promises';
import {RolloutConversationIndex} from '../conversation-index.mjs';
import {projectConversationRows} from '../conversation-rows.mjs';
import {readRolloutPage} from '../core.mjs';
import {displayTurn} from '../view.mjs';
import {resolveMobileImagePath} from '../mobile-history-shared.mjs';
import {conversationFixture,fixtureId,fixtureThread,event,turnRecords} from './conversation-fixture.mjs';
const options={threadId:fixtureId,thread:fixtureThread};
test('cold metadata scan and warm exact row windows preserve the original global row identities',async t=>{
 const f=await conversationFixture(t),index=new RolloutConversationIndex(),expected=projectConversationRows({thread:fixtureThread,turns:f.turns});
 const recent=await index.read(f.file,options);assert.deepEqual(recent.rows.window,expected.slice(-60));assert.equal(recent.rows.totalCount,expected.length);assert.equal(recent.rows.firstRowId,1);assert.equal(recent.diagnostics.scannedBytes,Buffer.byteLength(f.content));
 const older=await index.read(f.file,{...options,beforeRowId:recent.rows.window[0].rowId,sourceEpoch:recent.sourceEpoch});assert.deepEqual(older.rows.window,expected.slice(0,60));assert.equal(older.diagnostics.scannedBytes,0);assert.equal(older.hasMore,false);
 const metadata=await index.read(f.file,{...options,metadataOnly:true});assert.deepEqual(metadata.rows.window,[]);assert.equal(metadata.diagnostics.bodyReadBytes,0);assert.equal(metadata.revision,recent.revision);
});
test('one thousand rows in one turn still reads and returns only the requested sixty row bodies',async t=>{
 const f=await conversationFixture(t,{turnCount:1,items:1000}),index=new RolloutConversationIndex(),page=await index.read(f.file,options),expected=projectConversationRows({thread:fixtureThread,turns:f.turns});
 assert.equal(page.rows.totalCount,1001);assert.equal(page.rows.window.length,60);assert.deepEqual(page.rows.window,expected.slice(-60));assert(page.diagnostics.bodyReadBytes<Buffer.byteLength(f.content)/10);
 const warm=await index.read(f.file,{...options,fromRowId:882});assert.equal(warm.rows.window.length,120);assert.deepEqual(warm.rows.window,expected.slice(881));assert.equal(warm.diagnostics.scannedBytes,0);
});
test('normal tail append consumes only appended records and preserves the layout epoch',async t=>{
 const f=await conversationFixture(t),index=new RolloutConversationIndex(),first=await index.read(f.file,options),next=turnRecords(40);await f.append(next.records.join(''));
 const updated=await index.read(f.file,options);assert.equal(updated.sourceEpoch,first.sourceEpoch);assert.equal(updated.diagnostics.scannedBytes,Buffer.byteLength(next.records.join('')));assert.equal(updated.rows.totalCount,first.rows.totalCount+3);assert.notEqual(updated.revision,first.revision);
});
test('non-display progress records do not invalidate a revision while logical item changes do',async t=>{
 const f=await conversationFixture(t),index=new RolloutConversationIndex(),initial=await index.read(f.file,options);
 await f.append(event({type:'token_count',turn_id:'turn-39',info:{total_token_usage:{input_tokens:123}}}));
 const progress=await index.read(f.file,{...options,metadataOnly:true});assert.equal(progress.revision,initial.revision);assert.equal(progress.sourceEpoch,initial.sourceEpoch);
 await f.append(event({type:'item_completed',turn_id:'turn-39',item:{id:'item-39-1',type:'AgentMessage',content:'A changed answer'}}));
 const changed=await index.read(f.file,{...options,metadataOnly:true});assert.notEqual(changed.revision,initial.revision);assert.equal(changed.sourceEpoch,initial.sourceEpoch);
});
test('a header inserted before an existing tail row changes epoch instead of silently reusing row ids',async t=>{
 const f=await conversationFixture(t,{turnCount:1});await writeFile(f.file,event({type:'task_started',turn_id:'late'})+event({type:'item_completed',turn_id:'late',item:{id:'answer',type:'AgentMessage',content:'visible'}}));
 const index=new RolloutConversationIndex(),first=await index.read(f.file,options);assert.equal(first.rows.totalCount,1);
 await f.append(event({type:'task_complete',turn_id:'late',started_at:1,completed_at:2}));const changed=await index.read(f.file,options);assert.notEqual(changed.sourceEpoch,first.sourceEpoch);assert.equal(changed.rows.totalCount,2);
 await assert.rejects(index.read(f.file,{...options,sourceEpoch:first.sourceEpoch,beforeRowId:2}),{code:'HISTORY_WINDOW_CHANGED'});
});
test('same-size middle rewrites and truncation invalidate old cursors; partial JSON is consumed only after newline',async t=>{
 const f=await conversationFixture(t),index=new RolloutConversationIndex(),first=await index.read(f.file,options),before=await stat(f.file);
 await writeFile(f.file,f.content.replace('Answer 20','Change 20'));await utimes(f.file,before.atime,new Date(before.mtimeMs+2000));
 const rewrite=await index.read(f.file,options);assert.notEqual(rewrite.sourceEpoch,first.sourceEpoch);
 await writeFile(f.file,f.content.slice(0,f.content.indexOf('\n')+1));const truncated=await index.read(f.file,options);assert.notEqual(truncated.sourceEpoch,rewrite.sourceEpoch);
 const partial=event({type:'item_completed',turn_id:'turn-0',item:{id:'new',type:'AgentMessage',content:'tail'}});await f.append(partial.slice(0,-1));const withoutNewline=await index.read(f.file,options);assert.equal(withoutNewline.rows.totalCount,truncated.rows.totalCount);await f.append('\n');const complete=await index.read(f.file,options);assert.equal(complete.rows.totalCount,withoutNewline.rows.totalCount+1);
});
test('interleaved old-turn items use their own byte records, change epoch and keep image cursors independently authorized',async t=>{
 const f=await conversationFixture(t,{turnCount:12}),index=new RolloutConversationIndex(),initial=await index.read(f.file,options);
 await f.append(event({type:'item_completed',turn_id:'turn-0',item:{id:'late-image',type:'ImageGeneration',status:'completed',file_id:'native-file-id'}}));
 const current=await index.read(f.file,{...options,fromRowId:1});assert.notEqual(current.sourceEpoch,initial.sourceEpoch);assert.equal(current.rows.totalCount,initial.rows.totalCount+1);
 const raw=await readRolloutPage(f.file,null,10000),expected=projectConversationRows({thread:fixtureThread,turns:raw.data.map(turn=>displayTurn(turn,{threadId:fixtureId}))});
 assert.deepEqual(current.rows.window.map(row=>[row.kind,row.entityId,row.rowId]),expected.map(row=>[row.kind,row.entityId,row.rowId]));
 const image=current.rows.window.find(row=>row.entityId==='late-image'),url=new URL(/\]\(([^)]+)\)/.exec(image.text)[1],'http://local'),cursor=url.searchParams.get('cursor');
 const page=await readRolloutPage(f.file,cursor,8),displayed={thread:fixtureThread,turns:page.data.map(turn=>displayTurn(turn,{threadId:fixtureId}))};assert(resolveMobileImagePath(displayed,url.searchParams).startsWith('/api/thread-media?'));
 await assert.rejects(index.read(f.file,{...options,sourceEpoch:initial.sourceEpoch,beforeRowId:20}),{code:'HISTORY_WINDOW_CHANGED'});
});
