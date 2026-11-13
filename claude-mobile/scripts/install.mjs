import {mkdir,writeFile,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** 安装 Claude 手机入口的 LaunchAgent；沿用 dsh-mobile 的安装方式。 */

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const node=process.execPath;
const state=join(homedir(),'Library','Application Support','ClaudeMobile');
const agents=join(homedir(),'Library','LaunchAgents');
const label='com.wengqiang.claude-mobile';
const port=Number(process.env.CLM_PORT??18903);
const domain=`gui/${process.getuid()}`;

const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const args=[node,join(project,'backend','server.mjs')].map(value=>`<string>${escape(value)}</string>`).join('');
const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>WorkingDirectory</key><string>${escape(project)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLM_PORT</key><string>${port}</string>
    <key>CLM_BIND</key><string>0.0.0.0</string>
    <key>PATH</key><string>${escape(join(homedir(),'.local/bin'))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(join(state,'claude-mobile.log'))}</string>
  <key>StandardErrorPath</key><string>${escape(join(state,'claude-mobile.error.log'))}</string>
</dict>
</plist>
`;


await mkdir(state,{recursive:true,mode:0o700});
await mkdir(agents,{recursive:true});
const plistPath=join(agents,`${label}.plist`);
await writeFile(plistPath,plist,{mode:0o600});
await chmod(plistPath,0o600);
execFileSync('plutil',['-lint',plistPath],{stdio:'pipe'});

try{execFileSync('launchctl',['bootout',`${domain}/${label}`],{stdio:'ignore'});}catch{}
try{
  const ids=execFileSync('lsof',['-t',`-iTCP:${port}`,'-sTCP:LISTEN'],{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean);
  for(const id of ids){
    let cwd='';
    try{
      const listing=execFileSync('lsof',['-a','-p',id,'-d','cwd','-Fn'],{encoding:'utf8'});
      cwd=listing.split('\n').find(line=>line.startsWith('n'))?.slice(1)??'';
    }catch{}
    if(cwd!==project){console.error(`端口 ${port} 被其它程序占用，未做处理（pid ${id}，cwd ${cwd||'未知'}）`);continue;}
    try{process.kill(Number(id),'SIGTERM');}catch{}
  }
}catch{}
await new Promise(resolveWait=>setTimeout(resolveWait,600));

execFileSync('launchctl',['enable',`${domain}/${label}`],{stdio:'pipe'});
const bootstrap=()=>{try{execFileSync('launchctl',['bootstrap',domain,plistPath],{stdio:'pipe'});return true;}catch{return false;}};
for(let attempt=0;attempt<20;attempt++){
  const busy=(()=>{try{return execFileSync('lsof',['-t',`-iTCP:${port}`,'-sTCP:LISTEN'],{encoding:'utf8'}).trim().length>0;}catch{return false;}})();
  if(!busy&&bootstrap())break;
  if(attempt===19){try{execFileSync('launchctl',['kickstart','-k',`${domain}/${label}`],{stdio:'pipe'});}catch{}}
  await new Promise(resolveWait=>setTimeout(resolveWait,250));
}

let ready=false;
for(let attempt=0;attempt<60;attempt++){
  try{
    const response=await fetch(`http://127.0.0.1:${port}/_claude/status`,{signal:AbortSignal.timeout(600)});
    if(response.ok){
      const value=await response.json();
      if(value.service==='claude-mobile'){
        ready=true;
        console.log('Claude 手机组件已就绪；请使用桌面「手机连接」统一二维码。');
        console.log('Claude 运行环境：'+(value.upstreamReady?'可用':('未就绪 · '+(value.upstreamError??'未知'))));
        break;
      }
    }
  }catch{}
  await new Promise(resolveWait=>setTimeout(resolveWait,250));
}
if(!ready){
  console.error('手机网关安装了但未就绪，请查看日志：'+join(state,'claude-mobile.error.log'));
  process.exitCode=1;
}else{
  console.log('三合一入口：~/Desktop/手机连接/手机连接.png');
}
