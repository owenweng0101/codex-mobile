import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** 打印 Claude 手机入口与三合一入口状态。 */
const port=Number(process.env.CLM_PORT??18903);
const label='com.wengqiang.claude-mobile';
const domain=`gui/${process.getuid()}`;
let loaded=false;
try{execFileSync('launchctl',['print',`${domain}/${label}`],{stdio:'pipe'});loaded=true;}catch{}
console.log(loaded?'LaunchAgent：已加载':'LaunchAgent：未加载');
try{
  const response=await fetch(`http://127.0.0.1:${port}/_claude/status`,{signal:AbortSignal.timeout(1500)});
  const value=await response.json();
  console.log('状态：'+value.status+'（'+value.provider+'）');
  console.log('Claude 运行环境：'+(value.upstreamReady?'可用':('未就绪 · '+(value.upstreamError??'未知'))));
  console.log('三合一入口：'+(value.phoneUrl??'未取到'));
}catch{
  console.log('网关未响应，请查看日志：'+join(homedir(),'Library','Application Support','ClaudeMobile','claude-mobile.error.log'));
  process.exitCode=1;
}
