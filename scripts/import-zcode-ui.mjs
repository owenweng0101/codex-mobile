// The repository contains compatibility code, not third-party compiled bundles.
// Import the matching RPC runtime from a local ZCode installation and download
// its public, version-pinned web resources only on the user's own machine.
import {open,readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const app=option('--zcode-app','/Applications/ZCode.app');
const asar=await open(join(app,'Contents/Resources/app.asar'),'r');
try{
 const header=Buffer.alloc(16);await asar.read(header,0,16,0);const size=header.readUInt32LE(12);
 if(size>64*1024*1024)throw Error('Unexpected ASAR header size');
 const data=Buffer.alloc(size);await asar.read(data,0,size,16);const tree=JSON.parse(data),base=8+header.readUInt32LE(4);
 async function extract(path){let entry=tree;for(const part of path.split('/'))entry=entry.files?.[part];if(!entry||entry.unpacked||!Number.isSafeInteger(entry.size))throw Error('Unsupported ZCode layout: '+path);const bytes=Buffer.alloc(entry.size);await asar.read(bytes,0,bytes.length,base+Number(entry.offset));return bytes;}
 const meta=JSON.parse(await extract('package.json'));if(meta.version!=='3.16.3')throw Error('This adapter is pinned to ZCode 3.16.3; found '+meta.version+'. Do not mix versions.');
 await mkdir(join(root,'adapter/vendor'),{recursive:true});
 for(const file of ['chunk-CM2YMK3U.js','chunk-HH7N2YVI.js'])await writeFile(join(root,'adapter/vendor',file),await extract('out/main/'+file));
}finally{await asar.close();}
const web=join(root,'vendor/zcode-web'),prefix='/remote/v4/3.16.3/',origin='https://zcode.z.ai';
const local=option('--web-assets',null);
if(local){await cp(resolve(local),web,{recursive:true});}
else{
 const pending=[new URL(prefix+'index.html',origin)],seen=new Set(pending.map(x=>x.href));let count=0;
 function enqueue(raw,from){
  if(!raw||raw.startsWith('data:')||raw.includes('${'))return;let url;try{url=new URL(raw,from);}catch{return;}
  if(url.origin!==origin||!url.pathname.startsWith(prefix)||!/^\/[A-Za-z0-9_./-]+$/.test(url.pathname)||url.pathname.split('/').includes('..')||!/\.(?:js|css|woff2?|ttf|otf|wasm|svg|png|jpe?g|webp|gif|ico|html)$/.test(url.pathname))return;
  url.search='';url.hash='';if(!seen.has(url.href)){seen.add(url.href);pending.push(url);}
 }
 function discover(body,url){
  for(const m of body.matchAll(/(?:src|href)=["']([^"']+)["']/g))enqueue(m[1],url);
  for(const m of body.matchAll(/["']((?:\.?\.?\/|\/remote\/|assets\/)?[A-Za-z0-9_./-]+\.(?:js|css|woff2?|ttf|otf|wasm|svg|png|jpe?g|webp|gif|ico|html))["']/g))enqueue(m[1],m[1].startsWith('assets/')?origin+prefix:url);
  for(const m of body.matchAll(/url\(["']?([^\s)'";]+)["']?\)/g))enqueue(m[1],url);
 }
 while(pending.length){
  await Promise.all(pending.splice(0,8).map(async url=>{
   const path=join(web,url.pathname);let bytes;try{bytes=await readFile(path);}catch{const response=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Asset download failed: '+response.status+' '+url.pathname);bytes=Buffer.from(await response.arrayBuffer());await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);}
   if(/\.(?:js|css|html)$/.test(url.pathname))discover(bytes.toString('utf8'),url.href);count++;
  }));
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
