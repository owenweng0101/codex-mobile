import {mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {readControlResponse} from './control-client.mjs';
import {assertInstallFiles,prepareRuntimeDependencies,installRuntimeDependencies} from '../scripts/runtime-dependencies.mjs';
import {checkTunnelConfiguration} from '../scripts/install-preflight.mjs';
const source=import.meta.dirname,project=resolve(source,'..'),state=join(homedir(),'Library/Application Support/CodexMobileCpolar');
const services=join(state,'services'),adapterName='adapter',adapterSource=join(project,adapterName),adapter=join(services,adapterName),app=join(state,'app');
const readLabel='com.owen.codex-original-read',label='com.owen.codex-cpolar',domain='gui/'+process.getuid();
const connectionFiles=['server.mjs','ingress.mjs','dsh-proxy.mjs','cpolar.mjs','sakura.mjs','control-client.mjs','mobile-entry.mjs','package.json'];
const adapterFiles=['mobile-theme.css','attachment-scope.mjs','image-recovery.mjs','queued-attachments.mjs','mobile-connection.mjs','attachment-upload.mjs','server.mjs','api-client.mjs','mobile-api.mjs','mobile-history.mjs','mobile-image.mjs','write-client.mjs','write-services','auth.mjs','rpc-server.mjs','navigation.mjs','unavailable-services.mjs','package.json','vendor','read-services'];
const frontendFiles=['platform-services.mjs','support-services.mjs','conversation-read.mjs','browser-adapter.mjs','assets'];
await assertInstallFiles(source,connectionFiles);await assertInstallFiles(adapterSource,[...adapterFiles,'codex-entry.mjs']);
await assertInstallFiles(join(adapterSource,'frontend-stage'),frontendFiles);
await assertInstallFiles(project,['vendor/zcode-web/remote/v4/3.16.3/index.html','backend/mobile-history-shared.mjs','backend/conversation-rows.mjs']);
await checkTunnelConfiguration(state);
const connectionDependencies=await prepareRuntimeDependencies(source,{root:project});
const adapterDependencies=await prepareRuntimeDependencies(adapterSource,{root:project});
// Preparation is complete. Stop only the two owned phone services before
// replacing their files; do not mutate a running runtime during preflight.
for(const name of [label,readLabel])bootout(name);
stopOwned(8797,[join(source,'server.mjs'),join(app,'server.mjs')]);stopOwned(8796,[join(adapter,'server.mjs'),'zcode-codex-adapter-20261025/server.mjs']);
for(let i=0;i<30;i++){let busy=false;for(const port of [8796,8797,8798]){try{execFileSync('lsof',['-t','-iTCP:'+port,'-sTCP:LISTEN'],{stdio:'pipe'});busy=true;}catch{}}if(!busy)break;if(i===29)throw Error('Old isolated service has not exited');await new Promise(r=>setTimeout(r,100));}
await mkdir(app,{recursive:true,mode:0o700});await mkdir(adapter,{recursive:true,mode:0o700});
// adapter/server imports ../connection/mobile-entry.mjs in the installed tree;
// ingress imports ./mobile-entry.mjs from app. Prepare both before importers.
await mkdir(join(services,'connection'),{recursive:true,mode:0o700});
await cp(join(source,'mobile-entry.mjs'),join(services,'connection','mobile-entry.mjs'));
// Stage shared projection and content-addressed chunks before their importers.
await mkdir(join(services,'backend'),{recursive:true,mode:0o700});
for(const file of ['mobile-history-shared.mjs','conversation-rows.mjs'])await cp(join(project,'backend',file),join(services,'backend',file));
await mkdir(join(services,'vendor'),{recursive:true,mode:0o700});
await cp(join(project,'vendor/zcode-web'),join(services,'vendor/zcode-web'),{recursive:true});
for(const file of connectionFiles)await cp(join(source,file),join(app,file),{recursive:true});
for(const file of adapterFiles)await cp(join(adapterSource,file),join(adapter,file),{recursive:true});
await installRuntimeDependencies(connectionDependencies,app);await connectionDependencies.dispose();
await installRuntimeDependencies(adapterDependencies,adapter);await adapterDependencies.dispose();
await mkdir(join(adapter,'frontend-stage'),{recursive:true,mode:0o700});
for(const file of frontendFiles)await cp(join(adapterSource,'frontend-stage',file),join(adapter,'frontend-stage',file),{recursive:true});
await cp(join(adapterSource,'codex-entry.mjs'),join(adapter,'codex-entry.mjs'));
// Remove the retired custom UI from older installations.
await rm(join(services,'mobile'),{recursive:true,force:true});
await rm(join(adapter,'mobile-static.mjs'),{force:true});
await writeFile(join(state,'preferences.json'),JSON.stringify({mode:'codex-read'}),{mode:0o600});
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const agents=join(homedir(),'Library/LaunchAgents');await mkdir(agents,{recursive:true});
function bootout(name){try{execFileSync('launchctl',['bootout',domain+'/'+name],{stdio:'ignore'});}catch{}}
function stopOwned(port,expected){let ids=[];try{ids=execFileSync('lsof',['-t','-iTCP:'+port,'-sTCP:LISTEN'],{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean);}catch{}
 for(const id of ids){const args=execFileSync('ps',['-p',id,'-o','args='],{encoding:'utf8'});if(!expected.some(v=>args.includes(v)))throw Error('Port '+port+' belongs to a different application; stopped installation');process.kill(Number(id),'SIGTERM');}}
function launch(name,folder){
 const args=[process.execPath,join(folder,'server.mjs')].map(v=>'<string>'+escape(v)+'</string>').join('');
 const xml=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${args}</array><key>WorkingDirectory</key><string>${escape(folder)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${escape(join(state,name+'.log'))}</string><key>StandardErrorPath</key><string>${escape(join(state,name+'.error.log'))}</string></dict></plist>`;
 return{path:join(agents,name+'.plist'),xml};
}
for(const [name,folder]of [[readLabel,adapter],[label,app]]){const entry=launch(name,folder);await writeFile(entry.path,entry.xml,{mode:0o600});execFileSync('plutil',['-lint',entry.path],{stdio:'pipe'});execFileSync('launchctl',['enable',domain+'/'+name]);execFileSync('launchctl',['bootstrap',domain,entry.path]);}
let ready=false;for(let attempt=0;attempt<80;attempt++){try{const a=await fetch('http://127.0.0.1:8796/healthz',{signal:AbortSignal.timeout(500)}).then(r=>r.json());const b=await readControlResponse({signal:AbortSignal.timeout(500)}).then(r=>r.json());if(a.service==='codex-original-zcode-bridge'&&b.mode==='codex-read'){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}
if(!ready)throw Error('Isolated services installed but not healthy; inspect private service logs');
console.log('Installed isolated original read adapter and cpolar supervisor. QR codes: ~/Desktop/手机连接/');
