import { expect, it } from 'vitest';
import { generateText, wrapLanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { compatibleAudioDataUrlMiddleware } from './compatibleImageMiddleware';

it.each([false, true])(
  'serializes supported audio/video with the installed SDK (MiMo data URL: %s)',
  async (mimo) => {
    let payload: { messages: { content: unknown }[] } | undefined;
    const adapter = createOpenAICompatible({
      name: 'fixture',
      baseURL: 'https://fixture.invalid/v1',
      fetch: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return Response.json({
          id: 'response',
          model: 'media',
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Media received.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    })('media');
    const model = mimo
      ? wrapLanguageModel({ model: adapter, middleware: compatibleAudioDataUrlMiddleware })
      : adapter;
    const result = await generateText({
      model,
      maxRetries: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'file', data: Buffer.from('audio'), mediaType: 'audio/wav' },
            { type: 'file', data: Buffer.from('video'), mediaType: 'video/mp4' },
          ],
        },
      ],
    });
    expect(result.text).toBe('Media received.');
    expect(payload!.messages[0].content).toEqual([
      {
        type: 'input_audio',
        input_audio: mimo
          ? { data: 'data:audio/wav;base64,YXVkaW8=' }
          : { data: 'YXVkaW8=', format: 'wav' },
      },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
    ]);
  },
);

it('serializes audio through the native OpenAI Chat Completions adapter', async () => {
  let payload: { messages: { content: unknown }[] } | undefined;
  const model = createOpenAI({
    apiKey: 'fixture',
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({
        id: 'response',
        model: 'gpt-audio',
        created: 1,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Audio received.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  }).chat('gpt-audio');
  await generateText({
    model,
    maxRetries: 0,
    messages: [
      {
        role: 'user',
        content: [{ type: 'file', mediaType: 'audio/wav', data: Buffer.from('audio') }],
      },
    ],
  });
  expect(payload!.messages[0].content).toEqual([
    { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
  ]);
});

it('serializes audio and video through the native Google inline-data adapter', async () => {
  let payload: { contents: { parts: unknown[] }[] } | undefined;
  const model = createGoogleGenerativeAI({
    apiKey: 'fixture',
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [{ text: 'Media received.' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
    },
  })('gemini-2.5-flash');
  await generateText({
    model,
    maxRetries: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'file', mediaType: 'audio/wav', data: Buffer.from('audio') },
          { type: 'file', mediaType: 'video/mp4', data: Buffer.from('video') },
        ],
      },
    ],
  });
  expect(payload!.contents[0].parts).toEqual([
    { inlineData: { mimeType: 'audio/wav', data: 'YXVkaW8=' } },
    { inlineData: { mimeType: 'video/mp4', data: 'dmlkZW8=' } },
  ]);
});
