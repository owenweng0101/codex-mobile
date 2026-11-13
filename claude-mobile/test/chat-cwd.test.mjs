import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {resolveChatCwd} from '../backend/lib/chat-cwd.mjs';

let root,folderA,folderB,defaultCwd,file,missing,alias;
before(async()=>{
  root=await mkdtemp(join(tmpdir(),'claude-chat-cwd-'));
  folderA=join(root,'文件夹 A');
  folderB=join(root,'folder B');
  defaultCwd=join(root,'default');
  file=join(root,'file.txt');
  missing=join(root,'missing');
  alias=join(root,'alias');
  await Promise.all([mkdir(folderA),mkdir(folderB),mkdir(defaultCwd),writeFile(file,'not a directory')]);
  await symlink(folderA,alias);

});
after(async()=>{if(root)await rm(root,{recursive:true,force:true});});

test('new chat uses folder A exactly, and uses default only when cwd is omitted',async()=>{
  assert.deepEqual(await resolveChatCwd({requestedCwd:folderA,defaultCwd}),{cwd:folderA});
  assert.deepEqual(await resolveChatCwd({defaultCwd}),{cwd:defaultCwd});
  assert.deepEqual(await resolveChatCwd({requestedCwd:alias,defaultCwd}),{cwd:alias});
});

test('recorded session cwd wins over another folder or an invalid request',async()=>{
  for(const requestedCwd of [folderB,missing,file,'',null]){
    assert.deepEqual(await resolveChatCwd({sessionCwd:folderA,requestedCwd,defaultCwd}),{cwd:folderA});
  }
});

test('invalid explicit cwd never resolves to the default',async()=>{
  for(const requestedCwd of [missing,file,join(file,'child'),'relative/path','',null,42,{},[],folderA+'\0']){
    const result=await resolveChatCwd({requestedCwd,defaultCwd});
    assert.match(result.error,/工作目录 cwd/);
    assert.equal(result.cwd,undefined);
  }
});

test('unavailable recorded/default directories cannot silently change projects',async()=>{
  for(const options of [
    {sessionCwd:missing,requestedCwd:folderA,defaultCwd},
    {defaultCwd:missing},
  ]){
    assert.match((await resolveChatCwd(options)).error,/不存在或无法访问/);
  }
});

test('resume requires a known directory or an explicit validated cwd',async()=>{
  for(const sessionCwd of [null,'',undefined]){
    const result=await resolveChatCwd({sessionCwd,defaultCwd,resume:true});
    assert.match(result.error,/无法确认续聊.*明确提供 cwd/);
    assert.equal(result.cwd,undefined);
    assert.deepEqual(await resolveChatCwd({sessionCwd,requestedCwd:folderA,defaultCwd,resume:true}),{cwd:folderA});
  }
});

// No network, CLI, real model, real session lookup, or user session writes.
