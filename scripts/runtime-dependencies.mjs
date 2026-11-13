import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,cp,mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,posix,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
const execute=promisify(execFile);

/** Project the frozen workspace lock into a standalone PRODUCTION-only tree.
 * No npm resolution, root devDependencies or workspace symlinks are imported. */
export function standaloneLock(pkg,lock,workspace){
 const records=lock.packages,output={},tops=new Map();
 if(!records?.[workspace]||lock.lockfileVersion!==3)throw Error('Workspace lock is missing; run npm ci from the repository root.');
 const resolve=(name,from,optional=false)=>{
  let dir=from;
  while(true){
   const key=posix.join(dir,'node_modules',name),record=records[key];
   if(record){if(record.link||!record.version||!record.integrity||!/^https:\/\//.test(record.resolved||''))throw Error('Runtime dependency must be registry-locked: '+name);return key;}
   if(dir==='.')break;dir=posix.dirname(dir);
  }
  if(optional)return null;throw Error('Missing locked runtime dependency: '+name);
 };
 const edges=(manifest,from)=>{
  const required={...manifest.dependencies,...manifest.peerDependencies},optional={...manifest.optionalDependencies};
  for(const [name,meta]of Object.entries(manifest.peerDependenciesMeta||{}))if(meta.optional){optional[name]=required[name];delete required[name];}
  for(const name of Object.keys(optional))delete required[name];
  return [...Object.keys(required).map(name=>[name,resolve(name,from)]),...Object.keys(optional).map(name=>[name,resolve(name,from,true)])].filter(([,key])=>key);
 };
 for(const [name,key]of edges(pkg,workspace))tops.set(name,key);
 let count=0;
 const visit=(key,destination,ancestors,depth=0)=>{
  if(depth>100||++count>2000)throw Error('Runtime dependency graph is too large.');
  const {dev,devOptional,link,...record}=records[key];output[destination]=record;
  for(const [name,child]of edges(record,key))if(ancestors.get(name)!==child){
   const next=new Map(ancestors);next.set(name,child);visit(child,posix.join(destination,'node_modules',name),next,depth+1);
  }
 };
 for(const [name,key]of tops)visit(key,'node_modules/'+name,tops);
 const manifest={name:pkg.name,version:pkg.version||'0.0.0',private:true,type:pkg.type||'module',
  ...(pkg.dependencies?{dependencies:pkg.dependencies}:{}),...(pkg.optionalDependencies?{optionalDependencies:pkg.optionalDependencies}:{}),
  ...(pkg.peerDependencies?{peerDependencies:pkg.peerDependencies}:{}),...(pkg.peerDependenciesMeta?{peerDependenciesMeta:pkg.peerDependenciesMeta}:{})};
 return {manifest,lock:{name:manifest.name,version:manifest.version,lockfileVersion:3,requires:true,packages:{'':manifest,...output}}};
}
export async function runtimePlan(source,{root=dirname(source)}={}){
 const pkg=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
 const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
 return standaloneLock(pkg,lock,relative(root,source).split('\\').join('/'));
}
export async function assertInstallFiles(source,files){
 for(const file of files)try{await access(join(source,file));}catch{throw Error('Missing install source '+file+'; no services were stopped. Prepare the repository first.');}
}
export async function prepareRuntimeDependencies(source,{root=dirname(source),run=execute}={}){
 const plan=await runtimePlan(source,{root}),directory=await mkdtemp(join(tmpdir(),'mobile-chats-deps-'));
 const cleanup=()=>rmSync(directory,{recursive:true,force:true});
 process.once('exit',cleanup);
 const dispose=async()=>{process.removeListener('exit',cleanup);await rm(directory,{recursive:true,force:true});};
 try{
  await writeFile(join(directory,'package.json'),JSON.stringify(plan.manifest));
  await writeFile(join(directory,'package-lock.json'),JSON.stringify(plan.lock));
  const npm=process.platform==='win32'?'npm.cmd':'npm';
  await run(npm,['ci','--omit=dev','--ignore-scripts','--workspaces=false','--no-audit','--no-fund','--prefer-offline'],{cwd:directory,timeout:180000,maxBuffer:4*1024*1024});
  for(const [path,expected]of Object.entries(plan.lock.packages))if(path){
   const actual=JSON.parse(await readFile(join(directory,path,'package.json'),'utf8'));
   if(actual.version!==expected.version)throw Error('Prepared runtime version mismatch.');
  }
  return {directory,nodeModules:join(directory,'node_modules'),lock:plan.lock,dispose};
 }catch{await dispose();throw Error('Could not prepare locked production dependencies; no services were stopped. Run npm ci and check npm registry/cache access.');}
}
export async function installRuntimeDependencies(prepared,target){
 await mkdir(target,{recursive:true});
 const id=randomUUID(),next=join(target,'.node_modules-'+id),current=join(target,'node_modules'),backup=join(target,'.node_modules-old-'+id);
 let moved=false;
 try{
  await cp(prepared.nodeModules,next,{recursive:true,dereference:true});
  try{await rename(current,backup);moved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  try{await rename(next,current);}catch(error){if(moved)await rename(backup,current);throw error;}
  await writeFile(join(target,'package-lock.json'),JSON.stringify(prepared.lock,null,2)+'\n');
 }finally{await rm(next,{recursive:true,force:true});}
 if(moved)await rm(backup,{recursive:true,force:true});
}
