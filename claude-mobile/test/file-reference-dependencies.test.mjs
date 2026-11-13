import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {referencedPaths,localPath,isReferencedDependency,MARKDOWN_DEPENDENCY_LIMITS,embedHtmlAssets,resolveReferencedFile} from '../backend/lib/file-references.mjs';

async function fixture(t){
  const cwd=await mkdtemp(join(tmpdir(),'claude-dependencies-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const put=async(path,text)=>{const file=join(cwd,path);await mkdir(dirname(file),{recursive:true});await writeFile(file,text);return file;};
  const allowed=(text)=>referencedPaths(JSON.stringify({message:{content:[{type:'text',text}]}}),cwd);
  return {cwd,put,allowed};
}

test('transcript href suffixes are stripped before one decode; literal paths are unchanged',()=>{
  const cwd='/workspace';
  const raw=JSON.stringify({message:{content:[
    {type:'text',text:'[报告](<docs/中文 报告.markdown?v=1#标题>) ![图](images/a%23b%3Fc.png?raw=1#x)'},
    {type:'tool_use',input:{file_path:'/workspace/report%20final.html',other:'/workspace/literal?#.md'}},
  ]}});
  const paths=referencedPaths(raw,cwd);
  for(const path of ['docs/中文 报告.markdown','images/a#b?c.png','report%20final.html','literal?#.md'])assert.ok(paths.has(join(cwd,path)),path);
  assert.ok(!paths.has(join(cwd,'report final.html')));
  assert.ok(!paths.has(join(cwd,'docs/中文 报告.markdown?v=1#标题')));
});

test('marked links/images support Chinese, spaces, absolute/file URLs, references and URL suffixes',async t=>{
  const {cwd,put,allowed}=await fixture(t);
  const absolute=join(cwd,'绝对 文件.pdf'),urlFile=join(cwd,'file 图片.png');
  const root=await put('docs/根 文档.md',[
    '![图](<images/中文 图片.png?raw=1#图>)',
    '[绝对](<'+absolute+'?v=1#页>)',
    '[file]('+pathToFileURL(urlFile).href+'?v=1#图)',
    '[引用][target]',
    '',
    '[target]: <../引用 文件.txt?download=1#节>',
    '',
    '|表格|',
    '|---|',
    '|[嵌套](../表格.txt)|',
  ].join('\n'));
  const roots=allowed('[根](<docs/根 文档.md?v=1#标题>)');
  for(const file of [join(cwd,'docs/images/中文 图片.png'),absolute,urlFile,join(cwd,'引用 文件.txt'),join(cwd,'表格.txt')]){
    assert.equal(await isReferencedDependency(file,'docs/根 文档.md',roots,cwd),true,file);
  }
  assert.equal(await isReferencedDependency(join(cwd,'docs/images/同目录私密.png'),root,roots,cwd),false);
});

test('decoded API path/base are not decoded again, including literal percent and encoded separators',async t=>{
  const {cwd,put,allowed}=await fixture(t);
  const root=await put('根%20文档.md','![图](images/literal%2520name.png)\n![图](images/a%23b%3Fc.png)\n[字面](literal%252fsecret.txt)');
  const roots=allowed(root);
  assert.equal(await isReferencedDependency(join(cwd,'images/literal%20name.png'),root,roots,cwd),true);
  assert.equal(await isReferencedDependency(join(cwd,'images/literal name.png'),root,roots,cwd),false);
  assert.equal(await isReferencedDependency(join(cwd,'images/a#b?c.png'),root,roots,cwd),true);
  assert.equal(await isReferencedDependency(join(cwd,'literal%2fsecret.txt'),root,roots,cwd),true);
  assert.equal(await isReferencedDependency(join(cwd,'literal/secret.txt'),root,roots,cwd),false);
});

test('root md → child markdown → grandchild MD → image works with cwd-relative base and server resolution',async t=>{
  const {cwd,put,allowed}=await fixture(t);
  const root=await put('docs/root.md','[子](<sub/子 文档.markdown?v=1#章>)');
  await put('docs/sub/子 文档.markdown','[孙](../deep/孙.MD)');
  await put('docs/deep/孙.MD','![图](<../images/图片 一.png?v=1#x>)');
  const roots=allowed(root),base='docs/deep/孙.MD';
  const file=localPath('../images/图片 一.png',dirname(localPath(base,cwd)));
  assert.equal(await isReferencedDependency(file,base,roots,cwd),true);
  assert.equal(await isReferencedDependency(join(cwd,'docs/sub/子 文档.markdown'),root,roots,cwd),true);
  // A reachable base still authorizes only its own explicit dependencies.
  assert.equal(await isReferencedDependency(file,root,roots,cwd),false);
  assert.equal(roots.size,1,'the caller authorization Set must not be expanded');
});

test('base must be reachable from transcript Markdown roots; HTML roots and sibling bases confer nothing',async t=>{
  const {cwd,put,allowed}=await fixture(t);
  const root=await put('root.md','[child](child.md)');
  await put('child.md','![public](public.png)');
  const unrelated=await put('unrelated.md','![secret](secret.png)');
  const secret=join(cwd,'secret.png');
  assert.equal(await isReferencedDependency(secret,unrelated,allowed(root),cwd),false);
  assert.equal(await isReferencedDependency(secret,unrelated,new Set([secret]),cwd),false);
  assert.equal(await isReferencedDependency(secret,unrelated,allowed('[root](root.html)'),cwd),false);
  assert.equal(await isReferencedDependency(secret,root,new Set(),cwd),false);
  assert.equal(await isReferencedDependency(secret,null,allowed(root),cwd),false);
});

test('bare paths, code, HTML and unused definitions cannot grant dependencies or traversal',async t=>{
  const {cwd,put,allowed}=await fixture(t);
  const root=await put('root.md',[
    'secret.txt',
    '`[secret](inline.txt)`',
    '```md',
    '[secret](fenced.txt)',
    '```',
    '',
    '<a href="html.txt">secret</a>',
    '',
    '<img src="html.png">',
    '',
    '[unused]: unused.md',
    '',
    '![not a navigation link](image-base.md)',
  ].join('\n'));
  for(const path of ['secret.txt','inline.txt','fenced.txt','html.txt','html.png','unused.md'])assert.equal(await isReferencedDependency(join(cwd,path),root,allowed(root),cwd),false,path);
  for(const name of ['unused.md','image-base.md']){
    const base=await put(name,'[secret](secret.txt)');
    assert.equal(await isReferencedDependency(join(cwd,'secret.txt'),base,allowed(root),cwd),false,name);
  }
});

test('remote, protocol-relative, invalid and control-character hrefs cannot authorize local files',async t=>{
  const {cwd,put,allowed}=await fixture(t);
  const urls=['https://host/remote.png','//host/remote.png','file://host/remote.png','data:text/plain,x','javascript:secret.txt','%00secret.txt','%0Asecret.txt','bad%ZZ.txt','#anchor','?query'];
  const root=await put('root.md',urls.map((url,i)=>'[x'+i+']('+url+')').join('\n'));
  for(const path of ['remote.png','host/remote.png','secret.txt','bad%ZZ.txt'])assert.equal(await isReferencedDependency(join(cwd,path),root,allowed(root),cwd),false,path);
});

test('cycles terminate and missing/directory/oversized Markdown bases fail closed',async t=>{
  const {cwd,put,allowed}=await fixture(t);
  const root=await put('root.md','[child](child.md) [missing](missing.md) [dir](directory.md) [big](big.md)');
  const child=await put('child.md','[root](root.md) [ok](ok.txt)');
  await mkdir(join(cwd,'directory.md'));
  const big=await put('big.md','[ok](ok.txt)\n'+'x'.repeat(MARKDOWN_DEPENDENCY_LIMITS.maxFileBytes));
  assert.equal(await isReferencedDependency(join(cwd,'ok.txt'),child,allowed(root),cwd),true);
  for(const base of [join(cwd,'missing.md'),join(cwd,'directory.md'),big])assert.equal(await isReferencedDependency(join(cwd,'ok.txt'),base,allowed(root),cwd),false);
  assert.equal(await isReferencedDependency(join(cwd,'ok.txt'),join(cwd,'not-reachable.md'),allowed(root),cwd),false);
  await writeFile(root,'no dependencies now');
  assert.equal(await isReferencedDependency(join(cwd,'ok.txt'),child,allowed(root),cwd),false,'no stale authorization cache');
});

test('Markdown traversal depth is bounded, including the reachable boundary',async t=>{
  const {cwd,put,allowed}=await fixture(t),limit=MARKDOWN_DEPENDENCY_LIMITS.maxDepth;
  for(let i=0;i<=limit+1;i++)await put(i+'.md','[next]('+(i+1)+'.md) [image](image.png)');
  const roots=allowed(join(cwd,'0.md')),image=join(cwd,'image.png');
  assert.equal(await isReferencedDependency(image,join(cwd,limit+'.md'),roots,cwd),true);
  assert.equal(await isReferencedDependency(image,join(cwd,(limit+1)+'.md'),roots,cwd),false);
});

test('Markdown traversal limits both document count and aggregate read budget',async t=>{
  const {cwd,put,allowed}=await fixture(t),limits=MARKDOWN_DEPENDENCY_LIMITS;
  const root=await put('root.md',Array.from({length:limits.maxFiles},(_,i)=>'[child](child'+i+'.md)').join('\n'));
  for(let i=0;i<limits.maxFiles;i++)await put('child'+i+'.md','[ok](ok.png)');
  assert.equal(await isReferencedDependency(join(cwd,'ok.png'),join(cwd,'child'+(limits.maxFiles-2)+'.md'),allowed(root),cwd),true);
  assert.equal(await isReferencedDependency(join(cwd,'ok.png'),join(cwd,'child'+(limits.maxFiles-1)+'.md'),allowed(root),cwd),false);
  const count=Math.ceil(limits.maxTotalBytes/limits.maxFileBytes);
  await writeFile(root,Array.from({length:count},(_,i)=>'[child](large'+i+'.md)').join('\n'));
  const prefix='[ok](ok.png)\n\n```\n',suffix='\n```';
  for(let i=0;i<count;i++)await put('large'+i+'.md',prefix+'x'.repeat(limits.maxFileBytes-prefix.length-suffix.length)+suffix);
  assert.equal(await isReferencedDependency(join(cwd,'ok.png'),join(cwd,'large'+(count-1)+'.md'),allowed(root),cwd),false);
});

test('explicit local script src is embedded with non-source attributes retained',async t=>{
  const {cwd,put}=await fixture(t);
  await put('assets/中文 脚本.js','globalThis.testValue=42;');
  const html=await embedHtmlAssets(join(cwd,'report.html'),'<script type="module" defer integrity="obsolete" src="assets/%E4%B8%AD%E6%96%87%20%E8%84%9A%E6%9C%AC.js?v=1#x"></script>');
  assert.equal(html,'<script type="module" defer>globalThis.testValue=42;</script>');
  const absolute=join(cwd,'assets/中文 脚本.js');
  assert.ok((await embedHtmlAssets(join(cwd,'report.html'),'<script src="'+absolute+'"></script>')).includes('globalThis.testValue=42;'));
  assert.ok((await embedHtmlAssets(join(cwd,'report.html'),'<script src=assets/中文&#32;脚本.js></script>')).includes('globalThis.testValue=42;'));
});

test('script embedding rejects traversal, prefix siblings, symlink escapes and remote URLs',async t=>{
  const {cwd,put}=await fixture(t);
  const file=await put('page/report.html',''),outside=await put('outside.js','DO_NOT_EMBED');
  await put('page-neighbor/outside.js','DO_NOT_EMBED');
  await symlink(outside,join(cwd,'page/escape.js'));
  await mkdir(join(cwd,'page/nested'));
  await symlink(join(cwd,'page-neighbor'),join(cwd,'page/nested/escape'));
  for(const src of ['../outside.js','%2e%2e/outside.js',join(cwd,'page-neighbor/outside.js'),'escape.js','nested/escape/outside.js','https://host/outside.js','//host/outside.js','file://host/outside.js','missing.js']){
    const html='<script src="'+src+'"></script>';
    assert.equal(await embedHtmlAssets(file,html),html,src);
  }
});

test('script src must be an actual attribute of an actual script element',async t=>{
  const {cwd,put}=await fixture(t);await put('app.js','DO_NOT_EMBED');
  const examples=[
    '<!-- <script src="app.js"></script> -->',
    '<textarea><script src="app.js"></script></textarea>',
    '<title><script src="app.js"></script></title>',
    '<div title=\'<script src="app.js"></script>\'></div>',
    '<script>const x=\'<script src="app.js">\';</script>',
    '<script data-src="app.js"></script>',
    '<script title=\'src="app.js"\'></script>',
    '<script src="app.js" SRC="other.js"></script>',
    '<script src=""></script>',
    '<script src="app.js">',
  ];
  for(const html of examples)assert.equal(await embedHtmlAssets(join(cwd,'report.html'),html),html,html);
});

test('scripts cannot exceed per-file or shared image/CSS/script byte budgets',async t=>{
  const {cwd,put}=await fixture(t),file=join(cwd,'report.html');
  await put('huge.js','x'.repeat(2*1024*1024+1));
  const huge='<script src="huge.js"></script>';assert.equal(await embedHtmlAssets(file,huge),huge);
  const bytes=Buffer.alloc(2*1024*1024,120);await put('image.png',bytes);await put('large.js',bytes);await put('last.js','SHOULD_NOT_EMBED');
  const html='<img src="image.png">'+'<script src="large.js"></script>'.repeat(4)+'<script src="last.js"></script>';
  const result=await embedHtmlAssets(file,html);
  assert.ok(result.includes('data:image/png;base64,'));
  assert.equal((result.match(/src="large.js"/g)||[]).length,0);
  assert.ok(result.endsWith('<script src="last.js"></script>'));
});

test('embedded scripts do not introduce closing tags or recursively embed imported files',async t=>{
  const {cwd,put}=await fixture(t),file=join(cwd,'report.html');
  await put('unsafe.js','const x="</script><p>unexpected</p>";');
  const html='<script src="unsafe.js"></script>';assert.equal(await embedHtmlAssets(file,html),html);
  await put('app.js','import "./secret.js";');await put('secret.js','DO_NOT_EMBED');
  assert.equal(await embedHtmlAssets(file,'<script type="module" src="app.js"></script>'),'<script type="module">import "./secret.js";</script>');
});

test('embedding preserves JavaScript strings that resemble HTML style attributes',async t=>{
  const {cwd,put}=await fixture(t),script='const html=`<div style="background:url(image.png)"></div>`;';
  await put('app.js',script);await put('image.png','image bytes');
  assert.equal(await embedHtmlAssets(join(cwd,'report.html'),'<script src="app.js"></script>'),'<script>'+script+'</script>');
});

test('code link line and column suffixes authorize the real file, not a nonexistent suffixed filename',()=>{
 const raw=JSON.stringify({message:{content:'See [source](backend/lib/ui.mjs:356:12) and [literal](./notes%3A123).'}});
 const paths=referencedPaths(raw,'/workspace');
 assert.ok(paths.has('/workspace/backend/lib/ui.mjs'));
 assert.ok(paths.has('/workspace/notes:123'));
 assert.ok(!paths.has('/workspace/backend/lib/ui.mjs:356:12'));
});

test('relative links resolve inside desktop session folders without granting whole-folder access',async t=>{
 const f=await fixture(t);const source=await f.put('added/backend/ui.mjs','export const ok=true;');
 const secret=await f.put('added/private.txt','unreferenced');
 const raw=JSON.stringify({message:{content:'[source](backend/ui.mjs:356)'}});
 const options={raw,cwd:f.cwd,folders:[join(f.cwd,'added')],requested:'backend/ui.mjs'};
 assert.equal((await resolveReferencedFile(options)).file,source);
 assert.equal(await resolveReferencedFile({...options,folders:[]}),null);
 assert.equal(await resolveReferencedFile({...options,requested:'private.txt'}),null);
 assert.equal(await resolveReferencedFile({...options,requested:secret}),null);
 const primary=await f.put('backend/ui.mjs','primary');
 assert.equal((await resolveReferencedFile(options)).file,primary);
});
