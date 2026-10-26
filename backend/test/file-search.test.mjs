import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchWorkspaceFiles } from '../file-search.mjs';
test('project file search is bounded, supports Unicode paths and never follows links outside the workspace',async()=>{
  const root=await mkdtemp(join(tmpdir(),'codex-mobile-search-'));
  try {
    const workspace=join(root,'project');await mkdir(join(workspace,'src'),{recursive:true});await mkdir(join(workspace,'node_modules'));
    await writeFile(join(workspace,'src','按钮.ts'),'export const x=1');await writeFile(join(workspace,'node_modules','按钮.js'),'vendor');await writeFile(join(root,'按钮-private.txt'),'private');await symlink(join(root,'按钮-private.txt'),join(workspace,'按钮-link.txt'));
    const result=await searchWorkspaceFiles(workspace,'按钮');assert.deepEqual(result.entries.map(e=>e.path),['src/按钮.ts']);
    await assert.rejects(searchWorkspaceFiles(workspace,'按钮','../'),/以外/);
    const bounded=await searchWorkspaceFiles(workspace,'src','',{maxEntries:1});assert.equal(bounded.truncated,true);
  }finally{await rm(root,{recursive:true,force:true});}
});
