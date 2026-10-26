import { lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, normalize, relative, join, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { marked } from 'marked';

const MiB = 1024 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MEDIA_REASONS = Object.freeze({
  INVALID_REFERENCE: '图片引用无效，请重新打开会话。',
  HISTORY_UNAVAILABLE: '暂时无法读取这条历史消息，请稍后重试。',
  ITEM_NOT_FOUND: '这条图片消息不存在或已被编辑。',
  ITEM_MISMATCH: '图片与所选消息位置不一致，请重新打开会话。',
  INDEX_OUT_OF_RANGE: '图片位置已失效，请重新打开会话。',
  UNSUPPORTED_ITEM: '这条消息没有可预览的图片。',
  FILE_REFERENCE_UNSUPPORTED: '此图片使用原生存储引用，暂时请在电脑端查看。',
  REMOTE_IMAGE_UNSUPPORTED: '暂不代理远程图片地址，请在电脑端查看。',
  MEDIA_NOT_READY: '这张图片尚未生成或已没有可用内容。',
  INVALID_IMAGE_DATA: '图片数据无效，无法预览。',
  UNSUPPORTED_IMAGE_FORMAT: '暂时只支持 PNG、JPEG、GIF 和 WebP 图片。',
  MEDIA_TOO_LARGE: '图片过大，请在电脑端查看。',
  PATH_NOT_ALLOWED: '这张图片不在已授权的附件或工作区范围内。',
  ACCESS_CHECK_REQUIRED: '本机附件访问检查尚未配置，请在电脑端查看。',
  PERMISSION_REQUIRED: '需要先在 Mac 上允许本机服务访问该图片所在目录。',
  MEDIA_NOT_FOUND: '原图片文件已不存在，可能是临时图片已被清理。',
  UNSAFE_FILE: '图片文件类型或链接不符合安全要求。',
  MEDIA_CHANGED: '图片文件已发生变化，请重新打开会话后再试。',
  MEDIA_UNAVAILABLE: '暂时无法读取这张图片，请在电脑端查看。',
});

function mediaError(reason) { return Object.assign(new Error(MEDIA_REASONS[reason]), { reason }); }
function unresolved(reason, reference = null) {
  return { status: 'unresolved', reason, message: MEDIA_REASONS[reason], reference,
    ...(reason === 'PERMISSION_REQUIRED' ? { permissionRequired: true, retryable: true } : {}) };
}
function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) && !/^(?:data|file|https?):/i.test(value); }
export function validateMediaReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['threadId','turnId','itemId','index'].includes(key))) return null;
  if (![value.threadId,value.turnId,value.itemId].every(validId) || !Number.isSafeInteger(value.index) || value.index < 0 || value.index > 2048) return null;
  return { threadId: value.threadId, turnId: value.turnId, itemId: value.itemId, index: value.index };
}
function mediaUrl(reference) { return '/api/thread-media?' + new URLSearchParams(Object.entries(reference).map(([key,value]) => [key,String(value)])); }
// Parse actual Markdown image nodes, not paths mentioned in prose or code.
// Offsets let the mobile adapter replace only the image, preserving the reply.
export function assistantImageReferences(item) {
  if (item?.type !== 'agentMessage' || typeof item.text !== 'string') return [];
  const result=[];
  function visit(tokens, text, base=0, stripped=false, table=false) {
    let cursor=0;
    for (const token of tokens || []) {
      if (typeof token.raw !== 'string' || !token.raw) continue;
      // Container prefixes and table pipe escapes are absent from Marked's
      // child raw strings. Match those transformations inside this parent only,
      // consuming every token (including code) so duplicate images stay exact.
      const pattern=token.raw.split('\n').map(line=>Array.from(line,char=>
        table && char==='|' ? '(?:\\\\)?\\|' : char.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
      ).join('')).join('(?:\\r\\n|\\r|\\n)'+(stripped?'[\\t >]*?':''));
      const matcher=new RegExp(pattern,'g');matcher.lastIndex=cursor;
      const match=matcher.exec(text);if(!match)break;
      const offset=match.index,raw=match[0];cursor=offset+raw.length;
      if(token.type==='image'){
        let path=token.href;try{path=decodeURIComponent(path);}catch{}
        if(localPath(path))result.push({path,start:base+offset,end:base+cursor,alt:token.text||'图片'});
      }else if(token.type==='table'){
        const lines=raw.split(/\r\n|\r|\n/);let lineOffset=0;
        for(let row=0;row<lines.length;row++){
          const cells=row===0?token.header:row>1?token.rows[row-2]:null;
          if(cells)visit(cells.map(cell=>({raw:cell.text,tokens:cell.tokens})),lines[row],base+offset+lineOffset,stripped,true);
          lineOffset+=lines[row].length+(raw.slice(lineOffset+lines[row].length).startsWith('\r\n')?2:1);
        }
      }else if(token.tokens)visit(token.tokens,raw,base+offset,stripped||token.type==='blockquote'||token.type==='list_item',table);
      else if(token.items)visit(token.items,raw,base+offset,stripped,table);
    }
  }
  visit(marked.lexer(item.text),item.text);
  return result;
}
function sourceFor(item, index) {
  if(item.type==='agentMessage'){
    const image=assistantImageReferences(item)[index];
    if(!image)throw mediaError('INDEX_OUT_OF_RANGE');
    return {kind:'path',value:image.path};
  }
  if (item.type === 'userMessage') {
    if (!Array.isArray(item.content) || index >= item.content.length) throw mediaError('INDEX_OUT_OF_RANGE');
    const content = item.content[index];
    if (content?.type === 'localImage') return { kind: 'path', value: content.path };
    if (content?.type === 'image') {
      if (typeof content.fileId === 'string') throw mediaError('FILE_REFERENCE_UNSUPPORTED');
      if (typeof content.url !== 'string') throw mediaError('INVALID_IMAGE_DATA');
      if (/^data:/i.test(content.url)) return { kind: 'data', value: content.url };
      throw mediaError('REMOTE_IMAGE_UNSUPPORTED');
    }
    throw mediaError('UNSUPPORTED_ITEM');
  }
  if (item.type === 'imageGeneration') {
    if (index !== 0) throw mediaError('INDEX_OUT_OF_RANGE');
    if (item.status !== 'completed') throw mediaError('MEDIA_NOT_READY');
    if (typeof item.savedPath === 'string' && item.savedPath) return { kind: 'path', value: item.savedPath };
    if (typeof item.fileId === 'string') throw mediaError('FILE_REFERENCE_UNSUPPORTED');
    if (typeof item.result !== 'string' || !item.result) throw mediaError('MEDIA_NOT_READY');
    if (/^data:/i.test(item.result)) return { kind: 'data', value: item.result };
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(item.result)) return { kind: 'data', value: 'data:image/png;base64,' + item.result };
    throw mediaError('REMOTE_IMAGE_UNSUPPORTED');
  }
  throw mediaError('UNSUPPORTED_ITEM');
}

// Pure display projection: keep original content indexes. Never read files,
// probe permissions, expose absolute paths, or copy inline image data here.
export function projectHistoryMedia(item, { threadId, turnId } = {}) {
  if (!item || !validId(item.id)) return [];
  const indexes = item.type === 'agentMessage' ? assistantImageReferences(item).map((_,index)=>index) : item.type === 'imageGeneration' ? [0] : item.type === 'userMessage' && Array.isArray(item.content)
    ? item.content.flatMap((content,index) => ['image','localImage'].includes(content?.type) ? [index] : []) : [];
  return indexes.flatMap(index => {
    const reference = validateMediaReference({ threadId, turnId, itemId: item.id, index });
    if (!reference) return [];
    try { sourceFor(item,index); return [{ type:'image', status:'candidate', reference, url:mediaUrl(reference) }]; }
    catch (error) { return [{ type:'image', ...unresolved(error.reason || 'UNSUPPORTED_ITEM',reference) }]; }
  });
}

function sniff(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP') return 'image/webp';
  throw mediaError('UNSUPPORTED_IMAGE_FORMAT');
}
function decodeImage(value, maxBytes) {
  if (typeof value !== 'string' || value.length > 4*Math.ceil(maxBytes/3)+128) throw mediaError('MEDIA_TOO_LARGE');
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw mediaError('INVALID_IMAGE_DATA');
  if (!TYPES.has(match[1])) throw mediaError('UNSUPPORTED_IMAGE_FORMAT');
  if (match[2].length % 4) throw mediaError('INVALID_IMAGE_DATA');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.toString('base64') !== match[2]) throw mediaError('INVALID_IMAGE_DATA');
  if (bytes.length > maxBytes) throw mediaError('MEDIA_TOO_LARGE');
  if (sniff(bytes) !== match[1]) throw mediaError('INVALID_IMAGE_DATA');
  return bytes;
}
function within(root, path) { const part=relative(root,path); return part === '' || part !== '..' && !part.startsWith('..'+sep) && !isAbsolute(part); }
function localPath(value) { return typeof value === 'string' && !value.includes('\0') && isAbsolute(value) && normalize(value) === value; }
function safeName(path, mime) {
  const cleaned = path ? basename(path).replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,150) : '';
  return cleaned || 'image.' + EXTENSIONS[mime];
}
function failureReason(error) {
  if (Object.hasOwn(MEDIA_REASONS,error?.reason)) return error.reason;
  if (['WORKSPACE_PERMISSION_REQUIRED','EACCES','EPERM'].includes(error?.code)) return 'PERMISSION_REQUIRED';
  if (['ENOENT','ENOTDIR'].includes(error?.code)) return 'MEDIA_NOT_FOUND';
  if (error?.code === 'ELOOP') return 'UNSAFE_FILE';
  return 'MEDIA_UNAVAILABLE';
}

export class HistoryMedia {
  constructor({ core, ensureAccess, allowedRoots = [join(homedir(),'.codex','attachments'),tmpdir()], resolveRoots,
    io = { lstat, realpath, open }, maxBytes = 8*MiB, rpcTimeoutMs = 4000, uid = process.getuid?.() } = {}) {
    if (!core || typeof core.call !== 'function') throw new Error('需要正式 Codex 历史读取接口');
    if (!Array.isArray(allowedRoots) || !allowedRoots.every(localPath)) throw new Error('附件根目录必须由服务端配置绝对规范路径');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 32*MiB) throw new Error('图片大小限制无效');
    this.core=core; this.ensureAccess=ensureAccess; this.allowedRoots=allowedRoots.slice(); this.resolveRoots=resolveRoots;
    this.io=io; this.maxBytes=maxBytes; this.rpcTimeoutMs=rpcTimeoutMs; this.uid=uid;
  }
  async read(reference) {
    const ref = validateMediaReference(reference); if (!ref) return unresolved('INVALID_REFERENCE');
    let response;
    try { response = await this.core.call('thread/items/read',{threadId:ref.threadId,turnId:ref.turnId,itemIds:[ref.itemId]},this.rpcTimeoutMs); }
    catch { return unresolved('HISTORY_UNAVAILABLE',ref); }
    if (!Array.isArray(response?.data)) return unresolved('HISTORY_UNAVAILABLE',ref);
    const entries=response.data.filter(entry=>entry?.item?.id===ref.itemId);
    if (!entries.length) return unresolved('ITEM_NOT_FOUND',ref);
    if (entries.length!==1 || entries[0].turnId!==ref.turnId) return unresolved('ITEM_MISMATCH',ref);
    try {
      const source=sourceFor(entries[0].item,ref.index);
      const bytes=source.kind==='data' ? decodeImage(source.value,this.maxBytes) : await this.#readPath(source.value,ref,entries[0].item);
      const mime=sniff(bytes),name=safeName(source.kind==='path'?source.value:null,mime);
      return { status:'ready',reference:ref,mime,size:bytes.length,name,body:bytes,headers:{
        'Content-Type':mime,'Content-Length':bytes.length,'Content-Disposition':`inline; filename="image.${EXTENSIONS[mime]}"; filename*=UTF-8''${encodeURIComponent(name).replaceAll("'",'%27')}`,
        'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",
        ETag:'"'+createHash('sha256').update(bytes).digest('hex')+'"',
      } };
    } catch (error) { return unresolved(failureReason(error),ref); }
  }
  async #readPath(path, reference, item) {
    if (!localPath(path)) throw mediaError('PATH_NOT_ALLOWED');
    const extra=this.resolveRoots ? await this.resolveRoots(reference,{item,sourcePath:path}) : [];
    if (!Array.isArray(extra) || !extra.every(localPath)) throw mediaError('PATH_NOT_ALLOWED');
    const roots=[...this.allowedRoots,...extra], root=roots.find(candidate=>within(candidate,path) && candidate!==path);
    if (!root) throw mediaError('PATH_NOT_ALLOWED');
    if (typeof this.ensureAccess !== 'function') throw mediaError('ACCESS_CHECK_REQUIRED');
    // The existing WorkspaceAccess check must run before any stat/realpath/open,
    // especially for Documents. Never fall back to App fs RPC on denial.
    if (await this.ensureAccess(path) === false) throw mediaError('PERMISSION_REQUIRED');
    const relativePath=relative(root,path),parts=relativePath.split(sep);
    let current=root;
    for (let index=0;index<parts.length;index++) {
      current=join(current,parts[index]); const entry=await this.io.lstat(current);
      if (entry.isSymbolicLink() || index<parts.length-1&&!entry.isDirectory()) throw mediaError('UNSAFE_FILE');
    }
    const info=await this.io.lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || this.uid!=null&&info.uid!==this.uid) throw mediaError('UNSAFE_FILE');
    if (!Number.isSafeInteger(info.size) || info.size<=0 || info.size>this.maxBytes) throw mediaError('MEDIA_TOO_LARGE');
    const canonicalRoot=await this.io.realpath(root), canonical=await this.io.realpath(path);
    if (!within(canonicalRoot,canonical) || canonicalRoot===canonical) throw mediaError('PATH_NOT_ALLOWED');
    const file=await this.io.open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const opened=await file.stat();
      if (!opened.isFile() || opened.dev!==info.dev || opened.ino!==info.ino || opened.size!==info.size || this.uid!=null&&opened.uid!==this.uid) throw mediaError('MEDIA_CHANGED');
      const buffer=Buffer.alloc(Math.min(opened.size,this.maxBytes)+1);
      let length=0;
      while(length<buffer.length){ const result=await file.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead; }
      const after=await file.stat();
      if(length>this.maxBytes)throw mediaError('MEDIA_TOO_LARGE');
      if(length!==info.size || after.size!==opened.size || after.mtimeMs!==opened.mtimeMs || after.ctimeMs!==opened.ctimeMs)throw mediaError('MEDIA_CHANGED');
      return buffer.subarray(0,length);
    } finally { await file.close(); }
  }
}
