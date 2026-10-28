import {isAbsolute,relative,resolve,extname} from 'node:path';

const media=new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp']);
const extensions=new Set(['.png','.jpg','.jpeg','.gif','.webp','.avif','.bmp']);
const inside=(root,path)=>{const rel=relative(root,path);return rel!==''&&rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);};
export function createFileReadService({api,baseServices}){
 async function location(params){
  if(!params||typeof params.path!=='string'||!params.path||params.path.includes('\0')||params.path.length>4096||params.workspaceIdentity||params.remoteSessionId||params.sourceServerId)throw Error('文件预览范围无效');
  const tree=await baseServices.project.readTree();
  const roots=[...new Set([tree.conversationWorkspacePath,...tree.projects.flatMap(p=>p.roots.map(r=>r.rootPath)),...tree.tasks.map(t=>t.workspacePath)].filter(p=>typeof p==='string'&&isAbsolute(p)).map(p=>resolve(p)))];
  const requestedRoot=params.workspacePath;
  if(requestedRoot!==undefined&&(!roots.includes(requestedRoot)||!isAbsolute(requestedRoot)))throw Error('工作目录不在已配对范围内');
  if(!isAbsolute(params.path)&&!requestedRoot)throw Error('相对文件路径缺少工作目录');
  const absolute=resolve(requestedRoot||'/',params.path);
  const root=requestedRoot||roots.filter(root=>inside(root,absolute)).sort((a,b)=>b.length-a.length)[0];
  if(!root||!inside(root,absolute))throw Error('无法访问工作目录以外的文件');
  const project=tree.projects.find(p=>p.roots.some(r=>r.rootPath===root));
  const query=new URLSearchParams({...project?{projectId:project.id,root}:{cwd:root},path:relative(root,absolute)});
  // Native backend revalidates workspace membership, macOS access and realpath
  // containment, including symlinks, on every request.
  return{absolute,query};
 }
 return{
  async readTextFile(params){
   const offset=params?.offset??0,length=params?.length??512*1024;
   if(offset!==0||!Number.isSafeInteger(length)||length<0||length>2*1024*1024)throw Error('文本预览范围无效');
   const {absolute,query}=await location(params),value=await api.get('/api/file?'+query);
   if(typeof value.content!=='string')throw Error('文本预览响应无效');
   const bytes=Buffer.from(value.content),content=new TextDecoder().decode(bytes.subarray(0,length),{stream:bytes.length>length});
   return{path:absolute,content,isBinary:false,truncated:!!value.truncated||bytes.length>length,size:value.size};
  },
  async stat(params){
   const {absolute,query}=await location(params),path=query.get('path'),parts=path.split('/'),name=parts.pop();
   if(!name)throw Error('无法读取工作目录自身的文件信息');
   query.set('path',parts.join('/'));
   const result=await api.get('/api/files?'+query),entry=result.entries?.find(item=>item.name===name);
   if(!entry||entry.type==='unavailable')throw Error(result.truncated?'目录内容过多，无法确认文件信息':'文件不存在或无法访问');
   if(!['file','directory'].includes(entry.type))throw Error('文件类型无效');
   return{type:entry.type,size:entry.size};
  },
  async readMediaPreview(params){
   const {absolute,query}=await location(params);if(!extensions.has(extname(absolute).toLowerCase()))throw Error('此文件不属于支持的图片预览类型');
   const result=await api.getMedia('/api/file-content?'+query);if(!media.has(result.mediaType))throw Error('媒体预览类型不匹配');
   const image={bytes:result.bytes,contentType:result.mediaType};if(image.bytes.length>10*1024*1024)throw Error('图片过大，请在电脑上打开');
   return{path:absolute,mediaType:image.contentType,dataBase64:image.bytes.toString('base64')};
  },
 };
}
