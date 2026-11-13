import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
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
  const api=runInNewContext('let workspacePanelId=0;'+actualFunction('renderSessions')+'\n({renderSessions})',{state,rows,listView,closedWorkspaces,document:{createElement:tag=>new Element(tag)},timeText:ms=>String(Math.floor(ms/60000)),projectName:cwd=>cwd.split('/').at(-1),openSession:value=>opened.push(value),newChat(){},sessionStorage:{setItem(){}}});
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
  assert.equal(h.row('b'),row);assert.deepEqual(row.children,children);assert.equal(row.firstElementChild.textContent,'Changed');assert.equal(row.lastElementChild.textContent,'4');assert.equal(row.children[1].style.visibility,'hidden');assert.equal(row.children[1].attributes.role,undefined);assert.match(row.title,/9 条/);
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
