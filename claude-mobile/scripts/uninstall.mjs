import {execFileSync} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** 停止并移除 Claude 手机入口的 LaunchAgent（保留口令与日志）。 */
const label='com.wengqiang.claude-mobile';
const domain=`gui/${process.getuid()}`;
const plistPath=join(homedir(),'Library','LaunchAgents',`${label}.plist`);
try{execFileSync('launchctl',['bootout',`${domain}/${label}`],{stdio:'ignore'});console.log('已停止 Claude 手机入口');}
catch{console.log('Claude 手机入口未在运行');}
await rm(plistPath,{force:true});
