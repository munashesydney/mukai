import type { Database, Row } from '../db/database';
import { randomUUID } from 'node:crypto';
import type { TelegramUser, TelegramBotIdentity } from '../../shared/telegram';

export interface TelegramConnection {
  id: string;
  encryptedToken: string;
  bot: TelegramBotIdentity;
  enabled: boolean;
  owner: TelegramUser | null;
  ownerChatId: number | null;
  authorizedAt: number;
  authorizationId: string;
  pairingHash: string | null;
  pairingExpiresAt: number | null;
  candidate: TelegramUser | null;
  nextOffset: number;
}
export class TelegramConnectionRepository {
  constructor(readonly database: Database) {}
  private project(row: Row): TelegramConnection {
    return {
      id: String(row.id),
      encryptedToken: String(row.encrypted_token),
      bot: JSON.parse(String(row.bot_json)),
      enabled: Boolean(row.enabled),
      owner: row.owner_json ? JSON.parse(String(row.owner_json)) : null,
      ownerChatId: row.owner_chat_id === null ? null : Number(row.owner_chat_id),
      authorizedAt: Number(row.authorized_at),
      authorizationId: String(row.authorization_id),
      pairingHash: row.pairing_hash as string | null,
      pairingExpiresAt: row.pairing_expires_at === null ? null : Number(row.pairing_expires_at),
      candidate: row.pairing_candidate_json ? JSON.parse(String(row.pairing_candidate_json)) : null,
      nextOffset: Number(row.next_offset),
    };
  }
  get() {
    const row = this.database.get('SELECT * FROM telegram_connections');
    return row ? this.project(row) : undefined;
  }
  replace(id: string, encryptedToken: string, bot: TelegramBotIdentity) {
    this.database.transaction(() => {
      this.database.run('DELETE FROM telegram_connections');
      this.database.run('DELETE FROM telegram_access');
      this.database.run(
        'INSERT INTO telegram_connections(id,encrypted_token,bot_json) VALUES(?,?,?)',
        id,
        encryptedToken,
        JSON.stringify(bot),
      );
    });
  }
  remove() {
    this.database.transaction(() => {
      this.database.run('DELETE FROM telegram_connections');
      this.database.run('DELETE FROM telegram_access');
    });
  }
  enabled(value: boolean) {
    this.database.run('UPDATE telegram_connections SET enabled=?', Number(value));
  }
  pair(hash: string, expiresAt: number) {
    this.database.run(
      'UPDATE telegram_connections SET pairing_hash=?,pairing_expires_at=?,pairing_candidate_json=NULL',
      hash,
      expiresAt,
    );
  }
  claim(candidate: TelegramUser) {
    this.database.run(
      'UPDATE telegram_connections SET pairing_hash=NULL,pairing_candidate_json=?',
      JSON.stringify(candidate),
    );
  }
  approve(candidate: TelegramUser, now: number) {
    this.database.run(
      `UPDATE telegram_connections SET owner_json=?,owner_chat_id=?,authorized_at=?,authorization_id=?,
      pairing_hash=NULL,pairing_expires_at=NULL,pairing_candidate_json=NULL`,
      JSON.stringify(candidate),
      candidate.id,
      now,
      randomUUID(),
    );
  }
  revoke() {
    this.database.transaction(() => {
      this.database.run(`UPDATE telegram_connections SET owner_json=NULL,owner_chat_id=NULL,
        pairing_hash=NULL,pairing_expires_at=NULL,pairing_candidate_json=NULL`);
      this.database.run('DELETE FROM telegram_sessions');
      this.database.run('DELETE FROM telegram_inbox');
      this.database.run('DELETE FROM telegram_outbox');
    });
  }
  access() {
    return this.database.all('SELECT workspace_id,bot_id FROM telegram_access');
  }
  setAccess(values: { workspaceId: string; botId: string | null }[]) {
    this.database.transaction(() => {
      this.database.run('DELETE FROM telegram_access');
      for (const value of values)
        this.database.run(
          'INSERT INTO telegram_access VALUES(?,?)',
          value.workspaceId,
          value.botId,
        );
      // Workspace menus are snapshots; do not send an old access list after a settings change.
      this.database.run(
        "UPDATE telegram_outbox SET state='cancelled' WHERE state='pending' AND markup_json IS NOT NULL",
      );
      this.database.run(`DELETE FROM telegram_sessions WHERE NOT EXISTS (
        SELECT 1 FROM telegram_access a WHERE a.workspace_id=telegram_sessions.workspace_id AND (a.bot_id IS NULL OR a.bot_id=telegram_sessions.bot_id))`);
      this.database
        .run(`UPDATE telegram_outbox SET state='cancelled' WHERE state IN ('pending','sending') AND workspace_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM telegram_access a WHERE a.workspace_id=telegram_outbox.workspace_id AND (a.bot_id IS NULL OR a.bot_id=telegram_outbox.bot_id))`);
    });
  }
}
