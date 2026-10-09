import { randomUUID } from 'node:crypto';
import type { Database, Row } from '../db/database';
import type {
  WorkpadEntry,
  WorkpadEntryInput,
  WorkpadEntryPatch,
  WorkpadQuery,
  WorkpadPage,
} from '../../shared/pursuits';
import { ApiError } from '../config';

const priority = `CASE WHEN type='blocker' AND status='open' THEN 0
  WHEN type='work_item' AND status='in_progress' THEN 1
  WHEN type='work_item' AND status='todo' THEN 2
  WHEN type='decision' THEN 3 WHEN status='done' THEN 4
  WHEN type='reference' THEN 5 WHEN type='note' THEN 6 ELSE 7 END`;

export class WorkpadRepository {
  constructor(private database: Database) {}
  private project(row: Row): WorkpadEntry {
    return {
      id: String(row.id),
      pursuitId: String(row.pursuit_id),
      type: row.type as WorkpadEntry['type'],
      title: String(row.title),
      content: String(row.content),
      status: row.status as WorkpadEntry['status'],
      links: JSON.parse(String(row.links_json)),
      authorBotId: row.author_bot_id as string | null,
      originRunId: row.origin_run_id as string | null,
      updatedRunId: row.updated_run_id as string | null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      revision: Number(row.revision),
    };
  }
  get(pursuitId: string, entryId: string) {
    const row = this.database.get(
      'SELECT * FROM pursuit_workpad_entries WHERE pursuit_id=? AND id=?',
      pursuitId,
      entryId,
    );
    if (!row) throw new ApiError(404, 'Workpad entry not found in this pursuit.');
    return this.project(row);
  }
  validateReferences(pursuitId: string, links: WorkpadEntry['links']) {
    const workspaceId = this.database.get(
      'SELECT workspace_id FROM pursuits WHERE id=?',
      pursuitId,
    )?.workspace_id;
    for (const link of links) {
      if (link.kind === 'entry') this.get(pursuitId, link.target);
      else if (
        link.kind === 'conversation' &&
        !this.database.get(
          'SELECT id FROM conversations WHERE id=? AND workspace_id=?',
          link.target,
          workspaceId || null,
        )
      )
        throw new ApiError(400, 'Conversation references must belong to this workspace.');
      else if (
        link.kind === 'artifact' &&
        !this.database.get(
          'SELECT a.id FROM artifacts a JOIN bots b ON b.id=a.bot_id WHERE a.id=? AND b.workspace_id=?',
          link.target,
          workspaceId || null,
        )
      )
        throw new ApiError(400, 'Artifact references must belong to this workspace.');
    }
  }
  list(pursuitId: string, query: WorkpadQuery = {}): WorkpadPage {
    const clauses = ['pursuit_id=?'];
    const params: (string | number)[] = [pursuitId];
    if (query.type) {
      clauses.push('type=?');
      params.push(query.type);
    }
    if (query.status) {
      clauses.push('status=?');
      params.push(query.status);
    } else if (!query.includeArchived) clauses.push("status<>'archived'");
    const where = clauses.join(' AND ');
    const total = Number(
      this.database.get(
        `SELECT COUNT(*) AS total FROM pursuit_workpad_entries WHERE ${where}`,
        ...params,
      )?.total || 0,
    );
    const offset = query.offset || 0,
      limit = query.limit || 20;
    const entries = this.database
      .all(
        `SELECT * FROM pursuit_workpad_entries WHERE ${where} ORDER BY ${priority},updated_at DESC,rowid DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      )
      .map((row) => this.project(row));
    return {
      entries,
      total,
      nextOffset: offset + entries.length < total ? offset + entries.length : null,
    };
  }
  add(
    pursuitId: string,
    botId: string,
    runId: string | null,
    input: WorkpadEntryInput,
    now: number,
  ) {
    const id = randomUUID(),
      date = new Date(now).toISOString();
    const status =
      input.status ||
      (input.type === 'work_item' ? 'todo' : input.type === 'blocker' ? 'open' : 'active');
    this.database.run(
      `INSERT INTO pursuit_workpad_entries
      (id,pursuit_id,type,title,content,status,links_json,author_bot_id,origin_run_id,updated_run_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      pursuitId,
      input.type,
      input.title,
      input.content,
      status,
      JSON.stringify(input.links || []),
      botId,
      runId,
      runId,
      date,
      date,
    );
    return this.get(pursuitId, id);
  }
  update(
    pursuitId: string,
    entryId: string,
    patch: WorkpadEntryPatch,
    expectedRevision: number,
    runId: string | null,
    now: number,
  ) {
    const previous = this.get(pursuitId, entryId);
    const next = { ...previous, ...patch };
    const changed = this.database.run(
      `UPDATE pursuit_workpad_entries SET title=?,content=?,status=?,links_json=?,updated_run_id=?,updated_at=?,revision=revision+1
      WHERE pursuit_id=? AND id=? AND revision=?`,
      next.title,
      next.content,
      next.status,
      JSON.stringify(next.links),
      runId,
      new Date(now).toISOString(),
      pursuitId,
      entryId,
      expectedRevision,
    );
    if (!changed.changes)
      throw new ApiError(
        409,
        'This Workpad entry changed. Get the latest entry and retry with its revision.',
      );
    return this.get(pursuitId, entryId);
  }
  digest(pursuitId: string) {
    const page = this.list(pursuitId, { limit: 40 });
    // Reserve space for different kinds of context before filling by urgency.
    // A large blocker/work backlog must not hide every decision and recent result.
    const groups: [string, number][] = [
      ["type='blocker' AND status='open'", 3],
      ["type='work_item' AND status IN ('todo','in_progress')", 4],
      ["type='decision' AND status='active'", 3],
      ["type='work_item' AND status='done'", 2],
      ["type='reference' AND status='active'", 2],
      ["type='note' AND status='active'", 1],
      ["type='blocker' AND status='resolved'", 1],
    ];
    const candidates = new Map<string, WorkpadEntry>();
    for (const [where, limit] of groups)
      for (const row of this.database.all(
        `SELECT * FROM pursuit_workpad_entries WHERE pursuit_id=? AND ${where} ORDER BY ${priority},updated_at DESC,rowid DESC LIMIT ?`,
        pursuitId,
        limit,
      )) {
        const entry = this.project(row);
        candidates.set(entry.id, entry);
      }
    for (const entry of page.entries)
      if (!candidates.has(entry.id)) candidates.set(entry.id, entry);
    const entries: object[] = [];
    let characters = 0;
    for (const entry of candidates.values()) {
      const links = entry.links.filter((link) => link.target.length <= 500).slice(0, 2);
      const compact = {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        status: entry.status,
        revision: entry.revision,
        content: entry.content.slice(0, 500),
        contentTruncated: entry.content.length > 500,
        links,
        linksTruncated: links.length < entry.links.length,
      };
      const size = JSON.stringify(compact).length;
      if (entries.length >= 16) break;
      if (characters + size > 10000) continue;
      entries.push(compact);
      characters += size;
    }
    return {
      entries,
      total: page.total,
      omittedCount: page.total - entries.length,
      retrieval:
        'Use manage_pursuit list_entries/get_entry with pursuitId for full entries and additional context. Archived entries are excluded by default.',
    };
  }
}
