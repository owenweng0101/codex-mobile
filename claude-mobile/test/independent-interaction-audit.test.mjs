import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,response} from './native-ui-fixture.mjs';

test('audit: a verified image-only receipt clears the submitted attachment',async()=>{
 const f=fixture();f.api.newChat('/audit');f.api.state.capabilities={attachments:true};
 f.api.state.attachments=[{id:'image-one.png',name:'image.png',url:'/not-sent'}];
 const nativeMessageId=randomUUID();
 f.ctx.fetchHook=(url,options)=>options.method==='POST'?response(200,{requestId:JSON.parse(options.body).requestId,sessionId:JSON.parse(options.body).requestId,nativeMessageId,transport:'native-user-v1',state:'accepted'}):undefined;
 await f.api.send('');
 assert.equal(f.requests()[0].text,'请查看这张图片。');assert.equal(f.requests()[0].nativeMessageId,nativeMessageId);
 assert.equal(f.api.state.attachments.length,0,'a proved receipt, not HTTP status alone, clears the submitted selection');
});

test('audit: an in-flight upload remains removable after switching conversations',async()=>{
 const f=fixture();f.api.newChat('/audit');const image={name:'pending.png',uploading:true};f.api.state.attachments=[image];
 f.api.showList();await f.api.openSession({id:'other-session',cwd:'/audit',title:'Other'});
 f.api.newChat('/audit');assert.equal(f.api.state.attachments[0],image);
 f.node('attachments').querySelector('.rm').onclick();assert.equal(f.api.state.attachments.length,0);
});
