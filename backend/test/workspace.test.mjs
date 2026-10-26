import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { workspacePath, listWorkspaceFiles, readWorkspaceFile, workspaceGit, readRolloutPage } from '../core.mjs';

test('workspace reader rejects traversal and escaping symlinks, preserves Unicode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mobile-files-'));
  try {
    const dir = join(root, 'project'); await mkdir(dir); await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', '你好.md'), '中文与 emoji 🐱'); await writeFile(join(root, 'secret'), 'outside'); await symlink(root, join(dir, 'outside'));
    await assert.rejects(workspacePath(dir, '../secret'), /工作目录以外/);
    await assert.rejects(workspacePath(dir, 'outside/secret'), /工作目录以外/);
    await assert.rejects(workspacePath(dir, '/etc/passwd'), /相对路径/);
    assert.equal((await readWorkspaceFile(dir, 'sub/你好.md')).content, '中文与 emoji 🐱');
    assert.equal((await listWorkspaceFiles(dir)).entries.find(e => e.name === 'outside').type, 'unavailable');
    await writeFile(join(dir, 'binary'), Buffer.from([0, 1, 2])); await assert.rejects(readWorkspaceFile(dir, 'binary'), /二进制/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('large UTF-8 previews omit only the incomplete boundary character', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mobile-utf8-'));
  try {
    const path = join(root, 'preview.txt'), prefix = 'x'.repeat(512 * 1024 - 1);
    await writeFile(path, prefix + '中文🐱'); const preview = await readWorkspaceFile(root, 'preview.txt');
    assert.equal(preview.truncated, true); assert.equal(preview.content, prefix); assert.equal(preview.content.includes('\ufffd'), false);
    await writeFile(path, 'x'.repeat(512 * 1024 - 3) + '中'); const complete = await readWorkspaceFile(root, 'preview.txt');
    assert.equal(complete.truncated, false); assert.equal(complete.content.endsWith('中'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('git preview confines nested workspace paths and reports staged, unstaged and new files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mobile-git-'));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git(['init']); await mkdir(join(root, 'project')); await writeFile(join(root, 'project', 'tracked.md'), 'first\n'); await writeFile(join(root, 'outside.md'), 'outside\n');
    git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
    await writeFile(join(root, 'project', 'tracked.md'), 'second\n'); await writeFile(join(root, 'project', 'new 中文.md'), 'new\n'); await writeFile(join(root, 'outside.md'), 'changed\n');
    const result = await workspaceGit(join(root, 'project'));
    assert.equal(result.available, true); assert.deepEqual(result.files.map(f => f.path).sort(), ['new 中文.md', 'tracked.md']); assert.match(result.diff, /\+second/); assert.doesNotMatch(result.diff, /outside/);
    const fresh = await workspaceGit(join(root, 'project'), 'new 中文.md'); assert.match(fresh.diff, /\+new/);
    await assert.rejects(workspaceGit(join(root, 'project'), '../outside.md'), error => error.statusCode === 400 && /工作目录以外/.test(error.message));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rollout byte paging reads complete turns across large records without overlaps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mobile-history-'));
  try {
    const rows = [], event = payload => ({ timestamp: '2026-10-25T00:00:00Z', ordinal: rows.length, type: 'event_msg', payload });
    for (let i = 0; i < 12; i++) {
      rows.push(event({ type: 'task_started', turn_id: 'turn-' + i }));
      rows.push(event({ type: 'item_completed', turn_id: 'turn-' + i, item: { id: 'user-' + i, type: 'UserMessage', content: [{ type: 'text', text: '中文 ' + i }] } }));
      rows.push({ timestamp: '2026-10-25T00:00:00Z', type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(300000) } });
      rows.push(event({ type: 'item_completed', turn_id: 'turn-' + i, item: { id: 'reply-' + i, type: 'AgentMessage', content: [{ type: 'text', text: '回复 ' + i }], phase: 'final_answer' } }));
      rows.push(event({ type: 'task_complete', turn_id: 'turn-' + i }));
    }
    const path = join(root, 'history.jsonl'); await writeFile(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const latest = await readRolloutPage(path, null, 4), older = await readRolloutPage(path, latest.nextCursor, 8);
    assert.deepEqual(latest.data.map(t => t.id), ['turn-8','turn-9','turn-10','turn-11']);
    assert.equal(latest.data[0].items[1].text, '回复 8'); assert.equal(latest.data[0].status, 'completed');
    assert.deepEqual(older.data.map(t => t.id), Array.from({ length: 8 }, (_, i) => 'turn-' + i)); assert.equal(older.nextCursor, null);
    await assert.rejects(readRolloutPage(path, 'rollout:999999999'), /失效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rollout cursor ends at a metadata-only prelude without falling back to another cursor format', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mobile-history-end-'));
  try {
    const path = join(root, 'history.jsonl');
    const prefix = [{type:'session_meta',payload:{id:'fixture'}},{type:'event_msg',payload:{type:'thread_settings_applied'}}].map(JSON.stringify).join('\n')+'\n';
    const turn = [{type:'task_started',turn_id:'only'},{type:'item_completed',turn_id:'only',item:{id:'reply',type:'AgentMessage',content:[{type:'text',text:'real reply'}]}},{type:'task_complete',turn_id:'only'}].map(payload=>JSON.stringify({type:'event_msg',payload})).join('\n')+'\n';
    await writeFile(path,prefix+turn);
    const latest=await readRolloutPage(path,null,1);
    assert.equal(latest.nextCursor,'rollout:'+Buffer.byteLength(prefix));
    assert.deepEqual(await readRolloutPage(path,latest.nextCursor,8),{data:[],nextCursor:null});
    assert.equal((await readRolloutPage(path,null,8)).data[0].id,'only');
    const legacy=JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant'}})+'\n';
    await writeFile(path,legacy);
    assert.equal(await readRolloutPage(path,'rollout:'+Buffer.byteLength(legacy),8),null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
