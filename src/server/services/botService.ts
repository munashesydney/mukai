import { scoutInstructions } from '../../shared/botSystemPrompt';
import { randomInt, randomUUID } from 'node:crypto';
import { mainBotRole, type Bot, type BotInput, type BotModelInput } from '../../shared/ai';
import { botAvatarIds, resolveBotAvatar } from '../../shared/mascots';
import { ApiError } from '../config';
import { BotRepository } from '../repositories/botRepository';
import { ProviderRepository } from '../repositories/providerRepository';
import { AttachmentService } from './attachmentService';
import { WorkspaceRepository } from '../repositories/workspaceRepository';
import { effectiveReasoning, reasoningProfile, supportsReasoning } from '../../shared/reasoning';

function randomUnusedMascot(bots: Bot[]) {
  const mascots = botAvatarIds.filter((avatar) => avatar !== 'mukai-logo');
  const used = new Set(bots.map((bot) => resolveBotAvatar(bot.avatar)));
  const unused = mascots.filter((avatar) => !used.has(avatar));
  const choices = unused.length ? unused : mascots;
  return choices[randomInt(choices.length)];
}

export function scoutBot(workspaceId = 'default', id = 'scout'): Bot {
  return {
    id,
    workspaceId,
    name: 'Scout',
    role: mainBotRole,
    instructions: scoutInstructions,
    providerId: null,
    model: null,
    supportsImages: null,
    avatar: 'mukai-logo',
    createdAt: new Date().toISOString(),
    isMain: true,
    createdBy: null,
  };
}

export class BotService {
  constructor(
    private bots: BotRepository,
    private providers: ProviderRepository,
    private attachments: AttachmentService,
    private busy: (id: string) => boolean,
    private workspaces: WorkspaceRepository,
  ) {}
  list(workspaceId = 'default') {
    if (!this.workspaces.find(workspaceId)) throw new ApiError(404, 'Workspace not found.');
    return this.bots.list(workspaceId);
  }
  require(id: string) {
    const bot = this.bots.find(id);
    if (!bot) throw new ApiError(404, 'Bot not found.');
    this.workspaces.find(bot.workspaceId);
    return bot;
  }
  save(
    input: Omit<BotInput, 'avatar'> & { avatar?: BotInput['avatar'] },
    id?: string,
    workspaceId = 'default',
    createdBy?: string,
    configure?: (bot: Bot) => void,
  ) {
    const existing = id ? this.require(id) : undefined;
    workspaceId = existing?.workspaceId || workspaceId;
    if (!this.workspaces.find(workspaceId)) throw new ApiError(404, 'Workspace not found.');
    if (id && this.busy(id)) throw new ApiError(409, 'Stop this bot’s response before editing it.');
    if (input.providerId && !this.providers.find(input.providerId))
      throw new ApiError(400, 'Provider not found.');
    const creator = createdBy ? this.require(createdBy) : undefined;
    const sameModel =
      !existing || (existing.providerId === input.providerId && existing.model === input.model);
    const reasoningEffort =
      input.reasoningEffort !== undefined
        ? input.reasoningEffort
        : sameModel
          ? (existing?.reasoningEffort ?? null)
          : null;
    const provider = input.providerId
      ? this.providers.find(input.providerId)
      : this.providers.default();
    if (
      reasoningEffort &&
      provider &&
      !supportsReasoning(provider, input.model || provider.defaultModel, reasoningEffort)
    )
      throw new ApiError(400, 'This reasoning effort is not supported by the selected model.');
    if (provider) {
      const modelId = input.model || provider.defaultModel;
      const saved = provider.models?.find((model) => model.id === modelId);
      const effective = effectiveReasoning({ reasoningEffort }, saved);
      if (
        effective &&
        !['none', 'provider-default'].includes(effective) &&
        reasoningProfile(provider, modelId).driver === 'claude-budget' &&
        (saved?.maxOutputTokens ?? input.maxOutputTokens ?? provider.maxOutputTokens ?? 8192) < 1280
      )
        throw new ApiError(400, 'Thinking requires an output limit of at least 1,280 tokens.');
    }
    if (creator && creator.workspaceId !== workspaceId)
      throw new ApiError(403, 'Creator belongs to another workspace.');
    const bot = {
      ...input,
      reasoningEffort,
      avatar: resolveBotAvatar(input.avatar ?? existing?.avatar),
      role: existing?.isMain ? mainBotRole : input.role,
      contextWindowTokens:
        input.contextWindowTokens !== undefined
          ? input.contextWindowTokens
          : existing?.providerId === input.providerId && existing?.model === input.model
            ? (existing?.contextWindowTokens ?? null)
            : null,
      maxOutputTokens:
        input.maxOutputTokens !== undefined
          ? input.maxOutputTokens
          : (existing?.maxOutputTokens ?? null),
      id: existing?.id || randomUUID(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      workspaceId,
      isMain: existing?.isMain ?? false,
      createdBy: existing?.createdBy ?? null,
    };
    if (existing) this.bots.update(bot);
    else
      return this.bots.insertNew(
        (others) => ({
          ...bot,
          avatar: input.avatar === undefined ? randomUnusedMascot(others) : bot.avatar,
          isMain: others.length === 0,
          role: others.length === 0 ? mainBotRole : input.role,
          createdBy: creator?.id || others.find((other) => other.isMain)?.id || null,
        }),
        workspaceId,
        configure,
      );
    return bot;
  }
  setModel(id: string, input: BotModelInput) {
    const bot = this.require(id);
    return this.save(
      {
        ...bot,
        ...input,
        reasoningEffort:
          input.reasoningEffort !== undefined
            ? input.reasoningEffort
            : bot.providerId === input.providerId && bot.model === input.model
              ? bot.reasoningEffort
              : null,
        supportsImages: null,
        contextWindowTokens: null,
        maxOutputTokens: null,
      },
      id,
    );
  }
  remove(id: string) {
    const bot = this.require(id);
    if (this.list(bot.workspaceId).some((other) => other.createdBy === id))
      throw new ApiError(409, 'Delete this bot’s child bots first.');
    if (this.busy(id)) throw new ApiError(409, 'Stop this bot’s response before deleting it.');
    if (this.bots.hasUndeliveredResults(id))
      throw new ApiError(
        409,
        'Wait for this bot’s delegated results to reach its caller before deleting it.',
      );
    const names = this.attachments.storageNames(id);
    this.bots.delete(id);
    names.forEach((name) => this.attachments.removeFile(name));
  }
}
