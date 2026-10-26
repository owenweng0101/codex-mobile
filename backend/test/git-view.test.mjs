import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink,symlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {workspaceGit} from '../core.mjs';
import {projectTurnDiff} from '../git-view.mjs';
const exec=promisify(execFile);
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'codex-git-readonly-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const git=async(...args)=>(await exec('git',['--literal-pathspecs',...args],{cwd:root,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}})).stdout;
  await git('init','-q');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
  return{root,git,write:(path,text)=>writeFile(join(root,path),text),commit:async()=>{await git('add','--','.');await git('commit','-qm','fixture')}};
}
test('staged and unstaged changes to the same file retain both status columns and separate patches',async t=>{
  const f=await fixture(t);await f.write('same.txt','BASE\n');await f.commit();await f.write('same.txt','INDEX_VERSION\n');await f.git('add','--','same.txt');await f.write('same.txt','WORKTREE_VERSION\n');
  const indexBefore=await readFile(join(f.root,'.git/index')),mtime=(await stat(join(f.root,'.git/index'))).mtimeMs;
  const unstaged=await workspaceGit(f.root,'same.txt',{source:'unstaged'}),staged=await workspaceGit(f.root,'same.txt',{source:'staged'}),all=await workspaceGit(f.root,'same.txt');
  assert.deepEqual([all.files[0].indexStatus,all.files[0].worktreeStatus,all.files[0].staged,all.files[0].unstaged],['M','M',true,true]);
  assert.match(staged.diff,/-BASE\n\+INDEX_VERSION/);assert.equal(staged.diff.includes('WORKTREE_VERSION'),false);assert.match(unstaged.diff,/-INDEX_VERSION\n\+WORKTREE_VERSION/);assert.equal(unstaged.diff.includes('BASE'),false);assert.equal(all.source,'all');assert.match(all.diff,/WORKTREE_VERSION/);assert.match(all.diff,/-BASE/);assert.deepEqual(all.counts,{staged:1,unstaged:1,untracked:0});
  assert.deepEqual(await readFile(join(f.root,'.git/index')),indexBefore);assert.equal((await stat(join(f.root,'.git/index'))).mtimeMs,mtime);
});
test('deleted paths work without a surviving file and staged rename preserves Chinese and spaces',async t=>{
  const f=await fixture(t);await f.write('deleted.txt','DELETE_ME\n');await f.write('原始 空格.txt','RENAMED_CONTENT\n');await f.commit();await unlink(join(f.root,'deleted.txt'));await f.git('mv','--','原始 空格.txt','新的 名字.txt');
  const deleted=await workspaceGit(f.root,'deleted.txt',{source:'unstaged'});assert.match(deleted.diff,/deleted file mode/);assert.match(deleted.diff,/-DELETE_ME/);assert.equal(deleted.files[0].worktreeStatus,'D');
  const renamed=await workspaceGit(f.root,'新的 名字.txt',{source:'staged'});assert.equal(renamed.files[0].previousPath,'原始 空格.txt');assert.equal(renamed.files[0].indexStatus,'R');assert.match(renamed.diff,/rename from 原始 空格.txt/);assert.match(renamed.diff,/rename to 新的 名字.txt/);
});
test('untracked patches are real and selected Git pathspec-looking names remain literal',async t=>{
  const f=await fixture(t);await f.write('tracked.txt','seed\n');await f.commit();const literal=':(glob)*.txt';await f.write(literal,'LITERAL_ONLY\n');await f.write('other.txt','NOT_SELECTED\n');
  const result=await workspaceGit(f.root,literal,{source:'unstaged'});assert.equal(result.files.length,1);assert.equal(result.files[0].untracked,true);assert.match(result.diff,/\+LITERAL_ONLY/);assert.equal(result.diff.includes('NOT_SELECTED'),false);assert.match(result.diff,/new file mode/);
  const staged=await workspaceGit(f.root,literal,{source:'staged'});assert.equal(staged.files.length,0);assert.equal(staged.diff,'');
});
test('nested workspace scope rejects traversal and escaping symlinks while omitting outside Git changes',async t=>{
  const f=await fixture(t);await mkdir(join(f.root,'inside'));await f.write('inside/local.txt','LOCAL_BASE\n');await f.write('outside.txt','OUTSIDE_BASE\n');await f.commit();await f.write('inside/local.txt','LOCAL_CHANGED\n');await f.write('outside.txt','OUTSIDE_SECRET\n');await symlink(join(f.root,'outside.txt'),join(f.root,'inside/escape.txt'));
  const result=await workspaceGit(join(f.root,'inside'));assert.equal(result.files.some(file=>file.path.includes('outside')),false);assert.match(result.diff,/LOCAL_CHANGED/);assert.equal(result.diff.includes('OUTSIDE_SECRET'),false);assert.equal(result.files.find(file=>file.path==='escape.txt').unavailable,true);
  for(const path of ['../outside.txt','/tmp/file','escape.txt','escape.txt/child'])await assert.rejects(workspaceGit(join(f.root,'inside'),path),{statusCode:400});
});
test('Git views do not execute configured external diffs or text converters',async t=>{
  const f=await fixture(t);await f.write('file.txt','BASE\n');await f.write('.gitattributes','*.txt diff=fixture\n');await f.commit();await f.git('config','diff.external','/usr/bin/false');await f.git('config','diff.fixture.textconv','/usr/bin/false');await f.write('file.txt','CHANGED\n');
  assert.match((await workspaceGit(f.root,'file.txt',{source:'unstaged'})).diff,/CHANGED/);
});
test('turn source requires a real turn identity and diff, never a HEAD substitution',async t=>{
  const f=await fixture(t);await f.write('file.txt','BASE\n');await f.commit();await f.write('file.txt','UNCOMMITTED_NOT_A_TURN\n');
  const missing=await workspaceGit(f.root,null,{source:'turn'});assert.equal(missing.available,false);assert.equal(missing.reason,'no-turn-diff');assert.equal(missing.diff.includes('UNCOMMITTED'),false);
  const turn={turnId:'actual-turn-id',diff:'diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-REAL_TURN_DELETED\n'};
  const result=await workspaceGit(f.root,'deleted.txt',{source:'turn',turn});assert.equal(result.turnId,turn.turnId);assert.equal(result.files[0].status,'D');assert.match(result.diff,/REAL_TURN_DELETED/);assert.equal(result.diff.includes('UNCOMMITTED'),false);
});
test('turn patches filter outside paths and select exact renamed or spaced files',async t=>{
  const f=await fixture(t);const visible='diff --git a/旧 名.txt b/新 名.txt\nsimilarity index 100%\nrename from 旧 名.txt\nrename to 新 名.txt\n',other='diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-OLD\n+OTHER\n',outside='diff --git a/../secret.txt b/../secret.txt\n--- a/../secret.txt\n+++ b/../secret.txt\n@@ -1 +1 @@\n-SECRET_BEFORE\n+SECRET_AFTER\n';
  const result=await projectTurnDiff(f.root,{turnId:'real-turn',diff:visible+other+outside},'新 名.txt');assert.equal(result.files.length,1);assert.equal(result.files[0].previousPath,'旧 名.txt');assert.equal(result.excludedCount,1);assert.equal(result.diff,visible);assert.equal(result.diff.includes('SECRET'),false);await assert.rejects(projectTurnDiff(f.root,{turnId:'real-turn',diff:outside},'../secret.txt'),{statusCode:400});
});

test('renames across the workspace edge expose only the in-scope side, without outside names',async t=>{
  const f=await fixture(t);await mkdir(join(f.root,'scope'));await f.write('outside-original.txt','MOVED_IN_CONTENT\n');await f.write('scope/leaving.txt','MOVED_OUT_CONTENT\n');await f.commit();await f.git('mv','--','outside-original.txt','scope/arriving.txt');await f.git('mv','--','scope/leaving.txt','outside-destination.txt');
  const result=await workspaceGit(join(f.root,'scope'),null,{source:'staged'});assert.deepEqual(result.files.map(file=>file.path).sort(),['arriving.txt','leaving.txt']);assert.equal(result.diff.includes('outside-original'),false);assert.equal(result.diff.includes('outside-destination'),false);assert.equal(result.files.some(file=>file.previousPath?.startsWith('..')),false);assert.match(result.diff,/new file mode/);assert.match(result.diff,/deleted file mode/);
});
test('untracked diff output is bounded and reports truncation without altering the source',async t=>{
  const f=await fixture(t);await f.write('seed.txt','BASE\n');await f.commit();const text='LONG_UNTRACKED_LINE\n'.repeat(50000);await f.write('large.txt',text);
  const result=await workspaceGit(f.root,'large.txt',{source:'unstaged'});assert.equal(result.truncated,true);assert.equal(result.diff.length,512*1024);assert.equal(await readFile(join(f.root,'large.txt'),'utf8'),text);
});
test('ambiguous bare multi-file turn patches cannot label outside content as an in-scope file',async t=>{
  const f=await fixture(t),diff='--- a/inside.txt\n+++ b/inside.txt\n@@ -1 +1 @@\n-OLD\n+NEW\n--- a/../secret.txt\n+++ b/../secret.txt\n@@ -1 +1 @@\n-SECRET_OLD\n+SECRET_NEW\n';
  const result=await projectTurnDiff(f.root,{turnId:'turn-real',diff});assert.equal(result.files.length,0);assert.equal(result.diff,'');assert.equal(result.excludedCount,1);
});
test('real Git C-quoted UTF8 filenames survive safe turn projection',async t=>{
  const f=await fixture(t),path='中文 空格.txt';await f.write(path,'BEFORE\n');await f.commit();await f.write(path,'AFTER\n');
  const diff=await f.git('-c','core.quotePath=true','diff','--no-ext-diff','--no-textconv','--',path);assert.match(diff,/\\[0-7]{3}/);
  const result=await projectTurnDiff(f.root,{turnId:'actual-quoted-turn',diff},path);assert.equal(result.files[0].path,path);assert.equal(result.excludedCount,0);assert.match(result.diff,/\+AFTER/);
});
