import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {plan,manage,checkPython,inspect} from '../mobile-services.mjs';
import {discoverTests} from '../test.mjs';
test('root plans keep existing labels and require explicit backend installation or stop',()=>{
 assert.equal(plan('start').length,6);assert.equal(plan('status').length,6);
 for(const action of ['install','stop']){assert.equal(plan(action).some(x=>x.id==='backend'),false);assert.equal(plan(action,['--codex-backend']).some(x=>x.id==='backend'),true);}
 assert.deepEqual(plan('install').map(x=>x.id),['ingress','dsh','claude','qr']);
 assert.throws(()=>plan('stop',['--force']),/Unknown option/);
});
test('start never restarts running jobs; stop leaves the backend and desktop host alone',async()=>{
 const calls=[],deps={uid:999,log:()=>{},python:async()=>{},readJob:async()=>({loaded:true,running:true,pid:1}),run:async(...args)=>{calls.push(args);return {};}};
 await manage('start',[],deps);assert.deepEqual(calls,[]);
 await manage('stop',[],deps);assert.equal(calls.length,5);
 assert.ok(calls.every(([command,args])=>command==='launchctl'&&args[0]==='bootout'&&!args[1].endsWith('/com.owen.codex-mobile')));
});
test('explicit backend stop fails before all mutations when work/PTY update guard rejects',async()=>{
 const calls=[];await assert.rejects(manage('stop',['--codex-backend'],{readJob:async()=>({loaded:true,running:true}),run:async(...args)=>calls.push(args),prepareUpdate:async()=>{throw Error('active task');}}),/active task/);
 assert.deepEqual(calls,[]);
});
test('Python is configurable with a portable default and a dependency probe',async()=>{
 const calls=[],run=async(...args)=>calls.push(args);await checkPython({env:{},run});await checkPython({env:{CODEX_MOBILE_PYTHON:'/custom/python'},run});
 assert.equal(calls[0][0],'python3');assert.equal(calls[1][0],'/custom/python');assert.deepEqual(calls[0][1],['-c','import pypdf, reportlab']);
 await assert.rejects(checkPython({run:async()=>{throw Error('missing');}}),/pypdf and reportlab/);
});
test('status omits launchctl environment secrets and inspection errors fail closed',async()=>{
 const run=async()=>({stdout:'state = running\npid = 23\nsecret = private-value'});assert.deepEqual(await inspect('fixture',{run}),{loaded:true,running:true,pid:23});
 await assert.rejects(inspect('fixture',{run:async()=>{throw Object.assign(Error('denied'),{code:1});}}),/Cannot inspect/);
});
test('default installer dry run is side-effect free; npm prepare cannot install services',async()=>{
 const calls=[];await manage('install',['--dry-run'],{run:async()=>{throw Error('must not execute');},log:value=>calls.push(value)});
 assert.equal(calls.length,4);assert.ok(calls.every(value=>!value.includes('pin-frontend')));
 const pkg=JSON.parse(await readFile(new URL('../../package.json',import.meta.url)));
 assert.equal(pkg.workspaces.length,5);for(const name of ['install','postinstall','preinstall'])assert.equal(pkg.scripts[name],undefined);
 const start=await readFile(new URL('../start.mjs',import.meta.url),'utf8');assert.doesNotMatch(start,/18901|createServer|createIngress/);
});
test('root test entry covers all three modules, QR and backend update protection',async()=>{
 const files=await discoverTests();for(const prefix of ['connection/','adapter/','backend/','dsh-mobile/','claude-mobile/','desktop/mobile-qr/'])assert.ok(files.some(path=>path.startsWith(prefix)),prefix);
 assert.ok(files.includes('backend/test/update-preflight.test.mjs'));
});
test('installation delegates QR with --apply, never installs the backend implicitly, and stops on first failure',async()=>{
 const calls=[],deps={python:async()=>{},preflight:async()=>{},log:()=>{},run:async(command,args)=>{calls.push({command,args});return {};}};
 await manage('install',[],deps);assert.equal(calls.length,4);
 assert.ok(calls.every(row=>!row.args[0].endsWith('/backend/install-local.mjs')));
 assert.ok(calls.at(-1).args[0].endsWith('/desktop/mobile-qr/install.mjs'));assert.equal(calls.at(-1).args[1],'--apply');
 let attempted=0;await assert.rejects(manage('install',[],{...deps,run:async()=>{attempted++;throw Error('failed');}}),/remaining installers/);
 assert.equal(attempted,1);
});
