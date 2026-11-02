import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdtemp,readFile,readdir,realpath,rm,stat,writeFile,unlink,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AttachmentStore} from '../attachments.mjs';

const MiB=1024*1024;
const data=(bytes,mime='video/mp4')=>'data:'+mime+';base64,'+bytes.toString('base64');
function ftyp(size=24){
 const bytes=Buffer.alloc(size,0x53);
 bytes.writeUInt32BE(24,0);bytes.write('ftyp',4);bytes.write('isom',8);
 bytes.writeUInt32BE(0,12);bytes.write('isommp42',16);
 return bytes;
}
const ebml=Buffer.from([0x1a,0x45,0xdf,0xa3,0x9f,0x42,0x82,0x84,0x77,0x65,0x62,0x6d]);
async function fixture(t){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'codex-video-upload-')));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 // Every successful video upload must work even with no document extractor.
 return {directory,store:new AttachmentStore({directory,python:join(directory,'no-document-extractor')})};
}
function manifest(inputs){
 const input=inputs.find(i=>i.type==='text');
 assert.ok(input);assert.deepEqual(input.text_elements,[]);
 assert.ok(input.text.startsWith('<codex-mobile-attachments version="1">\n'));
 return JSON.parse(input.text.split('\n')[1]);
}
async function diskHash(path){
 const digest=createHash('sha256');
 for await(const chunk of createReadStream(path))digest.update(chunk);
 return digest.digest('hex');
}

test('actual 102 MiB upload preserves original bytes and SHA, and supplies only an unanalyzed video manifest',async t=>{
 const {directory,store}=await fixture(t),bytes=ftyp(102*MiB);
 // This exceeds the old decoder limit and the old message aggregate cap.
 const expectedHash=createHash('sha256').update(bytes).digest('hex');
 const uploaded=await store.upload({name:'../../原始 " $(echo NO).MP4',dataUrl:data(bytes),requestId:'video-102-mib-original'});
 assert.equal(uploaded.kind,'video');assert.equal(uploaded.extension,'mp4');
 assert.equal(uploaded.mime,'video/mp4');assert.equal(uploaded.size,102*MiB);
 assert.equal(uploaded.textStatus,'not-analyzed');assert.match(uploaded.notice,/尚未分析/);
 assert.equal(uploaded.name,'原始 " $(echo NO).MP4');
 assert.equal(JSON.stringify(uploaded).includes(directory),false);
 for(const key of ['path','textPath','excerpt','extractedCharacters'])assert.equal(key in uploaded,false);
 const local=await store.resolve(uploaded.id);
 assert.equal(local.sha256,expectedHash);assert.equal(await diskHash(local.path),expectedHash);
 assert.equal((await stat(local.path)).size,bytes.length);assert.equal((await stat(local.path)).mode&0o777,0o600);
 assert.equal(local.path,join(directory,uploaded.id+'.file.mp4'));assert.equal(local.textPath,undefined);
 assert.deepEqual((await readdir(directory)).sort(),[uploaded.id+'.file.mp4',uploaded.id+'.json'].sort());
 const persisted=JSON.parse(await readFile(join(directory,uploaded.id+'.json'),'utf8'));
 assert.equal(persisted.sha256,expectedHash);assert.equal(persisted.textStatus,'not-analyzed');
 assert.equal(persisted.extractedCharacters,undefined);
 // Reopen from disk to ensure resolution does not depend on in-memory state or a text companion.
 const reopened=new AttachmentStore({directory});
 assert.deepEqual(await reopened.metadata(uploaded.id),uploaded);
 const inputs=await reopened.inputs([uploaded.id]);assert.equal(inputs.length,1);assert.equal(inputs[0].type,'text');
 const entry=manifest(inputs).attachments[0];
 assert.equal(entry.kind,'video');assert.equal(entry.localPath,local.path);assert.equal(entry.size,bytes.length);
 assert.equal(entry.textRepresentation,'original-video-file');assert.equal(entry.textStatus,'not-analyzed');
 assert.match(entry.notice,/尚未分析/);
 for(const key of ['excerpt','textPath','extractedCharacters','excerptTruncated'])assert.equal(key in entry,false);
 const download=await reopened.download(uploaded.id);
 assert.equal(download.path,local.path);assert.equal(download.headers['Content-Type'],'video/mp4');
 assert.equal(download.headers['Content-Length'],bytes.length);assert.match(download.headers['Content-Disposition'],/^attachment;/);
 assert.equal(download.headers['X-Content-Type-Options'],'nosniff');
});

test('MP4, MOV, M4V and WebM resolve with canonical video metadata and never extract documents',async t=>{
 const {directory,store}=await fixture(t);
 for(const [extension,mime,bytes,declared]of [
  ['mp4','video/mp4',ftyp(),'video/mp4'],
  ['mov','video/quicktime',ftyp(),'video/quicktime'],
  ['m4v','video/x-m4v',ftyp(),'video/mp4'],
  ['webm','video/webm',ebml,'video/webm'],
  ['mp4','video/mp4',ftyp(),'application/octet-stream'],
  ['mov','video/quicktime',ftyp(),''],
 ]){
  const uploaded=await store.upload({name:'clip.'+extension,dataUrl:data(bytes,declared)});
  const local=await store.resolve(uploaded.id);
  assert.equal(local.kind,'video');assert.equal(local.mime,mime);assert.equal(local.extension,extension);
  assert.deepEqual(await readFile(local.path),bytes);assert.equal(local.textPath,undefined);
  assert.deepEqual(await store.metadata(uploaded.id),uploaded);
  assert.equal((await store.download(uploaded.id)).headers['Content-Type'],mime);
 }
 assert.equal((await readdir(directory)).some(name=>name.endsWith('.text.txt')),false);
});

test('video requests are idempotent concurrently and after reopening, and reject changed bytes',async t=>{
 const {directory,store}=await fixture(t),payload={name:'clip.mov',dataUrl:data(ftyp(),'video/quicktime'),requestId:'video-stable-request'};
 const [a,b]=await Promise.all([store.upload(payload),store.upload(payload)]);
 assert.deepEqual(a,b);assert.deepEqual(await store.upload(payload),a);
 const reopened=new AttachmentStore({directory});assert.deepEqual(await reopened.upload(payload),a);
 const changed=ftyp();changed[23]^=1;
 await assert.rejects(reopened.upload({...payload,dataUrl:data(changed,'video/quicktime')}),/不能更换文件/);
 for(const requestId of ['short','bad request id',123])await assert.rejects(store.upload({...payload,requestId}),/请求标识无效/);
 assert.equal(await diskHash((await reopened.resolve(a.id)).path),createHash('sha256').update(ftyp()).digest('hex'));
 assert.deepEqual((await readdir(directory)).sort(),[a.id+'.file.mov',a.id+'.json'].sort());
});

test('video signatures, extension/container combinations and declared MIME must agree',async t=>{
 const {directory,store}=await fixture(t),badBox=ftyp();badBox.writeUInt32BE(1000,0);
 for(const [name,bytes,mime]of [
  ['fake.mp4',Buffer.from('not a video'),'video/mp4'],
  ['truncated.mov',Buffer.from([0,0,0,16,102,116,121,112]),'video/quicktime'],
  ['bad-box.mp4',badBox,'video/mp4'],
  ['mismatch.mp4',ebml,'video/mp4'],
  ['mismatch.webm',ftyp(),'video/webm'],
  ['truncated.webm',ebml.subarray(0,3),'video/webm'],
  ['spoof.mp4',ftyp(),'image/png'],
  ['spoof.mp4',ftyp(),'text/plain'],
  ['wrong-mime.mov',ftyp(),'video/webm'],
  ['unsupported.avi',ftyp(),'video/mp4'],
 ])await assert.rejects(store.upload({name,dataUrl:data(bytes,mime)}),/格式不匹配|不支持/);
 assert.deepEqual(await readdir(directory),[]);
});

test('base64 decoder rejects malformed payloads, padding and noncanonical pad bits without writing files',async t=>{
 const {directory,store}=await fixture(t);
 for(const encoded of ['', '!!!!','Zg=','Zg===','Z=g=','Zg==AAAA','====','Zh==','Zm9=','Zg==\n','Zg-_','Zg== ', 'éAAA']){
  await assert.rejects(store.upload({name:'bad.txt',dataUrl:'data:text/plain;base64,'+encoded}),/编码无效/);
 }
 for(const value of [null,123,{},'plain text','data:video/mp4,AAAA','data:video/mp4;base64;AAAA']){
  await assert.rejects(store.upload({name:'bad.mp4',dataUrl:value}),/编码无效/);
 }
 assert.deepEqual(await readdir(directory),[]);
 // Exercise all three valid padding cases as well as generic/empty MIME.
 for(const value of ['f','fo','foo']){
  const a=await store.upload({name:'valid.txt',dataUrl:data(Buffer.from(value),'')});
  assert.equal(manifest(await store.inputs([a.id])).attachments[0].excerpt,value);
 }
});

// Generate canonical large payloads without also holding an equally large raw fixture.
function sizedData(size){
 const prefix=ftyp().toString('base64'),tail=size%3===1?'AA==':size%3===2?'AAA=':'';
 return 'data:video/mp4;base64,'+prefix+'A'.repeat(4*Math.ceil(size/3)-prefix.length-tail.length)+tail;
}
test('video decoder accepts exactly 256 MiB and rejects 256 MiB + 1 before storage',async t=>{
 const {store}=await fixture(t);let stored=0;
 // Boundary validation is real decoding and hashing; the 102 MiB test covers actual disk storage.
 store.store=async(meta,bytes)=>{stored++;assert.equal(bytes.length,256*MiB);return store.public(meta)};
 assert.equal((await store.upload({name:'max.mp4',dataUrl:sizedData(256*MiB)})).size,256*MiB);
 // The +1 case has the same encoded length, so it must account for padding, not just URL length.
 await assert.rejects(store.upload({name:'over.mp4',dataUrl:sizedData(256*MiB+1)}),/256MiB/);
 assert.equal(stored,1);
});

test('image 8 MiB and ordinary file 20 MiB limits remain enforced at their boundaries',async t=>{
 const {store}=await fixture(t),png=Buffer.alloc(8*MiB);
 Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
 const image=await store.upload({name:'limit.png',dataUrl:data(png,'image/png')});assert.equal(image.size,8*MiB);
 assert.equal((await store.inputs([image.id]))[0].type,'localImage');
 await assert.rejects(store.upload({name:'over.png',dataUrl:data(Buffer.concat([png,Buffer.from([0])]),'image/png')}),/8MB/);
 const text=await store.upload({name:'limit.txt',dataUrl:data(Buffer.alloc(20*MiB,65),'text/plain')});assert.equal(text.size,20*MiB);
 await assert.rejects(store.upload({name:'over.txt',dataUrl:data(Buffer.alloc(20*MiB+1,65),'text/plain')}),/20MB/);
});

test('message limits retain 60 MiB nonvideo and 256 MiB total, six distinct IDs, and mixed inputs',async t=>{
 const {store}=await fixture(t);
 const video=await store.upload({name:'clip.webm',dataUrl:data(ebml,'video/webm')});
 const document=await store.upload({name:'notes.txt',dataUrl:data(Buffer.from('VIDEO_CONTEXT'),'text/plain')});
 const image=await store.upload({name:'frame.png',dataUrl:data(Buffer.from([137,80,78,71,13,10,26,10]),'image/png')});
 const mixed=await store.inputs([image.id,video.id,document.id]);
 assert.equal(mixed[0].type,'localImage');
 assert.deepEqual(manifest(mixed).attachments.map(a=>a.kind),['video','text']);
 assert.equal(manifest(mixed).attachments[1].excerpt,'VIDEO_CONTEXT');
 await assert.rejects(store.inputs([video.id,video.id]),/不同附件/);
 await assert.rejects(store.inputs(Array.from({length:7},(_,i)=>String(i))),/最多添加6/);
 // Isolate aggregate arithmetic with resolved records; no huge fixture files are needed here.
 const originalResolve=store.resolve.bind(store),v=await originalResolve(video.id),d=await originalResolve(document.id);
 let records;
 store.resolve=async id=>({...records[Number(id)],id});
 records=Array.from({length:3},()=>({...d,size:20*MiB}));
 assert.equal(manifest(await store.inputs(['0','1','2'])).attachments.length,3);
 records.push({...d,size:1});await assert.rejects(store.inputs(['0','1','2','3']),/60MB/);
 records=[{...v,size:196*MiB},...Array.from({length:3},()=>({...d,size:20*MiB}))];
 assert.equal(manifest(await store.inputs(['0','1','2','3'])).attachments.length,4);
 records[0].size++;await assert.rejects(store.inputs(['0','1','2','3']),/256MiB/);
 records=[{...v,size:1},{...d,size:60*MiB+1}];await assert.rejects(store.inputs(['0','1']),/60MB/);
 records=[{...v,size:128*MiB},{...v,size:128*MiB}];
 assert.equal(manifest(await store.inputs(['0','1'])).attachments.length,2);
 records[1].size++;await assert.rejects(store.inputs(['0','1']),/256MiB/);
});

test('video resolution rejects inconsistent metadata, changed size and symlink substitutions',async t=>{
 const {directory,store}=await fixture(t),a=await store.upload({name:'clip.mp4',dataUrl:data(ftyp())});
 const metadataPath=join(directory,a.id+'.json'),original=await readFile(metadataPath,'utf8'),meta=JSON.parse(original);
 for(const change of [{kind:'document'},{kind:'image'},{mime:'text/html'},{extension:'txt'},{extension:'avi'}]){
  await writeFile(metadataPath,JSON.stringify({...meta,...change}));
  await assert.rejects(store.resolve(a.id),/元信息无效/);
 }
 await writeFile(metadataPath,original);const local=await store.resolve(a.id);
 await writeFile(local.path,Buffer.concat([ftyp(),Buffer.from([0])]));await assert.rejects(store.resolve(a.id),/内容已发生变化/);
 const outside=join(directory,'substitute.mp4');await writeFile(outside,ftyp());await unlink(local.path);await symlink(outside,local.path);
 await assert.rejects(store.resolve(a.id),/文件无效/);
});
