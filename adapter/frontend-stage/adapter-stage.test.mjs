import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mountCodexOriginalH5} from './browser-adapter.mjs';
import {createPlatformServices} from './platform-services.mjs';
import {workspaceInfo,resolveNavigation} from '../navigation.mjs';
import {applyMobileSplit,bundleSha} from './mobile-split-rebuild.mjs';

async function draftHarness(){
 const mounted=[],requests=[];
 const tree={conversationWorkspacePath:'/conversations',projects:[{id:'P',name:'Project',roots:[{rootPath:'/project'}]}],tasks:[{taskId:'T',workspacePath:'/project',projectId:'P'}]},status={cwd:'/project'};
 const services={projectService:{readTree:async()=>tree,prepareSession(){throw Error('must not call native prepareSession');}}};
 const control=await mountCodexOriginalH5({compat:{__codexOriginalPlatform:()=>({}),__codexOriginalMount:value=>mounted.push(value)},services,info:workspaceInfo(tree,status),resolveNavigation:async request=>{
  requests.push(request);
  return resolveNavigation(JSON.parse(JSON.stringify(request)),{tree,status,getTaskMeta:async()=>null});
 }});
 return{mounted,requests,control,services};
}

test('global, project and workspace draft protocols retain ownership and local input snapshots',async()=>{
 const {mounted,requests,control}=await draftHarness();
 const snapshot={sourceWorkspaceKey:'/project',draft:{text:'未发送输入',editorStateJson:'{}'},attachments:[new Blob(['attachment'])]};
 await control.switcher.openProjectDraft({projectId:'P',taskGroupId:null,initialComposerDraft:snapshot});
 assert.equal(mounted.at(-1).props.initialTaskDraft.initialComposerDraft,snapshot);
 assert.equal(requests.at(-1).project.initialComposerDraft,undefined);
 assert.equal(mounted.at(-1).props.initialTaskDraft.projectId,'P');
 await control.switcher.openProjectDraft({projectId:null});
 assert.equal(mounted.at(-1).props.initialWorkspaceAbsPath,'/conversations');
 assert.equal(mounted.at(-1).props.initialTaskDraft.projectId,null);
 await control.switcher.startDraft('/project',{initialComposerDraft:snapshot});
 assert.equal(mounted.at(-1).props.initialTaskDraft.initialComposerDraft,snapshot);
 assert.equal(mounted.at(-1).props.initialTaskDraft.projectId,'P');
 await control.switcher.startDraft('/project',{projectId:null,taskId:'T'});
 assert.equal(mounted.at(-1).props.initialTaskId,undefined);
 assert.equal(mounted.at(-1).props.initialTaskDraft.projectId,null);
 control.dispose();
});

test('detach resolves a conversation directory without remounting or creating a task',async()=>{
 const {mounted,requests,control,services}=await draftHarness();
 await control.switcher.openProjectDraft({projectId:'P'});
 const count=mounted.length,key=mounted.at(-1).key;
 const project=mounted.at(-1).services.projectService;
 assert.equal(await project.readTree(),await services.projectService.readTree());
 assert.deepEqual(await project.prepareSession(),{workspacePath:'/conversations',projectId:null,hostId:'local'});
 assert.equal(mounted.length,count);
 assert.deepEqual(requests.at(-1),{action:'project-draft',project:{}});
 await control.switcher.updateMobileViewState('/conversations');
 assert.equal(control.getContext().workspacePath,'/conversations');
 assert.equal(control.getContext().initialTaskDraft.projectId,null);
 await control.switcher.updateMobileViewState('/project','stale-old-mount');
 assert.equal(control.getContext().workspacePath,'/conversations');
 control.setTransportState('connecting');
 assert.equal(mounted.at(-1).key,key);
 control.dispose();
});

test('repeat draft taps do not remount and promoted task reports keep the render key',async()=>{
 const {mounted,control}=await draftHarness();
 const navigation=[];control.switcher.onMobileNavigationRequested(page=>navigation.push(page));
 await Promise.all([control.switcher.openProjectDraft({}),control.switcher.openProjectDraft({})]);
 assert.equal(mounted.length,2);
 const draftKey=mounted.at(-1).key;
 await control.switcher.openProjectDraft({});
 assert.equal(mounted.length,2);
 assert.equal(mounted.at(-1).key,draftKey);
 assert.deepEqual(navigation,['chat','chat']);
 const key=mounted.at(-1).key;
 await control.switcher.updateMobileViewState('/conversations','created-on-send');
 control.setTransportState('paired');
 assert.equal(mounted.at(-1).key,key);
 assert.equal(control.getContext().initialTaskDraft,undefined);
 await control.switcher.openProjectDraft({});
 assert.notEqual(mounted.at(-1).key,key);
 control.dispose();
});

test('canonical original UI has only reproducible reviewed compatibility patches',async()=>{
 const baseline=await readFile(new URL('./baseline/index-BsmXQHMM.js',import.meta.url),'utf8'),compat=await readFile(new URL('./assets/index-BsmXQHMM.js',import.meta.url),'utf8'),manifest=JSON.parse(await readFile(new URL('./bundle-patch-manifest.json',import.meta.url),'utf8'));
 let rebuilt=baseline;
 for(const patch of manifest.patches){assert.equal(rebuilt.split(patch.needle).length-1,patch.count,patch.name);rebuilt=rebuilt.split(patch.needle).join(patch.replacement);}
 rebuilt=applyMobileSplit(rebuilt,manifest.mobileSplit);
 assert.equal(bundleSha(rebuilt),manifest.compatSHA256);
 assert.equal(rebuilt,compat);
 assert.equal(manifest.exactReplacementCount,manifest.patches.length);
 assert(compat.includes('requestedVersion===e&&this.startCurrent(e)'));
 assert(compat.includes('openSettingsTab:()=>{return;'));
 const originalLocale=await readFile(new URL('../../vendor/zcode-web/remote/v4/3.16.3/assets/IntlProvider-itolvRb2.js',import.meta.url),'utf8'),locale=await readFile(new URL('./assets/IntlProvider-itolvRb2.js',import.meta.url),'utf8');
 assert.equal(originalLocale.replace(manifest.localePatch.needle,manifest.localePatch.replacement),locale);
 assert(!compat.includes('Atr();export{'));
 for(const name of ['HNn','U5n','W5n','DEt','SQt','W3t'])assert(baseline.includes('function '+name+'(')&&compat.includes('function '+name+'('));
});

test('paired own Codex mount uses original shell switcher without cloud credentials',async()=>{
 const mounted=[],requests=[];
 const control=await mountCodexOriginalH5({compat:{__codexOriginalPlatform:()=>({ownWebPlatform:true}),__codexOriginalMount:value=>mounted.push(value)},services:{identity:'actual-server-services'},info:{authenticated:true,deviceId:'local',workspaces:[{path:'/project/a'},{path:'/project/b'}]},resolveNavigation:async request=>{requests.push(request);return{workspacePath:'/project/b',initialTaskId:'actual-thread',navigationIntent:'chat'};}});
 assert.equal(mounted.length,1);
 assert.equal(mounted[0].props.restoreSession,false);
 assert.equal(mounted[0].props.supportsSettings,false);
 assert.equal(mounted[0].props.webRemoteControlWorkspaceSwitcher,control.switcher);
 assert.equal(mounted[0].props.initialWorkspaceAbsPath,'/project/a');
 assert.equal(mounted[0].props.webRemoteControlWorkspaceSwitcher.deviceNavigation,undefined);
 assert.equal(mounted[0].platform.jwt,undefined);
 await control.switcher.switchWorkspace('/project/b',{taskId:'actual-thread'});
 assert.equal(requests.length,1);
 assert.equal(mounted.at(-1).props.initialTaskId,'actual-thread');
 control.setTransportState('connecting');
 assert.equal(mounted.at(-1).props.webRemoteControlTerminalTransportState,'connecting');
 control.dispose();
});

test('unknown roots never dispatch and server navigation cannot widen scope',async()=>{
 let requests=0;
 const control=await mountCodexOriginalH5({compat:{__codexOriginalPlatform:()=>({}),__codexOriginalMount(){}},services:{},info:{authenticated:true,workspaces:[{path:'/project/a'}]},resolveNavigation:async()=>{requests++;return{workspacePath:'/outside'};}});
 await assert.rejects(control.switcher.switchWorkspace('/outside'),/配对范围/);
 assert.equal(requests,0);
 await assert.rejects(control.switcher.openProjectDraft({projectId:'real-project'}),/配对工作区范围/);
 assert.equal(requests,1);
 assert.equal(control.getContext().workspacePath,'/project/a');
 control.dispose();
});

test('late navigation response cannot overwrite newer original mount context',async()=>{
 const resolvers=[];const control=await mountCodexOriginalH5({compat:{__codexOriginalPlatform:()=>({}),__codexOriginalMount(){}},services:{},info:{authenticated:true,workspaces:[{path:'/project/a'},{path:'/project/b'}]},resolveNavigation:()=>new Promise(resolve=>resolvers.push(resolve))});
 const first=control.switcher.switchWorkspace('/project/b'),second=control.switcher.switchWorkspace('/project/a');
 resolvers[1]({workspacePath:'/project/a',initialTaskId:'second'});await second;
 resolvers[0]({workspacePath:'/project/b',initialTaskId:'first'});await first;
 assert.equal(control.getContext().initialTaskId,'second');control.dispose();
});

test('provider views come from actual catalogue shape and expose no ZCode cloud identity',async()=>{
 const calls=[],api={async get(path){calls.push(path);if(path==='/api/status')return{desktopOnline:true};return{data:[{model:'native-model',isDefault:true,defaultReasoningEffort:'low',inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{model:'unknown-effort-model',supportedReasoningEfforts:[]}]};}};
 const services=createPlatformServices({api});
 assert.deepEqual(await services.oauth.getProviders(),[]);
 assert.equal(await services.oauth.getActiveProvider(),null);
 assert.equal(await services.credential.load('zcodejwttoken'),null);
 const model=await services['model-selection'].getView(),providers=await services['provider-settings'].getView();
 assert.equal(model.providers[0].providerId,'codex-app');
 assert.deepEqual(model.preferredSelection,{providerId:'codex-app',modelId:'native-model',options:{reasoningLevel:'low'}});
 assert.deepEqual(model.effectiveSelection,model.preferredSelection);
 const selected={providerId:'codex-app',modelId:'native-model',options:{reasoningLevel:'high'}};
 assert.deepEqual((await services['model-selection'].getView({selection:selected})).effectiveSelection,selected);
 assert.equal((await services['model-selection'].getView({selection:{providerId:'codex-app',modelId:'missing'}})).effectiveSelection,null);
 assert.deepEqual((await services['model-selection'].getView({selection:{providerId:'codex-app',modelId:'native-model'}})).effectiveSelection,model.preferredSelection);
 assert.equal(model.providers[0].models[0].defaultReasoningEffort,'low');
 assert.equal(model.providers[0].models[0].modelId,'native-model');
 assert.deepEqual(model.providers[0].models[0].config.optionSpecs.reasoningLevel.values,['low','high']);
 assert.equal(model.providers[0].models.length,1);
 assert.equal(model.providers[0].config.access,null);
 assert.equal(providers.providers[0].effectiveConfig.access,null);
 assert.equal(providers.providers[0].models[0].selectable,true);
 assert(calls.every(path=>['/api/models','/api/status'].includes(path)));
 assert.equal((await services.setting.get()).providerFamilyDomainMigrated,true);
 assert.throws(()=>services.oauth.startOAuthWithPolling(),/未开放/);
});
