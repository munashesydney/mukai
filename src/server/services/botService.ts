import { scoutInstructions } from '../../shared/botSystemPrompt';
import { randomUUID } from 'node:crypto';
import { mainBotRole, type Bot, type BotInput, type BotModelInput } from '../../shared/ai';
import { ApiError } from '../config';
import { BotRepository } from '../repositories/botRepository';
import { ProviderRepository } from '../repositories/providerRepository';
import { AttachmentService } from './attachmentService';
import { WorkspaceRepository } from '../repositories/workspaceRepository';

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
    avatar: 'scout',
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
    return bot;
  }
  save(
    input: BotInput,
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
    if (creator && creator.workspaceId !== workspaceId)
      throw new ApiError(403, 'Creator belongs to another workspace.');
    const bot = {
      ...input,
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
      { ...bot, ...input, contextWindowTokens: input.contextWindowTokens ?? null },
      id,
    );
  }
  remove(id: string) {
    const bot = this.require(id);
    if (this.list(bot.workspaceId).some((other) => other.createdBy === id))
      throw new ApiError(409, 'Delete this bot’s child bots first.');
    if (this.busy(id)) throw new ApiError(409, 'Stop this bot’s response before deleting it.');
    const names = this.attachments.storageNames(id);
    this.bots.delete(id);
    names.forEach((name) => this.attachments.removeFile(name));
  }
}
