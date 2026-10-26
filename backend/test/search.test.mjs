import test from 'node:test';
import assert from 'node:assert/strict';
import { ThreadSearch, visibleOccurrence } from '../search.mjs';
const params = values => new URLSearchParams(values);
const thread = id => ({ id,name:'任务 '+id,cwd:'/workspace/'+id,updatedAt:100,status:{type:'idle'} });
const occurrence = (turnId,itemId,text,cursor='anchor:1',q='正文') => ({turnId,itemId,turnCursor:cursor,snippet:text,snippetMatchRange:{start:text.indexOf(q),end:text.indexOf(q)+q.length}});

test('visible snippets rebase UTF16 ranges after filtering system context and never use tool output',()=>{
  const text='开头 🐱 正文 <script>literal</script> 结束';
  const turn={id:'turn',items:[{id:'user',type:'userMessage',content:[{type:'text',text:'# AGENTS.md instructions\n<INSTRUCTIONS>正文 secret</INSTRUCTIONS><environment_context>private env</environment_context>\n## My request:\n'+text}]}]};
  const result=visibleOccurrence(occurrence('turn','user',text,'anchor:1','🐱'),turn,'🐱','thread');
  assert.equal(result.snippet.slice(result.snippetMatchRange.start,result.snippetMatchRange.end),'🐱');assert.equal(result.snippetMatchRange.end-result.snippetMatchRange.start,2);assert.equal(result.snippet.includes('secret'),false);assert.equal(result.snippet.includes('environment_context'),false);
  const hidden={id:'turn',items:[{id:'hidden',type:'userMessage',content:[{type:'text',text:'# AGENTS.md instructions\n<INSTRUCTIONS>正文 secret</INSTRUCTIONS><environment_context>正文</environment_context>\n## My request:\n安全请求'}]},{id:'tool',type:'mcpToolCall',result:{text:'正文 secret'},server:'local',tool:'debug'}]};
  assert.equal(visibleOccurrence(occurrence('turn','hidden','正文 secret'),hidden,'正文','thread'),null);assert.equal(visibleOccurrence(occurrence('turn','tool','正文 secret'),hidden,'正文','thread'),null);
});

test('literal matching escapes regex and preserves case and surrogate boundaries',()=>{
 const text='🐱 Hello a+b[1] 结尾';const turn={id:'t',items:[{id:'a',type:'agentMessage',text}]};
 const found=visibleOccurrence(occurrence('t','a',text,'anchor:1','a+b[1]'),turn,'a+b[1]','thread');assert.equal(found.snippet.slice(found.snippetMatchRange.start,found.snippetMatchRange.end),'a+b[1]');
 const casing=visibleOccurrence(occurrence('t','a',text,'anchor:1','Hello'),turn,'hello','thread');assert.equal(casing.snippet.slice(casing.snippetMatchRange.start,casing.snippetMatchRange.end),'Hello');assert.equal(casing.snippet.includes('\ufffd'),false);
});

test('cross-thread body search verifies visible items, scopes projects and binds its cursor to query',async()=>{
 const catalog={projects:[{id:'p1',roots:['/workspace/a']},{id:'p2',roots:['/workspace/b']}],threads:[{id:'a',mobileProjectId:'p1'},{id:'b',mobileProjectId:'p2'},{id:'c',mobileProjectId:'p2'}]};
 const core={async call(method,p){
  if(method==='thread/search'){const all=['a','b','c'],start=Number(p.cursor||0),ids=all.slice(start,start+p.limit);return{data:ids.map(id=>({thread:thread(id),snippet:'raw internal snippet must not be returned'})),nextCursor:start+p.limit<all.length?String(start+p.limit):null};}
  if(method==='thread/searchOccurrences')return{data:[occurrence('t','u','可见正文')],nextCursor:null};
  if(method==='thread/turns/list')return{data:[{id:'t',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text:p.threadId==='c'?'# AGENTS.md instructions\n<INSTRUCTIONS>正文 hidden</INSTRUCTIONS>':'可见正文'}]}]}],nextCursor:null};
  throw Error(method);
 }};
 const search=new ThreadSearch({core,catalog:async()=>catalog});const page=await search.search(params({q:'正文',projectId:'p2',limit:'1'}));assert.equal(page.data[0].threadId,'b');assert.match(page.data[0].snippet,/可见正文/);assert.equal(page.data[0].snippet.includes('internal'),false);assert.ok(page.nextCursor);
 await assert.rejects(search.search(params({q:'另一个词',projectId:'p2',cursor:page.nextCursor})),/范围已变化/);
 const rest=await search.search(params({q:'正文',projectId:'p2',limit:'1',cursor:page.nextCursor}));assert.equal(rest.data.length,0);assert.equal(rest.nextCursor,null);
});

test('occurrences share one minimal turn read and keep native page order and UTF16 ranges',async()=>{
 let reads=0;const text='前文 🐱 正文 后文',turn={id:'t',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text}]},{id:'a',type:'agentMessage',text}]};
 const core={async call(method,p){if(method==='thread/searchOccurrences')return{data:[occurrence('t','u',text),occurrence('t','a',text)],nextCursor:null};if(method==='thread/turns/list'){reads++;await new Promise(r=>setTimeout(r,5));assert.equal(p.limit,1);assert.equal(p.itemsView,'full');return{data:[turn]};}throw Error(method)}};
 const search=new ThreadSearch({core,catalog:async()=>({projects:[],threads:[]})});const found=await search.occurrences(params({threadId:'thread',q:'正文'}));assert.equal(reads,1);assert.deepEqual(found.data.map(o=>o.itemId),['u','a']);for(const o of found.data)assert.equal(o.snippet.slice(o.snippetMatchRange.start,o.snippetMatchRange.end),'正文');
});

test('around windows include the exact anchor, page both directions independently, and never append the latest tail',async()=>{
 const turns=Array.from({length:10},(_,i)=>({id:'t'+i,status:'completed',items:[{id:'u'+i,type:'userMessage',content:[{type:'text',text:'消息 '+i}]}]}));
 const core={async call(method,p){if(method==='thread/read')return{thread:thread(p.threadId)};if(method==='thread/turns/list'){const start=Number(p.cursor.split(':')[1]),step=p.sortDirection==='desc'?-1:1,data=[];let i=start;for(;data.length<p.limit&&i>=0&&i<turns.length;i+=step)data.push(turns[i]);return{data,nextCursor:i>=0&&i<turns.length?'page:'+i:null,backwardsCursor:'never-use-this-as-older'};}throw Error(method)}};
 const search=new ThreadSearch({core,catalog:async()=>({projects:[],threads:[]})});const first=await search.around(params({threadId:'thread',turnCursor:'anchor:5',turnId:'t5',itemId:'u5'}));assert.deepEqual(first.turns.map(t=>t.id),['t3','t4','t5','t6','t7']);assert.equal(first.anchor.itemId,'u5');assert.equal(first.hasOlder,true);assert.equal(first.hasNewer,true);
 const older=await search.around(params({threadId:'thread',cursor:first.olderCursor,direction:'older',limit:'2'}));assert.deepEqual(older.turns.map(t=>t.id),['t1','t2']);assert.equal(older.newerCursor,undefined);
 const newer=await search.around(params({threadId:'thread',cursor:first.newerCursor,direction:'newer',limit:'2'}));assert.deepEqual(newer.turns.map(t=>t.id),['t8','t9']);assert.equal(newer.newerCursor,null);assert.equal(newer.olderCursor,undefined);
 await assert.rejects(search.around(params({threadId:'thread',cursor:first.olderCursor,direction:'newer'})),/方向已变化/);
});
