import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export const bundleSha=value=>createHash('sha256').update(value).digest('hex');
export function applyMobileSplit(source,split){
 if(!split)return source;
 assert.equal(bundleSha(source),split.inputSha256,'Mobile split input changed');
 for(const stage of split.stages){
  assert.equal(bundleSha(source),stage.inputSha256,stage.name+' input changed');
  let previous=0;
  for(const edit of stage.edits){
   assert(Number.isSafeInteger(edit.start)&&edit.start>=previous&&edit.end>=edit.start&&edit.end<=source.length,'Invalid split offset');
   assert.equal(bundleSha(source.slice(edit.start,edit.end)),edit.beforeSha256,stage.name+' source slice changed');previous=edit.end;
  }
  for(const edit of stage.edits.toReversed())source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  assert.equal(bundleSha(source),stage.outputSha256,stage.name+' output changed');
 }
 assert.equal(bundleSha(source),split.outputSha256,'Mobile split output changed');
 return source;
}
