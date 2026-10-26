import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AttachmentStore,serveAttachment} from '../attachments.mjs';

test('authenticated attachment HTTP handler distinguishes public metadata from source downloads',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'codex-attachment-http-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=new AttachmentStore({directory}),privateText='PRIVATE_DOCUMENT_CONTENT_3497';
 const meta=await store.upload({name:'资料.txt',dataUrl:'data:text/plain;base64,'+Buffer.from(privateText).toString('base64')});
 let downloads=0,metadataReads=0;const download=store.download.bind(store),metadata=store.metadata.bind(store);
 store.download=async id=>{downloads++;return download(id)};store.metadata=async id=>{metadataReads++;return metadata(id)};
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.headers.authorization!=='Bearer fixture-only'){res.writeHead(401);res.end();return;}
  if(req.method!=='GET'||url.pathname!=='/api/attachment'){res.writeHead(404);res.end();return;}
  try{await serveAttachment(store,url.searchParams,res)}catch(error){res.writeHead(404,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}))}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
 const url='http://127.0.0.1:'+server.address().port+'/api/attachment?id='+meta.id,headers={authorization:'Bearer fixture-only'};
 const unauthorized=await fetch(url+'&meta=1');assert.equal(unauthorized.status,401);assert.equal(metadataReads,0);assert.equal(downloads,0);
 for(let reload=0;reload<2;reload++){
  const response=await fetch(url+'&meta=1',{headers});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^application\/json/);assert.equal(response.headers.get('cache-control'),'no-store');
  const restored=await response.json();assert.deepEqual(restored,meta);assert.equal(JSON.stringify(restored).includes(privateText),false);assert.equal(JSON.stringify(restored).includes(directory),false);assert.equal('path' in restored,false);
 }
 assert.equal(metadataReads,2);assert.equal(downloads,0);
 const binary=await fetch(url,{headers});assert.equal(binary.status,200);assert.equal(await binary.text(),privateText);assert.match(binary.headers.get('content-disposition'),/^attachment;/);assert.equal(downloads,1);
 const missing=await fetch(url.replace(meta.id,'a'.repeat(48))+'&meta=1',{headers});assert.equal(missing.status,404);
});
