import {stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

// A recorded session directory wins over the request. Only a new chat with an
// omitted cwd selects the default; invalid directories never change projects.
export async function resolveChatCwd({sessionCwd,requestedCwd,defaultCwd,resume=false}){
  if(resume&&!sessionCwd&&requestedCwd===undefined){
    return {error:'无法确认续聊会话的工作目录，请明确提供 cwd 后重试；不会使用默认目录'};
  }
  const cwd=sessionCwd||(requestedCwd===undefined?defaultCwd:requestedCwd);
  if(typeof cwd!=='string'||!isAbsolute(cwd)||cwd.includes('\0')){
    return {error:'工作目录 cwd 无效：必须是存在的绝对目录路径'};
  }
  try{
    if(!(await stat(cwd)).isDirectory())return {error:`工作目录 cwd 不是目录：${cwd}`};
  }catch{
    return {error:`工作目录 cwd 不存在或无法访问：${cwd}`};
  }
  return {cwd};
}
