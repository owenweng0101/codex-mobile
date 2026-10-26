import {MessageChannel} from 'node:worker_threads';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {MessagePortProtocol,ChannelServer,ChannelClient,ProxyChannel} from './vendor/rpc.mjs';
import {CodexReadClient} from './api-client.mjs';
import {createReadServices} from './read-services/index.mjs';

const api=new CodexReadClient(),services=createReadServices({api}),ports=new MessageChannel();
const left=new MessagePortProtocol(ports.port1),right=new MessagePortProtocol(ports.port2);
const server=new ChannelServer(left,{}),client=new ChannelClient(right);
for(const [name,service] of Object.entries(services))server.registerChannel(name,ProxyChannel.fromService(service));
try{
  const tree=await client.getChannel('project').call('readTree',[{}]);
  assert(tree.projects.length>0);assert(tree.tasks.length>0);
  const direct=await api.get('/api/projects');
  assert.deepEqual(tree.projects.map(p=>p.id).sort(),direct.projects.map(p=>p.id).sort());
  const id='01a1704c-f3ec-7e92-8644-4b2dc6c6ec7f'; // Our own archived image QA fixture.
  const snapshot=await client.getChannel('zcode-task').call('getTaskSnapshot',[{taskId:id,messageLimit:20}]);
  assert.equal(snapshot.meta.taskId,id);assert(snapshot.messages.some(m=>m.role==='assistant'&&m.content.includes('红色')&&m.content.includes('蓝色')));
  const receipt={checkedAt:new Date().toISOString(),transport:'exact original ZCode MessagePortProtocol/ChannelServer/ChannelClient/ProxyChannel',source:'real existing Mac Codex GET API',projectCount:tree.projects.length,taskCount:tree.tasks.length,projectIdsMatchNative:true,historyFixtureId:id,historyMessages:snapshot.messages.length,expectedRealReply:true,writes:0,businessMessagesSent:0};
  await writeFile(new URL('./live-read-rpc-receipt.json',import.meta.url),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt,null,2));
}finally{client.dispose();server.dispose();left.disconnect();right.disconnect();}
