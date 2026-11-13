import { mkdir,readFile,writeFile,cp,chmod,rm } from 'node:fs/promises';
import { dirname,resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { prepareLocalUpdate, assertUpdatePermit } from './update-preflight.mjs';
import {assertInstallFiles,prepareRuntimeDependencies,installRuntimeDependencies} from '../scripts/runtime-dependencies.mjs';
const source=dirname(fileURLToPath(import.meta.url));
const support=join(homedir(),'Library/Application Support/CodexMobile');
const app=join(support,'app');
const label='com.owen.codex-mobile',domain=`gui/${process.getuid()}`;
const files=['thread-metadata.mjs','skill-input.mjs','auto-title.mjs','mobile-history-shared.mjs','conversation-rows.mjs','conversation-index.mjs','server.mjs','core.mjs','git-view.mjs','view.mjs','tunnel.mjs','terminal.mjs','queue.mjs','message-delivery.mjs','capabilities.mjs','organization.mjs','desktop-bridge.mjs','file-content.mjs','catalog.mjs','desktop-intent.mjs','automations.mjs','file-search.mjs','projects.mjs','creation-ledger.mjs','native-archive.mjs','search.mjs','workspace-access.mjs','archived.mjs','goals.mjs','history-media.mjs','image-snapshots.mjs','native-media.mjs','attachments.mjs','attachments-extract.py','package.json','public'];
await assertInstallFiles(source,files);
await mkdir(support,{recursive:true,mode:0o700});await chmod(support,0o700);
for(const name of ['access-token','gateway_ed25519','gateway_ed25519.pub','gateway.json']){
 try{await readFile(join(support,name));}catch{throw Error('Missing installed runtime configuration: '+name+'; restore it in Application Support/CodexMobile before reinstalling.');}
}
const gateway=JSON.parse(await readFile(join(support,'gateway.json'),'utf8'));
let python=process.env.CODEX_MOBILE_PYTHON;
if(!python)try{python=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :EnvironmentVariables:CODEX_MOBILE_PYTHON',join(homedir(),'Library/LaunchAgents',label+'.plist')],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
python=python||'python3';
try{execFileSync(python,['-c','import pypdf, reportlab'],{stdio:'pipe',timeout:10000});}catch{throw Error('Python PDF dependencies are unavailable; set CODEX_MOBILE_PYTHON. No service was stopped.');}
// Resolve and install the frozen production graph BEFORE acquiring a drain
// permit or stopping anything. No workspace-local lock/node_modules is needed.
const dependencies=await prepareRuntimeDependencies(source);
const updatePermit=await prepareLocalUpdate();
assertUpdatePermit(updatePermit);
gateway.keyPath=join(support,'gateway_ed25519');await writeFile(join(support,'gateway.json'),JSON.stringify(gateway,null,2),{mode:0o600});
try{execFileSync('launchctl',['bootout',`${domain}/${label}`],{stdio:'ignore'});}catch{}
// bootout may return while the old registration is still being removed. Do not
// mistake that registration for a successful bootstrap of the new service.
for(let attempt=0;attempt<50;attempt++){
 let registered=false;try{execFileSync('launchctl',['print',`${domain}/${label}`],{stdio:'ignore'});registered=true;}catch{}
 if(!registered)break;
 if(attempt===49)throw Error('旧后台服务仍在卸载，请稍后重新更新。');
 await new Promise(resolve=>setTimeout(resolve,100));
}
try{
 const response=await fetch('http://127.0.0.1:8787/healthz',{signal:AbortSignal.timeout(2000)});const health=await response.json();
 if(health.service!=='codex-mobile-local')throw Error('8787 端口被其他程序占用');
 const pid=Number(execFileSync('lsof',['-t','-iTCP:8787','-sTCP:LISTEN'],{encoding:'utf8'}).trim());if(pid)process.kill(pid,'SIGTERM');
 await new Promise(r=>setTimeout(r,800));
}catch(e){if(e.message==='8787 端口被其他程序占用')throw e;}
await mkdir(app,{recursive:true,mode:0o700});
for(const name of files)await cp(join(source,name),join(app,name),{recursive:true});
for(const name of ['index.html','app.js','style.css','pair.html','pair.js'])await rm(join(app,'public',name),{force:true});
await installRuntimeDependencies(dependencies,app);await dependencies.dispose();
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const args=[process.execPath,join(app,'server.mjs'),'--no-tunnel'].map(s=>`<string>${escape(s)}</string>`).join('');
const env={CODEX_MOBILE_STATE_DIR:support,CODEX_MOBILE_CWD:join(homedir(),'codex'),CODEX_MOBILE_BIND:'127.0.0.1',CODEX_MOBILE_PYTHON:python,PATH:`${homedir()}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`};
// Preserve explicitly configured artifact roots across subsequent local updates.
try {
 const previous=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :EnvironmentVariables:CODEX_MOBILE_ARTIFACT_ROOTS',join(homedir(),'Library/LaunchAgents',label+'.plist')],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 if(previous)env.CODEX_MOBILE_ARTIFACT_ROOTS=previous;
} catch {}
const envXML=Object.entries(env).map(([k,v])=>`<key>${k}</key><string>${escape(v)}</string>`).join('');
const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args}</array><key>WorkingDirectory</key><string>${escape(app)}</string><key>EnvironmentVariables</key><dict>${envXML}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>${escape(join(support,'service.log'))}</string><key>StandardErrorPath</key><string>${escape(join(support,'service-error.log'))}</string></dict></plist>`;
const agents=join(homedir(),'Library/LaunchAgents');await mkdir(agents,{recursive:true});const path=join(agents,label+'.plist');await writeFile(path,plist,{mode:0o600});
execFileSync('plutil',['-lint',path],{stdio:'inherit'});
execFileSync('launchctl',['enable',`${domain}/${label}`],{stdio:'inherit'});
for(let attempt=0;attempt<3;attempt++){
 try{execFileSync('launchctl',['bootstrap',domain,path],{stdio:attempt===2?'inherit':'pipe'});break;}
 catch(error){let registered=false;try{execFileSync('launchctl',['print',`${domain}/${label}`],{stdio:'ignore'});registered=true;}catch{}if(registered)break;if(attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,500));}
}
let healthy=false;
for(let attempt=0;attempt<60;attempt++){
 try{const response=await fetch('http://127.0.0.1:8787/healthz',{signal:AbortSignal.timeout(500)});const health=await response.json();if(response.ok&&health.service==='codex-mobile-local'){healthy=true;break;}}catch{}
 await new Promise(resolve=>setTimeout(resolve,250));
}
if(!healthy)throw Error('后台服务已注册，但尚未通过健康检查，请查看 CodexMobile/service-error.log。');
console.log('Codex 手机后台服务已安装并通过健康检查；请使用统一桌面二维码。');
