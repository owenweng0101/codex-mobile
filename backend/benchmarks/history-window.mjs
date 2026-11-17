// Synthetic only: never opens a user's Codex state, database or rollout.
// Run: node backend/benchmarks/history-window.mjs [turnCount=5000] [items=10]
// Compare identical parameters/checkouts; elapsed time is informational, not a
// flaky unit-test threshold. Fresh index instances force a cold metadata scan.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {RolloutConversationIndex} from '../conversation-index.mjs';
import {projectConversationRows} from '../conversation-rows.mjs';
import {turnRecords,fixtureId,fixtureThread} from '../test/conversation-fixture.mjs';

const turnCount=Number(process.argv[2]||5000),items=Number(process.argv[3]||10);
assert(Number.isSafeInteger(turnCount)&&turnCount>0&&turnCount<=10000);
assert(Number.isSafeInteger(items)&&items>0&&items<=100);
const root=await realpath(tmpdir()),directory=await mkdtemp(join(root,'codex-history-benchmark-'));
try{
 const records=[],turns=[];
 for(let index=0;index<turnCount;index++){const value=turnRecords(index,{items});records.push(...value.records);turns.push(value.turn);}
 const content=records.join(''),file=join(directory,'synthetic.jsonl');
 await writeFile(file,content);
 const expected=projectConversationRows({thread:fixtureThread,turns});
 const identityHash=createHash('sha256').update(JSON.stringify(expected.map(row=>[row.rowId,row.entityId,row.kind]))).digest('hex');
 let timings;
 class MeasuredIndex extends RolloutConversationIndex{
  async scan(...args){const start=performance.now();try{return await super.scan(...args);}finally{timings.scanMs=performance.now()-start;}}
  layout(...args){const start=performance.now();try{return super.layout(...args);}finally{timings.layoutMs=performance.now()-start;}}
 }
 const index=new MeasuredIndex(),params={threadId:fixtureId,thread:fixtureThread};
 let revision,epoch;
 for(const [kind,options]of [['cold60',{limit:60}],['warm20',{limit:20}],['retainedAll',{fromRowId:1}],['unchangedRetained',{fromRowId:1}]]){
  timings={};const start=performance.now();
  const page=await index.read(file,{...params,...options,...(kind==='unchangedRetained'?{sourceEpoch:epoch,ifRevision:revision}:{})});
  const readMs=performance.now()-start,serializeAt=performance.now(),payloadBytes=Buffer.byteLength(JSON.stringify(page)),serializeMs=performance.now()-serializeAt;
  assert.equal(page.rows.totalCount,expected.length);
  if(kind==='unchangedRetained'){assert.equal(page.notModified,true);assert.equal(page.diagnostics.bodyReadBytes,0);assert.equal(page.rows.window.length,0);}
  else assert.deepEqual(page.rows.window,kind==='retainedAll'?expected:expected.slice(-options.limit));
  if(kind==='cold60')assert.equal(page.diagnostics.scannedBytes,Buffer.byteLength(content));
  else assert.equal(page.diagnostics.scannedBytes,0);
  revision=page.revision;epoch=page.sourceEpoch;
  console.log(JSON.stringify({kind,turnCount,items,sourceBytes:Buffer.byteLength(content),totalRows:expected.length,identityHash,readMs:+readMs.toFixed(2),scanMs:+timings.scanMs.toFixed(2),layoutMs:+timings.layoutMs.toFixed(2),windowMs:+(readMs-timings.scanMs-timings.layoutMs).toFixed(2),serializeMs:+serializeMs.toFixed(2),payloadBytes,returnedRows:page.rows.window.length,...page.diagnostics}));
 }
}finally{
 const target=await realpath(directory);assert.equal(dirname(target),root);assert(target.startsWith(join(root,'codex-history-benchmark-')));
 await rm(target,{recursive:true});
}
