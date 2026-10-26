import {attachImageGestures} from './image-gestures.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const baseline=await readFile(new URL('./baseline/index-BsmXQHMM.js',import.meta.url),'utf8');
const icon='data:image/svg+xml,'+encodeURIComponent(await readFile(new URL('./brand-icon.svg',import.meta.url),'utf8'));
let compat=baseline;
const patches=[];
function patch(name,needle,replacement,expected=1){
 const count=compat.split(needle).length-1;
 if(count!==expected)throw Error(name+': expected '+expected+' matches, got '+count);
 compat=compat.split(needle).join(replacement);patches.push({name,needle,replacement,count});
}
function section(start,end){const a=compat.indexOf(start),b=compat.indexOf(end,a+start.length);if(a<0||b<0)throw Error('Original component boundary changed: '+start);return compat.slice(a,b);}
patch('preview-touch-handler', 'Atr();export{', attachImageGestures.toString()+';Atr();export{');
const needle='Atr();export{';
const replacement=`function __codexOriginalMount({services:e,platform:t,props:n={},key:r="codex-original-h5"}){document.title="Codex";K9.render((0,$.jsx)(C2,{children:(0,$.jsx)(_o,{settingService:e.settingService,broadcastService:e.broadcastService,preferSettingServiceLocale:!0,children:(0,$.jsx)(U5n,{...n,services:e,platform:t,codexNavigationKey:r})})},"codex-original-shell"))}export{__codexOriginalMount,t7n as __codexOriginalConnect,ytr as __codexOriginalPlatform,Zj as __codexBrandIcon};export{`;
patch('authenticated-original-shell-bootstrap',needle,replacement);
// A user may return Home while the same draft remains active. Give every
// explicit New Task action a distinct navigation intent without remounting it.
patch('mobile-navigation-request','(0,Q.useEffect)(()=>{c===`chat`&&v(`chat`)},[c])','(0,Q.useEffect)(()=>{c===`chat`&&v(`chat`)},[c]),(0,Q.useEffect)(()=>m?.onMobileNavigationRequested?.(page=>{page===`chat`&&C()}),[m,C])');
// Navigation re-applies the original workspace bootstrap without tearing down
// the shell, model hooks, directory state or live subscriptions.
patch('navigation-key-through-root','function W5n({services:e,platform:t,','function W5n({codexNavigationKey:__codexNavigationKey,services:e,platform:t,');
patch('navigation-key-through-bootstrap','K8n({clientMode:Ye?','K8n({codexNavigationKey:__codexNavigationKey,clientMode:Ye?');
patch('navigation-bootstrap-key','function K8n({initialWorkspaceAbsPath:e,','function K8n({codexNavigationKey:__codexNavigationKey=!0,initialWorkspaceAbsPath:e,');
patch('navigation-bootstrap-per-intent','if(!(!o||O.current)){if(O.current=!0,_&&e&&n===','if(!(!o||O.current===__codexNavigationKey)){if(O.current=__codexNavigationKey,_&&e&&n===');
patch('navigation-bootstrap-key-dependency','[s,m,_,o,r,i,N,a,e,t,n,c,d])','[s,m,_,o,r,i,N,a,e,t,n,c,d,__codexNavigationKey])');
// The paired Codex connection is already authenticated before mounting. A new
// workspace must not wait for the unrelated ZCode OAuth/provider restore gate.
patch('paired-native-workspace-bootstrap','canBootstrapInitialWorkspace:$e&&Pt','canBootstrapInitialWorkspace:Ye&&globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true||$e&&Pt');
// The native catalogue supplies the real default effort. The original helper
// otherwise picks the final (often most expensive) reasoning level.
patch('native-model-default-effort',section('function jE(e,t){','var S8e='),'function jE(e,t){let n=e.providers.find(e=>e.providerId===t.providerId)?.models.find(e=>e.modelId===t.modelId),r=n?.config.optionSpecs.reasoningLevel.values,i=n?.defaultReasoningEffort,a=r?.includes(i)?i:r?.[0];if(a)return{providerId:t.providerId,modelId:t.modelId,options:{reasoningLevel:a}}}');
// Acquire/rendering is side-effect free. Only the existing first-send
// waitForSession path may request a real native conversation.
patch('draft-start-request-version','PHt=class{subscribers=new Map;current=null;','PHt=class{subscribers=new Map;current=null;requestedVersion=null;');
patch('draft-create-only-on-user-send','n(),this.current?.retiring&&(await this.current.completion,n()),this.current?.settled&&!this.current.binding&&(this.clearRetryTimer(),this.blockedInvalidationVersion=null,this.current=null,this.startCurrent(e));let r=this.current;', 'n(),this.requestedVersion=e,this.reconcile(),this.current?.retiring&&(await this.current.completion,n());let r=this.current;');
patch('draft-no-background-prewarm','&&this.blockedInvalidationVersion!==e&&this.startCurrent(e))}clearRetryTimer()', '&&this.blockedInvalidationVersion!==e&&this.requestedVersion===e&&this.startCurrent(e))}clearRetryTimer()');
const retry=section('scheduleRetryAfterFailure(e){','startCurrent(e,t=0){');
patch('draft-no-automatic-create-retry',retry,'scheduleRetryAfterFailure(e){this.clearRetryTimer()}');
patch('unknown-create-requires-review','草稿会话创建失败，请重试','草稿会话创建失败，请核对原请求后重新连接');
// A real user Send owns the in-flight native creation. React can replace a
// same-version subscriber while the project index publishes the new thread;
// that is not abandonment of this user operation or permission to delete it.
patch('first-send-claim-survives-subscriber-remount',section('async waitForSession(e,t){','acquire(e){'),`async waitForSession(e,t){let n=()=>{if(this.requestedInvalidationVersion()!==e||!Array.from(this.subscribers.values()).some(e=>e.generation===t))throw Error("草稿会话已切换，请重新发送")};n(),this.requestedVersion=e,this.reconcile();if(this.current?.retiring){await this.current.completion;if(this.requestedInvalidationVersion()!==e)throw Error("草稿会话已切换，请重新发送")}let r=this.current;if(!r)throw Error("草稿会话尚未开始创建");r.claimed=!0,r.controller.markPromotionPending();try{await r.completion;let t=this.requestedInvalidationVersion();if(t!==null&&t!==e||this.current!==r||r.retiring||r.invalidationVersion!==e)throw Error("草稿会话已切换，请重新发送");if(!r.binding)throw Error("草稿会话创建失败，请核对原请求后重新连接");return r.binding}catch(e){r.claimed=!1,this.requestedVersion===e&&(this.requestedVersion=null),this.current===r&&this.subscribers.size===0&&(this.retireCurrent(),this.current||this.onEmpty());throw e}}`);
patch('claimed-send-not-idle-prewarm','!(this.subscribers.size>0)&&(this.retireCurrent(),this.current||this.onEmpty())','!(this.subscribers.size>0)&&!this.current?.claimed&&(this.retireCurrent(),this.current||this.onEmpty())');
patch('release-first-send-claim-after-promotion','promote:()=>{this.current!==n||n.binding!==t||n.controller.markPromoted()}','promote:()=>{if(this.current!==n||n.binding!==t)return;n.controller.markPromoted(),n.claimed=!1,this.requestedVersion=null,this.subscribers.size===0&&(this.retireCurrent(),this.current||this.onEmpty())}');
patch('release-first-send-claim-after-discard','n.controller.markDiscarded(),n.binding=null,this.blockedInvalidationVersion=n.invalidationVersion,this.emitBindings()','n.controller.markDiscarded(),n.claimed=!1,this.requestedVersion=null,n.binding=null,this.blockedInvalidationVersion=n.invalidationVersion,this.emitBindings(),this.subscribers.size===0&&(this.retireCurrent(),this.current||this.onEmpty())');
patch('do-not-dispose-native-create-before-ack','e.binding=null,e.controller.dispose(),this.emitBindings(),e.settled&&(this.current=null)','e.binding=null,e.claimed||e.controller.dispose(),this.emitBindings(),e.settled&&(this.current=null)');
// Null means no group was selected. Native creation already owns project
// membership; do not submit an unrelated group placement after the first send.
patch('skip-unselected-task-group-placement','a=r===void 0?void 0:async()=>{let t={taskId:e,workspacePath:c,','a=r==null?void 0:async()=>{let t={taskId:e,workspacePath:c,');
patch('task-group-error-toast-expires','lo(Oe.formatMessage({id:`taskGroup.failed`}),{durationMs:0,','lo(Oe.formatMessage({id:`taskGroup.failed`}),{durationMs:5000,');
patch('running-task-indicator-before-unread','typeof e.unreadAt==`number`?`unread`:t?.phase===`prewarming`||t?.phase===`running`?`loading`:`none`','t?.phase===`prewarming`||t?.phase===`running`?`loading`:typeof e.unreadAt==`number`?`unread`:`none`');
patch('running-task-label-in-list','fe=uj(n.updatedAt,v),pe=Got(n)','fe=Rit(n)?v.formatMessage({id:`chat.target.status.active`}):uj(n.updatedAt,v),pe=Got(n)');
patch('running-task-label-in-groups','F=uj(e.updatedAt,x),I=ji(e)','F=Rit(e)?x.formatMessage({id:`chat.target.status.active`}):uj(e.updatedAt,x),I=ji(e)');
// This mobile workspace is intentionally limited to projects, conversations
// and model choices. It does not expose ZCode account or settings screens.
patch('project-and-conversation-navigation',section('function DEt({props:e,onCreate:t}){','function OEt(e){'),'function DEt({props:e,onCreate:t}){let r=e.webRemoteControlWorkspaceSwitcher?.deviceNavigation;return(0,$.jsxs)(`div`,{"data-testid":`sidebar-primary-navigation`,className:`flex flex-col gap-1 px-2 py-3 ${e.isWebRemoteControl&&!r?`max-md:pt-11`:``}`,children:[r?(0,$.jsx)(EEt,{navigation:r}):null,(0,$.jsx)(Ywt,{onCreateTask:t})]})}');
// Home has no floating header to reserve space for. Reuse the conversation theme menu.
patch('remove-project-inline-files',section('j.length>1&&!D?(0,$.jsxs)(vb,',',(0,$.jsx)(lI,{testId:`virtual-project-create-task`'),'null');
patch('hide-sidebar-view-filter','(0,$.jsxs)(vb,{children:[(0,$.jsx)(uy,{title:i.formatMessage({id:`project.view`})','!1&&(0,$.jsxs)(vb,{children:[(0,$.jsx)(uy,{title:i.formatMessage({id:`project.view`})');
// The Codex shell stays mounted across navigation; explicitly finish the
// original cross-workspace loading state instead of relying on an unmount.
patch('finish-native-workspace-navigation','markTaskReadExpectedUnreadAt:f.unreadAt}:{}})}catch(e)', 'markTaskReadExpectedUnreadAt:f.unreadAt}:{}});if(globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true){u?.(null),s?.(!1),c?.({crossWorkspace:!1}),a?.()}}catch(e)');
patch('home-navigation-top-spacing','className:`flex flex-col gap-1 px-2 py-3 ${e.isWebRemoteControl&&!r?`max-md:pt-11`:``}`','className:`flex flex-col gap-1 px-2 py-3`');
patch('home-theme-instead-of-keyboard-hint','(0,$.jsx)(`span`,{className:`ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest`,children:r})','(0,$.jsx)(`span`,{className:`ml-auto shrink-0`,onClick:e=>e.stopPropagation(),children:(0,$.jsx)(FNn,{})})');
patch('remove-account-settings-footer','activeTaskId:m,isDesktop:h=!1,banner:g,className:_}){let{intl:v}=q()', 'activeTaskId:m,isDesktop:h=!1,banner:g,className:_}){return null;let{intl:v}=q()');
patch('disable-settings-open-shortcut','openSettingsTab:()=>{let e=n().tabs.find(BT);','openSettingsTab:()=>{return;let e=n().tabs.find(BT);');
patch('conversation-only-quick-commands','u.filter(e=>(a||e.id!==`toggle-terminal`&&e.id!==`add-terminal-tab`)&&(o||e.id!==`add-review-tab`))','u.filter(e=>[`new-task`,`toggle-sidebar`].includes(e.id))');
patch('remove-task-list-settings-cta','u?(0,$.jsx)(`div`,{className:`border-t border-outline/40 p-3`,children:(0,$.jsxs)(X,{type:`button`,variant:`outline`,size:`sm`,onClick:A,"data-testid":LVe','!1?(0,$.jsx)(`div`,{className:`border-t border-outline/40 p-3`,children:(0,$.jsxs)(X,{type:`button`,variant:`outline`,size:`sm`,onClick:A,"data-testid":LVe');
patch('remove-model-settings-footer','providerFooter:s&&F?','providerFooter:!1?');
patch('hide-unavailable-mode-picker','onConfigPickerOpenChange:i,onSwitchMode:a}){let{intl:o}=q()', 'onConfigPickerOpenChange:i,onSwitchMode:a}){return null;let{intl:o}=q()');
patch('image-enabled-composer-controls','appSlashCommands:le,enableMentionPanel:ue}){let{intl:de}=q()', 'appSlashCommands:le,enableMentionPanel:ue}){h=!1,g=!1,_=!1,le=[],ue=!0;let{intl:de}=q()');
patch('native-skill-catalog-filter','function yq(e,t){return e.filter(rXt)}','function yq(e,t){return globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true?e.filter(s=>s.source==="codex"&&typeof s.id==="string"&&s.id.startsWith("codex:")):e.filter(rXt)}');
patch('native-context-skills-only','showPlugins:ue!==!1','showPlugins:!1');
patch('native-mention-skills-only','function qXt(e){return e===`@`?WXt:e===`#`?GXt:e===`$`?KXt:[]}','function qXt(e){return globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true?(e===`$`?KXt:[]):e===`@`?WXt:e===`#`?GXt:e===`$`?KXt:[]}');
patch('native-mention-trigger-scope','x=!a&&(u?.trigger===`@`||u?.trigger===`$`||u?.trigger===`#`)','x=!a&&(globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true?u?.trigger===`$`:(u?.trigger===`@`||u?.trigger===`$`||u?.trigger===`#`))');
patch('native-slash-skills-only','return[...t,...r]},[s,p,o]),E=(0,Q.useMemo)(()=>wXt(m),[m])','return globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true?[]:[...t,...r]},[s,p,o]),E=(0,Q.useMemo)(()=>globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true?[]:wXt(m),[m])');

patch('preview-touch-effect','return(0,$.jsxs)(WF,{children:[(0,$.jsx)(GF,{asChild:!0,children:(0,$.jsxs)(`div`,{"data-image-preview":!0', '(0,Q.useEffect)(()=>attachImageGestures(c.current),[n]);return(0,$.jsxs)(WF,{children:[(0,$.jsx)(GF,{asChild:!0,children:(0,$.jsxs)(`div`,{"data-image-preview":!0');
patch('native-same-origin-attachment-preview','async attachmentRead(r){if(r.signal?.throwIfAborted(),await a(),','async attachmentRead(r){if(globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true){const url=globalThis.__CODEX_NATIVE_ATTACHMENT_URL__?.(r.ref,r.sessionId);if(url)return{url,mediaType:r.mediaType||"image/*"};}if(r.signal?.throwIfAborted(),await a(),');
patch('lazy-native-history-keeps-manual-paging','function ble(e,t){if(t||!yu(e)||!e)return!1;let n=e.rows.window[0]?.turnId;return n?!e.rows.window.some(e=>e.turnId===n&&e.kind===`turnHeader`):!1}','function ble(e,t){if(globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true)return!1;if(t||!yu(e)||!e)return!1;let n=e.rows.window[0]?.turnId;return n?!e.rows.window.some(e=>e.turnId===n&&e.kind===`turnHeader`):!1}');
// A tail-only native snapshot can omit the turn header. Projection row createdAt
// is the native turn start (or zero), never the page-open or thread-create time.
patch('native-running-tail-elapsed-fallback','g=fbn({header:e.header,segmentIndex:i,triggerRow:r.triggerRow','g=fbn({header:e.header??(h&&globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true&&r.orderedRows[0]?.createdAt>0?{startedAt:r.orderedRows[0].createdAt}:void 0),segmentIndex:i,triggerRow:r.triggerRow');
patch('remove-home-zcode-decoration',section('function $3t({className:e}){','function FY(){'),'function $3t({className:e}){return null}');
// Brand replacements affect the app shell and localized UI only. User rows,
// thread titles, RPC channel names and .zcodeignore paths remain untouched.
const oldIcon=compat.match(/Zj=`[^`]+`/)?.[0];if(!oldIcon)throw Error('Original app icon not found');
patch('codex-app-icon',oldIcon,'Zj='+JSON.stringify(icon));
patch('codex-symbol',section('function dNt({className:e}){','function fNt({className:e}){'),'function dNt({className:e}){return(0,$.jsx)(`img`,{src:Zj,alt:`Codex`,className:Z(`shrink-0 select-none object-contain`,e),"aria-hidden":`true`,draggable:!1})}');
patch('codex-wordmark',section('function fNt({className:e}){','function kz(e){'),'function fNt({className:e}){return(0,$.jsx)(`span`,{className:Z(`shrink-0 font-semibold tracking-tight`,e),children:`Codex`})}');
const literals=[...new Set([...compat.matchAll(/`(?:\\.|[^`\\])*`/g)].map(match=>match[0]).filter(value=>/\bZCode\b/.test(value)))];
for(const [index,literal] of literals.entries())patch('shell-brand-literal-'+index,literal,literal.replace(/\bZCode\b/g,'Codex'),compat.split(literal).length-1);
patch('codex-logo-identifier','"data-app-logo":`zcode`','"data-app-logo":`codex`');
await mkdir(new URL('./assets/',import.meta.url),{recursive:true});
await writeFile(new URL('./assets/index-BsmXQHMM.js',import.meta.url),compat);
// Keep canonical locale imports intact; adapt dictionaries before the first
// React mount. This never scans or rewrites user conversation content.
const intl=await readFile(new URL('../../vendor/zcode-web/remote/v4/3.16.3/assets/IntlProvider-itolvRb2.js',import.meta.url),'utf8');
const intlNeedle='export{p as a';
if(intl.split(intlNeedle).length!==2)throw Error('Original locale export changed');
const intlBranding=`for(const messages of Object.values(_)){for(const [key,value] of Object.entries(messages))if(typeof value==="string")messages[key]=value.replace(/\\bZCode\\b/gi,"Codex");const locale=messages===_["zh-CN"]?"zh-CN":"en-US";for(const key of ["chat.placeholder.newTask","chat.placeholder.newTaskMobile"])messages[key]=locale==="zh-CN"?"向 Codex 发送消息":"Send a message to Codex";}export{p as a`;
const intlCompat=intl.replace(intlNeedle,intlBranding);
await writeFile(new URL('./assets/IntlProvider-itolvRb2.js',import.meta.url),intlCompat);
const hash=value=>createHash('sha256').update(value).digest('hex');
await writeFile(new URL('./bundle-patch-manifest.json',import.meta.url),JSON.stringify({baselineSHA256:hash(baseline),compatSHA256:hash(compat),exactReplacementCount:patches.length,patches,localePatch:{sourceSHA256:hash(intl),compatSHA256:hash(intlCompat),needle:intlNeedle,replacement:intlBranding},originalEntryFunctionRetained:true,autoOriginalEntryDisabled:true,uiFunctionsModified:['jE','PHt','DEt','LAt','m3t','SQt','$3t','dNt','fNt'],canonicalURL:'/remote/v4/3.16.3/assets/index-BsmXQHMM.js',reason:'Authenticated original UI with native model defaults, lazy create on first send, Codex branding, and no unrelated account/settings entry.'},null,2));
console.log(JSON.stringify({baselineSHA256:hash(baseline),compatSHA256:hash(compat),patchCount:patches.length}));
