import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {runtimeStatus} from '../backend/lib/runtime-status.mjs';
import {PHONE_IMAGE_ID,MAX_PHONE_IMAGES} from '../backend/lib/phone-images.mjs';
const source=await readFile(new URL('../backend/server.mjs',import.meta.url),'utf8');
const start=source.indexOf('function resolveAttachments(body){'),end=source.indexOf('\nlet initialized=false;',start);
assert.ok(start>=0&&end>start);
const handler=source.slice(start,end)+'\nchat;';
const id='11111111-1111-4111-8111-111111111111';
async function invoke(body={},options={}){
  const calls=[],staged=[],res={writeHead(status){this.status=status},end(text){this.value=JSON.parse(text)}};
  let readinessCalls=0;
  const receipt=state=>({requestId:id,sessionId:id,desktopSessionId:'desktop-real-id',state,delivery:['accepted','rejected','unknown'].includes(state)?state:'waiting',queueMode:'next',attachmentDelivery:null});
  const chat=runInNewContext(handler,{
    URL,createHash,runtimeStatus,PHONE_IMAGE_ID,MAX_PHONE_IMAGES,DESKTOP_CAPABILITIES:{attachments:true,attachmentDelivery:'file-reference',queue:true,steer:false},
    COOKIE_CLAUDE:'cookie',accessToken:'test',readCookie:()=>options.unauth?'wrong':'test',
    readBody:async()=>({requestId:id,text:'手机消息',cwd:'/folder/A',...body}),json:(r,s,v)=>{r.writeHead(s);r.end(JSON.stringify(v))},
    sessionCwd:async()=>options.recordedCwd||null,
    resolveChatCwd:async args=>options.cwdError?{error:'工作目录不可用'}:{cwd:args.sessionCwd||args.requestedCwd||'/default'},DEFAULT_CWD:'/default',
    claudeReadiness:async()=>{readinessCalls++;return options.notReady?{error:'native unavailable'}:{cli:'native-bootstrap',launch:{models:[{model:'selected'}]}};},
    defaultModelOf:()=> 'selected',PERMISSION_MODES:new Set(['acceptEdits','bypassPermissions']),config:{permissionMode:'acceptEdits'},
    stagePeerAttachments:async()=>{staged.push(true);throw Error('legacy staging must not run');},
    unlink:async()=>{},realpath:async path=>path,UPLOADS:'/uploads',PEER_SPOOL:'/spool',STATE_DIR:'/state',join:(...p)=>p.join('/'),sep:'/',stat:async()=>({isFile:()=>true}),
    desktopDelivery:{
      submit:async payload=>{
        calls.push(payload);if(options.throw)throw options.throw;
        return {...receipt(options.state||'accepted'),attachmentDelivery:payload.attachments.length?'file-reference':null};
      },
      status:async()=>receipt(options.existing?.state||'accepted'),
    },
    nativeBridge:{connection:()=>({ready:true,runtime:null})},
    desktopModels:{resolve:async()=>({mapped:false})},readTranscript:async()=>null,
    commandLedger:{get:async()=>options.existing??null},
    desktopIntent:{readState:async()=>({attached:true,running:true,status:'busy',nativePid:202,canInterrupt:false})},
  });
  await chat({headers:options.headers??{}},res);
  return {res,calls,staged,readinessCalls};
}

test('native HTTP chat returns the transport receipt without inventing another session',async()=>{const {res,calls}=await invoke();assert.equal(res.status,200);assert.equal(calls.length,1);assert.equal(calls[0].requestId,id);assert.equal(calls[0].cwd,'/folder/A');assert.equal(res.value.desktopSessionId,'desktop-real-id');assert.equal(res.value.control.attached,true);});
test('unknown delivery returns 202, never a fabricated failure or CLI fallback',async()=>{const {res,calls}=await invoke({}, {state:'unknown'});assert.equal(res.status,202);assert.equal(res.value.state,'unknown');assert.equal(calls.length,1);});
test('explicit rejection remains distinguishable from uncertain delivery',async()=>{const {res}=await invoke({}, {state:'rejected'});assert.equal(res.status,409);assert.equal(res.value.state,'rejected');});
test('stable request ID is required before any native submission',async()=>{for(const requestId of [null,'',123,'invalid']){const {res,calls}=await invoke({requestId});assert.equal(res.status,400);assert.equal(calls.length,0);}});
test('authentication, empty, invalid session and oversized messages never submit',async()=>{for(const [body,opts,status] of [[{}, {unauth:true},401],[{text:' '},{},400],[{sessionId:'not-a-session'},{},400],[{text:'x'.repeat(20001)},{},413]]){const {res,calls}=await invoke(body,opts);assert.equal(res.status,status);assert.equal(calls.length,0);}});
test('unavailable cwd fails before native submission',async()=>{const {res,calls}=await invoke({}, {cwdError:true});assert.equal(res.status,400);assert.equal(calls.length,0);});
test('recorded cwd wins for resumed desktop sessions',async()=>{const {calls}=await invoke({sessionId:id,cwd:'/wrong/B'}, {recordedCwd:'/real/A'});assert.equal(calls[0].cwd,'/real/A');assert.equal(calls[0].sessionId,id);});
test('declared priority remains part of request identity but native scheduling is next',async()=>{for(const priority of ['now','next']){const {res,calls}=await invoke({sessionId:id,priority});assert.equal(calls[0].priority,priority);assert.equal(res.value.queueMode,'next');}});
test('image-only, captioned and multiple images keep the same native operation contract',async()=>{
  const a=id+'.png',b=id+'.jpg';
  for(const [text,attachments] of [['',[a]],['  原文\n保留  ',[a]],['比较这两张图',[a,{id:b,path:'/ignored/client/path'}]]]){
    const {res,calls,staged}=await invoke({text,attachments});
    assert.equal(res.status,200);assert.equal(res.value.attachmentDelivery,'file-reference');
    assert.equal(calls[0].text,text);assert.equal(calls[0].prompt,text);
    assert.deepEqual(Array.from(calls[0].attachments),attachments.map(item=>typeof item==='string'?item:item.id));
    assert.deepEqual(Array.from(calls[0].fileAttachments),[]);assert.deepEqual(staged,[],'never use native/peer attachment staging');
    assert.equal(res.value.control.capabilities.attachmentDelivery,'file-reference');
  }
});
test('invalid attachment containers, traversal IDs and excessive counts are rejected',async()=>{
  for(const attachments of ['image.png',{},['../'+id+'.png'],[{path:'/private/image.png'}],Array(17).fill(id+'.png')]){
    const {res,calls}=await invoke({attachments});assert.equal(res.status,400);assert.equal(calls.length,0);
  }
});
test('image retries look up the old request before readiness or mutable upload files',async()=>{
  const body={text:'',attachments:[id+'.png']},first=await invoke(body),existing={state:'accepted',sessionId:id,clientRequestHash:first.calls[0].clientRequestHash};
  const again=await invoke(body,{existing,notReady:true,cwdError:true});
  assert.equal(again.res.status,200);assert.equal(again.calls.length,0);assert.equal(again.readinessCalls,0);
  for(const changed of [{attachments:['missing']},{text:'' ,attachments:[]},{sessionId:'invalid'}]){
    const result=await invoke({...body,...changed},{existing});
    assert.equal(result.res.status,409);assert.equal(result.res.value.code,'COMMAND_ID_COLLISION');
    assert.equal(result.res.value.notDispatched,false);assert.equal(result.calls.length,0);
  }
});
test('invalid attachment IDs cannot silently disappear',async()=>{const {res,calls}=await invoke({attachments:['missing']});assert.equal(res.status,400);assert.equal(calls.length,0);});
test('a reused ID with conflicting payload retains the durable conflict response',async()=>{const {res,calls}=await invoke({}, {throw:Object.assign(new Error('同一消息编号内容不同'),{statusCode:409,code:'COMMAND_ID_COLLISION'})});assert.equal(res.status,409);assert.equal(res.value.code,'COMMAND_ID_COLLISION');assert.equal(calls.length,1);});
test('a new request readiness failure is provably unsent',async()=>{const {res,calls}=await invoke({}, {notReady:true});assert.equal(res.status,503);assert.equal(res.value.notDispatched,true);assert.equal(res.value.delivery,'rejected');assert.equal(calls.length,0);});
test('matching existing native requests are status lookups before environment/files',async()=>{
  const first=await invoke(),existing={state:'accepted',sessionId:id,clientRequestHash:first.calls[0].clientRequestHash};
  const again=await invoke({}, {existing,notReady:true});
  assert.equal(again.res.status,200);assert.equal(again.res.value.delivery,'accepted');assert.equal(again.calls.length,0);assert.equal(again.readinessCalls,0);
  const changed=await invoke({text:'另一条消息'}, {existing});assert.equal(changed.res.status,409);assert.equal(changed.res.value.code,'COMMAND_ID_COLLISION');assert.equal(changed.calls.length,0);
});
test('legacy in-flight requests never become not-sent merely because readiness failed',async()=>{
  const value=await invoke({}, {existing:{state:'dispatched',sessionId:id},notReady:true});
  assert.equal(value.res.value.delivery,'unknown');assert.equal(value.res.value.notDispatched,false);assert.equal(value.readinessCalls,0);assert.equal(value.calls.length,0);
});
test('cross-origin authenticated sends are rejected before parsing/submitting',async()=>{
  const value=await invoke({}, {headers:{host:'phone.example:8443',origin:'https://phone.example:9443','sec-fetch-site':'same-site'}});
  assert.equal(value.res.status,403);assert.equal(value.calls.length,0);
});
