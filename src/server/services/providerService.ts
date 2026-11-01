import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, wrapLanguageModel } from 'ai';
import {
  compatibleImageMiddleware,
  compatibleAudioDataUrlMiddleware,
} from './compatibleImageMiddleware';
import { inputCapabilityLabel, modelInputCapabilities } from '../../shared/modelCapabilities';
import { toolMediaMiddleware } from './toolMediaMiddleware';
import { ApiError, privateSecret } from '../config';
import type { BotRecord, ProviderRecord } from '../models/entities';
import { publicProvider } from '../models/entities';
import type { ProviderInput, ProviderModelsInput, SavedProviderModel } from '../../shared/ai';
import {
  defaultCompatibleContext,
  defaultCompatibleOutput,
  findProviderPreset,
} from '../../shared/providerPresets';
import { ProviderRepository } from '../repositories/providerRepository';
import { BotRepository } from '../repositories/botRepository';
import { modelContextWindow } from '../../shared/modelLimits';
import type { DiagnosticService } from './diagnosticService';
import { ChatGPTService } from './chatgptService';
import { chatGPTError } from './chatgptTransport';
import { PROVIDER_MAX_RETRIES } from './responsePolicy';
import { providerToolCallFailure } from './providerToolCallRecovery';
import { generationTimeoutError } from './generationTimeout';
import { providerResponseTimeouts } from '../../shared/providerTimeouts';
import {
  effectiveReasoning,
  reasoningDefaultLabel,
  reasoningProfile,
  supportsReasoning,
} from '../../shared/reasoning';

// Provider warning strings are untrusted and can include request details.
globalThis.AI_SDK_LOG_WARNINGS = false;

type ModelConfigurationInput = Pick<
  BotRecord,
  | 'providerId'
  | 'model'
  | 'supportsImages'
  | 'contextWindowTokens'
  | 'maxOutputTokens'
  | 'reasoningEffort'
>;

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
  const timeout = generationTimeoutError(error);
  if (timeout)
    return timeout.kind === 'idle'
      ? 'Mukai stopped waiting because the model sent no streamed updates within its idle timeout. The model may have been generating a long tool call. Saved progress is preserved; increase the model’s response timeout settings or retry.'
      : 'Mukai stopped waiting because the model reached its response time limit. Saved progress is preserved; increase the model’s response timeout settings or retry.';
  const toolCallFailure = providerToolCallFailure(error);
  if (toolCallFailure)
    return toolCallFailure === 'incomplete_tool_call'
      ? 'The provider generated an incomplete tool call that Mukai could not execute. Completed work is saved; retry to continue.'
      : 'The provider generated a malformed tool call that Mukai could not execute. Completed work is saved; retry to continue.';
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
  if (status === 413)
    return 'The provider rejected the media or request size. Try a smaller or shorter recording, or send fewer attachments.';
  if (
    ((error as Error)?.name === 'AI_UnsupportedFunctionalityError' &&
      /audio|video|file|media/i.test(
        String((error as { functionality?: string }).functionality || ''),
      )) ||
    ([400, 415, 422].includes(status ?? 0) &&
      /audio|video|codec|mime|media.?type|file.?format/i.test(
        `${(error as Error)?.message || ''} ${detail.responseBody || ''}`,
      ))
  )
    return 'The provider could not process the attached media. Check this model’s audio/video input settings and try a shorter recording or a supported format (WAV/MP3 audio or MP4/MOV video). Your saved attachments are preserved.';
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
    const fallbackOutput = value.kind === 'compatible' ? defaultCompatibleOutput : 8192;
    const fallbackContext = value.kind === 'compatible' ? defaultCompatibleContext : null;
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
                ...(!existing ? { reasoningEffort: 'provider-default' as const } : {}),
                name: value.defaultModel,
                contextWindowTokens:
                  value.contextWindowTokens !== undefined
                    ? value.contextWindowTokens
                    : fallbackContext,
                maxOutputTokens: value.maxOutputTokens ?? fallbackOutput,
                supportsImages: value.supportsImages,
                supportsAudio: value.supportsAudio,
                supportsVideo: value.supportsVideo,
              },
            ]
          : []),
      id: providerId,
      name: value.name,
      kind: value.kind,
      baseUrl: value.baseUrl,
      defaultModel: value.defaultModel,
      supportsImages: value.supportsImages,
      supportsAudio: value.supportsAudio ?? existing?.supportsAudio ?? false,
      supportsVideo: value.supportsVideo ?? existing?.supportsVideo ?? false,
      // A saved default remains default until another provider is selected.
      isDefault: value.isDefault || Boolean(existing?.isDefault),
      encryptedKey,
      contextWindowTokens:
        value.contextWindowTokens !== undefined
          ? value.contextWindowTokens
          : ((existing?.defaultModel === value.defaultModel
              ? existing.contextWindowTokens
              : fallbackContext) ?? fallbackContext),
      maxOutputTokens: value.maxOutputTokens ?? existing?.maxOutputTokens ?? fallbackOutput,
    };
    if (value.models !== undefined) {
      for (const model of value.models) {
        if (model.reasoningEffort && !supportsReasoning(provider, model.id, model.reasoningEffort))
          throw new ApiError(
            400,
            `Reasoning effort ${model.reasoningEffort} is not supported by ${model.id}.`,
          );
        if (
          model.reasoningEffort &&
          !['none', 'provider-default'].includes(model.reasoningEffort) &&
          reasoningProfile(provider, model.id).driver === 'claude-budget' &&
          model.maxOutputTokens < 1280
        )
          throw new ApiError(400, 'Thinking requires an output limit of at least 1,280 tokens.');
      }
      const selected = value.models.find((model) => model.id === value.defaultModel);
      if (value.defaultModel && !selected)
        throw new ApiError(400, 'Choose a saved model as the provider default.');
      if (selected) {
        provider.contextWindowTokens = selected.contextWindowTokens;
        provider.maxOutputTokens = selected.maxOutputTokens;
        provider.supportsImages = selected.supportsImages;
        const capabilities = modelInputCapabilities(
          { model: selected.id, supportsImages: null },
          provider,
        );
        provider.supportsAudio = capabilities.supportsAudio;
        provider.supportsVideo = capabilities.supportsVideo;
      }
    }
    this.providers.save(provider);
    return this.public(provider);
  }
  saveModels(id: string, input: ProviderModelsInput) {
    if (input.models.length && !input.defaultModel)
      throw new ApiError(400, 'Choose a saved model as the provider default.');
    const existing = this.require(id);
    return this.save({ ...publicProvider(existing), ...input }, id);
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
        reasoningEffort: 'provider-default' as const,
        reasoningEfforts: model.reasoningEfforts,
        id: model.id,
        name: model.name,
        contextWindowTokens: model.contextWindowTokens,
        maxOutputTokens: provider.maxOutputTokens ?? 8192,
        supportsImages: model.supportsImages ?? false,
        supportsAudio: model.supportsAudio ?? false,
        supportsVideo: model.supportsVideo ?? false,
      }));
    const refreshed = saved.map((item) => {
      const metadata = models.find((model) => model.id === item.id);
      return metadata?.reasoningEfforts
        ? { ...item, reasoningEfforts: metadata.reasoningEfforts }
        : item;
    });
    if (added.length || JSON.stringify(refreshed) !== JSON.stringify(saved))
      this.providers.save({ ...provider, models: [...refreshed, ...added] });
    return models;
  }
  private configuredModels() {
    return this.providers.list().flatMap((provider) =>
      (provider.models ?? []).map((model) => ({
        provider,
        model,
        modelId:
          'model_' +
          createHash('sha256')
            .update(JSON.stringify([provider.id, model.id]))
            .digest('hex'),
      })),
    );
  }
  private configuredModel(modelId: string) {
    const selected = this.configuredModels().find((entry) => entry.modelId === modelId);
    if (!selected)
      throw new ApiError(
        404,
        'Model selection not found. Use list_models to choose a configured modelId.',
      );
    return selected;
  }
  private describeConfiguredModel(entry: {
    provider: ProviderRecord;
    model: SavedProviderModel;
    modelId: string;
  }) {
    return {
      ...this.describeModel({
        providerId: entry.provider.id,
        model: entry.model.id,
        supportsImages: null,
      }),
      modelId: entry.modelId,
      name: entry.model.name,
      reasoningEfforts: reasoningProfile(entry.provider, entry.model.id).levels,
    };
  }
  /** Saved catalog only: discovery never refreshes, imports, or changes model settings. */
  listConfiguredModels() {
    return this.configuredModels().map((entry) => this.describeConfiguredModel(entry));
  }
  getConfiguredModel(modelId: string) {
    return this.describeConfiguredModel(this.configuredModel(modelId));
  }
  resolveModelSelection(modelId: string) {
    const selected = this.configuredModel(modelId);
    return { providerId: selected.provider.id, model: selected.model.id };
  }
  private configuration(bot: ModelConfigurationInput) {
    const provider = bot.providerId
      ? this.providers.find(bot.providerId)
      : this.providers.default();
    if (!provider) return;
    const modelId = String(bot.model || provider.defaultModel);
    const configured = provider.models?.find((model) => model.id === modelId);
    const effort = effectiveReasoning(bot, configured);
    return {
      provider,
      modelId,
      contextWindow: modelContextWindow(bot, provider),
      maxOutputTokens:
        configured?.maxOutputTokens ?? bot.maxOutputTokens ?? provider.maxOutputTokens ?? 8192,
      ...modelInputCapabilities(bot, provider),
      reasoningEffort: effort,
      responseTimeouts: providerResponseTimeouts(provider, configured),
    };
  }
  /** Effective settings for tool results, without opening a model or accessing credentials. */
  describeModel(bot: ModelConfigurationInput) {
    const config = this.configuration(bot);
    if (!config || !config.modelId.trim())
      return {
        providerId: config?.provider.id ?? bot.providerId ?? 'Not configured',
        providerName: config?.provider.name ?? 'Not configured',
        model: config?.modelId || bot.model || 'Not configured',
        inputCapabilities: 'Unknown: provider or model is not configured',
        supportsText: 'unknown' as const,
        supportsImages: 'unknown' as const,
        supportsAudio: 'unknown' as const,
        supportsVideo: 'unknown' as const,
        contextWindowTokens: 'unknown' as const,
        maxOutputTokens: 'unknown' as const,
        reasoningEffort: 'Unknown: provider or model is not configured',
      };
    return {
      providerId: config.provider.id,
      providerName: config.provider.name,
      model: config.modelId,
      inputCapabilities: inputCapabilityLabel(config),
      supportsText: true,
      supportsImages: config.supportsImages,
      supportsAudio: config.supportsAudio,
      supportsVideo: config.supportsVideo,
      contextWindowTokens: config.contextWindow ?? 'unknown',
      maxOutputTokens: config.maxOutputTokens,
      reasoningEffort:
        config.reasoningEffort ?? reasoningDefaultLabel(config.provider, config.modelId),
    };
  }
  resolve(bot: BotRecord) {
    const config = this.configuration(bot);
    if (!config) throw new ApiError(400, 'Configure a provider in Settings before chatting.');
    const { provider, modelId, reasoningEffort: effort } = config;
    if (!modelId.trim())
      throw new ApiError(400, 'Choose a model for this provider in Settings before chatting.');
    if (effort && !supportsReasoning(provider, modelId, effort))
      throw new ApiError(
        400,
        `Reasoning effort ${effort} is not supported by ${modelId}. Choose another effort in the model picker.`,
      );
    return {
      ...config,
      vision: config.supportsImages,
      model: wrapLanguageModel({
        model: this.model(provider, modelId),
        middleware: toolMediaMiddleware,
      }),
      reasoningEffort: effort,
      reasoningProfile: reasoningProfile(provider, modelId),
      options:
        effort === undefined
          ? this.reasoningOptions(provider, modelId)
          : {
              openai: {
                store: false,
                ...(provider.kind === 'chatgpt' ? { systemMessageMode: 'developer' } : {}),
                ...(['openai', 'chatgpt'].includes(provider.kind) &&
                reasoningProfile(provider, modelId).levels.length > 0
                  ? {
                      forceReasoning: true,
                      ...(effort !== 'none' ? { reasoningSummary: 'auto' } : {}),
                    }
                  : {}),
              },
              anthropic: {},
              google: { thinkingConfig: { includeThoughts: true } },
            },
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
        if (modelInputCapabilities({ model: id, supportsImages: null }, provider).supportsAudio)
          return createOpenAI({ apiKey, fetch: secureFetch }).chat(id);
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
          middleware: [
            compatibleImageMiddleware,
            ...(findProviderPreset(provider)?.id === 'mimo'
              ? [compatibleAudioDataUrlMiddleware]
              : []),
          ],
        });
    }
  }
  async testBotModel(bot: ModelConfigurationInput, signal: AbortSignal) {
    signal.throwIfAborted();
    const config = this.configuration(bot);
    if (!config)
      throw new ApiError(400, 'Configure a provider in Settings before creating this bot.');
    const result = await this.test(config.provider.id, config.modelId, signal);
    signal.throwIfAborted();
    const current = this.configuration(bot);
    if (current?.provider.id !== config.provider.id || current.modelId !== config.modelId)
      throw new ApiError(
        409,
        'The model changed during the connection test. Retry the bot operation.',
      );
    return result;
  }
  async test(id: string, selectedModel?: string, signal?: AbortSignal) {
    const provider = this.require(id);
    const modelId = selectedModel ?? provider.defaultModel;
    if (!modelId.trim())
      throw new ApiError(400, 'Add a model in Settings before testing this connection.');
    try {
      const result = await generateText({
        model: this.model(provider, modelId),
        prompt: 'Reply with OK.',
        maxOutputTokens: 64,
        maxRetries: PROVIDER_MAX_RETRIES,
        abortSignal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
        providerOptions: { openai: { store: false } },
      });
      if (!result.text.trim())
        return {
          ok: true,
          message: `Connected to ${modelId}. The provider accepted the test but returned no text at the short output limit. Try a chat message to check its output.`,
        };
      return {
        ok: true,
        message: `Connected to ${modelId}. A short test request was sent.`,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ApiError) throw error;
      this.diagnostics.record('provider.test_failed', error, {
        providerId: provider.id,
        providerKind: provider.kind,
        model: modelId,
        phase: 'provider-test',
      });
      throw new ApiError(502, safeProviderError(error));
    }
  }
}
