import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

test('old scan shortcut delegates to the root opener, or opens only the unified desktop directory', async t => {
  const temporary=await mkdtemp(join(tmpdir(),'qr-shortcut-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
  const root=join(temporary,'mobile chats'),home=join(temporary,'home'),bin=join(temporary,'bin'),record=join(temporary,'record');
  for(const folder of [join(root,'connection'),home,bin])await mkdir(folder,{recursive:true});
  const script=join(root,'connection','打开国内扫码.command');
  await writeFile(script,await readFile(new URL('../../connection/打开国内扫码.command',import.meta.url)));
  const open=join(bin,'open');await writeFile(open,'#!/bin/sh\nprintf "%s\\n" "$@" > "$QR_TEST_RECORD"\n');await chmod(open,0o755);
  const env={...process.env,HOME:home,PATH:bin+':'+process.env.PATH,QR_TEST_RECORD:record};delete env.MOBILE_CHATS_ROOT;
  execFileSync('/bin/sh',[script],{env});assert.equal((await readFile(record,'utf8')).trim(),join(home,'Desktop','手机连接'));
  const rootOpener=join(root,'打开手机连接.command');await writeFile(rootOpener,'#!/bin/sh\nprintf "unified-root" > "$QR_TEST_RECORD"\n');await chmod(rootOpener,0o755);
  execFileSync('/bin/sh',[script],{env});assert.equal(await readFile(record,'utf8'),'unified-root');
  // An explicit alternate checkout is allowed, with no dependence on cwd.
  const alternate=join(temporary,'alternate checkout');await mkdir(alternate);const alternateOpener=join(alternate,'打开手机连接.command');
  await writeFile(alternateOpener,'#!/bin/sh\nprintf "alternate-root" > "$QR_TEST_RECORD"\n');await chmod(alternateOpener,0o755);
  execFileSync('/bin/sh',[script],{cwd:home,env:{...env,MOBILE_CHATS_ROOT:alternate}});assert.equal(await readFile(record,'utf8'),'alternate-root');
});
