import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const controlSocketPath = join(homedir(), 'Library/Application Support/CodexMobileCpolar/control.sock');

// Private Unix socket: no TCP listener or browser-facing pairing page.
export function readControlResponse({ signal = AbortSignal.timeout(2500), socketPath = controlSocketPath } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/local/status', method: 'GET', signal, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 100000) req.destroy(Error('Pairing response too large'));
      });
      res.on('error', reject);
      res.on('end', () => resolve(new Response(body, { status: res.statusCode })));
    });
    req.on('error', reject);
    req.end();
  });
}
