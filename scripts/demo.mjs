// Runs the actual compatibility UI with fixture data. Never opens a Codex IPC
// socket, reads ~/.codex, or sends a prompt to a model.
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import QRCode from 'qrcode';
const root=resolve(import.meta.dirname,'..'),state=resolve(root,'runtime/demo');await mkdir(state,{recursive:true,mode:0o700});
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',now=1792987200;
const thread={id,name:'让手机连接电脑上的 Codex',cwd:'/workspace/codex-mobile',projectId:'demo',updatedAt:now,createdAt:now-3600,status:{type:'idle'},model:'gpt-5',reasoningEffort:'medium'};
const turns=[{id:'demo-turn',status:'completed',startedAt:now-120,completedAt:now,items:[{id:'demo-user',type:'userMessage',content:[{type:'text',text:'手机微信扫码后，怎么连接到电脑上的 Codex？'}]},{id:'demo-answer',type:'agentMessage',text:'扫码后打开手机网页，请求通过 HTTPS 和隧道转发到你的电脑。\n\n**连接路径**\n\n手机 → 樱花公网节点 → frpc → 本机访问入口 → Codex\n\n你可以在手机上查看项目、阅读历史消息，以及向空闲会话发送任务。电脑需要保持开机联网。\n\n当前内容是公开截图专用的演示数据，不包含真实会话。'}]}];
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'?input:input.url||input);if(url.origin!=='http://127.0.0.1:8787')return nativeFetch(input,options);
 const path=url.pathname;let data;
 if(path==='/local/info')data={localUrl:'http://127.0.0.1:8787/#'+'a'.repeat(43)};
 else if(path==='/api/projects')data={projects:[{id:'demo',name:'Codex Mobile · 演示',roots:['/workspace/codex-mobile'],count:2}],otherCount:0};
 else if(path==='/api/threads')data={data:[thread,{...thread,id:other,name:'为项目补充安装说明',updatedAt:now-1800}],nextCursor:null};
 else if(path==='/api/organize')data={pins:[],unread:[],groups:[],assignments:{}};
 else if(path==='/api/models')data={data:[{id:'gpt-5',model:'gpt-5',displayName:'GPT-5',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}],inputModalities:['text','image']}]};
 else if(path==='/api/status')data={online:true,cwd:'/workspace/codex-mobile',desktopOnline:true,active:{},uncertainDesktop:[]};
 else if(path==='/api/history')data={thread:{...thread,id:url.searchParams.get('threadId')||id},turns,nextCursor:null,approvals:[]};
 else if(path==='/api/events'){await new Promise(r=>setTimeout(r,1500));data={events:[],sequence:0,epoch:'demo',lastId:0};}
 else if(path==='/api/skills')data={data:[],skills:[]};
 else if(path==='/api/archived')data={data:[],nextCursor:null};
 else if(path==='/api/file')data={files:[],entries:[]};
 else if(path==='/api/goal')data={goal:null};
 else return new Response(JSON.stringify({error:'演示模式不执行操作'}),{status:403,headers:{'content-type':'application/json'}});
 if(options.method&&options.method!=='GET')return new Response('{"error":"演示模式不执行操作"}',{status:403});
 return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
};
process.env.CODEX_MOBILE_ADAPTER_PORT='19096';process.env.CODEX_MOBILE_ADAPTER_STATE_DIR=state;process.env.CODEX_MOBILE_WORKSPACE_DIR='/workspace/codex-mobile';
// The adapter creates its default workspace; keep this inside the demo directory.
process.env.CODEX_MOBILE_WORKSPACE_DIR=state+'/workspace';
await import('../adapter/server.mjs');
const qr=await QRCode.toDataURL('https://example.invalid/codex-mobile-demo',{width:280,margin:3});
const panel=http.createServer(async(req,res)=>{if(req.url==='/api/mobile'){res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'online',demo:true,qr}));return;}res.setHeader('content-type','text/html; charset=utf-8');res.end(await readFile(root+'/web/pair.html'));});
panel.listen(19091,'127.0.0.1',()=>console.log('Demo pairing panel: http://127.0.0.1:19091/; UI: http://127.0.0.1:19096/ (fixture data only)'));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>panel.close());
