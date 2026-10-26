import {attachmentRefToUploadId} from './attachment-upload.mjs';
// Preserve scoped access while a queued image is withdrawn into the composer.
// Native queue membership is evidence; a caller-supplied attachment ID is not.
export function createQueuedAttachmentResolver({api,resolveUploaded,now=Date.now}={}){
 const restored=new Map(),ttl=30*60*1000;
 return async function resolveAttachment(p){
  try{return await resolveUploaded(p);}catch(error){if(error.code!=='CODEX_ATTACHMENT_NOT_FOUND')throw error;}
  const id=attachmentRefToUploadId(p.ref);
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(p.sessionId||''))throw Error('附件不属于当前会话');
  const page=await api.get('/api/history?threadId='+encodeURIComponent(p.sessionId));
  if(page.thread?.id!==p.sessionId||page.thread?.cwd!==p.workspacePath||page.thread?.archived)throw Error('附件不属于当前工作区');
  const key=JSON.stringify([p.workspacePath,p.sessionId,id]);
  for(const [key,value]of restored)if(value<now())restored.delete(key);
  if(page.queue?.threadId===p.sessionId&&page.queue.items?.some(item=>item.attachments?.includes(id))){restored.set(key,now()+ttl);while(restored.size>256)restored.delete(restored.keys().next().value);}
  if(!restored.has(key))throw Error('附件不属于当前会话队列，请重新上传');
  return{id};
 };
}
