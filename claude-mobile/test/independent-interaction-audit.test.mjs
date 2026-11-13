import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runInNewContext,Script} from 'node:vm';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {chatHtml} from '../backend/lib/ui.mjs';

const scripts=[...chatHtml().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
const client=scripts.find(source=>source.includes('const deliveryCommands=new Map()'));
assert.ok(client,'test the actual generated native-delivery client');
const between=(start,end)=>{
  const a=client.indexOf(start),b=client.indexOf(end,a);
  assert.ok(a>=0&&b>a,`locate client section: ${start}`);
  return client.slice(a,b);
};
function actualFunction(name){
  const match=new RegExp('^  (?:async )?function '+name+'\\(','m').exec(client);
  assert.ok(match,`locate real client function ${name}`);
  const start=match.index,lineEnd=client.indexOf('\n',start);
  if(client.slice(start,lineEnd).trimEnd().endsWith('}'))return client.slice(start,lineEnd);
  const end=client.indexOf('\n  }',lineEnd);
  assert.ok(end>start,`locate function end: ${name}`);
  return client.slice(start,end+4);
}
const functions=['rememberView','readRememberedView','projectName','currentRequest','syncInputHeight','afterComposerVisible','saveDraft','restoreDraft','showList','updateSendState','openSession','newChat','bootstrap'];
const harnessSource=[
  between('  const state = {','  let hubActive='),
  'let hubActive=true,historyAssistant=null; const assistantOwners=new Set(),seenMessages=new Set(),pendingNativeUsers=new Set();',
  'const drafts=new Map(),pendingRequests=new Map();let draftKey=null;',
  ...functions.map(actualFunction),
  between('  const deliveryCommands=new Map();','  function attachmentPreview('),
  '({state,drafts,pendingRequests,deliveryCommands,seenMessages,pendingNativeUsers,send,checkDelivery,receiveDelivery,pendingSame,restorePendingMessages,newChat,openSession,showList,saveDraft,bootstrap,updateSendState,currentRequest,readRememberedView,getDraftKey:()=>draftKey})',
].join('\n');

const pendingStorage='clm-pending-desktop-commands-v1',viewStorage='clm-current-view-v1';
const response=(status,value)=>({ok:status>=200&&status<300,status,json:async()=>value});
const plain=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const store=map=>({getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value))});

function element(connected=false){
  const classes=new Set();let text='';
  const node={parent:null,children:[],style:{},value:'',scrollHeight:24,attributes:{},
    classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),toggle(name,on){if(on)classes.add(name);else classes.delete(name);}},
    setAttribute(name,value){this.attributes[name]=value;},focus(){},
    append(...nodes){for(const child of nodes){child.parent=this;this.children.push(child);}},
    replaceChildren(){for(const child of this.children)child.parent=null;this.children=[];},
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;},
    querySelector(selector){return this.children.find(child=>('.'+child.className)===selector)||null;},
  };
  Object.defineProperties(node,{
    isConnected:{get:()=>connected||Boolean(node.parent?.isConnected)},
    textContent:{get:()=>text,set(value){text=value;node.replaceChildren();}},
  });
  return node;
}

// DOM, transport, timers and output rendering are boundary fakes. Delivery,
// navigation, persistence, matching and response handling above run unchanged.
function fixture({local=new Map(),session=new Map()}={}){
  const nodes=new Map(),ctx={calls:[],refreshes:0,polls:0,menus:[],users:[],uuidCalls:0};
  const node=id=>{if(!nodes.has(id))nodes.set(id,element(true));return nodes.get(id);};
  let api;
  const sandbox={
    document:{getElementById:node,createElement:()=>element(),hidden:false},
    localStorage:store(local),sessionStorage:store(session),history:{state:{},replaceState(value){this.state=value;}},
    crypto:{randomUUID:()=>{ctx.uuidCalls++;return randomUUID();}},AbortController,
    requestAnimationFrame:fn=>fn(),viewportChanged(){},renderAttachments(){},updateChips(){},
    closeMenu(){},openMenu:kind=>ctx.menus.push(kind),renderPlan(){},scrollDown(){},
    stopPoll(){},startPoll(){},poll:()=>ctx.polls++,refreshSessions:()=>ctx.refreshes++,
    appendMessage(){},errorLine(){},
    addUserMessage(text,attachments){const wrap=element();wrap.className='msg user';node('messages').append(wrap);ctx.users.push({text,attachments,wrap});return wrap;},
    loadModels:async()=>{api.state.modelsLoaded=true;api.state.capabilities={attachments:false};},
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,
    async fetch(url,options={}){
      ctx.calls.push({url,options});
      const custom=ctx.fetchHook?.(url,options);
      if(custom!==undefined)return custom;
      if(options.method==='POST'){
        const body=JSON.parse(options.body);
        return response(202,{requestId:body.requestId,sessionId:body.sessionId||body.requestId,state:'dispatched'});
      }
      if(url.startsWith('/claude/api/session/'))return response(200,{messages:[]});
      return response(404,{error:'request not found yet'});
    },
  };
  api=runInNewContext(harnessSource,sandbox);
  api.state.modelsLoaded=true;api.state.capabilities={attachments:false};api.state.model='chosen-model';
  return {api,ctx,node,local,session,
    posts:()=>ctx.calls.filter(call=>call.options.method==='POST'),
    queries:()=>ctx.calls.filter(call=>call.url.startsWith('/claude/api/command/')),
    requests:()=>[...api.deliveryCommands.values()],
    stored:()=>JSON.parse(local.get(pendingStorage)||'[]'),
  };
}

test('audit: image-only acknowledgement must clear the sent attachment',async()=>{
 const f=fixture();f.api.newChat('/audit');f.api.state.capabilities={attachments:true};
 f.api.state.attachments=[{id:'image-one.png',name:'image.png',url:'/not-sent'}];
 f.ctx.fetchHook=(url,options)=>options.method==='POST'?response(200,{requestId:JSON.parse(options.body).requestId,sessionId:JSON.parse(options.body).requestId,state:'accepted'}):undefined;
 await f.api.send('');
 assert.equal(f.requests()[0].text,'请查看这张图片。');
 assert.equal(f.api.state.attachments.length,0,'accepted image-only attachment must leave the composer');
});

test('audit: an in-flight upload must remain removable after switching conversations',async()=>{
 const f=fixture();f.api.newChat('/audit');const image={name:'pending.png',uploading:true};f.api.state.attachments=[image];
 f.api.showList();await f.api.openSession({id:'other-session',cwd:'/audit',title:'Other'});
 f.api.newChat('/audit');assert.equal(f.api.state.attachments[0],image);
});
