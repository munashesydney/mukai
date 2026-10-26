import { expect, it } from 'vitest';
import { generateText, wrapLanguageModel, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { toolMediaMiddleware } from './toolMediaMiddleware';
import { compatibleAudioDataUrlMiddleware } from './compatibleImageMiddleware';
import { mediaModelOutput } from '../tools/media/execute';

it.each(['compatible', 'mimo', 'openai', 'google'] as const)(
  'delivers tool media as actual next-step model input through %s',
  async (provider) => {
    let payload: unknown;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json(
        provider === 'google'
          ? {
              candidates: [
                {
                  index: 0,
                  content: { role: 'model', parts: [{ text: 'Received.' }] },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
            }
          : {
              id: 'response',
              model: 'media',
              created: 1,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Received.' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
      );
    };
    const adapter =
      provider === 'google'
        ? createGoogleGenerativeAI({ apiKey: 'fixture', fetch })('gemini-2.5-flash')
        : provider === 'openai'
          ? createOpenAI({ apiKey: 'fixture', fetch }).chat('gpt-audio')
          : createOpenAICompatible({
              name: 'fixture',
              baseURL: 'https://fixture.invalid/v1',
              fetch,
            })('media');
    const inner =
      provider === 'mimo'
        ? wrapLanguageModel({ model: adapter, middleware: compatibleAudioDataUrlMiddleware })
        : adapter;
    const model = wrapLanguageModel({ model: inner, middleware: toolMediaMiddleware });
    const types = provider === 'openai' ? ['audio/wav'] : ['audio/wav', 'video/mp4'];
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Inspect the files.' },
      {
        role: 'assistant',
        content: types.map((mediaType, i) => ({
          type: 'tool-call',
          toolCallId: String(i),
          toolName: 'media',
          input: {
            action: mediaType.startsWith('audio') ? 'listen_audio' : 'view_video',
            path: 'file',
          },
        })),
      },
      {
        role: 'tool',
        content: types.map((mediaType, i) => ({
          type: 'tool-result',
          toolCallId: String(i),
          toolName: 'media',
          output: mediaModelOutput({
            ok: true,
            result: { mediaType, media: Buffer.from(mediaType).toString('base64') },
          }),
        })),
      },
    ];
    const original = JSON.stringify(messages);
    await generateText({ model, maxRetries: 0, messages });
    expect(JSON.stringify(messages)).toBe(original);
    const serialized = JSON.stringify(payload);
    for (const type of types) expect(serialized).toContain(Buffer.from(type).toString('base64'));
    if (provider === 'google') expect(serialized).toContain('inlineData');
    else {
      const sent = payload as { messages: { role: string; content: unknown }[] };
      const lastTool = sent.messages.reduce(
        (last, message, index) => (message.role === 'tool' ? index : last),
        -1,
      );
      const observation = sent.messages[lastTool + 1];
      expect(observation.role).toBe('user');
      expect(JSON.stringify(observation.content)).toContain('input_audio');
      expect(
        JSON.stringify(sent.messages.filter((message) => message.role === 'tool')),
      ).not.toContain('input_audio');
      if (provider === 'mimo')
        expect(JSON.stringify(observation.content)).toContain('data:audio/wav;base64,');
      if (provider !== 'openai') expect(JSON.stringify(observation.content)).toContain('video_url');
    }
  },
);
