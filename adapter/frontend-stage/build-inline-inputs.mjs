import assert from 'node:assert/strict';
import {createInlineInputState,inlineInputStatus,inlineScrollKey} from './inline-input-state.mjs';
// V4 puts the human-readable reason on the ACK, not in reasonCode. Keep
// delivery uncertainty attached to the Error so presentation never invites a
// blind resend of an operation the native session may already have accepted.
export function commandAckError(ack, fallback='发送失败，请稍后重试'){
 const text=value=>typeof value==='string'&&value.trim()?value.trim():null;
 const code=text(ack?.reasonCode)||text(ack?.error?.code);
 const detail=text(ack?.message)||text(ack?.error?.message);
 const unknown=ack?.status==='unknown';
 const message=detail|| (unknown?'发送状态待确认，请核对电脑端会话后再操作':fallback);
 return Object.assign(Error(message),{...(code?{code}:{}),...(unknown?{outcomeUnknown:true}:{}),...(ack?.status==='rejected'?{sent:false}:{}),ackStatus:ack?.status});
}
export function normalizeCommandAck(command,ack){
 // A replay whose native outcome is not yet known uses the V4 literal form.
 // Normalize once, before either the UI ledger or inline projection sees it.
 return ack==='unknown'?{commandId:command.commandId,status:'unknown',reasonCode:'NATIVE_OUTCOME_UNKNOWN',message:'发送状态待确认，请核对电脑端会话后再操作'}:ack;
}
export function inlineInputEdits(source){
 const edits=[];
 function replace(needle,text,count=1){assert.equal(source.split(needle).length-1,count,'Inline input boundary changed: '+needle.slice(0,70));let at=0;for(let i=0;i<count;i++){const start=source.indexOf(needle,at);edits.push({start,end:start+needle.length,text});at=start+needle.length;}}
 // The hub may reload this iframe even while the first send is still creating
 // its native session. Use the real send lock and all attachment scopes, not
 // button disabled state (which also describes an empty or offline composer).
 replace('K.current=!0,W(!0);let F=', 'K.current=!0,W(!0);__codexMobileSending++;let F=');
 replace('finally{K.current=!1,W(!1)}', 'finally{__codexMobileSending=Math.max(0,__codexMobileSending-1);K.current=!1,W(!1)}');
 replace('throw Error(w.reasonCode??`sendText 被拒绝`)','throw __codexCommandAckError(w)');
 replace('if(w.status!==`accepted`){if(w.reasonCode===`modelUnavailable`','if(w.status!==`accepted`&&w.status!==`duplicate`){if(w.reasonCode===`modelUnavailable`');
 // Prewarming settles even when creation fails. Retain the actual failure on
 // its controller, without automatically allocating another native session.
 // MHt sends only {workspaceId, config?}, never firstInput. Mark this exact
 // empty-create failure so it cannot strand a not-yet-sent UI input as unknown.
 replace('function MHt(e){let{workspaceKey:', 'function MHt(e){let __codexDraftError=null;let{workspaceKey:');
 replace('if(e.status!==`accepted`||e.result?.type!==`createSession`){J.warn', 'if(e.status!==`accepted`&&e.status!==`duplicate`||e.result?.type!==`createSession`){__codexDraftError=Object.assign(__codexCommandAckError(e,`草稿会话创建失败，请核对原请求后重新连接`),{codexEmptySessionCreate:true});J.warn');
 replace('}).catch(e=>{J.warn(`[v4-draft-prewarm] createSession 失败`', '}).catch(e=>{__codexDraftError=Object.assign(e instanceof Error?e:Error(String(e)),{codexEmptySessionCreate:true});J.warn(`[v4-draft-prewarm] createSession 失败`');
 replace('markPromotionPending(){s===`draft`', 'getError(){return __codexDraftError},markPromotionPending(){s===`draft`');
 replace('if(!r.binding)throw Error("草稿会话创建失败，请核对原请求后重新连接")', 'if(!r.binding)throw r.controller.getError?.()??Error("草稿会话创建失败，请核对原请求后重新连接")');
 // Selecting an attachment needs this pane's draft session. A window-global
 // effect can be overwritten by a hidden draft or not yet registered when the
 // picker returns. Pass the callback synchronously with its attachment scope.
 replace('Qi=(0,Q.useRef)(async()=>void 0),$i=t??Re?.sessionId??Xi;', 'Qi=(0,Q.useRef)(async()=>void 0),$i=t??Re?.sessionId??Xi;const __codexPrepareAttachment=(0,Q.useCallback)(()=>{if(!__codexIsMobile()||t!==null)return Promise.resolve();return Ji().catch(e=>{const message=e?.message||`准备上传失败，请重新连接后重试`;Kt({code:e?.code||`SEND_FAILED`,message,detail:message});J.warn(`[codex-draft-attachment]`,e)})},[t,Ji,Kt]);');
 replace('attachmentSessionId:$i,attachmentPut:me,', 'attachmentSessionId:$i,prepareAttachmentSession:__codexPrepareAttachment,attachmentPut:me,');
 replace('attachmentSessionId:F=null,attachmentPut:I,', 'attachmentSessionId:F=null,prepareAttachmentSession:__codexPrepareAttachment,attachmentPut:I,');
 replace('scopeId:Le,attachmentSessionId:F,attachmentPut:I,', 'scopeId:Le,attachmentSessionId:F,prepareAttachmentSession:__codexPrepareAttachment,attachmentPut:I,');
 replace('attachmentSessionId:a=null,attachmentPut:o,', 'attachmentSessionId:a=null,prepareAttachmentSession:__codexPrepareAttachment,attachmentPut:o,');
 replace('attachmentPut:o,transferService:f}', 'attachmentPut:o,prepareAttachmentSession:__codexPrepareAttachment,transferService:f}');
 replace('let r=h.current.get(m),i=n.map(e=>{let t=!!(e.localPath&&r&&!pJ(r));', 'let r=h.current.get(m);!r?.sessionId&&n.length&&r?.prepareAttachmentSession?.();let i=n.map(e=>{let t=!!(e.localPath&&r&&!pJ(r));');
 replace('Ge=We.snapshot,Ke=', 'Ge=We.snapshot,__mobileInline=__codexUseInlineInputs(t,c,e,Ge),Ke=');
 replace('Do=Ge?Y8t(Ge.queue):null,','Do=__codexIsMobile()?__codexInlineInputs.project({sessionId:t,workspacePath:c,scopeId:__mobileInline,rows:Ge?.rows.window||[],queue:Ge?.queue||{items:[]}}):Ge?Y8t(Ge.queue):null,__mobileScroll=__codexUseInlineScroll(Do?.pendingGuides,Fn),');
 replace('pendingGuides:Ba?Do?.pendingGuides:[]','pendingGuides:__codexIsMobile()?Do?.pendingGuides||[]:Ba?Do?.pendingGuides:[]');
 replace('oe.length===0&&!x?(0,$.jsx)(`div`,','oe.length===0&&!x&&(!__codexIsMobile()||n.length===0)?(0,$.jsx)(`div`,');
 replace('hideTurnNavigator:R=!1}){let{intl:z}=q()','hideTurnNavigator:R=!1}){if(__codexIsMobile()&&n.length){S=!1,C=!1}let{intl:z}=q()');
 replace('function Y8t(e){let t=[],n=[];', 'function Y8t(e){if(__codexIsMobile())return{pendingGuides:[],visibleQueue:e};let t=[],n=[];');
 replace('t.map(e=>Byn(e,n))','t.map(e=>({...Byn(e,n),__mobileState:e.__mobileState}))');
 replace('userInputStatus:a},t.sourceCommandId)', 'userInputStatus:__codexIsMobile()?__codexInlineStatus(t.__mobileState,r.locale):a},t.sourceCommandId)');
 replace('f?.(w);let T=e===`createSession`?', 'f?.(w);await __codexInlineInputs.prepare(w,c);let T=e===`createSession`?');
 replace('Ue.store.markCommandPending({commandId:w.commandId,type:w.type,issuedAt:w.issuedAt})','Ue.store.markCommandPending({commandId:w.commandId,type:w.type,issuedAt:w.issuedAt,nativeInputId:__codexInlineInputs.nativeIdFor(w.commandId)})');
 replace('}:void 0),Ue?.store&&e!==`createSession`&&','}:void 0),__codexInlineInputs.bindLedger(OI,w),Ue?.store&&e!==`createSession`&&');
 replace('hu(e.type)?!n.has(e.commandId):!t.has(e.commandId)','hu(e.type)?!n.has(e.commandId)&&!n.has(e.nativeInputId):!t.has(e.commandId)');
 replace('if(t.size===0)return;let n=!1;for(let r of t){','if(t.size===0)return;for(const entry of this.entries.values())if(entry.sessionId===e.sessionId&&t.has(entry.nativeInputId))t.add(entry.commandId);let n=!1;for(let r of t){');
 replace('function vu(e,t){return e?e.queue.items.some(e=>e.sourceCommandId===t)?!0:e.rows.window.some(e=>e.kind===`userInput`&&e.origin===`realUser`&&e.sourceCommandId===t):!1}', 'function vu(e,t){let alias=__codexInlineInputs.nativeIdFor(t);return e?e.queue.items.some(e=>e.sourceCommandId===t||alias&&e.sourceCommandId===alias)?!0:e.rows.window.some(e=>e.kind===`userInput`&&e.origin===`realUser`&&(e.sourceCommandId===t||alias&&e.sourceCommandId===alias)):!1}');
 replace('if(OI.applyAck(w,E),', 'if(E=__codexNormalizeAck(w,E),__codexInlineInputs.ack(w,E),OI.applyAck(w,E),');
 const begin='pa=(0,Q.useCallback)(async(e,n)=>{let r=iEn({draftMode:t===null,inputRoutingMode:cn.current?.inputRouting.mode??null,heldQueueDisposition:n?.heldQueueDisposition});try{let t=await da(e,n);return t===`blocked`||t===`confirmationRequired`?t:(Kt(null),r&&fa(),`sent`)}catch(e){let n=e instanceof Error?e.message:String(e),r=n.includes(`provider.notInRegistry`);throw Kt({code:ET(e)??(r?`ZCODE_RUNTIME_MODEL_UNAVAILABLE`:`SEND_FAILED`),message:r?n:Oe.formatMessage({id:`chat.error.sendFailed`}),detail:n,...t?{taskId:t}:{}}),e}},[da,fa,Oe,t]);';
 const end='pa=(0,Q.useCallback)(async(e,n)=>{let r=iEn({draftMode:t===null,inputRoutingMode:cn.current?.inputRouting.mode??null,heldQueueDisposition:n?.heldQueueDisposition}),__inlineId=__codexIsMobile()?__codexInlineInputs.begin({sessionId:t,workspacePath:c,scopeId:__mobileInline,text:e,attachments:n?.attachments||[],queued:cn.current?.inputRouting.mode===`enqueue`}):null;try{let result=await da(e,__inlineId?{...n,requestedDelivery:`queue`,onCommandCreated:id=>{__codexInlineInputs.bind(__inlineId,id);n?.onCommandCreated?.(id)}}:n);if(result===`blocked`||result===`confirmationRequired`){__inlineId&&__codexInlineInputs.blocked(__inlineId);return result}return Kt(null),r&&fa(),`sent`}catch(e){__inlineId&&__codexInlineInputs.fail(__inlineId,e);let n=e instanceof Error?e.message:String(e),r=n.includes(`provider.notInRegistry`);throw Kt({code:ET(e)??(r?`ZCODE_RUNTIME_MODEL_UNAVAILABLE`:`SEND_FAILED`),message:__codexIsMobile()||r?n:Oe.formatMessage({id:`chat.error.sendFailed`}),detail:n,...t?{taskId:t}:{}}),e}},[da,fa,Oe,t,c,__mobileInline]);';
 replace(begin,end);
 replace('ie(),a===`startNow`&&(dt.current?.clear(),xt(``),A=st.current,H=!0);','ie(),(a===`startNow`||__codexIsMobile())&&(dt.current?.clear(),xt(``),__codexIsMobile()&&__codexRestoreDraft({text:``}),A=st.current,H=!0);');
 replace('t=e.applied&&e.current&&cn.current===E,n=e.applied&&!!ne&&!re','t=(e.applied&&e.current||__codexIsMobile()&&H&&!ot.current.trim())&&cn.current===E,n=e.applied&&!!ne&&!re');
 // The send callback also declares d for the selected code-comment array.
 // Capture the outer draft setter before entering that callback.
 replace('let Gn=(0,Q.useCallback)(async(e,n,r,a)=>{let o=pn()', 'let __codexRestoreDraft=d,Gn=(0,Q.useCallback)(async(e,n,r,a)=>{let o=pn()');
 replace('xt(o.text),A=st.current,H=!1):!e.applied','xt(o.text),__codexIsMobile()&&__codexRestoreDraft(o),A=st.current,H=!1):!e.applied');
 // The timeline mounts before a new native draft has a snapshot, too.
 const runtime=`\nvar __codexCommandAckError=${commandAckError.toString()};var __codexNormalizeAck=${normalizeCommandAck.toString()};var __codexInlineInputs=(${createInlineInputState.toString()})();var __codexMobileSending=0;globalThis.__CODEX_COMPOSER_RELOAD_SAFE__=()=>__codexMobileSending===0&&!__codexInlineInputs.hasUnconfirmed()&&!Object.values(MF.getState().scopes).some(items=>items.length>0);var __codexInlineStatus=${inlineInputStatus.toString()};var __codexInlineScrollKey=${inlineScrollKey.toString()};function __codexUseInlineScroll(items,scrollRef){const last=Q.useRef(null),key=__codexInlineScrollKey(items);Q.useLayoutEffect(()=>{if(__codexIsMobile()&&key&&key!==last.current){last.current=key;scrollRef.current?.()}},[key,scrollRef])}function __codexIsMobile(){return globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true}function __codexUseInlineInputs(sessionId,workspacePath,paneId,snapshot){const scope=Q.useMemo(()=>crypto.randomUUID(),[sessionId,workspacePath,paneId]);Q.useSyncExternalStore(__codexInlineInputs.subscribe,__codexInlineInputs.version,__codexInlineInputs.version);Q.useEffect(()=>{if(snapshot)__codexInlineInputs.reconcile(sessionId,snapshot.rows.window)},[sessionId,snapshot]);return scope}\n`;
 edits.push({start:source.length,end:source.length,text:runtime});return edits;
}
