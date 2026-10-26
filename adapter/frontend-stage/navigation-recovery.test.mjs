import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import vm from 'node:vm';
const target=process.env.NAV_TARGET?pathToFileURL(resolve(process.env.NAV_TARGET)+'/'):new URL('../../',import.meta.url);
const {mountCodexOriginalH5}=await import(new URL('adapter/frontend-stage/browser-adapter.mjs',target));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const context=(task,workspace='/fixture')=>({workspacePath:workspace,...(task?{initialTaskId:task}:{initialTaskDraft:{projectId:null}}),navigationKey:task||'draft'});
async function harness(t,{initialTaskId,resolveNavigation=async request=>context(request.options?.taskId,request.workspaceKey||'/fixture')}={}){
 const mounts=[],requests=[];
 const control=await mountCodexOriginalH5({compat:{__codexOriginalPlatform:()=>({}),__codexOriginalMount:props=>mounts.push(props)},services:{projectService:{readTree:async()=>({projects:[],tasks:[]})}},info:{authenticated:true,initialTaskId,workspaces:[{workspacePath:'/fixture'},{workspacePath:'/detached'}]},resolveNavigation:request=>{requests.push(request);return resolveNavigation(request);}});
 t.after(()=>control.dispose());return{mounts,requests,control,view:()=>mounts.at(-1).props.webRemoteControlWorkspaceSwitcher};
}
test('old same-workspace empty and nonempty reports cannot clear or replace a newly selected task',async t=>{
 const h=await harness(t),old=h.view();await h.control.switcher.switchWorkspace('/fixture',{taskId:'selected'});const current=h.view();
 await current.updateMobileTaskView({workspacePath:'/fixture',taskId:'selected'});
 for(const task of [undefined,null,'old-task']){await old.updateMobileViewState('/fixture',task);assert.equal(h.control.getContext().initialTaskId,'selected');}
 await old.updateMobileTaskView(null);assert.equal(h.control.getContext().localMobileView.taskId,'selected');
 await current.updateMobileViewState('/fixture',undefined);assert.equal(h.control.getContext().initialTaskId,'selected','even a current passive empty report cannot demote a selected task');
 assert.notEqual(current,old);
});
test('same owner can promote draft and select another task; empty cleanup never demotes promotion',async t=>{
 const h=await harness(t);await h.control.switcher.startDraft('/fixture');const view=h.view(),key=h.mounts.at(-1).key;
 await view.updateMobileViewState('/fixture','created-on-send');assert.equal(h.control.getContext().initialTaskId,'created-on-send');assert.equal(h.control.getContext().initialTaskDraft,undefined);
 await view.updateMobileViewState('/fixture',undefined);assert.equal(h.control.getContext().initialTaskId,'created-on-send');
 await view.updateMobileViewState('/fixture','clicked-another-task');assert.equal(h.control.getContext().initialTaskId,'clicked-another-task');assert.equal(h.mounts.at(-1).key,key,'reporting does not remount the composer');
});
test('explicit task-to-draft navigation still clears selection and invalidates the old reporter',async t=>{
 const h=await harness(t,{initialTaskId:'selected'}),old=h.view();await h.control.switcher.startDraft('/fixture');
 assert.equal(h.control.getContext().initialTaskId,undefined);assert.deepEqual(h.control.getContext().initialTaskDraft,{projectId:null});
 await old.updateMobileViewState('/fixture','late-promotion');assert.equal(h.control.getContext().initialTaskId,undefined);
 await h.view().updateMobileViewState('/fixture','new-draft-promotion');assert.equal(h.control.getContext().initialTaskId,'new-draft-promotion');
});
test('transport/viewport-like rerenders and repeated identical drafts preserve the reporter owner',async t=>{
 const h=await harness(t);await h.control.switcher.startDraft('/fixture');const view=h.view(),key=h.mounts.at(-1).key;
 h.control.setTransportState('connecting');h.control.setTransportState('paired');assert.equal(h.view(),view);assert.equal(h.mounts.at(-1).key,key);
 await h.control.switcher.startDraft('/fixture');assert.equal(h.view(),view);assert.equal(h.mounts.at(-1).key,key);
 await view.updateMobileViewState('/fixture','promoted');assert.equal(h.control.getContext().initialTaskId,'promoted');
});
test('failed navigation leaves the existing owner valid for a later first-send report',async t=>{
 const gate=deferred(),h=await harness(t,{resolveNavigation:()=>gate.promise}),view=h.view();const navigate=h.control.switcher.switchWorkspace('/fixture',{taskId:'unreachable'});
 gate.reject(Error('offline'));await assert.rejects(navigate,/offline/);assert.equal(h.view(),view);
 await view.updateMobileViewState('/fixture','created-after-error');assert.equal(h.control.getContext().initialTaskId,'created-after-error');
});
test('out-of-order navigation responses and callbacks always leave the newest committed selection',async t=>{
 const a=deferred(),b=deferred();let calls=0;const h=await harness(t,{resolveNavigation:()=>++calls===1?a.promise:b.promise});const initial=h.view();
 const first=h.control.switcher.switchWorkspace('/fixture',{taskId:'A'}),second=h.control.switcher.switchWorkspace('/fixture',{taskId:'B'});
 b.resolve(context('B'));await second;const current=h.view();await initial.updateMobileViewState('/fixture',undefined);a.resolve(context('A'));await first;
 assert.equal(h.control.getContext().initialTaskId,'B');assert.equal(h.view(),current);await initial.updateMobileViewState('/fixture','A');assert.equal(h.control.getContext().initialTaskId,'B');
});
test('all late-report orders from two retired views are harmless after a third commit',async t=>{
 const h=await harness(t);const owners=[h.view()];await h.control.switcher.switchWorkspace('/fixture',{taskId:'A'});owners.push(h.view());await h.control.switcher.switchWorkspace('/fixture',{taskId:'B'});
 const events=[()=>owners[0].updateMobileViewState('/fixture',undefined),()=>owners[0].updateMobileViewState('/fixture','old'),()=>owners[1].updateMobileViewState('/fixture',undefined),()=>owners[1].updateMobileViewState('/fixture','A')];
 function permutations(items){if(!items.length)return[[]];return items.flatMap((item,i)=>permutations(items.filter((_,j)=>i!==j)).map(rest=>[item,...rest]));}
 for(const order of permutations(events)){for(const event of order)await event();assert.equal(h.control.getContext().initialTaskId,'B');}
});
test('validated detach allows empty task in a different OR same workspace',async t=>{
 let target='/detached';const h=await harness(t,{initialTaskId:'selected',resolveNavigation:async()=>context(null,target)});
 await h.mounts.at(-1).services.projectService.prepareSession();await h.view().updateMobileViewState('/detached',undefined);
 assert.equal(h.control.getContext().workspacePath,'/detached');assert.equal(h.control.getContext().initialTaskId,undefined);assert.equal(h.control.getContext().initialTaskDraft.projectId,null);
 await h.view().updateMobileViewState('/detached','second-selected');target='/detached';await h.mounts.at(-1).services.projectService.prepareSession();await h.view().updateMobileViewState('/detached',undefined);
 assert.equal(h.control.getContext().initialTaskId,undefined);assert.equal(h.control.getContext().initialTaskDraft.projectId,null);
});
test('pending prepareSession cannot authorize detach after navigation or a different task report',async t=>{
 const gate=deferred();const h=await harness(t,{initialTaskId:'selected',resolveNavigation:request=>request.action==='project-draft'?gate.promise:context('new')});const old=h.mounts.at(-1);
 const prepare=old.services.projectService.prepareSession();await h.control.switcher.switchWorkspace('/fixture',{taskId:'new'});gate.resolve(context(null,'/detached'));
 await assert.rejects(prepare,{code:'CODEX_NAVIGATION_STALE'});await old.props.webRemoteControlWorkspaceSwitcher.updateMobileViewState('/detached',undefined);assert.equal(h.control.getContext().initialTaskId,'new');
 await assert.rejects(old.services.projectService.prepareSession(),{code:'CODEX_NAVIGATION_STALE'});
});
test('newer prepare wins; no-op reports do not break a pending legitimate detach',async t=>{
 const gates=[deferred(),deferred()];let calls=0;const h=await harness(t,{initialTaskId:'selected',resolveNavigation:()=>gates[calls++].promise});const project=h.mounts.at(-1).services.projectService;
 const old=project.prepareSession(),latest=project.prepareSession();await h.view().updateMobileViewState('/fixture','selected');gates[1].resolve(context(null,'/detached'));assert.equal((await latest).workspacePath,'/detached');
 gates[0].resolve(context(null,'/fixture'));await assert.rejects(old,{code:'CODEX_NAVIGATION_STALE'});await h.view().updateMobileViewState('/detached',undefined);assert.equal(h.control.getContext().workspacePath,'/detached');
});
test('task selection invalidates an outstanding detach even within the same view owner',async t=>{
 const gate=deferred(),h=await harness(t,{initialTaskId:'A',resolveNavigation:()=>gate.promise});const prepare=h.mounts.at(-1).services.projectService.prepareSession();
 await h.view().updateMobileViewState('/fixture','B');gate.resolve(context(null,'/detached'));await assert.rejects(prepare,{code:'CODEX_NAVIGATION_STALE'});
 await h.view().updateMobileViewState('/detached',undefined);assert.equal(h.control.getContext().initialTaskId,'B');
});
test('dispose rejects preparation/new navigation and drops in-flight responses and reports',async t=>{
 const gate=deferred(),h=await harness(t,{initialTaskId:'A',resolveNavigation:()=>gate.promise}),view=h.view();const pending=h.control.switcher.switchWorkspace('/fixture',{taskId:'B'});h.control.dispose();
 await view.updateMobileViewState('/fixture','stale');await view.updateMobileTaskView(null);gate.resolve(context('B'));await pending;
 assert.equal(h.control.getContext().initialTaskId,'A');await assert.rejects(h.mounts[0].services.projectService.prepareSession(),{code:'CODEX_NAVIGATION_STALE'});await assert.rejects(h.control.switcher.startDraft('/fixture'),{code:'CODEX_NAVIGATION_STALE'});
});

async function reporterHarness(){
 const bundle=await readFile(new URL('adapter/frontend-stage/assets/index-BsmXQHMM.js',target),'utf8');const start=bundle.indexOf('function fOt('),end=bundle.indexOf('function pOt(',start);assert(start>0&&end>start);
 const effects=[],layout=[],slots=[],pending=[];let slot=0;
 const effect=(fn,deps)=>{const i=slot++,old=slots[i];if(!old||!deps||deps.some((v,j)=>!Object.is(v,old.deps?.[j]))){slots[i]={deps,cleanup:old?.cleanup};pending.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}};
 const ctx={MO:()=>false,Q:{useRef:v=>{const i=slot++;return slots[i]??(slots[i]={current:v});},useLayoutEffect:fn=>layout.push(fn),useEffect:effect},J:{warn(){}},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},window:{addEventListener(){},removeEventListener(){}}};
 const reporter=vm.runInNewContext('('+bundle.slice(start,end)+')',ctx);
 return{render(props){slot=0;reporter(props);for(const fn of layout.splice(0))fn();},flush(){for(const fn of pending.splice(0))fn();},takeEffects(){return pending.splice(0);},offset:start};
}
test('exact patched reporter: disabled null/positive IDs do not report; enabled transition with same ID does',async()=>{
 const h=await reporterHarness(),calls=[],switcher={updateMobileViewState:async(...args)=>calls.push(args)};
 h.render({enabled:false,activeTaskId:null,workspacePath:'/fixture',switcher});h.flush();assert.equal(calls.length,0);
 h.render({enabled:false,activeTaskId:'created',workspacePath:'/fixture',switcher});h.flush();assert.equal(calls.length,0);
 h.render({enabled:true,activeTaskId:'created',workspacePath:'/fixture',switcher});h.flush();assert.deepEqual(calls,[['/fixture','created']]);
 h.render({enabled:true,activeTaskId:'created',workspacePath:'/fixture',switcher});h.flush();assert.equal(calls.length,1,'stable dependencies do not repeat');
 h.render({enabled:false,activeTaskId:'created',workspacePath:'/fixture',switcher});h.flush();h.render({enabled:true,activeTaskId:'created',workspacePath:'/fixture',switcher});h.flush();assert.equal(calls.length,2);
});
test('original reporter delayed effects across viewport-like disable/remount cannot erase current selection',async t=>{
 const h=await harness(t);const oldHooks=await reporterHarness();oldHooks.render({enabled:true,activeTaskId:null,workspacePath:'/fixture',switcher:h.view()});const staleEffects=oldHooks.takeEffects();
 await h.control.switcher.switchWorkspace('/fixture',{taskId:'selected'});const now=await reporterHarness();now.render({enabled:true,activeTaskId:'selected',workspacePath:'/fixture',switcher:h.view()});now.flush();
 for(const effect of staleEffects)effect();assert.equal(h.control.getContext().initialTaskId,'selected');
 now.render({enabled:false,activeTaskId:null,workspacePath:'/fixture',switcher:h.view()});now.flush();assert.equal(h.control.getContext().initialTaskId,'selected');
 now.render({enabled:true,activeTaskId:'selected',workspacePath:'/fixture',switcher:h.view()});now.flush();assert.equal(h.control.getContext().initialTaskId,'selected');
});
test('readiness promotion is retained after disabled-null reporting and rejected from a retired draft',async t=>{
 const h=await harness(t);await h.control.switcher.startDraft('/fixture');const old=h.view(),hooks=await reporterHarness();
 hooks.render({enabled:true,activeTaskId:'native-created-id',workspacePath:'/fixture',switcher:old});hooks.flush();assert.equal(h.control.getContext().initialTaskId,'native-created-id');assert.equal(h.control.getContext().initialTaskDraft,undefined);
 hooks.render({enabled:false,activeTaskId:null,workspacePath:'/fixture',switcher:old});hooks.flush();assert.equal(h.control.getContext().initialTaskId,'native-created-id');
 await h.control.switcher.startDraft('/fixture');await old.updateMobileViewState('/fixture','late-native-id');assert.equal(h.control.getContext().initialTaskId,undefined);
});

test('same-task reports after detach preparation do not consume the explicit pending detach',async t=>{
 let target='/detached';const h=await harness(t,{initialTaskId:'selected',resolveNavigation:async()=>context(null,target)});
 await h.mounts.at(-1).services.projectService.prepareSession();await h.view().updateMobileViewState('/fixture','selected');await h.view().updateMobileViewState('/detached');
 assert.equal(h.control.getContext().workspacePath,'/detached');assert.equal(h.control.getContext().initialTaskId,undefined);
 await h.view().updateMobileViewState('/detached','again');target='/detached';await h.mounts.at(-1).services.projectService.prepareSession();await h.view().updateMobileViewState('/detached','again');await h.view().updateMobileViewState('/detached');
 assert.equal(h.control.getContext().initialTaskId,undefined);assert.equal(h.control.getContext().initialTaskDraft.projectId,null);
});

test('enabled empty draft still reports and toggling enabled alone re-reports it',async()=>{
 const h=await reporterHarness(),calls=[],switcher={updateMobileViewState:async(...args)=>calls.push(args)};
 for(const enabled of [false,true,false,true]){h.render({enabled,activeTaskId:null,workspacePath:'/fixture',switcher});h.flush();}
 assert.deepEqual(calls,[['/fixture',undefined],['/fixture',undefined]]);
});
test('retired task-view reports cannot overwrite current view; current matching view remains accepted',async t=>{
 const h=await harness(t,{initialTaskId:'old'}),old=h.view();await h.control.switcher.switchWorkspace('/fixture',{taskId:'new'});
 const view={workspacePath:'/fixture',taskId:'new'};await h.view().updateMobileTaskView(view);
 for(const value of [null,{workspacePath:'/fixture',taskId:'old'},{workspacePath:'/detached',taskId:'new'}]){
  await old.updateMobileTaskView(value);assert.deepEqual(h.control.getContext().localMobileView,view);
 }
 await h.view().updateMobileTaskView({workspacePath:'/fixture',taskId:'wrong'});assert.deepEqual(h.control.getContext().localMobileView,view);
 await h.view().updateMobileTaskView(null);assert.equal(h.control.getContext().localMobileView,null,'current visibility cleanup is still allowed');
});
