// Schema migrations are append-only. A transaction applies each version exactly once.
// The workspace bootstrap below only creates a home for pre-workspace legacy bots.
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
   INSERT INTO workspaces SELECT 'default','Your workspace',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE EXISTS (SELECT 1 FROM bots);
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
  `DROP TRIGGER bot_conversation;
   CREATE TABLE conversations_next (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    kind TEXT NOT NULL CHECK(kind IN ('private','space','pursuit_run')), name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', owner_bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   INSERT INTO conversations_next SELECT c.*,COALESCE((SELECT MAX(created_at) FROM messages WHERE conversation_id=c.id),c.created_at) FROM conversations c;
   DROP TABLE conversations;
   ALTER TABLE conversations_next RENAME TO conversations;
   UPDATE conversations SET name=COALESCE((SELECT substr(replace(content,char(10),' '),1,60) FROM messages WHERE conversation_id=conversations.id AND role='user' AND content!='' ORDER BY sequence LIMIT 1),'New conversation'),description='' WHERE kind='private';
   CREATE INDEX bot_conversations ON conversations(owner_bot_id,kind,updated_at);
   CREATE TRIGGER bot_conversation AFTER INSERT ON bots BEGIN
    INSERT INTO conversations VALUES('bot-'||NEW.id,NEW.workspace_id,'private','New conversation','',NEW.id,NEW.created_at,NEW.created_at);
    INSERT INTO conversation_bots VALUES('bot-'||NEW.id,NEW.id);
   END;
   CREATE TRIGGER conversation_activity AFTER INSERT ON messages BEGIN
    UPDATE conversations SET updated_at=NEW.created_at WHERE id=NEW.conversation_id;
   END;
   CREATE TRIGGER conversation_finished AFTER UPDATE OF finished_at ON messages WHEN NEW.finished_at IS NOT NULL BEGIN
    UPDATE conversations SET updated_at=NEW.finished_at WHERE id=NEW.conversation_id;
   END;
   ALTER TABLE attachments ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;
   UPDATE attachments SET conversation_id=COALESCE((SELECT conversation_id FROM messages WHERE id=attachments.message_id),'bot-'||bot_id);
   CREATE INDEX pending_conversation_attachments ON attachments(conversation_id,message_id);`,
  `ALTER TABLE providers ADD COLUMN context_window_tokens INTEGER;
   ALTER TABLE providers ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 8192;
   ALTER TABLE bots ADD COLUMN context_window_tokens INTEGER;
   ALTER TABLE bots ADD COLUMN max_output_tokens INTEGER;
   ALTER TABLE bots ADD COLUMN run_time_limit_minutes INTEGER NOT NULL DEFAULT 60;
   ALTER TABLE bots ADD COLUMN run_token_limit INTEGER NOT NULL DEFAULT 1000000;
   ALTER TABLE messages ADD COLUMN context_usage_json TEXT;
   CREATE TABLE chat_jobs (
     message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
     checkpoint_json TEXT NOT NULL DEFAULT '{}', fingerprint TEXT NOT NULL,
     in_flight INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
   CREATE TABLE conversation_contexts (
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
     summary TEXT NOT NULL, through_sequence INTEGER NOT NULL,
     PRIMARY KEY(conversation_id,bot_id));`,
  `ALTER TABLE bots DROP COLUMN run_time_limit_minutes;
   ALTER TABLE bots DROP COLUMN run_token_limit;
   UPDATE chat_jobs SET checkpoint_json=json_remove(checkpoint_json,'$.elapsedMs') WHERE json_valid(checkpoint_json);`,
  `CREATE TABLE capability_env (
     workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(workspace_id,name));
   CREATE TABLE capabilities (
     id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     owner_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL, kind TEXT NOT NULL,
     name TEXT NOT NULL, module_path TEXT NOT NULL, export_name TEXT NOT NULL,
     version TEXT NOT NULL, enabled INTEGER NOT NULL, definition_json TEXT NOT NULL,
     method TEXT, path TEXT, UNIQUE(workspace_id,kind,name));
   CREATE UNIQUE INDEX capability_route ON capabilities(method,path) WHERE kind='route';
   CREATE TABLE capability_runs (
     id TEXT PRIMARY KEY, capability_id TEXT NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
     version TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
     duration_ms INTEGER, error TEXT);
   CREATE INDEX capability_recent_runs ON capability_runs(capability_id,started_at);
   CREATE TABLE capability_jobs (
     id TEXT PRIMARY KEY, capability_id TEXT NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
     version TEXT NOT NULL, provider TEXT NOT NULL, event_id TEXT NOT NULL,
     payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     next_at INTEGER NOT NULL, error TEXT, UNIQUE(capability_id,provider,event_id));`,
  `CREATE TABLE skills (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    version TEXT NOT NULL, bundle_json TEXT NOT NULL, info_json TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(workspace_id,name));
   CREATE TABLE loaded_skills (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL,
    PRIMARY KEY(conversation_id,bot_id,skill_id));`,
  `ALTER TABLE pursuits ADD COLUMN next_run_instructions TEXT NOT NULL DEFAULT '';
   UPDATE pursuits SET next_run_instructions=objective;`,
  `ALTER TABLE bots ADD COLUMN is_main INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE bots ADD COLUMN created_by TEXT REFERENCES bots(id) ON DELETE RESTRICT;
   CREATE UNIQUE INDEX one_main_bot ON bots(workspace_id) WHERE is_main=1;
   CREATE TABLE bot_tool_assignments (
     bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
     tool_id TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
     PRIMARY KEY(bot_id,tool_id));`,
  `ALTER TABLE bots RENAME COLUMN description TO role;
   UPDATE bots SET role=CASE WHEN is_main=1 THEN 'Main Bot/Orchestrator'
     WHEN trim(role)='' THEN 'Assistant' ELSE substr(role,1,120) END;`,
  `CREATE TABLE memory_review_jobs (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL, checkpoint INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE memory_review_runs (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    conversation_name TEXT NOT NULL, kind TEXT NOT NULL, owner_id TEXT,
    status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    summary TEXT NOT NULL, error TEXT, episode_id TEXT NOT NULL,
    message_ids TEXT NOT NULL, activity_json TEXT NOT NULL);
   CREATE INDEX memory_review_recent ON memory_review_runs(workspace_id,started_at);`,
  `CREATE TABLE pending_tool_approvals (
     id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
     request_json TEXT NOT NULL);
   CREATE INDEX pending_approval_message ON pending_tool_approvals(message_id);
   ALTER TABLE chat_jobs ADD COLUMN approval_step_json TEXT;`,
  `DROP TRIGGER bot_conversation;
   DROP TRIGGER conversation_activity;
   DROP TRIGGER conversation_finished;
   CREATE TABLE conversations_next (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    kind TEXT NOT NULL CHECK(kind IN ('private','space','pursuit_run','bot')), name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', owner_bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   INSERT INTO conversations_next SELECT * FROM conversations;
   DROP TABLE conversations;
   ALTER TABLE conversations_next RENAME TO conversations;
   CREATE INDEX bot_conversations ON conversations(owner_bot_id,kind,updated_at);
   CREATE INDEX workspace_conversations ON conversations(workspace_id,kind,updated_at);
   CREATE TRIGGER bot_conversation AFTER INSERT ON bots BEGIN
    INSERT INTO conversations VALUES('bot-'||NEW.id,NEW.workspace_id,'private','New conversation','',NEW.id,NEW.created_at,NEW.created_at);
    INSERT INTO conversation_bots VALUES('bot-'||NEW.id,NEW.id);
   END;
   CREATE TRIGGER conversation_activity AFTER INSERT ON messages BEGIN
    UPDATE conversations SET updated_at=NEW.created_at WHERE id=NEW.conversation_id;
   END;
   CREATE TRIGGER conversation_finished AFTER UPDATE OF finished_at ON messages WHEN NEW.finished_at IS NOT NULL BEGIN
    UPDATE conversations SET updated_at=NEW.finished_at WHERE id=NEW.conversation_id;
   END;`,
  `CREATE TABLE bot_delegations (
    parent_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL, caller_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    child_request_id TEXT NOT NULL, message TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('waiting','complete','cancelled')),
    PRIMARY KEY(parent_message_id,tool_call_id));
   CREATE INDEX delegation_child ON bot_delegations(conversation_id,child_request_id);`,
  `ALTER TABLE artifacts ADD COLUMN kind TEXT NOT NULL DEFAULT 'file';`,
  `ALTER TABLE providers ADD COLUMN models_json TEXT NOT NULL DEFAULT '[]';
   UPDATE providers SET models_json=json_array(json_object(
     'id',default_model,'name',default_model,'contextWindowTokens',context_window_tokens,
     'maxOutputTokens',max_output_tokens,'supportsImages',json(CASE WHEN supports_images=1 THEN 'true' ELSE 'false' END)))
   WHERE trim(default_model)<>'';
   UPDATE providers SET models_json=(
     SELECT json_group_array(json_object('id',id,'name',id,'contextWindowTokens',context_tokens,
       'maxOutputTokens',output_tokens,'supportsImages',json(CASE WHEN images=1 THEN 'true' ELSE 'false' END)))
     FROM (
       SELECT default_model AS id,context_window_tokens AS context_tokens,max_output_tokens AS output_tokens,supports_images AS images
       FROM providers p WHERE p.id=providers.id AND trim(default_model)<>''
       UNION ALL
       SELECT b.model,MAX(b.context_window_tokens),COALESCE(MAX(b.max_output_tokens),providers.max_output_tokens),COALESCE(MAX(b.supports_images),providers.supports_images)
       FROM bots b WHERE b.model IS NOT NULL AND trim(b.model)<>'' AND b.model<>providers.default_model
         AND (b.provider_id=providers.id OR (b.provider_id IS NULL AND providers.is_default=1))
       GROUP BY b.model
     )
   );`,
  `UPDATE capabilities SET definition_json=json_set(definition_json,'$.permissionMode','user_approval')
   WHERE kind='tool' AND json_extract(definition_json,'$.permissionMode') IS NULL;
   CREATE TABLE custom_tool_confirmations (
    id TEXT PRIMARY KEY, capability_id TEXT NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
    version TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL, input TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','running','complete','cancelled','failed')),
    UNIQUE(message_id,tool_call_id));`,
  `CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `ALTER TABLE workspaces ADD COLUMN computer TEXT NOT NULL DEFAULT 'local'
   CHECK(computer IN ('local','qemu'));`,
  `CREATE TABLE bot_notifications (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, bot_name TEXT NOT NULL,
    title TEXT NOT NULL, message TEXT NOT NULL,
    source_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, dismissed_at TEXT,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    UNIQUE(source_message_id,tool_call_id));
  CREATE INDEX notification_inbox ON bot_notifications(workspace_id,dismissed_at,created_at);
   INSERT OR IGNORE INTO bot_tool_assignments(bot_id,tool_id,enabled)
     SELECT bot_id,'communicate',enabled FROM bot_tool_assignments WHERE tool_id='ask';
   DELETE FROM bot_tool_assignments WHERE tool_id='ask';`,
  `CREATE TABLE pursuit_workpad_entries (
    id TEXT PRIMARY KEY,
    pursuit_id TEXT NOT NULL REFERENCES pursuits(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('work_item','decision','blocker','reference','note')),
    title TEXT NOT NULL, content TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('todo','in_progress','done','open','resolved','active','archived')),
    links_json TEXT NOT NULL DEFAULT '[]',
    author_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
    origin_run_id TEXT REFERENCES pursuit_runs(id) ON DELETE SET NULL,
    updated_run_id TEXT REFERENCES pursuit_runs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1);
   CREATE INDEX pursuit_workpad ON pursuit_workpad_entries(pursuit_id,status,type,updated_at);`,
  `ALTER TABLE workspaces ADD COLUMN vm_memory_mib INTEGER NOT NULL DEFAULT 4096
     CHECK(vm_memory_mib BETWEEN 1024 AND 65536 AND vm_memory_mib % 256 = 0);
   ALTER TABLE workspaces ADD COLUMN vm_vcpus INTEGER NOT NULL DEFAULT 2
     CHECK(vm_vcpus BETWEEN 1 AND 32);`,
  `ALTER TABLE workspaces ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE workspaces ADD COLUMN deletion_files_json TEXT;
   CREATE TABLE workspace_capability_versions (
     version TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE);`,
  `CREATE TABLE conversation_server_outputs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, url TEXT NOT NULL,
    UNIQUE(conversation_id,session_id,url));`,
  `CREATE TABLE chat_followups (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','steering','applied','sending','sent','cancelled')),
    target_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, error TEXT, steering_order INTEGER);
   CREATE INDEX followup_conversation ON chat_followups(conversation_id,state,sequence);
   CREATE TABLE chat_followup_queues (
     conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
     paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)));`,
  `CREATE TABLE web_owner (
    id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL,
    password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE web_sessions (
    token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
   CREATE INDEX web_session_expiry ON web_sessions(expires_at);`,
  `CREATE TABLE telegram_connections (
    id TEXT PRIMARY KEY, singleton INTEGER NOT NULL UNIQUE DEFAULT 1 CHECK(singleton=1),
    encrypted_token TEXT NOT NULL, bot_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    owner_json TEXT, owner_chat_id INTEGER, authorized_at INTEGER NOT NULL DEFAULT 0,
    authorization_id TEXT NOT NULL DEFAULT '',
    pairing_hash TEXT, pairing_expires_at INTEGER, pairing_candidate_json TEXT,
    next_offset INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE telegram_access (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE);
   CREATE TABLE telegram_sessions (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES telegram_connections(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    selected INTEGER NOT NULL DEFAULT 1,
    UNIQUE(connection_id,chat_id,workspace_id));
   CREATE UNIQUE INDEX telegram_selected_session ON telegram_sessions(connection_id,chat_id) WHERE selected=1;
   CREATE TABLE telegram_inbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL REFERENCES telegram_connections(id) ON DELETE CASCADE,
    update_id INTEGER NOT NULL, payload TEXT NOT NULL,
    UNIQUE(connection_id,update_id));
   CREATE TABLE telegram_chat_jobs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    connection_id TEXT NOT NULL REFERENCES telegram_connections(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES telegram_sessions(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL, source_message_id INTEGER NOT NULL, text TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','running','done','cancelled','interrupted')),
    created_at INTEGER NOT NULL);
   CREATE INDEX telegram_chat_queue ON telegram_chat_jobs(state,sequence);
   CREATE TABLE telegram_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    connection_id TEXT NOT NULL REFERENCES telegram_connections(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL, text TEXT NOT NULL, markup_json TEXT, reply_to INTEGER,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','uncertain','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
    telegram_message_id INTEGER, created_at INTEGER NOT NULL);
   CREATE INDEX telegram_delivery_queue ON telegram_outbox(state,sequence);`,
  `ALTER TABLE messages ADD COLUMN source TEXT CHECK(source IS NULL OR source='telegram');
   -- Remove the old runtime label from stored user text; reconstruct it only in model context.
   UPDATE messages SET source='telegram',
     content=substr(content,length('Message coming from the Telegram integration by the user.')+3)
   WHERE role='user' AND instr(content,'Message coming from the Telegram integration by the user.'||char(10)||char(10))=1;
   UPDATE conversations SET name=COALESCE((
     SELECT substr(trim(replace(replace(m.content,char(10),' '),char(13),' ')),1,60)
     FROM messages m WHERE m.conversation_id=conversations.id AND m.role='user'
     ORDER BY m.sequence LIMIT 1),name)
   WHERE kind='private' AND instr(name,'Message coming from the Telegram integration by the user.')=1
     AND EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=conversations.id AND m.source='telegram');`,
  `CREATE TABLE telegram_events (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES telegram_connections(id) ON DELETE CASCADE,
    authorization_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('approval','notification')), source_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    UNIQUE(connection_id,authorization_id,kind,source_id));
   CREATE TABLE telegram_actions (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES telegram_events(id) ON DELETE CASCADE,
    action TEXT NOT NULL, value TEXT, source_message_id INTEGER,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')),
    created_at INTEGER NOT NULL);
   CREATE INDEX telegram_pending_actions ON telegram_actions(state,created_at);
   ALTER TABLE telegram_sessions ADD COLUMN notification_id TEXT REFERENCES bot_notifications(id) ON DELETE CASCADE;
   ALTER TABLE telegram_chat_jobs ADD COLUMN notification_id TEXT REFERENCES bot_notifications(id) ON DELETE CASCADE;
   ALTER TABLE telegram_outbox ADD COLUMN workspace_event INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE telegram_outbox ADD COLUMN event_id TEXT REFERENCES telegram_events(id) ON DELETE CASCADE;
   ALTER TABLE telegram_outbox ADD COLUMN edit_message_id INTEGER;
   CREATE INDEX telegram_event_deliveries ON telegram_outbox(event_id);`,
  `ALTER TABLE telegram_events ADD COLUMN buttons_cleared INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE telegram_events ADD COLUMN continued INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE telegram_outbox ADD COLUMN reply_action TEXT CHECK(reply_action IS NULL OR reply_action='deny_reason');`,
  `ALTER TABLE workspaces ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 0 CHECK(memory_enabled IN (0,1));
   UPDATE workspaces SET memory_enabled=1;`,
  `ALTER TABLE artifacts ADD COLUMN media_type TEXT;
   ALTER TABLE artifacts ADD COLUMN size INTEGER CHECK(size IS NULL OR size >= 0);
   UPDATE artifacts SET media_type='image/png' WHERE kind='image';`,
  `ALTER TABLE providers ADD COLUMN supports_audio INTEGER NOT NULL DEFAULT 0 CHECK(supports_audio IN (0,1));
   ALTER TABLE providers ADD COLUMN supports_video INTEGER NOT NULL DEFAULT 0 CHECK(supports_video IN (0,1));`,
  `INSERT INTO bot_tool_assignments(bot_id,tool_id,enabled)
     SELECT bot_id,'media',enabled FROM bot_tool_assignments WHERE tool_id='image'
     ON CONFLICT(bot_id,tool_id) DO UPDATE SET enabled=MIN(bot_tool_assignments.enabled,excluded.enabled);
   DELETE FROM bot_tool_assignments WHERE tool_id='image';`,
  `ALTER TABLE telegram_outbox ADD COLUMN media_json TEXT;`,
  `ALTER TABLE bots ADD COLUMN reasoning_effort TEXT CHECK(reasoning_effort IS NULL OR reasoning_effort IN ('provider-default','none','minimal','low','medium','high','xhigh','max'));`,
];

// SQLite table rebuilds must disable FK actions before BEGIN, then validate before COMMIT.
export const rebuildMigrations = new Set([5, 6, 7, 17]);
