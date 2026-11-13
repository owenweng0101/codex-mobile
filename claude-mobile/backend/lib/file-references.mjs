import {marked} from '../vendor/marked.esm.js';
import {resolve,join,dirname,extname,sep} from 'node:path';
import {homedir} from 'node:os';
import {constants} from 'node:fs';
import {open,realpath,stat} from 'node:fs/promises';

export function localPath(value,cwd,asUrl=false){
  if(typeof value!=='string'||!value||value.startsWith('#'))return null;
  let path=value.replace(/^file:\/\//,'');
  if(/^[a-z][a-z\d+.-]*:/i.test(path))return null;
  if(asUrl){try{path=decodeURIComponent(path);}catch{}}
  if(path.includes('\0'))return null;
  return path.startsWith('~/')?join(homedir(),path.slice(2)):resolve(cwd,path);
}
export function referencedPaths(raw,cwd){
  const paths=new Set();
  const inspect=value=>{
    if(typeof value==='string'){
      if(/^(?:\/|~\/|\.\.?\/)/.test(value)&&!value.includes('\n')){const path=localPath(value,cwd);if(path)paths.add(path);}
      try{marked.walkTokens(marked.lexer(value),token=>{if(token.type==='link'||token.type==='image'){const path=dependencyPath(token.href,cwd);if(path)paths.add(path);}});}catch{}
    }else if(Array.isArray(value))value.forEach(inspect);
    else if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){if(!['data','signature','thinking'].includes(key))inspect(child);}
  };
  for(const line of raw.split('\n')){try{const record=JSON.parse(line);inspect(record.message?.content);}catch{}}
  return paths;
}

// URL syntax belongs to link destinations, not to already decoded file API paths.
// Strip suffixes before decoding so %23/%3F remain literal filename characters.
function dependencyPath(value,cwd){
  if(typeof value!=='string'||!value||value.startsWith('#')||value.startsWith('?'))return null;
  let url=value.split(/[?#]/,1)[0].replace(/:\d+(?::\d+)?$/,'');
  if(url.startsWith('file:///'))url=url.slice(7);
  else if(/^[a-z][a-z\d+.-]*:/i.test(url))return null;
  try{url=decodeURIComponent(url);}catch{return null;}
  if(!url||url.startsWith('//')||/[\u0000-\u001f\u007f\\]/.test(url))return null;
  return localPath(url,cwd);
}

async function boundedRead(file,limit){
  // Nonblocking open lets the regular-file check reject FIFOs without hanging.
  const handle=await open(file,constants.O_RDONLY|constants.O_NONBLOCK);
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.size>limit)return null;
    // One extra byte detects growth without permitting an unbounded readFile.
    const bytes=Buffer.alloc(info.size+1);let offset=0;
    while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,null);if(!result.bytesRead)break;offset+=result.bytesRead;}
    return offset>info.size?null:bytes.subarray(0,offset);
  }finally{await handle.close();}
}

export const MARKDOWN_DEPENDENCY_LIMITS=Object.freeze({maxDepth:8,maxFiles:64,maxFileBytes:2*1024*1024,maxTotalBytes:10*1024*1024});
const isMarkdown=path=>['.md','.markdown'].includes(extname(path).toLowerCase());

/**
 * Authorize a dependency of a reachable Markdown base, never a whole directory.
 * path/base are decoded filesystem paths (relative to cwd); allowedPaths must be
 * the unexpanded Set returned by referencedPaths(sessionTranscript,cwd).
 * Only marked link/image tokens count; raw HTML, code and bare paths do not.
 * Bases are reached from directly allowed .md/.markdown roots through link tokens only,
 * under MARKDOWN_DEPENDENCY_LIMITS (root depth 0). No authorization cache survives
 * a request. Missing/unreadable/non-file/oversized bases fail closed. This does not
 * check target existence or MIME/size limits; the serving endpoint still must.
 */
export async function isReferencedDependency(path,base,allowedPaths,cwd){
  try{
    const file=localPath(path,cwd),source=localPath(base,cwd);
    if(!file||!source||!isMarkdown(source)||!(allowedPaths instanceof Set))return false;
    const limits=MARKDOWN_DEPENDENCY_LIMITS,queue=[],seen=new Set();let budget=limits.maxTotalBytes,count=0;
    const enqueue=(path,depth)=>{if(seen.has(path)||queue.length>=limits.maxFiles)return;seen.add(path);queue.push({path,depth});};
    if(allowedPaths.has(source))enqueue(source,0);
    else for(const root of allowedPaths){if(typeof root==='string'&&isMarkdown(root))enqueue(root,0);}
    for(let index=0;index<queue.length&&count<limits.maxFiles;index++){
      const current=queue[index];let bytes;
      count++;
      try{bytes=await boundedRead(current.path,Math.min(limits.maxFileBytes,budget));}catch{continue;}
      if(!bytes)continue;budget-=bytes.length;
      let found=false;
      marked.walkTokens(marked.lexer(bytes.toString('utf8')),token=>{
        if(token.type!=='link'&&token.type!=='image')return;
        const dependency=dependencyPath(token.href,dirname(current.path));if(!dependency)return;
        if(current.path===source&&dependency===file)found=true;
        if(current.depth<limits.maxDepth&&token.type==='link'&&isMarkdown(dependency))enqueue(dependency,current.depth+1);
      });
      if(current.path===source)return found;
    }
    return false;
  }catch{return false;}
}
/** Resolve relative links in the same desktop-owned session folders. Every
 * candidate still needs explicit transcript/Markdown dependency authorization.
 * Existing primary-cwd files retain priority; no directory-wide grant. */
export async function resolveReferencedFile({raw,cwd,requested,base=null,folders=[]}){
  const roots=[...new Set([cwd,...folders].filter(value=>typeof value==='string'&&value))];
  for(const root of roots){
    const baseFile=base?localPath(base,root):null;
    const file=localPath(requested,baseFile?dirname(baseFile):root);
    if(!file)continue;
    const allowed=referencedPaths(raw,root);
    if(!allowed.has(file)&&!await isReferencedDependency(file,baseFile,allowed,root))continue;
    try{const info=await stat(file);if(info.isFile())return {file,info};}catch{}
  }
  return null;
}

const IMAGE_TYPES={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml'};
async function replaceAsync(text,pattern,replace){
  const matches=[...text.matchAll(pattern)],values=[];
  // Stable document order also makes the shared asset budget deterministic.
  for(const match of matches)values.push(await replace(...match));
  for(let i=matches.length-1;i>=0;i--){const match=matches[i];text=text.slice(0,match.index)+values[i]+text.slice(match.index+match[0].length);}
  return text;
}
function htmlAttributes(text){
  const attributes=[],pattern=/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
  let offset=0;
  while(offset<text.length){
    if(!text.slice(offset).trim())break;
    pattern.lastIndex=offset;const match=pattern.exec(text);if(!match)return null;
    attributes.push({name:match[1].toLowerCase(),value:match[2]??match[3]??match[4],start:offset,end:pattern.lastIndex});offset=pattern.lastIndex;
  }
  return attributes;
}
function htmlUrl(value){
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi,entity=>{
    const key=entity.slice(1,-1).toLowerCase(),named={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'};
    if(key in named)return named[key];
    const point=key.startsWith('#x')?parseInt(key.slice(2),16):Number(key.slice(1));
    return point>0&&point<=0x10ffff?String.fromCodePoint(point):'\0';
  });
}
/** Embed explicit image/CSS/script assets inside the HTML directory, including realpath checks. */
export async function embedHtmlAssets(file,html){
  const root=dirname(resolve(file));let budget=10*1024*1024,realRoot;
  const read=async(value,base)=>{
    const path=dependencyPath(value,base);
    if(!path||!path.startsWith(root+sep))return null;
    try{
      realRoot??=await realpath(root);const target=await realpath(path);
      if(!target.startsWith(realRoot+sep))return null;
      const bytes=await boundedRead(target,Math.min(2*1024*1024,budget));if(!bytes)return null;
      budget-=bytes.length;return {path,bytes};
    }catch{return null;}
  };
  const image=async(value,base)=>{
    const type=IMAGE_TYPES[extname(value).toLowerCase()];if(!type)return value;
    const asset=await read(value,base);return asset?'data:'+type+';base64,'+asset.bytes.toString('base64'):value;
  };
  const css=async(text,base)=>replaceAsync(text,/url\(\s*["']?([^"')]+)["']?\s*\)/gi,async(full,url)=>{const result=await image(url,base);return result===url?full:'url("'+result+'")';});
  html=await replaceAsync(html,/<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi,async(full,url)=>{
    if(!url.endsWith('.css'))return full;const asset=await read(url,root);if(!asset)return full;
    return '<style>'+await css(asset.bytes.toString('utf8'),dirname(asset.path))+'</style>';
  });
  html=await replaceAsync(html,/(<img\b[^>]*\bsrc\s*=\s*["'])([^"']+)(["'])/gi,async(full,prefix,url,suffix)=>prefix+await image(url,root)+suffix);
  html=await replaceAsync(html,/<style\b([^>]*)>([\s\S]*?)<\/style>/gi,async(full,attributes,text)=>'<style'+attributes+'>'+await css(text,root)+'</style>');
  html=await replaceAsync(html,/(\bstyle\s*=\s*)(["'])([\s\S]*?)\2/gi,async(full,prefix,quote,text)=>{
    const result=await css(text,root);if(result===text)return full;
    return prefix+quote+result.replace(/"/g,'&quot;').replace(/'/g,'&#39;')+quote;
  });
  // Consume comments, raw-text elements and complete tags so apparent scripts
  // inside attributes/comments/textarea or another script are never followed.
  return replaceAsync(html,/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)(<\/\1\s*>)|<[a-z][\w:-]*\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi,async(full,tag,attributes,body,closing)=>{
    if(tag?.toLowerCase()!=='script')return full;
    const parsed=htmlAttributes(attributes);if(!parsed)return full;
    const sources=parsed.filter(item=>item.name==='src');if(sources.length!==1||!sources[0].value)return full;
    const asset=await read(htmlUrl(sources[0].value),root);if(!asset)return full;
    const script=asset.bytes.toString('utf8');
    // Preserve JS bytes; do not let an embedded closing tag break HTML parsing.
    if(/<\/script\b/i.test(script))return full;
    for(const attr of parsed.filter(item=>item.name==='src'||item.name==='integrity').reverse())attributes=attributes.slice(0,attr.start)+attributes.slice(attr.end);
    return '<script'+attributes+'>'+script+closing;
  });
}
