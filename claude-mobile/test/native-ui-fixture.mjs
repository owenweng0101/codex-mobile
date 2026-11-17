import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContext,runInContext,Script} from 'node:vm';
import {chatHtml} from '../backend/lib/ui.mjs';

export const html=chatHtml();
export const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
export const client=scripts.find(source=>source.includes('const deliveryCommands=new Map()'));
export const between=(start,end)=>{
  const a=client.indexOf(start),b=client.indexOf(end,a);
  assert.ok(a>=0&&b>a,`locate client section: ${start}`);
  return client.slice(a,b);
};
export function actualFunction(name){
  const match=new RegExp('^  (?:async )?function '+name+'\\(','m').exec(client);
  assert.ok(match,`locate real client function ${name}`);
  const start=match.index,lineEnd=client.indexOf('\n',start);
  if(client.slice(start,lineEnd).trimEnd().endsWith('}'))return client.slice(start,lineEnd);
  const end=client.indexOf('\n  }',lineEnd);
  assert.ok(end>start,`locate function end: ${name}`);
  return client.slice(start,end+4);
}
const functions=[
  'rememberView','readRememberedView','projectName','currentRequest','syncInputHeight','afterComposerVisible',
  'persistDrafts','saveDraft','restoreDraft','showList','updateSendState','updateHistoryTop','resetHistoryPaging','loadOlder',
  'newAssistant','addUserMessage','renderText','scrollDown','nativeReadVisible','acknowledgeRead',
  'stopPoll','startPoll','poll','updateTranscriptCursor','finallyReloadSession','openSession','newChat','bootstrap',
  'attachmentPreview','renderAttachments','uploadFile','anchorFileInput','attachmentAction','buildReloadSafe','checkClaudeBuild',
  'timeText','renderSessions','planStatus','renderPlan','syncPlanExpansion','errorLine',
];
export const harnessSource=[
  between('  const state = {','  let claudeBuild='),
  'let hubActive=true,pollController=null,reloadTarget=null,followOutput=true,userScrolling=false,scrollIntentTimer;',
  'let claudeBuild=null,claudePendingBuild=false,workspacePanelId=0,planSignature="";const closedWorkspaces=new Set();',
  between('  const drafts=new Map(),','  function currentRequest('),
  between('  let historyAssistant = null;','  function nativeReadVisible('),
  ...functions.map(actualFunction),
  between('  const deliveryCommands=new Map();','  function attachmentPreview('),
  between("  $('planChip').addEventListener(","  $('attach').addEventListener("),
  between("  $('file').addEventListener('change',",'  bootstrap();'),
  '({state,drafts,pendingRequests,deliveryCommands,seenMessages,nativeUserRows,send,checkDelivery,receiveDelivery,pendingSame,unboundRequest,restorePendingMessages,newChat,openSession,showList,saveDraft,persistDrafts,bootstrap,updateSendState,currentRequest,readRememberedView,appendMessage,poll,startPoll,stopPoll,loadOlder,finallyReloadSession,uploadFile,renderAttachments,attachmentAction,buildReloadSafe,checkClaudeBuild,renderDelivery,applyControl,setWaitingStatus,runtimeStatus,tickRuntime,updatePlanActivity,renderPlan,renderSessions,updateTranscriptCursor,getDraftKey:()=>draftKey,getHistoryAssistant:()=>historyAssistant,getOwners:()=>[...assistantOwners],getHubActive:()=>hubActive,setHubActive:value=>hubActive=Boolean(value)})',
].join('\n');
new Script(harnessSource);

export const pendingStorage='clm-pending-desktop-commands-v1',viewStorage='clm-current-view-v1',draftStorage='clm-drafts-v1';
export const response=(status,value)=>({ok:status>=200&&status<300,status,json:async()=>value});
export const plain=value=>JSON.parse(JSON.stringify(value));
export const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
const store=map=>({getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value)),removeItem:key=>map.delete(key)});
const assistantSource=readFileSync(new URL('../backend/lib/assistant-view.js',import.meta.url),'utf8');

// Only platform boundaries are faked. send, polling, O/N reconciliation,
// native user/assistant turn ownership, draft persistence and navigation run
// their production implementations, including the real assistant-view module.
export function fixture({local=new Map(),session=new Map()}={}){
  const ctx={calls:[],refreshes:0,menus:[],uuidCalls:0,errors:new Map(),monotonic:1000,wall:Date.UTC(2026,10,14),focuses:[],frames:[],reloads:0};
  let document;
  class Node {
    constructor(tag='',text=''){this.tagName=tag.toUpperCase();this.nodeType=tag?1:3;this.data=String(text);this.childNodes=[];this.parentNode=null;this.attrs=new Map();this.dataset={};this.style={};this.listeners=new Map();this.value='';this.files=[];this.scrollTop=0;this.scrollLeft=0;this.clientHeight=400;this.inert=false;this.ownerDocument=document;}
    get children(){return this.childNodes.filter(child=>child.nodeType===1);}
    get firstChild(){return this.childNodes[0]||null;}
    get firstElementChild(){return this.children[0]||null;}
    get lastElementChild(){return this.children.at(-1)||null;}
    get lastChild(){return this.childNodes.at(-1)||null;}
    get scrollHeight(){return this._scrollHeight??this.children.length*40;}
    set scrollHeight(value){this._scrollHeight=value;}
    get textContent(){return this.nodeType===3?this.data:this.childNodes.map(child=>child.textContent).join('');}
    set textContent(value){if(this.nodeType===3)this.data=String(value);else this.replaceChildren(...(value?[new Node('',String(value))]:[]));}
    get value(){return this._value||'';}
    set value(value){this._value=String(value);if(this.tagName==='INPUT'&&this.getAttribute('type')==='file'&&this._value===''&&this.files)this.files.length=0;}
    get className(){return this.attrs.get('class')||'';}
    set className(value){this.attrs.set('class',String(value));}
    get id(){return this.attrs.get('id')||'';}
    set id(value){this.attrs.set('id',String(value));}
    get attributes(){return [...this.attrs].map(([name,value])=>({name,value}));}
    get classList(){const tokens=()=>this.className.split(/\s+/).filter(Boolean);return {
      contains:name=>tokens().includes(name),add:(...names)=>{this.className=[...new Set([...tokens(),...names])].join(' ');},
      remove:(...names)=>{this.className=tokens().filter(name=>!names.includes(name)).join(' ');},
      toggle:(name,force)=>{const on=force===undefined?!tokens().includes(name):Boolean(force);if(on)this.classList.add(name);else this.classList.remove(name);return on;},
    };}
    setAttribute(name,value){this.attrs.set(name,String(value));if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=String(value);}
    getAttribute(name){return this.attrs.get(name)??null;}
    hasAttribute(name){return this.attrs.has(name);}
    removeAttribute(name){this.attrs.delete(name);}
    appendChild(node){this.insertBefore(node,null);return node;}
    append(...nodes){for(const node of nodes)this.appendChild(typeof node==='string'?new Node('',node):node);}
    prepend(...nodes){for(const node of nodes.reverse())this.insertBefore(node,this.childNodes[0]||null);}
    insertBefore(node,before){if(node===before)return;node.remove();const index=before?this.childNodes.indexOf(before):this.childNodes.length;assert.ok(index>=0,'reference child exists');node.parentNode=this;this.childNodes.splice(index,0,node);}
    replaceChildren(...nodes){for(const child of this.childNodes)child.parentNode=null;this.childNodes=[];this.append(...nodes);}
    remove(){if(this.parentNode){const siblings=this.parentNode.childNodes;siblings.splice(siblings.indexOf(this),1);this.parentNode=null;}}
    replaceWith(node){const parent=this.parentNode;if(!parent)return;parent.insertBefore(node,this);this.remove();}
    after(node){const parent=this.parentNode;if(parent)parent.insertBefore(node,parent.childNodes[parent.childNodes.indexOf(this)+1]||null);}
    contains(node){return node===this||this.childNodes.some(child=>child.contains(node));}
    get isConnected(){return this===document.body||Boolean(this.parentNode?.isConnected);}
    matches(selector){
      if(this.nodeType!==1)return false;
      if(selector.includes(','))return selector.split(',').some(part=>this.matches(part.trim()));
      if(selector==='*')return true;
      const attribute=/^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
      if(attribute){const key=attribute[1],value=key.startsWith('data-')?this.dataset[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]:this.getAttribute(key);return value!=null&&(attribute[2]===undefined||value===attribute[2]);}
      const id=/^#([\w-]+)$/.exec(selector);if(id)return this.id===id[1];
      const match=/^([\w-]+)?((?:\.[\w-]+)*)$/.exec(selector);
      return Boolean(match&&(!match[1]||this.tagName===match[1].toUpperCase())&&match[2].split('.').filter(Boolean).every(name=>this.classList.contains(name)));
    }
    querySelectorAll(selector){const result=[];for(const child of this.children){if(child.matches(selector))result.push(child);result.push(...child.querySelectorAll(selector));}return result;}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    closest(selector){for(let current=this;current;current=current.parentNode)if(current.matches(selector))return current;return null;}
    addEventListener(type,callback){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(callback);}
    dispatch(type,event={}){const value={target:this,currentTarget:this,preventDefault(){},stopPropagation(){},...event};const results=(this.listeners.get(type)||[]).map(callback=>callback(value));if(this['on'+type])results.push(this['on'+type](value));return results.at(-1);}
    click(){return this.dispatch('click');}
    focus(){document.activeElement=this;ctx.focuses.push(this.id);}
    blur(){if(document.activeElement===this)document.activeElement=null;}
    getClientRects(){return this.isConnected&&!this.classList.contains('hidden')?[{}]:[];}
    getBoundingClientRect(){return {top:0,bottom:400,left:0,right:300,width:300,height:400};}
    isEqualNode(other){return this.outerHTML===other.outerHTML;}
    get outerHTML(){return this.nodeType===3?this.data:'<'+this.tagName+JSON.stringify([...this.attrs])+'>'+this.childNodes.map(node=>node.outerHTML).join('')+'</'+this.tagName+'>';}
    get innerHTML(){return this.childNodes.map(node=>node.outerHTML).join('');}
    set innerHTML(value){this.replaceChildren(...parseHtml(String(value)).childNodes);}
  }
  const decode=text=>text.replace(/&(?:amp|quot|lt|gt|#39);/g,match=>({'&amp;':'&','&quot;':'"','&lt;':'<','&gt;':'>','&#39;':"'"}[match]));
  function parseHtml(value){
    const root=new Node('div'),stack=[root];
    for(const token of value.match(/<[^>]*>|[^<]+/g)||[]){
      if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}
      if(token.startsWith('<')){
        const name=/^<([\w-]+)/.exec(token)?.[1];if(!name)continue;
        const node=new Node(name);
        for(const attr of token.slice(name.length+1).matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))node.setAttribute(attr[1],decode(attr[2]??attr[3]??attr[4]??''));
        stack.at(-1).append(node);if(!/^(img|br|hr|input|meta|link)$/i.test(name)&&!token.endsWith('/>'))stack.push(node);
      }else stack.at(-1).append(new Node('',decode(token)));
    }
    return root;
  }
  document={hidden:false,activeElement:null,createElement:tag=>new Node(tag),createTextNode:text=>new Node('',text),getElementById:id=>document.body.querySelector('#'+id),getSelection:()=>null};
  document.body=new Node('body');
  document.body.innerHTML=html.slice(html.indexOf('<body>')+6,html.indexOf('<script',html.indexOf('<body>')));
  const node=id=>{const found=document.getElementById(id);assert.ok(found,`fixture element ${id}`);return found;};
  const timers=new Map();let timerId=0,api;
  const schedule=(callback,delay,interval=false)=>{const id=++timerId;timers.set(id,{callback,delay,interval});return id;};
  const window={claudeToolName:name=>name,claudeRender:(container,text)=>{container.textContent=text;},claudePreviewImage(){}};window.parent=window;
  class ClockDate extends Date {constructor(...args){super(...(args.length?args:[ctx.wall]));}static now(){return ctx.wall;}}
  class FileReader {readAsDataURL(file){this.result='data:image/png;base64,'+(file.data||'fixture');this.onload();}}
  const sandbox={
    document,window,localStorage:store(local),sessionStorage:store(session),history:{state:{},replaceState(value){this.state=value;}},
    crypto:{randomUUID:()=>{ctx.uuidCalls++;return randomUUID();}},AbortController,Date:ClockDate,performance:{now:()=>ctx.monotonic},FileReader,
    URL:{createObjectURL:()=> 'blob:fixture-'+randomUUID()},location:{reload:()=>ctx.reloads++},
    requestAnimationFrame:callback=>{ctx.frames.push(callback);callback();return ctx.frames.length;},viewportChanged(){},updateChips(){},
    closeMenu(){},openMenu:kind=>ctx.menus.push(kind),
    refreshSessions:async()=>{ctx.refreshes++;},
    loadModels:async()=>{api.state.modelsLoaded=true;api.state.capabilities={attachments:false};},
    setTimeout:(callback,delay)=>schedule(callback,delay),clearTimeout:id=>timers.delete(id),
    setInterval:(callback,delay)=>schedule(callback,delay,true),clearInterval:id=>timers.delete(id),
    async fetch(url,options={}){
      ctx.calls.push({url,options});
      const custom=ctx.fetchHook?.(url,options);if(custom!==undefined)return custom;
      if(url==='/claude/api/chat'&&options.method==='POST'){
        const body=JSON.parse(options.body);
        return response(202,{requestId:body.requestId,messageId:body.requestId,nativeMessageId:null,sessionId:body.sessionId||body.requestId,state:'dispatched',transport:'native-user-v1',queueMode:'next'});
      }
      if(url.startsWith('/claude/api/session/'))return response(200,{messages:[],cursor:0,before:null,hasMore:false});
      return response(404,{error:'request not found yet'});
    },
  };
  const context=createContext(sandbox);runInContext(assistantSource,context);api=runInContext(harnessSource,context);
  api.state.modelsLoaded=true;api.state.capabilities={attachments:false};api.state.model='chosen-model';
  api.state.navigation={capture(){},restore(){},has:()=>false,resetFollow(){}};
  api.state.readStatus=(key,text,retry,visible)=>text?ctx.errors.set(key,{text,retry,visible}):ctx.errors.delete(key);api.state.readStatus.render=()=>{};
  Object.defineProperty(ctx,'users',{get:()=>node('messages').querySelectorAll('.msg.user').map(wrap=>({text:wrap.querySelector('.user-text')?.textContent,wrap}))});
  Object.defineProperty(ctx,'polls',{get:()=>ctx.calls.filter(call=>call.url.includes('?since=')).length});
  return {api,ctx,node,local,session,timers,context,document,
    type(text){node('input').value=text;node('input').dispatch('input');},
    advance(ms){ctx.monotonic+=ms;ctx.wall+=ms;},
    async runTimers(delay){for(const [id,timer] of [...timers])if(timer.delay===delay){if(!timer.interval)timers.delete(id);await timer.callback();}},
    posts:()=>ctx.calls.filter(call=>call.url==='/claude/api/chat'&&call.options.method==='POST'),
    queries:()=>ctx.calls.filter(call=>call.url.startsWith('/claude/api/command/')),
    requests:()=>[...api.deliveryCommands.values()],stored:()=>JSON.parse(local.get(pendingStorage)||'[]'),
  };
}
