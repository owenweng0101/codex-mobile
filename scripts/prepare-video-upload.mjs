// Generate versioned variants from the pinned upstream UI. Existing browsers may
// retain the original immutable module URLs, including their 20 MiB schemas.
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function prepareVideoUpload(assets){
 const validationPath=join(assets,'validation-B6yV_dPD.js');
 const original=await readFile(validationPath,'utf8');
 if(!/attachmentMaxBytes:(?:20|256)\*1024\*1024/.test(original)||!/attachmentUploadMaxChunks:(?:64|1024),/.test(original))throw Error('Pinned attachment limits changed; review the video upload compatibility patch.');
 const validation=original.replace('attachmentMaxBytes:20*1024*1024','attachmentMaxBytes:256*1024*1024').replace('attachmentUploadMaxChunks:64,','attachmentUploadMaxChunks:1024,');
 const parts=await readFile(join(assets,'parts-BD-IKHpw.js'),'utf8');
 if(!parts.includes('./validation-B6yV_dPD.js'))throw Error('Pinned attachment schema import changed.');
 await writeFile(validationPath,validation);
 await writeFile(join(assets,'validation-mobile-video-v1.js'),validation);
 await writeFile(join(assets,'parts-mobile-video-v1.js'),parts.replaceAll('./validation-B6yV_dPD.js','./validation-mobile-video-v1.js'));
}
