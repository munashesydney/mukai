import type { Database } from './db/database';
import { BotRepository } from './repositories/botRepository';
import { scoutBot } from './services/botService';
import { WorkspaceRepository } from './repositories/workspaceRepository';

export function seedTestWorkspace(store: Database) {
  const workspaces = new WorkspaceRepository(store);
  if (!workspaces.find('default'))
    workspaces.create({
      id: 'default',
      name: 'Test workspace',
      folder: null,
      createdAt: new Date().toISOString(),
      computer: 'local',
    });
}

/** Existing chat fixtures explicitly create their bot; production workspaces start empty. */
export function seedTestBot(store: Database) {
  seedTestWorkspace(store);
  // Existing chat fixtures model a workspace that already used memory before the opt-in default.
  store.run('UPDATE workspaces SET memory_enabled=1 WHERE id=?', 'default');
  new BotRepository(store).create(scoutBot());
}
