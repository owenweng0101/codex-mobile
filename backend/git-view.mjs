import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname} from 'node:path';

const execute=promisify(execFile),MAX_DIFF=512*1024,MAX_INPUT=2*1024*1024;
const outside=path=>path==='..'||path.startsWith('../')||isAbsolute(path);
const invalid=message=>Object.assign(new Error(message),{statusCode:400});
function relativePath(root,path,{absolute=false}={}) {
  if(typeof path!=='string'||path.includes('\0')||path.length>4096||(!absolute&&isAbsolute(path))||/^[A-Za-z]:[\\/]/.test(path))throw invalid('请输入工作目录内的相对路径');
  const rel=relative(root,resolve(root,path));if(outside(rel))throw invalid('无法访问工作目录以外的改动');return rel;
}
async function confinedPath(root,path) {
  let target=resolve(root,path);
  while(true){
    try{const actual=await realpath(target);if(outside(relative(root,actual)))throw invalid('无法访问工作目录以外的改动');return;}
    catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;const parent=dirname(target);if(parent===target)throw error;target=parent;}
  }
}
const empty=(source,extra={})=>({available:false,source,branch:null,files:[],diff:'',truncated:false,counts:{staged:0,unstaged:0,untracked:0},...extra});
function parseStatus(output,root,repository) {
  const parts=output.split('\0'),files=[];
  for(let i=0;i<parts.length;i++){
    const row=parts[i];if(!row||row.length<4)continue;const code=row.slice(0,2),previous=(code.includes('R')||code.includes('C'))?parts[++i]:null;
    let path;try{path=relativePath(root,resolve(repository,row.slice(3)),{absolute:true});}catch{continue;}
    if(!path)continue;const untracked=code==='??',staged=code[0]!==' '&&code[0]!=='?',unstaged=untracked||code[1]!==' '&&code[1]!=='?';
    const item={path,status:code.trim(),indexStatus:code[0],worktreeStatus:code[1],staged,unstaged,untracked};
    if(previous){try{item.previousPath=relativePath(root,resolve(repository,previous),{absolute:true});}catch{}}
    files.push(item);
  }
  return files;
}
function quotedPath(text) {
  if(!text.startsWith('"'))return text;
  if(!text.endsWith('"'))throw invalid('差异路径格式无法核验');
  const bytes=[],escapes={t:9,n:10,r:13,b:8,f:12,v:11,'\\':92,'"':34};
  for(let i=1;i<text.length-1;i++){
    if(text[i]!=='\\'){const code=text.codePointAt(i),char=String.fromCodePoint(code);bytes.push(...Buffer.from(char));if(code>0xffff)i++;continue;}
    const next=text[++i];if(/[0-7]/.test(next||'')){let octal=next;while(octal.length<3&&/[0-7]/.test(text[i+1]||''))octal+=text[++i];bytes.push(parseInt(octal,8));}
    else if(Object.hasOwn(escapes,next))bytes.push(escapes[next]);else throw invalid('差异路径格式无法核验');
  }
  return Buffer.from(bytes).toString('utf8');
}
function patchPath(line,prefix) {
  if(line==null)return undefined;
  let path=quotedPath(line.split('\t')[0]);if(path==='/dev/null')return null;if(path.startsWith(prefix+'/'))path=path.slice(2);return path;
}
function blockPaths(block) {
  if((block.match(/^--- /gm)||[]).length>1||(block.match(/^\+\+\+ /gm)||[]).length>1)throw invalid('差异文件边界无法核验');
  const oldLine=/^--- (.*)$/m.exec(block)?.[1],newLine=/^\+\+\+ (.*)$/m.exec(block)?.[1];
  if(oldLine!==undefined&&newLine!==undefined)return{old:patchPath(oldLine,'a'),next:patchPath(newLine,'b')};
  const renameFrom=/^rename from (.*)$/m.exec(block)?.[1],renameTo=/^rename to (.*)$/m.exec(block)?.[1];
  if(renameFrom!==undefined&&renameTo!==undefined)return{old:quotedPath(renameFrom),next:quotedPath(renameTo)};
  const header=/^diff --git (.*)$/m.exec(block)?.[1];if(!header)return null;
  let match=/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(header);
  if(!match){const boundary=header.lastIndexOf(' b/');if(boundary<0)return null;match=[null,header.slice(0,boundary),header.slice(boundary+1)];}
  return{old:patchPath(match[1],'a'),next:patchPath(match[2],'b')};
}

function patchName(path,prefix){const name=prefix+'/'+path;return /[\s"\\]/.test(name)?JSON.stringify(name):name;}
function contentPatch(path,content,added){
  if(content.includes('\0'))throw invalid('二进制文件记录没有可显示的文本差异');
  const normalized=content.replace(/\r\n/g,'\n'),lines=normalized?normalized.split('\n'):[];if(lines.at(-1)==='')lines.pop();
  const old=patchName(path,'a'),next=patchName(path,'b');let patch=`diff --git ${old} ${next}\n${added?'new':'deleted'} file mode 100644\n--- ${added?'/dev/null':old}\n+++ ${added?next:'/dev/null'}\n`;
  if(lines.length){patch+=added?`@@ -0,0 +1,${lines.length} @@\n`:`@@ -1,${lines.length} +0,0 @@\n`;patch+=lines.map(line=>(added?'+':'-')+line).join('\n')+'\n';if(!normalized.endsWith('\n'))patch+='\\ No newline at end of file\n';}
  return patch;
}
function validHunks(text){
  let old=0,next=0,seen=false;
  for(const line of text.split('\n')){
    if(line.startsWith('@@ ')){
      if(old||next)return false;const hunk=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);if(!hunk)return false;
      old=hunk[2]===undefined?1:Number(hunk[2]);next=hunk[4]===undefined?1:Number(hunk[4]);seen=true;continue;
    }
    if(line==='\\ No newline at end of file')continue;
    if(!old&&!next){if(line==='')continue;return false;}
    if(line[0]===' ') {old--;next--;}else if(line[0]==='-')old--;else if(line[0]==='+')next--;else return false;
    if(old<0||next<0)return false;
  }
  return seen&&old===0&&next===0;
}
function updatePatch(path,next,diff,base){
  const text=diff.trimStart(),oldHeader=patchName(path,'a'),nextHeader=patchName(next,'b');
  if(text.startsWith('@@ ')){if(!validHunks(text))throw invalid('更新记录不是完整统一差异');return `diff --git ${oldHeader} ${nextHeader}\n--- ${oldHeader}\n+++ ${nextHeader}\n${text}${text.endsWith('\n')?'':'\n'}`;}
  if(!text.startsWith('diff --git ')&&!text.startsWith('--- '))throw invalid('更新记录没有真实统一差异');
  if((text.match(/^diff --git /gm)||[]).length>1)throw invalid('单文件记录包含多文件差异');
  const parsed=blockPaths(text);if(!parsed||parsed.old===null||parsed.next===null||relativePath(base,parsed.old,{absolute:true})!==path||relativePath(base,parsed.next,{absolute:true})!==next)throw invalid('统一差异与文件记录不一致');
  const hunkAt=text.search(/^@@ /m);if(hunkAt<0||!validHunks(text.slice(hunkAt)))throw invalid('更新记录没有完整统一差异');
  for(const line of text.slice(0,hunkAt).split('\n'))if(line&&!/^(diff --git |index |--- |\+\+\+ |old mode |new mode |similarity index |rename from |rename to )/.test(line))throw invalid('更新记录的差异前缀无法核验');
  const hunks=text.slice(hunkAt);return `diff --git ${oldHeader} ${nextHeader}\n--- ${oldHeader}\n+++ ${nextHeader}\n${hunks}${hunks.endsWith('\n')?'':'\n'}`;
}
async function projectRecordedChanges(base,turn,selected){
  if(!turn.fileChanges.some(record=>record?.status==='completed'&&typeof record.id==='string'&&Array.isArray(record.changes)&&record.changes.length))return empty('turn',{turnId:turn.turnId,reason:'no-completed-file-changes',message:'这轮尚无已完成的文件修改记录'});
  const files=[],patches=[];let excludedCount=0,truncated=false,recordCount=0,characters=0;
  records:for(const record of turn.fileChanges||[]){
    if(record?.status!=='completed'||typeof record.id!=='string')continue;
    for(const [changeIndex,change] of (Array.isArray(record.changes)?record.changes:[]).entries()){
      if(++recordCount>500){truncated=true;break;}
      try{
        if(typeof change?.diff!=='string')throw invalid('文件记录没有正文');if(change.diff.length>MAX_INPUT){truncated=true;throw invalid('文件记录过大');}
        characters+=change.diff.length;if(characters>MAX_INPUT){truncated=true;break records;}
        const path=relativePath(base,change.path,{absolute:true}),kind=change.kind?.type,next=kind==='update'&&typeof (change.kind.move_path??change.kind.movePath)==='string'?relativePath(base,change.kind.move_path??change.kind.movePath,{absolute:true}):path;
        if(!path||!next)throw invalid('文件记录路径无效');await confinedPath(base,path);await confinedPath(base,next);
        const patch=kind==='add'?contentPatch(path,change.diff,true):kind==='delete'?contentPatch(path,change.diff,false):kind==='update'?updatePatch(path,next,change.diff,base):null;if(!patch)throw invalid('未知文件改动类型');
        const status=kind==='add'?'A':kind==='delete'?'D':path!==next?'R':'M',file={path:next,status,indexStatus:' ',worktreeStatus:' ',staged:false,unstaged:false,untracked:false,recordId:record.id,changeIndex,...(path!==next?{previousPath:path}:{})};
        if(selected===null||next===selected){files.push(file);patches.push(patch);}
      }catch{excludedCount++;}
    }
    if(recordCount>500)break;
  }
  if(selected!==null&&!files.length)throw invalid('该文件不在这轮已完成的文件记录中');
  const diff=patches.join('\n');return{available:true,source:'turn',turnId:turn.turnId,recordedChanges:true,message:'按本轮已完成的文件修改逐次展示，未合并为净差异。',branch:null,files,diff:diff.slice(0,MAX_DIFF),truncated:truncated||diff.length>MAX_DIFF,excludedCount,counts:{staged:0,unstaged:0,untracked:0},...(selected!==null?{selectedPath:selected}:{})};
}

export async function projectTurnDiff(root,turn,selectedPath) {
  const base=await realpath(root);
  if(!turn||typeof turn.turnId!=='string'||!turn.turnId||typeof turn.diff!=='string'&&!Array.isArray(turn.fileChanges))return empty('turn',{reason:'no-turn-diff',message:'尚无可核验的最近一轮差异'});
  const selected=selectedPath==null?null:relativePath(base,selectedPath);if(selected!==null)await confinedPath(base,selected);
  if(typeof turn.diff!=='string')return projectRecordedChanges(base,turn,selected);
  const input=turn.diff.slice(0,MAX_INPUT),blocks=input.split(/(?=^diff --git )/m).filter(Boolean),files=[],patches=[];let excludedCount=0;
  for(const block of blocks.slice(0,500)){
    try{
      const parsed=blockPaths(block);if(!parsed)throw Error('unrecognized patch');
      const old=parsed.old===null?null:relativePath(base,parsed.old,{absolute:true}),next=parsed.next===null?null:relativePath(base,parsed.next,{absolute:true});
      if(!old&&!next)throw Error('missing path');for(const path of [old,next].filter(Boolean))await confinedPath(base,path);
      const path=next||old,status=old===null?'A':next===null?'D':old!==next?'R':'M';
      const file={path,status,indexStatus:' ',worktreeStatus:' ',staged:false,unstaged:false,untracked:false,...(old&&next&&old!==next?{previousPath:old}:{})};
      if(!files.some(item=>item.path===path))files.push(file);if(selected===null||path===selected)patches.push(block);
    }catch{excludedCount++;}
  }
  if(selected!==null&&!files.some(file=>file.path===selected))throw invalid('该文件不在这轮可核验的改动中');
  const diff=patches.join('');return{available:true,source:'turn',turnId:turn.turnId,branch:null,files:selected===null?files:files.filter(file=>file.path===selected),diff:diff.slice(0,MAX_DIFF),truncated:turn.diff.length>MAX_INPUT||diff.length>MAX_DIFF||blocks.length>500,excludedCount,counts:{staged:0,unstaged:0,untracked:0},...(selected!==null?{selectedPath:selected}:{})};
}

export async function readWorkspaceGit(root,selectedPath,{source='all',turn}={}) {
  if(!['all','staged','unstaged','turn'].includes(source))throw invalid('不支持的差异来源');
  if(source==='turn')return projectTurnDiff(root,turn,selectedPath);
  const base=await realpath(root),selected=selectedPath==null?null:relativePath(base,selectedPath);if(selected!==null)await confinedPath(base,selected);
  const git=async(args,{difference=false}={})=>{
    try{return(await execute('git',['--no-optional-locks','--no-pager','--literal-pathspecs','-c','core.fsmonitor=false','-c','core.quotePath=false',...args],{cwd:base,timeout:10000,maxBuffer:MAX_INPUT})).stdout;}
    catch(error){if(difference&&error.code===1)return error.stdout||'';throw error;}
  };
  let repository,branch;try{repository=(await git(['rev-parse','--show-toplevel'])).replace(/\r?\n$/,'');try{branch=(await git(['symbolic-ref','--short','HEAD'])).trim();}catch{branch=(await git(['rev-parse','--short','HEAD'])).trim();}}catch{return empty(source);}
  let status,filesTruncated=false;
  try{status=await git(['status','--porcelain=v1','-z','--untracked-files=all','--','.']);}
  catch(error){if(error.code!=='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')throw error;const partial=error.stdout||'';status=partial.slice(0,partial.lastIndexOf('\0')+1);filesTruncated=true;}
  const allFiles=parseStatus(status,base,repository);
  if(selected!==null&&!allFiles.some(file=>file.path===selected))throw invalid('该文件不在当前改动中');
  const counts={staged:allFiles.filter(file=>file.staged).length,unstaged:allFiles.filter(file=>file.unstaged).length,untracked:allFiles.filter(file=>file.untracked).length};
  const files=allFiles.filter(file=>(source==='all'||(source==='staged'?file.staged:file.unstaged))&&(selected===null||file.path===selected));
  const selectedFile=allFiles.find(file=>file.path===selected),paths=selected===null?['.']:[selected,...(selectedFile?.previousPath?[selectedFile.previousPath]:[])],patches=[];let truncated=filesTruncated,excludedCount=0;
  for(const cached of source==='all'?[false,true]:[source==='staged']){
    try{patches.push(await git(['diff','--relative','--no-ext-diff','--no-textconv','--no-color',...(cached?['--cached']:[]),'--',...paths]));}
    catch(error){if(error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'){patches.push(error.stdout||'');truncated=true;}else throw error;}
  }
  if(source!=='staged')for(const file of files.filter(file=>file.untracked).slice(0,100)){
    if(patches.reduce((size,patch)=>size+patch.length,0)>MAX_DIFF){truncated=true;break;}
    try{await confinedPath(base,file.path);}
    catch(error){if(error.statusCode===400){file.unavailable=true;excludedCount++;continue;}throw error;}
    try{patches.push(await git(['diff','--no-index','--no-ext-diff','--no-textconv','--no-color','--','/dev/null',file.path],{difference:true}));}
    catch(error){if(error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'){patches.push(error.stdout||'');truncated=true;}else throw error;}
  }
  const diff=patches.join('');truncated ||= diff.length>MAX_DIFF||files.filter(file=>file.untracked).length>100;
  return{available:true,source,branch,files,diff:diff.slice(0,MAX_DIFF),truncated,filesTruncated,counts,excludedCount,...(selected!==null?{selectedPath:selected}:{})};
}
