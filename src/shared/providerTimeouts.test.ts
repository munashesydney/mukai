import { describe, expect, it } from 'vitest';
import { providerResponseTimeouts } from './providerTimeouts';

describe('provider response time limits', () => {
  it.each(['http://localhost:8000/v1', 'http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1'])(
    'allows terminal-buffered local generation at %s',
    (baseUrl) => {
      expect(providerResponseTimeouts({ kind: 'compatible', baseUrl })).toEqual({
        totalMs: 900000,
        idleMs: 600000,
      });
    },
  );
  it.each(['https://api.example.com/v1', 'http://localhost.example.com', 'invalid'])(
    'retains remote defaults for %s',
    (baseUrl) => {
      expect(providerResponseTimeouts({ kind: 'compatible', baseUrl })).toEqual({
        totalMs: 300000,
        idleMs: 120000,
      });
    },
  );
  it('honors per-model overrides, caps idle at total, and rejects unbounded or invalid legacy values', () => {
    const provider = { kind: 'openai' as const, baseUrl: '' };
    expect(
      providerResponseTimeouts(provider, {
        responseTimeoutSeconds: 1800,
        responseIdleTimeoutSeconds: 300,
      }),
    ).toEqual({ totalMs: 1800000, idleMs: 300000 });
    expect(providerResponseTimeouts(provider, { responseTimeoutSeconds: 60 })).toEqual({
      totalMs: 60000,
      idleMs: 60000,
    });
    for (const value of [0, -1, 1.5, Infinity, NaN, 7201]) {
      expect(
        providerResponseTimeouts(provider, {
          responseTimeoutSeconds: value,
          responseIdleTimeoutSeconds: value,
        }),
      ).toEqual({ totalMs: 300000, idleMs: 120000 });
    }
  });
});
