import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, wrapLanguageModel } from 'ai';
import { compatibleImageMiddleware } from './compatibleImageMiddleware';
import { ApiError, privateSecret } from '../config';
import type { BotRecord, ProviderRecord } from '../models/entities';
import { publicProvider } from '../models/entities';
import type { ProviderInput } from '../../shared/ai';
import { ProviderRepository } from '../repositories/providerRepository';
import { BotRepository } from '../repositories/botRepository';
import { modelContextWindow } from '../../shared/modelLimits';
import type { DiagnosticService } from './diagnosticService';
import { ChatGPTService } from './chatgptService';
import { chatGPTError } from './chatgptTransport';
import { PROVIDER_MAX_RETRIES } from './responsePolicy';

// Provider warning strings are untrusted and can include request details.
globalThis.AI_SDK_LOG_WARNINGS = false;

export function isContextOverflow(error: unknown) {
  const value = error as { statusCode?: number; message?: string; responseBody?: string };
  return (
    [400, 413, 422].includes(value?.statusCode ?? 0) &&
    /context[_ ](?:length|window)|maximum context|too many (?:input )?tokens|prompt (?:is )?too long|input.*exceed.*token/i.test(
      `${value.message ?? ''} ${value.responseBody ?? ''}`,
    )
  );
}

function transportErrorMessage(error: unknown): string | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const errors: { name?: string; code?: string; message?: string; statusCode?: number }[] = [];
  // SDK retries wrap the API error in lastError; fetch wraps the socket error in cause.
  while (pending.length && seen.size < 16) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const detail = current as (typeof errors)[number] & { cause?: unknown; lastError?: unknown };
    errors.push(detail);
    pending.push(detail.cause, detail.lastError);
  }
  // An HTTP rejection has its own explanation, even if its text mentions a connection.
  if (errors.some((detail) => typeof detail.statusCode === 'number' && detail.statusCode >= 400))
    return;
  if (
    errors.some(
      (detail) =>
        ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(detail.code || '') ||
        (detail.name === 'SocketError' && /other side closed/i.test(detail.message || '')),
    )
  )
    return 'The connection to the provider closed unexpectedly. Check your connection and retry.';
  if (
    errors.some(
      (detail) =>
        detail.name === 'TimeoutError' ||
        [
          'UND_ERR_CONNECT_TIMEOUT',
          'UND_ERR_HEADERS_TIMEOUT',
          'UND_ERR_BODY_TIMEOUT',
          'ETIMEDOUT',
        ].includes(detail.code || ''),
    )
  )
    return 'The provider connection timed out. Check your connection and retry.';
  if (
    errors.some(
      (detail) =>
        ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(
          detail.code || '',
        ) ||
        (detail.name === 'TypeError' && /^fetch failed$/i.test(detail.message || '')),
    )
  )
    return 'Could not connect to the provider. Check your internet connection and provider endpoint, then retry.';
}

export function safeProviderError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  const detail = error as {
    code?: string;
    data?: { error?: { code?: string } };
    responseBody?: string;
  };
  let code = detail.code || detail.data?.error?.code;
  if (!code && detail.responseBody) {
    try {
      code = JSON.parse(detail.responseBody).error?.code;
    } catch {
      /* Not every admission error is JSON. */
    }
  }
  if (code && /^(subscription_sharing_|chatpass_v2_)/.test(code)) return chatGPTError(code);
  if (isContextOverflow(error))
    return 'The provider rejected the context size. Check the model’s context-window setting and retry; your saved history is preserved.';
  const connectionError = transportErrorMessage(error);
  if (connectionError) return connectionError;
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
  readonly chatgpt: ChatGPTService;
  constructor(
    private providers: ProviderRepository,
    private bots: BotRepository,
    dir: string,
    private diagnostics: DiagnosticService,
  ) {
    this.key = privateSecret(dir, 'credentials.key', 32);
    this.chatgpt = new ChatGPTService(
      providers,
      dir,
      (value) => this.encrypt(value),
      (value) => this.decrypt(value),
      diagnostics,
    );
  }
  list() {
    return this.providers.list().map((provider) => this.public(provider));
  }
  private public(provider: ProviderRecord) {
    return {
      ...publicProvider(provider),
      ...(provider.kind === 'chatgpt'
        ? { hasKey: false, account: this.chatgpt.describe(provider) }
        : {}),
    };
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
    const key = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
    this.diagnostics.registerSecret(key);
    return key;
  }
  save(input: ProviderInput, id?: string) {
    const value = { ...input };
    const existing = id ? this.require(id) : undefined;
    if (value.kind === 'chatgpt' && !existing)
      throw new ApiError(400, 'Use Continue with ChatGPT to add this provider.');
    if (value.kind === 'chatgpt' && (value.apiKey || value.clearKey))
      throw new ApiError(400, 'ChatGPT credentials are managed through sign-in.');
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
      models:
        value.models ??
        existing?.models ??
        (value.defaultModel
          ? [
              {
                id: value.defaultModel,
                name: value.defaultModel,
                contextWindowTokens: value.contextWindowTokens ?? null,
                maxOutputTokens: value.maxOutputTokens ?? 8192,
                supportsImages: value.supportsImages,
              },
            ]
          : []),
      id: providerId,
      name: value.name,
      kind: value.kind,
      baseUrl: value.baseUrl,
      defaultModel: value.defaultModel,
      supportsImages: value.supportsImages,
      // A saved default remains default until another provider is selected.
      isDefault: value.isDefault || Boolean(existing?.isDefault),
      encryptedKey,
      contextWindowTokens:
        value.contextWindowTokens !== undefined
          ? value.contextWindowTokens
          : ((existing?.defaultModel === value.defaultModel
              ? existing.contextWindowTokens
              : null) ?? null),
      maxOutputTokens: value.maxOutputTokens ?? existing?.maxOutputTokens ?? 8192,
    };
    if (value.models !== undefined) {
      const selected = value.models.find((model) => model.id === value.defaultModel);
      if (value.defaultModel && !selected)
        throw new ApiError(400, 'Choose a saved model as the provider default.');
      if (selected) {
        provider.contextWindowTokens = selected.contextWindowTokens;
        provider.maxOutputTokens = selected.maxOutputTokens;
        provider.supportsImages = selected.supportsImages;
      }
    }
    this.providers.save(provider);
    return this.public(provider);
  }
  async remove(id: string) {
    this.require(id);
    if (this.bots.usesProvider(id))
      throw new ApiError(
        409,
        'A bot uses this provider. Edit its model settings before removing the provider.',
      );
    const result =
      this.require(id).kind === 'chatgpt'
        ? await this.chatgpt.disconnect(id)
        : { ok: true, message: 'Provider removed.' };
    this.providers.delete(id);
    this.chatgpt.cancelForProvider(id);
    return result;
  }
  async validateModel(id: string | null, model: string | null) {
    const provider = id ? this.providers.find(id) : this.providers.default();
    if (provider?.kind !== 'chatgpt') return;
    if (!model && !provider.defaultModel) return;
    const models = await this.models(provider.id);
    if (!models.some((item) => item.id === (model || provider.defaultModel)))
      throw new ApiError(
        400,
        'Choose a model available to this ChatGPT account. Refresh models in Settings.',
      );
  }
  async models(id: string) {
    const models = await this.chatgpt.models(id);
    const provider = this.require(id);
    const saved = provider.models ?? [];
    const added = models
      .filter((model) => !saved.some((item) => item.id === model.id))
      .map((model) => ({
        id: model.id,
        name: model.name,
        contextWindowTokens: model.contextWindowTokens,
        maxOutputTokens: provider.maxOutputTokens ?? 8192,
        supportsImages: model.supportsImages ?? false,
      }));
    if (added.length) this.providers.save({ ...provider, models: [...saved, ...added] });
    return models;
  }
  resolve(bot: BotRecord) {
    const provider = bot.providerId
      ? this.providers.find(bot.providerId)
      : this.providers.default();
    if (!provider) throw new ApiError(400, 'Configure a provider in Settings before chatting.');
    const modelId = String(bot.model || provider.defaultModel);
    if (!modelId.trim())
      throw new ApiError(400, 'Choose a model for this provider in Settings before chatting.');
    const configured = provider.models?.find((model) => model.id === modelId);
    return {
      provider,
      modelId,
      contextWindow: modelContextWindow(bot, provider),
      maxOutputTokens:
        configured?.maxOutputTokens ?? bot.maxOutputTokens ?? provider.maxOutputTokens ?? 8192,
      vision:
        configured?.supportsImages ??
        (bot.supportsImages === null
          ? Boolean(provider.supportsImages)
          : Boolean(bot.supportsImages)),
      model: this.model(provider, modelId),
      options: this.reasoningOptions(provider, modelId),
    };
  }
  private reasoningOptions(provider: ProviderRecord, model: string) {
    const openai =
      ['openai', 'chatgpt'].includes(provider.kind) && /^(o[1-9]|gpt-[5-9])/i.test(model)
        ? { store: false, reasoningSummary: 'auto', reasoningEffort: 'medium' }
        : { store: false };
    const anthropic =
      provider.kind === 'anthropic' && /claude-(?:sonnet|opus)-4-[6-9]/i.test(model)
        ? { thinking: { type: 'adaptive' } }
        : provider.kind === 'anthropic' && /claude-(?:3-7|(?:sonnet|opus)-4)/i.test(model)
          ? { thinking: { type: 'enabled', budgetTokens: 2048 } }
          : {};
    const google =
      provider.kind === 'google' && /^gemini-(?:2\.5|[3-9])/i.test(model)
        ? { thinkingConfig: { includeThoughts: true } }
        : {};
    return {
      openai: provider.kind === 'chatgpt' ? { ...openai, systemMessageMode: 'developer' } : openai,
      anthropic,
      google,
    };
  }
  private model(provider: ProviderRecord, id: string) {
    if (provider.kind === 'chatgpt')
      return createOpenAI({
        apiKey: 'chatgpt-oauth-managed',
        fetch: this.chatgpt.fetch(provider.id),
      }).responses(id);
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
        return wrapLanguageModel({
          model: createOpenAICompatible({
            name: 'mukai-custom',
            baseURL: String(provider.baseUrl),
            apiKey,
            fetch: secureFetch,
          })(id),
          middleware: compatibleImageMiddleware,
        });
    }
  }
  async test(id: string) {
    const provider = this.require(id);
    if (!provider.defaultModel)
      throw new ApiError(400, 'Add a model in Settings before testing this connection.');
    try {
      const result = await generateText({
        model: this.model(provider, String(provider.defaultModel)),
        prompt: 'Reply with OK.',
        maxOutputTokens: 64,
        maxRetries: PROVIDER_MAX_RETRIES,
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
      this.diagnostics.record('provider.test_failed', error, {
        providerId: provider.id,
        providerKind: provider.kind,
        model: provider.defaultModel,
        phase: 'provider-test',
      });
      throw new ApiError(502, safeProviderError(error));
    }
  }
}
