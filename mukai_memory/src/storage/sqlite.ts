import type { Episode, EpisodeInput, MemoryFact, MemoryScope, RecallTrace } from '../types';

export interface SQLiteConnection {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: (string | number | null)[]): unknown[];
    get(...params: (string | number | null)[]): unknown;
    run(...params: (string | number | null)[]): unknown;
  };
}
type Row = Record<string, string | number | null>;
export const normalize = (value: string) =>
  value.normalize('NFKC').trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');

export class SQLiteMemoryStore {
  constructor(readonly connection: SQLiteConnection) {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS memory_schema(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS memory_episodes(
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_id TEXT, actor_id TEXT,
        source_key TEXT NOT NULL, source_type TEXT NOT NULL, content TEXT NOT NULL,
        reference_time TEXT NOT NULL, conversation_id TEXT, message_id TEXT, context TEXT NOT NULL,
        created_at TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
        UNIQUE(workspace_id,source_key));
      CREATE INDEX IF NOT EXISTS memory_episode_scope ON memory_episodes(workspace_id,owner_id,status);
      CREATE TABLE IF NOT EXISTS memory_entities(
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_key TEXT NOT NULL,
        name TEXT NOT NULL, normalized_name TEXT NOT NULL, type TEXT NOT NULL,
        UNIQUE(workspace_id,owner_key,normalized_name));
      CREATE TABLE IF NOT EXISTS memory_aliases(
        workspace_id TEXT NOT NULL, owner_key TEXT NOT NULL, alias TEXT NOT NULL,
        entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
        PRIMARY KEY(workspace_id,owner_key,alias));
      CREATE TABLE IF NOT EXISTS memory_facts(
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_id TEXT,
        subject_id TEXT NOT NULL REFERENCES memory_entities(id), relation TEXT NOT NULL,
        object_id TEXT NOT NULL REFERENCES memory_entities(id), text TEXT NOT NULL,
        valid_from TEXT NOT NULL, valid_to TEXT, created_at TEXT NOT NULL,
        superseded_by TEXT, state TEXT NOT NULL, vector_json TEXT, vector_model TEXT);
      CREATE INDEX IF NOT EXISTS memory_fact_scope ON memory_facts(workspace_id,owner_id,valid_to);
      CREATE INDEX IF NOT EXISTS memory_fact_subject ON memory_facts(subject_id,relation);
      CREATE TABLE IF NOT EXISTS memory_fact_sources(
        fact_id TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL REFERENCES memory_episodes(id) ON DELETE CASCADE,
        PRIMARY KEY(fact_id,episode_id));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(fact_id UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS memory_settings(workspace_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_recalls(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        owner_id TEXT, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at TEXT NOT NULL,
        query TEXT NOT NULL, facts_json TEXT NOT NULL, characters INTEGER NOT NULL);
      INSERT OR IGNORE INTO memory_schema VALUES(1);
    `);
    const version = this.get('SELECT MAX(version) AS version FROM memory_schema')?.version;
    if (version !== 1) throw new Error('Memory storage needs a newer module version.');
    this.run("UPDATE memory_episodes SET status='pending' WHERE status='processing'");
  }
  get(sql: string, ...params: (string | number | null)[]) {
    return this.connection.prepare(sql).get(...params) as Row | undefined;
  }
  all(sql: string, ...params: (string | number | null)[]) {
    return this.connection.prepare(sql).all(...params) as Row[];
  }
  run(sql: string, ...params: (string | number | null)[]) {
    return this.connection.prepare(sql).run(...params);
  }
  transaction<T>(execute: () => T): T {
    this.connection.exec('SAVEPOINT memory_write');
    try {
      const result = execute();
      this.connection.exec('RELEASE memory_write');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK TO memory_write');
      this.connection.exec('RELEASE memory_write');
      throw error;
    }
  }
  scope(scope: MemoryScope, alias = 'f') {
    return {
      sql: `${alias}.workspace_id=?${scope.includePrivate ? '' : ` AND (${alias}.owner_id IS NULL${scope.privateOwner ? ` OR ${alias}.owner_id=?` : ''})`}`,
      params: [
        scope.workspaceId,
        ...(!scope.includePrivate && scope.privateOwner ? [scope.privateOwner] : []),
      ],
    };
  }
  episode(row: Row): Episode {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      ownerId: row.owner_id as string | null,
      actorId: row.actor_id as string | null,
      sourceKey: String(row.source_key),
      sourceType: row.source_type as EpisodeInput['sourceType'],
      content: String(row.content),
      referenceTime: String(row.reference_time),
      conversationId: row.conversation_id as string | null,
      messageId: row.message_id as string | null,
      context: String(row.context),
      createdAt: String(row.created_at),
      status: row.status as Episode['status'],
      attempts: Number(row.attempts),
      error: row.error as string | null,
    };
  }
  fact(row: Row): MemoryFact {
    const sources = this.all(
      'SELECT e.* FROM memory_episodes e JOIN memory_fact_sources s ON s.episode_id=e.id WHERE s.fact_id=? ORDER BY e.created_at',
      String(row.id),
    ).map((source) => this.episode(source));
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      ownerId: row.owner_id as string | null,
      subjectId: String(row.subject_id),
      subject: String(row.subject),
      relation: String(row.relation),
      objectId: String(row.object_id),
      object: String(row.object),
      text: String(row.text),
      validFrom: String(row.valid_from),
      validTo: row.valid_to as string | null,
      createdAt: String(row.created_at),
      supersededBy: row.superseded_by as string | null,
      state: row.state as MemoryFact['state'],
      sources,
    };
  }
  rows(scope: MemoryScope) {
    const where = this.scope(scope);
    return this.all(
      `SELECT f.*,s.name AS subject,o.name AS object FROM memory_facts f JOIN memory_entities s ON s.id=f.subject_id JOIN memory_entities o ON o.id=f.object_id WHERE ${where.sql} ORDER BY f.created_at DESC,f.id`,
      ...where.params,
    );
  }
  facts(scope: MemoryScope) {
    return this.rows(scope).map((row) => this.fact(row));
  }
  requireFact(scope: MemoryScope, id: string) {
    const where = this.scope(scope);
    const row = this.get(
      `SELECT f.*,s.name AS subject,o.name AS object FROM memory_facts f JOIN memory_entities s ON s.id=f.subject_id JOIN memory_entities o ON o.id=f.object_id WHERE ${where.sql} AND f.id=?`,
      ...where.params,
      id,
    );
    if (!row) throw new Error('Memory not found in this scope.');
    return this.fact(row);
  }
  pruneEntities() {
    this.run(
      'DELETE FROM memory_entities WHERE id NOT IN (SELECT subject_id FROM memory_facts UNION SELECT object_id FROM memory_facts)',
    );
  }
  settingsValue(workspaceId: string) {
    return this.get('SELECT value FROM memory_settings WHERE workspace_id=?', workspaceId)
      ?.value as string | undefined;
  }
  settingsValues() {
    return this.all('SELECT value FROM memory_settings').map((row) => String(row.value));
  }
  saveSettings(workspaceId: string, value: string) {
    this.run(
      'INSERT INTO memory_settings VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET value=excluded.value',
      workspaceId,
      value,
    );
  }
  pendingEpisodes(limit = 8, captureWorkspaces?: string[]) {
    const filter = captureWorkspaces
      ? ` AND (source_type!='user'${captureWorkspaces.length ? ` OR workspace_id IN (${captureWorkspaces.map(() => '?').join(',')})` : ''})`
      : '';
    return this.all(
      `SELECT * FROM memory_episodes WHERE status='pending'${filter} ORDER BY created_at LIMIT ?`,
      ...(captureWorkspaces || []),
      limit,
    ).map((row) => this.episode(row));
  }
  recentEpisodes(workspaceId: string) {
    return this.all(
      "SELECT * FROM memory_episodes WHERE workspace_id=? AND status!='forgotten' ORDER BY created_at DESC LIMIT 50",
      workspaceId,
    ).map((row) => this.episode(row));
  }
  retryEpisode(workspaceId: string, id: string) {
    this.run(
      "UPDATE memory_episodes SET status='pending',error=NULL WHERE id=? AND workspace_id=? AND status='failed'",
      id,
      workspaceId,
    );
  }
  recordRecall(scope: MemoryScope, trace: RecallTrace) {
    this.run(
      'INSERT OR REPLACE INTO memory_recalls VALUES(?,?,?,?,?,?,?,?,?)',
      trace.id,
      scope.workspaceId,
      scope.privateOwner || null,
      trace.conversationId,
      trace.messageId,
      trace.createdAt,
      trace.query,
      JSON.stringify(trace.facts),
      trace.characters,
    );
    this.run(
      'DELETE FROM memory_recalls WHERE workspace_id=? AND id NOT IN (SELECT id FROM memory_recalls WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100)',
      scope.workspaceId,
      scope.workspaceId,
    );
  }
  recalls(scope: MemoryScope): RecallTrace[] {
    const where = this.scope(scope, 'r');
    return this.all(
      `SELECT r.* FROM memory_recalls r WHERE ${where.sql} ORDER BY created_at DESC LIMIT 30`,
      ...where.params,
    ).map((row) => ({
      id: String(row.id),
      createdAt: String(row.created_at),
      conversationId: String(row.conversation_id),
      messageId: String(row.message_id),
      query: String(row.query),
      facts: JSON.parse(String(row.facts_json)),
      characters: Number(row.characters),
    }));
  }
}
