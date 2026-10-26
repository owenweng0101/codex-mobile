import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalManager } from '../terminal.mjs';

test('a mobile terminal runs in the selected workspace and rejects another workspace', { timeout: 12000 }, async () => {
  const manager = new TerminalManager();
  try {
    const session = await manager.create(process.cwd(), 60, 20);
    const query = new URLSearchParams({ id: session.id, since: '0' });
    await assert.rejects(manager.handle('GET', query, {}, () => '/tmp'), /不属于当前项目/);
    await manager.handle('POST', query, { action: 'resize', id: session.id, cols: 70, rows: 28 }, () => process.cwd());
    await manager.handle('POST', query, { action: 'write', id: session.id, data: "printf 'PTY_%s\\n' verified\r" }, () => process.cwd());
    let text = '';
    for (let count = 0; count < 25 && !text.includes('PTY_verified'); count++) {
      const page = await manager.handle('GET', query, {}, () => process.cwd());
      query.set('since', String(page.sequence));
      text += Buffer.concat(page.frames.filter(frame => frame.data).map(frame => Buffer.from(frame.data, 'base64'))).toString('utf8');
    }
    assert.ok(text.includes('PTY_verified'), 'received the real shell result');
    await manager.handle('POST', query, { action: 'close', id: session.id }, () => process.cwd());
    await assert.rejects(manager.handle('GET', query, {}, () => process.cwd()), /已关闭/);
  } finally { manager.closeAll(); }
});
