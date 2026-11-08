import { mkdir, open, writeFile, rename, readdir, stat, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Private, bounded snapshots of images that have actually been viewed. Keys
// include the verified message AND source, so edits cannot reuse stale bytes.
export class ImageSnapshots {
 constructor({directory,maxBytes=256*1024*1024,maxImageBytes=20*1024*1024}={}){
  this.directory=directory;this.maxBytes=maxBytes;this.maxImageBytes=maxImageBytes;this.serial=Promise.resolve();
 }
 path(reference,source){return join(this.directory,digest(JSON.stringify([reference,source]))+'.image');}
 async get(reference,source){
  let file;
  try{
   file=await open(this.path(reference,source),constants.O_RDONLY|constants.O_NOFOLLOW);
   const info=await file.stat();if(!info.isFile()||info.size>this.maxImageBytes+65||info.size<66)return null;
   const data=await file.readFile(),bytes=data.subarray(65);
   if(data[64]!==10||digest(bytes)!==data.subarray(0,64).toString())return null;
   return bytes;
  }catch{return null;}finally{await file?.close();}
 }
 put(reference,source,bytes){
  if(bytes.length>this.maxImageBytes||bytes.length+65>this.maxBytes)return Promise.resolve();
  const work=async()=>{
   let temporary;
   try{
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const path=this.path(reference,source);temporary=path+'.'+randomUUID()+'.tmp';
    await writeFile(temporary,Buffer.concat([Buffer.from(digest(bytes)+'\n'),bytes]),{mode:0o600,flag:'wx'});
    await rename(temporary,path);temporary=null;
    const files=await Promise.all((await readdir(this.directory)).filter(name=>/^[a-f0-9]{64}\.image$/.test(name)).map(async name=>{const path=join(this.directory,name),info=await stat(path);return{path,size:info.size,time:info.mtimeMs};}));
    let total=files.reduce((n,f)=>n+f.size,0);
    for(const file of files.sort((a,b)=>a.time-b.time)){if(total<=this.maxBytes)break;await rm(file.path,{force:true});total-=file.size;}
   }catch{/* A full/unavailable disk must not prevent delivery of the original. */}
   finally{if(temporary)await rm(temporary,{force:true}).catch(()=>{});}
  };
  const pending=this.serial.then(work);this.serial=pending.catch(()=>{});return pending;
 }
}
