import {constants} from 'node:fs';
import {lstat,mkdir,open,realpath,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {basename,dirname,extname,isAbsolute,join,parse,resolve,sep} from 'node:path';

const MAX_BYTES=30*1024*1024;
const MAX_FILES=16;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif',
  '.webp':'image/webp','.avif':'image/avif','.heic':'image/heic','.heif':'image/heif',
  '.bmp':'image/bmp','.tif':'image/tiff','.tiff':'image/tiff','.svg':'image/svg+xml'};
const writes=new Map();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

function absolutePath(value,label){
  if(typeof value!=='string'||!isAbsolute(value)||value.includes('\0')||value.split(sep).includes('..')){
    throw new Error(`${label} must be an absolute path without parent traversal`);
  }
  return resolve(value);
}

// Match Claude's sanitizePeerFileName, keeping the whole spool basename below NAME_MAX.
function safeName(name){
  const clean=basename(name).replace(/[^a-zA-Z0-9._-]/g,'_')||'attachment';
  const dot=clean.lastIndexOf('.');
  const extension=dot>0&&clean.length-dot<=16?clean.slice(dot):'';
  const stem=extension?clean.slice(0,dot):clean;
  return stem.slice(0,200-extension.length)+extension;
}

function anchored(directory,name){
  return process.platform==='linux'?`/proc/self/fd/${directory.fd}/${name}`:join(directory.directoryPath,name);
}

async function assertDirectoryStable(directory){
  if(process.platform==='linux')return;
  const path=directory.directoryPath;
  const [named,held,canonical]=await Promise.all([lstat(path),directory.stat(),realpath(path)]);
  if(!named.isDirectory()||named.isSymbolicLink()||canonical!==path||named.dev!==held.dev||named.ino!==held.ino){
    throw new Error('Attachment directory path changed or contains a symlink');
  }
}

/** Linux anchors child access to a directory fd; Darwin verifies canonical paths and inode identity. */
async function openDirectory(path,{create=false}={}){
  if(!constants.O_NOFOLLOW||!constants.O_DIRECTORY||process.platform==='win32'){
    throw new Error('Safe attachment staging requires nofollow directory descriptors');
  }
  const root=parse(path).root;
  let current=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  current.directoryPath=root;
  try{
    for(const component of path.slice(root.length).split(sep).filter(Boolean)){
      await assertDirectoryStable(current);
      const child=anchored(current,component);
      if(create){
        try{await mkdir(child,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
      }
      const named=await lstat(child);
      if(!named.isDirectory()||named.isSymbolicLink())throw new Error('Attachment directory must not be a symlink');
      const next=await open(child,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      next.directoryPath=join(current.directoryPath,component);
      try{
        const held=await next.stat();
        if(named.dev!==held.dev||named.ino!==held.ino)throw new Error('Attachment directory changed while opening');
        await assertDirectoryStable(current);
        await assertDirectoryStable(next);
      }catch(error){await next.close();throw error;}
      const previous=current;current=next;await previous.close();
    }
    return current;
  }catch(error){await current.close();throw error;}
}

async function boundedRead(path,{staged=false}={}){
  // NONBLOCK prevents FIFO input from hanging before the regular-file check.
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=await handle.stat();
    if(!before.isFile())throw new Error('Attachment must be a regular file');
    if(staged&&(before.nlink!==1||before.uid!==process.getuid?.())){
      throw new Error('Existing staged attachment must be an owned file with one link');
    }
    if(before.size>MAX_BYTES)throw new Error('Attachment exceeds the native 30 MiB limit');
    const bytes=Buffer.alloc(before.size+1);
    let length=0;
    while(length<bytes.length){
      const {bytesRead}=await handle.read(bytes,length,Math.min(64*1024,bytes.length-length),length);
      if(!bytesRead)break;
      length+=bytesRead;
    }
    const after=await handle.stat();
    if(length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs){
      throw new Error('Attachment changed while being read');
    }
    const named=await lstat(path);
    if(!named.isFile()||named.dev!==after.dev||named.ino!==after.ino){
      throw new Error('Attachment path changed while being read');
    }
    return {bytes:bytes.subarray(0,length),info:after};
  }finally{await handle.close();}
}

async function serialize(key,action){
  const previous=writes.get(key);
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  writes.set(key,pending);
  if(previous)await previous;
  try{return await action();}finally{
    release();
    if(writes.get(key)===pending)writes.delete(key);
  }
}

async function stageFile(directory,name,bytes,sha256){
  await assertDirectoryStable(directory);
  const target=anchored(directory,name);
  let handle;
  try{
    handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    const existing=await boundedRead(target,{staged:true});
    if(existing.bytes.length!==bytes.length||digest(existing.bytes)!==sha256){
      throw new Error('Existing staged attachment has different content; refusing to overwrite');
    }
    if((existing.info.mode&0o777)!==0o600)throw new Error('Existing staged attachment must have mode 0600');
    await assertDirectoryStable(directory);
    return;
  }
  const created=await handle.stat();
  try{
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const named=await lstat(target);
    if(!named.isFile()||named.dev!==created.dev||named.ino!==created.ino||named.nlink!==1){
      throw new Error('Staged attachment path changed while being written');
    }
    await assertDirectoryStable(directory);
  }catch(error){
    // Remove only the file this invocation created, never a substituted retry file.
    try{
      const named=await lstat(target);
      if(named.dev===created.dev&&named.ino===created.ino)await unlink(target);
    }catch{}
    throw error;
  }finally{await handle.close();}
}

/**
 * Stage absolute local file paths for Claude's native file_attachments protocol.
 * The HTTP layer retains its 10 MiB upload policy; this layer enforces native limits.
 * Callers must supply canonical directory paths (symlink components are refused).
 * Claude copies these files into its own uploads directory and may remove the spool copies.
 */
export async function stagePeerAttachments(files,{requestId,spoolDir=join(homedir(),'.claude','file-transfers')}={}){
  if(!Array.isArray(files)||files.length>MAX_FILES)throw new Error('At most 16 attachment files are allowed');
  if(typeof requestId!=='string'||!UUID.test(requestId))throw new Error('Attachment requestId must be a UUID');
  const paths=files.map(file=>absolutePath(file,'Attachment'));
  const spool=absolutePath(spoolDir,'Attachment spool');
  if(paths.length===0)return [];
  const directory=await openDirectory(spool,{create:true});
  try{
    const info=await directory.stat();
    if(info.uid!==process.getuid?.())throw new Error('Attachment spool must belong to the current user');
    await directory.chmod(0o700);
    await assertDirectoryStable(directory);
    const descriptors=[];
    for(const file of paths){
      const parent=await openDirectory(dirname(file));
      let bytes;
      try{
        await assertDirectoryStable(parent);
        ({bytes}=await boundedRead(anchored(parent,basename(file))));
        await assertDirectoryStable(parent);
      }finally{await parent.close();}
      const sha256=digest(bytes),file_name=basename(file);
      const name=`${sha256.slice(0,8)}-${requestId.toLowerCase()}-${safeName(file_name)}`;
      await serialize(`${info.dev}:${info.ino}:${name}`,()=>stageFile(directory,name,bytes,sha256));
      descriptors.push({path:join(spool,name),file_name,file_size:bytes.length,sha256,
        media_type:MIME[extname(file_name).toLowerCase()]??'application/octet-stream'});
    }
    return descriptors;
  }finally{await directory.close();}
}
