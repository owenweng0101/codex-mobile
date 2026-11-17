import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,appendFileSync,statSync,renameSync,rmSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSessionMetaCache,listSessions,parseTranscript,planItems,readMarker} from '../backend/lib/sessions.mjs';
import {chatHtml} from '../backend/lib/ui.mjs';
const client=[...chatHtml().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('const deliveryCommands'));
function actualFunction(name){const start=client.indexOf('  function '+name+'('),end=client.indexOf('\n  }',start);assert.ok(start>=0&&end>start);return client.slice(start,end+4);}
function fixture(){
  let mutations=0;const opened=[];
  class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.parent=null;this.dataset={};this.style={};this.attributes={};this.textContent='';this.title='';this.events={};}
    get firstElementChild(){return this.children[0];}get lastElementChild(){return this.children.at(-1);}
    appendChild(child){return this.insertBefore(child,null);}append(...children){children.forEach(child=>this.appendChild(child));}
    insertBefore(child,before){mutations++;child.remove();const index=before?this.children.indexOf(before):this.children.length;this.children.splice(index,0,child);child.parent=this;return child;}
    remove(){if(this.parent){mutations++;this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}}
    setAttribute(k,v){this.attributes[k]=v;}removeAttribute(k){delete this.attributes[k];}
    addEventListener(type,fn){this.events[type]=fn;}
    querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='.'+child.className?[child]:[]),...child.querySelectorAll(selector)]);}
  }
  const rows=new Element('div'),listView={scrollTop:400},closedWorkspaces=new Set();
  const state={sessions:[],listView:'project',unread:{isUnread:session=>session.unread===true}};
  const api=runInNewContext('let workspacePanelId=0;const runtimeSnapshots=new WeakMap();'+['observeRuntime','runtimeStatus','renderSessions'].map(actualFunction).join('\n')+'\n({renderSessions})',{state,rows,listView,closedWorkspaces,performance:{now:()=>0},document:{createElement:tag=>new Element(tag)},timeText:ms=>String(Math.floor(ms/60000)),projectName:cwd=>cwd.split('/').at(-1),openSession:value=>opened.push(value),newChat(){},sessionStorage:{setItem(){}}});
  return {state,rows,listView,closedWorkspaces,opened,api,mutations:()=>mutations,row:id=>rows.querySelectorAll('.row').find(row=>row.dataset.scrollKey==='session:'+id)};
}
const sessions=[{id:'a',cwd:'/work/a',title:'Alpha',messageCount:2,updatedAt:120000,unread:false},{id:'b',cwd:'/work/a',title:'Beta',messageCount:3,updatedAt:60000,unread:true},{id:'c',cwd:'/work/b',title:'Gamma',messageCount:4,updatedAt:60000,unread:false}];
test('metadata/revision/sub-minute timestamp churn produces no DOM mutations and clicks use fresh sessions',()=>{
  const h=fixture();h.state.sessions=sessions;h.api.renderSessions();const row=h.row('a'),group=h.rows.children[0],mutations=h.mutations();
  for(let i=1;i<=8;i++){
    h.state.sessions=sessions.map(session=>({...session,updatedAt:session.updatedAt+i,running:i%2===0,runningName:'owner-'+i,unreadVersion:'native-'+i}));h.api.renderSessions();
    assert.equal(h.row('a'),row);assert.equal(h.rows.children[0],group);assert.equal(h.mutations(),mutations);
  }
  row.events.click();assert.equal(h.opened[0],h.state.sessions[0]);assert.equal(h.opened[0].unreadVersion,'native-8');assert.equal(h.listView.scrollTop,400);
});
test('real title/unread/minute changes patch the same live row and its existing children',()=>{
  const h=fixture();h.state.sessions=sessions;h.api.renderSessions();const row=h.row('b'),children=[...row.children];
  h.state.sessions=sessions.map(session=>session.id==='b'?{...session,title:'Changed',messageCount:9,updatedAt:240000,unread:false}:session);h.api.renderSessions();
  assert.equal(h.row('b'),row);assert.deepEqual(row.children,children);assert.equal(row.children[1].textContent,'Changed');assert.equal(row.lastElementChild.textContent,'4');assert.equal(row.firstElementChild.firstElementChild.style.visibility,'hidden');assert.equal(row.firstElementChild.attributes.role,undefined);assert.match(row.title,/9 条/);
});
test('reordering, insertion and workspace moves retain all surviving row identities',()=>{
  const h=fixture();h.state.sessions=sessions;h.api.renderSessions();const saved=new Map(sessions.map(s=>[s.id,h.row(s.id)]));
  h.state.sessions=[{id:'inserted',cwd:'/new',title:'New',updatedAt:400000},...sessions.map(s=>s.id==='c'?{...s,cwd:'/work/a',updatedAt:500000}:s)];h.api.renderSessions();
  for(const [id,row]of saved)assert.equal(h.row(id),row);assert.equal(h.row('c').parent.parent.parent.dataset.cwd,'/work/a');
  h.state.sessions=h.state.sessions.filter(s=>s.id!=='b');h.api.renderSessions();assert.equal(h.row('b'),undefined);assert.equal(h.row('a'),saved.get('a'));
});
test('equal-timestamp API order jitter is stable and view switching keeps buttons and unique panel IDs',()=>{
  const h=fixture();h.state.sessions=sessions;h.api.renderSessions();const rows=sessions.map(s=>h.row(s.id)),mutations=h.mutations();
  h.state.sessions=[sessions[0],sessions[2],sessions[1]];h.api.renderSessions();assert.equal(h.mutations(),mutations);
  h.state.listView='recent';h.api.renderSessions();assert.equal(h.rows.children.length,1);assert.equal(h.rows.children[0].firstElementChild.hidden,true);
  h.state.listView='project';h.api.renderSessions();sessions.forEach((s,i)=>assert.equal(h.row(s.id),rows[i]));
  const ids=h.rows.children.map(group=>group.lastElementChild.id);assert.equal(new Set(ids).size,ids.length);
});
test('unrelated list updates preserve collapsed workspace/header identity',()=>{
  const h=fixture();h.state.sessions=sessions;h.api.renderSessions();const group=h.rows.children[0],heading=group.firstElementChild.firstElementChild;
  heading.events.click();assert.equal(group.dataset.expanded,'false');h.state.sessions=sessions.map(s=>s.id==='c'?{...s,title:'Other updated'}:s);h.api.renderSessions();
  assert.equal(h.rows.children[0],group);assert.equal(group.firstElementChild.firstElementChild,heading);assert.equal(group.dataset.expanded,'false');assert.equal(group.lastElementChild.inert,true);
});

// ---- 会话数据层：增量元数据缓存 / 未读 known / 计划状态 / 内联图片上限 ----
const userLine=(text,extra={})=>JSON.stringify({type:'user',cwd:'/work/a',message:{content:text},...extra})+'\n';
const assistantLine=(model='model-1')=>JSON.stringify({type:'assistant',message:{model,content:[{type:'text',text:'ok'}],stop_reason:'end_turn'}})+'\n';
const sessionFixture=(t,id='00000000-0000-4000-8000-00000000000a')=>{
  const directory=mkdtempSync(join(tmpdir(),'session-meta-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return {id,path:join(directory,id+'.jsonl')};
};
const entryOf=({id,path})=>{const info=statSync(path);return {id,path,size:info.size,mtimeMs:info.mtimeMs,ino:info.ino};};
async function readBytes(path,start,length){
  const handle=await open(path,'r');
  try{const buffer=Buffer.alloc(length);const {bytesRead}=await handle.read(buffer,0,length,start);return buffer.subarray(0,bytesRead);}
  finally{await handle.close();}
}
function countingCache(){
  const reads={whole:0,wholeBytes:0,range:0,rangeBytes:0};
  const cache=createSessionMetaCache({
    readWhole:async path=>{reads.whole++;const raw=await readBytes(path,0,statSync(path).size);reads.wholeBytes+=raw.length;return raw;},
    readRange:async(path,start,length)=>{reads.range++;const chunk=await readBytes(path,start,length);reads.rangeBytes+=chunk.length;return chunk;},
  });
  return {reads,cache};
}
test('session metadata cache reuses unchanged rows and only parses appended JSONL bytes',async t=>{
  const fixture=sessionFixture(t),first=userLine('问题一')+assistantLine('model-a');
  writeFileSync(fixture.path,first);
  const {reads,cache}=countingCache();
  const initial=await cache(entryOf(fixture));
  assert.equal(initial.title,'问题一');assert.equal(initial.messageCount,2);assert.equal(initial.model,'model-a');
  assert.deepEqual([reads.whole,reads.range],[1,0]);
  const unchanged=await cache(entryOf(fixture));
  assert.equal(unchanged,initial,'path+size+mtime 未变时直接复用缓存');
  assert.deepEqual([reads.whole,reads.range],[1,0]);
  const appended=userLine('问题二')+assistantLine('model-b');
  appendFileSync(fixture.path,appended);
  const next=await cache(entryOf(fixture));
  assert.equal(next.messageCount,4);assert.equal(next.title,'问题一');assert.equal(next.model,'model-b');
  assert.equal(reads.whole,1,'追加只读新增字节，不再整份 readFile');
  assert.equal(reads.range,1);
  assert.ok(reads.rangeBytes<=Buffer.byteLength(appended)+64,'增量读取量约等于新增字节');
  assert.ok(reads.rangeBytes<Buffer.byteLength(first)+Buffer.byteLength(appended));
  const late=userLine('问题三');
  appendFileSync(fixture.path,late.slice(0,20));
  assert.equal((await cache(entryOf(fixture))).messageCount,4,'半行尚未写完时不计数');
  appendFileSync(fixture.path,late.slice(20));
  assert.equal((await cache(entryOf(fixture))).messageCount,5,'补完换行后按增量行计数');
});
test('session metadata cache rebuilds when the JSONL shrinks, is rewritten or rotated',async t=>{
  const fixture=sessionFixture(t);
  writeFileSync(fixture.path,userLine('旧标题')+assistantLine('model-old')+userLine('旧追问'));
  const {reads,cache}=countingCache();
  const before=await cache(entryOf(fixture));
  assert.equal(before.messageCount,3);assert.equal(before.title,'旧标题');
  writeFileSync(fixture.path,userLine('新标题')+assistantLine('model-new'));
  const shrunk=await cache(entryOf(fixture));
  assert.equal(shrunk.messageCount,2);assert.equal(shrunk.title,'新标题');assert.equal(shrunk.model,'model-new');
  assert.ok(reads.whole>=2,'size 变小必须整份重建');
  writeFileSync(fixture.path,userLine('完全改写')+assistantLine('model-rewritten')+userLine('新记录')+assistantLine('model-rewritten-2'));
  const rewritten=await cache(entryOf(fixture));
  assert.equal(rewritten.messageCount,4);assert.equal(rewritten.title,'完全改写');assert.equal(rewritten.model,'model-rewritten-2');
  assert.ok(reads.whole>=3,'原地覆写且游标前缀对不上时不能沿用旧计数');
  const replacement=fixture.path+'.next';
  writeFileSync(replacement,userLine('轮转标题')+assistantLine('model-rotated')+userLine('轮转追问')+userLine('更多')+assistantLine('model-final'));
  renameSync(replacement,fixture.path);
  const rotated=await cache(entryOf(fixture));
  assert.equal(rotated.messageCount,5);assert.equal(rotated.title,'轮转标题');assert.equal(rotated.model,'model-final');
});
test('unknown native unread is flagged instead of silently looking read',async()=>{
  const id1='11111111-1111-4111-8111-111111111111',id2='22222222-2222-4222-8222-222222222222';
  const catalog=async()=>[{cliSessionId:id1,sessionId:'desktop-1',lastAssistantUuid:'reply-1'},{cliSessionId:id2,sessionId:'desktop-2'}];
  const base={catalog,entries:async()=>[],running:async()=>new Map()};
  const unknownDots={known:false,unreadIds:new Set(),explicitUnreadIds:new Set()};
  const unknown=await listSessions({...base,unread:async()=>unknownDots});
  assert.deepEqual(unknown.map(session=>[session.unread,session.unreadKnown]),[[false,false],[false,false]],'未知时保留 false，但必须带 unreadKnown:false');
  const unknownMarker=readMarker({cliSessionId:id1,sessionId:'desktop-1'},unknownDots);
  assert.equal(unknownMarker.known,false);assert.equal(unknownMarker.unreadKnown,false);assert.equal(unknownMarker.unread,false);
  const known=await listSessions({...base,unread:async()=>({known:true,unreadIds:new Set(['desktop-2']),explicitUnreadIds:new Set()})});
  assert.deepEqual(known.map(session=>[session.unread,session.unreadKnown]),[[false,true],[true,true]]);
  assert.equal(known[0].unreadVersion,'reply-1:reply');assert.equal(known[1].unreadVersion,'0:reply');
});
test('update_plan statuses normalize like TodoWrite in plans',()=>{
  assert.deepEqual(planItems('mcp__ccd_turn__update_plan',{items:[{content:'一',status:'completed'},{content:'二',status:'in_progress'},{content:'三'},{content:'四',status:'whatever'}]}),
    [{content:'一',status:'done'},{content:'二',status:'in_progress'},{content:'三',status:'pending'},{content:'四',status:'pending'}]);
  assert.deepEqual(planItems('TodoWrite',{todos:[{content:'一',status:'completed'}]}),[{content:'一',status:'done'}]);
  const id='00000000-0000-4000-8000-00000000000d';
  const raw=[
    JSON.stringify({uuid:'u1',type:'user',message:{content:'做计划'}}),
    JSON.stringify({uuid:'a1',type:'assistant',message:{model:'m',content:[{type:'tool_use',id:'t1',name:'mcp__ccd_turn__update_plan',input:{items:[{content:'步骤一',status:'completed'},{content:'步骤二',status:'in_progress'}]}}]}}),
    JSON.stringify({uuid:'r1',type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'Plan updated',is_error:false}]}}),
  ].join('\n')+'\n';
  const transcript=parseTranscript(raw,id);
  assert.deepEqual(transcript.plan,[{content:'步骤一',status:'done'},{content:'步骤二',status:'in_progress'}]);
  assert.equal(transcript.messages.at(-1).tools[0].name,'mcp__ccd_turn__update_plan');
});
test('phone screenshots inline up to 3MB per image, 6MB per message and 12MB per transcript',()=>{
  const id='00000000-0000-4000-8000-00000000000c';
  const imagePart=data=>({type:'image',source:{type:'base64',media_type:'image/png',data}});
  let lines=0;
  const line=content=>JSON.stringify({uuid:'u-'+(++lines),type:'user',message:{content}});
  const screenshot='a'.repeat(Math.floor(2.9*1024*1024)),tooLarge='b'.repeat(Math.ceil(3.1*1024*1024));
  const shipped=parseTranscript(line([imagePart(screenshot)]),id);
  assert.equal(shipped.messages[0].attachments[0].url,'data:image/png;base64,'+screenshot,'2.9MB 手机截图仍内联');
  assert.equal(shipped.messages[0].attachments[0].placeholder,undefined);
  assert.equal(shipped.messages[0].text,'');
  assert.equal(shipped.title,'未命名会话');
  const dropped=parseTranscript(line([imagePart(tooLarge)]),id);
  const attachment=dropped.messages[0].attachments[0];
  assert.equal(attachment.placeholder,true,'超过单张 3MB 降级为占位');
  assert.equal(attachment.url,undefined);
  assert.equal(attachment.size,Buffer.byteLength(tooLarge));
  assert.match(dropped.messages[0].text,/图片过大，未在手机上内联/);
  assert.equal(dropped.messages[0].attachments.length,1,'占位仍保留一条附件');
  assert.equal(dropped.title,'未命名会话','占位提示不应变成会话标题');
  // 单条消息 6MB：两张 2.9MB 截图仍内联，第三张降级为占位。
  const message=parseTranscript(line([imagePart(screenshot),imagePart(screenshot),imagePart(screenshot)]),id).messages[0];
  assert.deepEqual(message.attachments.map(item=>item.placeholder===true),[false,false,true],'单条消息内联总预算超限后降级为占位');
  assert.equal(message.attachments.filter(item=>item.url).length,2);
  assert.match(message.text,/图片过大/);
  // 整份 transcript 12MB：两条消息各内联 5.8MB 后，第三条再内联就超总预算。
  const transcript=parseTranscript([line([imagePart(screenshot),imagePart(screenshot)]),line([imagePart(screenshot),imagePart(screenshot)]),line([imagePart(screenshot)])].join('\n'),id);
  assert.deepEqual(transcript.messages.map(message=>message.attachments.map(item=>item.placeholder===true)),
    [[false,false],[false,false],[true]],'整份 transcript 内联预算用尽后剩余图片降级为占位');
  assert.match(transcript.messages[2].text,/图片过大/);
  assert.equal(transcript.messages[0].attachments[1].url,'data:image/png;base64,'+screenshot);
});

test('transcript pagination walks older 80-message pages without gaps or duplicates',()=>{
  const id='00000000-0000-4000-8000-00000000000e';
  const raw=Array.from({length:600},(_,i)=>JSON.stringify({uuid:'m-'+i,type:'user',timestamp:'2026-11-13T01:00:00Z',message:{content:'消息 '+i}})).join('\n')+'\n';
  const first=parseTranscript(raw,id);
  assert.equal(first.messages.length,400);assert.equal(first.before,201);assert.equal(first.hasMore,true);assert.equal(first.truncated,true);
  const pages=[];let before=first.before;
  for(;;){
    const page=parseTranscript(raw,id,0,before);
    assert.deepEqual(page.toolUpdates,[],'分页不返回增量工具更新');
    if(!page.messages.length){assert.equal(page.before,null);assert.equal(page.hasMore,false);break;}
    pages.unshift(page);
    assert.equal(page.before,page.messages[0].seq,'before 是本页第一条的 seq');
    if(!page.hasMore)break;
    before=page.before;
  }
  assert.deepEqual(pages.map(page=>page.messages.length),[40,80,80]);
  const all=[...pages.flatMap(page=>page.messages),...first.messages];
  assert.deepEqual(all.map(message=>message.seq),Array.from({length:600},(_,i)=>i+1),'两页衔接无重复无遗漏');
  assert.equal(new Set(all.map(message=>message.id)).size,600);
  const empty=parseTranscript(raw,id,0,1);
  assert.deepEqual(empty.messages,[]);assert.equal(empty.before,null);assert.equal(empty.hasMore,false);
  const small=parseTranscript(JSON.stringify({uuid:'s1',type:'user',message:{content:'一'}})+'\n'+JSON.stringify({uuid:'s2',type:'assistant',message:{content:[{type:'text',text:'二'}],stop_reason:'end_turn'}}),id);
  assert.equal(small.messages.length,2);assert.equal(small.before,1);assert.equal(small.hasMore,false);assert.equal(small.truncated,false);
});
// Use an existing agent-owned Space so this regression never opens a second one.
test('393px Ego: real 3-second polling retains click targets during metadata churn and visible updates',{skip:!process.env.CLAUDE_LIST_EGO_SPACE,timeout:240000},async()=>{
  let reads=0,mode='metadata';const writes=[];
  const id='e1111111-1111-4111-8111-111111111111',base=new Date();base.setSeconds(0,0);const now=base.getTime();
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture'),json=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(url.pathname==='/claude/api/sessions'){
      reads++;const list=Array.from({length:50},(_,i)=>({id:i===35?id:'fixture-'+i,title:i===35&&mode==='visible'?'Updated target '+reads:'Session '+i,cwd:'/workspace',updatedAt:now-i*60000+(reads%1000),messageCount:2,unread:i===35&&mode==='visible'&&reads%2===0,running:reads%2===0,unreadVersion:'revision-'+reads}));
      if(mode==='visible')list[35].updatedAt=now+60000;
      return json({sessions:list});
    }
    if(url.pathname==='/claude/api/models')return json({models:[{model:'fixture-model',label:'Fixture'}],defaultModel:'fixture-model',capabilities:{attachments:false}});
    if(url.pathname.startsWith('/claude/api/session/'))return json({id,messages:url.searchParams.has('since')?[]:[{id:'loaded',role:'assistant',text:'Isolated history'}],cursor:1,readMarker:{id,known:true,unread:false},control:{running:false}});
    if(url.pathname==='/fixture-mode'){mode='visible';return json({mode});}
    if(url.pathname==='/stats')return json({reads,mode,writes});
    if(req.method==='POST'){writes.push(url.pathname);return json({error:'unexpected write'});}
    res.writeHead(200,{'content-type':'text/html'});res.end(chatHtml().replace('<head>','<head><script>window.fixtureListReads=0;const originalFetch=window.fetch;window.fetch=async(...args)=>{const response=await originalFetch(...args);if(String(args[0])===\"/claude/api/sessions\")window.fixtureListReads++;return response;};</script>'));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const script=`
const task=await taskSpace(${JSON.stringify(process.env.CLAUDE_LIST_EGO_SPACE)});
try{
  const page=task.page('p1');
  await page.cdp('Emulation.setDeviceMetricsOverride',{width:393,height:852,deviceScaleFactor:1,mobile:true});
  await page.goto('http://127.0.0.1:${server.address().port}/claude/');
  await page.waitForFunction(()=>document.querySelectorAll('.row').length===50);
  console.log(await page.snapshot());
  console.log(await page.evaluate(()=>{
    window.savedRows=new Map([...document.querySelectorAll('.row')].map(row=>[row.dataset.scrollKey,row]));
    window.listChanges=0;new MutationObserver(records=>{window.listChanges+=records.length;}).observe(document.getElementById('rows'),{childList:true,subtree:true,attributes:true,characterData:true});
    window.errors=[];addEventListener('unhandledrejection',event=>window.errors.push(String(event.reason)));return {width:innerWidth,rows:savedRows.size};
  }));
  await page.waitForFunction(()=>window.fixtureListReads>=4,undefined,{timeout:30000});
  console.log(await page.evaluate(()=>{if(listChanges!==0)throw Error('Metadata refresh mutated list '+listChanges);if([...savedRows].some(([key,row])=>document.querySelector('[data-scroll-key="'+key+'"]')!==row||!row.isConnected))throw Error('Row replaced');return {realPollsObserved:true,listChanges};}));
  // Ego's automatic scroll could not expose this target in mobile emulation;
  // use real wheel input in the observed list, then keep real selector clicks.
  await page.mouse.move(195,500);
  await page.mouse.wheel(0,1200);
  console.log(await page.snapshot());
  await page.waitForFunction(()=>{const r=document.querySelector('[data-scroll-key="session:${id}"]').getBoundingClientRect();return r.top>=52&&r.bottom<=innerHeight;});
  for(let round=0;round<2;round++){
    console.log({round,phase:'click'});
    try{await page.click('[data-scroll-key="session:${id}"]');}
    catch(error){console.log(await page.evaluate(()=>{const node=document.querySelector('[data-scroll-key="session:${id}"]');return {target:node?.getBoundingClientRect().toJSON(),connected:node?.isConnected,ancestors:[node,...(function*(n){while(n?.parentElement){n=n.parentElement;yield n;}})(node)].map(n=>({id:n.id,cls:n.className,scrollTop:n.scrollTop,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight,overflow:getComputedStyle(n).overflow,rect:n.getBoundingClientRect().toJSON()}))};}));console.log(await page.snapshot());throw error;}
    await page.waitForFunction(()=>document.querySelector('#messages .msg'));
    await page.click('#back');
    await page.waitForFunction(()=>!document.getElementById('list').classList.contains('hidden')&&document.getElementById('list').getAttribute('aria-busy')==='false');
  }
  await page.evaluate(()=>fetch('/fixture-mode'));
  await page.waitForFunction(()=>document.querySelector('[data-scroll-key="session:${id}"] .name').textContent.startsWith('Updated target'),undefined,{timeout:10000});
  console.log(await page.evaluate(()=>{if([...savedRows].some(([key,row])=>document.querySelector('[data-scroll-key="'+key+'"]')!==row||!row.isConnected))throw Error('Visible update replaced row');return {visibleUpdateRetainsRows:true};}));
  // The changed timestamp legitimately moved the target to the top while the
  // reading anchor stayed at the old position. Scroll there as a person would.
  await page.mouse.move(195,500);
  await page.mouse.wheel(0,-1600);
  await page.waitForFunction(()=>{const r=document.querySelector('[data-scroll-key="session:${id}"]').getBoundingClientRect();return r.top>=52&&r.bottom<=innerHeight;});
  console.log(await page.snapshot());
  for(let round=0;round<2;round++){
    console.log({round,phase:'click'});
    try{await page.click('[data-scroll-key="session:${id}"]');}
    catch(error){console.log(await page.evaluate(()=>{const node=document.querySelector('[data-scroll-key="session:${id}"]');return {target:node?.getBoundingClientRect().toJSON(),connected:node?.isConnected,ancestors:[node,...(function*(n){while(n?.parentElement){n=n.parentElement;yield n;}})(node)].map(n=>({id:n.id,cls:n.className,scrollTop:n.scrollTop,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight,overflow:getComputedStyle(n).overflow,rect:n.getBoundingClientRect().toJSON()}))};}));console.log(await page.snapshot());throw error;}
    await page.waitForFunction(()=>document.querySelector('#messages .msg'));
    await page.click('#back');
    await page.waitForFunction(()=>document.getElementById('list').getAttribute('aria-busy')==='false');
  }
  console.log(await page.evaluate(async()=>{if(errors.length)throw Error(errors.join(','));const stats=await(await fetch('/stats')).json();if(stats.writes.length)throw Error('Unexpected writes');return {fourEgoClicksPassed:true,stats,unhandledRejections:errors};}));
}finally{await task.finish({keep:[]});}
`;
  try{
    const output=await new Promise((resolve,reject)=>{const child=spawn('ego-browser',['nodejs'],{stdio:['pipe','pipe','pipe']});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output+=data;process.stdout.write(data);});child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error(output)));child.stdin.end(script);});
    assert.match(output,/fourEgoClicksPassed/);assert.deepEqual(writes,[]);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
