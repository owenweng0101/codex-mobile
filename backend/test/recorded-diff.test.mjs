import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {desktopHistory} from '../desktop-bridge.mjs';
import {projectTurnDiff} from '../git-view.mjs';

const realFixture=fileURLToPath(new URL('./fixtures/native-recorded-add.json',import.meta.url));
const change=(path,type,diff,extra={})=>({path,kind:{type,...extra},diff});
const record=(id,changes,status='completed')=>({id,type:'fileChange',status,changes});
const turn=(items,extra={})=>({turnId:'real-original-turn',diff:null,status:'completed',items,...extra});
const state=turns=>({id:'fixture-thread',turns,cwd:'/tmp',requests:[]});
async function root(t){const directory=await mkdtemp(join(tmpdir(),'codex-recorded-diff-'));t.after(()=>rm(directory,{recursive:true,force:true}));return realpath(directory);}

test('the real authorized native snapshot provides a completed add record with the exact original turn ID',async t=>{
 const directory=await root(t),snapshot=JSON.parse((await readFile(realFixture,'utf8')).replaceAll('__FIXTURE_ROOT__',directory)),history=desktopHistory(snapshot);
 assert.equal(snapshot.id,'01a1701d-73ab-79d0-af5b-c67b464b1e44');assert.equal(history.turnDiff.turnId,'01a1702c-3887-72d3-ac50-d797b66cb216');assert.equal(history.turnDiff.recordedChanges,true);assert.equal('diff' in history.turnDiff,false);
 const projected=await projectTurnDiff(snapshot.cwd,history.turnDiff);assert.equal(projected.available,true);assert.equal(projected.recordedChanges,true);assert.match(projected.message,/逐次.*未合并/);assert.equal(projected.files[0].path,'native-change.txt');assert.equal(projected.files[0].status,'A');assert.match(projected.diff,/--- \/dev\/null\n\+\+\+ b\/native-change.txt\n@@ -0,0 \+1,1 @@\n\+NATIVE_TURN_CHANGE\n/);
});
test('only completed file records on a real raw turn ID become a fallback source',async t=>{
 for(const status of ['failed','declined','inProgress']){
  const history=desktopHistory(state([turn([record('record-id',[change('file.txt','add','NOT_APPLIED\n')],status)])]));assert.equal(history.turnDiff,null);
 }
 const synthetic=desktopHistory(state([{items:[record('record-id',[change('file.txt','add','NO_REAL_TURN\n')])],params:{clientUserMessageId:'synthetic-user-id'}}]));assert.equal(synthetic.turnDiff,null);
 const directory=await root(t),result=await projectTurnDiff(directory,{turnId:'real-turn',fileChanges:[record('bad',[change('x','add','FAILED')],'failed')]});assert.equal(result.available,false);assert.equal(result.reason,'no-completed-file-changes');assert.equal(result.diff,'');
});
test('the latest recorded turn beats older aggregate data, while a real aggregate on the same turn has priority',()=>{
 const previous=turn([],{turnId:'older-real-turn',diff:'OLDER_AGGREGATE'}),latest=turn([record('new-record',[change('file.txt','add','RECORDED_CONTENT\n')])]);
 const history=desktopHistory(state([previous,latest]));assert.equal(history.turnDiff.turnId,latest.turnId);assert.equal(history.turnDiff.recordedChanges,true);
 const aggregate=desktopHistory(state([previous,{...latest,diff:'REAL_AGGREGATE'}]));assert.deepEqual(aggregate.turnDiff,{turnId:latest.turnId,diff:'REAL_AGGREGATE'});assert.equal(aggregate.diff,'REAL_AGGREGATE');
});
test('add and delete full contents produce truthful patches without consulting current file contents',async t=>{
 const directory=await root(t);await writeFile(join(directory,'same 文件.txt'),'CURRENT_WORKTREE_IS_NOT_THE_RECORD\n');
 const source=desktopHistory(state([turn([record('add',[change('same 文件.txt','add','FIRST_RECORDED\n')]),record('delete',[change('same 文件.txt','delete','SECOND_RECORDED_WITHOUT_NEWLINE')])])])).turnDiff;
 const result=await projectTurnDiff(directory,source);assert.equal(result.files.length,2);assert.deepEqual(result.files.map(file=>[file.status,file.recordId]),[['A','add'],['D','delete']]);assert.match(result.diff,/\+FIRST_RECORDED/);assert.match(result.diff,/-SECOND_RECORDED_WITHOUT_NEWLINE\n\\ No newline at end of file/);assert.equal(result.diff.includes('CURRENT_WORKTREE'),false);assert.equal(result.recordedChanges,true);
});
test('consecutive updates remain ordered records and only actual unified hunks or patches are accepted',async t=>{
 const directory=await root(t),first='@@ -1,1 +1,1 @@\n-before\n+middle\n',second='diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-middle\n+after\n';
 const source={turnId:'real-turn',fileChanges:[record('first',[change('file.txt','update',first)]),record('second',[change('file.txt','update',second)]),record('plain',[change('file.txt','update','FULL_FILE_IS_NOT_AN_UPDATE_DIFF')]),record('bad-hunk',[change('file.txt','update','@@ -1,2 +1,1 @@\n-old\n+new\n')])]};
 const result=await projectTurnDiff(directory,source,'file.txt');assert.deepEqual(result.files.map(file=>file.recordId),['first','second']);assert.equal(result.excludedCount,2);assert.ok(result.diff.indexOf('-before')<result.diff.indexOf('-middle'));assert.equal(result.diff.includes('FULL_FILE_IS_NOT'),false);assert.match(result.message,/未合并为净差异/);
});
test('recorded paths, rename destinations, and nearest existing ancestors remain confined',async t=>{
 const directory=await root(t),outside=await root(t);await writeFile(join(outside,'secret.txt'),'SECRET_OUTSIDE_FILE');await symlink(outside,join(directory,'escape'));
 const source={turnId:'real-turn',fileChanges:[record('scopes',[change('../outside.txt','add','LEAK_RELATIVE'),change(join(outside,'secret.txt'),'add','LEAK_ABSOLUTE'),change('escape/secret.txt','add','LEAK_SYMLINK'),change('local.txt','update','@@ -1 +1 @@\n-old\n+new\n',{move_path:join(outside,'renamed.txt')}),change('deleted.txt','delete','IN_SCOPE_DELETED\n')])]};
 const result=await projectTurnDiff(directory,source);assert.equal(result.files.length,1);assert.equal(result.files[0].path,'deleted.txt');assert.equal(result.excludedCount,4);assert.match(result.diff,/-IN_SCOPE_DELETED/);assert.equal(result.diff.includes('LEAK'),false);assert.equal(result.diff.includes('SECRET_OUTSIDE'),false);
});
test('renamed update hunks use verified original and destination paths and single-file selection',async t=>{
 const directory=await root(t),source={turnId:'real-turn',fileChanges:[record('rename',[change('旧 文件.txt','update','@@ -1 +1 @@\n-old\n+new\n',{move_path:'新 文件.txt'})]),record('other',[change('other.txt','add','OTHER\n')])]};
 const result=await projectTurnDiff(directory,source,'新 文件.txt');assert.equal(result.files[0].status,'R');assert.equal(result.files[0].previousPath,'旧 文件.txt');assert.match(result.diff,/"a\/旧 文件.txt" "b\/新 文件.txt"/);assert.equal(result.diff.includes('OTHER'),false);
});
test('update headers cannot relabel another file, and binary content is not fabricated as text',async t=>{
 const directory=await root(t),source={turnId:'real-turn',fileChanges:[record('bad',[change('declared.txt','update','diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-SECRET\n+WRONG_FILE\n'),change('binary.bin','add','abc\0def')])]};
 const result=await projectTurnDiff(directory,source);assert.equal(result.files.length,0);assert.equal(result.diff,'');assert.equal(result.excludedCount,2);
});
test('empty additions, CRLF, EOF markers, and aggregate priority retain their explicit meaning',async t=>{
 const directory=await root(t),source={turnId:'real-turn',fileChanges:[record('text',[change('empty.txt','add',''),change('crlf.txt','add','A\r\nB\r\n')])]};
 const result=await projectTurnDiff(directory,source);assert.equal(result.files.length,2);assert.match(result.diff,/new file mode 100644\n--- \/dev\/null\n\+\+\+ b\/empty.txt\n/);assert.match(result.diff,/@@ -0,0 \+1,2 @@\n\+A\n\+B\n/);
 const aggregate={...source,diff:'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+AGGREGATE\n'};const preferred=await projectTurnDiff(directory,aggregate);assert.equal(preferred.recordedChanges,undefined);assert.match(preferred.diff,/AGGREGATE/);assert.equal(preferred.diff.includes('crlf.txt'),false);
});
