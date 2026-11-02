import assert from 'node:assert/strict';
export function videoUploadEdits(source){const edits=[];function patch(name,needle,text){assert.equal(source.split(needle).length-1,1,name);const start=source.indexOf(needle);edits.push({start,end:start+needle.length,text});}
patch('mobile-video-upload-limit','FQt=Math.min(_,We.attachmentMaxBytes)','FQt=We.attachmentMaxBytes');
patch('mobile-document-upload-limit','if(e.sizeBytes>We.attachmentMaxBytes)throw new tJ({filename:e.filename,maxSizeBytes:We.attachmentMaxBytes,sizeBytes:e.sizeBytes})','if(e.sizeBytes>20*1024*1024)throw new tJ({filename:e.filename,maxSizeBytes:20*1024*1024,sizeBytes:e.sizeBytes})');
patch('mobile-chunk-network-retry','if(uu(`attachmentChunkV4`,i),(await e.attachmentChunkV4(i)).nextChunkIndex!==n+1)', 'if(uu(`attachmentChunkV4`,i),(await (async()=>{for(let attempt=0;;attempt++){lu(r.signal);try{return await e.attachmentChunkV4(i)}catch(error){if(attempt>=2||r.signal?.aborted||/INVALID|CONFLICT|SCOPE|CHECKSUM|EXPIRED|NOT_FOUND/.test(String(error?.code||``)))throw error;await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)))}}})()).nextChunkIndex!==n+1)');
patch('mobile-video-validation-cache-version','from"./validation-B6yV_dPD.js"','from"./validation-mobile-video-v1.js"');
patch('mobile-video-schema-cache-version','from"./parts-BD-IKHpw.js"','from"./parts-mobile-video-v1.js"');
return edits;}
