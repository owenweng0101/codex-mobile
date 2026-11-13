import net from 'node:net';
import {open,readFile,readdir,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';

/**
 * 把手机消息送进桌面 App 正在运行的那个 Claude 会话。
 *
 * 桌面会话在 ~/.claude/sessions/<pid>.json 里公布一个 Unix socket；
 * 协议是 NDJSON：先发 auth 行，再发 user frame。socket 只负责入队，
 * 完整输出仍从该会话自己的 JSONL 增量读取。
 */

const SESSIONS=join(homedir(),'.claude','sessions');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export async function lastPermissionMode(file){
  try{
    const size=(await stat(file)).size;
    const length=Math.min(size,256*1024);
    const handle=await open(file,'r');
    const bytes=Buffer.alloc(length);
    await handle.read(bytes,0,length,size-length);
    await handle.close();
    const matches=[...bytes.toString('utf8').matchAll(/"permissionMode":"([^"]+)"/g)];
    return matches.length?matches[matches.length-1][1]:null;
  }catch{return null;}
}

export async function liveSession(sessionId,{directory=SESSIONS,isPidAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}}={}){
  let files=[];
  try{files=await readdir(directory);}catch{return null;}
  for(const name of files){
    if(!/^\d+\.json$/.test(name))continue;
    try{
      const value=JSON.parse(await readFile(join(directory,name),'utf8'));
      if(value.sessionId!==sessionId||typeof value.messagingSocketPath!=='string'||!isPidAlive(value.pid))continue;
      const keyFile=files.find(file=>file.startsWith(`${value.pid}.`)&&file.endsWith('.key'));
      let token=null;
      if(keyFile){
        try{token=JSON.parse(await readFile(join(directory,keyFile),'utf8')).peerToken??null;}catch{}
      }
      return {pid:value.pid,sessionId:value.sessionId,hostSessionId:value.hostSessionId,entrypoint:value.entrypoint,status:value.status,cwd:value.cwd,name:value.name??null,socketPath:value.messagingSocketPath,token};
    }catch{}
  }
  return null;
}

function connect(path){
  return new Promise((resolve,reject)=>{
    const socket=net.connect({path});
    const timer=setTimeout(()=>{socket.destroy();reject(Error('会话通道连接超时'));},5000);
    socket.once('connect',()=>{clearTimeout(timer);resolve(socket);});
    socket.once('error',error=>{clearTimeout(timer);reject(error);});
  });
}

/** 只负责投递；会话通道不返回正文。 */
export async function sendPeerMessage({socketPath,token,text,fromMode='prompting',msgId:stableId,priority='now',fileAttachments=[],name}){
  const socket=await connect(socketPath);
  const lines=[];
  if(token)lines.push(JSON.stringify({type:'auth',token}));
  if(typeof name==='string'&&name.trim())lines.push(JSON.stringify({msgV:1,msg_id:randomUUID(),type:'control',action:'rename',name:name.replace(/\s+/g,' ').trim().slice(0,72)}));
  const msgId=stableId||randomUUID();if(!/^[0-9a-f-]{36}$/i.test(msgId))throw Error('无效的消息编号');
  lines.push(JSON.stringify({
    msgV:1,msg_id:msgId,uuid:msgId,type:'user',
    message:{role:'user',content:text},
    priority:priority==='next'?'next':'now',from_mode:fromMode,...(fileAttachments.length?{file_attachments:fileAttachments}:{}),
  }));
  await new Promise((resolve,reject)=>{
    socket.write(lines.join('\n')+'\n',error=>{if(error)reject(error);else setTimeout(resolve,150);});
    socket.once('error',reject);
  });
  socket.end();
  return msgId;
}

/**
 * 从发送前的文件长度开始增量读，产出 JSONL 记录；遇到 last-prompt 结束。
 * 桌面端每完成一步就追加，手机上接近实时。
 */
export async function* tailTurn({file,startSize,timeoutMs=15*60*1000}){
  let offset=startSize;
  let buffer='';
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    let size=offset;
    try{size=(await stat(file)).size;}catch{await sleep(400);continue;}
    if(size>offset){
      const handle=await open(file,'r');
      try{
        const length=Math.min(size-offset,4*1024*1024);
        const bytes=Buffer.alloc(length);
        await handle.read(bytes,0,length,offset);
        offset+=length;
        buffer+=bytes.toString('utf8');
        let index;
        while((index=buffer.indexOf('\n'))!==-1){
          const line=buffer.slice(0,index).trim();
          buffer=buffer.slice(index+1);
          if(!line)continue;
          let record;
          try{record=JSON.parse(line);}catch{continue;}
          yield record;
        }
      }finally{await handle.close();}
    }
    await sleep(350);
  }
}
