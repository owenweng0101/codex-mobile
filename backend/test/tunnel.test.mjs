import test from 'node:test';import assert from 'node:assert/strict';import{extractTunnelUrl}from'../tunnel.mjs';
test('ignore vendor dashboard and documentation URLs',()=>{const welcome='manage domains at https://admin.localhost.run/ docs https://localhost.run/docs/';assert.equal(extractTunnelUrl(welcome,'localhostrun'),null);assert.equal(extractTunnelUrl(welcome+'\nabc123.lhr.life tunneled with tls termination, https://abc123.lhr.life\n','localhostrun'),'https://abc123.lhr.life');});
test('Cloudflare requires a tunnel subdomain',()=>{assert.equal(extractTunnelUrl('https://trycloudflare.com/docs','cloudflare'),null);assert.equal(extractTunnelUrl('https://hello-demo.trycloudflare.com','cloudflare'),'https://hello-demo.trycloudflare.com');});

test('rotating announcements always select the newest domain',()=>{
 const output='a1.lhr.life tunneled with tls termination, https://a1.lhr.life\n'+'b2.lhr.life tunneled with tls termination, https://b2.lhr.life\n';
 assert.equal(extractTunnelUrl(output,'localhostrun'),'https://b2.lhr.life');
 assert.equal(extractTunnelUrl('https://old.trycloudflare.com https://new.trycloudflare.com','cloudflare'),'https://new.trycloudflare.com');
});

test('readiness rejects a live process that serves no tunnel or a different service',async()=>{
 const {verifyTunnel}=await import('../tunnel.mjs');
 await assert.rejects(verifyTunnel('https://x.example','ours',async()=>({ok:false,status:502})),/502/);
 await assert.rejects(verifyTunnel('https://x.example','ours',async()=>({ok:true,json:async()=>({service:'codex-mobile-local',instance:'someone-else'})})),/本机服务/);
 assert.equal(await verifyTunnel('https://x.example','ours',async()=>({ok:true,json:async()=>({service:'codex-mobile-local',instance:'ours'})})),true);
});

test('unhealthy tunnel hides QR URL, restarts only its child and recovers',async()=>{
 const {ManagedTunnel}=await import('../tunnel.mjs');const{EventEmitter}=await import('node:events');
 const children=[];let healthy=true;
 const manager=new ManagedTunnel({port:1,instance:'ours',stateDir:'/tmp',checkInterval:60000,retryDelay:5,
  verify:async()=>{if(!healthy)throw Error('502 no tunnel');},
  spawnProcess:()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{child.killed=true;child.emit('exit')};children.push(child);return child;}
 });
 try{
  manager.start();children[0].stdout.emit('data',Buffer.from('tunneled with tls termination, https://a1.lhr.life\n'));
  await new Promise(setImmediate);assert.equal(manager.state.url,'https://a1.lhr.life');
  healthy=false;await manager.check();assert.equal(manager.state.url,null);await manager.check();assert.equal(children[0].killed,true);
  await new Promise(r=>setTimeout(r,15));assert.equal(children.length,2);
  healthy=true;children[1].stdout.emit('data',Buffer.from('tunneled with tls termination, https://b2.lhr.life\n'));
  await new Promise(setImmediate);assert.equal(manager.state.url,'https://b2.lhr.life');
 }finally{manager.stop();}
});
