import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { ApiError, privateSecret } from '../config';
import type { BotRecord, ProviderRecord } from '../models/entities';
import { publicProvider } from '../models/entities';
import type { ProviderInput } from '../../shared/ai';
import { ProviderRepository } from '../repositories/providerRepository';
import { BotRepository } from '../repositories/botRepository';

// Provider warning strings are untrusted and can include request details.
globalThis.AI_SDK_LOG_WARNINGS = false;

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
export class ProviderService {
  private key: Buffer;
  constructor(
    private providers: ProviderRepository,
    private bots: BotRepository,
    dir: string,
  ) {
    this.key = privateSecret(dir, 'credentials.key', 32);
  }
  list() {
    return this.providers.list().map(publicProvider);
  }
  require(id: string) {
    const provider = this.providers.find(id);
    if (!provider) throw new ApiError(404, 'Provider not found.');
    return provider;
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
  save(input: ProviderInput, id?: string) {
    const value = { ...input };
    const existing = id ? this.require(id) : undefined;
    const providerId = id || randomUUID();
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
        : (existing?.encryptedKey ?? null);
    if (value.kind !== 'compatible' && !encryptedKey)
      throw new ApiError(400, 'An API key is required for this provider.');
    if (!this.providers.list().length) value.isDefault = true;
    const provider: ProviderRecord = {
      id: providerId,
      name: value.name,
      kind: value.kind,
      baseUrl: value.baseUrl,
      defaultModel: value.defaultModel,
      supportsImages: value.supportsImages,
      // A saved default remains default until another provider is selected.
      isDefault: value.isDefault || Boolean(existing?.isDefault),
      encryptedKey,
    };
    this.providers.save(provider);
    return publicProvider(provider);
  }
  remove(id: string) {
    this.require(id);
    if (this.bots.usesProvider(id))
      throw new ApiError(
        409,
        'A bot uses this provider. Edit its model settings before removing the provider.',
      );
    this.providers.delete(id);
  }
  resolve(bot: BotRecord) {
    const provider = bot.providerId
      ? this.providers.find(bot.providerId)
      : this.providers.default();
    if (!provider) throw new ApiError(400, 'Configure a provider in Settings before chatting.');
    const modelId = String(bot.model || provider.defaultModel);
    return {
      provider,
      modelId,
      vision:
        bot.supportsImages === null
          ? Boolean(provider.supportsImages)
          : Boolean(bot.supportsImages),
      model: this.model(provider, modelId),
    };
  }
  private model(provider: ProviderRecord, id: string) {
    const apiKey = this.decrypt(provider.encryptedKey as string | null);
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
          baseURL: String(provider.baseUrl),
          apiKey,
          fetch: secureFetch,
        })(id);
    }
  }
  async test(id: string) {
    const provider = this.require(id);
    try {
      const result = await generateText({
        model: this.model(provider, String(provider.defaultModel)),
        prompt: 'Reply with OK.',
        maxOutputTokens: 64,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(20000),
        providerOptions: { openai: { store: false } },
      });
      if (!result.text.trim())
        return {
          ok: true,
          message: `Connected to ${String(provider.defaultModel)}. The provider accepted the test but returned no text at the short output limit. Try a chat message to check its output.`,
        };
      return {
        ok: true,
        message: `Connected to ${String(provider.defaultModel)}. A short test request was sent.`,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, safeProviderError(error));
    }
  }
}
