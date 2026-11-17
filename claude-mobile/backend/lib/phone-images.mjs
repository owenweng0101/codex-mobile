import {constants} from 'node:fs';
import {lstat,open,realpath,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {isAbsolute,join,resolve,sep} from 'node:path';

export const PHONE_IMAGE_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|jpeg|webp|gif)$/i;
export const MAX_PHONE_IMAGE_BYTES=10*1024*1024;
export const MAX_PHONE_IMAGES=16;
export const PHONE_IMAGE_ERRORS={
  PHONE_IMAGE_INVALID:'附件无效，请重新上传 PNG/JPEG/WebP/GIF 图片',
  PHONE_IMAGE_MISSING:'图片文件已不存在，请重新上传；这条消息未发送',
  PHONE_IMAGE_UNSAFE:'图片文件不在安全的上传目录中，请重新上传；这条消息未发送',
  PHONE_IMAGE_TOO_LARGE:'图片超过 10MB，请压缩后重新上传；这条消息未发送',
  PHONE_IMAGE_TOO_MANY:'一次最多发送 16 张图片',
  PHONE_IMAGE_UNAVAILABLE:'无法读取上传图片，请重新上传；这条消息未发送',
};
const fault=(code,statusCode=400)=>Object.assign(new Error(PHONE_IMAGE_ERRORS[code]),{code,statusCode});
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const owned=info=>typeof process.getuid!=='function'||info.uid===process.getuid();

function imageType(bytes){
  if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>=6&&/^GIF8[79]a$/.test(bytes.toString('ascii',0,6)))return 'image/gif';
  if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return null;
}
const types={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'};

async function uploadRoot(directory){
  if(typeof directory!=='string'||!isAbsolute(directory)||directory.includes('\0')||directory.split(sep).includes('..'))throw fault('PHONE_IMAGE_UNSAFE');
  const requested=resolve(directory),info=await lstat(requested),path=await realpath(requested);
  // System ancestors such as macOS /var may be aliases; the private uploads
  // directory itself must be owned, non-writable by others and not a symlink.
  if(!info.isDirectory()||info.isSymbolicLink()||!owned(info)||(info.mode&0o022)!==0)throw fault('PHONE_IMAGE_UNSAFE');
  return {requested,path,info};
}
async function assertRoot(root){
  const named=await lstat(root.requested);
  if(!named.isDirectory()||named.isSymbolicLink()||!sameFile(named,root.info)||await realpath(root.requested)!==root.path)throw fault('PHONE_IMAGE_UNSAFE');
}
function sanitized(error){
  if(Object.hasOwn(PHONE_IMAGE_ERRORS,error?.code))return error;
  if(error?.code==='ENOENT')return fault('PHONE_IMAGE_MISSING',404);
  if(['ELOOP','ENOTDIR'].includes(error?.code))return fault('PHONE_IMAGE_UNSAFE');
  return fault('PHONE_IMAGE_UNAVAILABLE');
}

/** Resolve only an authenticated user's opaque upload ID, never a supplied path.
 * Read a bounded, regular, owned file through a no-follow descriptor. Nothing
 * is staged into native/peer uploads, and no URL or credential enters a prompt.
 */
export async function readPhoneImage(id,{uploadsDir}={}){
  let handle;
  try{
    if(typeof id!=='string'||!PHONE_IMAGE_ID.test(id))throw fault('PHONE_IMAGE_INVALID');
    if(!constants.O_NOFOLLOW||!constants.O_NONBLOCK)throw fault('PHONE_IMAGE_UNSAFE');
    const root=await uploadRoot(uploadsDir),path=join(root.path,id),named=await lstat(path);
    if(!named.isFile()||named.isSymbolicLink()||await realpath(path)!==path)throw fault('PHONE_IMAGE_UNSAFE');
    handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=await handle.stat();
    if(!before.isFile()||!sameFile(named,before)||!owned(before)||before.nlink!==1)throw fault('PHONE_IMAGE_UNSAFE');
    if(before.size>MAX_PHONE_IMAGE_BYTES)throw fault('PHONE_IMAGE_TOO_LARGE',413);
    if(!Number.isSafeInteger(before.size)||before.size<=0)throw fault('PHONE_IMAGE_INVALID');
    const buffer=Buffer.alloc(before.size+1);
    let length=0;
    while(length<buffer.length){
      const {bytesRead}=await handle.read(buffer,length,Math.min(64*1024,buffer.length-length),length);
      if(!bytesRead)break;
      length+=bytesRead;
    }
    const after=await handle.stat(),current=await lstat(path);
    if(length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||!current.isFile()||current.isSymbolicLink()||!sameFile(current,after)||await realpath(path)!==path)throw fault('PHONE_IMAGE_UNSAFE');
    await assertRoot(root);
    const bytes=buffer.subarray(0,length),mediaType=types[id.split('.').pop().toLowerCase()];
    if(imageType(bytes)!==mediaType)throw fault('PHONE_IMAGE_INVALID');
    return {id,path,bytes,mediaType,size:length};
  }catch(error){throw sanitized(error);}
  finally{await handle?.close();}
}

export async function phoneImageReferences(ids,{uploadsDir}={}){
  if(!Array.isArray(ids))throw fault('PHONE_IMAGE_INVALID');
  if(ids.length>MAX_PHONE_IMAGES)throw fault('PHONE_IMAGE_TOO_MANY');
  const references=[];
  for(const id of ids){
    const {path,mediaType,size}=await readPhoneImage(id,{uploadsDir});
    references.push({id,path,mediaType,size});
  }
  return references;
}

export function phoneAttachmentNote(paths){
  return '\n\n（手机图片，请用 Read 查看：\n'+paths.map(path=>'- '+JSON.stringify(path)).join('\n')+'\n）';
}

/** New upload names are exclusively created, never allowed to overwrite a link. */
export async function storePhoneImage(bytes,mediaType,{uploadsDir}={}){
  if(!Buffer.isBuffer(bytes)||!bytes.length||imageType(bytes)!==mediaType)throw fault('PHONE_IMAGE_INVALID');
  if(bytes.length>MAX_PHONE_IMAGE_BYTES)throw fault('PHONE_IMAGE_TOO_LARGE',413);
  let handle,path,created;
  try{
    const root=await uploadRoot(uploadsDir),ext=mediaType==='image/jpeg'?'jpg':mediaType.slice('image/'.length);
    if(types[ext]!==mediaType)throw fault('PHONE_IMAGE_INVALID');
    const id=randomUUID()+'.'+ext;path=join(root.path,id);
    handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    created=await handle.stat();
    await handle.writeFile(bytes);await handle.sync();
    const named=await lstat(path);
    if(!named.isFile()||named.isSymbolicLink()||!sameFile(named,created)||named.nlink!==1)throw fault('PHONE_IMAGE_UNSAFE');
    await assertRoot(root);
    return {id,path,mediaType,size:bytes.length};
  }catch(error){
    if(created){try{if(sameFile(await lstat(path),created))await unlink(path);}catch{}}
    throw sanitized(error);
  }finally{await handle?.close();}
}
