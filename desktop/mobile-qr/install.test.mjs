import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {launchAgentPlan, installQrAgent, LABEL} from './install.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'qr-install-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=join(directory,'repo & mobile chats'),home=join(directory,'home');
  for(const path of ['desktop/mobile-qr','connection'])await mkdir(join(root,path),{recursive:true});
  for(const path of ['desktop/mobile-qr/update.mjs','connection/control-client.mjs'])await writeFile(join(root,path),'// installation fixture');
  return {root,home};
}

test('LaunchAgent points directly to this checkout, escapes paths and contains no credentials', () => {
  const plan=launchAgentPlan({root:'/example/mobile & chats',home:'/example/home',node:'/example/Node "stable"/node'});
  assert.ok(plan.contents.includes('/example/mobile &amp; chats/desktop/mobile-qr/update.mjs'));
  assert.ok(plan.contents.includes('Node &quot;stable&quot;'));
  assert.match(plan.contents,/<key>MOBILE_CHATS_ROOT<\/key>/);assert.match(plan.contents,/<key>StartInterval<\/key><integer>15<\/integer>/);
  assert.doesNotMatch(plan.contents,/access-token|AUTH_TOKEN|phoneUrl|KeepAlive/);
  assert.throws(()=>launchAgentPlan({root:'relative'}),/absolute/);
});

test('MOBILE_CHATS_ROOT is honored without modifying global environment', t => {
  const previous=process.env.MOBILE_CHATS_ROOT;t.after(()=>{if(previous===undefined)delete process.env.MOBILE_CHATS_ROOT;else process.env.MOBILE_CHATS_ROOT=previous;});
  process.env.MOBILE_CHATS_ROOT='/example/selected-repository';assert.equal(launchAgentPlan().root,process.env.MOBILE_CHATS_ROOT);
});

test('dry run validates source but creates no state, plist, desktop output or service operations', async t => {
  const f=await fixture(t);let calls=0;
  const plan=await installQrAgent({...f,run(){calls++;}});
  assert.equal(plan.applied,false);assert.equal(calls,0);await assert.rejects(stat(f.home),{code:'ENOENT'});
});

test('explicit installation affects only the QR label and writes a private portable plist', async t => {
  const f=await fixture(t),calls=[];
  const plan=await installQrAgent({...f,apply:true,platform:'darwin',uid:501,run(command,args){calls.push([command,...args]);if(command==='plutil'&&process.platform==='darwin')execFileSync(command,args,{stdio:'pipe'});}});
  assert.equal(plan.applied,true);assert.equal((await stat(plan.path)).mode&0o777,0o600);
  assert.equal(await readFile(plan.path,'utf8'),plan.contents);
  assert.deepEqual(calls.filter(call=>call[0]==='launchctl'),[
    ['launchctl','bootout','gui/501/'+LABEL],['launchctl','enable','gui/501/'+LABEL],['launchctl','bootstrap','gui/501',plan.path]
  ]);
  assert.ok(!calls.flat().some(value=>typeof value==='string'&&/codex-(?:mobile|cpolar|original)|dsh-mobile|claude-mobile/.test(value)));
});

test('missing source and unsupported apply fail before creating home or touching any agent', async t => {
  const f=await fixture(t);let calls=0;
  await assert.rejects(installQrAgent({...f,apply:true,platform:'linux',uid:501,run(){calls++;}}),/macOS/);
  await assert.rejects(stat(f.home),{code:'ENOENT'});assert.equal(calls,0);
  await rm(join(f.root,'connection/control-client.mjs'));
  await assert.rejects(installQrAgent({...f,apply:true,platform:'darwin',uid:501,run(){calls++;}}),{code:'ENOENT'});assert.equal(calls,0);
});
