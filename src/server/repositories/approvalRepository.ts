import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalTarget,
  ToolApproval,
} from '../../shared/approvals';
import type { Database } from '../db/database';

export type ApprovalCheckpoint = ToolApproval & { decision?: ApprovalDecision | string };

export class ApprovalRepository {
  constructor(private store: Database) {
    // Copy the old installation-wide policy to existing workspaces exactly once.
    const legacy = store.get('SELECT value FROM metadata WHERE key=?', 'approval-mode');
    if (legacy)
      store.transaction(() => {
        store.run(
          "INSERT OR IGNORE INTO metadata(key,value) SELECT 'approval-mode:' || id, ? FROM workspaces",
          legacy.value,
        );
        store.run('DELETE FROM metadata WHERE key=?', 'approval-mode');
      });
  }
  workspaceId(details: Pick<ToolApproval, 'conversationId' | 'botId'>) {
    return (
      this.target(details.conversationId)?.workspaceId ||
      String(
        this.store.get('SELECT workspace_id FROM bots WHERE id=?', details.botId)?.workspace_id ||
          'default',
      )
    );
  }
  blockedParents(request: ToolApproval): NonNullable<ToolApproval['blockedParents']> {
    return this.store
      .all(
        `WITH RECURSIVE parents(message_id) AS (
      SELECT d.parent_message_id FROM bot_delegations d
      WHERE d.conversation_id=? AND d.child_request_id=(SELECT request_id FROM messages WHERE id=?) AND d.state='waiting'
      UNION
      SELECT d.parent_message_id FROM bot_delegations d JOIN messages m ON m.conversation_id=d.conversation_id AND m.request_id=d.child_request_id
      JOIN parents p ON p.message_id=m.id WHERE d.state='waiting'
    ) SELECT m.id,m.conversation_id,m.bot_id,b.name FROM parents p
      JOIN messages m ON m.id=p.message_id JOIN bots b ON b.id=m.bot_id
      WHERE m.status='streaming'`,
        request.conversationId,
        request.messageId,
      )
      .map((row) => ({
        messageId: String(row.id),
        conversationId: String(row.conversation_id),
        botId: String(row.bot_id),
        botName: String(row.name),
      }));
  }
  pending(): ApprovalCheckpoint[] {
    return this.store
      .all('SELECT request_json FROM pending_tool_approvals ORDER BY rowid')
      .map((row) => JSON.parse(String(row.request_json)) as ApprovalCheckpoint);
  }
  save(request: ApprovalCheckpoint) {
    this.store.run(
      'INSERT OR REPLACE INTO pending_tool_approvals VALUES(?,?,?)',
      request.id,
      request.messageId,
      JSON.stringify(request),
    );
  }
  remove(id: string) {
    this.store.run('DELETE FROM pending_tool_approvals WHERE id=?', id);
  }
  resolve<T>(action: () => T) {
    return this.store.transaction(action);
  }
  target(conversationId: string): ApprovalTarget | undefined {
    const row = this.store.get(
      `SELECT c.kind,c.workspace_id,c.name,r.pursuit_id,r.id AS run_id
       FROM conversations c LEFT JOIN pursuit_runs r ON r.conversation_id=c.id WHERE c.id=?`,
      conversationId,
    );
    if (!row) return undefined;
    return {
      kind: row.kind as ApprovalTarget['kind'],
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      ...(row.run_id ? { pursuitId: String(row.pursuit_id), runId: String(row.run_id) } : {}),
    };
  }
  mode(workspaceId = 'default'): ApprovalMode {
    // Preserve existing behavior when upgrading an installation without a saved policy.
    return this.store.get(
      'SELECT value FROM metadata WHERE key = ?',
      'approval-mode:' + workspaceId,
    )?.value === 'ask-for-approval'
      ? 'ask-for-approval'
      : 'full-access';
  }
  setMode(mode: ApprovalMode, workspaceId = 'default') {
    this.store.run(
      'INSERT INTO metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      'approval-mode:' + workspaceId,
      mode,
    );
  }
}
