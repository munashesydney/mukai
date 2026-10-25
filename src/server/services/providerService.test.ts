import { describe, expect, it } from 'vitest';
import { ApiError } from '../config';
import { safeProviderError } from './providerService';

describe('Provider error messages', () => {
  it('explains media and request-size rejections without exposing request content', () => {
    expect(safeProviderError({ statusCode: 413 })).toContain('smaller or shorter');
    const message = safeProviderError({
      statusCode: 400,
      responseBody: 'unsupported audio codec PRIVATE_MEDIA_DATA',
    });
    expect(message).toContain('attached media');
    expect(message).not.toContain('PRIVATE_MEDIA_DATA');
  });
  const socket = Object.assign(new Error('other side closed PRIVATE_REQUEST_DATA'), {
    name: 'SocketError',
    code: 'UND_ERR_SOCKET',
  });
  const apiError = {
    name: 'AI_APICallError',
    message: 'Cannot connect to API: other side closed',
    isRetryable: true,
    cause: socket,
  };
  it.each([apiError, { name: 'AI_RetryError', lastError: apiError }, { cause: { cause: socket } }])(
    'explains nested socket closures without exposing error details',
    (error) => {
      const message = safeProviderError(error);
      expect(message).toContain('connection to the provider closed unexpectedly');
      expect(message).not.toMatch(/credentials|balance|PRIVATE_REQUEST_DATA/);
    },
  );
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'])(
    'explains connection failures (%s)',
    (code) => {
      expect(safeProviderError({ cause: { code } })).toContain('Could not connect to the provider');
    },
  );
  it.each([
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'ETIMEDOUT',
  ])('explains nested connection timeouts (%s)', (code) => {
    expect(safeProviderError({ cause: { code } })).toContain('provider connection timed out');
  });
  it('preserves explicit provider rejections and handles circular error chains', () => {
    expect(
      safeProviderError(new ApiError(503, 'ChatGPT routing is temporarily unavailable.')),
    ).toBe('ChatGPT routing is temporarily unavailable.');
    expect(safeProviderError({ statusCode: 401, cause: socket })).toContain(
      'rejected these credentials',
    );
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(safeProviderError(cycle)).toContain('Could not complete the provider request');
  });
});
