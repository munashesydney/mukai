import { expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { omitRejectedMedia, rejectedMedia } from './mediaRecovery';

it.each([
  { statusCode: 400, responseBody: '{"error":{"message":"Unsupported audio codec"}}' },
  { statusCode: 415, message: 'Unsupported media type' },
  { statusCode: 422, message: 'Invalid video format' },
  { name: 'AI_UnsupportedFunctionalityError', functionality: 'audio input' },
])('recognizes media admission failure: %j', (error) => {
  expect(rejectedMedia(error)).toBe('format');
  expect(rejectedMedia({ lastError: error })).toBe('format');
});
it('distinguishes size, context, credentials and network failures', () => {
  expect(rejectedMedia({ statusCode: 413, message: 'Too large' })).toBe('size');
  for (const error of [
    { statusCode: 413, message: 'maximum context length exceeded' },
    { statusCode: 401, message: 'audio credentials invalid' },
    { statusCode: 429, message: 'video quota exceeded' },
    { statusCode: 503, message: 'audio service unavailable' },
    { statusCode: 400, message: 'Invalid tool schema' },
    { name: 'AI_UnsupportedFunctionalityError', functionality: 'structured output' },
    new Error('audio socket closed'),
  ])
    expect(rejectedMedia({ cause: error })).toBeUndefined();
});
it('replaces only audio/video bytes, preserves tool pairs and does not mutate originals', () => {
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Explain this clip' },
        { type: 'file', mediaType: 'audio/wav', filename: 'recording.wav', data: 'private-audio' },
        { type: 'file', mediaType: 'video/mp4', filename: 'clip.mp4', data: 'private-video' },
        { type: 'file', mediaType: 'image/png', data: 'keep-image' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'done', toolName: 'browser', input: { action: 'tabs' } },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'done',
          toolName: 'browser',
          output: { type: 'text', value: 'completed result' },
        },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
  ];
  const original = JSON.stringify(messages);
  const fallback = omitRejectedMedia(messages, 'format');
  expect(fallback.count).toBe(2);
  const serialized = JSON.stringify(fallback.messages);
  expect(serialized).not.toMatch(/private-audio|private-video/);
  expect(serialized).toContain('recording.wav');
  expect(serialized).toContain('clip.mp4');
  expect(serialized).toContain('keep-image');
  expect(serialized).toContain('no transcript or description');
  for (let index = 1; index < messages.length; index++)
    expect(fallback.messages[index]).toBe(messages[index]);
  expect(JSON.stringify(messages)).toBe(original);
  expect(omitRejectedMedia(fallback.messages, 'format').count).toBe(0);
  expect(JSON.stringify(omitRejectedMedia(messages, 'size'))).toContain('size limit');
});
