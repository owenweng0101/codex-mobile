import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {injectHtmlPreview} from '../backend/lib/html-preview.mjs';

test('HTML injection preserves markup and rejects executable or oversized tokens',()=>{
  const text='<!doctype html><html><body><h1>报告</h1><script>const close="</body>";</script></body></html>';
  const result=injectHtmlPreview(text,'valid-token_1');
  assert.ok(result.startsWith(text));assert.match(result,/data-claude-preview-zoom/);
  assert.match(result,/bindDocumentZoom/);assert.match(result,/claude-preview-ready/);
  assert.doesNotMatch(result,/allow-same-origin|Content-Security-Policy|fetch\(/);
  for(const token of ['',null,'x'.repeat(161),'</script><script>alert(1)','abc def'])assert.equal(injectHtmlPreview(text,token),text);
});

test('file references strip only trailing numeric line/column suffixes',()=>{
  const source=readFileSync(new URL('../backend/lib/message-renderer.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('  function localPath('),source.indexOf('  function fileUrl('));
  const localPath=vm.runInNewContext('('+fn.trim()+')');
  assert.equal(localPath('/work/ui.mjs:356'),'/work/ui.mjs');
  assert.equal(localPath('file:///work/%E6%96%87%E6%A1%A3.md:3:12'),'/work/文档.md');
  assert.equal(localPath('report.md%3A356'), 'report.md:356');
  assert.equal(localPath('/work/report:notes.md'),'/work/report:notes.md');
  assert.equal(localPath('/work/report:12.md'),'/work/report:12.md');
  assert.equal(localPath('/work/report.md:12:notes'),'/work/report.md:12:notes');
  assert.equal(localPath('https://example.com/report.md:12'),null);
});

test('pinned PDF core, Worker, binary resources and compatibility shim ship locally',()=>{
  const read=name=>readFileSync(new URL('../backend/vendor/pdfjs/'+name,import.meta.url),'utf8');
  assert.match(read('pdf.worker.mjs'),/pdfjsVersion = 6\.3\.289/);
  assert.match(read('pdf.mjs'),/installPdfCompatibility\(\)/);
  assert.match(read('pdf.worker.mjs'),/installPdfCompatibility\(\)/);
  assert.match(read('binary-assets.mjs'),/Adobe-GB1-UCS2\.bcmap/);
  assert.match(read('LICENSE.txt'),/Apache License/);
  assert.match(read('loader.mjs'),/useWorkerFetch:false/);
  assert.doesNotMatch(read('loader.mjs'),/https?:|blob:/);
});
