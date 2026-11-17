import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {commandAckError,normalizeCommandAck,inlineInputEdits} from '../frontend-stage/build-inline-inputs.mjs';
import {createInlineInputState} from '../frontend-stage/inline-input-state.mjs';
import {isCodexMobileReloadSafe} from '../codex-entry.mjs';

// Replay reviewed stages only in memory. Never rebuild/write generated assets.
const manifest=JSON.parse(await readFile(new URL('../frontend-stage/bundle-patch-manifest.json',import.meta.url),'utf8'));
let source=await readFile(new URL('../frontend-stage/baseline/index-BsmXQHMM.js',import.meta.url),'utf8');
for(const patch of manifest.patches)source=source.split(patch.needle).join(patch.replacement);
for(const stage of manifest.mobileSplit.stages){
 if(stage.name==='inline-mobile-inputs')break;
 for(const edit of stage.edits.toReversed())source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
}
const edits=inlineInputEdits(source).sort((a,b)=>a.start-b.start);
for(let i=1;i<edits.length;i++)assert(edits[i-1].end<=edits[i].start,'patches must not overlap');
for(const edit of edits.toReversed())source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);

function sendDecision(ack){
 const begin=source.indexOf('if(w.reasonCode===`guard.heldQueueConfirmationStale`)');
 const end=source.indexOf('x?(x.promote()',begin);
 assert(begin>0&&end>begin);
 return vm.runInNewContext('(function(){'+source.slice(begin,end)+'return "sent"})()',{w:ack,C:{},__codexCommandAckError:commandAckError});
}

test('actual send ACK branch exposes outer message and retains the machine reason',()=>{
 assert.throws(()=>sendDecision({status:'rejected',reasonCode:'CODEX_WRITE_FAILED',message:'电脑端会话状态尚未同步，请确认 Codex 可接管'}),error=>error.message.includes('电脑端会话状态尚未同步')&&error.code==='CODEX_WRITE_FAILED'&&error.sent===false);
 assert.throws(()=>sendDecision({status:'rejected',reasonCode:'DESKTOP_PROTOCOL_UNSUPPORTED',message:'当前 Codex 桌面协议版本尚未适配，请更新手机服务后重试'}),error=>error.message==='当前 Codex 桌面协议版本尚未适配，请更新手机服务后重试'&&error.code==='DESKTOP_PROTOCOL_UNSUPPORTED'&&error.sent===false&&!error.outcomeUnknown);
 assert.equal(sendDecision({status:'duplicate',result:{inputId:'already-sent'}}),'sent');
 assert.equal(sendDecision({status:'accepted'}),'sent');
 assert.equal(sendDecision({status:'rejected',reasonCode:'guard.heldQueueConfirmationStale'}),'confirmationRequired');
});

test('unconfirmed ACK survives the outer send failure and reconciles once by native identity',async()=>{
 const state=createInlineInputState({newId:()=> 'local',nativeId:async()=> 'native'}),query={sessionId:'S',workspacePath:'/w',scopeId:'pane'};
 const id=state.begin({...query,text:'do not resend',attachments:[{ref:'image-ref'}]});state.bind(id,'C');
 await state.prepare({type:'sendText',commandId:'C',sessionId:'S'},'/w');
 const ack={status:'unknown',reasonCode:'NATIVE_OUTCOME_UNKNOWN',message:'原生回执尚未确认'};
 state.ack({commandId:'C'},ack);
 assert.throws(()=>sendDecision(ack),error=>{assert.equal(error.outcomeUnknown,true);state.fail(id,error);return true;});
 state.fail(id,Error('outer refresh error'));
 assert.equal(state.project(query).pendingGuides[0].__mobileState,'unknown');
 assert.equal(state.project(query).pendingGuides[0].attachments[0].ref,'image-ref');
 state.reconcile('S',[{kind:'userInput',sourceCommandId:'native'}]);
 assert.equal(state.project(query).pendingGuides.length,0);
});

test('real transport literal unknown is normalized before the actual dispatch ledger and never resent',async()=>{
 const wrapperStart=source.indexOf('async function bce('),wrapperEnd=source.indexOf('r.ackReleased=!0,a}',wrapperStart)+'r.ackReleased=!0,a}'.length;
 const methodStart=source.indexOf('async sendCommand(t,r){'),methodEnd=source.indexOf('},async queryCommands',methodStart)+1;
 assert(wrapperStart>0&&wrapperEnd>wrapperStart&&methodStart>0&&methodEnd>methodStart);
 let calls=0;
 const transport=vm.createContext({Ll:()=>false,a:async()=>({capabilities:{independentPlanState:true}}),n:{workspacePath:'/w'},e:{sendConversationCommandV4:async()=>{calls++;return 'unknown';}}});
 vm.runInContext(source.slice(wrapperStart,wrapperEnd),transport);
 const send=vm.runInContext('('+source.slice(methodStart,methodEnd).replace('async sendCommand(','async function(')+')',transport);
 const envelope={type:'sendText',commandId:'C',sessionId:'S',payload:{text:'once only'}};
 const raw=await send(envelope);assert.equal(raw,'unknown');
 const state=createInlineInputState({newId:()=> 'id',nativeId:async()=> 'native'}),query={sessionId:'S',workspacePath:'/w'};
 const id=state.begin({...query,text:'once only'});state.bind(id,'C');await state.prepare(envelope,'/w');
 const ledger=[];const dispatch=vm.createContext({E:raw,w:envelope,__codexNormalizeAck:normalizeCommandAck,__codexInlineInputs:state,OI:{applyAck:(command,ack)=>ledger.push(ack)}});
 const start=source.indexOf('if(E=__codexNormalizeAck(w,E),'),end=source.indexOf(',OI.applyAck(w,E),',start)+',OI.applyAck(w,E)'.length;
 assert(start>0&&end>start);vm.runInContext(source.slice(start+3,end),dispatch);
 assert.equal(ledger[0].status,'unknown');assert.equal(ledger[0].commandId,'C');
 assert.throws(()=>sendDecision(dispatch.E),error=>{state.fail(id,error);return error.outcomeUnknown===true;});
 assert.equal(state.hasUnconfirmed(),true);
 state.reconcile('S',[{kind:'userInput',sourceCommandId:'native'}]);assert.equal(state.hasUnconfirmed(),false);assert.equal(state.project(query).pendingGuides.length,0);
 assert.equal(calls,1,'normalization and read reconciliation must never replay a native mutation');
 for(const ack of [{status:'noop'},{status:'duplicate'},{status:'rejected'}])assert.equal(normalizeCommandAck(envelope,ack),ack);
});

test('reload guard covers hidden attachment scopes and real in-flight or unknown sends, not plain text',()=>{
 const scopes={};const context=vm.createContext({MF:{getState:()=>({scopes})},crypto:{randomUUID:()=> 'local'}});
 vm.runInContext(source.slice(source.indexOf('var __codexCommandAckError=')),context);
 const safe=()=>isCodexMobileReloadSafe({check:context.__CODEX_COMPOSER_RELOAD_SAFE__,document:{querySelector:()=>null}});
 assert.equal(safe(),true,'persisted text is not an attachment or pending operation');
 scopes['hidden-session-A']=[{file:{name:'photo.png'},uploadStatus:'ready'}];assert.equal(safe(),false);delete scopes['hidden-session-A'];
 vm.runInContext('__codexMobileSending++',context);assert.equal(safe(),false,'first-send preflight cannot reload before inline begin');
 vm.runInContext('__codexMobileSending--',context);assert.equal(safe(),true);
 vm.runInContext('var localId=__codexInlineInputs.begin({sessionId:"S",workspacePath:"/w",text:"message"});__codexInlineInputs.bind(localId,"C")',context);assert.equal(safe(),false);
 vm.runInContext('__codexInlineInputs.ack({commandId:"C"},{status:"unknown"});__codexInlineInputs.fail(localId,Error("outer catch"))',context);assert.equal(safe(),false,'finally alone never clears an uncertain outcome');
 vm.runInContext('__codexInlineInputs.ack({commandId:"C"},{status:"accepted",result:{inputId:"native"}})',context);assert.equal(safe(),true,'accepted durable input may be restored from history');
 assert(source.includes('K.current=!0,W(!0);__codexMobileSending++;'));
 assert(source.includes('finally{__codexMobileSending=Math.max(0,__codexMobileSending-1);K.current=!1,W(!1)}'));
 assert.equal(isCodexMobileReloadSafe({check:()=>{throw Error('unavailable');}}),false);
 assert.equal(isCodexMobileReloadSafe({check:null,document:{querySelector:()=>({})}}),false);
});

test('missing or nested ACK messages still produce readable errors, never only a raw code',()=>{
 assert.equal(commandAckError({reasonCode:'CODEX_WRITE_FAILED'}).message,'发送失败，请稍后重试');
 assert.equal(commandAckError({message:' ',error:{message:'请重新配对',code:'AUTH_REQUIRED'}}).message,'请重新配对');
 assert.match(commandAckError({status:'unknown'}).message,/待确认.*核对/);
});

function draftManager(reply){
 const start=source.indexOf('function MHt(e){'),end=source.indexOf('var NHt=',start),classStart=source.indexOf('PHt=class{'),classEnd=source.indexOf(',sH=new Map;',classStart);
 const requests=[];const context={setTimeout,clearTimeout,Map,Symbol,Promise,Array,Error,J:{warn(){},info(){}},NHt:[500,1000,2000],__codexCommandAckError:commandAckError};
 const Constructor=vm.runInNewContext(source.slice(start,end)+';('+source.slice(classStart+'PHt='.length,classEnd)+')',context);
 return{manager:new Constructor('/w',async(type,payload,sessionId)=>{requests.push({type,payload,sessionId});return typeof reply==='function'?reply():reply;},()=>({}),()=>{}),requests,get calls(){return requests.length;}};
}

test('new-session creation forwards rejection detail to first send without another native create',async()=>{
 const f=draftManager({status:'rejected',reasonCode:'CODEX_WRITE_FAILED',message:'请解锁电脑并打开 Codex'}),generation={};
 const release=f.manager.acquire({generation,invalidationVersion:0,onBinding(){}});
 for(let i=0;i<2;i++)await assert.rejects(f.manager.waitForSession(0,generation),error=>error.message==='请解锁电脑并打开 Codex'&&error.code==='CODEX_WRITE_FAILED');
 assert.equal(f.calls,1);release();
});

test('real empty prewarm unknown through pa never dispatches a message or strands the draft reload guard',async()=>{
 let releaseReply;const pendingReply=new Promise(resolve=>{releaseReply=resolve;});
 const f=draftManager(()=>pendingReply),generation={};const release=f.manager.acquire({generation,invalidationVersion:0,onBinding(){}});
 const scopes={};let messageDispatches=0;const errors=[];
 const context=vm.createContext({Error,MF:{getState:()=>({scopes})},crypto:{randomUUID:()=> 'ui-input'},iEn:()=>false,t:null,c:'/w',__mobileInline:'draft',cn:{current:{inputRouting:{mode:'startNow'}}},da:async()=>{await f.manager.waitForSession(0,generation);messageDispatches++;},Kt:error=>errors.push(error),ET:error=>error.code,Oe:{formatMessage:()=> 'generic'},fa(){},__CODEX_ORIGINAL_BRIDGE__:{codexBridge:true}});
 vm.runInContext(source.slice(source.indexOf('var __codexCommandAckError=')),context);
 const start=source.indexOf('pa=(0,Q.useCallback)(async(e,n)=>'),end=source.indexOf(',[da,fa,Oe,t,c,__mobileInline]);',start);
 assert(start>0&&end>start);
 const pa=vm.runInContext('('+source.slice(start+'pa=(0,Q.useCallback)('.length,end)+')',context);
 vm.runInContext('__codexMobileSending++',context);
 const pending=pa('original first message');assert.equal(context.__CODEX_COMPOSER_RELOAD_SAFE__(),false);
 releaseReply(normalizeCommandAck({commandId:'empty-create'},'unknown'));
 await assert.rejects(pending,error=>error.outcomeUnknown===true&&error.codexEmptySessionCreate===true);
 vm.runInContext('__codexMobileSending--',context);
 assert.equal(f.calls,1);assert.equal(f.requests[0].type,'createSession');assert.equal(f.requests[0].sessionId,null);
 assert.deepEqual(Object.keys(f.requests[0].payload),['workspaceId']);assert.equal(f.requests[0].payload.workspaceId,'/w');
 assert.equal(messageDispatches,0);assert.equal(errors[0].message,'发送状态待确认，请核对电脑端会话后再操作');
 assert.equal(context.__CODEX_COMPOSER_RELOAD_SAFE__(),true,'only the never-dispatched UI record is removed; text restoration can reload');
 scopes.photo=[{file:{name:'photo.png'}}];assert.equal(context.__CODEX_COMPOSER_RELOAD_SAFE__(),false,'unsent image still belongs to its memory scope');
 release();
});

test('empty-create tagging never erases an already bound unknown message command',async()=>{
 const state=createInlineInputState({newId:()=> 'id',nativeId:async()=> 'native'}),id=state.begin({sessionId:'S',workspacePath:'/w',text:'message'});
 state.bind(id,'send-command');await state.prepare({type:'sendText',commandId:'send-command',sessionId:'S'},'/w');
 state.fail(id,Object.assign(Error('unknown'),{outcomeUnknown:true,codexEmptySessionCreate:true}));assert.equal(state.hasUnconfirmed(),true);
 state.reconcile('S',[{kind:'userInput',sourceCommandId:'native'}]);assert.equal(state.hasUnconfirmed(),false);
 const unbound=state.begin({sessionId:null,workspacePath:'/w',text:'message'});state.fail(unbound,Object.assign(Error('unclassified unknown'),{outcomeUnknown:true}));assert.equal(state.hasUnconfirmed(),true,'absence of commandId alone is never evidence to discard');
});

test('duplicate native create ACK keeps the original session instead of reporting failure',async()=>{
 const f=draftManager({status:'duplicate',result:{type:'createSession',sessionId:'existing'}}),generation={};
 const release=f.manager.acquire({generation,invalidationVersion:0,onBinding(){}});
 const binding=await f.manager.waitForSession(0,generation);assert.equal(binding.sessionId,'existing');assert.equal(f.calls,1);binding.promote();release();
});

test('failed send restores its cleared draft but never overwrites newer input or another conversation',()=>{
 const composer=source.indexOf('let __codexRestoreDraft=d,Gn='),start=source.indexOf('ae=()=>{',composer),end=source.indexOf(',U=()=>{',start);
 assert(start>composer&&end>start);
 for(const [text,scope,expected] of [['','S',true],['newer input','S',false],['','different',false]]){
  const changes=[];const context={te:true,T:{restore:()=>({applied:false,current:false})},__codexIsMobile:()=>true,H:true,ot:{current:text},cn:{current:scope},E:'S',ne:null,re:false,fn:{current:{}},o:{text:'original draft',editorStateJson:'original-editor'},dt:{current:{setEditorStateJson:value=>changes.push(['editor',value]),setText:value=>changes.push(['text',value])}},xt:value=>changes.push(['input',value]),__codexRestoreDraft:value=>changes.push(['persisted',value.text]),st:{current:0}};
  vm.runInNewContext('('+source.slice(start+'ae='.length,end)+')()',context);
  assert.deepEqual(changes,expected?[['editor','original-editor'],['input','original draft'],['persisted','original draft']]:[]);
 }
});

function attachmentPreparer(Ji,onError=()=>{}){
 const start=source.indexOf('const __codexPrepareAttachment=(0,Q.useCallback)('),end=source.indexOf(',[t,Ji,Kt]);',start);assert(start>0&&end>start);
 return vm.runInNewContext('('+source.slice(start+'const __codexPrepareAttachment=(0,Q.useCallback)('.length,end)+')',{t:null,__codexIsMobile:()=>true,Ji,Kt:onError,J:{warn(){}}});
}

test('attachment preparation failure reaches the visible error state instead of console only',async()=>{
 let visible;
 const run=attachmentPreparer(async()=>{throw Object.assign(Error('原生会话创建失败，请重新连接'),{code:'CODEX_WRITE_FAILED'});},value=>{visible=value;});
 await run();assert.equal(visible.message,'原生会话创建失败，请重新连接');assert.equal(visible.code,'CODEX_WRITE_FAILED');
 assert(source.includes('message:__codexIsMobile()||r?n:Oe.formatMessage({id:`chat.error.sendFailed`})'));
});

test('actual picker insertion uses its own draft before any global effect and cannot be stolen by another pane',async()=>{
 const marker=source.indexOf('!r?.sessionId&&n.length&&r?.prepareAttachmentSession?.()'),start=source.lastIndexOf('(0,Q.useCallback)(e=>{',marker),end=source.indexOf('},[M,P,m,R])',marker)+1;
 assert(marker>0&&start>0&&end>start);const insertion=source.slice(start+'(0,Q.useCallback)('.length,end);
 const files=new Map(),owners=new Map(),queued=[],pending=[],panes=[];
 const update=(scope,fn)=>files.set(scope,fn(files.get(scope)||[]));
 const renderSet='h.current.set(m,{sessionId:a,workspacePath:t,workspaceIdentity:n,remoteSessionId:r,attachmentPut:o,prepareAttachmentSession:__codexPrepareAttachment,transferService:f})';
 const renderAt=source.indexOf(renderSet),hookAt=source.lastIndexOf('function v$t(',renderAt);assert(hookAt>0&&renderAt>hookAt);assert(!source.slice(hookAt,renderAt).includes('useEffect'),'attachment metadata must be installed synchronously during render, before passive effects');
 const renderMetadata=(scope,prepare,sessionId=null)=>vm.runInNewContext(renderSet,{h:{current:owners},m:scope,a:sessionId,t:'/w',n:null,r:null,o:()=>{},f:{},__codexPrepareAttachment:prepare});
 const makePane=(scope,reply={status:'accepted',result:{type:'createSession',sessionId:'native-'+scope}})=>{
  const f=draftManager(reply),generation={},errors=[];
  const release=f.manager.acquire({generation,invalidationVersion:0,onBinding:binding=>{if(binding)owners.get(scope).sessionId=binding.sessionId;}});
  const prepare=attachmentPreparer(()=>f.manager.waitForSession(0,generation),error=>errors.push(error));
  renderMetadata(scope,()=>{const p=prepare();pending.push(p);return p;});
  const context={m:scope,h:{current:owners},NF:key=>files.get(key)||[],M:update,P:(scope,id)=>queued.push([scope,id]),R(){},w(){},pJ:()=>false,oJ(){},__codexPrepareDraftAttachment:()=>{throw Error('global singleton must not be called');}};
  const add=vm.runInNewContext('('+insertion+')',context);const pane={f,release,add,context,scope,errors};panes.push(pane);return pane;
 };
 const a=makePane('A'),b=makePane('B');assert.equal(a.f.calls,0);assert.equal(b.f.calls,0,'mounting panes must not allocate a native session');
 // Use the actual native-file-input handler; do not invoke prewarm manually.
 const inputStart=source.indexOf('te=(0,Q.useCallback)(e=>{let t=Array.from(e.currentTarget.files??[])'),inputEnd=source.indexOf('},[B])',inputStart)+1;assert(inputStart>0&&inputEnd>inputStart);
 const handle=vm.runInNewContext('('+source.slice(inputStart+'te=(0,Q.useCallback)('.length,inputEnd)+')',{B:a.add});
 const target={files:[{id:'photo-A',filename:'a.png'}],value:'selected'};handle({currentTarget:target});
 assert.equal(target.value,'');assert.equal(a.f.calls,1);assert.equal(b.f.calls,0);assert.equal(files.get('A')[0].uploadStatus,'waitingSession');
 await Promise.all(pending);assert.equal(owners.get('A').sessionId,'native-A');assert.equal(b.f.calls,0);
 // A now has an old native binding and may be hidden while B becomes active.
 b.add([{id:'photo-B',filename:'b.png'}]);await Promise.all(pending);
 assert.equal(a.f.calls,1);assert.equal(owners.get('B').sessionId,'native-B');
 // Execute the original session-ready effect, which queues the selected file.
 const wakeAt=source.indexOf('if(a&&t)for(let t of e)t.uploadStatus===`waitingSession`'),wakeStart=source.lastIndexOf('(0,Q.useEffect)(()=>{',wakeAt),wakeEnd=source.indexOf('},[a,P,r,T,m,N,n])',wakeAt)+1;
 assert(wakeAt>0&&wakeStart>0&&wakeEnd>wakeStart);
 for(const pane of panes){
  const wake=vm.runInNewContext('('+source.slice(wakeStart+'(0,Q.useEffect)('.length,wakeEnd)+')',{...pane.context,a:owners.get(pane.scope).sessionId,r:null,n:null,N:(scope,id,fn)=>update(scope,items=>items.map(item=>item.id===id?fn(item):item))});wake();
  assert.equal(files.get(pane.scope)[0].uploadStatus,'queued');assert.equal(pane.f.calls,1);pane.release();
 }
 assert.deepEqual(queued,[['A','photo-A'],['B','photo-B']]);
 a.add([{id:'photo-A-2',filename:'a2.png'}]);assert.equal(a.f.calls,1);assert.equal(b.f.calls,1);assert.equal(files.get('A')[1].uploadStatus,'queued','returning to an already bound pane reuses only its own session');
 // Negative control: restoring the prior singleton line reproduces zero new
 // create calls plus waitingSession when a hidden pane owns the global hook.
 let legacyPrepared=0;owners.set('legacy-B',{sessionId:null,prepareAttachmentSession:()=>legacyPrepared++});
 const legacy=vm.runInNewContext('('+insertion.replace('r?.prepareAttachmentSession?.()','globalThis.__codexPrepareDraftAttachment?.()')+')',{...b.context,m:'legacy-B',__codexPrepareDraftAttachment:async()=>({sessionId:'native-A'})});
 legacy([{id:'legacy-photo'}]);assert.equal(legacyPrepared,0);assert.equal(files.get('legacy-B')[0].uploadStatus,'waitingSession');
 let oldCallback=0,newCallback=0;renderMetadata('same-scope',()=>oldCallback++);
 const sameScopeAdd=vm.runInNewContext('('+insertion+')',{...b.context,m:'same-scope'});
 renderMetadata('same-scope',()=>newCallback++);sameScopeAdd([{id:'fresh-callback'}]);assert.equal(oldCallback,0);assert.equal(newCallback,1,'same-scope render refreshes Ji without relying on an effect or callback recreation');
 let boundPrepares=0;renderMetadata('bound',()=>boundPrepares++,'native-existing');
 vm.runInNewContext('('+insertion+')',{...b.context,m:'bound'})([{id:'already-bound'}]);assert.equal(boundPrepares,0);assert.equal(files.get('bound')[0].uploadStatus,'queued');
 const failed=makePane('failed',{status:'rejected',reasonCode:'CODEX_WRITE_FAILED',message:'只属于当前失败草稿'});failed.add([{id:'failed-photo'}]);await Promise.all(pending);
 assert.equal(failed.errors[0].message,'只属于当前失败草稿');assert.equal(a.errors.length,0);assert.equal(b.errors.length,0);assert.equal(failed.f.calls,1);
 failed.add([{id:'failed-photo-2'}]);await Promise.all(pending);assert.equal(failed.f.calls,1,'a failed/unknown prewarm is never replaced by automatic fresh native creation');failed.release();
 assert(!source.includes('__codexPrepareDraftAttachment'),'no hidden-pane global writer remains');
 for(const needle of ['attachmentSessionId:$i,prepareAttachmentSession:__codexPrepareAttachment,attachmentPut:me','attachmentSessionId:F=null,prepareAttachmentSession:__codexPrepareAttachment','scopeId:Le,attachmentSessionId:F,prepareAttachmentSession:__codexPrepareAttachment','attachmentSessionId:a=null,prepareAttachmentSession:__codexPrepareAttachment','attachmentPut:o,prepareAttachmentSession:__codexPrepareAttachment,transferService:f'])assert(source.includes(needle),needle);
});
