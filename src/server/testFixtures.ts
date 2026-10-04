import type { Database } from './db/database';
import { BotRepository } from './repositories/botRepository';
import { scoutBot } from './services/botService';

/** Existing chat fixtures explicitly create their bot; production workspaces start empty. */
export function seedTestBot(store: Database) {
  new BotRepository(store).create(scoutBot());
}
