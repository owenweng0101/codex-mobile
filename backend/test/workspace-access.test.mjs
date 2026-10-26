import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceAccess } from '../workspace-access.mjs';

const root='/fake-user/Documents';
test('authorization timeout shares a single pending probe and recovers after late permission',async()=>{
  let resolveProbe,calls=0;
  const access=new WorkspaceAccess({protectedRoots:[root],timeoutMs:10,probe:()=>{calls++;return calls===1?new Promise(resolve=>{resolveProbe=resolve}):Promise.resolve()}});
  const attempts=await Promise.allSettled([access.ensure(root+'/one'),access.ensure(root+'/two')]);
  for(const result of attempts){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'WORKSPACE_PERMISSION_REQUIRED');assert.match(result.reason.message,/电脑端.*允许/)}
  assert.equal(calls,1);assert.equal(access.pending.size,1);
  await assert.rejects(access.ensure(root+'/three'),{code:'WORKSPACE_PERMISSION_REQUIRED'});assert.equal(calls,1);
  resolveProbe();await new Promise(resolve=>setImmediate(resolve));assert.equal(access.pending.size,0);
  await access.ensure(root+'/one');assert.equal(calls,2);
});
test('explicit permission denial is actionable and does not prevent a later retry',async()=>{
  let calls=0;const access=new WorkspaceAccess({protectedRoots:[root],probe:async()=>{if(++calls===1)throw Object.assign(new Error('denied'),{code:'EPERM'})}});
  await assert.rejects(access.ensure(root),{code:'WORKSPACE_PERMISSION_REQUIRED',statusCode:423,retryable:true});
  await access.ensure(root);assert.equal(calls,2);
});
test('unprotected directories do not perform any filesystem probe',async()=>{
  let calls=0;const access=new WorkspaceAccess({protectedRoots:[root],probe:async()=>{calls++}});
  for(const path of ['/fake-user/codex',root+'-archive',root+'/../elsewhere'])await access.ensure(path);
  assert.equal(calls,0);
});
test('unrelated filesystem errors retain their original meaning',async()=>{
  const error=Object.assign(new Error('missing'),{code:'ENOENT'}),access=new WorkspaceAccess({protectedRoots:[root],probe:async()=>{throw error}});
  await assert.rejects(access.ensure(root),value=>value===error);assert.equal(access.pending.size,0);
});
