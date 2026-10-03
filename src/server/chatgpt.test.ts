import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, tool, Output } from 'ai';
import { z } from 'zod';
import { Database } from './db/database';
import { ProviderRepository } from './repositories/providerRepository';
import { ChatGPTService, classifyChatGPTModel } from './services/chatgptService';
import { chatGPTRequest, collectChatGPTResponse } from './services/chatgptTransport';
import { DiagnosticService } from './services/diagnosticService';
import { safeProviderError } from './services/providerService';

let dir: string, database: Database, providers: ProviderRepository, service: ChatGPTService;
let authorization: URL;
let subject: string;
let permission: string;
let signatureNonce: string | undefined;
let tokenError: string | undefined;
let tokenCalls: URLSearchParams[];
let inferenceCalls: Record<string, unknown>[];
let inference: (init?: RequestInit) => Response;
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
function jwt(client: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://auth.openai.com',
      aud: client,
      sub: subject,
      email: 'same@example.com',
      nonce: signatureNonce ?? authorization.searchParams.get('nonce'),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  return `${header}.${payload}.${sign('sha256', Buffer.from(`${header}.${payload}`), keyPair.privateKey).toString('base64url')}`;
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function sse(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
function complete(text = 'OK') {
  return {
    id: 'resp_test',
    created_at: 1,
    model: 'gpt-4.1-mini',
    status: 'completed',
    object: 'response',
    output: [
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}
const request = vi.fn<typeof fetch>(async (input, init) => {
  const url = String(input);
  if (url.endsWith('/.well-known/openid-configuration'))
    return json({
      issuer: 'https://auth.openai.com',
      jwks_uri: 'https://auth.openai.com/jwks',
      revocation_endpoint: 'https://auth.openai.com/revoke',
    });
  if (url.endsWith('/jwks'))
    return json({
      keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' }],
    });
  if (url.endsWith('/oauth/token')) {
    const parameters = new URLSearchParams(String(init?.body));
    tokenCalls.push(parameters);
    if (tokenError) return json({ error: tokenError }, 400);
    return json({
      access_token: `access-${tokenCalls.length}`,
      refresh_token: `refresh-${tokenCalls.length}`,
      id_token: jwt(parameters.get('client_id')!),
      expires_in: 3600,
      token_type: 'Bearer',
      scope: permission,
    });
  }
  if (url.endsWith('/revoke')) return new Response('', { status: 200 });
  if (url.endsWith('/models'))
    return json({
      models: [
        {
          slug: 'gpt-6.1-sol',
          display_name: 'GPT Sol',
          visibility: 'list',
          context_window: 200000,
          input_modalities: ['text', 'image'],
        },
        { slug: 'gpt-5-codex', display_name: 'Codex', visibility: 'list' },
        { slug: 'o3', display_name: 'o3', visibility: 'list' },
        { slug: 'future-model', display_name: 'Future', visibility: 'list' },
        { slug: 'hidden', visibility: 'hidden' },
        { slug: 'gpt-6.1-sol', visibility: 'list' },
      ],
    });
  if (url.endsWith('/responses')) {
    inferenceCalls.push(JSON.parse(String(init?.body)));
    expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Bearer access-/);
    return inference(init);
  }
  throw new Error('Unexpected test endpoint');
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-chatgpt-'));
  database = new Database(dir);
  providers = new ProviderRepository(database);
  subject = 'subject-a';
  permission = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  signatureNonce = undefined;
  tokenError = undefined;
  tokenCalls = [];
  inferenceCalls = [];
  inference = () => sse([{ type: 'response.completed', response: complete() }]);
  const key = randomBytes(32);
  const encrypt = (value: string) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  };
  const decrypt = (value: string | null) => {
    if (!value) return undefined;
    const data = Buffer.from(value, 'base64'),
      decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  };
  request.mockClear();
  service = new ChatGPTService(
    providers,
    dir,
    encrypt,
    decrypt,
    new DiagnosticService(dir),
    request,
  );
});
afterEach(() => {
  service.shutdown();
  database.db.close();
  rmSync(dir, { recursive: true, force: true });
});
async function login(providerId?: string, client = 'oaiapp_test') {
  const attempt = await service.begin(providerId);
  authorization = new URL(attempt.url!);
  const callback = new URL(authorization.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({
    state: authorization.searchParams.get('state')!,
    code: 'test-code',
    client_id: client,
  }).toString();
  const response = await fetch(callback);
  return { attempt, response, result: service.status(attempt.id) };
}

describe('ChatGPT OAuth and accounts', () => {
  it('registers through PKCE, validates identity, and stores encrypted credentials', async () => {
    const { response, result } = await login();
    expect(response.status).toBe(200);
    expect(result.status).toBe('complete');
    expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorization.searchParams.get('agent_name_hint')).toBe('Mukai');
    expect(authorization.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    const parameters = tokenCalls[0];
    expect(parameters.get('client_id')).toBe('oaiapp_test');
    expect(parameters.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'));
    expect(parameters.has('client_secret')).toBe(false);
    expect(parameters.get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
    expect(providers.find(result.providerId!)?.encryptedKey).not.toContain('access-1');
    expect(service.describe(providers.find(result.providerId!)!)).toMatchObject({
      connected: true,
      planEnabled: true,
    });
  });
  it('rejects a forged state without consuming the real attempt', async () => {
    const attempt = await service.begin();
    authorization = new URL(attempt.url!);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.search = '?state=wrong&code=bad';
    expect((await fetch(callback)).status).toBe(400);
    expect(service.status(attempt.id).status).toBe('pending');
    expect(tokenCalls).toHaveLength(0);
  });
  it('rejects a valid signature with the wrong nonce', async () => {
    signatureNonce = 'wrong';
    const { result } = await login();
    expect(result.status).toBe('failed');
    expect(providers.list()).toHaveLength(0);
  });
  it('handles declined authorization without exchanging a code', async () => {
    const attempt = await service.begin();
    authorization = new URL(attempt.url!);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({
      state: authorization.searchParams.get('state')!,
      error: 'access_denied',
    }).toString();
    await fetch(callback);
    expect(service.status(attempt.id).status).toBe('failed');
    expect(tokenCalls).toHaveLength(0);
  });
  it('retains a sign-in without inference permission and prevents model/inference requests', async () => {
    permission = 'openid profile email';
    const { result } = await login();
    expect(result.status).toBe('complete');
    expect(service.describe(providers.find(result.providerId!)!).planEnabled).toBe(false);
    await expect(service.models(result.providerId!)).rejects.toThrow('Enable ChatGPT plan usage');
  });
  it('reuses client and host IDs, rejects another identity, and preserves original credentials', async () => {
    const { result } = await login();
    const id = result.providerId!;
    const host = authorization.searchParams.get('ext_agent_host_id');
    subject = 'different';
    expect((await login(id)).result.status).toBe('failed');
    expect(authorization.searchParams.get('client_id')).toBe('oaiapp_test');
    expect(authorization.searchParams.has('agent_name_hint')).toBe(false);
    expect(authorization.searchParams.get('ext_agent_host_id')).toBe(host);
    expect(authorization.searchParams.has('id_token_hint')).toBe(true);
    expect(await service.accessToken(id)).toBe('access-1');
  });
  it('keeps separate registrations with identical emails separate', async () => {
    await login(undefined, 'oaiapp_one');
    await login(undefined, 'oaiapp_two');
    expect(providers.list()).toHaveLength(2);
    expect(new Set(providers.list().map((provider) => service.describe(provider).label)).size).toBe(
      2,
    );
  });
  it('cancels pending attempts and rejects callbacks after cancellation', async () => {
    const attempt = await service.begin();
    service.cancel(attempt.id);
    expect(service.status(attempt.id).status).toBe('cancelled');
    expect(providers.list()).toHaveLength(0);
  });
  it('retains an issued client after a failed code exchange for a fresh authorization', async () => {
    tokenError = 'invalid_grant';
    const { result } = await login();
    expect(result.status).toBe('failed');
    const retry = await service.begin(undefined, false, result.id);
    expect(new URL(retry.url!).searchParams.get('client_id')).toBe('oaiapp_test');
    expect(new URL(retry.url!).searchParams.has('agent_name_hint')).toBe(false);
    expect(providers.list()).toHaveLength(0);
  });
  it('rejects a changed client ID before replacing a returning account', async () => {
    const { result } = await login();
    const mismatch = await login(result.providerId, 'oaiapp_other');
    expect(mismatch.result.status).toBe('failed');
    expect(tokenCalls).toHaveLength(1);
    expect(await service.accessToken(result.providerId!)).toBe('access-1');
  });
  it('serializes token rotation, revokes on sign-out, and retains client identity', async () => {
    const { result } = await login();
    const id = result.providerId!;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600000);
    try {
      expect(await Promise.all([service.accessToken(id), service.accessToken(id)])).toEqual([
        'access-2',
        'access-2',
      ]);
      expect(tokenCalls).toHaveLength(2);
      expect(tokenCalls[1].get('refresh_token')).toBe('refresh-1');
      expect(tokenCalls[1].has('scope')).toBe(false);
      await service.disconnect(id);
      expect(service.describe(providers.find(id)!)).toMatchObject({
        connected: false,
        clientId: 'oaiapp_test',
      });
      await expect(service.accessToken(id)).rejects.toThrow('Reconnect');
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('clears revoked refresh tokens but preserves credentials after temporary failure', async () => {
    const { result } = await login();
    const id = result.providerId!;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600000);
    try {
      tokenError = 'temporarily_unavailable';
      await expect(service.accessToken(id)).rejects.toThrow();
      expect(service.describe(providers.find(id)!).connected).toBe(true);
      tokenError = 'invalid_grant';
      await expect(service.accessToken(id)).rejects.toThrow('revoked');
      expect(service.describe(providers.find(id)!).connected).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('filters hidden/duplicate models and groups families without guessing unknown capabilities', async () => {
    const { result } = await login();
    const models = await service.models(result.providerId!);
    expect(models.map((model) => model.category)).toEqual(['GPT', 'Codex', 'Reasoning', 'Other']);
    expect(models[0]).toMatchObject({ contextWindowTokens: 200000, supportsImages: true });
    expect(models[1]).toMatchObject({ contextWindowTokens: null, supportsImages: null });
    expect(classifyChatGPTModel('gpt-6-astra')).toBe('GPT');
  });
});

describe('ChatGPT Responses compatibility', () => {
  it('omits rejected fields, maps system messages, and namespaces local tools/history', () => {
    const body = chatGPTRequest({
      input: [
        { role: 'system', content: 'hello' },
        { type: 'function_call', name: 'read', call_id: 'a' },
      ],
      tools: [{ type: 'function', name: 'read', parameters: {} }],
      store: true,
      stream: false,
      temperature: 0.5,
      max_output_tokens: 8192,
      previous_response_id: 'prior',
      conversation: 'server-side',
    });
    expect(body).toMatchObject({
      store: false,
      stream: true,
      input: [{ role: 'developer' }, { namespace: 'mukai' }],
      tools: [{ type: 'namespace', name: 'mukai' }],
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('previous_response_id');
    expect(() => chatGPTRequest({ input: [], tools: [{ type: 'file_search' }] })).toThrow(
      'not supported',
    );
  });
  it('runs real SDK generateText over streaming HTTP for connection tests and summaries', async () => {
    const { result } = await login();
    const model = createOpenAI({
      apiKey: 'placeholder',
      fetch: service.fetch(result.providerId!),
    }).responses('gpt-4.1-mini');
    const response = await generateText({
      model,
      system: 'Be concise.',
      prompt: 'Hi',
      maxOutputTokens: 64,
      maxRetries: 0,
      providerOptions: { openai: { store: false } },
    });
    expect(response.text).toBe('OK');
    expect(response.usage.totalTokens).toBe(12);
    expect(inferenceCalls[0]).toMatchObject({ store: false, stream: true });
    expect(inferenceCalls[0]).not.toHaveProperty('max_output_tokens');
    expect(inferenceCalls[0].input).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'developer' })]),
    );
  });
  it('extracts structured memory when ChatGPT omits completed items from the terminal output', async () => {
    const { result } = await login();
    const text = JSON.stringify({ facts: [{ subject: 'User', preference: 'espresso' }] });
    const response = complete(text);
    const message = response.output[0];
    const reasoning = { id: 'rs_test', type: 'reasoning', summary: [] };
    inference = () =>
      sse([
        { type: 'response.output_item.done', output_index: 0, item: reasoning },
        { type: 'response.output_text.delta', output_index: 1, delta: text },
        { type: 'response.output_item.done', output_index: 1, item: message },
        { type: 'response.completed', response: { ...response, output: [] } },
      ]);
    const model = createOpenAI({
      apiKey: 'placeholder',
      fetch: service.fetch(result.providerId!),
    }).responses('gpt-4.1-mini');
    const extracted = await generateText({
      model,
      prompt: 'Extract the durable preference.',
      output: Output.object({
        schema: z.object({
          facts: z.array(z.object({ subject: z.string(), preference: z.string() })),
        }),
      }),
      maxRetries: 0,
      providerOptions: { openai: { store: false } },
    });
    expect(extracted.output).toEqual({ facts: [{ subject: 'User', preference: 'espresso' }] });
    expect(extracted.usage.totalTokens).toBe(12);
    const full = await collectChatGPTResponse(
      sse([
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response },
      ]),
    );
    expect((await full.json()).output).toEqual(response.output);
    const partial = await collectChatGPTResponse(
      sse([
        { type: 'response.output_item.done', output_index: 0, item: reasoning },
        { type: 'response.output_item.done', output_index: 1, item: message },
        { type: 'response.completed', response: { ...response, output: [reasoning] } },
      ]),
    );
    expect((await partial.json()).output.map((item: { id: string }) => item.id)).toEqual([
      'rs_test',
      'msg_test',
    ]);
  });
  it('executes namespaced tool calls with the real SDK', async () => {
    const { result } = await login();
    const execute = vi.fn(async () => 'file contents');
    inference = () =>
      sse([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            id: 'fc_test',
            type: 'function_call',
            call_id: 'call_test',
            name: 'read',
            namespace: 'mukai',
            arguments: '',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_test',
          output_index: 0,
          delta: '{}',
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: 'fc_test',
            type: 'function_call',
            call_id: 'call_test',
            name: 'read',
            namespace: 'mukai',
            arguments: '{}',
            status: 'completed',
          },
        },
        {
          type: 'response.completed',
          response: {
            ...complete(),
            output: [
              {
                id: 'fc_test',
                type: 'function_call',
                call_id: 'call_test',
                name: 'read',
                namespace: 'mukai',
                arguments: '{}',
              },
            ],
          },
        },
      ]);
    const model = createOpenAI({
      apiKey: 'placeholder',
      fetch: service.fetch(result.providerId!),
    }).responses('gpt-4.1-mini');
    const response = streamText({
      model,
      prompt: 'Read a file',
      maxRetries: 0,
      tools: { read: tool({ inputSchema: z.object({}), execute }) },
    });
    for await (const chunk of response.fullStream) if (chunk.type === 'error') throw chunk.error;
    expect(execute).toHaveBeenCalledOnce();
    expect(inferenceCalls[0].tools).toEqual([
      expect.objectContaining({ type: 'namespace', name: 'mukai' }),
    ]);
  });
  it('rejects an interrupted stream and reports a late plan-limit failure', async () => {
    await expect(
      collectChatGPTResponse(sse([{ type: 'response.output_text.delta', delta: 'Partial' }])),
    ).rejects.toThrow('interrupted');
    await expect(
      collectChatGPTResponse(
        sse([
          {
            type: 'response.failed',
            response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
          },
        ]),
      ),
    ).rejects.toThrow('app usage limit');
    expect(safeProviderError({ code: 'subscription_sharing_usage_limit_exceeded' })).toContain(
      'ChatGPT Settings',
    );
    const { result } = await login();
    inference = () => sse([{ type: 'response.output_text.delta', delta: 'Partial' }]);
    const response = await service.fetch(result.providerId!)(
      'https://api.openai.com/v1/responses',
      { method: 'POST', body: JSON.stringify({ input: [], stream: true }) },
    );
    await expect(response.text()).rejects.toThrow('interrupted');
  });
  it('preserves streamed text and reports a late quota failure through the real SDK', async () => {
    const { result } = await login();
    inference = () =>
      sse([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_test',
          output_index: 0,
          content_index: 0,
          delta: 'Partial text',
        },
        {
          type: 'response.failed',
          sequence_number: 2,
          response: {
            error: {
              code: 'subscription_sharing_usage_limit_exceeded',
              message: 'Limit reached',
              type: 'rate_limit_error',
              param: null,
            },
          },
        },
      ]);
    const model = createOpenAI({
      apiKey: 'placeholder',
      fetch: service.fetch(result.providerId!),
    }).responses('gpt-4.1-mini');
    const stream = streamText({ model, prompt: 'Hi', maxRetries: 0 });
    let text = '',
      failure: unknown;
    for await (const chunk of stream.fullStream) {
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'error') failure = chunk.error;
    }
    expect(text).toBe('Partial text');
    expect(safeProviderError(failure)).toContain('ChatGPT Settings');
    expect(inferenceCalls).toHaveLength(1);
  });
  it('disconnect cancels active inference and prevents subsequent requests', async () => {
    const { result } = await login();
    const id = result.providerId!;
    inference = (init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new Error('Signed out')),
              { once: true },
            );
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    const response = await service.fetch(id)('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [], stream: true }),
    });
    const reading = response.text();
    const rejected = expect(reading).rejects.toThrow('Signed out');
    await service.disconnect(id);
    await rejected;
    await expect(service.accessToken(id)).rejects.toThrow('Reconnect');
  });
  it('handles nonstandard admission errors without clearing credentials or suggesting an API key', async () => {
    const { result } = await login();
    const id = result.providerId!;
    const send = () =>
      service.fetch(id)('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ input: [], stream: true }),
      });
    inference = () => json({ detail: 'Unavailable' }, 503);
    await expect(send()).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('credentials are saved'),
    });
    expect(service.describe(providers.find(id)!).connected).toBe(true);
    inference = () => json({ detail: 'Signed context rejected' }, 401);
    await expect(send()).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('Reconnect'),
    });
  });
});
