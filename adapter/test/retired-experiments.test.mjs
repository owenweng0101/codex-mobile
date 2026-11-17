import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {join,resolve,extname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {CodexWriteClient} from '../write-client.mjs';
import {GoalReader} from '../../backend/goals.mjs';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const source=await read('../server.mjs');

test('retired Goal write transport rejects before credentials or any request',async()=>{
 const client=new CodexWriteClient();let touched=false;
 client.credentials=async()=>{touched=true;};client.fetch=async()=>{touched=true;};
 await assert.rejects(client.post('/api/goal',{}),error=>error.code==='CODEX_WRITE_UNAVAILABLE'&&error.sent===false);
 assert.equal(touched,false);
 const backend=await read('../../backend/server.mjs');
 assert.match(backend,/req\.method === 'GET' && pathname === '\/api\/goal'/);
 assert.doesNotMatch(backend,/req\.method === 'POST' && pathname === '\/api\/goal'|NativeGoalService|goals\.mutate/);
 const calls=[],reader=new GoalReader({core:{call:async(...args)=>{calls.push(args);return{goal:null};}}});
 assert.equal(reader.mutate,undefined);
 await reader.read('00000000-0000-0000-0000-000000000001');
 assert.equal(calls.length,1);assert.equal(calls[0][0],'thread/goal/get');
});

test('RPC connection exposes uploads but not experimental native Goal methods',()=>{
 const uploads={uploadAttachment:()=>{}},sharedServices={'zcode-agent':{nativeRead:()=>{}}};
 const wrap=channels=>({channels,dispose(){},refresh:async()=>{}});
 const context={uploads,sharedServices,api:{},modelSelections:{},resolveAttachment(){},join,stateDir:'/fixture',
  createSupportServices:()=>({}),wrapReadControllers:wrap,
  wrapReadEvents:channels=>({...wrap(channels),changes:()=>({dispose(){}})}),
  createConversationReadServices:options=>({...wrap(options.baseServices),validateRevision(){}}),
  createWriteServices:options=>wrap(options.baseServices),rejectMissingChannels:channels=>channels};
 const fragment=source.slice(source.indexOf('function createConnection(){'),source.indexOf('const types='));
 const connection=runInNewContext(fragment+'\ncreateConnection();',context);
 const agent=connection.services['zcode-agent'];
 assert.equal(agent.uploadAttachment,uploads.uploadAttachment);
 assert.equal(agent.getNativeGoal,undefined);assert.equal(agent.mutateNativeGoal,undefined);
 connection.dispose();
});

test('removed Goal and picker public URLs return 404 through the actual static handler',async()=>{
 let handler;
 const root=resolve(import.meta.dirname,'..'),web=resolve(root,'../vendor/zcode-web');
 const context={URL,Buffer,Set,join,resolve,extname,sep,createHash,root,web,origin:'http://fixture',
  createServer:callback=>{handler=callback;return{};},sameOrigin:()=>true,
  readFile,stat,pairing:{allows:()=>false}};
 runInNewContext(source.slice(source.indexOf('const types='),source.indexOf('const stopRpc=')),context);
 for(const path of ['/remote/v4/3.16.3/mobile-goal-menu.mjs','/remote/v4/3.16.3/native-file-picker.mjs']){
  const res={writeHead(status){this.status=status;this.headersSent=true;},end(body){this.body=body;}};
  await handler({url:path,method:'GET',headers:{}},res);
  assert.equal(res.status,404,path);
 }
});

test('production source and installer have no Goal UI or picker experiment hooks',async()=>{
 for(const path of ['../server.mjs','../frontend-stage/browser-adapter.mjs','../image-recovery.mjs','../../connection/install-local.mjs']){
  assert.doesNotMatch(await read(path),/goal-menu|goal-services|native-file-picker|installGoalMenu|goalMenu\.dispose|__codexNativePickers|createNativeFilePicker/,path);
 }
 assert.doesNotMatch(await read('../mobile-theme.css'),/cm-goal-/);
 const picker=await read('../image-recovery.mjs');
 assert.match(picker,/export function positionFilePickerAtTrigger/);
 assert.match(picker,/export function installFilePickerAnchors/);
});
