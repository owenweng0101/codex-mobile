import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAttachmentUploadServices} from '../attachment-upload.mjs';
const MiB=1024*1024;
test('102MiB video chunk transfer is exact, retryable and scoped',async()=>{
 const bytes=Buffer.alloc(102*MiB,42);bytes.write('ftyp',4);
 const digest=createHash('sha256').update(bytes).digest('hex'),id='a'.repeat(48);let posts=0,scopes=0;
 const service=createAttachmentUploadServices({scope:()=>{scopes++;},api:{post:async(path,body)=>{posts++;assert.equal(path,'/api/upload');const raw=Buffer.from(body.dataUrl.slice(body.dataUrl.indexOf(',')+1),'base64');assert.equal(createHash('sha256').update(raw).digest('hex'),digest);return{id,name:body.name,mime:'video/mp4',size:raw.length,url:'/api/attachment?id='+id};}}});
 try{
 const identity={workspacePath:'/workspace',sessionId:'draft',uploadId:'video102'};
 const chunkSize=384*1024,totalChunks=Math.ceil(bytes.length/chunkSize);
 await service.attachmentBeginV4({...identity,fileName:'camera.mp4',mime:'video/mp4',totalBytes:bytes.length,totalChunks,checksum:'sha256:'+digest});
 for(let chunkIndex=0;chunkIndex<totalChunks;chunkIndex++){const chunk={...identity,chunkIndex,dataBase64:bytes.subarray(chunkIndex*chunkSize,(chunkIndex+1)*chunkSize).toString('base64')};await service.attachmentChunkV4(chunk);if(chunkIndex===2)assert.equal((await service.attachmentChunkV4(chunk)).nextChunkIndex,3);}
 const committed=await service.attachmentCommitV4(identity);assert.deepEqual(await service.attachmentCommitV4(identity),committed);assert.equal(posts,1);assert(scopes>totalChunks);assert.equal((await service.resolveAttachment({...identity,ref:committed.ref})).id,id);
 await assert.rejects(service.resolveAttachment({...identity,workspacePath:'/foreign',ref:committed.ref}),/未在当前工作区/);
 await assert.rejects(service.attachmentBeginV4({...identity,uploadId:'too-big',fileName:'big.mp4',mime:'video/mp4',totalBytes:256*MiB+1,totalChunks:1024,checksum:'sha256:'+digest}),/256MB/);
 }finally{service.dispose();}
});
