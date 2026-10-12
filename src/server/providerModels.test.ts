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
  it('validates model IDs and requires a saved default', () => {
    expect(
      providerSchema.safeParse({ ...connection, models: [models[0], models[0]] }).success,
    ).toBe(false);
    expect(() => service.save({ ...connection, defaultModel: 'missing', models })).toThrow(
      'Choose a saved model',
    );
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
