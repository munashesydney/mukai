import { createConnection } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { listenForOAuth } from './loopback';

async function exchange(uri: string, targets: string[]) {
  const url = new URL(uri);
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    let result = '';
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy(new Error('Callback test timed out')));
    socket.on('data', (chunk) => {
      result += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => resolve(result));
    socket.once('connect', () =>
      socket.write(
        targets
          .map(
            (target, index) =>
              `GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: ${index === targets.length - 1 ? 'close' : 'keep-alive'}\r\n\r\n`,
          )
          .join(''),
      ),
    );
  });
}

describe('OAuth loopback listener', () => {
  it('handles a pipelined browser request after callback shutdown without throwing', async () => {
    const callback = vi.fn(async () => {
      listener.close();
    });
    const listener = await listenForOAuth(callback);
    try {
      const response = await exchange(listener.uri, ['/auth/callback?code=test', '/favicon.ico']);
      expect(response).toContain('HTTP/1.1 200');
      expect(response).toContain('HTTP/1.1 410');
      expect(response).toContain('Sign-in listener has closed');
      expect(callback).toHaveBeenCalledOnce();
      listener.close(); // Shutdown is idempotent.
    } finally {
      listener.close();
    }
  });
  it('rejects malformed targets and unrelated browser requests safely', async () => {
    const callback = vi.fn(async () => {});
    const listener = await listenForOAuth(callback);
    try {
      expect(await exchange(listener.uri, ['http://[broken'])).toContain('HTTP/1.1 400');
      expect(await exchange(listener.uri, ['/favicon.ico'])).toContain('HTTP/1.1 404');
      expect(await exchange(listener.uri, ['http://other.example/auth/callback'])).toContain(
        'HTTP/1.1 404',
      );
      expect(callback).not.toHaveBeenCalled();
    } finally {
      listener.close();
    }
  });
  it('contains synchronous callback failures', async () => {
    const listener = await listenForOAuth(() => {
      throw new Error('Invalid callback');
    });
    try {
      expect(await exchange(listener.uri, ['/auth/callback'])).toContain('HTTP/1.1 400');
    } finally {
      listener.close();
    }
  });
});
