// The repository contains compatibility code, not third-party compiled bundles.
// Build the RPC runtime from the included upstream source and download
// version-pinned web resources. No desktop application is read or installed.
import './build-rpc.mjs';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
if(args.length&&!(args.length===2&&args[0]==='--web-assets'&&args[1]))throw Error('Usage: npm run prepare:ui [-- --web-assets /path/to/cached-web-assets]. ZCode installation is not required.');
const web=join(root,'vendor/zcode-web'),prefix='/remote/v4/3.16.3/',origin='https://zcode.z.ai';
const local=option('--web-assets',null);
if(local){await cp(resolve(local),web,{recursive:true});}
else{
 const pending=[new URL(prefix+'index.html',origin)],seen=new Set(pending.map(x=>x.href));let count=0,nextReport=100;
 function enqueue(raw,from){
  if(!raw||raw.startsWith('data:')||raw.includes('${'))return;let url;try{url=new URL(raw,from);}catch{return;}
  if(url.origin!==origin||!url.pathname.startsWith(prefix)||!/^\/[A-Za-z0-9_./-]+$/.test(url.pathname)||url.pathname.split('/').includes('..')||!/\.(?:js|css|woff2?|ttf|otf|wasm|svg|png|jpe?g|webp|gif|ico|html)$/.test(url.pathname))return;
  url.search='';url.hash='';if(!seen.has(url.href)){seen.add(url.href);pending.push(url);}
 }
 function discover(body,url){
  if(url.endsWith('.html'))for(const m of body.matchAll(/(?:src|href)=["']([^"']+)["']/g))enqueue(m[1],url);
  // Vite emits fingerprinted filenames. Bare filenames inside editor grammars
  // (for example "component.html") are sample code, not downloadable assets.
  for(const m of body.matchAll(/["'`]((?:\.{1,2}\/|\/remote\/|assets\/)[A-Za-z0-9_./-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|ttf|otf|wasm|svg|png|jpe?g|webp|gif|ico))["'`]/g))enqueue(m[1],m[1].startsWith('assets/')?origin+prefix:url);
  for(const m of body.matchAll(/new URL\(["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\)/g))enqueue(m[1],url);
  if(url.endsWith('.css'))for(const m of body.matchAll(/url\(["']?([^\s)'";]+)["']?\)/g))enqueue(m[1],url);
 }
 async function download(url){
  for(let attempt=0;attempt<3;attempt++)try{
   const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
   if(!response.ok)throw Object.assign(Error('HTTP '+response.status),{status:response.status});
   return Buffer.from(await response.arrayBuffer());
  }catch(error){
   if(attempt===2||error.status&&error.status<500&&error.status!==429)throw Error('Asset download failed: '+url.pathname+' ('+error.message+'). Run prepare:ui again to resume.');
   console.log('Retrying UI asset '+url.pathname+' ('+(attempt+1)+'/2).');
   await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
  }
 }
 while(pending.length){
  await Promise.all(pending.splice(0,16).map(async url=>{
   const path=join(web,url.pathname);let bytes;try{bytes=await readFile(path);}catch{bytes=await download(url);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);}
   if(/\.(?:js|css|html)$/.test(url.pathname))discover(bytes.toString('utf8'),url.href);count++;
  }));
  if(count>=nextReport){console.log('Prepared '+count+' UI assets; '+pending.length+' queued.');nextReport=count+100;}
  if(seen.size>6000)throw Error('Dependency graph exceeds expected size');
 }
 console.log('Downloaded '+count+' version-pinned web assets.');
}
const baseline=join(root,'adapter/frontend-stage/baseline');await mkdir(baseline,{recursive:true});
await cp(join(web,prefix,'assets/index-BsmXQHMM.js'),join(baseline,'index-BsmXQHMM.js'));
const schemaDir=join(root,'adapter/write-services/vendor');await mkdir(schemaDir,{recursive:true});
let schemas=await readFile(join(web,prefix,'assets/parts-BD-IKHpw.js'),'utf8');
let replacements=0;schemas=schemas.replace(/from["']\.\/([^"']+)["']/g,(_all,name)=>{replacements++;return 'from"../../../vendor/zcode-web/remote/v4/3.16.3/assets/'+name+'"';});
if(replacements!==3)throw Error('Original schema imports changed; expected 3 local imports.');
schemas+='\n// Export original existing schemas for server adapter contract validation.\nexport {An as originalCommandPayloads,In as originalCommandAck,jn as originalCommandTypes};\n';
await writeFile(join(schemaDir,'original-command-schemas.mjs'),schemas);
const build=spawnSync(process.execPath,['adapter/frontend-stage/build-compat.mjs'],{cwd:root,stdio:'inherit'});if(build.status)process.exit(build.status);
console.log('UI prepared locally. Imported bundles remain gitignored.');
