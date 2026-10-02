import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations } from './migrations';
import { startApiServer } from '../app';
import type { Attachment, Bot, ChatMessage } from '../../shared/ai';

let dir = '';
afterEach(() => {
  if (dir) {
    expect(dir.startsWith(join(tmpdir(), 'mukai-upgrade-'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
describe('Existing database upgrades', () => {
  it('upgrades a populated version-one database without losing bots, messages, providers, or attachments', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-upgrade-'));
    const db = new DatabaseSync(join(dir, 'mukai.sqlite'));
    db.exec(migrations[0]);
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(1,'2026-10-01');",
    );
    db.exec(
      "INSERT INTO providers VALUES('provider','Local','compatible','http://127.0.0.1:1234/v1','local-model',0,1,NULL);",
    );
    db.exec(
      "INSERT INTO bots VALUES('scout','Scout','Original description','Original instructions','provider',NULL,NULL,'scout','2026-10-01');",
    );
    db.exec("INSERT INTO metadata VALUES('scout_seeded','1');");
    db.exec(
      "INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at) VALUES('message','scout','request','user','Keep this chat','complete','2026-10-01');",
    );
    db.exec(
      "INSERT INTO attachments VALUES('attachment','scout','message','note.txt','text/plain',10,'text','stored.txt','Saved note',NULL);",
    );
    db.close();
    mkdirSync(join(dir, 'uploads'));
    writeFileSync(join(dir, 'uploads/stored.txt'), 'Saved note');
    const api = await startApiServer(0, { dataDir: dir });
    const get = async <T>(path: string): Promise<T> =>
      (
        await fetch(api.url + path, { headers: { Authorization: `Bearer ${api.token}` } })
      ).json() as Promise<T>;
    try {
      expect((await get<Bot[]>('/bots'))[0]).toMatchObject({
        id: 'scout',
        workspaceId: 'default',
        instructions: 'Original instructions',
      });
      const message = (await get<ChatMessage[]>('/bots/scout/messages'))[0];
      expect(message).toMatchObject({ content: 'Keep this chat', reasoning: '', activity: [] });
      expect(message.attachments[0]).toMatchObject({ id: 'attachment', name: 'note.txt' });
      expect(await get<Attachment[]>('/bots/scout/files')).toHaveLength(1);
      expect(api.store.all('SELECT version FROM schema_migrations')).toEqual([
        { version: 1 },
        { version: 2 },
      ]);
      expect(api.store.get('SELECT id FROM providers')?.id).toBe('provider');
      expect(() =>
        api.store.run('UPDATE bots SET workspace_id=NULL WHERE id=?', 'scout'),
      ).toThrow();
      expect(() =>
        api.store.run('UPDATE bots SET workspace_id=? WHERE id=?', 'missing', 'scout'),
      ).toThrow();
    } finally {
      await api.shutdown();
      await new Promise<void>((resolve) => api.server.close(() => resolve()));
    }
  });
});
