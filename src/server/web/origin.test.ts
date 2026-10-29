import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { trustedLocalRequest } from './origin';

const request = (host: string, origin?: string, localPort = 47831) =>
  ({
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    socket: { localPort },
  }) as unknown as IncomingMessage;

describe('native Desktop origins', () => {
  it('accepts the Desktop renderer and the browser UI against one backend', () => {
    for (const origin of [
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:5273',
    ])
      expect(trustedLocalRequest(request('127.0.0.1:47831', origin))).toBe(true);
    expect(trustedLocalRequest(request('localhost:47831', 'http://localhost:5273'))).toBe(true);
    // The browser dev UI is proxied as the backend's own origin, since the proxy holds the
    // local token. Only that exact origin is treated as this machine.
    expect(trustedLocalRequest(request('127.0.0.1:47831', 'http://127.0.0.1:47831'))).toBe(true);
    expect(trustedLocalRequest(request('localhost:5273', 'http://127.0.0.1:47831'))).toBe(true);
  });

  it('keeps requiring loopback and an exact dev origin', () => {
    expect(trustedLocalRequest(request('evil.example:47831', 'http://127.0.0.1:5173'))).toBe(false);
    expect(trustedLocalRequest(request('127.0.0.1:47831', 'http://127.0.0.1:5174'))).toBe(false);
    expect(trustedLocalRequest(request('127.0.0.1:47831', 'http://localhost:47831'))).toBe(false);
    expect(trustedLocalRequest(request('127.0.0.1:47831', 'https://127.0.0.1:5273'))).toBe(false);
    expect(trustedLocalRequest(request('127.0.0.1:47831', 'https://evil.example'))).toBe(false);
  });

  it('retains the file and missing-origin rules', () => {
    expect(trustedLocalRequest(request('127.0.0.1:47831'))).toBe(true);
    expect(trustedLocalRequest(request('127.0.0.1:47831', 'null'))).toBe(true);
    expect(trustedLocalRequest(request('127.0.0.1:47831', 'file://'))).toBe(false);
    expect(trustedLocalRequest(request('127.0.0.1:47831', 'file://'), false, true)).toBe(true);
  });

  it('honours an extra configured dev port', () => {
    process.env.MUKAI_DEV_ORIGINS = '5300';
    try {
      expect(trustedLocalRequest(request('127.0.0.1:47831', 'http://127.0.0.1:5300'))).toBe(true);
      expect(trustedLocalRequest(request('127.0.0.1:47831', 'http://127.0.0.1:5301'))).toBe(false);
    } finally {
      delete process.env.MUKAI_DEV_ORIGINS;
    }
  });

  it('treats only the running backend port as its own origin', () => {
    process.env.PORT = '47900';
    try {
      expect(trustedLocalRequest(request('127.0.0.1:47900', 'http://127.0.0.1:47900'))).toBe(true);
      expect(trustedLocalRequest(request('127.0.0.1:47831', 'http://127.0.0.1:47831'))).toBe(false);
    } finally {
      delete process.env.PORT;
    }
  });
});

describe('served browser origins', () => {
  it('still uses same-origin only, whatever the dev ports are', () => {
    expect(
      trustedLocalRequest(request('127.0.0.1:8080', 'http://127.0.0.1:8080', 8080), true),
    ).toBe(true);
    for (const origin of [
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5273',
      'http://evil.example',
      'null',
    ])
      expect(trustedLocalRequest(request('127.0.0.1:8080', origin, 8080), true)).toBe(false);
    // A served browser is judged against its own host, never the dev allowlist.
    expect(
      trustedLocalRequest(request('mukai.local:8080', 'http://mukai.local:8080', 8080), true),
    ).toBe(true);
    expect(
      trustedLocalRequest(request('mukai.local:8080', 'http://127.0.0.1:5273', 8080), true),
    ).toBe(false);
    // And the request must reach the port it claims.
    expect(
      trustedLocalRequest(request('127.0.0.1:8080', 'http://127.0.0.1:8080', 47831), true),
    ).toBe(false);
  });
});
