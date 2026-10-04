import type { ApprovalMode, ApprovalTarget, ToolApproval } from '../../shared/approvals';
import type { Database } from '../db/database';

export class ApprovalRepository {
  constructor(private store: Database) {}
  pending(): ToolApproval[] {
    return this.store
      .all('SELECT request_json FROM pending_tool_approvals ORDER BY rowid')
      .map((row) => JSON.parse(String(row.request_json)) as ToolApproval);
  }
  save(request: ToolApproval) {
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
  mode(): ApprovalMode {
    // Preserve existing behavior when upgrading an installation without a saved policy.
    return this.store.get('SELECT value FROM metadata WHERE key = ?', 'approval-mode')?.value ===
      'ask-for-approval'
      ? 'ask-for-approval'
      : 'full-access';
  }
  setMode(mode: ApprovalMode) {
    this.store.run(
      'INSERT INTO metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      'approval-mode',
      mode,
    );
  }
}
