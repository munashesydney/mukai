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
  hasUndeliveredResults(id: string) {
    return Boolean(
      this.database.get(
        "SELECT 1 FROM bot_delegations WHERE target_id=? AND mode='fire_and_forget' AND delivered=0 AND state!='cancelled' LIMIT 1",
        id,
      ),
    );
  }
  create(bot: BotRecord) {
    this.database.run(
      'INSERT INTO bots(id,name,role,instructions,provider_id,model,supports_images,avatar,created_at,workspace_id,context_window_tokens,max_output_tokens,is_main,created_by,reasoning_effort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      bot.id,
      bot.name,
      bot.role,
      bot.instructions,
      bot.providerId,
      bot.model,
      bot.supportsImages === null ? null : Number(bot.supportsImages),
      bot.avatar,
      bot.createdAt,
      bot.workspaceId,
      bot.contextWindowTokens ?? null,
      bot.maxOutputTokens ?? null,
      Number(bot.isMain),
      bot.createdBy,
      bot.reasoningEffort ?? null,
    );
  }
  update(bot: BotRecord) {
    this.database.run(
      'UPDATE bots SET name=?,role=?,instructions=?,provider_id=?,model=?,supports_images=?,avatar=?,context_window_tokens=?,max_output_tokens=?,reasoning_effort=?,created_by=? WHERE id=?',
      bot.name,
      bot.role,
      bot.instructions,
      bot.providerId,
      bot.model,
      bot.supportsImages === null ? null : Number(bot.supportsImages),
      bot.avatar,
      bot.contextWindowTokens ?? null,
      bot.maxOutputTokens ?? null,
      bot.reasoningEffort ?? null,
      bot.createdBy,
      bot.id,
    );
  }
  delete(id: string) {
    this.database.run('DELETE FROM bots WHERE id = ?', id);
  }
  insertNew(
    build: (existing: BotRecord[]) => BotRecord,
    workspaceId: string,
    configure?: (bot: BotRecord) => void,
  ) {
    return this.database.transaction(() => {
      const bot = build(this.list(workspaceId));
      this.create(bot);
      configure?.(bot);
      return bot;
    });
  }
}
