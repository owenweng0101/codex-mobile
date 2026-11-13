import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,link,lstat,mkdir,mkdtemp,open,readFile,readdir,realpath,rm,stat,symlink,unlink,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {stagePeerAttachments} from '../backend/lib/desktop-attachments.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=await realpath(await mkdtemp(join(tmpdir(),'desktop-attachments-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const spoolDir=join(root,'file-transfers'),requestId=randomUUID();
  const source=async(name='photo.png',bytes=Buffer.from('local-image-fixture'))=>{
    const path=join(root,name);await writeFile(path,bytes);return path;
  };
  return {root,spoolDir,requestId,source};
}

test('native descriptor preserves bytes, MIME and original name; spool stays private and outside cwd',async t=>{
  const f=await fixture(t),bytes=Buffer.from([0,255,137,80,78,71]),file=await f.source('图 片.PNG',bytes);
  const [item]=await stagePeerAttachments([file],f);
  assert.deepEqual(item,{path:join(f.spoolDir,`${hash(bytes).slice(0,8)}-${f.requestId}-___.PNG`),
    file_name:'图 片.PNG',file_size:bytes.length,sha256:hash(bytes),media_type:'image/png'});
  assert.deepEqual(await readFile(item.path),bytes);
  assert.deepEqual(await readFile(file),bytes);
  assert.equal((await stat(f.spoolDir)).mode&0o777,0o700);
  assert.equal((await stat(item.path)).mode&0o777,0o600);
  assert.equal(await realpath(f.spoolDir),f.spoolDir);
});

test('same request retries reuse the identical descriptor and inode without overwriting',async t=>{
  const f=await fixture(t),file=await f.source();
  const first=await stagePeerAttachments([file],{...f,requestId:f.requestId.toUpperCase()});
  const before=await stat(first[0].path);
  assert.deepEqual(await stagePeerAttachments([file],f),first);
  const after=await stat(first[0].path);
  assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);
  assert.equal((await readdir(f.spoolDir)).length,1);
  await unlink(first[0].path); // Native receiver consumes the spool file.
  assert.deepEqual(await stagePeerAttachments([file],f),first);
  const [other]=await stagePeerAttachments([file],{...f,requestId:randomUUID()});
  assert.notEqual(other.path,first[0].path);
});

test('concurrent retries cannot observe or replace an incompletely written transfer',async t=>{
  const f=await fixture(t),file=await f.source('photo.webp',Buffer.alloc(1024*1024,9));
  const results=await Promise.all(Array.from({length:4},()=>stagePeerAttachments([file],f)));
  for(const result of results)assert.deepEqual(result,results[0]);
  assert.equal((await readdir(f.spoolDir)).length,1);
});

test('existing content conflict is rejected without modifying either file',async t=>{
  const f=await fixture(t),file=await f.source(),[item]=await stagePeerAttachments([file],f);
  // Same length forces the full hash check, rather than just checking size/hash8 in the path.
  const conflicting=Buffer.alloc(item.file_size,120);await writeFile(item.path,conflicting);
  await assert.rejects(stagePeerAttachments([file],f),/different content/);
  assert.deepEqual(await readFile(item.path),conflicting);
  assert.equal(hash(await readFile(file)),item.sha256);
});

test('rejects source symlinks, directory symlinks and non-regular input',async t=>{
  const f=await fixture(t),file=await f.source();
  const alias=join(f.root,'linked.png');await symlink(file,alias);
  await assert.rejects(stagePeerAttachments([alias],f));
  const folder=join(f.root,'actual');await mkdir(folder);await writeFile(join(folder,'photo.png'),'private');
  const linkedFolder=join(f.root,'linked-folder');await symlink(folder,linkedFolder);
  await assert.rejects(stagePeerAttachments([join(linkedFolder,'photo.png')],f));
  await assert.rejects(stagePeerAttachments([folder],f),/regular file/);
});

test('rejects a symlink spool, symlink ancestor and staged-file symlink without touching targets',async t=>{
  const f=await fixture(t),file=await f.source(),outside=join(f.root,'outside');await mkdir(outside);
  await symlink(outside,f.spoolDir);
  await assert.rejects(stagePeerAttachments([file],f));
  assert.deepEqual(await readdir(outside),[]);
  await unlink(f.spoolDir);
  const ancestor=join(f.root,'alias');await symlink(outside,ancestor);
  await assert.rejects(stagePeerAttachments([file],{...f,spoolDir:join(ancestor,'file-transfers')}));
  assert.deepEqual(await readdir(outside),[]);
  const [item]=await stagePeerAttachments([file],f);await unlink(item.path);
  const victim=join(outside,'victim');await writeFile(victim,'do not modify');await symlink(victim,item.path);
  await assert.rejects(stagePeerAttachments([file],f));
  assert.equal(await readFile(victim,'utf8'),'do not modify');
  assert.equal((await lstat(item.path)).isSymbolicLink(),true);
});

test('rejects a hardlinked existing transfer and unsafe existing file permissions',async t=>{
  const f=await fixture(t),file=await f.source(),[item]=await stagePeerAttachments([file],f);
  await unlink(item.path);await link(file,item.path);
  await assert.rejects(stagePeerAttachments([file],f),/one link/);
  await unlink(item.path);await stagePeerAttachments([file],f);
  await chmod(item.path,0o644);
  await assert.rejects(stagePeerAttachments([file],f),/0600/);
});

test('native 30 MiB limit is independent of the HTTP 10 MiB policy; oversize sparse files fail boundedly',async t=>{
  const f=await fixture(t),file=await f.source('large.jpg',Buffer.alloc(10*1024*1024+1,7));
  assert.equal((await stagePeerAttachments([file],f))[0].file_size,10*1024*1024+1);
  const handle=await open(join(f.root,'too-large.png'),'w');
  try{await handle.truncate(30*1024*1024+1);}finally{await handle.close();}
  await assert.rejects(stagePeerAttachments([join(f.root,'too-large.png')],f),/30 MiB/);
  assert.equal((await readdir(f.spoolDir)).length,1);
});

test('validates UUID, file count and absolute paths before creating any spool',async t=>{
  const f=await fixture(t);
  for(const requestId of ['',undefined,'../../escape','not-a-uuid']){
    await assert.rejects(stagePeerAttachments([],{...f,requestId}),/UUID/);
  }
  await assert.rejects(stagePeerAttachments(Array(17).fill('/file'),f),/16/);
  await assert.rejects(stagePeerAttachments(['relative.png'],f),/absolute path/);
  await assert.rejects(stagePeerAttachments([join(f.root,'x')+'/../photo.png'],f),/parent traversal/);
  await assert.rejects(stagePeerAttachments(['bad\0name'],f),/absolute path/);
  await assert.rejects(stagePeerAttachments([],{...f,spoolDir:'relative'}),/absolute path/);
  assert.deepEqual(await stagePeerAttachments([],f),[]);
  await assert.rejects(stat(f.spoolDir),{code:'ENOENT'});
});

test('accepts exactly sixteen files, preserves order, and bounds sanitized names',async t=>{
  const f=await fixture(t),files=[];
  for(let i=0;i<16;i++)files.push(await f.source(`image-${i}.gif`,Buffer.from([i])));
  const items=await stagePeerAttachments(files,f);
  assert.equal(items.length,16);
  assert.deepEqual(items.map(item=>item.file_name),files.map(file=>basename(file)));
  assert.ok(items.every(item=>item.media_type==='image/gif'));
  const file=await f.source('a'.repeat(225)+'.png');
  const [item]=await stagePeerAttachments([file],f);
  assert.ok(Buffer.byteLength(basename(item.path))<=255);
  assert.ok(item.path.endsWith('.png'));
});
