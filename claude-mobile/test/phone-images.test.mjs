import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,appendFile,stat,open,rm,symlink,link,chmod,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {PHONE_IMAGE_ID,MAX_PHONE_IMAGE_BYTES,MAX_PHONE_IMAGES,readPhoneImage,storePhoneImage,phoneImageReferences} from '../backend/lib/phone-images.mjs';
import {CommandLedger} from '../backend/lib/command-ledger.mjs';
import {NativeUserDelivery} from '../backend/lib/native-user-delivery.mjs';
import {parseTranscript} from '../backend/lib/sessions.mjs';
import {runtimeStatus} from '../backend/lib/runtime-status.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=','base64');
const source=await readFile(new URL('../backend/server.mjs',import.meta.url),'utf8');
const commandStart=source.indexOf("  if(path.startsWith('/claude/api/command/')");
const commandEnd=source.indexOf('\n  }',commandStart)+4;
assert.ok(commandStart>=0&&commandEnd>commandStart);
const commandRoute=source.slice(commandStart,commandEnd);
const handlers=source.slice(source.indexOf('async function upload(req,res){'),source.indexOf('\nlet initialized=false;'))+'\nasync function command(req,res,path){'+commandRoute+'}\n({upload,serveUpload,chat,hydratePhoneAttachments,command});';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

async function files(t){
  const root=await mkdtemp(join(tmpdir(),'clm-images-')),uploadsDir=join(root,'uploads');
  await mkdir(uploadsDir,{mode:0o700});
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,uploadsDir,upload:()=>storePhoneImage(png,'image/png',{uploadsDir})};
}

// Pure handler integration with temporary native bytes and injected desktop
// dependencies. No server listener, browser, credentials or real session exists.
async function fixture(t,hooks={}){
  const f=await files(t),sessionId=randomUUID(),nativePath=join(f.root,'native.jsonl');
  await writeFile(nativePath,JSON.stringify({type:'system'})+'\n');
  const ledger=new CommandLedger({dir:join(f.root,'commands')}),jobs=new Map(),nativeIds=new Map(),intents=[];
  const bridge={waitForSession:async()=>{},hasPending:id=>jobs.has(id),enqueue:job=>jobs.set(job.requestId,job),
    connection:()=>({ready:true,runtime:null}),requestForMessage:(session,id)=>nativeIds.get(id)?.sessionId===session?nativeIds.get(id).requestId:null};
  const intent={attach:async id=>{intents.push({type:'attach',id});return {sessionId:id,desktopSessionId:'fixture-desktop'};},
    create:async args=>{intents.push({type:'create',...args});return {sessionId:args.sessionId,desktopSessionId:'fixture-desktop'};},
    readState:async()=>({attached:true,status:'idle',nativePid:123})};
  const delivery=new NativeUserDelivery({ledger,intent,bridge,uploadsDir:f.uploadsDir,readTranscript:async()=>({cursor:1}),sessionFile:async()=>({path:nativePath}),ackTimeoutMs:0});
  const token='test-only-upload-credential',caps=runInNewContext(source.match(/const DESKTOP_CAPABILITIES=(.*);/)[1]);
  let ready=true,readinessCalls=0;
  const api=runInNewContext(handlers,{
    Buffer,URL,createHash,PHONE_IMAGE_ID,MAX_PHONE_IMAGES,MAX_UPLOAD_BYTES:MAX_PHONE_IMAGE_BYTES,readPhoneImage,storePhoneImage,runtimeStatus,
    UPLOADS:f.uploadsDir,COOKIE_CLAUDE:'fixture-auth',accessToken:token,DESKTOP_CAPABILITIES:caps,
    readCookie:cookie=>cookie,readBody:async req=>{hooks.onBody?.(req.body);return req.body;},json:(res,status,value)=>{res.status=status;res.value=JSON.parse(JSON.stringify(value));},
    commandLedger:ledger,desktopDelivery:delivery,desktopIntent:intent,nativeBridge:bridge,
    sessionCwd:async()=>f.root,resolveChatCwd:async()=>({cwd:f.root}),DEFAULT_CWD:f.root,
    claudeReadiness:async()=>{readinessCalls++;return hooks.readiness?hooks.readiness(readinessCalls):ready?{cli:'mock-native',launch:{models:[{model:'unchanged-model'}]}}:{error:'fixture unavailable'};},
    defaultModelOf:()=> 'unchanged-model',PERMISSION_MODES:new Set(['default']),config:{permissionMode:'default'},
    desktopModels:{resolve:async()=>({mapped:false})},readTranscript:async()=>null,
  });
  const headers={cookie:token,'content-type':'application/json',host:'phone.test',origin:'https://phone.test','sec-fetch-site':'same-origin'};
  const response=()=>({writeHead(status,headers){this.status=status;this.headers=headers;},end(bytes){this.bytes=bytes;}});
  const call=async(method,body,options={})=>{const res=response();await api[method]({method:options.method??'POST',headers:{...headers,...options.headers},body},res,...(options.path?[options.path]:[]));return res;};
  const accept=async requestId=>{
    const job=jobs.get(requestId),nativeMessageId=randomUUID();assert.ok(job);
    await job.onClaim({dispatchToken:'fixture-dispatch',leaseId:'fixture-lease',instanceId:'fixture-instance',ownerPid:123});
    await ledger.mark(requestId,{nativeMessageId});nativeIds.set(nativeMessageId,{sessionId:job.sessionId,requestId});
    await appendFile(nativePath,JSON.stringify({type:'user',uuid:nativeMessageId,sessionId:job.sessionId,message:{role:'user',content:job.text},origin:{kind:'plugin',name:'mobile-native-bridge',asUser:true}})+'\n');
    jobs.delete(requestId);return delivery.status(requestId);
  };
  return {...f,api,call,ledger,delivery,jobs,intents,sessionId,nativePath,token,caps,accept,setReady:value=>{ready=value;},readinessCalls:()=>readinessCalls};
}

test('uploaded bytes stay private, canonical and unchanged; previews read the same image',async t=>{
  const f=await files(t),image=await f.upload(),read=await readPhoneImage(image.id,{uploadsDir:f.uploadsDir});
  assert.ok(PHONE_IMAGE_ID.test(image.id));assert.equal(image.path,join(await realpath(f.uploadsDir),image.id));
  assert.deepEqual(read.bytes,png);assert.equal(read.mediaType,'image/png');
  assert.equal((await stat(image.path)).mode&0o777,0o600);
  const refs=await phoneImageReferences([image.id],{uploadsDir:f.uploadsDir});
  assert.deepEqual(refs,[{id:image.id,path:image.path,mediaType:'image/png',size:png.length}]);
});

test('image references reject malformed, missing, foreign and directory IDs',async t=>{
  const f=await files(t),other=join(f.root,'other');await mkdir(other,{mode:0o700});
  const foreign=await storePhoneImage(png,'image/png',{uploadsDir:other});
  for(const id of ['../'+foreign.id,foreign.path,'x.png','00000000-0000-0000-0000-000000000000.png',foreign.id]){
    await assert.rejects(readPhoneImage(id,{uploadsDir:f.uploadsDir}),error=>['PHONE_IMAGE_INVALID','PHONE_IMAGE_MISSING'].includes(error.code));
  }
  const directoryId=randomUUID()+'.png';await mkdir(join(f.uploadsDir,directoryId));
  await assert.rejects(readPhoneImage(directoryId,{uploadsDir:f.uploadsDir}),{code:'PHONE_IMAGE_UNSAFE'});
  await assert.rejects(phoneImageReferences(Array(17).fill(foreign.id),{uploadsDir:f.uploadsDir}),{code:'PHONE_IMAGE_TOO_MANY'});
});

test('symlink files, symlink upload roots and hardlink escapes are never references or previews',async t=>{
  const f=await files(t),outside=join(f.root,'outside.png');await writeFile(outside,png,{mode:0o600});
  for(const target of [outside,join(f.root,'missing.png')]){
    const id=randomUUID()+'.png';await symlink(target,join(f.uploadsDir,id));
    await assert.rejects(readPhoneImage(id,{uploadsDir:f.uploadsDir}),{code:'PHONE_IMAGE_UNSAFE'});
  }
  const image=await f.upload(),alias=randomUUID()+'.png';await symlink(image.path,join(f.uploadsDir,alias));
  await assert.rejects(readPhoneImage(alias,{uploadsDir:f.uploadsDir}),{code:'PHONE_IMAGE_UNSAFE'});
  const rootAlias=join(f.root,'alias');await symlink(f.uploadsDir,rootAlias);
  await assert.rejects(readPhoneImage(image.id,{uploadsDir:rootAlias}),{code:'PHONE_IMAGE_UNSAFE'});
  const hard=randomUUID()+'.png';await link(outside,join(f.uploadsDir,hard));
  await assert.rejects(readPhoneImage(hard,{uploadsDir:f.uploadsDir}),{code:'PHONE_IMAGE_UNSAFE'});
});

test('oversize, empty, unreadable and disguised image files fail before delivery',async t=>{
  const f=await files(t),largeId=randomUUID()+'.png',large=await open(join(f.uploadsDir,largeId),'wx',0o600);
  await large.truncate(MAX_PHONE_IMAGE_BYTES+1);await large.close();
  await assert.rejects(readPhoneImage(largeId,{uploadsDir:f.uploadsDir}),{code:'PHONE_IMAGE_TOO_LARGE'});
  for(const bytes of [Buffer.alloc(0),Buffer.from('not an image')]){
    const id=randomUUID()+'.png';await writeFile(join(f.uploadsDir,id),bytes,{mode:0o600});
    await assert.rejects(readPhoneImage(id,{uploadsDir:f.uploadsDir}),{code:'PHONE_IMAGE_INVALID'});
  }
  await assert.rejects(storePhoneImage(png,'image/jpeg',{uploadsDir:f.uploadsDir}),{code:'PHONE_IMAGE_INVALID'});
  const unavailable=await f.upload();await chmod(unavailable.path,0o000);
  if(process.getuid?.()!==0)await assert.rejects(readPhoneImage(unavailable.id,{uploadsDir:f.uploadsDir}),{code:'PHONE_IMAGE_UNAVAILABLE'});
});

test('authenticated upload and preview endpoints serve only validated original bytes',async t=>{
  const f=await fixture(t),body={name:'手机截图.png',data:'data:image/png;base64,'+png.toString('base64')};
  const upload=await f.call('upload',body);assert.equal(upload.status,200);assert.equal(upload.value.name,body.name);
  const preview=await f.call('serveUpload',null,{path:upload.value.url});
  assert.equal(preview.status,200);assert.equal(preview.headers['content-type'],'image/png');assert.deepEqual(preview.bytes,png);
  assert.ok(!JSON.stringify(upload.value).includes(f.token));
  assert.equal((await f.call('upload',body,{headers:{cookie:'wrong'}})).status,401);
  assert.equal((await f.call('upload',body,{headers:{origin:'https://foreign.test'}})).status,403);
  assert.equal((await f.call('upload',{...body,data:'data:image/png;base64,'+Buffer.from('fake').toString('base64')})).status,400);
  const outside=join(f.root,'outside.png');await writeFile(outside,png);await rm(upload.value.path);await symlink(outside,upload.value.path);
  assert.equal((await f.call('serveUpload',null,{path:upload.value.url})).status,404);
  assert.equal((await f.call('serveUpload',null,{path:upload.value.url,headers:{cookie:'wrong'}})).status,401);
});

test('HTTP image-only new chat, caption and multiple images hydrate exactly after refresh',async t=>{
  const f=await fixture(t),a=await f.upload(),b=await f.upload();
  assert.equal(f.caps.attachments,true);assert.equal(f.caps.attachmentDelivery,'file-reference');
  const inputs=[
    {requestId:f.sessionId,sessionId:null,text:'',attachments:[a.id]},
    {requestId:randomUUID(),sessionId:f.sessionId,text:'  原文\n@"/uploads/不是隐藏内容"\n保留结尾空格  ',attachments:[a.id]},
    {requestId:randomUUID(),sessionId:f.sessionId,text:'比较这两张图片',attachments:[a.id,b.id]},
  ];
  for(const input of inputs){
    const response=await f.call('chat',input);assert.equal(response.status,202);assert.equal(response.value.attachmentDelivery,'file-reference');
    assert.equal((await f.accept(input.requestId)).delivery,'accepted');
  }
  assert.deepEqual(f.intents.map(item=>item.type),['create','attach','attach']);assert.equal(f.intents[0].title,'图片');
  const original=await readFile(f.nativePath,'utf8'),raw=parseTranscript(original,f.sessionId);
  assert.equal(raw.messages.length,inputs.length,'only-image native input remains visible to hydration');
  const hydrated=f.delivery.annotateTranscript(raw);await f.api.hydratePhoneAttachments(hydrated);
  for(let i=0;i<inputs.length;i++){
    const message=hydrated.messages[i];assert.equal(message.text,inputs[i].text);assert.equal(message.rawText,inputs[i].text);
    assert.deepEqual(Array.from(message.attachments,item=>item.id),inputs[i].attachments);
    assert.equal(message.requestId,inputs[i].requestId);assert.equal(message.attachmentDelivery,'file-reference');
    assert.ok(message.attachments.every(item=>item.url==='/claude/api/upload/'+item.id));
  }
  assert.equal(await readFile(f.nativePath,'utf8'),original,'hydration never rewrites native history');
  assert.deepEqual(raw.messages.map(message=>message.attachments),[[],[],[]],'hydration owns display clones');
  const wrong={id:randomUUID(),messages:[{...hydrated.messages[0],attachments:[],text:'wrong session'}]};
  await f.api.hydratePhoneAttachments(wrong);assert.deepEqual(wrong.messages[0].attachments,[]);
});

test('existing HTTP image operation stays accepted after uploads disappear and environment fails',async t=>{
  const f=await fixture(t),image=await f.upload(),input={requestId:randomUUID(),sessionId:f.sessionId,text:'',attachments:[image.id]};
  await f.call('chat',input);await f.accept(input.requestId);await rm(f.uploadsDir,{recursive:true});f.setReady(false);
  const again=await f.call('chat',input);assert.equal(again.status,200);assert.equal(again.value.delivery,'accepted');
  assert.equal(again.value.attachmentDelivery,'file-reference');assert.equal(again.value.notDispatched,false);assert.equal(f.intents.length,1);
  const changed=await f.call('chat',{...input,attachments:['missing']});assert.equal(changed.status,409);assert.equal(changed.value.notDispatched,false);
  const view=f.delivery.annotateTranscript(parseTranscript(await readFile(f.nativePath,'utf8'),f.sessionId));
  await f.api.hydratePhoneAttachments(view);assert.equal(view.messages[0].text,'');assert.equal(view.messages[0].attachments[0].id,image.id);
});

test('new HTTP requests with bad image files never create or attach a desktop session',async t=>{
  const f=await fixture(t),missing=randomUUID()+'.png',directory=randomUUID()+'.png';await mkdir(join(f.uploadsDir,directory));
  for(const id of [missing,directory]){
    const response=await f.call('chat',{requestId:randomUUID(),text:'',attachments:[id]});
    assert.equal(response.status,409);assert.equal(response.value.delivery,'rejected');assert.equal(response.value.notDispatched,true);
    assert.ok(!JSON.stringify(response.value).includes(f.token));assert.equal(f.jobs.size,0);
  }
  assert.equal(f.intents.length,0);
});

for(const changed of [false,true])test(changed?
  'concurrent HTTP image payloads sharing an ID cannot overwrite the first operation':
  'concurrent duplicate HTTP images return the first acceptance despite later readiness failure',
  {timeout:5000},async t=>{
    const entered=deferred(),bothParsed=deferred(),release=deferred(),accepted=deferred();
    t.after(()=>{release.resolve();accepted.resolve();});
    let parsed=0,submits=0;
    const f=await fixture(t,{
      onBody:()=>{if(++parsed===2)bothParsed.resolve();},
      readiness:async count=>{
        if(count===1){entered.resolve();await release.promise;}
        else{await accepted.promise;if(!changed)return {error:'readiness failed after the first send'};}
        return {cli:'mock-native',launch:{models:[{model:'unchanged-model'}]}};
      },
    });
    const image=await f.upload(),input={requestId:randomUUID(),sessionId:f.sessionId,text:'第一条图片原文',attachments:[image.id]};
    const submit=f.delivery.submit.bind(f.delivery);
    f.delivery.submit=async args=>{submits++;await submit(args);const receipt=await f.accept(args.requestId);accepted.resolve();return receipt;};
    const first=f.call('chat',input);await entered.promise;
    const second=f.call('chat',{...input,requestId:input.requestId.toUpperCase(),...(changed?{text:'另一条不允许覆盖的原文'}:{})});
    await bothParsed.promise;
    // Let the second handler pass body parsing while the first preflight is
    // blocked. Without the HTTP guard its ledger lookup is queued before prepare.
    await new Promise(resolve=>setImmediate(resolve));release.resolve();
    const [a,b]=await Promise.all([first,second]);
    assert.equal(a.status,200);assert.equal(a.value.delivery,'accepted');
    if(changed){assert.equal(b.status,409);assert.equal(b.value.code,'COMMAND_ID_COLLISION');}
    else{assert.equal(b.status,200);assert.equal(b.value.delivery,'accepted');assert.equal(b.value.nativeMessageId,a.value.nativeMessageId);}
    assert.equal(b.value.notDispatched,false);assert.equal(f.readinessCalls(),1);assert.equal(submits,1);
    const record=await f.ledger.get(input.requestId);
    assert.equal(record.state,'accepted');assert.equal(record.attachmentText,input.text);assert.equal(record.nativeMessageId,a.value.nativeMessageId);
    assert.equal(f.intents.length,1);
  });

test('a blocked image POST does not block a different ID or the real GET status handler',{timeout:5000},async t=>{
  const entered=deferred(),release=deferred();t.after(()=>release.resolve());
  const f=await fixture(t,{readiness:async count=>{
    if(count===1){entered.resolve();await release.promise;}
    return {cli:'mock-native',launch:{models:[{model:'unchanged-model'}]}};
  }});
  const image=await f.upload(),input={requestId:randomUUID(),sessionId:f.sessionId,text:'图片',attachments:[image.id]};
  const submit=f.delivery.submit.bind(f.delivery);
  f.delivery.submit=async args=>{await submit(args);return f.accept(args.requestId);};
  const first=f.call('chat',input);await entered.promise;
  const pendingStatus=await f.call('command',null,{method:'GET',path:'/claude/api/command/'+input.requestId});
  assert.equal(pendingStatus.status,404,'status lookup is not queued behind the POST preflight');
  const other={...input,requestId:randomUUID()},second=await f.call('chat',other);
  assert.equal(second.status,200);assert.equal(second.value.delivery,'accepted');
  const status=await f.call('command',null,{method:'GET',path:'/claude/api/command/'+other.requestId});
  assert.equal(status.status,200);assert.equal(status.value.nativeMessageId,second.value.nativeMessageId);
  release.resolve();assert.equal((await first).status,200);assert.equal(f.readinessCalls(),2);
});
