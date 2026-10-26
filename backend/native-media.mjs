import { dirname, isAbsolute } from 'node:path';
import { validateMediaReference, MEDIA_REASONS } from './history-media.mjs';

// The path comes from the exact official item, never from the HTTP query or
// prose mentioning a file. A native selection grants only its selected image.
export function nativeImageRoots(reference, { item, sourcePath } = {}) {
  if (!validateMediaReference(reference) || item?.id !== reference.itemId || typeof sourcePath !== 'string' || !isAbsolute(sourcePath) || sourcePath.includes('\0')) return [];
  const selected = item.type === 'userMessage' ? item.content?.[reference.index] : null;
  if (selected?.type === 'localImage' && selected.path === sourcePath || item.type === 'imageGeneration' && item.status === 'completed' && reference.index === 0 && item.savedPath === sourcePath) return [dirname(sourcePath)];
  return [];
}

export async function serveNativeMedia(store, params, response) {
  const keys = ['threadId','turnId','itemId','index'], index = params.get('index');
  const valid = [...params.keys()].length === 4 && keys.every(key => params.getAll(key).length === 1) && /^(?:0|[1-9]\d{0,3})$/.test(index || '');
  const reference = valid ? validateMediaReference({ threadId:params.get('threadId'), turnId:params.get('turnId'), itemId:params.get('itemId'), index:Number(index) }) : null;
  let result;
  try { result = reference ? await store.read(reference) : { reason:'INVALID_REFERENCE' }; }
  catch { result = { reason:'MEDIA_UNAVAILABLE' }; }
  if (result.status === 'ready') { response.writeHead(200, result.headers); response.end(result.body); return; }
  const reason = Object.hasOwn(MEDIA_REASONS, result.reason) ? result.reason : 'MEDIA_UNAVAILABLE';
  const status = { INVALID_REFERENCE:400, ITEM_NOT_FOUND:404, MEDIA_NOT_FOUND:404, ITEM_MISMATCH:410, INDEX_OUT_OF_RANGE:410, PERMISSION_REQUIRED:423, PATH_NOT_ALLOWED:403, UNSAFE_FILE:403, MEDIA_TOO_LARGE:413, HISTORY_UNAVAILABLE:503, MEDIA_UNAVAILABLE:503, MEDIA_NOT_READY:409 }[reason] || 422;
  const body = JSON.stringify({ status:'unresolved', reason, message:MEDIA_REASONS[reason], reference, ...(reason === 'PERMISSION_REQUIRED' ? {permissionRequired:true,retryable:true} : {}) });
  response.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length':Buffer.byteLength(body), 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
  response.end(body);
}
