import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkInstallPrerequisites} from './install-preflight.mjs';
const execute=promisify(execFile),root=dirname(dirname(fileURLToPath(import.meta.url)));
const components=[
 ['backend','com.owen.codex-mobile','backend/install-local.mjs'],
 ['adapter','com.owen.codex-original-read'],
 ['ingress','com.owen.codex-cpolar','connection/install-local.mjs'],
 ['dsh','com.wengqiang.dsh-mobile','dsh-mobile/scripts/install.mjs'],
 ['claude','com.wengqiang.claude-mobile','claude-mobile/scripts/install.mjs'],
 ['qr','com.wengqiang.mobile-qr','desktop/mobile-qr/install.mjs'],
];
export function plan(action,args=[]){
 for(const arg of args)if(!['--codex-backend','--dry-run','--check','--json','--help'].includes(arg))throw Error('Unknown option: '+arg);
 if(!['install','start','status','stop'].includes(action))throw Error('Unknown action.');
 if(args.includes('--check')&&action!=='install')throw Error('--check is for install:local.');
 return components.filter(([id,,installer])=>(action!=='install'||installer)
  &&(id!=='backend'||!['install','stop'].includes(action)||args.includes('--codex-backend')))
  .map(([id,label,installer])=>({id,label,installer}));
}
export async function checkPython({env=process.env,run=execute}={}){
 try{await run(env.CODEX_MOBILE_PYTHON||'python3',['-c','import pypdf, reportlab'],{env,timeout:10000});}
 catch{throw Error('Python needs pypdf and reportlab. Set CODEX_MOBILE_PYTHON or install requirements-dev.txt with python3.');}
}
export async function inspect(label,{run=execute,uid=process.getuid?.()}={}){
 try{const {stdout}=await run('launchctl',['print',`gui/${uid}/${label}`],{timeout:5000});
  return {loaded:true,running:/\bstate = running\b/.test(stdout),pid:Number(/\bpid = (\d+)/.exec(stdout)?.[1])||null};
 }catch(error){if([3,113].includes(error.code))return {loaded:false,running:false,pid:null};throw Error('Cannot inspect '+label+'; no services changed.');}
}
export async function manage(action,args=[],{run=execute,readJob=inspect,base=root,home=homedir(),uid=process.getuid?.(),env=process.env,log=console.log,python=checkPython,preflight=checkInstallPrerequisites,prepareUpdate}={}){
 const items=plan(action,args);
 if(args.includes('--dry-run')){for(const item of items)log(`${action} ${item.id}: ${action==='install'?item.installer:item.label}`);return items;}
 if(action==='install'){
  // Check every delegated path before any installer can stop an existing job.
  for(const item of items)await access(join(base,item.installer));
  await preflight({base,home});
  await python({env,run});
  if(args.includes('--check')){log('Installer paths and Python dependencies available; no services changed.');return items;}
  for(const item of items){
   log('Installing '+item.id+'.');
   // The optional backend installer retains prepareLocalUpdate/assertUpdatePermit.
   // DSH starts only its phone gateway. No pin/capture or desktop host command.
   const installerArgs=[join(base,item.installer),...(item.id==='qr'?['--apply']:[])];
   try{await run(process.execPath,installerArgs,{cwd:base,env,timeout:180000,maxBuffer:8*1024*1024});}
   catch{throw Error(item.id+' installer failed; remaining installers were not run. Inspect the private service log.');}
  }
  return items;
 }
 const jobs=await Promise.all(items.map(async item=>({...item,...await readJob(item.label,{run,uid})})));
 if(action==='status')return jobs.map(({id,label,loaded,running,pid})=>({id,label,loaded,running,pid}));
 if(action==='start'){
  await python({env,run});
  for(const item of jobs)if(!item.loaded)await access(join(home,'Library/LaunchAgents',item.label+'.plist'));
 }
 if(action==='stop'&&jobs.some(item=>item.id==='backend'&&item.running)){
  if(prepareUpdate)await prepareUpdate();
  else{const {prepareLocalUpdate,assertUpdatePermit}=await import('../backend/update-preflight.mjs');assertUpdatePermit(await prepareLocalUpdate());}
 }
 for(const item of action==='stop'?[...jobs].reverse():jobs){
  const target=`gui/${uid}/${item.label}`;
  if(action==='start'){
   if(item.running){log(item.id+': already running; kept.');continue;}
   if(!item.loaded)await run('launchctl',['bootstrap',`gui/${uid}`,join(home,'Library/LaunchAgents',item.label+'.plist')]);
   await run('launchctl',['kickstart',target]); // Never -k: do not restart active jobs.
  }else if(item.loaded)await run('launchctl',['bootout',target]);
  log(item.id+': '+(action==='start'?'started':'stopped')+'.');
 }
 return jobs;
}
export async function main(action,args=process.argv.slice(2)){
 try{
  if(args.includes('--help')){console.log(`${action}: --dry-run; install: --check; status: --json. Default install/stop preserve the Codex backend; --codex-backend explicitly includes it. Start reuses running jobs. No standalone QR web panel.`);return;}
  if(!args.includes('--dry-run')&&process.platform!=='darwin')throw Error('LaunchAgent management requires macOS. Tests and resource preparation remain portable.');
  const rows=await manage(action,args);
  if(action==='status'&&!args.includes('--dry-run'))console.log(args.includes('--json')?JSON.stringify(rows,null,2):rows.map(row=>`${row.id}: ${row.running?'running':row.loaded?'loaded/stopped':'not installed'}${row.pid?' (pid '+row.pid+')':''}`).join('\n'));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
