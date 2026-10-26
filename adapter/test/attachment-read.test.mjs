import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationReadServices} from '../frontend-stage/conversation-read.mjs';

const THREAD='11111111-1111-4111-8111-111111111111',THREAD2='44444444-4444-4444-8444-444444444444';
const TURN='22222222-2222-4222-8222-222222222222',ITEM='33333333-3333-4333-8333-333333333333';
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('codex-mobile-attachment-test')]);

function imagePage(){
  return {thread:{id:THREAD,cwd:'/actual'},turns:[{id:TURN,items:[{id:ITEM,type:'userMessage',content:[
    {type:'text',text:'看图'},
    {type:'image',status:'candidate',reference:{threadId:THREAD,turnId:TURN,itemId:ITEM,index:1},url:'/api/thread-media?threadId='+THREAD+'&turnId='+TURN+'&itemId='+ITEM+'&index=1'},
  ]}]}]};
}
function refUrl(threadId=THREAD){
  return '/mobile/api/image?threadId='+threadId+'&turnId='+TURN+'&itemId='+ITEM+'&index=1';
}
function harness({page=imagePage()}={}){
  const historyGets=[];let fetches=0;
  const api={
    bearer:'test',credentials:async()=>{},origin:'http://127.0.0.1:8787',
    async get(path){if(path==='/api/history?threadId='+THREAD){historyGets.push(path);return structuredClone(page);}throw Error('unexpected GET '+path);},
    async fetch(url,init){fetches++;assert.match(url,/^http:\/\/127\.0\.0\.1:8787\/api\/thread-media\?/);assert.equal(init.headers.authorization,'Bearer test');return new Response(png,{headers:{'content-type':'image/png'}});},
  };
  const baseServices={
    project:{async readTree(){return{projects:[{id:'p',roots:[{rootPath:'/actual'}]}],tasks:[{taskId:THREAD,workspacePath:'/actual'}]};}},
    'zcode-task':{onDynamicTaskEvent:()=>()=>({dispose(){}})},
  };
  const services=createConversationReadServices({api,baseServices});
  return{services,counts:{get:()=>historyGets.length,fetches:()=>fetches}};
}

test('attachmentReadV4 streams a user-message image in original chunk protocol',async()=>{
  const {services}=harness(),agent=services.channels['zcode-agent'];
  const parts=[];let offset=0,mediaType,totalBytes;
  for(let guard=0;guard<64;guard++){
    const chunk=await agent.attachmentReadV4({workspacePath:'/actual',sessionId:THREAD,ref:refUrl(),offset,limit:5});
    totalBytes??=chunk.totalBytes;mediaType??=chunk.mediaType;
    assert.equal(chunk.totalBytes,totalBytes);assert.equal(chunk.mediaType,mediaType);
    const bytes=Buffer.from(chunk.dataBase64,'base64');
    assert.equal(offset+bytes.length,chunk.nextOffset??totalBytes);
    parts.push(bytes);
    if(chunk.nextOffset===null)break;
    offset=chunk.nextOffset;
  }
  assert.equal(mediaType,'image/png');assert.equal(totalBytes,png.length);
  assert.deepEqual(Buffer.concat(parts),png);
});
test('attachmentReadV4 rejects refs outside the current conversation',async()=>{
  const {services}=harness(),agent=services.channels['zcode-agent'];
  await assert.rejects(agent.attachmentReadV4({workspacePath:'/actual',sessionId:THREAD,ref:refUrl(THREAD2),offset:0,limit:16}),error=>error.code==='CODEX_ATTACHMENT_SCOPE');
  await assert.rejects(agent.attachmentReadV4({workspacePath:'/actual',sessionId:THREAD,ref:'http://evil.invalid/img',offset:0,limit:16}),error=>error.code==='CODEX_READ_ONLY_METHOD_UNAVAILABLE');
  await assert.rejects(agent.attachmentReadV4({workspacePath:'/actual',sessionId:THREAD,ref:refUrl(),offset:png.length+1,limit:16}),error=>error.code==='CODEX_READ_ONLY_METHOD_UNAVAILABLE');
});
test('history refresh reuses immutable cursor pages',async()=>{
  const older={thread:{id:THREAD,cwd:'/actual'},turns:[{id:'99999999-9999-4999-8999-999999999999',items:[{id:'99999999-9999-4999-8999-999999999998',type:'agentMessage',text:'旧回复'}]}]};
  let cursorGets=0;
  const api={
    bearer:'test',credentials:async()=>{},origin:'http://127.0.0.1:8787',
    async get(path){
      if(path==='/api/history?threadId='+THREAD)return {thread:{id:THREAD,cwd:'/actual'},turns:[{id:TURN,items:[{id:ITEM,type:'agentMessage',text:'新消息'}]}],nextCursor:'c1'};
      if(path==='/api/history?threadId='+THREAD+'&cursor=c1'){cursorGets++;return structuredClone(older);}
      throw Error('unexpected GET '+path);
    },
    async fetch(){throw Error('no media expected');},
  };
  const baseServices={
    project:{async readTree(){return{projects:[],tasks:[{taskId:THREAD,workspacePath:'/actual'}]};}},
    'zcode-task':{onDynamicTaskEvent:()=>()=>({dispose(){}})},
  };
  const services=createConversationReadServices({api,baseServices}),agent=services.channels['zcode-agent'];
  const sub=await agent.subscribeConversationV4({workspacePath:'/actual',sessionId:THREAD});
  assert.equal(cursorGets,1);
  await agent.resyncConversationV4({workspacePath:'/actual',sessionId:THREAD,subscriptionId:sub.ack.subscriptionId});
  assert.equal(cursorGets,1);
  await agent.unsubscribeConversationV4({workspacePath:'/actual',sessionId:THREAD,subscriptionId:sub.ack.subscriptionId});
  services.dispose();
});
