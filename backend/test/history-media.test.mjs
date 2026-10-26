import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryMedia, projectHistoryMedia, assistantImageReferences, MEDIA_REASONS } from '../history-media.mjs';

const PNG=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const dataUrl=(bytes=PNG,mime='image/png')=>'data:'+mime+';base64,'+bytes.toString('base64');
const ref={threadId:'thread-one',turnId:'turn-one',itemId:'item-one',index:0};
const user=content=>({id:'item-one',type:'userMessage',content});

test('assistant Markdown images are exact item references, not arbitrary paths or code examples',async()=>{
 const item={id:'item-one',type:'agentMessage',text:'文本 /allowed/root/other.png\n\n`![代码](/allowed/root/code.png)`\n\n![实际图片](/allowed/root/image.png)\n\n```\n![代码](/allowed/root/code.png)\n```\n\n![远程](https://example.com/a.png)'};
 const images=assistantImageReferences(item);assert.equal(images.length,1);assert.equal(images[0].path,'/allowed/root/image.png');
 assert.equal(item.text.slice(images[0].start,images[0].end),'![实际图片](/allowed/root/image.png)');
 assert.equal((await fixture(item).manager.read(ref)).status,'ready');
 assert.equal((await fixture({...item,text:'![图片](/elsewhere/image.png)'}).manager.read(ref)).reason,'PATH_NOT_ALLOWED');
 assert.equal((await fixture(item).manager.read({...ref,index:1})).reason,'INDEX_OUT_OF_RANGE');
});
function fixture(item=user([{type:'image',url:dataUrl()}]),options={}){
 const calls=[],access=[],operations=[];
 const bytes=options.bytes||PNG;
 const info={uid:501,dev:1,ino:44,size:bytes.length,mtimeMs:1,ctimeMs:1,isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false};
 let closed=false;
 const io={
  lstat:async path=>{operations.push(['lstat',path]);return options.symlink?{...info,isSymbolicLink:()=>true}:info;},
  realpath:async path=>{operations.push(['realpath',path]);return options.escape&&path.endsWith('image.png')?'/elsewhere/image.png':path;},
  open:async(path,flags)=>{operations.push(['open',path,flags]);return{
   stat:async()=>options.changed?{...info,ino:45}:info,
   read:async(buffer,offset,length,position)=>{operations.push(['read',path]);const part=bytes.subarray(position,position+length);part.copy(buffer,offset);return{bytesRead:part.length};},
   close:async()=>{closed=true;},
  };},
 };
 const core={call:async(method,params)=>{calls.push({method,params});if(options.rpcError)throw Error('PRIVATE /secret/path data:image/png;base64,secret');return options.response||{data:[{turnId:'turn-one',item}]};}};
 const ensureAccess=async path=>{access.push(path);if(options.denied)throw Object.assign(Error('PRIVATE '+path),{code:'WORKSPACE_PERMISSION_REQUIRED'});};
 const manager=new HistoryMedia({core,ensureAccess,allowedRoots:['/allowed/root'],io,uid:501,...options.config});
 return{manager,core,calls,access,operations,get closed(){return closed;}};
}
function assertPrivate(result){const text=JSON.stringify(result);assert.equal(text.includes('/allowed/root'),false);assert.equal(text.includes('/Users/'),false);assert.equal(text.includes('data:image'),false);assert.equal(text.includes('PRIVATE'),false);}

test('official exact thread/turn/item lookup renders raster data without any filesystem access',async()=>{
 const f=fixture(),result=await f.manager.read(ref);
 assert.equal(result.status,'ready');assert.deepEqual(result.body,PNG);assert.equal(result.mime,'image/png');
 assert.deepEqual(f.calls,[{method:'thread/items/read',params:{threadId:'thread-one',turnId:'turn-one',itemIds:['item-one']}}]);
 assert.equal(f.access.length,0);assert.equal(f.operations.length,0);assert.equal(result.headers['Content-Length'],PNG.length);assert.equal(result.headers['X-Content-Type-Options'],'nosniff');
 assert.equal(result.headers['Cache-Control'],'private, no-store');assert.match(result.headers['Content-Disposition'],/^inline;/);assertPrivate({...result,body:undefined});
});

test('projection is pure, preserves original content index, and exposes no path, URL data or fileId',()=>{
 const item=user([{type:'text',text:'x'},{type:'localImage',path:'/allowed/root/image.png'},{type:'image',url:dataUrl()},{type:'image',fileId:'secret-file-id'}]);
 const projected=projectHistoryMedia(item,{threadId:ref.threadId,turnId:ref.turnId});
 assert.deepEqual(projected.map(p=>p.reference.index),[1,2,3]);assert.match(projected[0].url,/index=1/);
 assert.equal(projected[2].reason,'FILE_REFERENCE_UNSUPPORTED');assert.equal(projected[2].url,undefined);assert.equal(JSON.stringify(projected).includes('secret-file-id'),false);assertPrivate(projected);
 assert.deepEqual(projectHistoryMedia(item,{threadId:'/private/id',turnId:'turn-one'}),[]);
});

test('client path/url/root widening and malformed references are refused before RPC',async()=>{
 const f=fixture();
 for(const input of [{...ref,path:'/allowed/root/image.png'},{...ref,url:dataUrl()},{...ref,allowedRoots:['/']},{...ref,index:-1},{...ref,index:0.5},{...ref,index:2049},{...ref,itemId:'/private/secret'},{...ref,itemId:'data:abc'},{...ref,threadId:null}]){
  const result=await f.manager.read(input);assert.equal(result.reason,'INVALID_REFERENCE');assertPrivate(result);
 }
 assert.equal(f.calls.length,0);assert.equal(f.operations.length,0);
});

test('absent item, wrong turn, duplicated item, wrong index and non-image never fall back to a neighbour',async()=>{
 for(const [response,reason]of[
  [{data:[]},'ITEM_NOT_FOUND'],
  [{data:[{turnId:'turn-other',item:user([{type:'image',url:dataUrl()}])}]},'ITEM_MISMATCH'],
  [{data:[{turnId:'turn-one',item:user([])},{turnId:'turn-one',item:user([])}]},'ITEM_MISMATCH'],
  [{data:[{turnId:'turn-one',item:user([{type:'text',text:'x'},{type:'image',url:dataUrl()}])}]},'UNSUPPORTED_ITEM'],
  [{data:[{turnId:'turn-one',item:user([])}]},'INDEX_OUT_OF_RANGE'],
  [{items:[user([{type:'image',url:dataUrl()}])]},'HISTORY_UNAVAILABLE'],
 ]){const f=fixture(undefined,{response}),result=await f.manager.read(ref);assert.equal(result.reason,reason);assert.equal(f.operations.length,0);assertPrivate(result);}
 const failed=await fixture(undefined,{rpcError:true}).manager.read(ref);assert.equal(failed.reason,'HISTORY_UNAVAILABLE');assertPrivate(failed);
});

test('strict data URL decoding rejects SVG, HTML, MIME mismatch, malformed base64 and oversized payloads',async()=>{
 for(const [url,reason]of[
  [dataUrl(Buffer.from('<svg/>'),'image/svg+xml'),'UNSUPPORTED_IMAGE_FORMAT'],
  ['data:text/html;base64,PGh0bWw+','INVALID_IMAGE_DATA'],
  [dataUrl(PNG,'image/jpeg'),'INVALID_IMAGE_DATA'],
  ['data:image/png;base64,a===','INVALID_IMAGE_DATA'],
  ['data:image/png;base64,abcd\nefgh','INVALID_IMAGE_DATA'],
  ['data:image/png;base64,iVBORw0KGgo','INVALID_IMAGE_DATA'],
  [dataUrl(Buffer.from('<html/>')),'UNSUPPORTED_IMAGE_FORMAT'],
 ]){const f=fixture(user([{type:'image',url}])),result=await f.manager.read(ref);assert.equal(result.reason,reason);assert.equal(f.access.length,0);assertPrivate(result);}
 const tooLarge=fixture(user([{type:'image',url:dataUrl(Buffer.alloc(200))}]),{config:{maxBytes:16}});assert.equal((await tooLarge.manager.read(ref)).reason,'MEDIA_TOO_LARGE');
});

test('native generated image supports bare PNG result and savedPath but never fabricates fileId/remote downloads',async()=>{
 const generated=result=>({id:'item-one',type:'imageGeneration',status:'completed',result});
 assert.equal((await fixture(generated(PNG.toString('base64'))).manager.read(ref)).status,'ready');
 assert.equal((await fixture({...generated(''),savedPath:'/allowed/root/image.png'}).manager.read(ref)).status,'ready');
 assert.equal((await fixture({...generated(''),fileId:'secret-id'}).manager.read(ref)).reason,'FILE_REFERENCE_UNSUPPORTED');
 assert.equal((await fixture(generated('https://example.test/img.png')).manager.read(ref)).reason,'REMOTE_IMAGE_UNSUPPORTED');
 assert.equal((await fixture(generated('')).manager.read(ref)).reason,'MEDIA_NOT_READY');
 assert.equal((await fixture(generated(dataUrl())).manager.read({...ref,index:1})).reason,'INDEX_OUT_OF_RANGE');
});

test('local image uses scoped roots, permission check before IO, stable file handle and always closes',async()=>{
 const f=fixture(user([{type:'localImage',path:'/allowed/root/image.png'}])),result=await f.manager.read(ref);
 assert.equal(result.status,'ready');assert.deepEqual(f.access,['/allowed/root/image.png']);assert.equal(f.closed,true);assertPrivate({...result,body:undefined});
 const denied=fixture(user([{type:'localImage',path:'/allowed/root/image.png'}]),{denied:true}),blocked=await denied.manager.read(ref);
 assert.equal(blocked.reason,'PERMISSION_REQUIRED');assert.equal(blocked.permissionRequired,true);assert.equal(denied.operations.length,0);assertPrivate(blocked);
 const absent=fixture(user([{type:'localImage',path:'/allowed/root/image.png'}]),{config:{ensureAccess:undefined}});assert.equal((await absent.manager.read(ref)).reason,'ACCESS_CHECK_REQUIRED');assert.equal(absent.operations.length,0);
});

test('Documents permission denial is injected and does not stat, realpath, open or actually probe any protected directory',async()=>{
 const f=fixture(user([{type:'localImage',path:'/home/demo/Documents/private.png'}]),{denied:true,config:{allowedRoots:['/home/demo/Documents']}});
 const result=await f.manager.read(ref);assert.equal(result.reason,'PERMISSION_REQUIRED');assert.equal(f.operations.length,0);assertPrivate(result);
});

test('lexical escape, traversal, source/parent symlink, canonical escape and inode replacement are refused',async()=>{
 for(const path of ['/etc/private.png','/allowed/root/../private.png','relative.png','/allowed/root-other/image.png','file:///allowed/root/image.png']){
  const f=fixture(user([{type:'localImage',path}]));assert.equal((await f.manager.read(ref)).reason,'PATH_NOT_ALLOWED');assert.equal(f.access.length,0);assert.equal(f.operations.length,0);
 }
 const symlink=fixture(user([{type:'localImage',path:'/allowed/root/image.png'}]),{symlink:true});assert.equal((await symlink.manager.read(ref)).reason,'UNSAFE_FILE');assert.equal(symlink.operations.some(([op])=>op==='open'),false);
 const parent=fixture(user([{type:'localImage',path:'/allowed/root/sub/image.png'}]));const actual=parent.manager.io.lstat;parent.manager.io.lstat=async path=>path.endsWith('/sub')?{isSymbolicLink:()=>true}:actual(path);assert.equal((await parent.manager.read(ref)).reason,'UNSAFE_FILE');
 const escape=fixture(user([{type:'localImage',path:'/allowed/root/image.png'}]),{escape:true});assert.equal((await escape.manager.read(ref)).reason,'PATH_NOT_ALLOWED');
 const replaced=fixture(user([{type:'localImage',path:'/allowed/root/image.png'}]),{changed:true});assert.equal((await replaced.manager.read(ref)).reason,'MEDIA_CHANGED');assert.equal(replaced.closed,true);assert.equal(replaced.operations.some(([op])=>op==='read'),false);
});

test('server-only resolveRoots may supply an additional exact boundary, and bounded file reads cannot grow silently',async()=>{
 const item=user([{type:'localImage',path:'/workspace/image.png'}]);
 const f=fixture(item,{config:{resolveRoots:async received=>{assert.deepEqual(received,ref);return['/workspace'];}}});assert.equal((await f.manager.read(ref)).status,'ready');
 const oversized=fixture(user([{type:'localImage',path:'/allowed/root/image.png'}]),{bytes:Buffer.alloc(100),config:{maxBytes:16}});assert.equal((await oversized.manager.read(ref)).reason,'MEDIA_TOO_LARGE');assert.equal(oversized.operations.some(([op])=>op==='open'),false);
 const mutable=fixture(user([{type:'localImage',path:'/allowed/root/image.png'}]));const orig=mutable.manager.io.open;
 mutable.manager.io.open=async(...args)=>{const file=await orig(...args);const stat=file.stat;let count=0;file.stat=async()=>{const info=await stat();return ++count>1?{...info,mtimeMs:2}:info;};return file;};
 assert.equal((await mutable.manager.read(ref)).reason,'MEDIA_CHANGED');assert.equal(mutable.closed,true);
});

test('unresolved reasons stay within fixed enum and never echo private underlying errors',async()=>{
 const f=fixture(user([{type:'localImage',path:'/allowed/root/image.png'}]));f.manager.io.lstat=async()=>{throw Error('/home/demo PRIVATE data:image/png;base64,secret');};
 const result=await f.manager.read(ref);assert.equal(Object.hasOwn(MEDIA_REASONS,result.reason),true);assert.equal(result.reason,'MEDIA_UNAVAILABLE');assertPrivate(result);
});

test('server resolver receives only exact officially matched raw item and sourcePath, permitting an explicitly selected cwd-external image',async()=>{
 const official=user([{type:'text',text:'分析图片'},{type:'localImage',path:'/picked-outside-cwd/image.png'}]);
 let observed,called=0;
 const f=fixture(official,{config:{resolveRoots:async(reference,source)=>{called++;observed=source;assert.deepEqual(reference,{...ref,index:1});assert.equal(source.item,official);assert.equal(source.sourcePath,official.content[1].path);return source.item.type==='userMessage'&&source.item.content[reference.index]?.type==='localImage'&&source.item.content[reference.index].path===source.sourcePath?['/picked-outside-cwd']:[];}}});
 const result=await f.manager.read({...ref,index:1});assert.equal(result.status,'ready');assert.equal(called,1);assert.deepEqual(Object.keys(observed).sort(),['item','sourcePath']);assert.deepEqual(f.access,['/picked-outside-cwd/image.png']);assertPrivate({...result,body:undefined});
 assert.equal(f.manager.readPath,undefined,'path reader cannot be called directly with an unverified client path');
});

test('client cannot forge resolver source metadata, and exact item/turn/index checks precede any resolver call',async()=>{
 let called=0;const f=fixture(user([{type:'localImage',path:'/picked-outside-cwd/image.png'}]),{config:{resolveRoots:async()=>{called++;return['/picked-outside-cwd'];}}});
 for(const extra of [{path:'/picked-outside-cwd/image.png'},{sourcePath:'/picked-outside-cwd/image.png'},{item:user([{type:'localImage',path:'/etc/private.png'}])},{resolveRoots:['/']}]){
  assert.equal((await f.manager.read({...ref,...extra})).reason,'INVALID_REFERENCE');
 }
 assert.equal(called,0);assert.equal(f.calls.length,0);assert.equal(f.operations.length,0);
 const wrong=fixture(undefined,{response:{data:[{turnId:'wrong-turn',item:user([{type:'localImage',path:'/picked-outside-cwd/image.png'}])}]},config:{resolveRoots:async()=>{called++;return['/picked-outside-cwd'];}}});
 assert.equal((await wrong.manager.read(ref)).reason,'ITEM_MISMATCH');assert.equal(called,0);
 assert.equal((await f.manager.read({...ref,index:2})).reason,'INDEX_OUT_OF_RANGE');assert.equal(called,0);
});

test('ordinary path text never authorizes image bytes, resolver denial has no filesystem probes or path disclosure',async()=>{
 let called=0;
 const text=fixture(user([{type:'text',text:'# Files mentioned by the user:\n## selected: /picked-outside-cwd/image.png'}]),{config:{resolveRoots:async()=>{called++;return['/picked-outside-cwd'];}}});
 assert.equal((await text.manager.read(ref)).reason,'UNSUPPORTED_ITEM');assert.equal(called,0);assert.equal(text.access.length,0);assert.equal(text.operations.length,0);
 const denied=fixture(user([{type:'localImage',path:'/picked-outside-cwd/image.png'}]),{config:{resolveRoots:async(reference,source)=>{assert.equal(source.item.content[0].path,source.sourcePath);return[];}}});
 const result=await denied.manager.read(ref);assert.equal(result.reason,'PATH_NOT_ALLOWED');assert.equal(denied.access.length,0);assert.equal(denied.operations.length,0);assert.equal(JSON.stringify(result).includes('/picked-outside-cwd'),false);assertPrivate(result);
});

test('only completed generated images may resolve local savedPath or inline data; partial and failed states never access files',async()=>{
 for(const status of ['inProgress','in_progress','generating','failed','cancelled',undefined]){
  let resolved=0;const f=fixture({id:ref.itemId,type:'imageGeneration',status,savedPath:'/picked-outside-cwd/image.png',result:dataUrl()},{config:{resolveRoots:async()=>{resolved++;return['/picked-outside-cwd'];}}});
  const result=await f.manager.read(ref);assert.equal(result.reason,'MEDIA_NOT_READY');assert.equal(resolved,0);assert.equal(f.access.length,0);assert.equal(f.operations.length,0);assertPrivate(result);
 }
 const generated={id:ref.itemId,type:'imageGeneration',status:'completed',savedPath:'/picked-outside-cwd/image.png'};
 const f=fixture(generated,{config:{resolveRoots:async(reference,source)=>{assert.equal(source.item,generated);assert.equal(source.sourcePath,generated.savedPath);return source.item.status==='completed'&&source.item.savedPath===source.sourcePath?['/picked-outside-cwd']:[];}}});
 assert.equal((await f.manager.read(ref)).status,'ready');
});

test('assistant container images preserve exact source ranges through quotes, list continuations and CRLF',()=>{
 const image='![a](/work/a.png)';
 for(const text of [
  `> before\n> ${image}`,
  `- before\n  ${image}`,
  `> > before\n> > ${image}`,
  `> - before\n>   ${image}`,
  `1. before\n   ${image}`,
  `- [x] before\n  ${image}`,
  `> before\r\n> ${image}`,
  `> before\r> ${image}`,
  `😀 中文\n\n> before\n> **${image}**`,
  `> before\n> \`${image}\`\n> ${image}`,
  `- before\n  \`${image}\`\n  ${image}`,
 ]){
  assert.deepEqual(assistantImageReferences({type:'agentMessage',text}),[
   {path:'/work/a.png',start:text.lastIndexOf(image),end:text.lastIndexOf(image)+image.length,alt:'a'},
  ],text);
 }
 const text='> ![multi\n> line](/work/a.png)';
 const [found]=assistantImageReferences({type:'agentMessage',text});
 assert.equal(text.slice(found.start,found.end),'![multi\n> line](/work/a.png)');
});

test('assistant table header and body traverse real images in order, including escaped pipes and duplicate code',()=>{
 const head='![head](/work/h.png)',image='![a](/work/a.png)',pipe='![a\\|b](/work/p.png)';
 for(const prefix of ['', '> ']){
  const text=[`| ${head} | code |`, '| --- | --- |', `| \`${image}\` | ${image} |`, `| ${pipe} | /work/plain.png |`].map(line=>prefix+line).join('\r\n');
  const images=assistantImageReferences({type:'agentMessage',text});
  assert.deepEqual(images.map(image=>image.path),['/work/h.png','/work/a.png','/work/p.png']);
  assert.deepEqual(images.map(image=>text.slice(image.start,image.end)),[head,image,pipe]);
  assert.equal(images[1].start,text.lastIndexOf(image));
 }
});

test('assistant images exclude code, escaped syntax, HTML and prose while retaining Markdown reference images',()=>{
 const image='![a](/work/a.png)';
 const text=[
  '/work/plain.png and [ordinary link](/work/link.png)',
  `\\${image}`, `\`${image}\``, `    ${image}`,
  `> \`\`\`md\n> ${image}\n> \`\`\``,
  `- before\n\n      ${image}`,
  '<div>\n'+image+'\n</div>',
  '<img src="/work/html.png">',
  '![remote](https://example.com/image.png)',
  '> before\n> ![reference][picture]',
  '[picture]: /work/reference.png',
 ].join('\n\n');
 const images=assistantImageReferences({type:'agentMessage',text});
 assert.deepEqual(images.map(image=>image.path),['/work/reference.png']);
 assert.equal(text.slice(images[0].start,images[0].end),'![reference][picture]');
});

test('assistant projection and source lookup share container image indexes without widening roots',async()=>{
 const item={id:ref.itemId,type:'agentMessage',text:[
  '> before\n> ![quote](/allowed/root/quote.png)',
  '- before\n  ![list](/allowed/root/list.png)',
  '| ![head](/allowed/root/head.png) |\n| --- |\n| ![outside](/outside/image.png) |\n| ![last](/allowed/root/last.png) |',
 ].join('\n\n')};
 const paths=['/allowed/root/quote.png','/allowed/root/list.png','/allowed/root/head.png','/outside/image.png','/allowed/root/last.png'];
 assert.deepEqual(assistantImageReferences(item).map(image=>image.path),paths);
 const projected=projectHistoryMedia(item,ref);
 assert.deepEqual(projected.map(image=>image.reference.index),[0,1,2,3,4]);
 for(const [index,image]of projected.entries()){
  const f=fixture(item),result=await f.manager.read(image.reference);
  if(index===3){
   assert.equal(result.reason,'PATH_NOT_ALLOWED');assert.deepEqual(f.access,[]);assert.deepEqual(f.operations,[]);
  }else{
   assert.equal(result.status,'ready');assert.deepEqual(f.access,[paths[index]]);
  }
  assert.deepEqual(f.manager.allowedRoots,['/allowed/root']);
 }
 assert.equal((await fixture(item).manager.read({...ref,index:5})).reason,'INDEX_OUT_OF_RANGE');
});
