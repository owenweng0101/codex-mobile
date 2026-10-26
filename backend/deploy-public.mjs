import{readFile,cp}from'node:fs/promises';import{spawn}from'node:child_process';import{homedir}from'node:os';import{join,dirname}from'node:path';import{fileURLToPath}from'node:url';
const root=dirname(fileURLToPath(import.meta.url)),support=join(homedir(),'Library/Application Support/CodexMobile');
const gateway=JSON.parse(await readFile(join(support,'gateway.json'),'utf8'));
await cp(join(root,'public'),join(support,'app/public'),{recursive:true});
const ssh=spawn('/usr/bin/ssh',['-i',process.env.CODEX_MOBILE_ADMIN_KEY||join(homedir(),'.ssh/oracle_proxy'),'-o','BatchMode=yes','root@'+gateway.host,'tar -xf - -C /opt/codex-mobile/public'],{stdio:['pipe','inherit','inherit']});
const tar=spawn('/usr/bin/tar',['-C',join(root,'public'),'-cf','-','index.html','app.js','style.css','vendor'],{stdio:['ignore','pipe','inherit'],env:{...process.env,COPYFILE_DISABLE:'1'}});
tar.stdout.pipe(ssh.stdin);ssh.stdin.on('error',()=>{});
const done=child=>new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('页面更新失败，退出码 '+code)));});
await Promise.all([done(ssh),done(tar)]);console.log('手机页面已更新到固定入口。');
