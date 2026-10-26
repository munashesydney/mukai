import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations } from './migrations';
import { startApiServer } from '../app';
import type { Attachment, Bot, ChatMessage } from '../../shared/ai';
import { WorkspaceRepository } from '../repositories/workspaceRepository';
import { Database } from './database';
import { seedTestBot } from '../testFixtures';

let dir = '';
afterEach(() => {
  if (dir) {
    expect(dir.startsWith(join(tmpdir(), 'mukai-upgrade-'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
describe('Existing database upgrades', () => {
  it('migrates image assignments into Media while preserving denials and saved activity', () => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-upgrade-'));
    let database = new Database(dir);
    seedTestBot(database);
    database.run("INSERT INTO bot_tool_assignments VALUES('scout','image',0)");
    database.run("INSERT INTO bot_tool_assignments VALUES('scout','media',1)");
    database.run(
      'DELETE FROM schema_migrations WHERE version=?',
      migrations.findIndex((sql) => sql.includes("SELECT bot_id,'media'")) + 1,
    );
    database.db.close();
    database = new Database(dir);
    try {
      expect(
        database.all("SELECT tool_id,enabled FROM bot_tool_assignments WHERE bot_id='scout'"),
      ).toEqual([{ tool_id: 'media', enabled: 0 }]);
      expect(database.all('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      database.db.close();
    }
  });
  it('adds disabled audio/video defaults without changing saved credentials or models', () => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-upgrade-'));
    let database = new Database(dir);
    database.run(
      "INSERT INTO providers(id,name,kind,base_url,default_model,supports_images,is_default,encrypted_key,models_json) VALUES('legacy','Legacy','compatible','http://localhost/v1','text',0,1,'encrypted-value','[]')",
    );
    database.db.exec(
      'ALTER TABLE providers DROP COLUMN supports_audio; ALTER TABLE providers DROP COLUMN supports_video;',
    );
    database.run(
      'DELETE FROM schema_migrations WHERE version=?',
      migrations.findIndex((sql) => sql.includes('ADD COLUMN supports_audio')) + 1,
    );
    database.db.close();
    database = new Database(dir);
    try {
      expect(
        database.get(
          "SELECT supports_audio,supports_video,encrypted_key,models_json FROM providers WHERE id='legacy'",
        ),
      ).toEqual({
        supports_audio: 0,
        supports_video: 0,
        encrypted_key: 'encrypted-value',
        models_json: '[]',
      });
      expect(database.all('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      database.db.close();
    }
  });
  it('adds optional artifact metadata without losing existing file or screenshot records', () => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-upgrade-'));
    let database = new Database(dir);
    seedTestBot(database);
    database.run(
      "INSERT INTO messages(id,bot_id,conversation_id,request_id,role,content,status,created_at) VALUES('artifact-message','scout','bot-scout','legacy','assistant','','complete','2026-10-15')",
    );
    for (const [id, kind] of [
      ['legacy-file', 'file'],
      ['legacy-image', 'image'],
    ]) {
      database.run(
        'INSERT INTO artifacts(id,bot_id,message_id,conversation_id,path,name,kind,created_at) VALUES(?,?,?,?,?,?,?,?)',
        id,
        'scout',
        'artifact-message',
        'bot-scout',
        id,
        id,
        kind,
        '2026-10-15',
      );
    }
    database.db.exec(
      'ALTER TABLE artifacts DROP COLUMN media_type; ALTER TABLE artifacts DROP COLUMN size;',
    );
    database.run(
      'DELETE FROM schema_migrations WHERE version=?',
      migrations.findIndex((sql) => sql.includes('ALTER TABLE artifacts ADD COLUMN media_type')) +
        1,
    );
    database.db.close();
    database = new Database(dir);
    try {
      expect(database.all('SELECT id,kind,media_type,size FROM artifacts ORDER BY id')).toEqual([
        { id: 'legacy-file', kind: 'file', media_type: null, size: null },
        { id: 'legacy-image', kind: 'image', media_type: 'image/png', size: null },
      ]);
      expect(database.all('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      database.db.close();
    }
  });
  it('moves legacy Telegram labels out of user text and titles into internal source metadata', () => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-upgrade-'));
    let database = new Database(dir);
    seedTestBot(database);
    const label = 'Message coming from the Telegram integration by the user.';
    database.run(
      `INSERT INTO messages(id,bot_id,conversation_id,request_id,role,content,status,created_at)
      VALUES('telegram-user','scout','bot-scout','legacy','user',?,'complete','2026-10-13')`,
      label + '\n\nActual user text',
    );
    database.run('UPDATE conversations SET name=? WHERE id=?', label + ' Act', 'bot-scout');
    // Recreate the preceding schema so reopening runs the actual append-only upgrade.
    database.db.exec('ALTER TABLE messages DROP COLUMN source');
    database.run(
      'DELETE FROM schema_migrations WHERE version=?',
      migrations.findIndex((sql) => sql.includes('ALTER TABLE messages ADD COLUMN source')) + 1,
    );
    database.db.close();
    database = new Database(dir);
    try {
      expect(
        database.get('SELECT content,source FROM messages WHERE id=?', 'telegram-user'),
      ).toEqual({
        content: 'Actual user text',
        source: 'telegram',
      });
      expect(database.get('SELECT name FROM conversations WHERE id=?', 'bot-scout')?.name).toBe(
        'Actual user text',
      );
      expect(database.all('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      database.db.close();
    }
  });
  it('starts a fresh database without workspaces and stays empty after reopening', () => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-upgrade-'));
    let database = new Database(dir);
    expect(new WorkspaceRepository(database).list()).toEqual([]);
    expect(database.all('SELECT * FROM bots')).toEqual([]);
    database.db.close();
    database = new Database(dir);
    try {
      expect(new WorkspaceRepository(database).list()).toEqual([]);
      expect(database.all('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      database.db.close();
    }
  });

  it('preserves the workspace from an already installed database, including its name', () => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-upgrade-'));
    const db = new DatabaseSync(join(dir, 'mukai.sqlite'));
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
    migrations.slice(0, 2).forEach((sql, index) => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index + 1, 'old');
    });
    db.prepare('INSERT INTO workspaces VALUES(?,?,NULL,?)').run(
      'default',
      'My existing workspace',
      '2026-10-01',
    );
    db.close();
    const database = new Database(dir);
    try {
      expect(new WorkspaceRepository(database).find('default')).toMatchObject({
        name: 'My existing workspace',
        createdAt: '2026-10-01',
      });
      expect(
        database.get('SELECT memory_enabled FROM workspaces WHERE id=?', 'default')?.memory_enabled,
      ).toBe(1);
      expect(database.all('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      database.db.close();
    }
  });

  it('starts newly created workspaces with memory off and preserves their choice on restart', () => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-upgrade-'));
    let database = new Database(dir);
    new WorkspaceRepository(database).create({
      id: 'new-memory',
      name: 'New workspace',
      folder: null,
      createdAt: '2026-10-15',
      computer: 'local',
    });
    expect(
      database.get('SELECT memory_enabled FROM workspaces WHERE id=?', 'new-memory')
        ?.memory_enabled,
    ).toBe(0);
    database.db.close();
    database = new Database(dir);
    try {
      expect(
        database.get('SELECT memory_enabled FROM workspaces WHERE id=?', 'new-memory')
          ?.memory_enabled,
      ).toBe(0);
    } finally {
      database.db.close();
    }
  });

  it('gives existing VM workspaces resource defaults without changing their computer or identity', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-upgrade-'));
    const db = new DatabaseSync(join(dir, 'mukai.sqlite'));
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
    migrations
      .slice(
        0,
        migrations.findIndex((sql) => sql.includes('ADD COLUMN vm_memory_mib')),
      )
      .forEach((sql, index) => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index + 1, 'old');
      });
    db.exec(
      "INSERT INTO workspaces(id,name,folder,created_at,computer) VALUES('vm','My computer',NULL,'2026-10-01','qemu')",
    );
    db.close();
    const api = await startApiServer(0, { dataDir: dir });
    try {
      expect(new WorkspaceRepository(api.store).find('vm')).toEqual({
        id: 'vm',
        name: 'My computer',
        folder: null,
        createdAt: '2026-10-01',
        computer: 'qemu',
        computerResources: { memoryMiB: 4096, vcpus: 2 },
      });
      expect(new WorkspaceRepository(api.store).find('default')).toBeUndefined();
      expect(api.store.all('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      await api.shutdown();
      await new Promise<void>((resolve) => api.server.close(() => resolve()));
    }
  });
  it('removes installed run budgets while preserving bot settings and saved progress', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mukai-upgrade-'));
    const db = new DatabaseSync(join(dir, 'mukai.sqlite'));
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
    migrations.slice(0, 8).forEach((sql, index) => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index + 1, 'old');
    });
    db.exec(
      "INSERT INTO workspaces(id,name,folder,created_at) VALUES('default','Existing workspace',NULL,'2026-10-01')",
    );
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
      "INSERT INTO workspaces(id,name,folder,created_at) VALUES('default','Existing workspace',NULL,'2026-10-01')",
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
      expect(api.store.all('SELECT version FROM schema_migrations ORDER BY version')).toEqual(
        migrations.map((_sql, index) => ({ version: index + 1 })),
      );
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
