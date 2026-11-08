import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImageSnapshots} from '../image-snapshots.mjs';
import {HistoryMedia} from '../history-media.mjs';
import {nativeImageRoots} from '../native-media.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=','base64');
const ref={threadId:'t',turnId:'u',itemId:'i',index:0};
test('viewed image survives source removal and service restart; exact item, source and permission remain required',async t=>{
 const root=await mkdtemp(join(tmpdir(),'image-snapshot-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'outside-workspace','image.png'),directory=join(root,'cache');
 const {mkdir}=await import('node:fs/promises');await mkdir(join(root,'outside-workspace'));await writeFile(path,png);
 let item={id:'i',type:'agentMessage',text:`| image |\n|---|\n| ![screenshot](${path}) |`},permitted=true;
 const create=()=>new HistoryMedia({core:{call:async(_m,p)=>({data:p.itemIds[0]===item.id?[{turnId:'u',item}]:[]})},allowedRoots:[],ensureAccess:async()=>permitted,resolveRoots:nativeImageRoots,snapshots:new ImageSnapshots({directory})});
 assert.equal((await create().read(ref)).status,'ready');await rm(path);
 assert.deepEqual((await create().read(ref)).body,png);
 assert.equal((await create().read({...ref,itemId:'foreign'})).reason,'ITEM_NOT_FOUND');
 permitted=false;assert.equal((await create().read(ref)).reason,'PERMISSION_REQUIRED');permitted=true;
 item={...item,text:`![edited](${path}.new)`};assert.equal((await create().read(ref)).reason,'MEDIA_NOT_FOUND');
});
test('snapshots enforce disk budget and reject corruption; failed storage does not break image delivery',async t=>{
 const root=await mkdtemp(join(tmpdir(),'image-snapshot-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new ImageSnapshots({directory:root,maxBytes:150});await store.put(ref,'one',png);await store.put(ref,'two',png);
 assert.equal((await readdir(root)).length,1);assert.equal(await store.get(ref,'one'),null);assert.deepEqual(await store.get(ref,'two'),png);
 const file=store.path(ref,'two'),bytes=await readFile(file);bytes[bytes.length-1]^=1;await writeFile(file,bytes);assert.equal(await store.get(ref,'two'),null);
 const blocked=join(root,'not-a-directory');await writeFile(blocked,'x');const broken=new ImageSnapshots({directory:blocked});await broken.put(ref,'x',png);assert.equal(await broken.get(ref,'x'),null);
});
