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
  it('removes installed run budgets while preserving bot settings and saved progress', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-upgrade-'));
    const db = new DatabaseSync(join(dir, 'mukai.sqlite'));
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
    migrations.slice(0, 8).forEach((sql, index) => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index + 1, 'old');
    });
    db.exec(
      "INSERT INTO bots(id,name,description,instructions,avatar,created_at,workspace_id,context_window_tokens,max_output_tokens,run_time_limit_minutes,run_token_limit) VALUES('scout','Scout','Original description','Original instructions','scout','2026-10-01','default',65536,4096,1,10000); INSERT INTO metadata VALUES('scout_seeded','1')",
    );
    db.exec(
      "INSERT INTO messages(id,bot_id,conversation_id,request_id,role,content,status,created_at) VALUES('reply','scout','bot-scout','request','assistant','Saved progress','interrupted','2026-10-01'); INSERT INTO chat_jobs VALUES('reply','{\"elapsedMs\":86400000,\"usage\":{\"runTokens\":2000000},\"messages\":[],\"steps\":12}','fingerprint',1,'2026-10-01')",
    );
    db.close();
    const api = await startApiServer(0, { dataDir: dir });
    try {
      const columns = api.store.all('PRAGMA table_info(bots)').map((column) => column.name);
      expect(columns).not.toContain('run_time_limit_minutes');
      expect(columns).not.toContain('run_token_limit');
      expect(
        api.store.get(
          "SELECT instructions,context_window_tokens,max_output_tokens FROM bots WHERE id='scout'",
        ),
      ).toMatchObject({
        instructions: 'Original instructions',
        context_window_tokens: 65536,
        max_output_tokens: 4096,
      });
      const job = api.store.get("SELECT * FROM chat_jobs WHERE message_id='reply'")!;
      expect(job.in_flight).toBe(1);
      const checkpoint = JSON.parse(String(job.checkpoint_json));
      expect(checkpoint).not.toHaveProperty('elapsedMs');
      expect(checkpoint).toMatchObject({ usage: { runTokens: 2000000 }, steps: 12 });
      expect(api.store.get("SELECT content FROM messages WHERE id='reply'")?.content).toBe(
        'Saved progress',
      );
      expect(api.store.all('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      await api.shutdown();
      await new Promise<void>((resolve) => api.server.close(() => resolve()));
    }
  });
  it('preserves existing reviews and artifacts when rebuilding the messages table', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-upgrade-'));
    const db = new DatabaseSync(join(dir, 'mukai.sqlite'));
    for (const sql of migrations.slice(0, 4)) db.exec(sql);
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(1,'old'),(2,'old'),(3,'old'),(4,'old');",
    );
    db.exec(
      "INSERT INTO bots VALUES('scout','Scout','Original description','Original instructions',NULL,NULL,NULL,'scout','2026-10-01','default'); INSERT INTO metadata VALUES('scout_seeded','1');",
    );
    db.exec(
      "INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at) VALUES('reply','scout','request','assistant','Done','complete','2026-10-01'); INSERT INTO artifacts VALUES('artifact','scout','reply','draft.md','draft.md','2026-10-01'); INSERT INTO file_changes VALUES('change','reply','scout','draft.md','draft.md','before','after',1,1,'[]');",
    );
    db.close();
    const api = await startApiServer(0, { dataDir: dir });
    try {
      expect(
        api.store.get('SELECT conversation_id FROM messages WHERE id=?', 'reply')?.conversation_id,
      ).toBe('bot-scout');
      expect(
        api.store.get('SELECT conversation_id FROM artifacts WHERE id=?', 'artifact')
          ?.conversation_id,
      ).toBe('bot-scout');
      expect(
        api.store.get('SELECT before_text,after_text FROM file_changes WHERE id=?', 'change'),
      ).toMatchObject({ before_text: 'before', after_text: 'after' });
      expect(api.store.all('PRAGMA foreign_key_check')).toEqual([]);
      expect(api.store.get('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    } finally {
      await api.shutdown();
      await new Promise<void>((resolve) => api.server.close(() => resolve()));
    }
  });
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
      expect(message).toMatchObject({
        content: 'Keep this chat',
        reasoning: '',
        activity: [],
        parts: [],
        startedAt: null,
        finishedAt: null,
      });
      expect(message.attachments[0]).toMatchObject({ id: 'attachment', name: 'note.txt' });
      expect(await get<Attachment[]>('/bots/scout/files')).toHaveLength(1);
      expect(api.store.all('SELECT version FROM schema_migrations')).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
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
