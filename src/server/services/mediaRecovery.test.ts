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
it('omits provider-rejected tool media while retaining completed operations and factual metadata', () => {
  const messages: ModelMessage[] = [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolName: 'media',
          toolCallId: 'completed',
          output: {
            type: 'content',
            value: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  result: { name: 'recording.wav', mediaIncluded: true, mediaDelivery: 'included' },
                }),
              },
              {
                type: 'file',
                mediaType: 'audio/wav',
                data: { type: 'data', data: 'PRIVATE_BYTES' },
              },
            ],
          },
        },
      ],
    },
  ];
  const fallback = omitRejectedMedia(messages, 'format');
  expect(fallback.count).toBe(1);
  expect(JSON.stringify(fallback)).toContain('recording.wav');
  expect(JSON.stringify(fallback)).toContain('completed');
  expect(JSON.stringify(fallback)).not.toMatch(
    /PRIVATE_BYTES|tell the user|explain|suggest|do not claim/i,
  );
  const message = fallback.messages[0];
  if (
    message.role !== 'tool' ||
    message.content[0].type !== 'tool-result' ||
    message.content[0].output.type !== 'content'
  )
    throw new Error('Expected a tool result');
  expect(message.content[0].output.value[0]).toMatchObject({
    type: 'text',
    text: expect.stringContaining('"mediaIncluded":false'),
  });
});
