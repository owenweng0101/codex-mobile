import test from 'node:test';
import assert from 'node:assert/strict';
import {createSupportServices} from './support-services.mjs';
function fixture(online=true){
 const calls=[];
 const services=createSupportServices({api:{async get(path){calls.push(path);return{online,desktopOnline:online};}},baseServices:{project:{async readTree(){return{projects:[{roots:[{rootPath:'/allowed'}]}],tasks:[{workspacePath:'/task-only'}]};}},oauth:{getActiveProvider:async()=>null}}});
 return{services,calls};
}
test('vendor onboarding and marketing are explicitly disabled with no claimed migration',async()=>{
 const {services,calls}=fixture();
 const eligibility=await services['onboarding-record'].getOnboardingEligibility();
 assert.equal(eligibility.shouldOnboard,false);assert.equal(eligibility.disabled,true);
 assert.equal(await services['onboarding-record'].getLatestEntry(),null);
 assert.throws(()=>services['onboarding-record'].claimAnonymousRecord(),error=>error.code==='CODEX_ADAPTER_UNSUPPORTED');
 assert.throws(()=>services['onboarding-record'].appendRecord(),error=>error.code==='CODEX_ADAPTER_UNSUPPORTED');
 const sync=await services['settings-sync'].getFirstRunPromptState();assert.equal(sync.disabled,true);assert.equal(sync.decision,'skip-zcode-settings-import');
 const marketing=await services['marketing-touch'].query();assert.equal(marketing.disabled,true);assert.deepEqual(marketing.deliveries,[]);
 assert.deepEqual(calls,[]);
});
test('original V4 hello represents only real online read connection, all unadapted features false',async()=>{
 const {services,calls}=fixture();
 const hello=await services['zcode-agent'].helloConversationV4();
 assert.equal(hello.kind,'hello');assert.equal(hello.protocolVersion,3);assert.equal(hello.clientMode,'web-remote-replayable');assert.equal(hello.deliveryProfile,'replayable');assert.deepEqual(hello.auth,{});
 for(const [name,value]of Object.entries(hello.capabilities))if(name!=='compression')assert.equal(value,false,name);
 await services['zcode-agent'].initializeConversationV4({kind:'clientHello',protocolVersion:3,clientId:'own-client'});
 await assert.rejects(services['zcode-agent'].initializeConversationV4({kind:'clientHello',protocolVersion:3,clientId:'other-client'}),/clientChanged/);
 assert.deepEqual(calls,['/api/status']);
 const offline=fixture(false);await assert.rejects(offline.services['zcode-agent'].helloConversationV4(),error=>error.code==='CODEX_OFFLINE');
});
test('read workspace init checks actual roots/tasks without file or process access',async()=>{
 const {services}=fixture();
 assert.equal((await services['zcode-session'].initializeWorkspace({workspacePath:'/allowed'})).available,true);
 assert.equal((await services['zcode-agent'].initialize({workspacePath:'/task-only'})).readOnly,true);
 await assert.rejects(services['zcode-session'].initializeWorkspace({workspacePath:'/outside'}),error=>error.code==='CODEX_WORKSPACE_MISMATCH');
 await assert.rejects(services['zcode-session'].initializeWorkspace({workspacePath:'/allowed',workspaceIdentity:'remote-forged'}),error=>error.code==='CODEX_WORKSPACE_MISMATCH');
});
test('broadcast is local adapter event only and unknown operations fail immediately',async()=>{
 const {services,calls}=fixture();const messages=[];
 const sub=services.broadcast.onMessage(message=>messages.push(message));
 await services.broadcast.send({channel:'adapter-local',payload:{theme:'dark'}});
 assert.equal(messages.length,1);sub.dispose();
 assert.throws(()=>services.git.refresh(),error=>error.code==='CODEX_ADAPTER_UNSUPPORTED');
 assert.throws(()=>services['window-controller'].subscribeControllerV4(),error=>error.code==='CODEX_ADAPTER_UNSUPPORTED');
 assert.throws(()=>services['zcode-agent'].sendConversationCommandV4(),error=>error.code==='CODEX_ADAPTER_UNSUPPORTED');
 assert.deepEqual(await services.oauth.restoreCachedSessionState(),{status:'signed-out'});
 assert.deepEqual(calls,[]);
});

function skillFixture(result){
 const calls=[];
 const services=createSupportServices({api:{async get(path){calls.push(path);return result;}},baseServices:{project:{async readTree(){return{projects:[{roots:[{rootPath:'/real project'}]}],conversationWorkspacePath:'/conversations'};}}}});
 return{services,calls};
}
test('both original skills catalog reads preserve real Codex skill identity and availability',async()=>{
 const data=[
  {name:'local-skill',path:'/real project/.agents/skills/local/SKILL.md',description:'Local description',displayName:'Local',enabled:true,scope:'repo'},
  {name:'disabled-skill',path:'/home/.codex/skills/disabled/SKILL.md',description:'Disabled',enabled:false,scope:'user'},
  {name:'plugin-skill',path:'/home/.codex/plugins/cache/skill/SKILL.md',description:'Plugin',enabled:true,scope:'system',pluginId:'actual-plugin'},
 ];
 const original=structuredClone(data),f=skillFixture({data,errors:[{message:'native catalog warning'}]});
 const listed=await f.services.skills.list({workspacePath:'/real project',provider:'glm'});
 const referenced=await f.services['zcode-agent'].getSkillReferenceCatalog({workspacePath:'/real project',sessionId:'existing-session'});
 assert.deepEqual(referenced.skills,listed.skills);assert.equal(referenced.authority,null);
 assert.deepEqual(listed.skills.map(s=>s.id),data.map(s=>'codex:'+s.path));
 assert.deepEqual(listed.skills.map(s=>s.path),data.map(s=>s.path));
 assert.deepEqual(listed.skills.map(s=>s.name),data.map(s=>s.name));
 assert.deepEqual(listed.skills.map(s=>s.scope),['workspace','user','plugin']);
 assert.deepEqual(listed.skills.map(s=>s.nativeScope),['repo','user','system']);
 assert.equal(listed.skills[1].enabled,false);assert.equal(listed.skills[2].pluginId,'actual-plugin');
 assert.deepEqual(listed.diagnostics,[{message:'native catalog warning'}]);assert.equal(listed.capability.readOnly,true);
 assert.deepEqual(f.calls,Array(2).fill('/api/skills?cwd=%2Freal%20project'));
 assert.deepEqual(data,original);
 assert.throws(()=>f.services.skills.setEnabled({}),error=>error.code==='CODEX_ADAPTER_UNSUPPORTED');
 assert.throws(()=>f.services.skills.buildPromptContext({}),error=>error.code==='CODEX_ADAPTER_UNSUPPORTED');
 f.services['zcode-agent'].onAgentRuntimeRestarted(()=>assert.fail('no synthetic runtime event')).dispose();
});
test('skills reads enforce workspace scope and do not invent skills on invalid responses',async()=>{
 const f=skillFixture({data:[],errors:[]});
 await assert.rejects(f.services.skills.list({workspacePath:'/outside'}),error=>error.code==='CODEX_WORKSPACE_MISMATCH');
 await assert.rejects(f.services['zcode-agent'].getSkillReferenceCatalog({workspacePath:'/real project',workspaceIdentity:'remote'}),error=>error.code==='CODEX_WORKSPACE_MISMATCH');
 assert.deepEqual(f.calls,[]);
 assert.deepEqual((await f.services.skills.list({workspacePath:'/conversations'})).skills,[]);
 await assert.rejects(skillFixture({}).services.skills.list({workspacePath:'/real project'}),/目录响应无效/);
 await assert.rejects(skillFixture({data:[{name:'fake',path:'relative/SKILL.md',enabled:true,scope:'repo'}]}).services.skills.list({workspacePath:'/real project'}),/目录条目无效/);
});
