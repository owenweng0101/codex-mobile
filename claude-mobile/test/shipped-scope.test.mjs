import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {chatHtml} from '../backend/lib/ui.mjs';

test('the shipped phone interface keeps chat, images and progress but no goal controls',()=>{
  const html=chatHtml();
  assert.match(html,/id="input"/);
  assert.match(html,/id="file"/);
  assert.match(html,/id="send"/);
  assert.match(html,/row-status/);
  assert.match(html,/planChip/);
  assert.doesNotMatch(html,/ClaudeGoalControls|clmGoalPanel|goalControls|add\('目标'/);
});

test('retired goal execution has no public/private route or plugin consumer',async()=>{
  const server=await readFile(new URL('../backend/server.mjs',import.meta.url),'utf8');
  const bridge=await readFile(new URL('../backend/lib/native-user-bridge.mjs',import.meta.url),'utf8');
  const plugin=await readFile(new URL('../desktop-plugin/hooks/register.ts',import.meta.url),'utf8');
  const types=await readFile(new URL('../desktop-plugin/types/index.d.ts',import.meta.url),'utf8');
  assert.doesNotMatch(server,/NativeGoalService|goalService|\/claude\/api\/goal/);
  assert.doesNotMatch(bridge,/goalCommands|\/v1\/goal/);
  assert.doesNotMatch(plugin,/createGoalBridge|goalCommands|\/v1\/goal|\$\.command\.run/);
  assert.doesNotMatch(types,/ClaudeMobileGoal|goalCommands/);
});

test('unfinished goal modules and their standalone documentation are removed',()=>{
  for(const name of ['../NATIVE_GOAL.md','../backend/lib/goal-controls.js','../backend/lib/native-goal.mjs','../backend/lib/native-goal-command.mjs','../backend/lib/native-goal-io.mjs','../backend/lib/native-goal-owner.mjs','../backend/lib/native-goal-service.mjs','../desktop-plugin/hooks/goal.ts'])assert.equal(existsSync(new URL(name,import.meta.url)),false,name);
});
