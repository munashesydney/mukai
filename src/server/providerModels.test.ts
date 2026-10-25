import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './db/database';
import { ProviderRepository } from './repositories/providerRepository';
import { BotRepository } from './repositories/botRepository';
import { ProviderService } from './services/providerService';
import { DiagnosticService } from './services/diagnosticService';
import { scoutBot } from './services/botService';
import { providerSchema } from './http/schemas';
import { migrations } from './db/migrations';
import { seedTestWorkspace } from './testFixtures';

describe('Saved provider models', () => {
  let dir: string, database: Database, service: ProviderService;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-provider-models-'));
    database = new Database(dir);
    service = new ProviderService(
      new ProviderRepository(database),
      new BotRepository(database),
      dir,
      new DiagnosticService(dir),
    );
  });
  afterEach(() => {
    service.chatgpt.shutdown();
    database.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const connection = {
    name: 'Deepseek',
    kind: 'compatible' as const,
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: '',
    supportsImages: false,
    isDefault: true,
  };
  const models = [
    {
      id: 'deepseek-chat',
      name: 'Chat',
      contextWindowTokens: 65536,
      maxOutputTokens: 4096,
      supportsImages: false,
    },
    {
      id: 'deepseek-vision',
      name: 'Vision',
      contextWindowTokens: 131072,
      maxOutputTokens: 16384,
      supportsImages: true,
    },
  ];
  it('saves a connection first, then stores multiple models independently across providers and reloads', () => {
    const first = service.save({ ...connection, models: [] });
    expect(first.models).toEqual([]);
    service.save({ ...connection, defaultModel: models[0].id, models }, first.id);
    const second = service.save({
      ...connection,
      name: 'GLM',
      isDefault: false,
      defaultModel: 'glm',
      models: [{ ...models[0], id: 'glm' }],
    });
    database.db.close();
    database = new Database(dir);
    const repository = new ProviderRepository(database);
    expect(repository.find(first.id)?.models).toEqual(models);
    expect(repository.find(second.id)?.models?.map((model) => model.id)).toEqual(['glm']);
    expect(repository.default()?.id).toBe(first.id);
  });
  it('uses settings for the selected model even when the bot has stale limits', () => {
    const provider = service.save({ ...connection, defaultModel: models[0].id, models });
    const config = service.resolve({
      ...scoutBot(),
      providerId: provider.id,
      model: models[1].id,
      contextWindowTokens: 8192,
      maxOutputTokens: 512,
      supportsImages: false,
    });
    expect(config).toMatchObject({
      modelId: models[1].id,
      contextWindow: 131072,
      maxOutputTokens: 16384,
      vision: true,
    });
    expect(service.resolve(scoutBot())).toMatchObject({
      modelId: models[0].id,
      contextWindow: 65536,
      maxOutputTokens: 4096,
      vision: false,
    });
    service.save(
      {
        ...connection,
        defaultModel: models[0].id,
        models: models.map((model) => ({ ...model, contextWindowTokens: 262144 })),
      },
      provider.id,
    );
    expect(
      service.resolve({ ...scoutBot(), providerId: provider.id, model: models[1].id })
        .contextWindow,
    ).toBe(262144);
  });
  it('persists separate audio and video flags and changes capabilities with the selected model', () => {
    const provider = service.save({
      ...connection,
      defaultModel: 'media',
      models: [
        { ...models[0], id: 'media', supportsAudio: true, supportsVideo: true },
        { ...models[0], id: 'text', supportsAudio: false, supportsVideo: false },
      ],
    });
    expect(service.resolve({ ...scoutBot(), model: 'media' })).toMatchObject({
      supportsAudio: true,
      supportsVideo: true,
    });
    expect(service.resolve({ ...scoutBot(), model: 'text' })).toMatchObject({
      supportsAudio: false,
      supportsVideo: false,
    });
    const saved = new ProviderRepository(database).find(provider.id)!;
    expect(saved).toMatchObject({ supportsAudio: true, supportsVideo: true });
    expect(saved.models?.[1]).toMatchObject({ supportsAudio: false, supportsVideo: false });
    service.saveModels(provider.id, { models: saved.models!, defaultModel: 'text' });
    expect(new ProviderRepository(database).find(provider.id)).toMatchObject({
      supportsAudio: false,
      supportsVideo: false,
    });
  });
  it('validates model IDs and requires a saved default', () => {
    expect(
      providerSchema.safeParse({ ...connection, models: [models[0], models[0]] }).success,
    ).toBe(false);
    expect(() => service.save({ ...connection, defaultModel: 'missing', models })).toThrow(
      'Choose a saved model',
    );
  });
  it('updates only model settings, retaining credentials and connection configuration', () => {
    const provider = service.save({
      ...connection,
      name: 'My provider',
      apiKey: 'test-only-key',
      models: [models[0]],
      defaultModel: models[0].id,
    });
    const encryptedKey = new ProviderRepository(database).find(provider.id)?.encryptedKey;
    const updated = service.saveModels(provider.id, { models, defaultModel: models[1].id });
    expect(updated).toMatchObject({
      name: 'My provider',
      baseUrl: connection.baseUrl,
      hasKey: true,
      isDefault: true,
      defaultModel: models[1].id,
      contextWindowTokens: models[1].contextWindowTokens,
      maxOutputTokens: models[1].maxOutputTokens,
      supportsImages: true,
    });
    expect(new ProviderRepository(database).find(provider.id)?.encryptedKey).toBe(encryptedKey);
    expect(() => service.saveModels(provider.id, { models, defaultModel: '' })).toThrow(
      'Choose a saved model',
    );
    expect(service.list()[0].defaultModel).toBe(models[1].id);
    expect(service.saveModels(provider.id, { models: [], defaultModel: '' }).models).toEqual([]);
  });
  it('starts custom compatible models with a 128K context and 32K output cap', () => {
    const provider = service.save({ ...connection, defaultModel: 'custom-model' });
    expect(provider.models?.[0]).toMatchObject({
      contextWindowTokens: 128000,
      maxOutputTokens: 32768,
    });
    expect(service.resolve(scoutBot())).toMatchObject({
      contextWindow: 128000,
      maxOutputTokens: 32768,
    });
  });
  it('migrates the default and existing bot-specific models without losing their limits', () => {
    seedTestWorkspace(database);
    const provider = service.save({
      ...connection,
      defaultModel: models[0].id,
      contextWindowTokens: 65536,
      maxOutputTokens: 4096,
    });
    new BotRepository(database).create({
      ...scoutBot(),
      providerId: provider.id,
      model: models[1].id,
      contextWindowTokens: 131072,
      maxOutputTokens: 16384,
      supportsImages: true,
    });
    database.db.exec('ALTER TABLE providers DROP COLUMN models_json;');
    database.run(
      'DELETE FROM schema_migrations WHERE version=?',
      migrations.findIndex((sql) => sql.includes('ALTER TABLE providers ADD COLUMN models_json')) +
        1,
    );
    database.db.close();
    database = new Database(dir);
    expect(new ProviderRepository(database).find(provider.id)?.models).toEqual([
      { ...models[0], name: models[0].id },
      { ...models[1], name: models[1].id },
    ]);
  });
});
