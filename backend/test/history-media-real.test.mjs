import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HistoryMedia } from '../history-media.mjs';

// Only self-created AppSupport bytes. No model messages, business history,
// protected-directory probes, App fs service or credential access.
test('real AppSupport raster bytes use verified item path and refuse symlinks/non-raster, then clean fixture',async()=>{
 const base=join(homedir(),'Library/Application Support/CodexMobile/history-media-fixtures');
 await mkdir(base,{recursive:true,mode:0o700});const root=await mkdtemp(join(base,'media-'));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=','base64');
 const reference={threadId:'fixture-thread',turnId:'fixture-turn',itemId:'fixture-image',index:0};
 let item={id:reference.itemId,type:'userMessage',content:[{type:'localImage',path:join(root,'图片.png')}]};
 const access=[];
 const media=new HistoryMedia({core:{call:async(method,params)=>{assert.equal(method,'thread/items/read');assert.deepEqual(params,{threadId:reference.threadId,turnId:reference.turnId,itemIds:[reference.itemId]});return{data:[{turnId:reference.turnId,item}]};}},allowedRoots:[root],ensureAccess:async path=>{assert.equal(path.startsWith(root+'/'),true);access.push(path);}});
 try{
  await writeFile(join(root,'图片.png'),png,{mode:0o600});
  const ready=await media.read(reference);assert.equal(ready.status,'ready');assert.deepEqual(ready.body,png);assert.equal(ready.mime,'image/png');assert.equal(ready.name,'图片.png');assert.equal(ready.headers['Content-Length'],png.length);
  const publicPart=JSON.stringify({...ready,body:undefined});assert.equal(publicPart.includes(root),false);assert.equal(publicPart.includes('data:image'),false);assert.match(ready.headers['Content-Disposition'],/%E5%9B%BE/);
  item={id:reference.itemId,type:'imageGeneration',status:'completed',savedPath:join(root,'图片.png')};assert.equal((await media.read(reference)).status,'ready');
  await symlink(join(root,'图片.png'),join(root,'alias.png'));item={id:reference.itemId,type:'userMessage',content:[{type:'localImage',path:join(root,'alias.png')}]};assert.equal((await media.read(reference)).reason,'UNSAFE_FILE');
  await writeFile(join(root,'pretend.png'),'<html><script>private</script></html>',{mode:0o600});item.content[0].path=join(root,'pretend.png');assert.equal((await media.read(reference)).reason,'UNSUPPORTED_IMAGE_FORMAT');
  item.content[0].path=join(root,'missing.png');assert.equal((await media.read(reference)).reason,'MEDIA_NOT_FOUND');
  assert.equal(access.length,5);
 }finally{await rm(root,{recursive:true,force:true});}
});
