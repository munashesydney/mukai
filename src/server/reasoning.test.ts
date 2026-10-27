import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './db/database';
import { BotRepository } from './repositories/botRepository';
import { ProviderRepository } from './repositories/providerRepository';
import { AttachmentRepository } from './repositories/attachmentRepository';
import { WorkspaceRepository } from './repositories/workspaceRepository';
import { BotService, scoutBot } from './services/botService';
import { AttachmentService } from './services/attachmentService';
import { ProviderService } from './services/providerService';
import { DiagnosticService } from './services/diagnosticService';
import { chatReasoningSettings } from './services/reasoningOptions';
import { seedTestWorkspace } from './testFixtures';
import { botModelSchema, providerSchema } from './http/schemas';

describe('Persisted reasoning settings', () => {
  let dir: string, db: Database, providers: ProviderService, bots: BotService;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-reasoning-'));
    db = new Database(dir);
    seedTestWorkspace(db);
    const botRepository = new BotRepository(db);
    const providerRepository = new ProviderRepository(db);
    providers = new ProviderService(
      providerRepository,
      botRepository,
      dir,
      new DiagnosticService(dir),
    );
    bots = new BotService(
      botRepository,
      providerRepository,
      new AttachmentService(new AttachmentRepository(db), botRepository, join(dir, 'uploads')),
      () => false,
      new WorkspaceRepository(db),
    );
    botRepository.create(scoutBot());
  });
  afterEach(() => {
    providers.chatgpt.shutdown();
    db.db.close();
    // Test-owned temporary directories only.
    expect(dir.startsWith(join(tmpdir(), 'mukai-reasoning-'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  function addModel(reasoningEffort?: 'low' | 'provider-default') {
    return providers.save({
      name: 'OpenAI test',
      kind: 'openai',
      baseUrl: '',
      defaultModel: 'gpt-5.4',
      apiKey: 'test-only',
      isDefault: true,
      supportsImages: true,
      models: [
        {
          id: 'gpt-5.4',
          name: 'GPT',
          contextWindowTokens: 128000,
          maxOutputTokens: 8192,
          supportsImages: true,
          reasoningEffort,
        },
      ],
    });
  }
  it('persists model defaults and bot overrides, including an explicit provider-default bypass', () => {
    const provider = addModel('low');
    const input = {
      providerId: provider.id,
      model: 'gpt-5.4',
      supportsImages: null,
      contextWindowTokens: null,
    };
    let bot = bots.setModel('scout', { ...input, reasoningEffort: 'high' });
    expect(bots.require('scout').reasoningEffort).toBe('high');
    expect(new ProviderRepository(db).find(provider.id)?.models?.[0].reasoningEffort).toBe('low');
    expect(chatReasoningSettings(providers.resolve(bot), 8192).reasoning).toBe('high');
    bot = bots.setModel('scout', { ...input, reasoningEffort: null });
    expect(chatReasoningSettings(providers.resolve(bot), 8192).reasoning).toBe('low');
    bot = bots.setModel('scout', { ...input, reasoningEffort: 'provider-default' });
    const settings = chatReasoningSettings(providers.resolve(bot), 8192);
    expect(settings.reasoning).toBeUndefined();
    expect(settings.providerOptions?.openai?.reasoningEffort).toBeUndefined();
    db.db.close();
    db = new Database(dir);
    expect(new BotRepository(db).find('scout')?.reasoningEffort).toBe('provider-default');
    expect(new ProviderRepository(db).find(provider.id)?.models?.[0].reasoningEffort).toBe('low');
  });
  it('retains old implicit behavior until explicitly changed and preserves effort on ordinary bot edits', () => {
    const provider = addModel();
    const bot = bots.setModel('scout', {
      providerId: provider.id,
      model: 'gpt-5.4',
      supportsImages: null,
      contextWindowTokens: null,
    });
    expect(providers.resolve(bot).options.openai).toMatchObject({ reasoningEffort: 'medium' });
    const updated = bots.save({ ...bot, reasoningEffort: 'low' }, bot.id);
    const oldClient = { ...updated };
    delete oldClient.reasoningEffort;
    expect(bots.save({ ...oldClient, name: 'Renamed' }, bot.id).reasoningEffort).toBe('low');
    expect(
      bots.setModel(bot.id, {
        providerId: provider.id,
        model: 'gpt-4.1',
        supportsImages: null,
        contextWindowTokens: null,
      }).reasoningEffort,
    ).toBeNull();
  });
  it('rejects unsupported effort choices in both settings and bot saves without changing persisted data', () => {
    const provider = addModel('low');
    expect(() =>
      bots.setModel('scout', {
        providerId: provider.id,
        model: 'gpt-4.1',
        supportsImages: null,
        contextWindowTokens: null,
        reasoningEffort: 'high',
      }),
    ).toThrow('not supported');
    expect(() =>
      providers.saveModels(provider.id, {
        defaultModel: 'gpt-5.4',
        models: [{ ...provider.models![0], reasoningEffort: 'minimal' }],
      }),
    ).toThrow('not supported');
    expect(new ProviderRepository(db).find(provider.id)?.models?.[0].reasoningEffort).toBe('low');
    expect(
      providerSchema.safeParse({
        ...provider,
        models: [{ ...provider.models![0], reasoningEffort: 'ultra' }],
      }).success,
    ).toBe(false);
    expect(
      botModelSchema.safeParse({
        providerId: provider.id,
        model: 'gpt-5.4',
        supportsImages: null,
        reasoningEffort: 'ultra',
      }).success,
    ).toBe(false);
  });
  it('requires enough output room when a bot enables manual Claude thinking', () => {
    const provider = providers.save({
      name: 'Claude test',
      kind: 'anthropic',
      baseUrl: '',
      defaultModel: 'claude-sonnet-4-5-20250929',
      apiKey: 'test-only',
      isDefault: true,
      supportsImages: false,
      models: [
        {
          id: 'claude-sonnet-4-5-20250929',
          name: 'Claude',
          contextWindowTokens: 128000,
          maxOutputTokens: 1024,
          supportsImages: false,
          reasoningEffort: 'provider-default',
        },
      ],
    });
    expect(() =>
      bots.setModel('scout', {
        providerId: provider.id,
        model: provider.defaultModel,
        supportsImages: null,
        contextWindowTokens: null,
        reasoningEffort: 'high',
      }),
    ).toThrow('1,280');
  });
});
