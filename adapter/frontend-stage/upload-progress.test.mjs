import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {uploadPresentation} from './build-upload-progress.mjs';

const source=readFileSync(new URL('./assets/index-BsmXQHMM.js',import.meta.url),'utf8');
const start=source.indexOf('d&&n?(()=>{const p=uploadPresentation(e);');
const end=source.indexOf(':null]}),n?null:',start);
const render=vm.runInNewContext('(e)=>'+source.slice(start+5,end),{
 uploadPresentation,$:{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},ax:()=> 'progress',cUe:'progress',u:'original status'
});

test('image progress visibly distinguishes upload bytes from saving and preparation',()=>{
 for(const [status,progress,label,value,pending] of [
  ['waitingSession',0,'准备上传','',true],['queued',0,'等待上传','',true],
  ['uploading',42.9,'上传中','42%',false],['committing',100,'保存中','',true],
  ['ready',100,'已上传','✓',false],['failed',42,'上传失败','!',false]
 ]) {
  const node=render({uploadStatus:status,uploadProgress:progress});
  const [svg,caption]=node.props.children;
  assert.equal(caption.props.children,label);
  assert.equal(svg.props.children[2].props.children,value);
  assert.equal(!!svg.props.children[1].props.children,pending);
  assert.equal(node.props.role,status==='failed'?'alert':'status');
  assert.equal(node.props.style.pointerEvents,'none');
 }
});

test('upload progress follows confirmed chunks, then stays in saving until receipt',async()=>{
 const from=source.indexOf('async function tle('),to=source.indexOf('function du(',from);
 const run=vm.runInNewContext('('+source.slice(from,to).trim()+')',{
  lu:()=>{},Xce:s=>s.length,Yce:s=>new Uint8Array(s.length),$ce:()=> 'test',cu:2,
  Qce:async()=> 'hash',uu:()=>{},We:{attachmentMaxBytes:100},Zce:()=> 'YQ==',J:{warn:()=>{}},setTimeout,Error
 });
 const events=[];let releaseChunk,releaseCommit,finished=false;
 const chunkGate=new Promise(r=>releaseChunk=r),commitGate=new Promise(r=>releaseCommit=r);
 const done=run({attachmentBeginV4:async()=>({state:'staging',nextChunkIndex:0}),
  attachmentChunkV4:async p=>{await chunkGate;return {nextChunkIndex:p.chunkIndex+1};},
  attachmentCommitV4:async()=>{await commitGate;return {ref:'receipt'};},attachmentAbortV4:async()=>{}
 },{}, {sessionId:'draft',dataBase64:'aaaa'}, {onProgress:p=>events.push(p)}).then(()=>{finished=true;});
 await new Promise(setImmediate);
 assert.equal(events.at(-1).uploadedBytes,0);
 releaseChunk();await new Promise(setImmediate);
 assert.deepEqual(events.map(p=>p.uploadedBytes),[0,2,4,4]);
 assert.equal(events.at(-1).phase,'committing');assert.equal(finished,false);
 assert.equal(uploadPresentation({uploadStatus:'committing',uploadProgress:100}).label,'保存中');
 releaseCommit();await done;assert.equal(finished,true);
});
