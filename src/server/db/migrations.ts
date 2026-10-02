// Migrations are append-only. A transaction applies each version exactly once.
export const migrations = [
  `CREATE TABLE providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
    base_url TEXT NOT NULL, default_model TEXT NOT NULL, supports_images INTEGER NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0, encrypted_key TEXT);
   CREATE UNIQUE INDEX one_default_provider ON providers(is_default) WHERE is_default = 1;
   CREATE TABLE bots (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL,
    provider_id TEXT REFERENCES providers(id) ON DELETE RESTRICT, model TEXT, supports_images INTEGER,
    avatar TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL,
    UNIQUE(bot_id,request_id,role));
   CREATE INDEX chat_history ON messages(bot_id,sequence);
   CREATE TABLE attachments (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE, name TEXT NOT NULL,
    media_type TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL,
    storage_name TEXT NOT NULL, extracted_text TEXT, warning TEXT);
   CREATE INDEX message_attachments ON attachments(message_id);
   CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT UNIQUE, created_at TEXT NOT NULL);
   INSERT INTO workspaces VALUES ('default','Munashe’s workspace',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
   ALTER TABLE bots ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
   UPDATE bots SET workspace_id = 'default';
   CREATE TRIGGER require_bot_workspace_insert BEFORE INSERT ON bots WHEN NEW.workspace_id IS NULL
     BEGIN SELECT RAISE(ABORT,'A bot must belong to a workspace'); END;
   CREATE TRIGGER require_bot_workspace_update BEFORE UPDATE OF workspace_id ON bots WHEN NEW.workspace_id IS NULL
     BEGIN SELECT RAISE(ABORT,'A bot must belong to a workspace'); END;
   CREATE INDEX workspace_bots ON bots(workspace_id,created_at);
   ALTER TABLE messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT '';
   ALTER TABLE messages ADD COLUMN activity_json TEXT NOT NULL DEFAULT '[]';
   CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    path TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(bot_id,path));`,
  `ALTER TABLE messages ADD COLUMN parts_json TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE messages ADD COLUMN started_at TEXT;
   ALTER TABLE messages ADD COLUMN finished_at TEXT;`,
  `CREATE TABLE file_changes (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    path TEXT NOT NULL, path_key TEXT NOT NULL,
    before_text TEXT, after_text TEXT NOT NULL,
    added INTEGER, removed INTEGER, hunks_json TEXT,
    UNIQUE(message_id,path_key));
   CREATE INDEX message_file_changes ON file_changes(message_id);
   CREATE INDEX bot_file_changes ON file_changes(bot_id);`,
];
