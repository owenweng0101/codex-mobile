import {access,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {assertInstallFiles,runtimePlan} from './runtime-dependencies.mjs';

export async function checkTunnelConfiguration(state){
 try{
  let sakura;
  try{sakura=JSON.parse(await readFile(join(state,'sakura.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(sakura){
   if(new URL(sakura.origin).protocol!=='https:'||!sakura.binary||!sakura.configPath)throw Error('invalid');
   await access(sakura.binary);await access(sakura.configPath);
  }else{
   const config=await readFile(join(state,'cpolar.yml'),'utf8');
   if(!/authtoken:\s*"[A-Za-z0-9_-]{16,}"/.test(config))throw Error('invalid');
   await access(join(state,'cpolar'));
  }
 }catch{throw Error('Existing tunnel configuration/client is missing or invalid; no services were stopped. This command maintains an already provisioned installation.');}
}
export async function checkInstallPrerequisites({base,home=homedir()}={}){
 await assertInstallFiles(base,['adapter/frontend-stage/assets/index-BsmXQHMM.js','adapter/vendor/rpc.mjs','vendor/zcode-web/remote/v4/3.16.3/index.html',
  'dsh-mobile/frontend/manifest.json','dsh-mobile/frontend/index.html','dsh-mobile/frontend/public/index.html',
  'claude-mobile/backend/vendor/marked.umd.js','claude-mobile/backend/vendor/marked.esm.js','claude-mobile/backend/vendor/pdfjs/loader.mjs']);
 // No access keys or pairing values leave this preflight.
 const support=join(home,'Library/Application Support/CodexMobile');
 try{
  for(const name of ['access-token','gateway_ed25519','gateway_ed25519.pub','gateway.json'])await access(join(support,name));
  const gateway=JSON.parse(await readFile(join(support,'gateway.json'),'utf8'));
  if(!gateway||typeof gateway!=='object')throw Error('invalid');
 }catch{throw Error('Existing Codex backend private state is missing or invalid; no services were stopped. Provision it before install:local.');}
 await checkTunnelConfiguration(join(home,'Library/Application Support/CodexMobileCpolar'));
 for(const workspace of ['backend','adapter','connection'])await runtimePlan(join(base,workspace),{root:base});
}
