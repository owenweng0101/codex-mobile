import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,writeFile,symlink,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
import{createFileReadService}from'../files.mjs';import{readWorkspaceFile,workspacePath}from'../../../backend/core.mjs';import{CodexReadClient}from'../../api-client.mjs';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'codex-preview-'));t.after(()=>rm(root,{recursive:true,force:true}));const calls=[];
 await writeFile(join(root,'note.md'),'你好，预览\n# Example');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');await writeFile(join(root,'photo.png'),png);
 const api={get:async path=>{calls.push(path);const q=new URL(path,'http://test').searchParams;return readWorkspaceFile(root,q.get('path'));},getMedia:async path=>{calls.push(path);const q=new URL(path,'http://test').searchParams;await workspacePath(root,q.get('path'));return{bytes:png,mediaType:'image/png'};}};
 const baseServices={project:{readTree:async()=>({projects:[],tasks:[{workspacePath:root}]})}};
 return{root,calls,png,service:createFileReadService({api,baseServices})};
}
test('native text and image responses satisfy original preview contracts',async t=>{
 const f=await fixture(t),text=await f.service.readTextFile({path:join(f.root,'note.md'),offset:0,length:100});assert.match(text.content,/你好/);assert.equal(text.isBinary,false);assert.equal(text.truncated,false);
 const small=await f.service.readTextFile({path:'note.md',workspacePath:f.root,length:6});assert.equal(small.content,'你好');assert.equal(small.truncated,true);
 const image=await f.service.readMediaPreview({path:join(f.root,'photo.png')});assert.equal(image.mediaType,'image/png');assert.deepEqual(Buffer.from(image.dataBase64,'base64'),f.png);
});
test('outside paths, foreign scopes and symlink escapes cannot read local files',async t=>{
 const f=await fixture(t);for(const p of [{path:'/etc/hosts'},{path:'../outside',workspacePath:f.root},{path:'note.md'},{path:join(f.root,'note.md'),workspaceIdentity:'remote'},{path:join(f.root,'note.md'),workspacePath:'/etc'}])await assert.rejects(f.service.readTextFile(p));
 assert.equal(f.calls.length,0);await symlink('/etc/hosts',join(f.root,'escape.md'));await assert.rejects(f.service.readTextFile({path:join(f.root,'escape.md')}),/工作目录以外/);
 await assert.rejects(f.service.readMediaPreview({path:join(f.root,'note.md')}),/图片预览/);
});
test('media transport enforces route and size bounds, including unknown content length',async()=>{
 let requests=0;const c=new CodexReadClient({fetchImpl:async()=>{requests++;return new Response(new Uint8Array(6),{headers:{'content-type':'image/png'}});}});c.bearer='fixture';
 await assert.rejects(c.getMedia('/api/file-content?cwd=a&path=b',{maxBytes:5}),/大小限制/);assert.equal(requests,1);
 for(const path of ['https://example.com/api/file-content?x','/api/file-content?download=1','/api/history?x'])await assert.rejects(c.getMedia(path));assert.equal(requests,1);
});
test('stat is scoped and original image bytes are preserved for download',async()=>{
 const root='/workspace',original=Buffer.alloc(200000,7),calls=[];
 const api={get:async path=>{calls.push(path);return{entries:[{name:'photo.png',type:'file',size:original.length}],truncated:false};},getMedia:async()=>({bytes:original,mediaType:'image/png'})};
 const baseServices={project:{readTree:async()=>({projects:[],tasks:[{workspacePath:root}]})}};
 const service=createFileReadService({api,baseServices,preview:async()=>{throw Error('original must not be transformed');}});
 assert.deepEqual(await service.stat({path:root+'/assets/photo.png'}),{type:'file',size:original.length});
 assert.equal(new URL(calls[0],'http://local').searchParams.get('path'),'assets');
 assert.deepEqual(Buffer.from((await service.readMediaPreview({path:root+'/assets/photo.png'})).dataBase64,'base64'),original);
 await assert.rejects(service.stat({path:'/etc/hosts'}));assert.equal(calls.length,1);
});
