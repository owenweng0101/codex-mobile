import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {resolve} from 'node:path';
import {createHistoryOverlayReader} from '../desktop-bridge.mjs';
import {desktopConnectionState,cleanUserText} from '../view.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
// Exercise the production functions without importing the server entrypoint
// (which would start services or access native private state).
const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
const metadataSource=source.slice(source.indexOf('function historyMetadata('),source.indexOf('const conversationIndex='));
const windowSource=source.slice(source.indexOf('async function historyWindow('),source.indexOf('async function history(id, cursor)'));
for(const delayed of ['index','thread'])test('late native success during '+delayed+' IO cannot elevate old fallback trust or override the local completed tail',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const id='fixture-thread',stale=new Set(),cache=new Map([[id,{thread:{name:'fixture',status:{type:'active'}},turns:[{id:'old-turn',status:'inProgress'}],activeTurn:'old-turn',settings:{model:'native-old',effort:'high'}}]]);
 const nativeGate=deferred(),indexGate=deferred(),indexEntered=deferred(),threadGate=deferred();let indexParams;
 const reader=createHistoryOverlayReader({read:()=>nativeGate.promise,cached:id=>cache.get(id)||null,failed:id=>stale.add(id),accept:(id,value)=>{cache.set(id,value);stale.delete(id);}});t.after(()=>reader.dispose());
 const context={resolve,homedir:()=>'/fixture',process:{env:{CODEX_HOME:'/fixture/codex'}},draftThreads:new Map(),owned:new Set(),touchDesktop(){},pruneDesktopIdle(){},historyOverlay:reader,threadRead:async()=>{if(delayed==='thread')await threadGate.promise;return{id,path:'/fixture/codex/sessions/fixture.jsonl',cwd:'/fixture/workspace',model:'thread-model',status:{type:'idle'}};}, desktop:{online:true},desktopStale:stale,desktopConnectionState,cleanUserText,threadSettings:{},messageQueue:{get:()=>({items:[]})},core:{tokenUsage:new Map(),turnPlans:new Map(),turnDiffs:new Map(),requests:new Map(),activeTurns:new Map()},conversationIndex:{read:async(file,params)=>{indexParams=params;indexEntered.resolve();await indexGate.promise;return{rows:{window:[],totalCount:1,firstRowId:1},sourceEpoch:'fixture',revision:String(params.activeTurn??'idle'),lastTurn:{id:'persisted-turn',status:'completed'},settings:{model:'rollout-model',effort:'low'}};}}};
 const historyWindow=vm.runInNewContext(metadataSource+windowSource+';historyWindow',context);
 const result=historyWindow(id,{limit:20});await flush();t.mock.timers.tick(80);await flush();if(delayed==='index')await indexEntered.promise;
 nativeGate.resolve({thread:{status:{type:'idle'}},turns:[{id:'fresh-turn',status:'completed'}],activeTurn:null,settings:{model:'native-new'}});await flush();assert.equal(stale.has(id),false);assert.equal(cache.get(id).activeTurn,null);
 threadGate.resolve();await indexEntered.promise;
 assert.equal(indexParams.activeTurn,null);assert.equal(indexParams.nativeTurns.length,0,'untrusted old running turns must not overlay persisted history');
 indexGate.resolve();const reply=await result;
 assert.equal(reply.desktopConnected,false);assert.equal(reply.activeTurn,null);assert.equal(reply.revision,'idle');assert.equal(reply.thread.status.type,'unavailable');assert.equal(reply.turns[0].status,'completed');
 assert.equal(reply.settings.model,'native-old','one frozen read keeps its original native settings precedence');assert.equal(reply.settings.effort,'high');
});
