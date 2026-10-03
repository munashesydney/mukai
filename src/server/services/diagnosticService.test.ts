import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiagnosticService } from './diagnosticService';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-diagnostics-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(dir.startsWith(join(tmpdir(), 'mukai-diagnostics-'))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('persists useful provider and network errors without SDK request bodies or credentials', () => {
  const logger = new DiagnosticService(dir);
  const key = 'private-test-key',
    token = 'local-api-token-secret';
  logger.registerSecret(key);
  logger.registerSecret(token);
  const cause = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
  const error = Object.assign(new Error('Upstream failure ' + key, { cause }), {
    name: 'AI_APICallError',
    statusCode: 503,
    isRetryable: true,
    url: 'https://user:password@provider.example/v1/chat/completions?token=' + token,
    requestBodyValues: { messages: ['PRIVATE PROMPT'], tools: ['PRIVATE SOURCE'] },
    responseHeaders: {
      'x-request-id': 'request-42',
      authorization: 'Bearer ' + key,
      'set-cookie': token,
    },
    responseBody: JSON.stringify({
      error: { type: 'server_error', code: 'upstream_failure', message: 'Try again ' + key },
      request: { content: 'PRIVATE PROMPT' },
      apiKey: key,
    }),
  });
  const id = logger.record('chat.failed', error, {
    model: 'model',
    conversationId: 'conversation',
    messageId: 'message',
    phase: 'provider-request',
    step: 15,
    ...{ apiKey: key },
  });
  const text = readFileSync(logger.path, 'utf8');
  const record = JSON.parse(text);
  expect(record).toMatchObject({
    id,
    event: 'chat.failed',
    phase: 'provider-request',
    messageId: 'message',
    step: 15,
    error: {
      name: 'AI_APICallError',
      statusCode: 503,
      isRetryable: true,
      endpoint: 'https://provider.example/v1/chat/completions',
      message: 'Upstream failure [redacted]',
      providerRequestId: 'request-42',
      providerError: {
        type: 'server_error',
        code: 'upstream_failure',
        message: 'Try again [redacted]',
      },
      cause: { code: 'ECONNRESET', message: 'socket reset' },
    },
  });
  expect(record.error.stack.length).toBeGreaterThan(0);
  expect(record.error.stack.every((line: string) => line.trimStart().startsWith('at '))).toBe(true);
  for (const forbidden of [
    key,
    token,
    'PRIVATE PROMPT',
    'PRIVATE SOURCE',
    'Bearer ',
    'requestBodyValues',
    'set-cookie',
  ]) {
    expect(text).not.toContain(forbidden);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(forbidden);
  }
});
it('omits raw validation payloads and unstructured response bodies, but retains error causes', () => {
  const logger = new DiagnosticService(dir);
  const cause = Object.assign(new Error('Invalid data PRIVATE SOURCE'), {
    name: 'AI_TypeValidationError',
    data: { source: 'PRIVATE SOURCE' },
  });
  const error = Object.assign(
    new Error('Invalid arguments: {"content":"PRIVATE SOURCE"}', { cause }),
    { responseBody: '<html>PRIVATE SOURCE</html>' },
  );
  logger.record('chat.failed', error);
  const text = readFileSync(logger.path, 'utf8');
  expect(text).not.toContain('PRIVATE SOURCE');
  expect(JSON.parse(text).error.cause).toMatchObject({
    name: 'AI_TypeValidationError',
    message: 'Validation or parsing failed; raw payload omitted.',
  });
  expect(JSON.parse(text).error.responseBytes).toBeGreaterThan(0);
});
it('bounds nested/circular causes and rotates logs while retaining the newest errors', () => {
  const logger = new DiagnosticService(dir, 1024);
  const cause = Object.assign(new Error('Network failed'), { stack: '' });
  cause.cause = cause;
  let latest = '';
  for (let i = 0; i < 20; i++) latest = logger.record('chat.failed', cause);
  const files = ['errors.log', 'errors.1.log', 'errors.2.log'].map((file) =>
    join(dir, 'logs', file),
  );
  for (const path of files) {
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeLessThanOrEqual(1024);
    for (const line of readFileSync(path, 'utf8').trim().split('\n'))
      expect(JSON.parse(line).error.cause.name).toBe('CauseOmitted');
  }
  expect(readFileSync(logger.path, 'utf8')).toContain(latest);
});
it('preserves terminal diagnostics when writing fails and never throws into chat processing', () => {
  writeFileSync(join(dir, 'logs'), 'directory is unavailable');
  const logger = new DiagnosticService(dir);
  expect(() => logger.record('chat.failed', new Error('fetch failed'))).not.toThrow();
  expect(console.error).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('fetch failed');
  expect(() =>
    logger.record('chat.failed', {
      get name() {
        throw new Error('bad getter');
      },
    }),
  ).not.toThrow();
});
it('persists a fallback for unreadable errors and retains numeric provider codes', () => {
  const logger = new DiagnosticService(dir);
  const id = logger.record('chat.failed', {
    get name() {
      throw new Error('bad getter');
    },
  });
  logger.record('provider.test_failed', {
    name: 'APIError',
    message: 'Upstream failed',
    code: 123,
    responseBody: '{"error":{"code":12007,"message":"Quota exhausted"}}',
  });
  const records = readFileSync(logger.path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records[0]).toMatchObject({ id, error: { name: 'UninspectableError' } });
  expect(records[1].error).toMatchObject({
    code: 123,
    providerError: { code: 12007, message: 'Quota exhausted' },
  });
});
