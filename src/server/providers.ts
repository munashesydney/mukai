import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { z } from 'zod';
import { ApiError, privateSecret } from './config';
import { Store, type Row, providerDto } from './database';

// Provider warning strings are untrusted and can include request details.
globalThis.AI_SDK_LOG_WARNINGS = false;

const providerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['openai', 'anthropic', 'google', 'compatible']),
  baseUrl: z.string().trim().max(500),
  defaultModel: z.string().trim().min(1).max(150),
  supportsImages: z.boolean(),
  isDefault: z.boolean(),
  apiKey: z.string().trim().max(4096).optional(),
  clearKey: z.boolean().optional(),
});
export function safeProviderError(error: unknown) {
  const status = (error as { statusCode?: number })?.statusCode;
  if (status === 401 || status === 403)
    return 'The provider rejected these credentials. Check the API key and permissions.';
  if (status === 429)
    return 'The provider rate limit or quota was reached. Check your account, then retry.';
  if (status === 404)
    return 'The model or endpoint was not found. Check the model ID and base URL.';
  if (status === 400 || status === 422)
    return 'The provider rejected this request. Check the model’s capabilities and settings.';
  if ((error as Error)?.name === 'TimeoutError')
    return 'The provider timed out. Check the endpoint and retry.';
  return 'Could not complete the provider request. Check the connection, credentials, model, and account balance, then retry.';
}
export class Providers {
  private key: Buffer;
  constructor(private store: Store) {
    this.key = privateSecret(store.dir, 'credentials.key', 32);
  }
  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  private decrypt(value: string | null) {
    if (!value) return undefined;
    const data = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }
  save(input: unknown, id: string = this.store.id()) {
    const value = providerSchema.parse(input);
    const existing = this.store.get('SELECT * FROM providers WHERE id = ?', id);
    if (existing && existing.kind !== value.kind)
      throw new ApiError(400, 'Provider type cannot be changed. Add a new provider instead.');
    if (value.kind === 'compatible') {
      let url: URL;
      try {
        url = new URL(value.baseUrl);
      } catch {
        throw new ApiError(400, 'Enter a valid endpoint URL.');
      }
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new ApiError(
          400,
          'Use an HTTP(S) base URL without embedded credentials, query parameters, or fragments.',
        );
      if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new ApiError(
          400,
          'Use HTTPS for remote endpoints. HTTP is supported for local models on this computer.',
        );
      value.baseUrl = value.baseUrl.replace(/\/+$/, '');
    } else value.baseUrl = '';
    const encryptedKey = value.clearKey
      ? null
      : value.apiKey
        ? this.encrypt(value.apiKey)
        : (existing?.encrypted_key ?? null);
    if (value.kind !== 'compatible' && !encryptedKey)
      throw new ApiError(400, 'An API key is required for this provider.');
    if (!this.store.providers().length) value.isDefault = true;
    this.store.transaction(() => {
      if (value.isDefault) this.store.run('UPDATE providers SET is_default = 0');
      // A saved default remains default until another provider is selected.
      const isDefault = value.isDefault || Boolean(existing?.is_default);
      this.store.run(
        `INSERT INTO providers VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,base_url=excluded.base_url,default_model=excluded.default_model,supports_images=excluded.supports_images,is_default=excluded.is_default,encrypted_key=excluded.encrypted_key`,
        id,
        value.name,
        value.kind,
        value.baseUrl,
        value.defaultModel,
        Number(value.supportsImages),
        Number(isDefault),
        encryptedKey,
      );
    });
    return providerDto(this.store.get('SELECT * FROM providers WHERE id = ?', id)!);
  }
  remove(id: string) {
    if (!this.store.get('SELECT id FROM providers WHERE id = ?', id))
      throw new ApiError(404, 'Provider not found.');
    if (this.store.get('SELECT id FROM bots WHERE provider_id = ?', id))
      throw new ApiError(
        409,
        'A bot uses this provider. Edit its model settings before removing the provider.',
      );
    this.store.transaction(() => {
      this.store.run('DELETE FROM providers WHERE id = ?', id);
      if (!this.store.get('SELECT id FROM providers WHERE is_default = 1')) {
        const next = this.store.get('SELECT id FROM providers ORDER BY name LIMIT 1');
        if (next) this.store.run('UPDATE providers SET is_default = 1 WHERE id = ?', next.id);
      }
    });
  }
  resolve(bot: Row) {
    const provider = bot.provider_id
      ? this.store.get('SELECT * FROM providers WHERE id = ?', bot.provider_id)
      : this.store.get('SELECT * FROM providers WHERE is_default = 1');
    if (!provider) throw new ApiError(400, 'Configure a provider in Settings before chatting.');
    const modelId = String(bot.model || provider.default_model);
    return {
      provider,
      modelId,
      vision:
        bot.supports_images === null
          ? Boolean(provider.supports_images)
          : Boolean(bot.supports_images),
      model: this.model(provider, modelId),
    };
  }
  private model(provider: Row, id: string) {
    const apiKey = this.decrypt(provider.encrypted_key as string | null);
    const secureFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });
    switch (provider.kind) {
      case 'openai':
        return createOpenAI({ apiKey, fetch: secureFetch }).responses(id);
      case 'anthropic':
        return createAnthropic({ apiKey, fetch: secureFetch })(id);
      case 'google':
        return createGoogleGenerativeAI({ apiKey, fetch: secureFetch })(id);
      default:
        return createOpenAICompatible({
          name: 'mukai-custom',
          baseURL: String(provider.base_url),
          apiKey,
          fetch: secureFetch,
        })(id);
    }
  }
  async test(id: string) {
    const provider = this.store.get('SELECT * FROM providers WHERE id = ?', id);
    if (!provider) throw new ApiError(404, 'Provider not found.');
    try {
      const result = await generateText({
        model: this.model(provider, String(provider.default_model)),
        prompt: 'Reply with OK.',
        maxOutputTokens: 64,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(20000),
        providerOptions: { openai: { store: false } },
      });
      if (!result.text.trim())
        return {
          ok: true,
          message: `Connected to ${String(provider.default_model)}. The provider accepted the test but returned no text at the short output limit. Try a chat message to check its output.`,
        };
      return {
        ok: true,
        message: `Connected to ${String(provider.default_model)}. A short test request was sent.`,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, safeProviderError(error));
    }
  }
}
