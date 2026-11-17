import {readFile,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * 复用 Magpie 为本机 Claude Code 生成的启动配置（模型网关、临时口令、模型清单），
 * 再以 headless 方式拉起 Claude Code。口令只在本进程与子进程环境里使用，
 * 不写日志、不进手机页面。桌面 App 的登录态不动。
 */

const HOME=homedir();
const LAUNCH_SETTINGS=join(HOME,'.config/magpie/claude-launch/settings.json');
const CLI_ROOTS=[
  join(HOME,'Library/Application Support/Claude-3p/claude-code'),
  join(HOME,'Library/Application Support/Claude/claude-code'),
];
const FALLBACK_BINS=[
  fileURLToPath(new URL('../../bin/claude',import.meta.url)),
];

const versionValue=v=>v.split('.').map(n=>Number(n)||0);
const compareVersionsDesc=(a,b)=>{
  const x=versionValue(a),y=versionValue(b);
  for(let i=0;i<Math.max(x.length,y.length);i++){if((y[i]||0)!==(x[i]||0))return (y[i]||0)-(x[i]||0);}
  return 0;
};

async function listDirs(path){
  try{return (await readdir(path,{withFileTypes:true})).filter(v=>v.isDirectory()).map(v=>v.name);}catch{return[];}
}

/** 找到桌面 App 自带的最新 Claude Code 可执行文件。 */
export async function resolveCli(){
  const override=process.env.CLM_CLAUDE_BIN;
  if(override&&existsSync(override))return override;
  for(const root of CLI_ROOTS){
    const versions=(await listDirs(root)).sort(compareVersionsDesc);
    for(const version of versions){
      const base=join(root,version);
      const direct=join(base,'claude.app/Contents/MacOS/claude');
      if(existsSync(direct))return direct;
      for(const hash of await listDirs(base)){
        const nested=join(base,hash,'claude.app/Contents/MacOS/claude');
        if(existsSync(nested))return nested;
      }
    }
  }
  for(const bin of FALLBACK_BINS)if(existsSync(bin))return bin;
  return null;
}

/** 读取 Magpie 生成的启动配置：网关地址、临时口令、可选模型。 */
export async function readMagpieLaunch(){
  let parsed;
  try{parsed=JSON.parse(await readFile(LAUNCH_SETTINGS,'utf8'));}catch{
    throw Error('未找到 Magpie 的 Claude Code 启动配置，请先在电脑上运行一次 magpie claude run');
  }
  const env=parsed.env??{};
  if(!env.ANTHROPIC_BASE_URL||!env.ANTHROPIC_AUTH_TOKEN)throw Error('Magpie 启动配置缺少网关地址或口令');
  const seen=new Set();
  const models=[];
  for(const option of parsed.modelPicker?.options??[]){
    const model=typeof option?.model==='string'?option.model:'';
    if(!model||seen.has(model))continue;
    seen.add(model);
    models.push({model,label:typeof option.label==='string'?option.label:model});
  }
  return {baseUrl:env.ANTHROPIC_BASE_URL,token:env.ANTHROPIC_AUTH_TOKEN,env,models};
}

const PASS_THROUGH_ENV=[
  'CLAUDE_CODE_MODEL_CAPABILITIES','CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS','CLAUDE_CODE_MAX_OUTPUT_TOKENS','ENABLE_TOOL_SEARCH',
];

/** 以 Magpie 网关为上游构造子进程环境；模型统一覆盖。 */
export function buildTurnEnv(launch,model){
  const env={...process.env};
  for(const key of Object.keys(env)){
    if(key.startsWith('ANTHROPIC_'))delete env[key];
  }
  const path=[join(HOME,'.local/bin'),'/opt/homebrew/bin','/usr/local/bin',env.PATH].filter(Boolean).join(':');
  Object.assign(env,{
    PATH:path,
    ANTHROPIC_BASE_URL:launch.baseUrl,
    ANTHROPIC_AUTH_TOKEN:launch.token,
    ANTHROPIC_MODEL:model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL:model,
    ANTHROPIC_DEFAULT_SONNET_MODEL:model,
    ANTHROPIC_DEFAULT_OPUS_MODEL:model,
    ANTHROPIC_SMALL_FAST_MODEL:model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
  });
  for(const key of PASS_THROUGH_ENV)if(launch.env[key])env[key]=launch.env[key];
  return env;
}

export const PERMISSION_MODES=new Set(['default','acceptEdits','plan','bypassPermissions','auto']);

/**
 * 跑一个 headless 回合，按行产出解析后的 JSON 事件。
 * @returns {{child: import('node:child_process').ChildProcess, events: AsyncGenerator<object>}}
 */
export async function startTurn({cli,model,env,cwd,prompt,sessionId,resume,fork,permissionMode,addDirs=[]}){
  if(!cli)throw Error('未找到 Claude Code 可执行文件');
  const args=['-p',prompt,'--output-format','stream-json','--include-partial-messages','--verbose','--model',model];
  args.push('--permission-mode',PERMISSION_MODES.has(permissionMode)?permissionMode:'bypassPermissions');
  for(const dir of addDirs)if(typeof dir==='string'&&dir.startsWith('/'))args.push('--add-dir',dir);
  if(resume){args.push('--resume',resume);if(fork)args.push('--fork-session');}
  else if(sessionId)args.push('--session-id',sessionId);
  const child=spawn(cli,args,{cwd,env,stdio:['ignore','pipe','pipe']});
  let stderr='';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{
    stderr+=chunk;
    if(stderr.length>16000)stderr=stderr.slice(-8000);
  });
  const events=(async function*(){
    let buffer='';
    child.stdout.setEncoding('utf8');
    for await(const chunk of child.stdout){
      buffer+=chunk;
      let index;
      while((index=buffer.indexOf('\n'))!==-1){
        const line=buffer.slice(0,index).trim();
        buffer=buffer.slice(index+1);
        if(!line)continue;
        try{yield JSON.parse(line);}catch{}
      }
    }
    const tail=buffer.trim();
    if(tail){try{yield JSON.parse(tail);}catch{}}
  })();
  return {child,events,stderr:()=>stderr};
}
