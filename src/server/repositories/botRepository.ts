import type { BotRecord } from '../models/entities';
import type { Database } from '../db/database';
import { botRecord } from './records';

export class BotRepository {
  constructor(private database: Database) {}
  list(workspaceId = 'default') {
    return this.database
      .all('SELECT * FROM bots WHERE workspace_id=? ORDER BY created_at,id', workspaceId)
      .map(botRecord);
  }
  find(id: string) {
    const row = this.database.get('SELECT * FROM bots WHERE id = ?', id);
    return row ? botRecord(row) : undefined;
  }
  usesProvider(id: string) {
    return Boolean(this.database.get('SELECT id FROM bots WHERE provider_id = ?', id));
  }
  create(bot: BotRecord) {
    this.database.run(
      'INSERT INTO bots(id,name,description,instructions,provider_id,model,supports_images,avatar,created_at,workspace_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      bot.id,
      bot.name,
      bot.description,
      bot.instructions,
      bot.providerId,
      bot.model,
      bot.supportsImages === null ? null : Number(bot.supportsImages),
      bot.avatar,
      bot.createdAt,
      bot.workspaceId,
    );
  }
  update(bot: BotRecord) {
    this.database.run(
      'UPDATE bots SET name=?,description=?,instructions=?,provider_id=?,model=?,supports_images=?,avatar=? WHERE id=?',
      bot.name,
      bot.description,
      bot.instructions,
      bot.providerId,
      bot.model,
      bot.supportsImages === null ? null : Number(bot.supportsImages),
      bot.avatar,
      bot.id,
    );
  }
  delete(id: string) {
    this.database.run('DELETE FROM bots WHERE id = ?', id);
  }
  seedScout(bot: BotRecord) {
    this.database.transaction(() => {
      if (!this.database.get("SELECT value FROM metadata WHERE key = 'scout_seeded'")) {
        this.create(bot);
        this.database.run("INSERT INTO metadata VALUES ('scout_seeded','1')");
      }
    });
  }
}
