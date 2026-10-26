import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_TITLE_MAX_LENGTH, autoTitleCandidate, isDefaultThreadTitle } from '../auto-title.mjs';

const first = options => autoTitleCandidate({ isFirstUserInput: true, ...options });

test('only blank/default titles on the first user input get a candidate', () => {
  for (const title of [undefined, null, '', ' \n ', '新任务', ' New Task ']) {
    assert.equal(isDefaultThreadTitle(title), true);
    assert.equal(first({ title, text: '修复手机首次对话标题' }), '修复手机首次对话标题');
  }
  for (const title of ['我的项目', '新任务：排查', 'Untitled', '图片任务', 123]) {
    assert.equal(isDefaultThreadTitle(title), false);
    assert.equal(first({ title, text: '新输入' }), null);
  }
  assert.equal(autoTitleCandidate({ title: '新任务', text: '第二条消息' }), null);
  assert.equal(autoTitleCandidate({ title: '新任务', text: '第二条消息', isFirstUserInput: false }), null);
  assert.equal(autoTitleCandidate({ title: '', text: '未知历史', isFirstUserInput: 1 }), null);
});

test('explicit custom placeholders and native titles win, including rechecks after send', () => {
  for (const title of ['', '新任务', 'New task', '自定义标题']) assert.equal(first({ title, text: '请求', customTitle: true }), null);
  assert.equal(first({ title: '新任务', text: '修复登录' }), '修复登录');
  assert.equal(first({ title: '原生生成或用户刚重命名', text: '修复登录' }), null);
});

test('strips known context wrappers and keeps the actual request', () => {
  const text = '# AGENTS.md instructions\n<INSTRUCTIONS>不要当作标题</INSTRUCTIONS>\n<environment_context><cwd>/private/path</cwd></environment_context>\n<codex_mobile_plan>内部计划</codex_mobile_plan>\n## My request:\n### 修复   登录问题\n更多说明';
  assert.equal(first({ text }), '修复 登录问题');
  assert.equal(first({ text: '## Referenced chats with Codex:\n旧消息\n## My request:\n修复搜索' }), '修复搜索');
  assert.equal(first({ text: '<user_query>查看这个项目</user_query>' }), '查看这个项目');
  assert.equal(first({ text: '<send_user_message_question_reply>[{"answer":"使用深色主题"}]</send_user_message_question_reply>' }), '使用深色主题');
  assert.equal(first({ text: '<environment_context>只有上下文</environment_context>' }), null);
});

test('attachment manifests are not exposed as titles', () => {
  const text = '<codex-mobile-attachments version="1">\n{"attachments":[]}\n</codex-mobile-attachments>\n检查附件内容';
  assert.equal(first({ text }), '检查附件内容');
});

test('uses text input blocks, with meaningful image-only and file-only fallbacks', () => {
  for (const type of ['image', 'localImage', 'local_image', 'input_image', 'image_url']) assert.equal(first({ input: [{ type, path: '/private/photo.png' }] }), '图片任务');
  assert.equal(first({ attachments: [{ kind: 'image', name: 'private.png' }] }), '图片任务');
  assert.equal(first({ attachments: [{ mime: 'image/png' }] }), '图片任务');
  assert.equal(first({ attachments: [{ mimeType: 'image/jpeg' }] }), '图片任务');
  assert.equal(first({ input: [{ type: 'localImage' }, { type: 'text', text: '比较这两张图片' }] }), '比较这两张图片');
  assert.equal(first({ input: [{ type: 'input_text', text: '修复程序' }] }), '修复程序');
  assert.equal(first({ files: ['private.pdf'] }), '文件任务');
  assert.equal(first({ input: [{ type: 'mention', name: 'report.pdf' }] }), '文件任务');
  assert.equal(first({ attachments: [{ kind: 'document' }] }), '文件任务');
  assert.equal(first({ input: [null, { type: 'tool_result', text: '忽略工具输出' }] }), null);
  assert.equal(first({ text: '\n \t', input: null, attachments: null, files: null }), null);
});

test('bounded titles preserve Unicode graphemes and collapse control whitespace', () => {
  assert.equal(AUTO_TITLE_MAX_LENGTH, 60);
  assert.equal(first({ text: '中'.repeat(61) }), '中'.repeat(59) + '…');
  const emoji = '👨‍👩‍👧‍👦';
  assert.equal(first({ text: emoji.repeat(8), maxLength: 5 }), emoji.repeat(4) + '…');
  assert.equal(first({ text: 'e\u0301'.repeat(6), maxLength: 5 }), 'e\u0301'.repeat(4) + '…');
  assert.equal(first({ text: '- 修复\t标题\u0000显示' }), '修复 标题 显示');
  for (const maxLength of [0, 1, 61, 2.5, NaN]) assert.throws(() => first({ text: 'test', maxLength }), RangeError);
});

test('candidate calculation is deterministic and does not mutate message data', () => {
  const options = { title: '新任务', text: '调查首条消息', input: [{ type: 'localImage', path: '/tmp/test.png' }], isFirstUserInput: true };
  const before = structuredClone(options);
  assert.equal(autoTitleCandidate(options), autoTitleCandidate(options));
  assert.deepEqual(options, before);
});
