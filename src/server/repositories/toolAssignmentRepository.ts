import type { Database } from '../db/database';
import { botRecord } from './records';

export class ToolAssignmentRepository {
  constructor(private db: Database) {}
  bot(id: string) {
    const row = this.db.get('SELECT * FROM bots WHERE id=?', id);
    return row ? botRecord(row) : undefined;
  }
  bots(workspaceId: string) {
    return this.db.all('SELECT * FROM bots WHERE workspace_id=?', workspaceId).map(botRecord);
  }
  customTools(workspaceId: string) {
    return this.db
      .all(
        "SELECT id,owner_bot_id FROM capabilities WHERE workspace_id=? AND kind='tool'",
        workspaceId,
      )
      .map((row) => ({
        id: String(row.id),
        ownerBotId: row.owner_bot_id === null ? null : String(row.owner_bot_id),
      }));
  }
  override(botId: string, toolId: string) {
    const row = this.db.get(
      'SELECT enabled FROM bot_tool_assignments WHERE bot_id=? AND tool_id=?',
      botId,
      toolId,
    );
    return row ? Boolean(row.enabled) : undefined;
  }
  set(botId: string, toolId: string, enabled: boolean) {
    this.db.run(
      'INSERT INTO bot_tool_assignments VALUES(?,?,?) ON CONFLICT(bot_id,tool_id) DO UPDATE SET enabled=excluded.enabled',
      botId,
      toolId,
      Number(enabled),
    );
  }
}
