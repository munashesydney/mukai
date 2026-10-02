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
  `CREATE TABLE conversations (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    kind TEXT NOT NULL CHECK(kind IN ('private','space')), name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', owner_bot_id TEXT UNIQUE REFERENCES bots(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL);
   CREATE TABLE conversation_bots (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    PRIMARY KEY(conversation_id,bot_id));
   INSERT INTO conversations SELECT 'bot-'||id,workspace_id,'private',name,description,id,created_at FROM bots;
   INSERT INTO conversation_bots SELECT 'bot-'||id,id FROM bots;
   CREATE TRIGGER bot_conversation AFTER INSERT ON bots BEGIN
    INSERT INTO conversations VALUES('bot-'||NEW.id,NEW.workspace_id,'private',NEW.name,NEW.description,NEW.id,NEW.created_at);
    INSERT INTO conversation_bots VALUES('bot-'||NEW.id,NEW.id);
   END;
   CREATE TABLE messages_next (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL, request_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL,
    reasoning TEXT NOT NULL DEFAULT '', activity_json TEXT NOT NULL DEFAULT '[]',
    parts_json TEXT NOT NULL DEFAULT '[]', started_at TEXT, finished_at TEXT,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    author_name TEXT NOT NULL DEFAULT '', saved INTEGER NOT NULL DEFAULT 0,
    CHECK(conversation_id IS NOT NULL OR bot_id IS NOT NULL),
    UNIQUE(conversation_id,request_id,role));
   INSERT INTO messages_next(sequence,id,bot_id,request_id,role,content,status,error,created_at,reasoning,activity_json,parts_json,started_at,finished_at,conversation_id,author_name)
    SELECT m.sequence,m.id,m.bot_id,m.request_id,m.role,m.content,m.status,m.error,m.created_at,m.reasoning,m.activity_json,m.parts_json,m.started_at,m.finished_at,'bot-'||m.bot_id,CASE WHEN m.role='user' THEN 'You' ELSE b.name END FROM messages m JOIN bots b ON b.id=m.bot_id;
   DROP TABLE messages;
   ALTER TABLE messages_next RENAME TO messages;
   CREATE INDEX chat_history ON messages(conversation_id,sequence);
   CREATE INDEX bot_messages ON messages(bot_id);
   CREATE TRIGGER legacy_message_conversation AFTER INSERT ON messages WHEN NEW.conversation_id IS NULL AND NEW.bot_id IS NOT NULL BEGIN
    UPDATE messages SET conversation_id='bot-'||NEW.bot_id WHERE id=NEW.id;
   END;
   CREATE TABLE artifacts_next (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, path TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE, UNIQUE(conversation_id,path));
   INSERT INTO artifacts_next SELECT a.*,m.conversation_id FROM artifacts a JOIN messages m ON m.id=a.message_id;
   DROP TABLE artifacts;
   ALTER TABLE artifacts_next RENAME TO artifacts;
   CREATE INDEX conversation_artifacts ON artifacts(conversation_id);`,
  `DROP TRIGGER bot_conversation;
   CREATE TABLE conversations_next (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    kind TEXT NOT NULL CHECK(kind IN ('private','space','pursuit_run')), name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', owner_bot_id TEXT UNIQUE REFERENCES bots(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL);
   INSERT INTO conversations_next SELECT * FROM conversations;
   DROP TABLE conversations;
   ALTER TABLE conversations_next RENAME TO conversations;
   CREATE TRIGGER bot_conversation AFTER INSERT ON bots BEGIN
    INSERT INTO conversations VALUES('bot-'||NEW.id,NEW.workspace_id,'private',NEW.name,NEW.description,NEW.id,NEW.created_at);
    INSERT INTO conversation_bots VALUES('bot-'||NEW.id,NEW.id);
   END;
   CREATE TABLE pursuits (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL, objective TEXT NOT NULL, success_criteria TEXT NOT NULL,
    owner_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('active','waiting','blocked','waiting_for_you','paused','completed')),
    interval_minutes INTEGER NOT NULL CHECK(interval_minutes >= 1), deadline TEXT,
    next_run_at TEXT, next_run_reason TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE INDEX pursuit_due ON pursuits(status,next_run_at);
   CREATE TABLE pursuit_runs (
    id TEXT PRIMARY KEY, pursuit_id TEXT NOT NULL REFERENCES pursuits(id),
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
    status TEXT NOT NULL CHECK(status IN ('running','complete','failed','stopped','interrupted')),
    trigger TEXT NOT NULL CHECK(trigger IN ('schedule','manual')),
    started_at TEXT NOT NULL, finished_at TEXT, summary TEXT NOT NULL DEFAULT '', error TEXT,
    snapshot_json TEXT NOT NULL);
   CREATE UNIQUE INDEX one_running_pursuit ON pursuit_runs(pursuit_id) WHERE status='running';`,
];

// SQLite table rebuilds must disable FK actions before BEGIN, then validate before COMMIT.
export const rebuildMigrations = new Set([5, 6]);
