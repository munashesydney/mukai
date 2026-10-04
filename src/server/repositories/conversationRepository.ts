import { randomUUID } from 'node:crypto';
import type { Conversation, SpaceInput } from '../../shared/conversations';
import type { Database, Row } from '../db/database';

export class ConversationRepository {
  constructor(private database: Database) {}
  private project(row: Row): Conversation {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      kind: row.kind as Conversation['kind'],
      name: String(row.name),
      description: String(row.description),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ownerBotId: row.owner_bot_id as string | null,
      botIds: this.database
        .all(
          'SELECT bot_id FROM conversation_bots WHERE conversation_id=? ORDER BY rowid',
          String(row.id),
        )
        .map((row) => String(row.bot_id)),
    };
  }
  find(id: string) {
    const row = this.database.get('SELECT * FROM conversations WHERE id=?', id);
    return row ? this.project(row) : undefined;
  }
  list(workspaceId: string) {
    return this.database
      .all(
        "SELECT * FROM conversations WHERE workspace_id=? AND kind='space' ORDER BY created_at,rowid",
        workspaceId,
      )
      .map((row) => this.project(row));
  }
  privateChats(workspaceId: string) {
    return this.database
      .all(
        "SELECT * FROM conversations WHERE workspace_id=? AND kind='private' ORDER BY updated_at DESC,rowid DESC",
        workspaceId,
      )
      .map((row) => this.project(row));
  }
  botChats(workspaceId: string) {
    return this.database
      .all(
        "SELECT * FROM conversations WHERE workspace_id=? AND kind='bot' ORDER BY updated_at DESC,rowid DESC",
        workspaceId,
      )
      .map((row) => this.project(row));
  }
  createBotChat(workspaceId: string, callerId: string, targetId: string, message: string) {
    return this.database.transaction(() => {
      const id = randomUUID(),
        now = new Date().toISOString();
      this.database.run(
        "INSERT INTO conversations(id,workspace_id,kind,name,created_at,updated_at) VALUES(?,?,'bot',?,?,?)",
        id,
        workspaceId,
        message.replace(/\s+/g, ' ').trim().slice(0, 60),
        now,
        now,
      );
      for (const botId of [callerId, targetId])
        this.database.run('INSERT INTO conversation_bots VALUES(?,?)', id, botId);
      return this.find(id)!;
    });
  }
  createPrivate(workspaceId: string, botId: string) {
    return this.database.transaction(() => {
      const empty = this.database.get(
        "SELECT c.* FROM conversations c WHERE c.workspace_id=? AND c.owner_bot_id=? AND c.kind='private' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id) ORDER BY c.updated_at DESC,c.rowid DESC LIMIT 1",
        workspaceId,
        botId,
      );
      if (empty) return this.project(empty);
      const id = randomUUID(),
        now = new Date().toISOString();
      this.database.run(
        "INSERT INTO conversations(id,workspace_id,kind,name,owner_bot_id,created_at,updated_at) VALUES(?,?,'private','New conversation',?,?,?)",
        id,
        workspaceId,
        botId,
        now,
        now,
      );
      this.database.run('INSERT INTO conversation_bots VALUES(?,?)', id, botId);
      return this.find(id)!;
    });
  }
  create(workspaceId: string, input: SpaceInput, id = randomUUID()) {
    this.database.transaction(() => {
      this.database.run(
        "INSERT INTO conversations(id,workspace_id,kind,name,description,created_at,updated_at) VALUES(?,?,'space',?,?,?,?)",
        id,
        workspaceId,
        input.name,
        input.description,
        new Date().toISOString(),
        new Date().toISOString(),
      );
      for (const botId of input.botIds)
        this.database.run('INSERT INTO conversation_bots VALUES(?,?)', id, botId);
    });
    return this.find(id)!;
  }
  import(
    workspaceId: string,
    spaces: {
      id: string;
      name: string;
      description: string;
      messages: { id: string; text: string; author: string; saved: boolean }[];
    }[],
    botIds: string[],
  ) {
    // Import and its checkpoint are atomic; a repeated request never duplicates history.
    const key = 'space_import:' + workspaceId;
    this.database.transaction(() => {
      if (this.database.get('SELECT key FROM metadata WHERE key=?', key)) return;
      for (const space of spaces) {
        const id = randomUUID();
        this.database.run(
          "INSERT INTO conversations(id,workspace_id,kind,name,description,created_at,updated_at) VALUES(?,?,'space',?,?,?,?)",
          id,
          workspaceId,
          space.name,
          space.description,
          new Date().toISOString(),
          new Date().toISOString(),
        );
        for (const botId of botIds)
          this.database.run('INSERT INTO conversation_bots VALUES(?,?)', id, botId);
        for (const message of space.messages) {
          const bot =
            message.author === 'munashe'
              ? undefined
              : this.database.get(
                  'SELECT id,name FROM bots WHERE id=? AND workspace_id=?',
                  message.author,
                  workspaceId,
                );
          this.database.run(
            'INSERT INTO messages(id,conversation_id,bot_id,request_id,role,content,status,created_at,author_name,saved) VALUES(?,?,?,?,?,?,?,?,?,?)',
            randomUUID(),
            id,
            bot ? String(bot.id) : null,
            'legacy-' + message.id,
            message.author === 'munashe' ? 'user' : 'assistant',
            message.text,
            'complete',
            new Date().toISOString(),
            message.author === 'munashe' ? 'You' : String(bot?.name || message.author),
            Number(message.saved),
          );
        }
      }
      this.database.run('INSERT INTO metadata VALUES(?,?)', key, '1');
    });
    return this.list(workspaceId);
  }
}
