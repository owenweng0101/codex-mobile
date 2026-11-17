import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,appendFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {CommandLedger} from '../backend/lib/command-ledger.mjs';
import {NativeUserBridge,NATIVE_USER_TRANSPORT} from '../backend/lib/native-user-bridge.mjs';
import {NativeUserDelivery,findNativeUserProof} from '../backend/lib/native-user-delivery.mjs';
import {storePhoneImage} from '../backend/lib/phone-images.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=','base64');

const digest=text=>createHash('sha256').update(text).digest('hex');
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'clmn-'));
  const stateDir=join(root,'state');await mkdir(stateDir,{mode:0o700});
  const uploadsDir=join(stateDir,'uploads');await mkdir(uploadsDir,{mode:0o700});
  const sessionId=randomUUID(),desktopSessionId='local_'+randomUUID(),instanceId=randomUUID();
  const path=join(root,sessionId+'.jsonl');await writeFile(path,JSON.stringify({type:'system'})+'\n');
  const ledger=new CommandLedger({dir:join(stateDir,'commands')});
  let owner={entrypoint:'claude-desktop-3p',hostSessionId:desktopSessionId,pid:701,status:'idle'};
  const ownerFor=async()=>owner;
  let bridge=new NativeUserBridge({stateDir,ledger,ownerFor});await bridge.start();
  let calls=0;
  const intent={attach:async id=>{calls++;return {sessionId:id,desktopSessionId};},create:async({sessionId:id})=>{calls++;return {sessionId:id,desktopSessionId};}};
  const readTranscript=async id=>({id,messages:[],cursor:1});
  const sessionFile=async()=>({path});
  const deliveryFor=value=>new NativeUserDelivery({ledger,intent,bridge:value,readTranscript,sessionFile,uploadsDir,ackTimeoutMs:0});
  let delivery=deliveryFor(bridge);
  const token=JSON.parse(await readFile(bridge.configPath,'utf8')).token;
  const request=(route,body={},options={})=>new Promise((resolve,reject)=>{
    const req=http.request({socketPath:bridge.socketPath,path:route,method:options.method??'POST',headers:{host:'claude-mobile-native','content-type':'application/json',authorization:'Bearer '+token,...options.headers}},res=>{
      let data='';res.setEncoding('utf8');res.on('data',chunk=>{data+=chunk;});res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(data)});}catch(error){reject(error);}});
    });req.on('error',reject);const wire=['/v1/poll','/v1/claim'].includes(route)?{instanceId,hostSessionId:desktopSessionId,entrypoint:'claude-desktop-3p',...body}:body;req.end(JSON.stringify(wire));
  });
  const poll=ready=>request('/v1/poll',{sessionId,ready});
  const args=(requestId=randomUUID(),text='你好')=>({requestId,sessionId,cwd:root,text,model:'fixture-model',permissionMode:'default',attachments:[],priority:'now',prompt:text,fileAttachments:[]});
  const submit=async input=>{await poll(true);return delivery.submit(input);};
  const claim=async requestId=>{
    const p=await poll(true);assert.equal(p.status,200);
    const c=await request('/v1/claim',{sessionId,requestId,leaseId:p.body.leaseId});
    assert.equal(c.status,200);return {...c.body,leaseId:p.body.leaseId};
  };
  const nativeRow=(nativeMessageId,text='你好',extra={})=>({type:'user',uuid:nativeMessageId,sessionId,message:{role:'user',content:text},origin:{kind:'plugin',name:'mobile-native-bridge',asUser:true},...extra});
  const receipt=(requestId,dispatchToken,nativeMessageId,status='accepted')=>request('/v1/receipt',{sessionId,requestId,dispatchToken,nativeMessageId,status});
  const restart=async()=>{
    await bridge.stop();bridge=new NativeUserBridge({stateDir,ledger,ownerFor});await bridge.start();
    delivery=deliveryFor(bridge);await delivery.recoverStartup();
  };
  t.after(async()=>{await bridge.stop();await rm(root,{recursive:true,force:true});});
  return {root,stateDir,sessionId,desktopSessionId,path,ledger,request,poll,args,submit,claim,nativeRow,receipt,restart,token,uploadsDir,
    upload:()=>storePhoneImage(png,'image/png',{uploadsDir}),
    delivery:()=>delivery,bridge:()=>bridge,calls:()=>calls,setOwner:value=>{owner=value;}};
}

test('private native bridge requires its own credential, local host and native owner',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/v1/poll',{sessionId:f.sessionId,ready:true},{headers:{authorization:'Bearer invalid'}})).status,401);
  assert.equal((await f.request('/v1/poll',{sessionId:f.sessionId,ready:true},{headers:{origin:'https://example.test'}})).status,403);
  assert.equal((await f.request('/v1/poll',{sessionId:f.sessionId,ready:true},{headers:{host:'other-host'}})).status,403);
  assert.equal((await f.request('/v1/poll',{}, {method:'GET'})).status,405);
  assert.equal((await stat(f.bridge().socketPath)).mode&0o777,0o600);
  assert.equal((await stat(f.bridge().configPath)).mode&0o777,0o600);
  f.setOwner({entrypoint:'cli',hostSessionId:f.desktopSessionId,pid:702});
  assert.equal((await f.poll(true)).status,409);
});

test('original text is offered, claim is durable and duplicate claim never redispatches',async t=>{
  const f=await fixture(t),input=f.args();
  const first=await f.submit(input);assert.equal(first.delivery,'waiting');
  const offer=await f.poll(true);assert.equal(offer.body.job.text,input.text);
  assert.equal((await f.ledger.get(input.requestId)).state,'prepared');
  assert.equal((await f.poll(false)).body.job,null);
  const claimed=await f.claim(input.requestId);
  assert.equal((await f.ledger.get(input.requestId)).state,'dispatched');
  const twice=await f.request('/v1/claim',{sessionId:f.sessionId,requestId:input.requestId,leaseId:claimed.leaseId});
  assert.equal(twice.body.dispatchToken,claimed.dispatchToken);
  await f.submit(input);assert.equal(f.calls(),1);
  await assert.rejects(f.delivery().submit({...input,text:'不同内容',prompt:'不同内容'}),{code:'COMMAND_ID_COLLISION'});
});

test('native receipt is not accepted until matching bare user JSONL exists',async t=>{
  const f=await fixture(t),input=f.args(),nativeId=randomUUID();await f.submit(input);
  const {dispatchToken}=await f.claim(input.requestId);
  assert.equal((await f.receipt(input.requestId,dispatchToken,nativeId)).body.recorded,true);
  assert.equal((await f.delivery().status(input.requestId)).delivery,'waiting');
  await appendFile(f.path,JSON.stringify(f.nativeRow(nativeId))+'\n');
  const result=await f.delivery().status(input.requestId);
  assert.equal(result.delivery,'accepted');assert.equal(result.requestId,input.requestId);
  assert.equal(result.messageId,nativeId);assert.equal(result.nativeMessageId,nativeId);
  assert.equal((await f.ledger.get(input.requestId)).messageId,input.requestId,'legacy operation identity remains immutable');
  assert.equal(result.inputProvenance,'plugin-as-user');assert.equal(result.queueMode,'next');
});

test('peer or hidden user row cannot masquerade as a real user acknowledgement',async t=>{
  const f=await fixture(t),nativeId=randomUUID();
  const cases=[{isMeta:true},{isSidechain:true},{origin:{kind:'peer'}},{origin:{kind:'plugin',name:'other-plugin',asUser:true}},{origin:{kind:'plugin',name:'mobile-native-bridge'}},{sessionId:randomUUID()},{message:{role:'user',content:'Another Claude session sent a message: 你好'}}];
  for(const extra of cases){
    await writeFile(f.path,JSON.stringify(f.nativeRow(nativeId,'你好',extra))+'\n');
    const proof=await findNativeUserProof({path:f.path,sessionId:f.sessionId,nativeMessageId:nativeId,textHash:digest('你好')});
    assert.equal(proof.verified,false);
  }
  await writeFile(f.path,JSON.stringify(f.nativeRow(nativeId)));
  assert.equal((await findNativeUserProof({path:f.path,sessionId:f.sessionId,nativeMessageId:nativeId,textHash:digest('你好')})).verified,false,'partial final line is not durable evidence');
});

test('two equal texts remain separate operations with separate engine UUIDs',async t=>{
  const f=await fixture(t),a=f.args(),b=f.args(),na=randomUUID(),nb=randomUUID();
  await f.submit(a);await f.submit(b);
  const ca=await f.claim(a.requestId),cb=await f.claim(b.requestId);
  await appendFile(f.path,JSON.stringify(f.nativeRow(na))+'\n'+JSON.stringify(f.nativeRow(nb))+'\n');
  await f.receipt(a.requestId,ca.dispatchToken,na);await f.receipt(b.requestId,cb.dispatchToken,nb);
  assert.equal((await f.delivery().status(a.requestId)).delivery,'accepted');
  assert.equal((await f.delivery().status(b.requestId)).delivery,'accepted');
  assert.equal(f.bridge().requestForMessage(f.sessionId,na),a.requestId);
  assert.equal(f.bridge().requestForMessage(f.sessionId,nb),b.requestId);
  assert.equal(f.bridge().requestForMessage(randomUUID(),nb),null);
});

test('restarted gateway rejects unclaimed requests without replaying native actions',async t=>{
  const f=await fixture(t),input=f.args();await f.submit(input);await f.restart();
  const result=await f.delivery().status(input.requestId);
  assert.equal(result.delivery,'rejected');assert.equal(result.notDispatched,true);
  assert.equal((await f.poll(true)).body.job,null);
  assert.equal(f.calls(),1);
});

test('receipt retry after restart recovers a dispatched native message without a second send',async t=>{
  const f=await fixture(t),input=f.args(),nativeId=randomUUID();await f.submit(input);
  const {dispatchToken}=await f.claim(input.requestId);await f.restart();
  assert.equal((await f.delivery().status(input.requestId)).delivery,'unknown');
  await appendFile(f.path,JSON.stringify(f.nativeRow(nativeId))+'\n');
  assert.equal((await f.receipt(input.requestId,dispatchToken,nativeId)).status,200);
  assert.equal((await f.delivery().status(input.requestId)).delivery,'accepted');
  assert.equal((await f.poll(true)).body.job,null);
  await f.receipt(input.requestId,dispatchToken,nativeId);
  assert.equal(f.calls(),1);
});

test('late unknown/drop cannot undo native acceptance; UUID binding is one-to-one',async t=>{
  const f=await fixture(t),a=f.args(),b=f.args(),nativeId=randomUUID();await f.submit(a);await f.submit(b);
  const ca=await f.claim(a.requestId),cb=await f.claim(b.requestId);
  await appendFile(f.path,JSON.stringify(f.nativeRow(nativeId))+'\n');await f.receipt(a.requestId,ca.dispatchToken,nativeId);
  await f.delivery().status(a.requestId);
  await f.receipt(a.requestId,ca.dispatchToken,undefined,'unknown');await f.receipt(a.requestId,ca.dispatchToken,undefined,'rejected');
  assert.equal((await f.delivery().status(a.requestId)).delivery,'accepted');
  assert.equal((await f.receipt(a.requestId,ca.dispatchToken,randomUUID())).status,409);
  assert.equal((await f.receipt(b.requestId,cb.dispatchToken,nativeId)).status,409);
});

test('explicit engine drop rejects; dispatch exceptions remain uncertain',async t=>{
  const f=await fixture(t),a=f.args(),b=f.args();await f.submit(a);await f.submit(b);
  const ca=await f.claim(a.requestId),cb=await f.claim(b.requestId);
  await f.receipt(a.requestId,ca.dispatchToken,undefined,'rejected');await f.receipt(b.requestId,cb.dispatchToken,undefined,'unknown');
  assert.equal((await f.delivery().status(a.requestId)).delivery,'rejected');
  assert.equal((await f.delivery().status(a.requestId)).notDispatched,false);
  assert.equal((await f.delivery().status(b.requestId)).delivery,'unknown');
  await f.submit(b);assert.equal((await f.poll(true)).body.job,null,'uncertain operation is not offered again');
});

test('invalid images, structured native attachments and slash commands never reach native input',async t=>{
  const f=await fixture(t);
  const invalid=await f.submit({...f.args(),attachments:['image.png']});
  assert.equal(invalid.errorCode,'PHONE_IMAGE_INVALID');assert.equal(invalid.notDispatched,true);
  const missing=await f.submit({...f.args(),attachments:[randomUUID()+'.png']});
  assert.equal(missing.errorCode,'PHONE_IMAGE_MISSING');assert.equal(missing.notDispatched,true);
  const structured=await f.submit({...f.args(),fileAttachments:[{path:'/not-an-upload'}]});
  assert.equal(structured.errorCode,'NATIVE_ATTACHMENTS_UNSUPPORTED');assert.equal(structured.notDispatched,true);
  const slash=await f.submit(f.args(randomUUID(),'/clear'));
  assert.equal(slash.errorCode,'NATIVE_SLASH_UNSUPPORTED');assert.equal(f.calls(),0);
});

test('image-only, captioned and multi-image inputs prove the actual text reference, not native image delivery',async t=>{
  const f=await fixture(t),a=await f.upload(),b=await f.upload();
  for(const [text,attachments] of [['',[a.id]],['  原文\n不要改变  ',[a.id]],['比较两张图片',[a.id,b.id]]]){
    const input={...f.args(randomUUID(),text),attachments},nativeId=randomUUID();
    const pending=await f.submit(input),offered=(await f.poll(true)).body.job;
    assert.equal(pending.attachmentDelivery,'file-reference');assert.equal(pending.sessionId,f.sessionId);
    assert.equal(offered.requestId,input.requestId);assert.ok(offered.text.includes(a.path));
    if(attachments.length>1)assert.ok(offered.text.includes(b.path));
    if(text)assert.ok(offered.text.startsWith(text+'\n\n'));
    assert.match(offered.text,/请用 Read 查看/);assert.equal(offered.attachments,undefined);
    const record=await f.ledger.get(input.requestId);
    assert.equal(record.textHash,digest(offered.text));assert.notEqual(record.textHash,digest(text));
    assert.equal(record.attachmentText,text);assert.deepEqual(record.attachmentIds,attachments);
    const claimed=await f.claim(input.requestId);await f.receipt(input.requestId,claimed.dispatchToken,nativeId);
    assert.equal((await f.delivery().status(input.requestId)).delivery,'waiting','transport receipt alone proves no native append');
    await appendFile(f.path,JSON.stringify(f.nativeRow(nativeId,offered.text))+'\n');
    const accepted=await f.delivery().status(input.requestId);
    assert.equal(accepted.delivery,'accepted');assert.equal(accepted.attachmentDelivery,'file-reference');
    assert.equal(accepted.nativeMessageId,nativeId);assert.equal(accepted.requestId,input.requestId);
    assert.equal((await findNativeUserProof({path:f.path,sessionId:f.sessionId,nativeMessageId:nativeId,textHash:digest(text)})).verified,false);
    for(const value of [offered,pending,accepted])assert.ok(!JSON.stringify(value).includes(f.token),'no access credential in content or public receipt');
    assert.equal(accepted.attachmentRead,undefined,'acceptance is not a Read-tool acknowledgement');
  }
  assert.equal(f.calls(),3);
});

test('image operation survives missing uploads and restart without another native send',async t=>{
  const f=await fixture(t),image=await f.upload(),input={...f.args(),attachments:[image.id]},nativeId=randomUUID();
  await Promise.all([f.submit(input),f.submit(input)]);assert.equal(f.calls(),1);
  const offered=(await f.poll(true)).body.job,{dispatchToken}=await f.claim(input.requestId);
  await f.receipt(input.requestId,dispatchToken,undefined,'unknown');await rm(image.path);
  assert.equal((await f.submit(input)).delivery,'unknown');assert.equal(f.calls(),1);
  await f.restart();
  assert.equal((await f.submit(input)).delivery,'unknown');assert.equal((await f.poll(true)).body.job,null);
  await appendFile(f.path,JSON.stringify(f.nativeRow(nativeId,offered.text))+'\n');
  await f.receipt(input.requestId,dispatchToken,nativeId);
  const accepted=await f.delivery().status(input.requestId);
  assert.equal(accepted.delivery,'accepted');assert.equal(accepted.attachmentDelivery,'file-reference');
  await rm(f.uploadsDir,{recursive:true});await f.restart();
  assert.equal((await f.submit(input)).delivery,'accepted');assert.equal(f.calls(),1);
  assert.deepEqual((await f.ledger.get(input.requestId)).attachmentIds,[image.id]);
  assert.equal(f.bridge().requestForMessage(f.sessionId,nativeId),input.requestId);
});

test('stale owner cannot claim and second live server cannot take the private socket',async t=>{
  const f=await fixture(t),input=f.args();await f.submit(input);const p=await f.poll(true);
  f.setOwner({entrypoint:'claude-desktop-3p',hostSessionId:f.desktopSessionId,pid:888});
  assert.equal((await f.request('/v1/claim',{sessionId:f.sessionId,requestId:input.requestId,leaseId:p.body.leaseId})).status,409);
  const second=new NativeUserBridge({stateDir:f.stateDir,ledger:f.ledger,ownerFor:async()=>null});
  await assert.rejects(second.start(),{code:'NATIVE_SOCKET_BUSY'});
  assert.ok(f.bridge().server.listening);
});

test('transcript mapping owns mutable display objects and recovers after restart',async t=>{
  const f=await fixture(t),input=f.args(),nativeId=randomUUID();await f.submit(input);const {dispatchToken}=await f.claim(input.requestId);
  await appendFile(f.path,JSON.stringify(f.nativeRow(nativeId))+'\n');await f.receipt(input.requestId,dispatchToken,nativeId);await f.delivery().status(input.requestId);
  await f.restart();
  const raw={id:f.sessionId,messages:[{id:nativeId,role:'user',text:'你好',attachments:[]}]};
  const view=f.delivery().annotateTranscript(raw);assert.equal(view.messages[0].requestId,input.requestId);
  view.messages[0].attachments.push({url:'preview'});view.messages[0].text='changed';
  assert.deepEqual(raw.messages[0].attachments,[]);assert.equal(raw.messages[0].text,'你好');
});
