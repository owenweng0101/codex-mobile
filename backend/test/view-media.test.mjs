import test from 'node:test';
import assert from 'node:assert/strict';
import { displayItem,displayTurn,desktopItemEvents,cleanUserText } from '../view.mjs';

const ctx={threadId:'thread-one',turnId:'turn-one'};
const user={id:'user-one',type:'userMessage',content:[{type:'text',text:'看这两张图'},{type:'localImage',path:'/home/demo/Documents/image.png'},{type:'image',url:'data:image/png;base64,iVBORw0KGgo='}]};

test('assistant inline image spans survive double projection without changing reply text',()=>{
 const raw={id:'assistant-one',type:'agentMessage',phase:'final_answer',text:'看图：\n\n![图片](/work/photo.png)\n\n正文不变'};
 const shown=displayItem(raw,ctx);assert.equal(shown.text,raw.text);assert.equal(shown.inlineImages.length,1);
 assert.equal(raw.text.slice(shown.inlineImages[0].start,shown.inlineImages[0].end),'![图片](/work/photo.png)');
 assert.equal(shown.inlineImages[0].reference.itemId,raw.id);assert.equal(shown.inlineImages[0].reference.index,0);
 assert.deepEqual(displayItem(shown,ctx),shown);assert.deepEqual(displayItem(shown),shown);
});
function safe(value){const text=JSON.stringify(value);assert.equal(text.includes('/Users/'),false);assert.equal(text.includes('data:image'),false);assert.equal(text.includes('secret-file-id'),false);}

test('native user images preserve original raw index and scoped references, while source paths/data never leave view',()=>{
 const item=displayItem(user,ctx);assert.deepEqual(item.content.slice(1).map(c=>c.reference.index),[1,2]);
 for(const [index,image]of item.content.slice(1).entries()){
  assert.deepEqual(image.reference,{...ctx,itemId:'user-one',index:index+1});assert.equal(new URL('http://local'+image.url).searchParams.get('threadId'),'thread-one');
 }
 safe(item);assert.deepEqual(displayItem(item,ctx),item);assert.deepEqual(displayItem(item),item);
});

test('raw media without explicit valid context never invents a native proxy URL, including map callback arguments',()=>{
 const single=displayItem(user);assert.equal(single.content.some(c=>c.url),false);safe(single);
 const mapped=[{id:'turn-one',items:[user]},{id:'turn-two',items:[user]}].map(displayTurn);assert.equal(JSON.stringify(mapped).includes('/api/thread-media'),false);safe(mapped);
 assert.equal(JSON.stringify(displayTurn({id:'turn-one',items:[user]},{threadId:'thread-one',turnId:'wrong-turn'})).includes('/api/thread-media'),false);
});

test('ordinary upload cards that flatten text do not shift the native raw image reference on second projection',()=>{
 const attachmentId='a'.repeat(48),manifest='<codex-mobile-attachments version="1">\n'+JSON.stringify({attachments:[{id:attachmentId,name:'文档.pdf',kind:'document',mime:'application/pdf',size:12,localPath:'/private/data.pdf',excerpt:'private words'}]})+'\n</codex-mobile-attachments>';
 const raw={id:'user-one',type:'userMessage',content:[{type:'text',text:'分析\n'+manifest},{type:'localImage',path:'/private/tmp/image.png'}]};
 const once=displayItem(raw,ctx);assert.equal(once.content[1].type,'attachment');assert.equal(once.content[2].reference.index,1);
 const twice=displayItem(once,ctx);assert.deepEqual(twice,once);assert.equal(twice.content[2].reference.index,1);assert.equal(JSON.stringify(twice).includes('private words'),false);
});

test('projected native refs are whitelisted, context-bound and URL is rebuilt rather than trusting caller URL/message',()=>{
 const reference={...ctx,itemId:'user-one',index:9};
 const raw={id:'user-one',type:'userMessage',content:[{type:'image',reference,url:'file:///home/demo',status:'candidate',path:'/home/demo',data:'data:image/private'}]};
 const item=displayItem(raw,ctx);assert.match(item.content[0].url,/^\/api\/thread-media\?/);safe(item);assert.equal(item.content[0].reference.index,9);
 for(const broken of [{...reference,path:'/home/demo'},{...reference,itemId:'other'},{...reference,threadId:'other'},{...reference,turnId:'other'},{...reference,index:-1}]){
  const result=displayItem({...raw,content:[{...raw.content[0],reference:broken}]},ctx);assert.equal(result.content[0].reason,'INVALID_REFERENCE');assert.equal(result.content[0].url,undefined);safe(result);
 }
 const failed=displayItem({...raw,content:[{...raw.content[0],status:'unresolved',reason:'MEDIA_NOT_FOUND',message:'/home/demo'}]},ctx);assert.equal(failed.content[0].reason,'MEDIA_NOT_FOUND');safe(failed);assert.deepEqual(displayItem(failed,ctx),failed);
});

test('imageGeneration exposes only safe single-media ref and remains stable across repeated projection',()=>{
 for(const source of [{savedPath:'/private/cache/image.png'},{result:'data:image/png;base64,iVBORw0KGgo='},{fileId:'secret-file-id'},{result:''}]){
  const raw={id:'generated-one',type:'imageGeneration',status:'completed',...source,revisedPrompt:'private details'};
  const result=displayItem(raw,ctx);assert.equal(result.type,'imageGeneration');assert.deepEqual(result.media.reference,{...ctx,itemId:'generated-one',index:0});safe(result);assert.equal(result.revisedPrompt,undefined);assert.equal(result.savedPath,undefined);assert.equal(result.result,undefined);assert.deepEqual(displayItem(result,ctx),result);
 }
 const raw={id:'generated-one',type:'imageGeneration',status:'completed',savedPath:'/private/cache/image.png'};const noContext=displayItem(raw);assert.equal(noContext.media.url,undefined);assert.deepEqual(displayItem(noContext),noContext);
});

test('desktop snapshot double projection and item event projection preserve media refs without duplicate updates',()=>{
 const raw={id:'turn-one',status:'completed',items:[user,{id:'generated-one',type:'imageGeneration',status:'completed',result:'data:image/png;base64,iVBORw0KGgo='}]};
 const once=displayTurn(raw,{threadId:'thread-one'}),twice=displayTurn(once,{threadId:'thread-one'});assert.deepEqual(twice,once);
 assert.deepEqual([once].map(displayTurn),[once]);
 const events=desktopItemEvents('thread-one',{turns:[]},{turns:[raw]});assert.equal(events.length,2);for(const event of events){const item=displayItem(event.params.item,{threadId:event.params.threadId,turnId:event.params.turnId});assert.deepEqual(item,event.params.item);safe(item);}
 assert.deepEqual(desktopItemEvents('thread-one',{turns:[once]},{turns:[twice]}),[]);
});

test('legacy uploads, native local_image aliases, system cleaner and bounded tools keep their existing behaviour',()=>{
 const id='b'.repeat(48),phone=displayItem({id:'user',type:'userMessage',content:[{type:'local_image',path:'/private/uploads/'+id+'.png'}]},ctx);assert.equal(phone.content[0].url,'/api/attachment?id='+id);assert.deepEqual(displayItem(phone,ctx),phone);
 const native=displayItem({id:'user-one',type:'userMessage',content:[{type:'local_image',path:'/private/cache/image.png'}]},ctx);assert.equal(native.content[0].reference.index,0);safe(native);
 assert.equal(cleanUserText('<environment_context>private</environment_context>\n## My request:\n我的问题'),'我的问题');
 const command=displayItem({id:'tool',type:'commandExecution',command:'x'.repeat(3000),aggregatedOutput:'x'.repeat(5000)+'END'});assert.equal(command.command.length,1200);assert.equal(command.aggregatedOutput.length,2000);assert.ok(command.aggregatedOutput.endsWith('END'));
});
